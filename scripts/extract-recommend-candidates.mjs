#!/usr/bin/env node
/**
 * extract-recommend-candidates.mjs - Boss直聘推荐牛人页候选人提取（基础信息 + 在线简历）
 *
 * 从推荐牛人页（/web/chat/recommend）提取候选人：
 *   1. 扫描候选人卡片列表获取 geekId 和基本信息（卡片内已经包含完整基础信息）
 *   2. 逐个点击候选人卡片弹出在线简历弹窗
 *   3. 截图 + OCR 提取简历文本
 *   4. 保存到 output/zhipin-candidates.json（含 resumeText 字段）
 *
 * Usage:
 *   node scripts/extract-recommend-candidates.mjs --count 20 [--output output/zhipin-candidates.json]
 *
 * 前置条件：
 *   - CDP Proxy 已运行（端口 3456）
 *   - Chrome 已登录 Boss 直聘招聘端
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proxyGet, sleep, randomDelay,
  cdpEval,
  closeBossPopup,
  captureResumeScreenshots,
  ocrScreenshots,
  safeName,
  getScanCachePath, getProgressPath,
  saveScanCache, loadScanCache, saveProgress, loadProgress, cleanupCacheFiles,
  archiveOldOutput,
  reportStats,
  parseArgs,
} from './extract-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T') + new Date().toISOString().slice(19, 23);

// 主页面 URL（嵌入 iframe 方式）
const RECOMMEND_PAGE_URL = 'https://www.zhipin.com/web/chat/recommend';

/**
 * 通过 CDP /targets 查找用户已打开的推荐牛人页 tab
 * 用于 --attach 模式（手动筛选后附着到现有页面）
 */
async function findExistingRecommendTab() {
  const targets = await proxyGet('/targets');
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('无法获取 Chrome tab 列表，请确保 CDP Proxy 已连接');
  }
  const tab = targets.find(t =>
    t.url && t.url.includes('/web/chat/recommend')
  );
  if (!tab || !tab.targetId) {
    throw new Error(
      '未找到已打开的推荐牛人页。\n' +
      '请先在 Chrome 中打开 https://www.zhipin.com/web/chat/recommend\n' +
      '并设置好筛选条件，然后重试。'
    );
  }
  console.log(`已附着到用户打开的推荐页: ${tab.url}`);
  return tab.targetId;
}

/**
 * 通过 JS eval 在 iframe 上下文中执行表达式
 * 推荐牛人页内容在 iframe[name=recommendFrame] 内，所有 DOM 操作需穿透 iframe
 */
async function iframeEval(targetId, expr) {
  const wrapped = `(function(){
    var iframe = document.querySelector('iframe[name=recommendFrame]');
    if (!iframe) return JSON.stringify({error: 'no-recommend-frame'});
    try {
      var iwin = iframe.contentWindow;
      if (!iwin || !iwin.document) return JSON.stringify({error: 'no-content-window'});
      var result = iwin.eval(${JSON.stringify(expr)});
      return JSON.stringify({ok: true, value: result});
    } catch(e) {
      return JSON.stringify({error: e.message});
    }
  })()`;
  const raw = await cdpEval(targetId, wrapped);
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`iframe 操作失败: ${parsed.error}`);
  return parsed.value;
}

// ===== 页面操作 =====

async function waitForPageLoad(targetId, maxWait = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const count = await iframeEval(targetId, `document.querySelectorAll('li.card-item').length`);
      if (count > 0) return count;
    } catch {}
    await sleep(800);
  }
  throw new Error('推荐牛人页面未加载');
}

// ===== 卡片信息提取脚本 =====

/**
 * 从推荐牛人页的卡片 DOM 中提取基础信息（无需点击）
 * 每张卡片包含：姓名、年龄、工作年限、学历、期望薪资、期望职位、
 * 优势描述、技能标签、工作经历、教育经历
 */
