#!/usr/bin/env node
/**
 * extract-candidates-full.mjs - Boss直聘候选人全量提取（基础信息 + 在线简历）
 *
 * 在第一轮提取中一次性完成：
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

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = 3456;
const startTime = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T') + new Date().toISOString().slice(19, 23);

// ===== CLI 参数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key === 'all' || key === 'resume') {
        opts[key] = true;
      } else {
        opts[key] = args[i + 1];
        i++;
      }
    }
  }

  // --all 或 --count 0 表示提取全部
  const countRaw = opts.count !== undefined ? parseInt(opts.count, 10) : undefined;
  if (opts.all || countRaw === 0) {
    opts.extractAll = true;
    opts.count = undefined;
  } else if (countRaw !== undefined) {
    let count = countRaw;
    if (count < 1) count = 1;
    opts.count = count;
    opts.extractAll = false;
  } else {
    // 未指定 --count 且未指定 --all，默认提取 10 个
    opts.count = 10;
    opts.extractAll = false;
  }

  opts.output = opts.output || 'output/zhipin-candidates.json';
  return opts;
}

// ===== CDP Proxy HTTP 调用 =====
function proxyGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${PROXY_PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function proxyPost(path, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port: PROXY_PORT,
      path, method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ===== 统计数据上报 =====
async function reportStats({ resume_count, start_time, status }) {
  const url = process.env.STATS_API_URL || 'http://192.168.201.39:8100/ai_efficiency/api/submit_screening_record/';
  // 转为本地时间字符串，避免时区后缀导致 SQLite 报错
  const localTime = new Date(start_time).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_count, start_time: localTime, status }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await res.json();
    if (res.ok && data.code === 200) {
      console.log('Stats reported successfully');
    } else {
      console.warn(`Stats report failed: HTTP ${res.status}, ${JSON.stringify(data)}`);
    }
  } catch (e) {
    console.warn(`Stats report failed: ${e.message}`);
  }
}

function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(ms));
}

// ===== CDP 快捷操作 =====
async function cdpEval(targetId, expr) {
  const result = await proxyPost(`/eval?target=${targetId}`, expr);
  if (result.error) throw new Error(`eval error: ${result.error}`);
  return result.value;
}

async function cdpScreenshot(targetId, filePath, clip) {
  let url = `/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}`;
  if (clip) {
    url += `&clip=${clip.x},${clip.y},${clip.width},${clip.height}`;
  }
  const result = await proxyGet(url);
  // 验证文件是否真正保存成功
  if (!existsSync(filePath)) {
    throw new Error(`截图文件未保存: ${filePath}, proxy响应: ${JSON.stringify(result)}`);
  }
  const stat = readFileSync(filePath);
  if (stat.length === 0) {
    throw new Error(`截图文件为空: ${filePath}`);
  }
  return result;
}

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

// 读取当前可见的 .geek-item 元素的 geekId 和姓名
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

// 滚动候选人列表容器向下
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

// 滚动候选人列表容器向上
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

// 重置列表滚动到顶部
async function scrollListToTop(targetId) {
  await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (list) list.scrollTop = 0;
  })()`);
  await randomDelay(800, 1200);
}

// 扫描全部候选人 geekId（逐步滚动，去重，终止检测）
async function scanAllCandidateGeekIds(targetId, opts = {}) {
  const { maxScrollAttempts = 500, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  // 重置到顶部
  await scrollListToTop(targetId);

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // 读取当前可见项目
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

    // 进度回调
    if (onProgress) onProgress(candidateList.length, attempt, newInThisBatch);

    // 向下滚动
    const scroll = await scrollListDown(targetId);
    if (!scroll.ok) break;

    // scrollHeight 增长 → 新内容已加载 → 重置终止信号
    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      prevScrollTop = -1; // 允许继续向下滚入新区域
      noNewCount = Math.max(0, noNewCount - 2);
    } else if (!scroll.scrolled) {
      // 触底且无新数据：先不中断，耐心等待可能加载的新内容
      // 不做特殊处理，继续通过 noNewCount 和 scrollTop 判断
    }

    // 终止检测：scrollTop 未变化（物理到底，且 scrollHeight 未增长）
    if (scroll.scrollTop === prevScrollTop) break;
    prevScrollTop = scroll.scrollTop;

    // 终止检测：连续多次无新 geekId
    if (noNewCount >= noNewThreshold) break;

    // 触底时等更久（给API加载时间），正常滚动用短间隔
    await randomDelay(scroll.scrolled ? 800 : 3000, scroll.scrolled ? 1200 : 4000);
  }

  return candidateList;
}

// 扫描前 N 个候选人 geekId（滚动直到发现 N 个）
async function scanUpToCandidateGeekIds(targetId, count, opts = {}) {
  const { maxScrollAttempts = 200, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  // 重置到顶部
  await scrollListToTop(targetId);

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // 已达到目标数量
    if (candidateList.length >= count) break;

    // 读取当前可见项目
    const visibleItems = await readVisibleGeekItems(targetId);
    let newInThisBatch = 0;

    for (const item of visibleItems) {
      if (item.geekId && !seenGeekIds.has(item.geekId)) {
        seenGeekIds.add(item.geekId);
        candidateList.push(item);
        newInThisBatch++;
        // 达到目标数量即停止
        if (candidateList.length >= count) break;
      }
    }

    if (newInThisBatch === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress(candidateList.length, attempt, newInThisBatch);

    // 终止检测
    if (noNewCount >= noNewThreshold) break;
    if (candidateList.length >= count) break;

    // 向下滚动
    const scroll = await scrollListDown(targetId);
    if (!scroll.ok) break;

    // scrollHeight 增长 → 新内容已加载 → 重置终止信号
    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      prevScrollTop = -1; // 允许继续向下滚入新区域
      noNewCount = Math.max(0, noNewCount - 2);
    } else if (!scroll.scrolled) {
      // 触底且无新数据：不做特殊处理，靠 noNewCount 和 scrollTop 判断
    }

    // 终止检测：scrollTop 未变化（物理到底）
    if (scroll.scrollTop === prevScrollTop) break;
    prevScrollTop = scroll.scrollTop;

    await randomDelay(1500, 2500);
  }

  return candidateList;
}

// 通过 geekId 精准定位并点击候选人卡片
async function clickCandidateByGeekId(targetId, geekId) {
  // 优先通过 geekId 定位
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

  // geekId 不在 DOM 中，通过滚动搜索
  // 先重置到顶部再向下搜索，避免从中间位置开始导致遗漏
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

  // 向下未找到，尝试向上滚动
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

// ===== 基础信息提取（复用 zhipin.com.md 中定义的脚本） =====
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
  // 点击岗位名称
  const clickResult = await cdpEval(targetId, `(function(){
    var nameEl = document.querySelector('.position-name');
    if (!nameEl) return 'not-found';
    nameEl.click();
    return 'clicked';
  })()`);
  if (clickResult === 'not-found') return null;

  // 等待弹窗出现
  await randomDelay(1000, 1500);

  // 提取岗位描述
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

  // 关闭弹窗
  await closeBossPopup(targetId, '.job-details-dialog', 'JD弹窗');

  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}

// ===== 在线简历弹窗操作 =====

async function clickOnlineResume(targetId) {
  const result = await cdpEval(targetId, `(function(){
    var btn = document.querySelector('a.btn.resume-btn-online');
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked';
  })()`);
  if (result === 'not-found') return false;

  // 等待弹窗出现且尺寸稳定（Boss弹窗有展开动画，需等动画完成）
  const maxWait = 15000;
  const start = Date.now();
  let lastWidth = 0, lastHeight = 0;
  let stableCount = 0;
  
  while (Date.now() - start < maxWait) {
    try {
      const dialogState = await cdpEval(targetId, `(function(){
        var detail = document.querySelector('.resume-detail');
        if (!detail) return JSON.stringify({found: false});
        var rect = detail.getBoundingClientRect();
        var iframe = detail.querySelector('iframe');
        var idoc = null, hasResume = false, hasCanvas = false;
        if (iframe) {
          try {
            idoc = iframe.contentDocument || iframe.contentWindow.document;
            hasResume = !!idoc.querySelector('#resume');
            hasCanvas = !!idoc.querySelector('canvas#resume');
          } catch(e) {}
        }
        return JSON.stringify({
          found: true,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          hasIframe: !!iframe,
          iframeLoaded: iframe ? !!iframe.contentWindow : false,
          hasResume: hasResume,
          hasCanvas: hasCanvas
        });
      })()`);
      const state = JSON.parse(dialogState);
      
      if (state.found && state.width > 0 && state.height > 0) {
        // 检测尺寸是否稳定（连续两次相同，说明动画已完成）
        // sizeOk 仅用于日志警告，尺寸一旦稳定就返回（避免 Boss 渲染窄版时死等超时）
        const sizeOk = state.width >= 600 && state.height >= 500;
        if (state.width === lastWidth && state.height === lastHeight) {
          stableCount++;
          if (stableCount >= 2) {
            // 尺寸已稳定，再等 iframe 内容渲染
            const waitForIframe = state.hasIframe && state.hasResume && state.hasCanvas ? 2000 : 4000;
            const sizeWarn = sizeOk ? '' : ' ⚠尺寸偏小';
            console.log(`    弹窗尺寸稳定: ${state.width}x${state.height}, iframe=${state.hasIframe}, resume=${state.hasResume}, canvas=${state.hasCanvas}, 额外等待 ${waitForIframe}ms${sizeWarn}`);
            await sleep(waitForIframe);
            return true;
          }
        } else {
          stableCount = 0;
          lastWidth = state.width;
          lastHeight = state.height;
        }
      }
    } catch {}
    await sleep(400);
  }
  
  console.log('    ⚠ 等待弹窗超时');
  return false;
}

async function getDialogClip(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var detail = document.querySelector('.resume-detail');
    if (!detail) {
      var fallback = document.querySelector('.boss-popup__wrapper') || document.querySelector('.dialog-wrap');
      if (!fallback) return JSON.stringify(null);
      var r = fallback.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), source: 'fallback' });
    }

    var detailRect = detail.getBoundingClientRect();
    var iframe = detail.querySelector('iframe');
    
    // 优先用 iframe 的实际宽度（有些候选人的简历 iframe 比容器窄）
    if (iframe) {
      var iframeRect = iframe.getBoundingClientRect();
      // iframe 有有效宽度时，取 iframe 宽 + detail 高（detail 负责滚动，高度是可视区）
      if (iframeRect.width >= 300 && iframeRect.height > 0) {
        // x,y 以 iframe 为准，高度以 detail 可视区为准
        return JSON.stringify({
          x: Math.round(iframeRect.x),
          y: Math.round(detailRect.y),
          width: Math.round(iframeRect.width),
          height: Math.round(detailRect.height),
          source: 'iframe',
          detailWidth: Math.round(detailRect.width)
        });
      }
    }
    
    return JSON.stringify({
      x: Math.round(detailRect.x),
      y: Math.round(detailRect.y),
      width: Math.round(detailRect.width),
      height: Math.round(detailRect.height),
      source: 'detail'
    });
  })()`);
  return JSON.parse(raw);
}

async function getResumeScrollInfo(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var detail = document.querySelector('.resume-detail');
    if (!detail) return JSON.stringify({error: 'no .resume-detail'});

    var iframe = detail.querySelector('iframe');
    
    // Boss直聘简历结构：.resume-detail > iframe > body > DIV#resume > CANVAS#resume
    // .resume-detail 是滚动容器 (overflow:auto)
    // iframe 高度 = 内容实际高度（大于可视区）
    // canvas 固定为可视区大小，通过 translateY 模拟滚动
    
    if (iframe) {
      try {
        var idoc = iframe.contentDocument || iframe.contentWindow.document;
        var resumeDiv = idoc.querySelector('#resume') || idoc.querySelector('div');
        var canvas = idoc.querySelector('canvas#resume') || idoc.querySelector('canvas');
        
        if (resumeDiv && canvas) {
          // 取 DIV#resume 高度、detail.scrollHeight、iframe.offsetHeight 三者的最大值
          var divHeight = resumeDiv.offsetHeight;
          var detailHeight = detail.scrollHeight;
          var iframeHeight = iframe.offsetHeight;
          var contentHeight = Math.max(divHeight, detailHeight, iframeHeight);
          var viewHeight = detail.clientHeight;
          if (contentHeight > viewHeight) {
            return JSON.stringify({
              scrollHeight: contentHeight,
              clientHeight: viewHeight,
              scrollTop: detail.scrollTop,
              scrollTarget: 'resume-detail',
              source: 'iframe-canvas-div',
              canvasSize: canvas.width + 'x' + canvas.height,
              heights: 'div=' + divHeight + ',detail=' + detailHeight + ',iframe=' + iframeHeight
            });
          }
        }
        
        // iframe 存在但检测失败，返回调试信息
        var bodyChildren = idoc.body ? Array.from(idoc.body.children).map(function(el){ 
          return el.tagName + (el.id ? '#' + el.id : '') + '(' + el.offsetWidth + 'x' + el.offsetHeight + ')'; 
        }).join(', ') : 'no-body';
        var iframeSrc = iframe.src || iframe.getAttribute('src') || 'no-src';
        return JSON.stringify({
          scrollHeight: detail.scrollHeight,
          clientHeight: detail.clientHeight,
          scrollTop: detail.scrollTop,
          scrollTarget: 'resume-detail',
          source: 'iframe-debug',
          debug: 'resumeDiv=' + (resumeDiv ? resumeDiv.tagName + '#' + (resumeDiv.id || 'none') + '(' + resumeDiv.offsetWidth + 'x' + resumeDiv.offsetHeight + ')' : 'null') + 
                 ', canvas=' + (canvas ? canvas.tagName + '#' + (canvas.id || 'none') + '(' + canvas.width + 'x' + canvas.height + ')' : 'null') +
                 ', bodyChildren=[' + bodyChildren + ']' +
                 ', iframeH=' + iframe.offsetHeight + ', detailH=' + detail.scrollHeight +
                 ', src=' + iframeSrc.substring(0, 100)
        });
      } catch(e) {
        return JSON.stringify({
          scrollHeight: detail.scrollHeight,
          clientHeight: detail.clientHeight,
          scrollTop: detail.scrollTop,
          scrollTarget: 'resume-detail',
          source: 'iframe-error',
          error: e.message
        });
      }
    }
    
    // .resume-detail 本身可滚动（适用于 iframe 已加载完成的情况）
    if (detail.scrollHeight > detail.clientHeight) {
      return JSON.stringify({
        scrollHeight: detail.scrollHeight,
        clientHeight: detail.clientHeight,
        scrollTop: detail.scrollTop,
        scrollTarget: 'resume-detail',
        source: 'detail-scroll'
      });
    }
    
    // 兑底：iframe 存在但尺寸还没渲染完，用 iframe 元素高度
    if (iframe && iframe.offsetHeight > detail.clientHeight) {
      return JSON.stringify({
        scrollHeight: iframe.offsetHeight,
        clientHeight: detail.clientHeight,
        scrollTop: 0,
        scrollTarget: 'resume-detail',
        source: 'iframe-offset'
      });
    }
    
    // 最终兑底
    return JSON.stringify({
      scrollHeight: detail.scrollHeight,
      clientHeight: detail.clientHeight,
      scrollTop: detail.scrollTop,
      scrollTarget: 'resume-detail',
      source: 'detail-fallback'
    });
  })()`);
  return JSON.parse(raw);
}

async function scrollResume(targetId, scrollTop) {
  // 统一滚动 .resume-detail 容器（Boss直聘的实际滚动容器）
  await cdpEval(targetId, `(function(){
    var el = document.querySelector('.resume-detail');
    if (el) {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = ${scrollTop};
    }
  })()`);
  await randomDelay(800, 1200);
}

// ===== 通用弹窗关闭 =====

async function closeBossPopup(targetId, popupSelector, label = '弹窗') {
  // 尝试多种关闭按钮选择器
  // 注意：关闭按钮 .close-btn 在 .dialog-wrap 内、popupSelector 元素外部
  // 所以需要从 dialog-wrap 层级查找，而不能仅从 popup 内部查找
  const closed = await cdpEval(targetId, `(function(){
    var popup = document.querySelector('${popupSelector}');
    if (!popup) return 'not-exist';
    // 优先从 dialog-wrap 查找关闭按钮（.close-btn 在 popup 外层）
    var dialogWrap = document.querySelector('.dialog-wrap.active');
    var closeBtn = dialogWrap && dialogWrap.querySelector('.close-btn');
    if (!closeBtn) closeBtn = popup.querySelector('.close-btn');
    if (!closeBtn) closeBtn = popup.querySelector('.boss-popup__close');
    if (!closeBtn) closeBtn = popup.querySelector('[class*="close"]');
    if (closeBtn) { closeBtn.click(); return 'clicked'; }
    // 兜底：尝试页面级别的关闭按钮
    var pageClose = document.querySelector('.dialog-wrap.active .close-btn')
      || document.querySelector('.boss-popup__close');
    if (pageClose) { pageClose.click(); return 'clicked-page'; }
    return 'no-close-btn';
  })()`);
  await randomDelay(800, 1500);

  if (closed === 'not-exist') return true;

  // 确认弹窗是否已关闭
  const stillVisible = await cdpEval(targetId, `(function(){
    var popup = document.querySelector('${popupSelector}');
    if (popup && popup.offsetParent !== null) return 'still-visible';
    return 'closed';
  })()`);

  if (stillVisible === 'still-visible') {
    // 重试一次
    await cdpEval(targetId, `(function(){
      var dialogWrap = document.querySelector('.dialog-wrap.active');
      var closeBtn = dialogWrap && dialogWrap.querySelector('.close-btn');
      if (!closeBtn) {
        var popup = document.querySelector('${popupSelector}');
        closeBtn = popup && (popup.querySelector('.close-btn')
          || popup.querySelector('.boss-popup__close')
          || popup.querySelector('[class*="close"]'));
      }
      if (closeBtn) closeBtn.click();
    })()`);
    await randomDelay(800, 1500);

    const retryCheck = await cdpEval(targetId, `(function(){
      var popup = document.querySelector('${popupSelector}');
      if (popup && popup.offsetParent !== null) return 'still-visible';
      return 'closed';
    })()`);

    if (retryCheck === 'still-visible') {
      // 强制移除 DOM（移除整个 dialog-wrap）
      await cdpEval(targetId, `(function(){
        var dialogWrap = document.querySelector('.dialog-wrap.active');
        if (dialogWrap) dialogWrap.remove();
      })()`);
      console.warn(`  ⚠ ${label}关闭失败，已强制移除DOM`);
      await randomDelay(300, 500);
      return false;
    }
  }

  return true;
}

async function closeResumeDialog(targetId) {
  return closeBossPopup(targetId, '.resume-detail', '简历弹窗');
}

async function captureResumeScreenshots(targetId, safename, tempDir) {
  // 获取滚动信息，如果检测到 fallback 且 iframe 存在，等待重试
  let info = await getResumeScrollInfo(targetId);
  if (info.error) throw new Error(info.error);
  
  // 如果 scrollHeight == clientHeight 且 iframe 存在，可能内容还没渲染完，等待重试
  if (info.scrollHeight <= info.clientHeight && (info.source?.includes('fallback') || info.source?.includes('debug'))) {
    for (let retry = 0; retry < 5; retry++) {
      console.log(`    等待内容渲染... (第${retry + 1}次)`);
      await sleep(2000);
      info = await getResumeScrollInfo(targetId);
      if (info.scrollHeight > info.clientHeight) break;
    }
  }

  const { scrollHeight, clientHeight, source, canvasSize } = info;
  const step = Math.floor(clientHeight * 0.95);
  const pages = Math.ceil((scrollHeight - clientHeight) / step) + 1;
  const screenshots = [];

  const clip = await getDialogClip(targetId);
  if (clip) {
    console.log(`    弹窗区域: x=${clip.x}, y=${clip.y}, ${clip.width}x${clip.height} (source=${clip.source}${clip.detailWidth ? ', detailW=' + clip.detailWidth : ''})`);
  }
  console.log(`    检测源: ${source || 'unknown'}${canvasSize ? ', Canvas: ' + canvasSize : ''}${info.heights ? ', ' + info.heights : ''}${info.debug ? ', debug: ' + info.debug : ''}`);
  console.log(`    简历高度: ${scrollHeight}px, 可视: ${clientHeight}px, 步进: ${step}px, 需截 ${pages} 页`);

  let prevActualTop = -1;
  for (let page = 0; page < pages; page++) {
    const scrollTop = Math.min(page * step, scrollHeight - clientHeight);
    await scrollResume(targetId, scrollTop);
    
    // 调试：输出滚动后的实际状态
    const actualScrollTop = parseInt(await cdpEval(targetId, `document.querySelector('.resume-detail').scrollTop`)) || 0;
    console.log(`    第${page + 1}页: 目标=${scrollTop}, 实际=${actualScrollTop}`);
    
    // 滚动停滞检测：如果不是第1页且实际位置没变化，说明已到底部
    if (page > 0 && actualScrollTop <= prevActualTop) {
      console.log(`    ⚡ 已到达底部 (滚动停滞在 ${actualScrollTop}), 跳过剩余 ${pages - page} 页`);
      break;
    }
    prevActualTop = actualScrollTop;
    
    const ssPath = resolve(tempDir, `${safename}-p${page}.png`);

    // 截图（含重试）
    let success = false;
    for (let retry = 0; retry < 2; retry++) {
      try {
        await cdpScreenshot(targetId, ssPath, clip);
        screenshots.push(ssPath);
        success = true;
        break;
      } catch (e) {
        console.warn(`    ⚠ 截图第 ${page + 1}/${pages} 页失败 (${retry + 1}/2): ${e.message}`);
        if (retry < 1) {
          await randomDelay(800, 1500);
          await scrollResume(targetId, scrollTop);
        }
      }
    }
    if (!success) {
      throw new Error(`截图第 ${page + 1}/${pages} 页多次失败`);
    }

    if (page < pages - 1) await randomDelay(600, 1000);
  }

  await scrollResume(targetId, 0);
  return screenshots;
}

// ===== OCR 文本清洗 =====

// 常见 OCR 错字字典（可根据实际效果补充）
const OCR_TYPO_MAP = {
  '沟 通': '沟通',
  '管 理': '管理',
  '研 发': '研发',
  '项 目': '项目',
  '公 司': '公司',
  '工 作': '工作',
  '技 术': '技术',
  '教 育': '教育',
  '经 验': '经验',
  '学 校': '学校',
  '专 业': '专业',
  '职 位': '职位',
  '能 力': '能力',
};

function cleanOcrText(raw) {
  if (!raw) return '';
  let text = raw;

  // 1. 全角字符 → 半角（保留中文标点）
  text = text.replace(/：/g, '：').replace(/，/g, '，');

  // 2. 去除中文字符之间的多余空格（OCR 常见问题）
  // 中文+空格+中文 → 中文+中文
  const CJK = '[\u4e00-\u9fa5\uff00-\uffef\u3000-\u303f]';
  const cjkSpaceRe = new RegExp(`(${CJK})\\s+(${CJK})`, 'g');
  // 执行多次确保连续中文间多个空格被清理
  for (let i = 0; i < 3; i++) {
    text = text.replace(cjkSpaceRe, '$1$2');
  }

  // 3. 中文与标点符号之间的空格
  text = text.replace(/([\u4e00-\u9fa5])\s+([\uff0c\u3002\uff1f\uff01\uff1b\uff1a\u201d\u2019\uff09])/g, '$1$2');
  text = text.replace(/([\uff0c\u3002\uff1a\u201c\u2018\uff08])\s+([\u4e00-\u9fa5])/g, '$1$2');

  // 4. 多个空格/制表符 → 单个空格
  text = text.replace(/[ \t]+/g, ' ');

  // 5. 行首行尾空白去除
  text = text.split('\n').map(l => l.trim()).join('\n');

  // 6. 压缩连续空行：3个以上空行 → 1个空行
  text = text.replace(/\n{3,}/g, '\n\n');

  // 7. 常见错字修正
  for (const [wrong, right] of Object.entries(OCR_TYPO_MAP)) {
    text = text.split(wrong).join(right);
  }

  // 8. 去除孤立的单字符行（OCR 噪声，如单个 · . ` 等）
  text = text.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (t.length === 1 && /[^\u4e00-\u9fa5\w]/.test(t)) return false;
    return true;
  }).join('\n');

  return text.trim();
}

// 相邻页内容去重：月叠行移除
function dedupePages(pages) {
  if (pages.length <= 1) return pages.join('\n\n');
  const result = [pages[0]];
  for (let i = 1; i < pages.length; i++) {
    const prevLines = result[result.length - 1].split('\n').map(l => l.trim()).filter(Boolean);
    const curLines = pages[i].split('\n');
    // 找到 curLines 开头与 prevLines 结尾的最长重叠
    const prevTail = prevLines.slice(-10);
    let overlapEnd = 0;
    for (let n = Math.min(prevTail.length, 10); n > 0; n--) {
      const tail = prevTail.slice(prevTail.length - n);
      const head = curLines.slice(0, n).map(l => l.trim()).filter(Boolean).slice(0, n);
      if (head.length < n) continue;
      let match = true;
      for (let k = 0; k < n; k++) {
        if (tail[k] !== head[k]) { match = false; break; }
      }
      if (match) {
        // 计算 curLines 中前 n 行非空对应的原始下标
        let kept = 0;
        for (let k = 0; k < curLines.length; k++) {
          if (curLines[k].trim()) kept++;
          if (kept === n) { overlapEnd = k + 1; break; }
        }
        break;
      }
    }
    result.push(curLines.slice(overlapEnd).join('\n'));
  }
  return result.join('\n\n');
}

async function ocrScreenshots(screenshots, worker) {
  const texts = [];
  for (let i = 0; i < screenshots.length; i++) {
    console.log(`    OCR 第 ${i + 1}/${screenshots.length} 页...`);
    const { data: { text } } = await worker.recognize(screenshots[i]);
    texts.push(cleanOcrText(text));
  }
  // 先跨页去重，再整体清洗一次
  const merged = dedupePages(texts);
  return cleanOcrText(merged);
}

function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unknown';
}

// ===== 进度保存/恢复 =====

function getScanCachePath(outputPath) {
  return resolve(dirname(outputPath), '.scan-cache.json');
}

function getProgressPath(outputPath) {
  return resolve(dirname(outputPath), '.extract-progress.json');
}

function saveScanCache(candidateList, outputPath) {
  const cachePath = getScanCachePath(outputPath);
  writeFileSync(cachePath, JSON.stringify({
    scannedAt: new Date().toISOString(),
    totalCandidates: candidateList.length,
    candidates: candidateList,
  }, null, 2), 'utf8');
  console.log(`扫描缓存已保存: ${cachePath} (${candidateList.length} 人)`);
}

function loadScanCache(outputPath) {
  const cachePath = getScanCachePath(outputPath);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log(`加载扫描缓存: ${data.totalCandidates} 人 (扫描于 ${data.scannedAt})`);
    return data;
  } catch {
    return null;
  }
}

function saveProgress(processedGeekIds, candidates, outputPath) {
  const progressPath = getProgressPath(outputPath);
  writeFileSync(progressPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    processedCount: processedGeekIds.size,
    processedGeekIds: [...processedGeekIds],
    candidates,
  }, null, 2), 'utf8');
}

function loadProgress(outputPath) {
  const progressPath = getProgressPath(outputPath);
  if (!existsSync(progressPath)) return null;
  try {
    const data = JSON.parse(readFileSync(progressPath, 'utf8'));
    console.log(`加载提取进度: ${data.processedCount} 人已完成`);
    return data;
  } catch {
    return null;
  }
}

function cleanupCacheFiles(outputPath) {
  const files = [getScanCachePath(outputPath), getProgressPath(outputPath)];
  for (const f of files) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {}
  }
}

// ===== 主流程 =====

/**
 * 归档旧的 output 目录：把 output/ 挪到 output-YYYYMMDD-HHMM/
 * resume 模式下跳过（要恢复上次进度）
 */
