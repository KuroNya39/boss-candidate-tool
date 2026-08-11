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
  cdpEval, prepareTab,
  clickOnlineResume,
  closeResumeDialog,
  captureResumeScreenshots,
  ocrScreenshots, tryExtractResumeTextFromDOM,
  safeName, cleanOcrText, FIND_LIST_CONTAINER_JS,
  getScanCachePath, getProgressPath,
  saveScanCache, loadScanCache, saveProgress, loadProgress, cleanupCacheFiles,
  archiveOldOutput,
  reportStats,
  parseArgs,
  parseEducationFromResume,
} from './extract-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T') + new Date().toISOString().slice(19, 23);

// ===== 查找用户已打开的沟通页 tab =====
async function findChatTab() {
  const targets = await proxyGet('/targets');
  const list = Array.isArray(targets) ? targets : targets.targets || [];
  const tab = list.find(t =>
    t.url && t.url.includes('/web/chat') && !t.url.includes('/web/chat/recommend')
  );
  if (!tab || !tab.targetId) {
    throw new Error(
      '未找到已打开的沟通页。\n' +
      '请先在 Chrome 中打开 Boss 直聘沟通页 https://www.zhipin.com/web/chat\n' +
      '然后重试。'
    );
  }
  console.log(`已附着到用户打开的沟通页: ${tab.url}`);
  return tab.targetId;
}

// ===== 页面操作 =====

async function waitForCandidateList(targetId, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const count = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`);
      if (count > 0) return count;
    } catch {}
    await sleep(400);
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
      var id = el.id || el.getAttribute('data-id') || el.getAttribute('data-geek-id') || '';
      var geekId = id.split('-')[0] || '';
      if (!geekId) {
        // 尝试从 href 或 onclick 属性提取
        var link = el.querySelector('a');
        if (link) {
          var href = link.getAttribute('href') || '';
          var match = href.match(/geekId=([^&]+)/);
          if (match) geekId = match[1];
        }
      }
      var nameEl = el.querySelector('.name') || el.querySelector('.geek-name') || el.querySelector('[class*=name]');
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

/**
 * 滚动候选人列表
 * 容器检测方式：从 .geek-item 向上找第一个可滚动（scrollHeight > clientHeight）的父容器
 * 兼容虚拟滚动容器（overflow:hidden）和普通滚动容器（overflow:auto/scroll）
 */
async function scrollListDown(targetId, aggressive = false) {
  const raw = await cdpEval(targetId, `(function(){
    ${FIND_LIST_CONTAINER_JS}
    var before = el.scrollTop;
    if (${aggressive}) {
      el.scrollTop = el.scrollHeight;
    } else {
      el.scrollTop += Math.floor(el.clientHeight * 0.9);
    }
    var after = el.scrollTop;
    var tag = (el.tagName || '') + (el.className ? '.' + el.className.split(' ')[0].replace(/\\s/g, '') : '') + (el.id ? '#' + el.id : '');
    return JSON.stringify({
      ok: true,
      scrollTop: after,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrolled: after > before,
      containerTag: tag
    });
  })()`);
  const data = JSON.parse(raw);
  return {
    ok: data.ok,
    movedKey: data.scrolled ? data.containerTag : null,
    scrollHeight: data.scrollHeight,
    raw: data
  };
}

/**
 * 向上滚动候选人列表（与 scrollListDown 用同一容器检测方式）
 */
async function scrollListUp(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    ${FIND_LIST_CONTAINER_JS}
    var before = el.scrollTop;
    el.scrollTop = Math.max(0, el.scrollTop - Math.floor(el.clientHeight * 0.7));
    var after = el.scrollTop;
    return JSON.stringify({ok: true, scrolled: after !== before, scrollTop: after});
  })()`);
  const data = JSON.parse(raw);
  return { ok: true, movedKey: data.scrolled ? 'up' : null, raw: data, scrolled: data.scrolled };
}

async function scrollListToTop(targetId) {
  await cdpEval(targetId, `(function(){
    ${FIND_LIST_CONTAINER_JS}
    el.scrollTop = 0;
    return '';
  })()`);
  await randomDelay(500, 800);
}

async function scrollListToBottom(targetId) {
  await cdpEval(targetId, `(function(){
    ${FIND_LIST_CONTAINER_JS}
    el.scrollTop = el.scrollHeight;
    return '';
  })()`);
}