const EXTRACT_CARD_INFO_SCRIPT = `(function(){
  function safeText(el) {
    if (!el || !el.textContent) return '';
    return el.textContent.trim();
  }

  var cards = document.querySelectorAll('li.card-item');
  var result = [];
  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var info = {};

    // geekId: 从 .card-inner 的 data-geekid 属性获取
    var cardInner = card.querySelector('.card-inner');
    if (cardInner) {
      info.geekId = cardInner.getAttribute('data-geekid') || '';
    }

    // 构建 rawVisibleText
    var rawText = safeText(card);

    // col-2 区域包含主要信息
    var col2 = card.querySelector('.col-2');
    if (col2) {
      var basicInfo = {};

      // 姓名
      var nameEl = col2.querySelector('.name');
      if (nameEl) basicInfo.name = safeText(nameEl);

      // 年龄、工作年限、学历（在 join-text-wrap.base-info 内，用 · 分隔）
      var baseInfoWrap = col2.querySelector('.join-text-wrap.base-info');
      if (baseInfoWrap) {
        var spans = baseInfoWrap.querySelectorAll(':scope > span');
        var parts = [];
        spans.forEach(function(s) { parts.push(safeText(s)); });
        if (parts.length >= 1) basicInfo.age = parts[0];
        if (parts.length >= 2) basicInfo.workYears = parts[1];
        if (parts.length >= 3) basicInfo.education = parts[2];
      }

      if (Object.keys(basicInfo).length > 0) info.basicInfo = basicInfo;

      // 期望职位/城市
      var expectContent = col2.querySelector('.expect-wrap .content');
      if (expectContent) {
        var expectSpans = expectContent.querySelectorAll('span');
        var posInfo = {};
        if (expectSpans.length >= 1) posInfo.expectCity = safeText(expectSpans[0]);
        if (expectSpans.length >= 2) posInfo.expectPosition = safeText(expectSpans[1]);
        if (Object.keys(posInfo).length > 0) info.positionInfo = posInfo;
      }

      // 优势描述
      var descContent = col2.querySelector('.geek-desc .content');
      if (descContent) {
        info.advantage = safeText(descContent);
      }

      // 技能标签
      var tagItems = col2.querySelectorAll('.tags-wrap .tag-item');
      if (tagItems.length > 0) {
        info.skills = Array.from(tagItems).map(function(t) { return safeText(t); });
      }
    }

    // col-3 区域包含工作经历和教育经历
    var col3 = card.querySelector('.col-3');
    if (col3) {
      // 工作经历
      var workExps = col3.querySelectorAll('.timeline-wrap.work-exps .timeline-item');
      if (workExps.length > 0) {
        var workExp = [];
        workExps.forEach(function(item) {
          var w = {};
          var timeSpans = item.querySelectorAll('.join-text-wrap.time span');
          if (timeSpans.length >= 1) w.time = safeText(timeSpans[0]);
          if (timeSpans.length >= 2) {
            if (w.time) w.time += ' - ' + safeText(timeSpans[1]);
            else w.time = safeText(timeSpans[1]);
          }
          var contentSpans = item.querySelectorAll('.join-text-wrap.content span');
          if (contentSpans.length >= 1) w.company = safeText(contentSpans[0]);
          if (contentSpans.length >= 2) w.position = safeText(contentSpans[1]);
          if (Object.keys(w).length > 0) workExp.push(w);
        });
        if (workExp.length > 0) info.workExperience = workExp;
      }

      // 教育经历
      var eduExps = col3.querySelectorAll('.timeline-wrap.edu-exps .timeline-item');
      if (eduExps.length > 0) {
        var eduExp = [];
        eduExps.forEach(function(item) {
          var e = {};
          var timeSpans = item.querySelectorAll('.join-text-wrap.time span');
          if (timeSpans.length >= 1) e.time = safeText(timeSpans[0]);
          if (timeSpans.length >= 2) {
            if (e.time) e.time += ' - ' + safeText(timeSpans[1]);
            else e.time = safeText(timeSpans[1]);
          }
          var contentSpans = item.querySelectorAll('.join-text-wrap.content span');
          if (contentSpans.length >= 1) e.school = safeText(contentSpans[0]);
          if (contentSpans.length >= 2) e.major = safeText(contentSpans[1]);
          if (contentSpans.length >= 3) e.degree = safeText(contentSpans[2]);
          if (Object.keys(e).length > 0) eduExp.push(e);
        });
        if (eduExp.length > 0) info.educationExperience = eduExp;
      }
    }

    // 薪资期望（在 col-1 或 salary-wrap 中）
    var salaryEl = card.querySelector('.salary-wrap span') || card.querySelector('.col-1 span');
    if (salaryEl) {
      var salaryText = safeText(salaryEl);
      if (salaryText && /[\\dK]/.test(salaryText)) {
        if (!info.positionInfo) info.positionInfo = {};
        // 薪资可能是 col-1 的 span，与 col-2 的期望不同
        // 放在 positionInfo.expectSalary
        info.positionInfo.expectSalary = salaryText;
      }
    }

    // appliedJob：从页面标题区域获取（不在卡片内，在页面头部）
    // 需要在卡片提取后单独补充

    info.rawVisibleText = rawText;
    result.push(info);
  }
  return result;
})()`;

// ===== 获取页面级别的岗位名称（appliedJob） =====

/**
 * 页面头部有职位选择器，显示当前筛选的岗位名称
 * 如 "AI硬件产品经理 _ 深圳 17-24K"
 */
const EXTRACT_PAGE_JOB_SCRIPT = `(function(){
  // 尝试从页面头部获取岗位名称
  // 选择器：.header-wrap 或 .job-selecter-wrap 或 .recommend-filter 区域
  var headerEl = document.querySelector('.header-wrap') || document.querySelector('.candidate-head');
  if (headerEl) {
    var text = headerEl.textContent.trim();
    // 取第一行（通常是岗位名称 + 地点 + 薪资）
    var lines = text.split('\\n').filter(function(l) { return l.trim(); });
    if (lines.length > 0) return lines[0];
  }
  return '';
})()`;

// ===== 候选人列表扫描 =====

/**
 * 扫描全部候选人：读取所有可见卡片，逐步滚动加载更多
 * 推荐牛人页使用虚拟滚动/分页，需要不断滚动发现新人
 */