function archiveOldOutput(outputDir, isResume) {
  if (isResume) {
    console.log('恢复模式：保留现有 output 目录');
    return;
  }
  if (!existsSync(outputDir)) return;
  let entries;
  try {
    entries = readdirSync(outputDir);
  } catch {
    return;
  }
  if (entries.length === 0) return;

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const archived = `${outputDir}-${stamp}`;
  try {
    renameSync(outputDir, archived);
    console.log(`已归档旧 output 目录: ${archived}`);
  } catch (e) {
    console.warn(`归档 output 目录失败: ${e.message}（将继续在原目录上运行）`);
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

  // 动态等待列表刷新：轮询直到 .geek-item 数量稳定
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

async function main() {
  const opts = parseArgs();
  const outputPath = resolve(opts.output);
  const outputDir = dirname(outputPath);

  // 自动归档：运行前把老 output/ 挪到 output-YYYYMMDD-HHMM/
  archiveOldOutput(outputDir, opts.resume);

  const modeLabel = opts.extractAll ? '全部' : `前 ${opts.count} 个`;
  console.log(`\n========== Boss直聘候选人全量提取 ==========`);
  console.log(`提取模式: ${modeLabel}`);
  if (opts.resume) console.log('恢复模式: 从上次进度继续');
  console.log(`输出文件: ${outputPath}\n`);

  // 确保输出目录
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
    // 使用缓存的扫描结果
    candidateList = scanCache.candidates;
    console.log(`跳过扫描阶段，使用缓存: ${candidateList.length} 人\n`);
  } else {
    // 创建新 tab
    console.log('打开 Boss 直聘沟通页...');
    const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
    const targetId = newTab.targetId;
    console.log(`Tab 已创建: ${targetId}`);

    // [试验] 改用真实窗口尺寸：暂时注释 /emulate 调用，避免 1920 过宽触发 Boss max-width 居中布局导致的左侧 gap
    // 若出现后台 tab 变窄/响应式窄版问题，恢复下方这段即可
    // try {
    //   await proxyGet(`/emulate?target=${targetId}&width=1920&height=1080`);
    // } catch { /* 非致命 */ }

    // 等待列表加载
    console.log('等待页面加载...');
    const listCount = await waitForCandidateList(targetId, 15000);
    console.log(`页面已加载，候选人列表: ${listCount} 项\n`);

    // 切换到未读模式
    await ensureUnreadFilter(targetId);

    // 扫描阶段
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

    // 保存扫描缓存
    saveScanCache(candidateList, outputPath);

    // 如果指定了数量但实际扫描到更多，截取前 N 个
    if (!opts.extractAll && candidateList.length > opts.count) {
      candidateList = candidateList.slice(0, opts.count);
    }

    // 关闭扫描用的 tab（阶段 2 会重新打开）
    console.log('关闭扫描 tab...');
    await proxyGet(`/close?target=${targetId}`);
  }

  // ===== 阶段 2：逐个提取候选人 =====

  // 加载已有进度（恢复模式）
  let progressData = null;
  const processedGeekIds = new Set();
  const candidates = [];

  if (opts.resume) {
    progressData = loadProgress(outputPath);
    if (progressData) {
      // 一致性检查：进度中的 geekId 必须在扫描缓存中
      const scanGeekIds = new Set(candidateList.map(c => c.geekId));
      const validGeekIds = progressData.processedGeekIds.filter(gid => scanGeekIds.has(gid));
      const invalidCount = progressData.processedGeekIds.length - validGeekIds.length;
      if (invalidCount > 0) {
        console.warn(`⚠ 进度缓存中有 ${invalidCount} 个 geekId 不在当前扫描结果中，已忽略`);
      }
      for (const gid of validGeekIds) {
        processedGeekIds.add(gid);
      }
      // 只保留 geekId 有效的候选人
      const validCandidates = progressData.candidates.filter(c => processedGeekIds.has(c.geekId));
      candidates.push(...validCandidates);
      console.log(`已有 ${processedGeekIds.size} 人完成提取，跳过这些候选人\n`);
    }
  }

  // 初始化 OCR
  console.log('初始化 OCR 引擎...');
  const { createWorker } = await import('tesseract.js');
  // 优先使用本地预置语言包（ocr-lang/），找不到再回退到 jsDelivr CDN
  const localLangDir = resolve(__dirname, '..', 'ocr-lang');
  const workerOpts = {};
  if (existsSync(resolve(localLangDir, 'chi_sim.traineddata.gz'))) {
    workerOpts.langPath = localLangDir;
    workerOpts.gzip = true;
    console.log(`  使用本地语言包: ${localLangDir}`);
  } else {
    console.log('  本地未找到语言包，将从 CDN 下载');
  }
  const worker = await createWorker('chi_sim+eng', 1, workerOpts);
  console.log('OCR 引擎就绪\n');

  // 创建新 tab 用于提取
  console.log('打开 Boss 直聘沟通页...');
  const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
  const targetId = newTab.targetId;
  console.log(`Tab 已创建: ${targetId}`);

  // [试验] 改用真实窗口尺寸：暂时注释 /emulate 调用，避免 1920 过宽触发 Boss max-width 居中布局导致的左侧 gap
  // 若简历出现窄版/截图窄问题，恢复下方这段即可
  // try {
  //   await proxyGet(`/emulate?target=${targetId}&width=1920&height=1080`);
  //   console.log('已设置 viewport: 1920x1080');
  // } catch (e) {
  //   console.warn(`设置 viewport 失败: ${e.message}`);
  // }
  console.log('[试验] 未强制 viewport，使用真实窗口尺寸');

  // 等待列表加载
  console.log('等待页面加载...');
  const listCount = await waitForCandidateList(targetId, 15000);
  console.log(`页面已加载，候选人列表: ${listCount} 项\n`);

  // 切换到未读模式
  await ensureUnreadFilter(targetId);

  // 岗位描述缓存（同一岗位只提取一次）
  const jobDescCache = new Map();

  // 筛选待处理的候选人
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
          // 重试一次
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

        // 2.5 提取岗位描述（同一岗位只提取一次）
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

            // 保存单独的简历 txt 文件
            const resumeDir = resolve(dirname(outputPath), 'resumes');
            mkdirSync(resumeDir, { recursive: true });
            const txtPath = resolve(resumeDir, `${sname}-${geekId}.txt`);
            writeFileSync(txtPath, resumeText, 'utf8');
          } catch (e) {
            console.warn(`  ⚠ 简历提取失败: ${e.message}`);
          }

          // 关闭弹窗
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

      // 每 5 人保存进度
      if ((i + 1) % 5 === 0) {
        saveProgress(processedGeekIds, candidates, outputPath);
        console.log(`  💾 进度已保存 (${processedGeekIds.size}/${totalCount})`);
      }

      // 每 50 人额外停顿（防风控）
      if ((i + 1) % 50 === 0 && i < toProcess.length - 1) {
        const pauseMs = 30000;
        console.log(`  ⏸ 已处理 ${i + 1} 人，暂停 ${(pauseMs / 1000).toFixed(0)}s 防风控...`);
        await sleep(pauseMs);
      }

      // 候选人之间随机延迟（防风控）
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

  // 保存最终结果
  const output = {
    requested: opts.extractAll ? 'all' : opts.count,
    actual: candidates.length,
    totalScanned: totalCount,
    extractedAt: new Date().toISOString(),
    candidates,
  };

  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf8');

  // 清理缓存文件
  cleanupCacheFiles(outputPath);

  // 摘要
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

  // 上报统计数据
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
