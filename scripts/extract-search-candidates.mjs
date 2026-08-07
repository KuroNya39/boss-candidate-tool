#!/usr/bin/env node
/**
 * extract-search-candidates.mjs - Boss直聘搜索页候选人提取（基础信息 + 在线简历）
 *
 * 从搜索页（/web/chat/search）提取候选人：
 *   1. 扫描候选人卡片列表获取 jid 和基本信息
 *   2. 逐个点击候选人卡片弹出在线简历弹窗
 *   3. 截图 + OCR 提取简历文本（含 DOM 直提 fallback）
 *   4. 保存到 output/zhipin-candidates.json（含 resumeText 字段）
 *
 * Usage:
 *   node scripts/extract-search-candidates.mjs --attach --count 20 [--output output/zhipin-candidates.json]
 *
 * 前置条件：
 *   - CDP Proxy 已运行（端口 3456）
 *   - Chrome 已登录 Boss 直聘招聘端
 *   - 用户在 Chrome 中已打开搜索页 https://www.zhipin.com/web/chat/search
 *     并已设置好搜索关键词、岗位、筛选条件
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proxyGet, proxyPost, sleep, randomDelay,
  cdpEval, forceViewport, resetViewport,
  ocrScreenshots,
  safeName, findFrameInTree,
  getScanCachePath, getProgressPath,
  saveScanCache, loadScanCache, saveProgress, loadProgress, cleanupCacheFiles,
  archiveOldOutput,
  reportStats,
  parseArgs,
  parseEducationFromResume,
} from './extract-common.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const startTime = new Date().toLocaleString('sv-SE', { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }).replace(' ', 'T') + new Date().toISOString().slice(19, 23);

// 主页面 URL（嵌入 iframe 方式）
const SEARCH_PAGE_URL = 'https://www.zhipin.com/web/chat/search';

/**
 * 通过 CDP /targets 查找用户已打开的搜索页 tab
 * 搜索页只支持 --attach 模式
 */
async function findExistingSearchTab() {
  const targets = await proxyGet('/targets');
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('无法获取 Chrome tab 列表，请确保 CDP Proxy 已连接');
  }
  const tab = targets.find(t =>
    t.url && t.url.includes('/web/chat/search')
  );
  if (!tab || !tab.targetId) {
    throw new Error(
      '未找到已打开的搜索页。\n' +
      '请先在 Chrome 中打开 https://www.zhipin.com/web/chat/search\n' +
      '并设置好搜索关键词、岗位和筛选条件，然后重试。'
    );
  }
  console.log(`已附着到用户打开的搜索页: ${tab.url}`);
  return tab.targetId;
}

/**
 * 通过 JS eval 在 iframe 上下文中执行表达式
 * 搜索页内容在 iframe[name=searchFrame] 内，所有 DOM 操作需穿透 iframe
 */