async function scanAllCards(targetId, opts = {}) {
  const { maxScrollAttempts = 300, noNewThreshold = 10, onProgress } = opts;

  const seenGeekIds = new Set();
  const cardInfos = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    // 读取当前可见的卡片信息
    let visibleCards;
    try {
      visibleCards = await iframeEval(targetId, EXTRACT_CARD_INFO_SCRIPT);
    } catch (e) {
      console.warn(`  读取卡片失败: ${e.message}`);
      await sleep(2000);
      continue;
    }

    let newInThisBatch = 0;

    for (const card of visibleCards) {
      if (card.geekId && !seenGeekIds.has(card.geekId)) {
        seenGeekIds.add(card.geekId);
        cardInfos.push(card);
        newInThisBatch++;
      }
    }

    if (newInThisBatch === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress(cardInfos.length, attempt, newInThisBatch);

    // 找到滚动容器并滚动：从卡片元素往上找可滚动的父容器
    const scrollResult = await iframeEval(targetId, `(function(){
      var card = document.querySelector('li.card-item');
      var el = card ? card.parentElement : null;
      while (el && el !== document.body && el !== document.documentElement) {
        var style = window.getComputedStyle(el);
        if ((style.overflowY === 'scroll' || style.overflowY === 'auto' ||
             style.overflow === 'scroll' || style.overflow === 'auto') &&
            el.scrollHeight > el.clientHeight + 5) {
          break;
        }
        el = el.parentElement;
      }
      if (!el || el === document.body || el === document.documentElement) {
        el = document.documentElement;
      }
      var before = el.scrollTop;
      el.scrollTop += Math.floor(el.clientHeight * 0.9);
      var after = el.scrollTop;
      return {
        ok: true,
        scrollTop: after,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
        scrolled: after > before,
        containerTag: (el.tagName || '') + (el.className ? '.' + el.className.split(' ')[0].replace(/\s/g, '') : '') + (el.id ? '#' + el.id : '')
      };
    })()`);
    if (!scrollResult.ok) {
      console.warn('  滚动失败，终止扫描');
      break;
    }

    // scrollHeight 增长 → 新内容已加载
    if (scrollResult.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scrollResult.scrollHeight;
      prevScrollTop = -1;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    // 触底检测
    if (scrollResult.scrollTop === prevScrollTop) break;
    prevScrollTop = scrollResult.scrollTop;

    // 连续无新人
    if (noNewCount >= noNewThreshold) break;

    await randomDelay(1500, 3000);
  }

  return cardInfos;
}

/**
 * 扫描前 N 个候选人
 */
async function scanUpToCards(targetId, count, opts = {}) {
  const { maxScrollAttempts = 200, noNewThreshold = 10, onProgress } = opts;

  const seenGeekIds = new Set();
  const cardInfos = [];
  let noNewCount = 0;
  let prevScrollTop = -1;
  let prevScrollHeight = 0;

  for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
    if (cardInfos.length >= count) break;

    let visibleCards;
    try {
      visibleCards = await iframeEval(targetId, EXTRACT_CARD_INFO_SCRIPT);
    } catch (e) {
      console.warn(`  读取卡片失败: ${e.message}`);
      await sleep(2000);
      continue;
    }

    let newInThisBatch = 0;

    for (const card of visibleCards) {
      if (card.geekId && !seenGeekIds.has(card.geekId)) {
        seenGeekIds.add(card.geekId);
        cardInfos.push(card);
        newInThisBatch++;
        if (cardInfos.length >= count) break;
      }
    }

    if (newInThisBatch === 0) {
      noNewCount++;
    } else {
      noNewCount = 0;
    }

    if (onProgress) onProgress(cardInfos.length, attempt, newInThisBatch);

    if (noNewCount >= noNewThreshold) break;
    if (cardInfos.length >= count) break;

    const scrollResult = await iframeEval(targetId, `(function(){
      var card = document.querySelector('li.card-item');
      var el = card ? card.parentElement : null;
      while (el && el !== document.body && el !== document.documentElement) {
        var style = window.getComputedStyle(el);
        if ((style.overflowY === 'scroll' || style.overflowY === 'auto' ||
             style.overflow === 'scroll' || style.overflow === 'auto') &&
            el.scrollHeight > el.clientHeight + 5) {
          break;
        }
        el = el.parentElement;
      }
      if (!el || el === document.body || el === document.documentElement) {
        el = document.documentElement;
      }
      var before = el.scrollTop;
      el.scrollTop += Math.floor(el.clientHeight * 0.9);
      var after = el.scrollTop;
      return { ok: true, scrollTop: after, scrollHeight: el.scrollHeight, scrolled: after > before };
    })()`);

    if (!scrollResult.ok) break;

    if (scrollResult.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scrollResult.scrollHeight;
      prevScrollTop = -1;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scrollResult.scrollTop === prevScrollTop) break;
    prevScrollTop = scrollResult.scrollTop;

    await randomDelay(1500, 2500);
  }

  return cardInfos;
}

// ===== 岗位切换 =====