async function scanAllCandidateGeekIds(targetId, opts = {}) {
  const { maxScrollAttempts = 500, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollHeight = 0;
  let hasProbedBottom = false; // 是否已完成底部探测，防止重复

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

    // 连续无新人时：尝试滚到底部触发懒加载
    if (noNewCount >= noNewThreshold) {
      // 如果已经做过完整的底部探测，不再重复
      if (hasProbedBottom) {
        console.log(`   ✓ 已探测过底部，共 ${candidateList.length} 人`);
        break;
      }
      hasProbedBottom = true;

      // 先跳到顶部重新扫描一遍，确保虚拟滚动没有漏掉
      await scrollListToTop(targetId);
      await sleep(2000);
      const topItems = await readVisibleGeekItems(targetId);
      let newFound = false;
      for (const item of topItems) {
        if (item.geekId && !seenGeekIds.has(item.geekId)) {
          seenGeekIds.add(item.geekId);
          candidateList.push(item);
          newFound = true;
        }
      }
      if (newFound) {
        console.log(`   🔄 回到顶部发现新候选人，继续扫描 (${candidateList.length} 人)`);
        noNewCount = 0;
        hasProbedBottom = false;
        continue;
      }
      // 跳到底部，轮询检查 scrollHeight 是否增长（最长等 10s）
      const initial = await scrollListDown(targetId, true);
      const baseSh = initial.scrollHeight;
      let pollStart = Date.now();
      let foundMore = false;
      while (Date.now() - pollStart < 10000) {
        const check = await scrollListDown(targetId, true);
        if (check.movedKey !== null || check.scrollHeight > baseSh) {
          noNewCount = Math.max(0, noNewThreshold - 3);
          console.log(`   ⚡ 滚到底部后又加载了更多: scrollH ${baseSh}→${check.scrollHeight}`);
          foundMore = true;
          break;
        }
        await sleep(1000);
        // 检查是否有新 geekId 出现（即使 scrollHeight 没变）
        const itemsNow = await readVisibleGeekItems(targetId);
        for (const item of itemsNow) {
          if (item.geekId && !seenGeekIds.has(item.geekId)) {
            seenGeekIds.add(item.geekId);
            candidateList.push(item);
            foundMore = true;
            console.log(`   🔄 底部出现新候选人: ${item.geekId} (${candidateList.length} 人)`);
          }
        }
        if (foundMore) break;
      }
      if (foundMore) {
        noNewCount = Math.max(0, noNewThreshold - 3);
        // 继续滚动，但不再做第二次底部探测（防止反复上下滚动）
        continue;
      }
      // 实在没有更多了：滚回顶部再扫一遍作为最终确认
      await scrollListToTop(targetId);
      await sleep(2000);
      const recheckItems = await readVisibleGeekItems(targetId);
      let anyNew = false;
      for (const item of recheckItems) {
        if (item.geekId && !seenGeekIds.has(item.geekId)) {
          seenGeekIds.add(item.geekId);
          candidateList.push(item);
          anyNew = true;
        }
      }
      if (anyNew) {
        console.log(`   🔄 二次回顶发现新候选人: ${candidateList.length} 人`);
        noNewCount = 0;
        continue;
      }
      console.log(`   ✓ 已到列表底部，共 ${candidateList.length} 人`);
      break;
    }

    // 渐进式滚动：接近阈值时用更激进的滚动触发懒加载
    const aggressive = noNewCount >= Math.floor(noNewThreshold / 2);
    const scroll = await scrollListDown(targetId, aggressive);
    if (!scroll.ok) break;

    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scroll.movedKey === null) {
      // 如果已在底部但还没有触发底部探测，让 noNewCount 继续增长触发探测
      if (!aggressive) break;
      await randomDelay(800, 1200);
      continue;
    }

    await randomDelay(800, 1200);
  }

  return candidateList;
}