async function iframeEval(targetId, expr) {
  const wrapped = `(function(){
    var iframe = document.querySelector('iframe[name=searchFrame]');
    if (!iframe) return JSON.stringify({error: 'no-search-frame'});
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
      const count = await iframeEval(targetId, `document.querySelectorAll('li.geek-info-card').length`);
      if (count > 0) return count;
    } catch {}
    await sleep(800);
  }
  throw new Error('搜索页面未加载');
}

// ===== 卡片信息提取脚本 =====

/**
 * 从搜索页的卡片 DOM 中提取基础信息（无需点击）
 *
 * 搜索页卡片结构（li.geek-info-card）：
 *   └─ a[data-jid="xxx"]
 *        └─ .card-container > .card-inner
 *             └─ .search-geek-info
 *                  ├─ .geek-info-detail
 *                  │   ├─ .geek-info-basic
 *                  │   │   ├─ .search-geek-avatar
 *                  │   │   └─ .geek-info-basic-content
 *                  │   │       ├─ .name > .name-label  ← 姓名
 *                  │   │       ├─ .info-labels         ← 年龄·年限·学历·状态·薪资
 *                  │   │       │   └─ .label-text x5
 *                  │   │       ├─ .info-detail         ← 优势描述
 *                  │   │       └─ .info-tags-wrap > .info-tags > .info-tags-item ← 技能
 *                  │   └─ ...
 *                  └─ .geek-words-edus                 ← 工作/教育经历
 *                       ├─ .exp-box.expect-exp-box    ← 期望城市
 *                       ├─ .exp-box.work-exp-box      ← 工作经历
 *                       └─ .exp-box.edu-exp-box       ← 教育经历
 */
const EXTRACT_CARD_INFO_SCRIPT = `(function(){
  function safeText(el) {
    if (!el || !el.textContent) return '';
    return el.textContent.trim();
  }

  var cards = document.querySelectorAll('li.geek-info-card');
  var result = [];
  for (var ci = 0; ci < cards.length; ci++) {
    var card = cards[ci];
    var info = {};

    // expectId: 从 <a> 标签的 data-expect 属性获取（这才是候选人唯一标识）
    // data-jid 是职位ID，所有卡片相同，不能用于去重
    var aTag = card.querySelector('a[data-expect]');
    if (aTag) {
      info.expectId = aTag.getAttribute('data-expect') || '';
      info.jid = aTag.getAttribute('data-jid') || ''; // 保留职位ID供参考
    }

    // 构建 rawVisibleText
    var rawText = safeText(card);
    info.rawVisibleText = rawText;

    // 核心内容在 .search-geek-info 中
    var geekInfo = card.querySelector('.search-geek-info');
    if (!geekInfo) { result.push(info); continue; }

    var detail = geekInfo.querySelector('.geek-info-detail');
    if (!detail) { result.push(info); continue; }

    var basicContent = detail.querySelector('.geek-info-basic-content');
    if (!basicContent) { result.push(info); continue; }

    var basicInfo = {};

    // 姓名
    var nameEl = basicContent.querySelector('.name .name-label');
    if (nameEl) basicInfo.name = safeText(nameEl);

    // 年龄、工作年限、学历、状态、薪资（在 .info-labels 中，5个 .label-text 用 em.vline 分隔）
    var labels = basicContent.querySelectorAll('.info-labels > .label-text');
    if (labels.length >= 1) basicInfo.age = safeText(labels[0]);
    if (labels.length >= 2) basicInfo.workYears = safeText(labels[1]);
    if (labels.length >= 3) basicInfo.education = safeText(labels[2]);
    if (labels.length >= 4) basicInfo.jobStatus = safeText(labels[3]);
    if (labels.length >= 5) basicInfo.expectSalary = safeText(labels[4]);

    if (Object.keys(basicInfo).length > 0) info.basicInfo = basicInfo;

    // 优势描述
    var infoDetail = basicContent.querySelector('.info-detail');
    if (infoDetail) {
      info.advantage = safeText(infoDetail);
    }

    // 技能标签
    var tagItems = basicContent.querySelectorAll('.info-tags .info-tags-item');
    if (tagItems.length > 0) {
      info.skills = Array.from(tagItems).map(function(t) { return safeText(t); });
    }

    // 期望城市（在 .exp-box.expect-exp-box 中）
    // DOM 结构：span.date 是标签"期望城市"，第二个 span 才是实际值
    var expectBox = geekInfo.querySelector('.exp-box.expect-exp-box');
    if (expectBox) {
      var expectSpans = expectBox.querySelectorAll('span');
      if (expectSpans.length >= 2) {
        if (!info.positionInfo) info.positionInfo = {};
        info.positionInfo.expectCity = safeText(expectSpans[1]);
      }
    }

    // 工作经历（在 .exp-box.work-exp-box 中）
    // DOM 结构：span.date 是标签，实际数据在 .t-tooltip-slot > div 中
    var workBox = geekInfo.querySelector('.exp-box.work-exp-box');
    if (workBox) {
      var workItems = workBox.querySelectorAll('li.work-exp-item');
      if (workItems.length > 0) {
        var workExp = [];
        workItems.forEach(function(item) {
          var w = {};
          var tooltipDivs = item.querySelectorAll('.t-tooltip-slot > div');
          if (tooltipDivs.length >= 1) w.company = safeText(tooltipDivs[0]);
          if (tooltipDivs.length >= 2) w.position = safeText(tooltipDivs[1]);
          if (Object.keys(w).length > 0) workExp.push(w);
        });
        if (workExp.length > 0) info.workExperience = workExp;
      }
    }

    // 教育经历（在 .exp-box.edu-exp-box 中）
    // DOM 结构：span.date 是标签"院校"，实际数据在 .t-tooltip-slot > div 中
    // 搜索页卡片只有最新一段教育，且无时间、学历字段
    // time 字段仅在简历中有，此处留空；degree 从 basicInfo.education 补充
    var eduBox = geekInfo.querySelector('.exp-box.edu-exp-box');
    if (eduBox) {
      var eduItems = eduBox.querySelectorAll('li');
      if (eduItems.length > 0) {
        var eduExp = [];
        eduItems.forEach(function(item) {
          var e = {};
          var tooltipDivs = item.querySelectorAll('.t-tooltip-slot > div');
          if (tooltipDivs.length >= 1) e.school = safeText(tooltipDivs[0]);
          if (tooltipDivs.length >= 2) e.major = safeText(tooltipDivs[1]);
          // 卡片上无教育时间字段，留空（简历中有）
          e.time = '';
          // 从基本信息补充学历：卡片上每段教育的学历字段不在 edu-box 中
          // basicInfo.education 已在 info-labels 中提取
          e.degree = '';
          if (Object.keys(e).length > 0) eduExp.push(e);
        });
        if (eduExp.length > 0) info.educationExperience = eduExp;
      }
    }

    result.push(info);
  }
  return result;
})()`;

// ===== 候选人列表扫描 =====

/**
 * 扫描全部候选人：读取所有可见卡片，逐步滚动加载更多
 * 搜索页使用虚拟滚动/分页，需要不断滚动发现新人
 */
async function scanAllCards(targetId, opts = {}) {
  const { maxScrollAttempts = 300, noNewThreshold = 10, onProgress } = opts;

  const seenExpectIds = new Set();
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
      if (card.expectId && !seenExpectIds.has(card.expectId)) {
        seenExpectIds.add(card.expectId);
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

    // 找到滚动容器并滚动
    const scrollResult = await iframeEval(targetId, `(function(){
      var card = document.querySelector('li.geek-info-card');
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
        containerTag: (el.tagName || '') + (el.className ? '.' + el.className.split(' ')[0].replace(/\\s/g, '') : '') + (el.id ? '#' + el.id : '')
      };
    })()`);
    if (!scrollResult.ok) {
      console.warn('  滚动失败，终止扫描');
      break;
    }

    if (scrollResult.scrollHeight > prevScrollHeight) {
      prevScrollHeight = scrollResult.scrollHeight;
      prevScrollTop = -1;
      noNewCount = Math.max(0, noNewCount - 2);
    }

    if (scrollResult.scrollTop === prevScrollTop) break;
    prevScrollTop = scrollResult.scrollTop;

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

  const seenExpectIds = new Set();
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
      if (card.expectId && !seenExpectIds.has(card.expectId)) {
        seenExpectIds.add(card.expectId);
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
      var card = document.querySelector('li.geek-info-card');
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

// ===== 点击候选人卡片弹出简历 =====

async function clickCardToOpenResume(targetId, expectId, cardIndex) {
  // 先滚动列表到目标卡片附近
  if (cardIndex !== undefined) {
    await iframeEval(targetId, `(function(){
      var containers = [
        document.querySelector('.geek-list-wrap'),
        document.querySelector('.params-and-list-container'),
        document.querySelector('.list-body'),
        document.querySelector('#container'),
      ];
      var list = null;
      for (var i = 0; i < containers.length; i++) {
        if (containers[i] && containers[i].scrollHeight > containers[i].clientHeight) {
          list = containers[i];
          break;
        }
      }
      if (!list) list = document.body;
      // 估算：每张卡片约 140px，滚到目标卡片的前 3 张位置
      list.scrollTop = Math.max(0, (${cardIndex} - 3)) * 140;
    })()`);
    await sleep(300);
  }

  const result = await iframeEval(targetId, `(function(){
    var aTag = document.querySelector('a[data-expect="${expectId}"]');
    if (!aTag) return 'not-found';
    aTag.click();
    return 'clicked';
  })()`);
  if (result === 'not-found') {
    throw new Error(`无法定位候选人卡片 expectId=${expectId}`);
  }

  // 搜索页简历弹窗在主页面层级打开，用 cdpEval 在主页面检测
  // 仅用数字/字符串表达式，避免对象序列化
  console.log('  → 等待弹窗 (15s)...');
  const maxWait = 15000;
  const start = Date.now();
  let lastW = 0, lastH = 0;
  let stable = 0;

  while (Date.now() - start < maxWait) {
    try {
      const n = await cdpEval(targetId, "document.querySelectorAll('.boss-popup__wrapper.dialog-lib-resume').length");
      const s = await cdpEval(targetId, "var d=document.querySelector('.boss-popup__wrapper.dialog-lib-resume'); if(d&&d.offsetParent!==null){var r=d.getBoundingClientRect(); r.width+'x'+r.height} else 'no'");

      if (n > 0 && s !== 'no') {
        const [w, h] = s.split('x').map(Number);
        if (stable === 0) console.log(`    弹窗存在: ${s}`);
        if (w === lastW && h === lastH) { stable++; if (stable>=1) { await sleep(250); return true; } }
        else { stable=0; lastW=w; lastH=h; }
      }
    } catch(e) { if (Date.now()-start > 2000) console.log(`    弹窗检测异常: ${e.message}`); }
    await sleep(200);
  }
  console.log('    ⚠ 等待弹窗超时');
  return false;
}

// ===== 简历弹窗相关操作（搜索页特化） =====

/**
 * 获取搜索页简历弹窗的截图区域
 */
async function getSearchDialogClip(targetId) {
  // 搜索页简历弹窗在主页面层级打开，坐标直接是视口坐标，无需加 iframe 偏移
  const clipRaw = await cdpEval(targetId, `JSON.stringify(function(){
    var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    if (!wrap) return null;
    var content = wrap.querySelector('.boss-popup__content');
    if (!content) return null;
    var resumeWrap = content.querySelector('.resume-detail-wrap');
    if (resumeWrap) {
      var wrapRect = resumeWrap.getBoundingClientRect();
      var iframeEl = resumeWrap.querySelector('iframe');
      if (iframeEl) {
        var iframeRect = iframeEl.getBoundingClientRect();
        if (iframeRect.width >= 300 && iframeRect.height > 0) {
          return { x: Math.round(iframeRect.x), y: Math.round(wrapRect.y), width: Math.round(iframeRect.width), height: Math.round(wrapRect.height), source: 'iframe' };
        }
      }
      return { x: Math.round(wrapRect.x), y: Math.round(wrapRect.y), width: Math.round(wrapRect.width), height: Math.round(wrapRect.height), source: 'wrap' };
    }
    var rect = wrap.getBoundingClientRect();
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
  }())`);
  return JSON.parse(clipRaw);
}

/**
 * 获取搜索页简历弹窗的滚动信息
 */
async function getSearchResumeScrollInfo(targetId) {
  const raw = await cdpEval(targetId, `JSON.stringify(function(){
    var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    if (!wrap) return {error: 'no dialog'};
    var content = wrap.querySelector('.boss-popup__content');
    if (!content) return {error: 'no content'};
    var all = content.querySelectorAll('*');
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
    return {
      scrollHeight: content.scrollHeight,
      clientHeight: content.clientHeight,
      scrollTop: 0,
      scrollTarget: 'content',
      source: 'fallback'
    };
  }())`);
  return JSON.parse(raw);
}

/**
 * 尝试直接从 DOM 提取搜索页简历文本，跳过截图+OCR 流程
 * 搜索页简历弹窗结构与推荐页类似，使用相同的 CDP frame tree 策略
 */
// DOM 提取文本最短阈值：低于此值视为抓到弹窗壳（头部固定文案等）而非简历正文，降级走截图 OCR
const DOM_MIN_TEXT_LEN = 200;
async function tryExtractSearchResumeTextFromDOM(targetId) {
  try {
    // 弹窗在主页面层级，需从主页面 DOM 获取 iframe src
    const nestedSrc = await cdpEval(targetId, `JSON.stringify(function(){
      var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
      if (!wrap) return '';
      var content = wrap.querySelector('.boss-popup__content');
      if (!content) return '';
      var detailWrap = content.querySelector('.resume-detail-wrap');
      if (!detailWrap) return '';
      var iframe = detailWrap.querySelector('iframe');
      if (!iframe) return '';
      return iframe.src || iframe.getAttribute('src') || '';
    }())`);
    const parsedSrc = JSON.parse(nestedSrc);
    if (!parsedSrc) return null;

    const framesResp = await proxyGet(`/frames?target=${targetId}`);
    if (!framesResp.frameTree) return null;

    const targetFrame = findFrameInTree(framesResp.frameTree, parsedSrc);
    if (!targetFrame || !targetFrame.id) return null;

    const contexts = framesResp.executionContexts || [];
    const ctx = contexts.find(c => c.frameId === targetFrame.id);
    if (!ctx) return null;

    const result = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var resumeDiv = document.querySelector('#resume') || document.querySelector('body');
      if (!resumeDiv) return null;
      var text = (resumeDiv.textContent || '').replace(/\\s+/g, ' ').trim();
      return text.length > ${DOM_MIN_TEXT_LEN} ? text : null;
    })()`);
    return result.value || null;
  } catch {
    return null;
  }
}