async function selectJobByName(targetId, jobName) {
  console.log(`  切换岗位至: ${jobName}`);
  // 点击下拉框展开岗位列表
  const clicked = await iframeEval(targetId, `(function(){
    var wrap = document.querySelector('.job-selecter-wrap');
    if (!wrap) return false;
    // 点击下拉框标签展开列表
    var label = wrap.querySelector('.ui-dropmenu-label') || wrap;
    label.click();
    return true;
  })()`);
  if (!clicked) {
    console.warn('  ⚠ 未找到岗位选择器，跳过岗位切换');
    return;
  }
  await sleep(500);

  // 在展开的列表中查找匹配的岗位并点击
  const result = await iframeEval(targetId, `(function(){
    var items = document.querySelectorAll('.job-list .job-item');
    for (var i = 0; i < items.length; i++) {
      var text = (items[i].textContent || '').trim().replace(/\\s+/g, ' ');
      if (text === ${JSON.stringify(jobName)}) {
        items[i].click();
        return 'found-and-clicked';
      }
    }
    return 'not-found';
  })()`);

  if (result === 'not-found') {
    console.warn(`  ⚠ 未找到岗位"${jobName}"，将使用当前默认岗位`);
    // 点击空白处关闭下拉
    await iframeEval(targetId, `document.body.click()`);
    return;
  }

  console.log(`  ✓ 已切换到: ${jobName}`);
  // 等待推荐列表刷新
  await sleep(2000);
}

// ===== 点击候选人卡片弹出简历 =====

async function clickCardToOpenResume(targetId, geekId, cardIndex) {
  // 先滚动列表到目标卡片附近（虚拟滚动只保留 ~20 张卡片在 DOM 中）
  if (cardIndex !== undefined) {
    await iframeEval(targetId, `(function(){
      var containers = [
        document.querySelector('.recommend-list-wrap'),
        document.querySelector('.list-body'),
        document.querySelector('#recommend-list'),
        document.querySelector('.card-list'),
        document.querySelector('.candidate-body'),
      ];
      var list = null;
      for (var i = 0; i < containers.length; i++) {
        if (containers[i] && containers[i].scrollHeight > containers[i].clientHeight) {
          list = containers[i];
          break;
        }
      }
      if (!list) list = document.body;
      // 估算：每张卡片约 120px，滚到目标卡片的前 3 张位置
      list.scrollTop = Math.max(0, (${cardIndex} - 3)) * 120;
    })()`);
    await sleep(800);
  }

  const result = await iframeEval(targetId, `(function(){
    var cardInner = document.querySelector('.card-inner[data-geekid="${geekId}"]');
    if (!cardInner) {
      // 通过索引查找：遍历所有 card-item 找匹配的 geekId
      var items = document.querySelectorAll('li.card-item');
      for (var i = 0; i < items.length; i++) {
        var inner = items[i].querySelector('.card-inner');
        if (inner && inner.getAttribute('data-geekid') === '${geekId}') {
          inner.click();
          return 'clicked-by-search';
        }
      }
      return 'not-found';
    }
    cardInner.click();
    return 'clicked';
  })()`);
  if (result === 'not-found') {
    throw new Error(`无法定位候选人卡片 geekId=${geekId}`);
  }

  // 等待简历弹窗出现并尺寸稳定
  const maxWait = 15000;
  const start = Date.now();
  let lastWidth = 0, lastHeight = 0;
  let stableCount = 0;

  while (Date.now() - start < maxWait) {
    try {
      const dialogState = await iframeEval(targetId, `(function(){
        var dialog = document.querySelector('.dialog-wrap.active');
        if (!dialog) return {found: false};
        var rect = dialog.getBoundingClientRect();
        var resumeWrap = dialog.querySelector('.lib-standard-resume');
        var iframe = dialog.querySelector('.resume-detail-wrap iframe');
        var hasIframe = !!iframe;
        var idoc = null, hasCanvas = false;
        if (iframe) {
          try {
            idoc = iframe.contentDocument || iframe.contentWindow.document;
            hasCanvas = !!idoc.querySelector('canvas');
          } catch(e) {}
        }
        return {
          found: true,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          hasIframe: hasIframe,
          hasResumeWrap: !!resumeWrap,
          hasCanvas: hasCanvas,
          iframeLoaded: iframe ? !!iframe.contentWindow : false
        };
      })()`);
      if (dialogState.found && dialogState.width > 0 && dialogState.height > 0) {
        const sizeOk = dialogState.width >= 600 && dialogState.height >= 500;
        if (dialogState.width === lastWidth && dialogState.height === lastHeight) {
          stableCount++;
          if (stableCount >= 2) {
            const waitForIframe = dialogState.hasCanvas ? 2000 : 4000;
            const sizeWarn = sizeOk ? '' : ' ⚠尺寸偏小';
            console.log(`    弹窗尺寸稳定: ${dialogState.width}x${dialogState.height}, iframe=${dialogState.hasIframe}, canvas=${dialogState.hasCanvas}${sizeWarn}`);
            await sleep(waitForIframe);
            return true;
          }
        } else {
          stableCount = 0;
          lastWidth = dialogState.width;
          lastHeight = dialogState.height;
        }
      }
    } catch {}
    await sleep(400);
  }

  console.log('    ⚠ 等待弹窗超时');
  return false;
}

// ===== 简历弹窗相关操作（推荐牛人页特化） =====

/**
 * 推荐牛人页的简历弹窗结构不同，需特化的点击操作
 */
async function clickResumeInDialog(targetId) {
  // 推荐牛人页点击卡片后简历自动加载，无需额外点击
  // 此函数作为占位，留作将来可能需要
  return true;
}

/**
 * 获取推荐牛人页简历弹窗的截图区域
 */