async function scanUpToCandidateGeekIds(targetId, count, opts = {}) {
  const { maxScrollAttempts = 200, noNewThreshold = 6, onProgress } = opts;

  const seenGeekIds = new Set();
  const candidateList = [];
  let noNewCount = 0;
  let prevScrollHeight = 0;
  let hasProbedBottom = false;

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

    // 连续无新人时：尝试滚到底部触发懒加载
    if (noNewCount >= noNewThreshold) {
      if (candidateList.length >= count) break;

      // 如果已经做过完整的底部探测，不再重复
      if (hasProbedBottom) {
        console.log(`   ✓ 已探测过底部，共 ${candidateList.length} 人`);
        break;
      }
      hasProbedBottom = true;

      // 先跳到顶部重新扫描一遍，确保虚拟滚动没有漏掉
      await scrollListToTop(targetId);
      await sleep(2000);
      const topItems = await readVisibleGeekItems(targetId);
      let newFound = false;
      for (const item of topItems) {
        if (item.geekId && !seenGeekIds.has(item.geekId)) {
          seenGeekIds.add(item.geekId);
          candidateList.push(item);
          newFound = true;
          if (candidateList.length >= count) break;
        }
      }
      if (newFound) {
        console.log(`   🔄 回到顶部发现新候选人，继续扫描 (${candidateList.length} 人)`);
        noNewCount = 0;
        hasProbedBottom = false;
        continue;
      }
      // 跳到底部，轮询检查 scrollHeight 是否增长（最长等 10s）
      const initial = await scrollListDown(targetId, true);
      const baseSh = initial.scrollHeight;
      let pollStart = Date.now();
      let foundMore = false;
      while (Date.now() - pollStart < 10000) {
        const check = await scrollListDown(targetId, true);
        if (check.movedKey !== null || check.scrollHeight > baseSh) {
          noNewCount = Math.max(0, noNewThreshold - 3);
          console.log(`   ⚡ 滚到底部后又加载了更多: scrollH ${baseSh}→${check.scrollHeight}`);
          foundMore = true;
          break;
        }
        await sleep(1000);
        // 检查是否有新 geekId 出现（即使 scrollHeight 没变）
        const itemsNow = await readVisibleGeekItems(targetId);
        for (const item of itemsNow) {
          if (item.geekId && !seenGeekIds.has(item.geekId)) {
            seenGeekIds.add(item.geekId);
            candidateList.push(item);
            foundMore = true;
            console.log(`   🔄 底部出现新候选人: ${item.geekId} (${candidateList.length} 人)`);
          }
        }
        if (foundMore) break;
      }
      if (foundMore) {
        noNewCount = Math.max(0, noNewThreshold - 3);
        continue;
      }
      // 实在没有更多了：滚回顶部再扫一遍作为最终确认
      await scrollListToTop(targetId);
      await sleep(2000);
      const recheckItems = await readVisibleGeekItems(targetId);
      let anyNew = false;
      for (const item of recheckItems) {
        if (item.geekId && !seenGeekIds.has(item.geekId)) {
          seenGeekIds.add(item.geekId);
          candidateList.push(item);
          anyNew = true;
        }
      }
      if (anyNew) {
        console.log(`   🔄 二次回顶发现新候选人: ${candidateList.length} 人`);
        noNewCount = 0;
        continue;
      }
      console.log(`   ✓ 已到列表底部，共 ${candidateList.length} 人`);
      break;
    }
    if (candidateList.length >= count) break;

    // 渐进式滚动：接近阈值时用更激进的滚动触发懒加载
    const aggressive = noNewCount >= Math.floor(noNewThreshold / 2);
    const scroll = await scrollListDown(targetId, aggressive);
    if (!scroll.ok) break;

    if (scroll.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scroll.scrollHeight;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scroll.movedKey === null) {
      // 如果已在底部但还没有触发底部探测，让 noNewCount 继续增长触发探测
      if (!aggressive) break;
      await randomDelay(800, 1200);
      continue;
    }

    await randomDelay(800, 1200);
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
    await randomDelay(800, 1200);
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
      await randomDelay(800, 1200);
      return result;
    }
    if (!scroll.ok || !scroll.movedKey) break;
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
      await randomDelay(800, 1200);
      return result;
    }
    if (!scroll.ok || !scroll.movedKey) break;
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
    // 使用 querySelectorAll 遍历所有 .time-content / .work-content 对
    // 避免 Boss直聘工作经历和教育经历分属不同容器时漏掉教育经历
    var timeLists = document.querySelectorAll('.time-content');
    var detailLists = document.querySelectorAll('.work-content');
    var pairCount = Math.min(timeLists.length, detailLists.length);
    if (pairCount > 0) {
      var workExp = [], eduExp = [];
      for (var listIdx = 0; listIdx < pairCount; listIdx++) {
        var timeList = timeLists[listIdx];
        var detailList = detailLists[listIdx];
        var timeItems = timeList.querySelectorAll(':scope > li');
        var detailItems = detailList.querySelectorAll(':scope > li');
        timeItems.forEach(function(timeLi, index) {
          var detailLi = detailItems[index];
          if (!detailLi) return;
          var time = safeText(timeLi.querySelector('.time'));
          var detail = safeText(detailLi.querySelector('.value'));
          var svgEl = timeLi.querySelector('svg');
          var svgClass = svgEl ? svgEl.className.baseVal : '';
          var isEdu = svgClass.includes('shool') || svgClass.includes('school') || svgClass.includes('edu');
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
      }
      if (workExp.length > 0) result.workExperience = workExp;
      if (eduExp.length > 0) result.educationExperience = eduExp;
    }
  } catch (e) {}
  // 教育经历后备提取：结构化提取无结果时，从原始文本中解析
  if (!result.educationExperience && result.rawVisibleText) {
    try {
      var text = result.rawVisibleText;
      var lines = text.split('\\n');
      var eduStart = -1;
      for (var i = 0; i < lines.length; i++) {
        if (/教育/.test(lines[i])) { eduStart = i + 1; break; }
      }
      if (eduStart > 0) {
        var eduLines = [];
        for (var i = eduStart; i < lines.length; i++) {
          var line = lines[i].trim();
          if (!line) continue;
          if (/^(工作经历|项目经历|期望|技能|自我|证书)/.test(line)) break;
          eduLines.push(line);
        }
        var fallbackEdu = [];
        for (var i = 0; i < eduLines.length; i++) {
          if (/\\d{4}/.test(eduLines[i])) {
            var time = eduLines[i];
            var detail = '';
            if (i + 1 < eduLines.length && !/\\d{4}/.test(eduLines[i + 1])) {
              detail = eduLines[i + 1];
              i++;
            }
            var parts = detail.split('\\u00b7').map(function(p){return p.trim()}).filter(Boolean);
            var entry = { time: time };
            if (parts[0]) entry.school = parts[0];
            if (parts[1]) entry.major = parts[1];
            if (parts[2]) entry.degree = parts[2];
            fallbackEdu.push(entry);
          }
        }
        if (fallbackEdu.length > 0) result.educationExperience = fallbackEdu;
      }
    } catch (e) {}
  }
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

  await randomDelay(500, 800);

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

async function ensureOnChatList(targetId) {
  // 恢复页面状态到列表视图，不刷新页面（刷新会导致 Boss直聘只加载最近约40条记录）
  // 尝试关闭弹窗、回到列表视图，保留已加载的全部候选人数据
  try {
    // 1. 关闭可能还开着的弹窗（简历弹窗、JD弹窗）
    try {
      const { closeBossPopup } = await import('./extract-common.mjs');
      await closeBossPopup(targetId, '.resume-detail', '简历弹窗');
      await closeBossPopup(targetId, '.job-details-dialog', 'JD弹窗');
    } catch {}

    // 2. 检查页面是否还在列表页，.geek-item 是否存在
    const hasItems = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length > 0`);

    if (hasItems) {
      // 3. 列表项还在，尝试点击"返回"按钮退出聊天详情页回到列表视图
      try {
        await cdpEval(targetId, `(function(){
          var backBtn = document.querySelector('.back-btn') || document.querySelector('.btn-chat-back') || document.querySelector('[class*=back]');
          if (backBtn) { backBtn.click(); return 'clicked'; }
          return 'no-back-btn';
        })()`);
      } catch {}
      await sleep(500);

      // 4. 滚动列表回到顶部，由后续 scan 函数自行处理滚动
      try {
        await cdpEval(targetId, `(function(){
          var item = document.querySelector('.geek-item');
          if (item) {
            var el = item.parentElement;
            while (el) {
              try { el.scrollTop = 0; } catch(e){}
              el = el.parentElement;
            }
          }
          document.documentElement.scrollTop = 0;
          document.body.scrollTop = 0;
        })()`);
      } catch {}
      await sleep(800);

      console.log('[页面状态] 已恢复列表视图，未刷新页面（保留全部已加载候选人）');
      return;
    }

    // 5. 后备：列表 DOM 不存在时，尝试用 history.back() 返回（SPA内后退，不触发完整页面刷新）
    console.warn('[页面状态] .geek-item 不存在，尝试 SPA 后退...');
    try {
      await cdpEval(targetId, `history.back()`);
      await sleep(3000);
      const retryItems = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length > 0`);
      if (retryItems) {
        console.log('[页面状态] SPA 后退后列表恢复');
        return;
      }
    } catch {}

    // 6. 最终后备：做一次页面导航（SPA内导航，不是整页刷新）
    console.warn('[页面状态] 列表仍未恢复，进行 SPA 导航...');
    try {
      const infoRaw = await proxyGet(`/info?target=${targetId}`);
      const currentUrl = infoRaw?.url || '';
      const chatUrl = currentUrl.includes('/web/chat')
        ? currentUrl.replace(/\/web\/chat\/.*$/, '/web/chat')
        : 'https://www.zhipin.com/web/chat';
      console.log(`[页面状态] SPA 导航到: ${chatUrl}`);
      await cdpEval(targetId, `location.href = '${chatUrl}'`);
      await sleep(5000);
    } catch (e) {
      console.warn(`[页面状态] SPA 导航失败: ${e.message}，继续`);
    }
  } catch (e) {
    console.warn(`[页面状态] 恢复列表状态失败: ${e.message}，继续`);
  }
}

