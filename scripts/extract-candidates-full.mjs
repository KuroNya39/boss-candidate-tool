#!/usr/bin/env node
/**
 * extract-candidates-full.mjs - Boss直聘沟通页候选人全量提取（基础信息 + 在线简历）
 *
 * 从沟通页（/web/chat）提取候选人：
 *   1. 扫描候选人列表获取 geekId（稳定标识）
 *   2. 逐个点击候选人卡片提取基础信息
 *   3. 打开在线简历弹窗，截图 + OCR 提取简历文本
 *   4. 保存到 output/zhipin-candidates.json（含 resumeText 字段）
 *
 * Usage:
 *   node scripts/extract-candidates-full.mjs --count 20 [--output output/zhipin-candidates.json]
 *
 * 前置条件：
 *   - CDP Proxy 已运行（端口 3456）
 *   - Chrome 已登录 Boss 直聘招聘端
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proxyGet, proxyPost, sleep, randomDelay,
  cdpEval, cdpScreenshot,
  clickOnlineResume,
  closeResumeDialog,
  captureResumeScreenshots,
  ocrScreenshots,
  safeName, cleanOcrText,
  getScanCachePath, getProgressPath,
  saveScanCache, loadScanCache, saveProgress, loadProgress, cleanupCacheFiles,
  archiveOldOutput,
  reportStats,
  parseArgs,
} from './extract-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T') + new Date().toISOString().slice(19, 23);

// ===== 页面操作 =====

async function waitForCandidateList(targetId, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const count = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`);
      if (count > 0) return count;
    } catch {}
    await sleep(800);
  }
  throw new Error('候选人列表未加载');
}

// ===== 候选人列表扫描（支持虚拟滚动） =====

async function readVisibleGeekItems(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var items = document.querySelectorAll('.geek-item');
    var result = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var id = el.id || el.getAttribute('data-id') || '';
      var geekId = id.split('-')[0] || '';
      var nameEl = el.querySelector('.name') || el.querySelector('.geek-name');
      var name = nameEl ? nameEl.textContent.trim() : '';
      result.push({ geekId: geekId, listName: name });
    }
    return JSON.stringify(result);
  })()`);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function scrollListDown(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (!list) return JSON.stringify({ok: false, reason: 'no-list'});
    var before = list.scrollTop;
    list.scrollTop += Math.floor(list.clientHeight * 0.8);
    var after = list.scrollTop;
    return JSON.stringify({ok: true, scrollTop: after, scrollHeight: list.scrollHeight, scrolled: after > before});
  })()`);
  return JSON.parse(raw);
}

async function scrollListUp(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (!list) return JSON.stringify({ok: false, reason: 'no-list'});
    var before = list.scrollTop;
    list.scrollTop -= Math.floor(list.clientHeight * 0.8);
    var after = list.scrollTop;
    return JSON.stringify({ok: true, scrollTop: after, scrolled: after < before});
  })()`);
  return JSON.parse(raw);
}

async function scrollListToTop(targetId) {
  await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (list) list.scrollTop = 0;
  })()`);
  await randomDelay(800, 1200);
}

async function scanAllCandidateGeekIds(targetId, opts = {}) {
  const { maxScrollAttempts = 500, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  await scrollListToTop(targetId);

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    const visibleItems = await readVisibleGeekItems(targetId);
    let newInThisBatch = 0;

    for (const item of visibleItems) {
      if (item.geekId && !seenGeekIds.has(item.geekId)) {
        seenGeekIds.add(item.geekId);
        candidateList.push(item);
        newInThisBatch++;
      }
    }

    if (newInThisBatch === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress(candidateList.length, attempt, newInThisBatch);

    const scroll = await scrollListDown(targetId);
    if (!scroll.ok) break;

    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      prevScrollTop = -1;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scroll.scrollTop === prevScrollTop) break;
    prevScrollTop = scroll.scrollTop;

    if (noNewCount >= noNewThreshold) break;

    await randomDelay(scroll.scrolled ? 800 : 3000, scroll.scrolled ? 1200 : 4000);
  }

  return candidateList;
}

async function scanUpToCandidateGeekIds(targetId, count, opts = {}) {
  const { maxScrollAttempts = 200, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  await scrollListToTop(targetId);

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    if (candidateList.length >= count) break;

    const visibleItems = await readVisibleGeekItems(targetId);
    let newInThisBatch = 0;

    for (const item of visibleItems) {
      if (item.geekId && !seenGeekIds.has(item.geekId)) {
        seenGeekIds.add(item.geekId);
        candidateList.push(item);
        newInThisBatch++;
        if (candidateList.length >= count) break;
      }
    }

    if (newInThisBatch === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress(candidateList.length, attempt, newInThisBatch);

    if (noNewCount >= noNewThreshold) break;
    if (candidateList.length >= count) break;

    const scroll = await scrollListDown(targetId);
    if (!scroll.ok) break;

    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      prevScrollTop = -1;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scroll.scrollTop === prevScrollTop) break;
    prevScrollTop = scroll.scrollTop;

    await randomDelay(1500, 2500);
  }

  return candidateList;
}

async function clickCandidateByGeekId(targetId, geekId) {
  const clickExpr = `(function(){
    var el = document.querySelector('[id^="${geekId}-"]');
    if (el) { el.click(); return 'ok-by-id'; }
    el = document.querySelector('[data-id^="${geekId}-"]');
    if (el) { el.click(); return 'ok-by-data-id'; }
    return 'not-found';
  })()`;

  let result;
  try {
    result = await cdpEval(targetId, clickExpr);
  } catch {
    result = 'error';
  }

  if (result !== 'not-found' && result !== 'error') {
    await randomDelay(1500, 2500);
    return result;
  }

  await scrollListToTop(targetId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const scroll = await scrollListDown(targetId);
    await randomDelay(500, 800);
    try {
      result = await cdpEval(targetId, clickExpr);
    } catch {
      result = 'error';
    }
    if (result !== 'not-found' && result !== 'error') {
      await randomDelay(1500, 2500);
      return result;
    }
    if (!scroll.ok || !scroll.scrolled) break;
  }

  for (let attempt = 0; attempt < 10; attempt++) {
    const scroll = await scrollListUp(targetId);
    await randomDelay(500, 800);
    try {
      result = await cdpEval(targetId, clickExpr);
    } catch {
      result = 'error';
    }
    if (result !== 'not-found' && result !== 'error') {
      await randomDelay(1500, 2500);
      return result;
    }
    if (!scroll.ok || !scroll.scrolled) break;
  }

  throw new Error(`无法定位候选人 geekId=${geekId}`);
}

// ===== 基础信息提取脚本 =====

const EXTRACT_BASIC_INFO_SCRIPT = `(function() {
  function safeText(el) {
    if (!el || !el.textContent) return '';
    return el.textContent.trim();
  }
  var result = {};
  try {
    var container = document.querySelector('.base-info-single-container');
    if (container) result.rawVisibleText = container.innerText;
  } catch (e) {}
  try {
    var basicDetail = document.querySelector('.base-info-single-detial');
    if (basicDetail) {
      var basicInfo = {};
      var divs = Array.from(basicDetail.querySelectorAll(':scope > div'))
        .filter(function(d) { return !d.classList.contains('active-time') && !d.classList.contains('online-info-img'); });
      var nameEl = basicDetail.querySelector('.base-name');
      var nameText = safeText(nameEl);
      if (nameText) basicInfo.name = nameText;
      if (divs.length >= 2) { var t = safeText(divs[1]); if (t) basicInfo.age = t; }
      if (divs.length >= 3) { var t = safeText(divs[2]); if (t) basicInfo.workYears = t; }
      if (divs.length >= 4) { var t = safeText(divs[3]); if (t) basicInfo.education = t; }
      if (Object.keys(basicInfo).length > 0) result.basicInfo = basicInfo;
    }
  } catch (e) {}
  try {
    var timeList = document.querySelector('.time-content');
    var detailList = document.querySelector('.work-content');
    if (timeList && detailList) {
      var timeItems = timeList.querySelectorAll(':scope > li');
      var detailItems = detailList.querySelectorAll(':scope > li');
      var workExp = [], eduExp = [];
      timeItems.forEach(function(timeLi, index) {
        var detailLi = detailItems[index];
        if (!detailLi) return;
        var time = safeText(timeLi.querySelector('.time'));
        var detail = safeText(detailLi.querySelector('.value'));
        var svgEl = timeLi.querySelector('svg');
        var svgClass = svgEl ? svgEl.className.baseVal : '';
        var isEdu = svgClass.includes('shool');
        if (isEdu) {
          var parts = detail ? detail.split('\\u00b7').map(function(p){return p.trim();}) : [];
          var edu = {};
          if (time) edu.time = time;
          if (parts[0]) edu.school = parts[0];
          if (parts[1]) edu.major = parts[1];
          if (parts[2]) edu.degree = parts[2];
          if (Object.keys(edu).length > 0) eduExp.push(edu);
        } else {
          var parts = detail ? detail.split('\\u00b7').map(function(p){return p.trim();}) : [];
          var work = {};
          if (time) work.time = time;
          if (parts[0]) work.company = parts[0];
          if (parts[1]) work.position = parts[1];
          if (Object.keys(work).length > 0) workExp.push(work);
        }
      });
      if (workExp.length > 0) result.workExperience = workExp;
      if (eduExp.length > 0) result.educationExperience = eduExp;
    }
  } catch (e) {}
  try {
    var posContent = document.querySelector('.position-content');
    if (posContent) {
      var posInfo = {};
      var appliedEl = posContent.querySelector('.position-name');
      var appliedText = safeText(appliedEl);
      if (appliedText) posInfo.appliedJob = appliedText;
      var expectEl = posContent.querySelector('.value.job');
      var expectText = safeText(expectEl);
      if (expectText) {
        var ep = expectText.split('\\u00b7').map(function(p){return p.trim();});
        if (ep[0]) posInfo.expectCity = ep[0];
        if (ep[1]) {
          var ps = ep[1].split(/\\s+/);
          if (ps[0]) posInfo.expectPosition = ps[0];
          if (ps[1]) posInfo.expectSalary = ps[1];
        }
      }
      if (Object.keys(posInfo).length > 0) result.positionInfo = posInfo;
    }
  } catch (e) {}
  return JSON.stringify(result);
})()`;

// ===== 岗位描述提取 =====

async function extractJobDescription(targetId) {
  const clickResult = await cdpEval(targetId, `(function(){
    var nameEl = document.querySelector('.position-name');
    if (!nameEl) return 'not-found';
    nameEl.click();
    return 'clicked';
  })()`);
  if (clickResult === 'not-found') return null;

  await randomDelay(1000, 1500);

  const detail = await cdpEval(targetId, `(function(){
    var dialog = document.querySelector('.job-details-dialog');
    if (!dialog) return JSON.stringify(null);
    var info = {};
    try {
      var nameEl = dialog.querySelector('.job-title-wrap .title');
      if (nameEl) info.jobName = nameEl.textContent.trim();
    } catch(e) {}
    try {
      var salaryEl = dialog.querySelector('.job-title-wrap .salary');
      if (salaryEl) info.salary = salaryEl.textContent.trim();
    } catch(e) {}
    try {
      var detailContent = dialog.querySelector('.job-details')
        || dialog.querySelector('.job-detail-content')
        || dialog.querySelector('.detail-content')
        || dialog.querySelector('.job-sec');
      if (detailContent) info.description = detailContent.textContent.trim();
      else info.description = dialog.textContent.trim();
    } catch(e) {}
    try {
      var tagItems = dialog.querySelectorAll('.job-summary-wrap .info-item');
      if (tagItems.length) info.tags = Array.from(tagItems).map(function(t){return t.textContent.trim()});
    } catch(e) {}
    return JSON.stringify(info);
  })()`);

  const { closeBossPopup } = await import('./extract-common.mjs');
  await closeBossPopup(targetId, '.job-details-dialog', 'JD弹窗');

  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

// ===== 未读筛选 =====

async function ensureUnreadFilter(targetId) {
  const result = await proxyPost(`/eval?target=${targetId}`, `
    (() => {
      const el = Array.from(document.querySelectorAll('span,button,a,div,li'))
        .find(el => (el.innerText || el.textContent || '').trim() === '未读');
      if (!el) return { clicked: false, reason: 'not found' };
      el.click();
      return { clicked: true };
    })()
  `);

  if (!result || !result.value?.clicked) {
    console.warn('[未读筛选] 未找到"未读"按钮，降级为全量提取');
    return;
  }

  console.log('[未读筛选] 已点击"未读"，等待列表刷新...');

  const maxWait = 8000;
  const start = Date.now();
  let prevCount = -1;
  let stableCount = 0;

  while (Date.now() - start < maxWait) {
    try {
      const count = parseInt(await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`)) || 0;
      if (count === prevCount && count > 0) {
        stableCount++;
        if (stableCount >= 3) {
          console.log(`[未读筛选] 列表已刷新稳定 (${count} 项)`);
          return;
        }
      } else {
        stableCount = 0;
        prevCount = count;
      }
    } catch {}
    await sleep(400);
  }

  console.warn(`[未读筛选] 等待列表刷新超时 (当前 ${prevCount} 项)，继续`);
}

// ===== 取消清理 =====

let _cleanupTargetId = null;
let _cleanupWorker = null;

async function doCleanup() {
  if (!_cleanupTargetId && !_cleanupWorker) return;
  console.log('\n收到取消指令，清理资源...');
  if (_cleanupTargetId) {
    try { await proxyGet(`/close?target=${_cleanupTargetId}`); } catch {}
    _cleanupTargetId = null;
  }
  if (_cleanupWorker) {
    try { await _cleanupWorker.terminate(); } catch {}
    _cleanupWorker = null;
  }
}

process.stdin.on('data', (data) => {
  if (data.toString().trim() === 'CANCEL') {
    doCleanup().finally(() => process.exit(0));
  }
});
if (process.stdin && typeof process.stdin.unref === 'function') {
  process.stdin.unref();
}

process.on('SIGTERM', () => {
  doCleanup().finally(() => process.exit(0));
});

// ===== 主流程 =====

async function main() {
  const opts = parseArgs();
  const outputPath = resolve(opts.output);
  const outputDir = dirname(outputPath);

  archiveOldOutput(outputDir, opts.resume);

  const modeLabel = opts.extractAll ? '全部' : `前 ${opts.count} 个`;
  console.log(`\n========== Boss直聘候选人全量提取 (沟通页) ==========`);
  console.log(`提取模式: ${modeLabel}`);
  if (opts.resume) console.log('恢复模式: 从上次进度继续');
  console.log(`输出文件: ${outputPath}\n`);

  mkdirSync(dirname(outputPath), { recursive: true });
  const tempDir = resolve(dirname(outputPath), '.temp-screenshots');
  mkdirSync(tempDir, { recursive: true });

  // ===== 阶段 1：扫描候选人列表 =====
  let candidateList;
  let scanCache = null;

  if (opts.resume) {
    scanCache = loadScanCache(outputPath);
  }

  if (scanCache) {
    candidateList = scanCache.candidates;
    console.log(`跳过扫描阶段，使用缓存: ${candidateList.length} 人\n`);
  } else {
    console.log('打开 Boss 直聘沟通页...');
    const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
    const targetId = newTab.targetId;
    console.log(`Tab 已创建: ${targetId}`);

    console.log('等待页面加载...');
    const listCount = await waitForCandidateList(targetId, 15000);
    console.log(`页面已加载，候选人列表: ${listCount} 项\n`);

    await ensureUnreadFilter(targetId);

    if (opts.extractAll) {
      console.log('扫描全部候选人 geekId...');
      candidateList = await scanAllCandidateGeekIds(targetId, {
        onProgress: (total, attempt, newCount) => {
          console.log(`  扫描进度: ${total} 人 (第 ${attempt + 1} 次滚动, 新增 ${newCount})`);
        },
      });
    } else {
      console.log(`扫描前 ${opts.count} 个候选人 geekId...`);
      candidateList = await scanUpToCandidateGeekIds(targetId, opts.count, {
        onProgress: (total, attempt, newCount) => {
          console.log(`  扫描进度: ${total}/${opts.count} 人 (第 ${attempt + 1} 次滚动, 新增 ${newCount})`);
        },
      });
    }

    console.log(`扫描完成: 发现 ${candidateList.length} 个候选人\n`);

    if (candidateList.length === 0) {
      console.error('未扫描到候选人，退出');
      await proxyGet(`/close?target=${targetId}`);
      process.exit(1);
    }

    saveScanCache(candidateList, outputPath);

    if (!opts.extractAll && candidateList.length > opts.count) {
      candidateList = candidateList.slice(0, opts.count);
    }

    console.log('关闭扫描 tab...');
    await proxyGet(`/close?target=${targetId}`);
  }

  // ===== 阶段 2：逐个提取候选人 =====

  let progressData = null;
  const processedGeekIds = new Set();
  const candidates = [];

  if (opts.resume) {
    progressData = loadProgress(outputPath);
    if (progressData) {
      const scanGeekIds = new Set(candidateList.map(c => c.geekId));
      const validGeekIds = progressData.processedGeekIds.filter(gid => scanGeekIds.has(gid));
      const invalidCount = progressData.processedGeekIds.length - validGeekIds.length;
      if (invalidCount > 0) {
        console.warn(`⚠ 进度缓存中有 ${invalidCount} 个 geekId 不在当前扫描结果中，已忽略`);
      }
      for (const gid of validGeekIds) {
        processedGeekIds.add(gid);
      }
      const validCandidates = progressData.candidates.filter(c => processedGeekIds.has(c.geekId));
      candidates.push(...validCandidates);
      console.log(`已有 ${processedGeekIds.size} 人完成提取，跳过这些候选人\n`);
    }
  }

  // 初始化 OCR
  console.log('初始化 OCR 引擎...');
  const { createWorker } = await import('tesseract.js');
  const localLangDir = resolve(__dirname, '..', 'ocr-lang');
  const workerOpts = {};
  if (existsSync(resolve(localLangDir, 'chi_sim.traineddata.gz'))) {
    workerOpts.langPath = localLangDir;
    workerOpts.gzip = true;
    console.log(`  使用本地语言包: ${localLangDir}`);
  } else {
    console.log('  本地未找到语言包，将从 CDN 下载');
  }
  const worker = await createWorker('chi_sim', 1, workerOpts);
  _cleanupWorker = worker;
  console.log('OCR 引擎就绪\n');

  // 创建新 tab 用于提取
  console.log('打开 Boss 直聘沟通页...');
  const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
  const targetId = newTab.targetId;
  _cleanupTargetId = targetId;
  console.log(`Tab 已创建: ${targetId}`);

  console.log('等待页面加载...');
  const listCount = await waitForCandidateList(targetId, 15000);
  console.log(`页面已加载，候选人列表: ${listCount} 项\n`);

  await ensureUnreadFilter(targetId);

  const jobDescCache = new Map();

  const toProcess = candidateList.filter(c => !processedGeekIds.has(c.geekId));
  const totalCount = candidateList.length;
  const alreadyDone = processedGeekIds.size;

  console.log(`待提取: ${toProcess.length} 人 (已完成 ${alreadyDone}，总计 ${totalCount})\n`);

  if (toProcess.length === 0) {
    console.log('所有候选人已提取完成');
  } else {
    for (let i = 0; i < toProcess.length; i++) {
      const { geekId, listName } = toProcess[i];
      const globalIndex = alreadyDone + i + 1;
      const displayName = listName || `候选人${globalIndex}`;
      console.log(`[${globalIndex}/${totalCount}] ${displayName} (geekId=${geekId})`);

      let candidateData = { index: globalIndex, geekId };

      try {
        // 1. 通过 geekId 精准点击候选人
        console.log('  → 点击候选人卡片...');
        await clickCandidateByGeekId(targetId, geekId);

        // 2. 提取基础信息
        console.log('  → 提取基础信息...');
        try {
          const rawInfo = await cdpEval(targetId, EXTRACT_BASIC_INFO_SCRIPT);
          const info = JSON.parse(rawInfo);
          candidateData = { ...candidateData, ...info };
          const name = info.basicInfo?.name || displayName;
          console.log(`  ✓ 基础信息: ${name}`);
        } catch (e) {
          console.warn(`  ⚠ 基础信息提取失败: ${e.message}`);
          await randomDelay(500, 800);
          try {
            await clickCandidateByGeekId(targetId, geekId);
            await randomDelay(800, 1200);
            const rawInfo = await cdpEval(targetId, EXTRACT_BASIC_INFO_SCRIPT);
            const info = JSON.parse(rawInfo);
            candidateData = { ...candidateData, ...info };
            console.log(`  ✓ 重试成功`);
          } catch {
            console.warn(`  ⚠ 重试仍然失败，跳过基础信息`);
          }
        }

        // 2.5 提取岗位描述
        const appliedJob = candidateData.positionInfo?.appliedJob || '';
        if (appliedJob && jobDescCache.has(appliedJob)) {
          candidateData.jobDescription = jobDescCache.get(appliedJob);
          console.log(`  ✓ 岗位描述(缓存): ${appliedJob}`);
        } else if (appliedJob) {
          console.log('  → 提取岗位描述...');
          try {
            const jd = await extractJobDescription(targetId);
            if (jd) {
              candidateData.jobDescription = jd;
              jobDescCache.set(appliedJob, jd);
              console.log(`  ✓ 岗位描述: ${jd.jobName || appliedJob}`);
            } else {
              console.log(' 未找到岗位描述弹窗');
            }
          } catch (e) {
            console.warn(` 岗位描述提取失败: ${e.message}`);
          }
        }

        // 3. 提取在线简历
        console.log('  → 打开在线简历...');
        const hasResume = await clickOnlineResume(targetId);
        if (hasResume) {
          try {
            const name = candidateData.basicInfo?.name || displayName;
            const sname = safeName(name);
            console.log('  → 截图...');
            const screenshots = await captureResumeScreenshots(targetId, sname, tempDir);

            console.log('  → OCR 识别...');
            const resumeText = await ocrScreenshots(screenshots, worker);
            candidateData.resumeText = resumeText;
            console.log(`  ✓ 简历提取完成 (${resumeText.length} 字)`);

            const resumeDir = resolve(dirname(outputPath), 'resumes');
            mkdirSync(resumeDir, { recursive: true });
            const txtPath = resolve(resumeDir, `${sname}-${geekId}.txt`);
            writeFileSync(txtPath, resumeText, 'utf8');
          } catch (e) {
            console.warn(`  ⚠ 简历提取失败: ${e.message}`);
          }

          try {
            const closed = await closeResumeDialog(targetId);
            if (!closed) console.warn('  ⚠ 简历弹窗关闭异常');
          } catch (e) {
            console.warn(`  ⚠ 简历弹窗关闭失败: ${e.message}`);
          }
        } else {
          console.log('  ℹ 该候选人无在线简历');
        }
      } catch (err) {
        console.error(`  ✗ 处理失败: ${err.message}`);
        try {
          const closed = await closeResumeDialog(targetId);
          if (!closed) console.warn('  ⚠ 简历弹窗关闭异常');
        } catch (e) {
          console.warn(`  ⚠ 简历弹窗关闭失败: ${e.message}`);
        }
      }

      processedGeekIds.add(geekId);
      candidates.push(candidateData);

      if ((i + 1) % 5 === 0) {
        saveProgress(processedGeekIds, candidates, outputPath);
        console.log(`  💾 进度已保存 (${processedGeekIds.size}/${totalCount})`);
      }

      if ((i + 1) % 50 === 0 && i < toProcess.length - 1) {
        const pauseMs = 30000;
        console.log(`  ⏸ 已处理 ${i + 1} 人，暂停 ${(pauseMs / 1000).toFixed(0)}s 防风控...`);
        await sleep(pauseMs);
      }

      if (i < toProcess.length - 1) {
        const delayMs = 3000 + Math.random() * 5000;
        console.log(`  ⏳ 等待 ${(delayMs / 1000).toFixed(1)}s...\n`);
        await sleep(delayMs);
      }
    }
  }

  // 关闭 tab
  console.log('\n关闭 tab...');
  await proxyGet(`/close?target=${targetId}`);
  await worker.terminate();
  _cleanupTargetId = null;
  _cleanupWorker = null;

  // 保存最终结果
  const output = {
    requested: opts.extractAll ? 'all' : opts.count,
    actual: candidates.length,
    totalScanned: totalCount,
    extractedAt: new Date().toISOString(),
    candidates,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  cleanupCacheFiles(outputPath);

  const withResume = candidates.filter(c => c.resumeText).length;
  const withBasic = candidates.filter(c => c.basicInfo).length;
  console.log(`\n========== 提取结果摘要 ==========`);
  console.log(`总计: ${candidates.length} 人`);
  console.log(`有基础信息: ${withBasic} 人`);
  console.log(`有在线简历: ${withResume} 人`);
  console.log(`输出文件: ${outputPath}`);
  if (withResume > 0) {
    console.log(`简历目录: ${resolve(dirname(outputPath), 'resumes')}`);
  }

  await reportStats({
    resume_count: candidates.length,
    start_time: startTime,
    status: 'success',
  });
}

main().catch(async (err) => {
  console.error('致命错误:', err.message);
  await reportStats({
    resume_count: 0,
    start_time: startTime,
    status: 'error',
  });
  process.exit(1);
});