async function getRecommendDialogClip(targetId) {
  // iframeEval 中 getBoundingClientRect() 返回 iframe 内部坐标，
  // 而 CDP 截图需要主页面视口坐标，需要加上 iframe 在主页面的偏移
  const offsetRaw = await cdpEval(targetId, `(function(){
    var frame = document.querySelector('iframe[name=recommendFrame]');
    if (!frame) return JSON.stringify({x: 0, y: 0});
    var r = frame.getBoundingClientRect();
    return JSON.stringify({x: Math.round(r.x), y: Math.round(r.y)});
  })()`);
  const offset = JSON.parse(offsetRaw);

  const clip = await iframeEval(targetId, `(function(){
    var dialog = document.querySelector('.dialog-wrap.active');
    if (!dialog) return null;

    var rect = dialog.getBoundingClientRect();

    // 获取简历渲染区域（iframe 或 resume-detail-wrap）
    var resumeWrap = dialog.querySelector('.resume-detail-wrap');
    if (resumeWrap) {
      var wrapRect = resumeWrap.getBoundingClientRect();
      // 优先找 iframe，用 iframe 的 x/width 排除左侧个人信息面板的偏移
      var iframeEl = resumeWrap.querySelector('iframe');
      if (iframeEl) {
        var iframeRect = iframeEl.getBoundingClientRect();
        if (iframeRect.width >= 300 && iframeRect.height > 0) {
          return {
            x: Math.round(iframeRect.x),
            y: Math.round(wrapRect.y),
            width: Math.round(iframeRect.width),
            height: Math.round(wrapRect.height),
            source: 'iframe'
          };
        }
      }
      // 兜底：用 resume-detail-wrap 的区域
      return {
        x: Math.round(wrapRect.x),
        y: Math.round(wrapRect.y),
        width: Math.round(wrapRect.width),
        height: Math.round(wrapRect.height),
        source: 'wrap'
      };
    }

    // 兜底：全弹窗区域
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  })()`);

  if (!clip) return null;
  // 加上 iframe 偏移，转为主页面视口坐标
  clip.x += offset.x;
  clip.y += offset.y;
  return clip;
}

/**
 * 获取推荐牛人页简历弹窗的滚动信息
 * 扫描弹窗内所有元素，找到真正可滚动的容器（不依赖特定 class 名）
 */
async function getRecommendResumeScrollInfo(targetId) {
  const info = await iframeEval(targetId, `(function(){
    var dialog = document.querySelector('.dialog-wrap.active');
    if (!dialog) return {error: 'no dialog'};

    // 扫描所有子元素，找 scrollHeight > clientHeight 的
    var all = dialog.querySelectorAll('*');
    var best = null;
    var bestDiff = 0;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var sh = el.scrollHeight;
      var ch = el.clientHeight;
      var diff = sh - ch;
      if (diff > 100 && diff > bestDiff) {
        best = el;
        bestDiff = diff;
      }
    }

    if (best) {
      return {
        scrollHeight: best.scrollHeight,
        clientHeight: best.clientHeight,
        scrollTop: best.scrollTop,
        scrollTarget: best.className || best.tagName,
        source: 'scan'
      };
    }

    // 兜底：用弹窗本身
    return {
      scrollHeight: dialog.scrollHeight,
      clientHeight: dialog.clientHeight,
      scrollTop: 0,
      scrollTarget: 'dialog',
      source: 'fallback'
    };
  })()`);
  return info;
}

/**
 * 滚动推荐牛人页的简历弹窗
 * 扫描弹窗内所有元素，找到可滚动的容器并设 scrollTop
 */
async function scrollRecommendResume(targetId, scrollTop) {
  await iframeEval(targetId, `(function(){
    var dialog = document.querySelector('.dialog-wrap.active');
    if (!dialog) return;

    // 扫描所有子元素，找到 scrollHeight > clientHeight 的
    var all = dialog.querySelectorAll('*');
    var best = null;
    var bestDiff = 0;

    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var sh = el.scrollHeight;
      var ch = el.clientHeight;
      var diff = sh - ch;
      if (diff > 100 && diff > bestDiff) {
        best = el;
        bestDiff = diff;
      }
    }

    // 如果没找到，用弹窗本身
    if (!best) best = dialog;

    best.style.scrollBehavior = 'auto';
    best.scrollTop = ${scrollTop};
  })()`);
  await randomDelay(800, 1200);
}


/**
 * 关闭推荐牛人页的简历弹窗
 */
async function closeRecommendDialog(targetId) {
  // 检查弹窗是否存在
  const exists = await iframeEval(targetId, `(function(){
    var d = document.querySelector('.dialog-wrap.active');
    return d ? true : false;
  })()`);

  if (!exists) return true;

  // 1. 按 Escape 键关闭（keydown + keyup 兼容 React 等框架）
  await iframeEval(targetId, `(function(){
    ['keydown','keyup'].forEach(function(type){
      document.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    });
  })()`);
  await randomDelay(1200, 1600);

  const afterEscape = await iframeEval(targetId, `(function(){
    var d = document.querySelector('.dialog-wrap.active');
    return d ? (d.offsetParent !== null) : false;
  })()`);

  if (!afterEscape) return true;

  // 2. 尝试点关闭按钮
  await iframeEval(targetId, `(function(){
    var dialog = document.querySelector('.dialog-wrap.active');
    if (!dialog) return;
    var closeBtn = dialog.querySelector('.close-btn');
    if (closeBtn) closeBtn.click();
  })()`);
  await randomDelay(500, 1000);

  const stillVisible = await iframeEval(targetId, `(function(){
    var d = document.querySelector('.dialog-wrap.active');
    return d ? true : false;
  })()`);

  if (!stillVisible) return true;

  // 3. 强制移除 DOM
  await iframeEval(targetId, `(function(){
    var dialog = document.querySelector('.dialog-wrap.active');
    if (dialog) dialog.remove();
  })()`);
  console.warn(`  ⚠ 简历弹窗关闭失败，已强制移除DOM`);
  await randomDelay(300, 500);
  return false;
}