/**
 * 滚动搜索页的简历弹窗
 */
async function scrollSearchResume(targetId, scrollTop) {
  // 弹窗在主页面层级，通过 cdpEval 操作
  await cdpEval(targetId, `(function(){
    var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    if (!wrap) return;
    var content = wrap.querySelector('.boss-popup__content');
    if (!content) return;
    var all = content.querySelectorAll('*');
    var best = null;
    var bestDiff = 0;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var sh = el.scrollHeight;
      var ch = el.clientHeight;
      var diff = sh - ch;
      if (diff > 100 && diff > bestDiff) { best = el; bestDiff = diff; }
    }
    if (!best) best = content;
    best.style.scrollBehavior = 'auto';
    best.scrollTop = ${scrollTop};
  })()`);
  await randomDelay(250, 400);
}

/**
 * 关闭搜索页的简历弹窗
 */
async function closeSearchDialog(targetId) {
  // 弹窗在主页面层级，通过 cdpEval 操作
  const exists = await cdpEval(targetId, `(function(){
    var d = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    return d && d.offsetParent !== null ? true : false;
  })()`);

  if (!exists) return true;

  // 1. 按 Escape 键关闭
  await cdpEval(targetId, `(function(){
    ['keydown','keyup'].forEach(function(type){
      document.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    });
  })()`);
  await randomDelay(400, 800);

  const afterEscape = await cdpEval(targetId, `(function(){
    var d = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    return d && d.offsetParent !== null ? true : false;
  })()`);

  if (!afterEscape) return true;

  // 2. 尝试点关闭按钮
  await cdpEval(targetId, `(function(){
    var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    if (!wrap) return;
    var closeBtn = wrap.querySelector('.close-btn');
    if (closeBtn) closeBtn.click();
  })()`);
  await randomDelay(200, 500);

  const stillVisible = await cdpEval(targetId, `(function(){
    var d = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    return d && d.offsetParent !== null ? true : false;
  })()`);

  if (!stillVisible) return true;

  // 3. 强制移除 DOM
  await cdpEval(targetId, `(function(){
    var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
    if (wrap) wrap.remove();
  })()`);
  console.warn(`  ⚠ 简历弹窗关闭失败，已强制移除DOM`);
  await randomDelay(300, 500);
  return false;
}