async function ensureUnreadFilter(targetId) {
  // 先检查"未读"是否已经激活（避免重复点击导致筛选被关闭）
  const result = await proxyPost(`/eval?target=${targetId}`, `
    (() => {
      const el = Array.from(document.querySelectorAll('span,button,a,div,li'))
        .find(el => (el.innerText || el.textContent || '').trim() === '未读');
      if (!el) return { active: false, reason: 'not found' };
      // 检查是否已激活（有 active/selected/chosen 类，或 aria-pressed="true"）
      const isActive = el.classList.contains('active')
        || el.classList.contains('selected')
        || el.classList.contains('chosen')
        || el.getAttribute('aria-pressed') === 'true'
        || el.getAttribute('aria-selected') === 'true'
        || el.style?.color !== ''
        || el.matches('.tab-item.active, .filter-item.active, .tag-item.active');
      return { active: isActive, clicked: false };
    })()
  `);

  if (!result || !result.value) {
    console.warn('[未读筛选] 检测"未读"按钮状态失败');
    return;
  }

  if (result.value.active) {
    console.log('[未读筛选] "未读"已激活，跳过点击');
    return;
  }

  if (result.value.reason === 'not found') {
    console.warn('[未读筛选] 未找到"未读"按钮，降级为全量提取');
    return;
  }

  // 未激活，点击它
  await proxyPost(`/eval?target=${targetId}`, `
    (() => {
      const el = Array.from(document.querySelectorAll('span,button,a,div,li'))
        .find(el => (el.innerText || el.textContent || '').trim() === '未读');
      if (el) el.click();
    })()
  `);

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

// ===== API 候选人获取（绕过虚拟滚动，直接从页面 API 获取全部候选人） =====

function parseApiResponse(raw) {
  if (!raw) return null;
  let data = raw;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch { return null; }
  }
  // CDP eval 返回的是 {value: ...} 形式
  if (data && data.value) {
    try { data = JSON.parse(data.value); } catch { return null; }
  }
  // 尝试常见返回结构：{zpData: {list: [...]}}, {code: 0, data: {list: [...]}}, {list: [...]}
  const list = data?.zpData?.list || data?.data?.list || data?.list || data?.data;
  if (Array.isArray(list)) {
    return list.map(item => ({
      geekId: item.geekId || item.uid || item.id || '',
      listName: item.name || item.userName || item.nickname || item.geekName || '',
    })).filter(c => c.geekId);
  }
  return null;
}