// ===== 取消清理 =====

let _cleanupTargetId = null;
let _cleanupWorker = null;
let _attachMode = false; // --attach 模式不关闭用户 tab

async function doCleanup() {
  if (!_cleanupTargetId && !_cleanupWorker) return;
  console.log('\n收到取消指令，清理资源...');
  if (_cleanupTargetId) {
    if (_attachMode) {
      console.log('  [手动筛选模式] 保留用户打开的 tab');
    } else {
      try { await proxyGet(`/close?target=${_cleanupTargetId}`); } catch {}
    }
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
  console.log(`\n========== Boss直聘候选人全量提取 (推荐牛人页) ==========`);
  console.log(`提取模式: ${modeLabel}`);
  if (opts.resume) console.log('恢复模式: 从上次进度继续');
  console.log(`输出文件: ${outputPath}\n`);

  mkdirSync(dirname(outputPath), { recursive: true });
  const tempDir = resolve(dirname(outputPath), '.temp-screenshots');
  mkdirSync(tempDir, { recursive: true });

  // ===== 阶段 1：扫描候选人列表（卡片信息 + geekId） =====
  let targetId = null;
  let cardInfos;
  let scanCache = null;
  let effectiveJobName = ''; // 当前岗位名（用于 appliedJob）

  if (opts.resume) {
    scanCache = loadScanCache(outputPath);
  }

  if (scanCache) {
    cardInfos = scanCache.candidates;
    console.log(`跳过扫描阶段，使用缓存: ${cardInfos.length} 人\n`);
  } else {
    if (opts.attach) {
      // 手动筛选模式：附着到用户已打开的推荐页
      _attachMode = true;
      console.log('查找用户已打开的推荐牛人页...');
      targetId = await findExistingRecommendTab();
      console.log(`已附着到 Tab: ${targetId}\n`);
    } else {
      // 自动模式：创建新 tab
      console.log('打开 Boss 直聘推荐牛人页...');
      const newTab = await proxyGet(`/new?url=${RECOMMEND_PAGE_URL}`);
      targetId = newTab.targetId;
      console.log(`Tab 已创建: ${targetId}`);
    }

    // 如果指定了岗位，先切换再等待加载（避免浪费等待默认岗位的候选人）
    // 注意：--attach 模式下跳过岗位切换（用户已手动选好岗位和筛选条件）
    if (opts.attach) {
      console.log('等待页面加载（手动筛选模式，跳过岗位切换）...');
      const cardCount = await waitForPageLoad(targetId, 20000);
      console.log(`页面已加载，卡片列表: ${cardCount} 项\n`);
      // 先用 --job 参数（用户在 UI 中选择了岗位）
      if (opts.job) {
        console.log(`使用用户选择的岗位: ${opts.job}`);
        effectiveJobName = opts.job;
      } else {
        // 回退：尝试读取当前页面岗位名作为 appliedJob
        try {
          const pageJob = await iframeEval(targetId, EXTRACT_PAGE_JOB_SCRIPT);
          if (pageJob) {
            console.log(`当前岗位: ${pageJob}`);
            effectiveJobName = pageJob;
          }
        } catch {}
      }
    } else if (opts.job) {
      console.log('等待页面初始加载...');
      try {
        await sleep(3000);
        await waitForPageLoad(targetId, 10000);
      } catch {}
      await selectJobByName(targetId, opts.job);
      effectiveJobName = opts.job;
      console.log('等待新岗位候选人加载...');
      await sleep(2000);
      const newCount = await waitForPageLoad(targetId, 20000);
      console.log(`岗位已切换，候选人列表: ${newCount} 项\n`);
    } else {
      console.log('等待页面加载...');
      const cardCount = await waitForPageLoad(targetId, 20000);
      console.log(`页面已加载，卡片列表: ${cardCount} 项\n`);

      // 获取页面岗位名称
      try {
        const pageJob = await iframeEval(targetId, EXTRACT_PAGE_JOB_SCRIPT);
        if (pageJob) {
          console.log(`当前岗位: ${pageJob}`);
          if (!effectiveJobName) effectiveJobName = pageJob;
        }
      } catch {}
    }

    // 扫描阶段
    if (opts.extractAll) {
      console.log('扫描全部候选人卡片...');
      cardInfos = await scanAllCards(targetId, {
        onProgress: (total, attempt, newCount) => {
          console.log(`  扫描进度: ${total} 人 (第 ${attempt + 1} 次滚动, 新增 ${newCount})`);
        },
      });
    } else {
      console.log(`扫描前 ${opts.count} 个候选人卡片...`);
      cardInfos = await scanUpToCards(targetId, opts.count, {
        onProgress: (total, attempt, newCount) => {
          console.log(`  扫描进度: ${total}/${opts.count} 人 (第 ${attempt + 1} 次滚动, 新增 ${newCount})`);
        },
      });
    }

    console.log(`扫描完成: 发现 ${cardInfos.length} 个候选人\n`);

    if (cardInfos.length === 0) {
      console.error('未扫描到候选人，退出');
      if (!opts.attach) {
        await proxyGet(`/close?target=${targetId}`);
      }
      process.exit(1);
    }

    // 为所有候选人注入 appliedJob（用于 Excel sheet 名和分组）
    for (const card of cardInfos) {
      card.appliedJob = effectiveJobName;
    }

    // 保存扫描缓存
    saveScanCache(cardInfos, outputPath);

    // 截取前 N 个
    if (!opts.extractAll && cardInfos.length > opts.count) {
      cardInfos = cardInfos.slice(0, opts.count);
    }

  }

  // ===== 阶段 2：逐个提取在线简历 =====

  let progressData = null;
  const processedGeekIds = new Set();
  const candidates = [];

  if (opts.resume) {
    progressData = loadProgress(outputPath);
    if (progressData) {
      const scanGeekIds = new Set(cardInfos.map(c => c.geekId));
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

  // 使用扫描阶段的 tab（resume 模式需新开）
  if (!targetId) {
    console.log('打开 Boss 直聘推荐牛人页...');
    const newTab = await proxyGet(`/new?url=${RECOMMEND_PAGE_URL}`);
    targetId = newTab.targetId;
    _cleanupTargetId = targetId;
    console.log(`Tab 已创建: ${targetId}`);

    console.log('等待页面加载...');
    const cardCount = await waitForPageLoad(targetId, 20000);
    console.log(`页面已加载，卡片列表: ${cardCount} 项\n`);
  } else {
    _cleanupTargetId = targetId;
    console.log('复用扫描 tab，无需重新打开\n');
    // 滚动回列表顶部，准备从上到下点击
    await iframeEval(targetId, `(function(){
      var containers = [
        document.querySelector('.recommend-list-wrap'),
        document.querySelector('.list-body'),
        document.querySelector('#recommend-list'),
        document.querySelector('.card-list'),
        document.querySelector('.candidate-body'),
      ];
      for (var i = 0; i < containers.length; i++) {
        if (containers[i] && typeof containers[i].scrollTop !== 'undefined') {
          containers[i].scrollTop = 0;
        }
      }
    })()`);
    await sleep(500);
  }

  // 筛选待处理的候选人
  const toProcess = cardInfos.filter(c => !processedGeekIds.has(c.geekId));
  const totalCount = cardInfos.length;
  const alreadyDone = processedGeekIds.size;

  console.log(`待提取: ${toProcess.length} 人 (已完成 ${alreadyDone}，总计 ${totalCount})\n`);

  if (toProcess.length === 0) {
    console.log('所有候选人已提取完成');
  } else {
    // 流水线：OCR 在后台进行，与关闭弹窗 + 下一人点击重叠
    let prevOcr = Promise.resolve();

    for (let i = 0; i < toProcess.length; i++) {
      const card = toProcess[i];
      const geekId = card.geekId;
      const globalIndex = alreadyDone + i + 1;
      const displayName = (card.basicInfo && card.basicInfo.name) || geekId || `候选人${globalIndex}`;
      console.log(`[${globalIndex}/${totalCount}] ${displayName} (geekId=${geekId})`);

      // 初始数据：卡片基础信息
      let candidateData = {
        index: globalIndex,
        geekId: geekId || '',
        rawVisibleText: card.rawVisibleText || '',
      };

      // 结构化基础信息（从卡片提取的）
      if (card.basicInfo) candidateData.basicInfo = card.basicInfo;
      if (card.workExperience) candidateData.workExperience = card.workExperience;
      if (card.educationExperience) candidateData.educationExperience = card.educationExperience;
      if (card.positionInfo) {
        candidateData.positionInfo = card.positionInfo;
        // 如果没有 appliedJob，从卡片上补充（扫描时就设好了）
        if (!candidateData.positionInfo.appliedJob) {
          candidateData.positionInfo.appliedJob = card.appliedJob || '';
        }
      }
      if (card.skills) candidateData.skills = card.skills;
      if (card.advantage) candidateData.advantage = card.advantage;

      try {
        // 1. 点击卡片打开简历弹窗（与上一个人的 OCR 并行）
        console.log('  → 点击卡片打开简历...');
        const dialogOpened = await clickCardToOpenResume(targetId, geekId, globalIndex - 1);
        if (!dialogOpened) {
          console.log('  ℹ 简历弹窗未打开，跳过');
          processedGeekIds.add(geekId);
          candidates.push(candidateData);
          continue;
        }

        // 2. 截图 + OCR
        try {
          const sname = safeName(displayName);

          console.log('  → 截图...');

          // 使用推荐牛人页特化的截图方法
          const info = await getRecommendResumeScrollInfo(targetId);
          if (info.error) throw new Error(info.error);

          const { scrollHeight, clientHeight } = info;
          const step = Math.floor(clientHeight * 0.95);
          const pages = Math.ceil((scrollHeight - clientHeight) / step) + 1;
          const screenshots = [];

          const clip = await getRecommendDialogClip(targetId);
          if (clip) {
            console.log(`    弹窗区域: x=${clip.x}, y=${clip.y}, ${clip.width}x${clip.height}`);
          }
          console.log(`    简历高度: ${scrollHeight}px, 可视: ${clientHeight}px, 步进: ${step}px, 需截 ${pages} 页`);

          let prevActualTop = -1;
          for (let page = 0; page < pages; page++) {
            const scrollTop = Math.min(page * step, scrollHeight - clientHeight);
            await scrollRecommendResume(targetId, scrollTop);

            const actualScrollTop = await iframeEval(targetId, `(function(){
              var dialog = document.querySelector('.dialog-wrap.active');
              if (!dialog) return 0;
              var all = dialog.querySelectorAll('*');
              var bestTop = 0;
              for (var i = 0; i < all.length; i++) {
                var el = all[i];
                if (el.scrollHeight > el.clientHeight && el.scrollTop > bestTop) {
                  bestTop = el.scrollTop;
                }
              }
              return bestTop;
            })()`);
            console.log(`    第${page + 1}页: 目标=${scrollTop}, 实际=${actualScrollTop}`);

            if (page > 0 && actualScrollTop <= prevActualTop) {
              console.log(`    ⚡ 已到达底部 (滚动停滞在 ${actualScrollTop})`);
              break;
            }
            prevActualTop = actualScrollTop;

            const ssPath = resolve(tempDir, `${sname}-p${page}.png`);

            let success = false;
            for (let retry = 0; retry < 2; retry++) {
              try {
                const { cdpScreenshot } = await import('./extract-common.mjs');
                await cdpScreenshot(targetId, ssPath, clip);
                screenshots.push(ssPath);
                success = true;
                break;
              } catch (e) {
                console.warn(`    ⚠ 截图第 ${page + 1}/${pages} 页失败 (${retry + 1}/2): ${e.message}`);
                if (retry < 1) {
                  await randomDelay(800, 1500);
                  await scrollRecommendResume(targetId, scrollTop);
                }
              }
            }
            if (!success) throw new Error(`截图第 ${page + 1}/${pages} 页多次失败`);

            if (page < pages - 1) await randomDelay(600, 1000);
          }

          console.log('  → OCR 识别（后台进行，与关闭弹窗重叠）...');

          // 等上一个人的 OCR 完成后再启动新的（避免 CPU 争抢）
          await prevOcr;

          // 流水线：OCR 在后台执行，不阻塞关闭弹窗和下一人操作
          prevOcr = ocrScreenshots(screenshots, worker).then(resumeText => {
            candidateData.resumeText = resumeText;
            console.log(`  ✓ 简历提取完成 (${resumeText.length} 字)`);
            const resumeDir = resolve(dirname(outputPath), 'resumes');
            mkdirSync(resumeDir, { recursive: true });
            const txtPath = resolve(resumeDir, `${sname}-${geekId}.txt`);
            writeFileSync(txtPath, resumeText, 'utf8');
          }).catch(e => {
            console.warn(`  ⚠ OCR 识别失败: ${e.message}`);
          });

        } catch (e) {
          console.warn(`  ⚠ 简历截图失败: ${e.message}`);
        }

        // 3. 关闭弹窗（与后台 OCR 并行执行）
        try {
          const closed = await closeRecommendDialog(targetId);
          if (!closed) console.warn('  ⚠ 简历弹窗关闭异常');
        } catch (e) {
          console.warn(`  ⚠ 简历弹窗关闭失败: ${e.message}`);
        }

      } catch (err) {
        console.error(`  ✗ 处理失败: ${err.message}`);
        try {
          await closeRecommendDialog(targetId);
        } catch {}
      }

      processedGeekIds.add(geekId);
      candidates.push(candidateData);

      // 每 5 人保存进度（等待 OCR 完成确保数据完整）
      if ((i + 1) % 5 === 0) {
        await prevOcr;
        saveProgress(processedGeekIds, candidates, outputPath);
        console.log(`  💾 进度已保存 (${processedGeekIds.size}/${totalCount})`);
      }

      // 每 50 人额外停顿（等待 OCR 完成后再休息）
      if ((i + 1) % 50 === 0 && i < toProcess.length - 1) {
        await prevOcr;
        const pauseMs = 30000;
        console.log(`  ⏸ 已处理 ${i + 1} 人，暂停 ${(pauseMs / 1000).toFixed(0)}s 防风控...`);
        await sleep(pauseMs);
      }

      // 候选人之间随机延迟
      if (i < toProcess.length - 1) {
        const delayMs = 3000 + Math.random() * 5000;
        console.log(`  ⏳ 等待 ${(delayMs / 1000).toFixed(1)}s...\n`);
        await sleep(delayMs);
      }
    }

    // 等待最后一个候选人的 OCR 完成
    await prevOcr;
  }

  // 两种模式都保留 tab，供后续"打招呼"等操作复用
  console.log('\n保留页面 tab，供后续操作使用');
  await worker.terminate();
  _cleanupTargetId = null;
  _cleanupWorker = null;

  // 保存最终结果
  const output = {
    source: 'recommend',
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