/**
 * 合并卡片数据和OCR解析的教育经历
 *
 * 搜索页卡片只有学校+专业（无时间/学历），OCR有时间+学历+专业（学校名有噪声）
 * 策略：以OCR为骨架，用卡片数据校正学校名
 * 卡片有学校X → OCR找到X本/硕/博三段 → 全部保留
 */
function mergeEducationData(candidateData, resumeText) {
  const cardEdu = candidateData.educationExperience || [];
  const ocrParsed = parseEducationFromResume(resumeText);
  if (!ocrParsed || ocrParsed.length === 0) return;

  const noiseWords = ['荣誉', '奖学金', '优秀', '共建', '获荣', '一等', '二等', '院校'];
  const seen = new Set();
  const result = [];

  for (const ocr of ocrParsed) {
    if (!ocr.degree || noiseWords.some(w => ocr.school.includes(w))) continue;

    // 用卡片数据校正学校名
    const cardMatch = cardEdu.find(c =>
      c.school && (c.school.includes(ocr.school) || ocr.school.includes(c.school))
    );
    const school = cardMatch ? cardMatch.school : ocr.school;

    // 同校+同degree去重
    const key = school + '|' + ocr.degree;
    if (seen.has(key)) continue;
    seen.add(key);

    result.push({
      time: ocr.time || '',
      school: school,
      major: ocr.major || (cardMatch ? cardMatch.major : ''),
      degree: ocr.degree
    });
  }

  // 添加卡片中未被OCR覆盖的(以卡片学校名作为补充)
  for (const card of cardEdu) {
    if (!card.school) continue;
    const inResult = result.some(r => r.school.includes(card.school) || card.school.includes(r.school));
    if (!inResult) result.push({ ...card });
  }

  // 按学历级别排序
  const ORDER = {博士: 0, 硕士: 1, 本科: 2, 大专: 3, 中专: 4, 高中: 5};
  result.sort((a, b) => (ORDER[a.degree] ?? 99) - (ORDER[b.degree] ?? 99));

  if (result.length > 0) candidateData.educationExperience = result;
}