async function fetchCandidatesFromPage(targetId) {
  // 策略 1：从 performance 记录中找聊天列表 API URL
  try {
    const apiUrl = await cdpEval(targetId, `(function(){
      var entries = performance.getEntriesByType('resource');
      for (var i = 0; i < entries.length; i++) {
        var name = entries[i].name;
        if (name.indexOf('/wapi/zpchat/geek/list') !== -1 || name.indexOf('geekList') !== -1) {
          return name;
        }
      }
      return '';
    })()`);
    if (apiUrl) {
      console.log(`  [API] 从 performance 发现 URL: ${apiUrl.substring(0, 120)}`);
      const raw = await proxyPost(`/eval?target=${targetId}`, `(async function(){
        var resp = await fetch('${apiUrl}', { credentials: 'include' });
        return JSON.stringify({status: resp.status, data: await resp.json()});
      })()`);
      if (raw && raw.value) {
        try {
          const parsed = JSON.parse(raw.value);
          console.log(`  [API] 响应状态: ${parsed.status}, 数据结构: ${Object.keys(parsed.data||{}).join(',')}`);
          const candidates = parseApiResponse(parsed.data);
          if (candidates && candidates.length > 0) {
            console.log(`  [API] 解析成功: ${candidates.length} 人`);
            return candidates;
          } else {
            console.log(`  [API] 响应中未找到候选人列表`);
          }
        } catch(e) {
          console.log(`  [API] 解析失败: ${e.message}`);
        }
      } else {
        console.log(`  [API] 请求失败: ${JSON.stringify(raw).substring(0, 100)}`);
      }
    } else {
      console.log(`  [API] performance 中未找到聊天列表 API`);
    }
  } catch (e) {
    console.log(`  [API] 策略1异常: ${e.message}`);
  }

  // 策略 2：尝试常见 API 路径
  const urls = [
    '/wapi/zpchat/geek/list?page=1&pageSize=200',
    '/wapi/zpchat/geek/list/page/1?pageSize=200',
    '/wapi/zpchat/geek/list/latest',
  ];
  for (const url of urls) {
    try {
      console.log(`  [API] 尝试 URL: ${url}`);
      const raw = await proxyPost(`/eval?target=${targetId}`, `(async function(){
        var resp = await fetch('${url}', { credentials: 'include' });
        return JSON.stringify({status: resp.status, data: await resp.json()});
      })()`);
      if (raw && raw.value) {
        const parsed = JSON.parse(raw.value);
        console.log(`  [API] ${url} 响应: ${parsed.status}, keys: ${Object.keys(parsed.data||{}).join(',')}`);
        const candidates = parseApiResponse(parsed.data);
        if (candidates && candidates.length > 0) return candidates;
      }
    } catch (e) {
      console.log(`  [API] ${url} 异常: ${e.message}`);
    }
  }

  // 策略 3：搜索 React fiber tree / 全局变量
  try {
    console.log(`  [API] 尝试搜索全局状态...`);
    const raw = await cdpEval(targetId, `(function(){
      // 搜索常见全局状态
      var globals = ['__INITIAL_STATE__', '__NEXT_DATA__', '__NUXT__', '__STORE__', '__ZP_STATE__'];
      for (var g = 0; g < globals.length; g++) {
        try {
          var val = JSON.stringify(window[globals[g]]);
          if (val && val.indexOf('geekId') !== -1 && val.length > 500) return 'GLOBAL:' + globals[g] + ':' + val.substring(0, 5000);
        } catch(e) {}
      }
      // 搜索 window 上可能存储聊天列表的属性
      for (var key in window) {
        try {
          var w = window[key];
          if (w && typeof w === 'object' && w.list && Array.isArray(w.list) && w.list.length > 10) {
            var s = JSON.stringify(w.list);
            if (s.indexOf('geekId') !== -1) return 'WINDOW:' + key + ':' + s.substring(0, 5000);
          }
        } catch(e) {}
      }
      return '';
    })()`);
    if (raw && raw.length > 10) {
      console.log(`  [API] 全局状态找到数据: ${raw.substring(0, 100)}...`);
      if (raw.indexOf('GLOBAL:') === 0 || raw.indexOf('WINDOW:') === 0) {
        var parts = raw.split(':');
        var key = parts[1];
        var jsonStr = parts.slice(2).join(':');
        try {
          var data = JSON.parse(jsonStr);
          if (Array.isArray(data)) {
            return data.map(item => ({
              geekId: item.geekId || item.uid || item.id || '',
              listName: item.name || item.userName || item.nickname || '',
            })).filter(c => c.geekId);
          }
        } catch {}
      }
    } else {
      console.log(`  [API] 全局状态未找到数据`);
    }
  } catch (e) {
    console.log(`  [API] 策略3异常: ${e.message}`);
  }

  return null;
}

// ===== 取消清理 =====

let _cleanupTargetId = null;
let _cleanupWorker = null;
let _cleanupProgressVars = null; // { processedGeekIds, candidates, outputPath, prevOcr }

async function doCleanup() {
  // 保存进度到磁盘（如果有未保存的数据）
  if (_cleanupProgressVars) {
    const { processedGeekIds, candidates, outputPath, prevOcr } = _cleanupProgressVars;
    try {
      await prevOcr;
      saveProgress(processedGeekIds, candidates, outputPath);
      console.log(`  💾 取消前已保存进度 (${processedGeekIds.size} 人)`);
    } catch (e) {
      console.warn(`  ⚠ 取消前保存进度失败: ${e.message}`);
    }
  }

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
    doCleanup().finally(() => process.exit(1));
  }
});
if (process.stdin && typeof process.stdin.unref === 'function') {
  process.stdin.unref();
}

process.on('SIGTERM', () => {
  doCleanup().finally(() => process.exit(1));
});

// ===== 教育经历解析（从 OCR 后的简历文本中提取） =====
/**
 * 从 resumeText 中解析教育经历段落（后备方案）
 * 在线简历弹窗中包含完整教育经历，可补充右侧面板时间线提取的不足
 */
function _old_parseEducationFromResumeText(resumeText) {
  if (!resumeText) return null;

  const lines = resumeText.split('\n').map(l => l.trim()).filter(Boolean);
  // 找"教育经历"或"教育背景"节点头
  let eduStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^教育/.test(lines[i])) { eduStart = i + 1; break; }
  }
  if (eduStart < 0 || eduStart >= lines.length) return null;

  // 收集教育节内容，遇到其他节点头停止
  const eduLines = [];
  for (let i = eduStart; i < lines.length; i++) {
    const line = lines[i];
    if (/^(工作经历|项目经历|期望职位|技能|自我评价|证书|语言|培训经历)/.test(line)) break;
    eduLines.push(line);
  }
  if (eduLines.length === 0) return null;

  // 解析：两行为一组（时间行 + 学校·专业·学历 行），或三~四行为一组
  const result = [];
  let i = 0;
  while (i < eduLines.length) {
    const line = eduLines[i];
    if (/\d{4}/.test(line)) {
      const time = line;
      const remaining = eduLines.slice(i + 1);
      // 找下一个时间行或结尾
      let nextTimeIdx = remaining.findIndex(l => /\d{4}/.test(l));
      if (nextTimeIdx < 0) nextTimeIdx = remaining.length;

      // 取时间行之后到下一个时间行之间的所有行作为详情
      const detailLines = remaining.slice(0, nextTimeIdx);
      let school = '', major = '', degree = '';

      for (const dl of detailLines) {
        // 按 · 或 • 分隔
        if (dl.includes('·') || dl.includes('•')) {
          const parts = dl.split(/[·•]/).map(p => p.trim()).filter(Boolean);
          if (parts[0]) school = parts[0];
          if (parts[1]) major = parts[1];
          if (parts[2]) degree = parts[2];
        } else {
          // 单行文本：按"本科/硕士/博士/大专"等关键词分配
          if (!school && !/^(本科|硕士|博士|大专)/.test(dl)) {
            school = dl;
          } else if (!major && !/^(本科|硕士|博士|大专)/.test(dl)) {
            major = dl;
          } else if (/^(本科|硕士|博士|大专|高中)/.test(dl)) {
            degree = dl;
          } else if (!school) {
            school = dl;
          } else if (!major) {
            major = dl;
          }
        }
      }

      const entry = { time };
      if (school) entry.school = school;
      if (major) entry.major = major;
      if (degree) entry.degree = degree;
      result.push(entry);

      i += 1 + detailLines.length;
    } else {
      i++;
    }
  }

  return result.length > 0 ? result : null;
}