// ===== 取消清理 =====

let _cleanupTargetId = null;
let _cleanupWorker = null;
let _cleanupProgressVars = null; // { processedExpectIds, candidates, outputPath, prevOcr }

async function doCleanup() {
  if (_cleanupProgressVars) {
    const { processedExpectIds, candidates, outputPath, prevOcr } = _cleanupProgressVars;
    try {
      await prevOcr;
      saveProgress(processedExpectIds, candidates, outputPath);
      console.log(`  💾 取消前已保存进度 (${processedExpectIds.size} 人)`);
    } catch (e) {
      console.warn(`  ⚠ 取消前保存进度失败: ${e.message}`);
    }
  }

  if (!_cleanupTargetId && !_cleanupWorker) return;
  console.log('\n收到取消指令，清理资源...');
  if (_cleanupTargetId) {
    // 搜索页始终 attach 模式，不关闭用户 tab，但要清除视口 override（DPR=2 残留会变形）
    try { await resetViewport(_cleanupTargetId); } catch {}
    console.log('  [attach 模式] 保留用户打开的 tab');
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

// ===== 主流程 =====

async function main() {
  const opts = parseArgs();
  const outputPath = resolve(opts.output);
  const outputDir = dirname(outputPath);

  archiveOldOutput(outputDir, opts.resume);

  const modeLabel = opts.extractAll ? '全部' : `前 ${opts.count} 个`;
  console.log(`\n========== Boss直聘候选人全量提取 (搜索页) ==========`);
  console.log(`模式: attach（附着到用户打开的搜索页）`);
  console.log(`提取模式: ${modeLabel}`);
  if (opts.resume) console.log('恢复模式: 从上次进度继续');
  console.log(`输出文件: ${outputPath}\n`);

  mkdirSync(dirname(outputPath), { recursive: true });
  const tempDir = resolve(dirname(outputPath), '.temp-screenshots');
  mkdirSync(tempDir, { recursive: true });

  // ===== 阶段 1：扫描候选人列表 =====
  let targetId = null;
  let cardInfos;
  let scanCache = null;
  let effectiveJobName = ''; // 当前搜索岗位名

  if (opts.resume) {
    scanCache = loadScanCache(outputPath);
  }

  if (scanCache) {
    cardInfos = scanCache.candidates;
    console.log(`跳过扫描阶段，使用缓存: ${cardInfos.length} 人\n`);
  } else {
    // 搜索页只支持 attach 模式
    console.log('查找用户已打开的搜索页...');
    targetId = await findExistingSearchTab();
    console.log(`已附着到 Tab: ${targetId}\n`);

    // 按实际窗口尺寸设置视口（DPR=2 提升 OCR 清晰度），避免布局塌缩、网页变形
    await forceViewport(targetId);

    // 等待页面加载
    console.log('等待页面加载...');
    const cardCount = await waitForPageLoad(targetId, 20000);
    console.log(`页面已加载，卡片列表: ${cardCount} 项\n`);

    // 获取页面当前搜索的岗位名（如果有）
    try {
      const pageJob = await iframeEval(targetId, `(function(){
        var jobLabel = document.querySelector('.search-current-job');
        if (jobLabel) return jobLabel.textContent.trim();
        return '';
      })()`);
      if (pageJob) {
        console.log(`当前搜索岗位: ${pageJob}`);
        effectiveJobName = pageJob;
      }
    } catch {}

    // 如果用户指定了目标岗位（--job），覆盖页面自动检测的岗位名
    if (opts.job) {
      console.log(`使用指定的目标岗位: ${opts.job}`);
      effectiveJobName = opts.job;
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
      process.exit(1);
    }

    // 为所有候选人注入 appliedJob（jid 映射为 geekId + 岗位名）
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
  const processedExpectIds = new Set();
  const candidates = [];

  if (opts.resume) {
    progressData = loadProgress(outputPath);
    if (progressData) {
      const scanExpectIds = new Set(cardInfos.map(c => c.expectId));
      const validIds = progressData.processedGeekIds.filter(gid => scanJids.has(gid));
      const invalidCount = progressData.processedGeekIds.length - validIds.length;
      if (invalidCount > 0) {
        console.warn(`⚠ 进度缓存中有 ${invalidCount} 个 jid 不在当前扫描结果中，已忽略`);
      }
      for (const gid of validIds) {
        processedExpectIds.add(gid);
      }
      const validCandidates = progressData.candidates.filter(c => processedExpectIds.has(c.expectId || c.geekId));
      candidates.push(...validCandidates);
      console.log(`已有 ${processedExpectIds.size} 人完成提取，跳过这些候选人\n`);
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

  // 如果 resume 时没有 targetId（从缓存恢复），需要重新 attach 到搜索页
  if (!targetId) {
    console.log('附着到已打开的搜索页...');
    targetId = await findExistingSearchTab();
    _cleanupTargetId = targetId;
    console.log(`已附着到 Tab: ${targetId}`);

    // 按实际窗口尺寸设置视口（DPR=2 提升 OCR 清晰度），避免布局塌缩、网页变形
    await forceViewport(targetId);

    console.log('等待页面加载...');
    const cardCount = await waitForPageLoad(targetId, 20000);
    console.log(`页面已加载，卡片列表: ${cardCount} 项\n`);
  } else {
    _cleanupTargetId = targetId;
    console.log('复用扫描 tab，无需重新打开\n');
    // 滚动回列表顶部
    await iframeEval(targetId, `(function(){
      var containers = [
        document.querySelector('.geek-list-wrap'),
        document.querySelector('.params-and-list-container'),
        document.querySelector('#container'),
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
  const toProcess = cardInfos.filter(c => !processedExpectIds.has(c.expectId));
  const totalCount = cardInfos.length;
  const alreadyDone = processedExpectIds.size;

  console.log(`待提取: ${toProcess.length} 人 (已完成 ${alreadyDone}，总计 ${totalCount})\n`);

  if (toProcess.length === 0) {
    console.log('所有候选人已提取完成');
  } else {
    let prevOcr = Promise.resolve();

    for (let i = 0; i < toProcess.length; i++) {
      const card = toProcess[i];
      const expectId = card.expectId;
      const globalIndex = alreadyDone + i + 1;
      const displayName = (card.basicInfo && card.basicInfo.name) || expectId || `候选人${globalIndex}`;
      console.log(`[${globalIndex}/${totalCount}] ${displayName} (expectId=${expectId})`);

      let candidateData = {
        index: globalIndex,
        geekId: expectId || '',          // expectId 映射为 geekId 兼容后续流程
        expectId: expectId || '',        // 保留原始 expectId
        jid: card.jid || '',             // 保留原始 jid（职位ID）
        rawVisibleText: card.rawVisibleText || '',
      };

      if (card.basicInfo) candidateData.basicInfo = card.basicInfo;
      if (card.workExperience) candidateData.workExperience = card.workExperience;
      if (card.educationExperience) {
        candidateData.educationExperience = card.educationExperience;
        // 搜索页卡片每段教育没有学历字段，从 basicInfo 补充
        const basicEdu = card.basicInfo?.education || '';
        if (basicEdu) {
          for (const edu of candidateData.educationExperience) {
            if (!edu.degree) edu.degree = basicEdu;
          }
        }
      }
      if (card.positionInfo) {
        candidateData.positionInfo = card.positionInfo;
        if (!candidateData.positionInfo.appliedJob) {
          candidateData.positionInfo.appliedJob = card.appliedJob || '';
        }
      }
      if (card.skills) candidateData.skills = card.skills;
      if (card.advantage) candidateData.advantage = card.advantage;

      try {
        // 1. 点击卡片打开简历弹窗
        console.log('  → 点击卡片打开简历...');
        const dialogOpened = await clickCardToOpenResume(targetId, expectId, globalIndex - 1);
        if (!dialogOpened) {
          console.log('  ℹ 简历弹窗未打开，使用卡片基础数据（无教育时间、仅一段学历）');
          processedExpectIds.add(expectId);
          candidates.push(candidateData);
          continue;
        }

        // 2. 截图 + OCR
        try {
          const sname = safeName(displayName);

          // 截图区域 clip 提升到 try 作用域：若在 else 块内声明，
          // 外层 catch 引用它会因块级作用域抛 "clip is not defined"，
          // 反而把真实截图失败原因覆盖掉（v1.3.16 实测）
          let clip = null;

          // 先尝试直接从 DOM 提取简历文本
          const domText = await tryExtractSearchResumeTextFromDOM(targetId);
          if (domText) {
            candidateData.resumeText = domText;
            console.log(`  ✓ DOM提取简历文本 (${domText.length} 字)`);
            // 从简历文本解析教育经历并与卡片数据合并
            mergeEducationData(candidateData, domText);
            const resumeDir = resolve(dirname(outputPath), 'resumes');
            mkdirSync(resumeDir, { recursive: true });
            const txtPath = resolve(resumeDir, `${sname}-${expectId}.txt`);
            writeFileSync(txtPath, domText, 'utf8');
          } else {
            console.log('  → 截图...');

            // 弹窗刚打开时简历 iframe 可能尚未加载：clip 尺寸和滚动信息会拿到空值
            // （0x0 / 高度=可视高度），直接截图会报 "Cannot take screenshot with 0 width"，
            // 且会把"有简历但加载慢"的候选人误判为无简历。先等待内容渲染稳定（最多约 6s）。
            let info = null;
            for (let attempt = 0; attempt < 4; attempt++) {
              info = await getSearchResumeScrollInfo(targetId);
              clip = await getSearchDialogClip(targetId);
              const clipOk = clip && clip.width > 50 && clip.height > 50;
              const scrollOk = info && !info.error && info.scrollHeight > info.clientHeight + 50;
              if (attempt === 0) {
                console.log(`    弹窗内容: clip=${clipOk ? `${clip.width}x${clip.height}` : '空'}, 可滚动=${scrollOk ? `${info.scrollHeight}px` : '无'}`);
              }
              if (clipOk || scrollOk) break;
              await randomDelay(1200, 1800);
            }
            if (info.error) throw new Error(info.error);

            const { scrollHeight, clientHeight } = info;
            const step = Math.floor(clientHeight * 0.95);
            const pages = Math.max(1, Math.ceil((scrollHeight - clientHeight) / step) + 1);
            const screenshots = [];

            if (clip) {
              console.log(`    弹窗区域: x=${clip.x}, y=${clip.y}, ${clip.width}x${clip.height}`);
            } else {
              console.log('    弹窗区域: null（走全屏截图兜底）');
            }
            console.log(`    简历高度: ${scrollHeight}px, 可视: ${clientHeight}px, 步进: ${step}px, 需截 ${pages} 页`);

            let prevActualTop = -1;
            for (let page = 0; page < pages; page++) {
              const scrollTop = Math.min(page * step, scrollHeight - clientHeight);
              await scrollSearchResume(targetId, scrollTop);

              const actualScrollTop = await cdpEval(targetId, `(function(){
                var wrap = document.querySelector('.boss-popup__wrapper.boss-dialog.dialog-lib-resume');
                if (!wrap) return 0;
                var content = wrap.querySelector('.boss-popup__content');
                if (!content) return 0;
                var all = content.querySelectorAll('*');
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
              for (let retry = 0; retry < 3; retry++) {
                try {
                  // clip 尺寸无效（width/height 为 0，常见于弹窗尚未渲染完成）时
                  // 转全屏截图兜底，避免 CDP 报 "Cannot take screenshot with 0 width"
                  const shotClip = (clip && clip.width > 0 && clip.height > 0) ? clip : null;
                  const { cdpScreenshot } = await import('./extract-common.mjs');
                  await cdpScreenshot(targetId, ssPath, shotClip);
                  screenshots.push(ssPath);
                  success = true;
                  break;
                } catch (e) {
                  console.warn(`    ⚠ 截图第 ${page + 1}/${pages} 页失败 (${retry + 1}/3): ${e.message}`);
                  if (retry < 2) {
                    // 失败多半是内容未渲染完：等待更久 + 重新获取弹窗区域 + 重新滚动定位，再重试
                    await randomDelay(1200, 2000);
                    try {
                      clip = await getSearchDialogClip(targetId);
                    } catch {}
                    await scrollSearchResume(targetId, scrollTop);
                    await sleep(500);
                  }
                }
              }
              if (!success) throw new Error(`截图第 ${page + 1}/${pages} 页多次失败`);

              if (page < pages - 1) await randomDelay(300, 500);
            }

            console.log('  → OCR 识别（后台进行，与关闭弹窗重叠）...');

            await prevOcr;

            prevOcr = ocrScreenshots(screenshots, worker).then(resumeText => {
              candidateData.resumeText = resumeText;
              console.log(`  ✓ 简历提取完成 (${resumeText.length} 字)`);
              mergeEducationData(candidateData, resumeText);
              const resumeDir = resolve(dirname(outputPath), 'resumes');
              mkdirSync(resumeDir, { recursive: true });
              const txtPath = resolve(resumeDir, `${sname}-${expectId}.txt`);
              writeFileSync(txtPath, resumeText, 'utf8');
            }).catch(e => {
              console.warn(`  ⚠ OCR 识别失败: ${e.message}`);
            });
          }
        } catch (e) {
          let clipDiag = clip ? `clip=${clip.x},${clip.y},${clip.width}x${clip.height}` : 'clip=null(全屏)';
          let filesDiag = '';
          try {
            const { readdirSync } = await import('node:fs');
            const ssFiles = readdirSync(tempDir).filter(f => f.startsWith(sname)).map(f => `${f}(${readFileSync(resolve(tempDir, f)).length}B)`).join(',');
            filesDiag = ssFiles ? ` 已落盘: ${ssFiles}` : ' 无已落盘截图';
          } catch {}
          console.warn(`  ⚠ 简历截图失败: ${e.message} | ${clipDiag}${filesDiag}`);
        }

        // 3. 关闭弹窗
        try {
          const closed = await closeSearchDialog(targetId);
          if (!closed) console.warn('  ⚠ 简历弹窗关闭异常');
        } catch (e) {
          console.warn(`  ⚠ 简历弹窗关闭失败: ${e.message}`);
        }

      } catch (err) {
        console.error(`  ✗ 处理失败: ${err.message}`);
        try {
          await closeSearchDialog(targetId);
        } catch {}
      }

      processedExpectIds.add(expectId);
      candidates.push(candidateData);
      _cleanupProgressVars = { processedExpectIds, candidates, outputPath, prevOcr };

      if ((i + 1) % 5 === 0) {
        await prevOcr;
        saveProgress(processedExpectIds, candidates, outputPath);
        console.log(`  💾 进度已保存 (${processedExpectIds.size}/${totalCount})`);
      }

      if ((i + 1) % 50 === 0 && i < toProcess.length - 1) {
        await prevOcr;
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

    await prevOcr;
  }

  console.log('\n保留页面 tab，供后续操作使用');
  await worker.terminate();
  // 保留 tab 前必须清除视口 override，否则 DPR=2 残留导致筛选框变形变大
  await resetViewport(_cleanupTargetId);
  _cleanupTargetId = null;
  _cleanupWorker = null;

  // 保存最终结果
  const output = {
    source: 'search',
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