// ===== 单个候选人提取（供并发扫描+提取使用） =====

/**
 * 提取单个候选人的基础信息、岗位描述、在线简历
 * @param {object} ctx - 共享上下文 { worker, outputPath, tempDir, jobDescCache, processedGeekIds, candidates, prevOcrRef, targetId }
 */
async function extractSingleCandidate(targetId, geekId, listName, globalIndex, totalCount, ctx) {
  const { worker, outputPath, tempDir, jobDescCache, prevOcrRef } = ctx;
  const displayName = listName || `候选人${globalIndex}`;
  const totalLabel = totalCount || '?';
  console.log(`[${globalIndex}/${totalLabel}] ${displayName} (geekId=${geekId})`);

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

    // 3. 提取在线简历（OCR 后台进行，不阻塞关闭弹窗）
    console.log('  → 打开在线简历...');
    const hasResume = await clickOnlineResume(targetId);
    if (hasResume) {
      try {
        const name = candidateData.basicInfo?.name || displayName;
        const sname = safeName(name);
        // 先尝试直接从 DOM 提取简历文本（绕过截图+OCR，快 30-100 倍）
        const domText = await tryExtractResumeTextFromDOM(targetId);
        if (domText) {
          candidateData.resumeText = domText;
          console.log(`  ✓ DOM提取简历文本 (${domText.length} 字)`);

          // 从简历文本补充多段教育经历
          const ocrEdu1 = parseEducationFromResume(domText);
          if (ocrEdu1 && ocrEdu1.length > 0) {
            const cardEdu = candidateData.educationExperience || [];
            for (const p of ocrEdu1) {
              const exists = cardEdu.some(e => e.school && p.school && (e.school.includes(p.school) || p.school.includes(e.school)));
              if (!exists) cardEdu.push(p);
            }
            if (cardEdu.length > 0) candidateData.educationExperience = cardEdu;
            console.log('  ✓ 从简历补充教育经历: ' + ocrEdu1.length + ' 段');
          }

          const resumeDir = resolve(dirname(outputPath), 'resumes');
          mkdirSync(resumeDir, { recursive: true });
          const txtPath = resolve(resumeDir, `${sname}-${geekId}.txt`);
          writeFileSync(txtPath, domText, 'utf8');
        } else {
          console.log('  → 截图...');
          const screenshots = await captureResumeScreenshots(targetId, sname, tempDir);

          console.log('  → OCR 识别（后台进行，与关闭弹窗重叠）...');

          // 等上一个人的 OCR 完成（最多等 3 秒，避免简历内容少的人被阻塞）
          await Promise.race([
            prevOcrRef.current,
            new Promise(r => setTimeout(r, 3000))
          ]);

          // OCR 在后台执行，不阻塞关闭弹窗和下一人操作
          prevOcrRef.current = ocrScreenshots(screenshots, worker).then(resumeText => {
            candidateData.resumeText = resumeText;
            console.log(`  ✓ OCR提取完成 (${resumeText.length} 字)`);

            // 从简历文本补充多段教育经历
            const ocrEdu2 = parseEducationFromResume(resumeText);
            if (ocrEdu2 && ocrEdu2.length > 0) {
              const cardEdu = candidateData.educationExperience || [];
              for (const p of ocrEdu2) {
                const exists = cardEdu.some(e => e.school && p.school && (e.school.includes(p.school) || p.school.includes(e.school)));
                if (!exists) cardEdu.push(p);
              }
              if (cardEdu.length > 0) candidateData.educationExperience = cardEdu;
            }

            const resumeDir = resolve(dirname(outputPath), 'resumes');
            mkdirSync(resumeDir, { recursive: true });
            const txtPath = resolve(resumeDir, `${sname}-${geekId}.txt`);
            writeFileSync(txtPath, resumeText, 'utf8');
          }).catch(e => {
            console.warn(`  ⚠ OCR 识别失败: ${e.message}`);
          });
        }

      } catch (e) {
        let filesDiag = '';
        try {
          const { readdirSync } = await import('node:fs');
          const ssFiles = readdirSync(tempDir).filter(f => f.startsWith(sname)).map(f => `${f}(${readFileSync(resolve(tempDir, f)).length}B)`).join(',');
          filesDiag = ssFiles ? ` 已落盘: ${ssFiles}` : ' 无已落盘截图';
        } catch {}
        console.warn(`  ⚠ 简历截图失败: ${e.message}${filesDiag}`);
      }

      // 关闭弹窗（与后台 OCR 并行执行）
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

  return candidateData;
}

// ===== 主流程（两阶段：先扫描收集 geekId，再逐个提取） =====

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

  // ===== 查找用户已打开的沟通页 tab =====
  console.log('查找已打开的 Boss 直聘沟通页...');
  const targetId = await findChatTab();
  console.log(`已附着到用户打开的沟通页 tab: ${targetId}\n`);

  // 按实际窗口尺寸设置视口（DPR=2 提升 OCR 清晰度），避免布局塌缩、网页变形
  await prepareTab(targetId);

  // ===== 确保页面在列表页 =====
  await ensureOnChatList(targetId);

  // ================================================================
  // 阶段 1：扫描候选人列表（只收集 geekId，不提取）
  // ================================================================
  let candidateList;
  let scanCache = null;

  if (opts.resume) {
    scanCache = loadScanCache(outputPath);
  }

  if (scanCache) {
    candidateList = scanCache.candidates;
    console.log(`跳过扫描阶段，使用缓存: ${candidateList.length} 人\n`);
  } else {
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
      process.exit(1);
    }

    saveScanCache(candidateList, outputPath);

    if (!opts.extractAll && candidateList.length > opts.count) {
      candidateList = candidateList.slice(0, opts.count);
    }
  }

  // ================================================================
  // 阶段 2：逐个提取候选人（点击 → 基础信息 → 岗位描述 → 简历 OCR）
  // ================================================================

  // 恢复进度（跳过已提取的人）
  const processedGeekIds = new Set();
  const candidates = [];

  if (opts.resume) {
    const progressData = loadProgress(outputPath);
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
  if (existsSync(resolve(localLangDir, 'chi_sim.traineddata'))) {
    workerOpts.langPath = localLangDir;
    workerOpts.gzip = false;        // 本地为未压缩文件；gzip 仅控制文件名后缀，读取后按 magic bytes 判断解压
    workerOpts.cacheMethod = 'none'; // 固定读本地文件，行为确定
    console.log(`  使用本地语言包: ${localLangDir}/chi_sim.traineddata`);
  } else {
    console.log('  本地未找到语言包，将从 CDN 下载');
  }
  const worker = await createWorker('chi_sim', 1, workerOpts);
  _cleanupWorker = worker;
  console.log('OCR 引擎就绪\n');

  // 准备提取
  console.log('使用已打开的沟通页 tab 进行提取...\n');
  await ensureUnreadFilter(targetId);

  const toProcess = candidateList.filter(c => !processedGeekIds.has(c.geekId));
  const totalCount = candidateList.length;
  const alreadyDone = processedGeekIds.size;
  const jobDescCache = new Map();
  const prevOcrRef = { current: Promise.resolve() };
  const ctx = { worker, outputPath, tempDir, jobDescCache, processedGeekIds, candidates, prevOcrRef, targetId };

  console.log(`待提取: ${toProcess.length} 人 (已完成 ${alreadyDone}，总计 ${totalCount})\n`);

  if (toProcess.length === 0) {
    console.log('所有候选人已提取完成');
  } else {
    for (let i = 0; i < toProcess.length; i++) {
      const { geekId, listName } = toProcess[i];
      const globalIndex = alreadyDone + i + 1;
      const cd = await extractSingleCandidate(targetId, geekId, listName, globalIndex, totalCount, ctx);
      candidates.push(cd);
      processedGeekIds.add(geekId);

      _cleanupProgressVars = { processedGeekIds, candidates, outputPath, prevOcr: prevOcrRef.current };

      if ((i + 1) % 5 === 0) {
        await prevOcrRef.current;
        saveProgress(processedGeekIds, candidates, outputPath);
        console.log(`  💾 进度已保存 (${processedGeekIds.size}/${totalCount})`);
      }

      if ((i + 1) % 50 === 0 && i < toProcess.length - 1) {
        await prevOcrRef.current;
        const pauseMs = 20000;
        console.log(`  ⏸ 已处理 ${i + 1} 人，暂停 ${(pauseMs / 1000).toFixed(0)}s 防风控...`);
        await sleep(pauseMs);
      }

      if (i < toProcess.length - 1) {
        const delayMs = 500 + Math.random() * 500;
        console.log(`  ⏳ 等待 ${(delayMs / 1000).toFixed(1)}s...\n`);
        await sleep(delayMs);
      }
    }
  }

  // 等待最后一个 OCR 完成
  await prevOcrRef.current;

  // 保留页面 tab
  console.log('\n保留页面 tab，供后续操作使用');
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
