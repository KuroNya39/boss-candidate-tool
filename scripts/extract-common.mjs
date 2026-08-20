/**
 * extract-common.mjs - 候选人提取公共模块
 *
 * 共享工具函数：CDP 调用、OCR 引擎、进度保存/恢复、截图、关闭弹窗、简历去重清洗
 *
 * Usage:
 *   import { cdpEval, sleep, ... } from './extract-common.mjs';
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROXY_PORT = 3456;

// ===== CDP Proxy HTTP 调用 =====

export function proxyGet(path) {
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

export function proxyPost(path, data) {
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

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 提取开始时把标签页带到最前（前台才持续出帧，截图才稳定）+ 唤醒页面
// 解除后台冻结/节能暂停（否则切到别的标签页后简历 canvas 停画、截图空白）。
// 页面尺寸、DPR 全程不被触碰——之前的 setDeviceMetricsOverride 锁视口会让网页重排变形，
// 已彻底弃用；OCR 清晰度改由 cdpScreenshot 的 clip.scale=2 保证（只放大截图画面，不改布局）。
export async function prepareTab(targetId) {
  // /activate 用 Target.activateTarget 把标签页真实带到最前：前台页面 Chrome 不会冻结/节能，
  // 懒加载内容开始渲染。截图时 /screenshot 端点内部还会再唤醒一次（双保险，见 cdp-proxy）。
  try { await proxyGet(`/activate?target=${targetId}`); } catch {}
  console.log('已激活页面（带到最前）；不再锁视口，页面布局不受影响');
}

export function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(ms));
}

// ===== CDP 快捷操作 =====

export async function cdpEval(targetId, expr) {
  const result = await proxyPost(`/eval?target=${targetId}`, expr);
  if (result.error) throw new Error(`eval error: ${result.error}`);
  return result.value;
}

// 检查标签页当前是否可见。只有「被切到后台/最小化」（不可见）时才需要 /activate 拉回最前，
// 否则每次截图都把 Boss 的 Chrome 窗口强顶到最前，会打断用户用别的窗口（v1.3.28）。
async function isTabVisible(targetId) {
  try {
    const result = await Promise.race([
      cdpEval(targetId, `document.visibilityState === 'visible'`),
      sleep(2000).then(() => 'timeout'),
    ]);
    return result === true;
  } catch {
    return false;
  }
}

export async function cdpScreenshot(targetId, filePath, clip) {
  // 截图前按需把标签页真实带到最前（Target.activateTarget）。
  // 用户切到别的标签页后，隐藏页面的合成器可能停止出帧，Page.captureScreenshot
  // 会卡到 CDP 超时（之前实测 30s 超时、截图失败）。activate 让页面前台出帧 → 截图稳定。
  // v1.3.28：Boss 页本来就在最前（如「开两个 Chrome」边跑边用）时不再强制拉回，不抢用户焦点；
  // 只有真的被切走（隐藏）时才激活。拿不到可见状态时保守处理：照旧 activate 保证截图稳定。
  try {
    if (!(await isTabVisible(targetId))) {
      try { await proxyGet(`/activate?target=${targetId}`); } catch {}
    }
  } catch {}
  // v1.3.11: 改回 PNG 无损。JPEG q80 的块效应 + 色度抽样破坏中文细字边缘，
  // tesseract 二值化放大噪声；代价是文件更大、编码略慢，OCR 准确率优先。
  let url = `/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}&format=png`;
  if (clip) {
    url += `&clip=${clip.x},${clip.y},${clip.width},${clip.height}`;
  }
  // scale=2 把截图画面放大 2 倍（OCR 清晰度），只影响截图分辨率，不改页面布局/视口/DPR。
  // 无条件带上：clip 与全屏兜底截图都保持同样的 2 倍清晰度（否则同一份简历清晰度会不一致）。
  url += `&scale=2`;
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

// ===== 在线简历弹窗操作 =====

/**
 * 点击"在线简历"按钮，等待弹窗出现且尺寸稳定
 * 注：推荐牛人页直接点击卡片弹出简历，不需要此函数。仅沟通页需用。
 */
export async function clickOnlineResume(targetId) {
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
        const sizeOk = state.width >= 600 && state.height >= 500;
        if (state.width === lastWidth && state.height === lastHeight) {
          stableCount++;
          if (stableCount >= 1) {
            // 内容就绪检测：DOM #resume 或 canvas 已加载即视为就绪（替代固定 2-4s 等待）
            const contentReady = await waitForResumeContentLoaded(targetId, 2000);
            const sizeWarn = sizeOk ? '' : ' ⚠尺寸偏小';
            console.log(`    弹窗尺寸稳定: ${state.width}x${state.height}, iframe=${state.hasIframe}, resume=${state.hasResume}, canvas=${state.hasCanvas}, 内容${contentReady ? '就绪' : '未就绪'}${sizeWarn}`);
            await sleep(contentReady ? 300 : 800);
            return true;
          }
        } else {
          stableCount = 0;
          lastWidth = state.width;
          lastHeight = state.height;
        }
      }
    } catch {}
    await sleep(200);
  }

  console.log('    ⚠ 等待弹窗超时');
  return false;
}

/**
 * 等待简历弹窗 iframe 内容真正加载（#resume 或 canvas 出现），最多 maxWait ms
 */
async function waitForResumeContentLoaded(targetId, maxWait) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const raw = await cdpEval(targetId, `(function(){
        var detail = document.querySelector('.resume-detail');
        if (!detail) return '0';
        var iframe = detail.querySelector('iframe');
        if (!iframe) return '0';
        var idoc;
        try { idoc = iframe.contentDocument || iframe.contentWindow.document; } catch(e) { return '0'; }
        if (!idoc) return '0';
        return (!!idoc.querySelector('#resume') || !!idoc.querySelector('canvas')) ? '1' : '0';
      })()`);
      if (raw === '1') return true;
    } catch {}
    await sleep(150);
  }
  return false;
}

export async function getDialogClip(targetId) {
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

    if (iframe) {
      var iframeRect = iframe.getBoundingClientRect();
      if (iframeRect.width >= 300 && iframeRect.height > 0) {
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

export async function getResumeScrollInfo(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var detail = document.querySelector('.resume-detail');
    if (!detail) return JSON.stringify({error: 'no .resume-detail'});

    var iframe = detail.querySelector('iframe');

    if (iframe) {
      try {
        var idoc = iframe.contentDocument || iframe.contentWindow.document;
        var resumeDiv = idoc.querySelector('#resume') || idoc.querySelector('div');
        var canvas = idoc.querySelector('canvas#resume') || idoc.querySelector('canvas');

        if (resumeDiv && canvas) {
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
              divHeight: divHeight,
              canvasSize: canvas.width + 'x' + canvas.height,
              heights: 'div=' + divHeight + ',detail=' + detailHeight + ',iframe=' + iframeHeight
            });
          }
        }

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
          divHeight: resumeDiv ? resumeDiv.offsetHeight : 0,
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

    if (detail.scrollHeight > detail.clientHeight) {
      return JSON.stringify({
        scrollHeight: detail.scrollHeight,
        clientHeight: detail.clientHeight,
        scrollTop: detail.scrollTop,
        scrollTarget: 'resume-detail',
        source: 'detail-scroll'
      });
    }

    if (iframe && iframe.offsetHeight > detail.clientHeight) {
      return JSON.stringify({
        scrollHeight: iframe.offsetHeight,
        clientHeight: detail.clientHeight,
        scrollTop: 0,
        scrollTarget: 'resume-detail',
        source: 'iframe-offset'
      });
    }

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

export async function scrollResume(targetId, scrollTop) {
  await cdpEval(targetId, `(function(){
    var el = document.querySelector('.resume-detail');
    if (el) {
      el.style.scrollBehavior = 'auto';
      el.scrollTop = ${scrollTop};
    }
  })()`);
  await randomDelay(250, 400);
}

// ===== 通用弹窗关闭 =====

async function popupStillVisible(targetId, popupSelector) {
  const r = await cdpEval(targetId, `(function(){
    var popup = document.querySelector('${popupSelector}');
    return !!(popup && popup.offsetParent !== null);
  })()`);
  return r;
}

export async function closeBossPopup(targetId, popupSelector, label = '弹窗') {
  // 先尝试 Escape 键关闭（keydown + keyup 兼容 React 等框架）
  await cdpEval(targetId, `(function(){
    ['keydown','keyup'].forEach(function(type){
      document.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    });
  })()`);
  await randomDelay(250, 450);

  const closed = await cdpEval(targetId, `(function(){
    var popup = document.querySelector('${popupSelector}');
    if (!popup) return 'not-exist';
    var dialogWrap = document.querySelector('.dialog-wrap.active');
    if (!dialogWrap || dialogWrap.offsetParent === null) return 'escape-closed';
    var closeBtn = dialogWrap && dialogWrap.querySelector('.close-btn');
    if (!closeBtn) closeBtn = popup.querySelector('.close-btn');
    if (!closeBtn) closeBtn = popup.querySelector('.boss-popup__close');
    if (!closeBtn) closeBtn = popup.querySelector('[class*="close"]');
    if (closeBtn) { closeBtn.click(); return 'clicked'; }
    var pageClose = document.querySelector('.dialog-wrap.active .close-btn')
      || document.querySelector('.boss-popup__close');
    if (pageClose) { pageClose.click(); return 'clicked-page'; }
    return 'no-close-btn';
  })()`);
  if (closed === 'not-exist') return true;

  // 弹窗已响应（Escape 生效或已点关闭按钮）：短等确认收起即返回，不空等
  await randomDelay(180, 320);

  if (!(await popupStillVisible(targetId, popupSelector))) {
    await randomDelay(120, 240);
    return true;
  }

  // 弹窗还在 → 再点一次关闭按钮
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
  await randomDelay(400, 700);

  if (await popupStillVisible(targetId, popupSelector)) {
    await cdpEval(targetId, `(function(){
      var dialogWrap = document.querySelector('.dialog-wrap.active');
      if (dialogWrap) dialogWrap.remove();
    })()`);
    console.warn(`  ⚠ ${label}关闭失败，已强制移除DOM`);
    await randomDelay(300, 500);
    return false;
  }

  await randomDelay(120, 240);
  return true;
}

export async function closeResumeDialog(targetId) {
  return closeBossPopup(targetId, '.resume-detail', '简历弹窗');
}

// ===== 简历截图 =====

export async function captureResumeScreenshots(targetId, safename, tempDir) {
  let info = await getResumeScrollInfo(targetId);
  if (info.error) throw new Error(info.error);

  // 等待内容渲染：简历 canvas 画出来之前 DIV#resume 高度为 0、scrollHeight 恒等于可视高度，
  // 旧判断（scrollHeight > clientHeight）对这种空白状态永远等不到。改用 divHeight > 0 判定。
  if (info.scrollHeight <= info.clientHeight || !(info.divHeight > 0)) {
    for (let retry = 0; retry < 5; retry++) {
      console.log(`    等待内容渲染... (第${retry + 1}次)`);
      await sleep(2000);
      info = await getResumeScrollInfo(targetId);
      if (info.scrollHeight > info.clientHeight || info.divHeight > 0) break;
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

    const actualScrollTop = parseInt(await cdpEval(targetId, `document.querySelector('.resume-detail').scrollTop`)) || 0;
    console.log(`    第${page + 1}页: 目标=${scrollTop}, 实际=${actualScrollTop}`);

    if (page > 0 && actualScrollTop <= prevActualTop) {
      console.log(`    ⚡ 已到达底部 (滚动停滞在 ${actualScrollTop}), 跳过剩余 ${pages - page} 页`);
      break;
    }
    prevActualTop = actualScrollTop;

    const ssPath = resolve(tempDir, `${safename}-p${page}.png`);

    let success = false;
    for (let retry = 0; retry < 3; retry++) {
      try {
        await cdpScreenshot(targetId, ssPath, clip);
        screenshots.push(ssPath);
        success = true;
        break;
      } catch (e) {
        console.warn(`    ⚠ 截图第 ${page + 1}/${pages} 页失败 (${retry + 1}/3): ${e.message}`);
        if (retry < 2) {
          // 失败多半是内容未渲染完：等待更久 + 重新滚动定位，再重试
          // v1.3.12: 拉长等待给 OOPIF 简历弹窗 iframe 更多渲染时间
          // v1.3.31: 重试等待 1500-2500 → 800-1200ms（截图提速，重试不频繁触发）
          await randomDelay(800, 1200);
          await scrollResume(targetId, scrollTop);
          await sleep(500);
        }
      }
    }
    if (!success) {
      throw new Error(`截图第 ${page + 1}/${pages} 页多次失败`);
    }

    // v1.3.31: 页间等待 300-500 → 220-350ms（截图提速，仍保留防反爬节奏）
    if (page < pages - 1) await randomDelay(220, 350);
  }

  await scrollResume(targetId, 0);
  return screenshots;
}

// ===== OCR 文本清洗 =====

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

export function cleanOcrText(raw) {
  if (!raw) return '';
  let text = raw;

  // 全角转半角（保留中文标点）
  text = text.replace(/：/g, '：').replace(/，/g, '，');

  // 去除中文字符之间的多余空格
  const CJK = '[\u4e00-\u9fa5\uff00-\uffef\u3000-\u303f]';
  const cjkSpaceRe = new RegExp(`(${CJK})\\s+(${CJK})`, 'g');
  for (let i = 0; i < 3; i++) {
    text = text.replace(cjkSpaceRe, '$1$2');
  }

  // 中文与标点符号之间的空格
  text = text.replace(/([\u4e00-\u9fa5])\s+([\uff0c\u3002\uff1f\uff01\uff1b\uff1a\u201d\u2019\uff09])/g, '$1$2');
  text = text.replace(/([\uff0c\u3002\uff1a\u201c\u2018\uff08])\s+([\u4e00-\u9fa5])/g, '$1$2');

  // 多个空格/制表符 → 单个空格
  text = text.replace(/[ \t]+/g, ' ');

  // 行首行尾空白去除
  text = text.split('\n').map(l => l.trim()).join('\n');

  // 压缩连续空行
  text = text.replace(/\n{3,}/g, '\n\n');

  // 常见错字修正
  for (const [wrong, right] of Object.entries(OCR_TYPO_MAP)) {
    text = text.split(wrong).join(right);
  }

  // 去除孤立的单字符行
  text = text.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return true;
    if (t.length === 1 && /[^\u4e00-\u9fa5\w]/.test(t)) return false;
    return true;
  }).join('\n');

  // 去除页面底部"其他名校毕业的牛人"推荐列表
  const bottomMarkerRe = /[其共][他她]名校毕业的[牛午][人入]/;
  const otherSchoolLine = text.split('\n').findIndex(l => bottomMarkerRe.test(l));
  if (otherSchoolLine !== -1) {
    text = text.split('\n').slice(0, otherSchoolLine).join('\n');
  }

  return text.trim();
}

export function dedupePages(pages) {
  if (pages.length <= 1) return pages.join('\n\n');
  const result = [pages[0]];
  for (let i = 1; i < pages.length; i++) {
    const prevLines = result[result.length - 1].split('\n').map(l => l.trim()).filter(Boolean);
    const curLines = pages[i].split('\n');
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

export async function ocrScreenshots(screenshots, worker) {
  // 简历是单栏文本，PSM6（假设为单一文本块）比默认 auto 更稳定，降低乱码
  try {
    await worker.setParameters({ tessedit_pageseg_mode: '6' });
  } catch { /* 部分版本参数名差异时忽略 */ }
  const texts = [];
  for (let i = 0; i < screenshots.length; i++) {
    console.log(`    OCR 第 ${i + 1}/${screenshots.length} 页...`);
    // v1.3.12: 内建预处理。isNormalize（对比度归一化）默认已开；
    // isBinarize（Otsu 二值化）降低彩色/低对比度噪声对中文细字的干扰。
    // 若实测对低对比度简历过曝，回退为 { isNormalize: true }。
    const { data: { text } } = await worker.recognize(screenshots[i], { isBinarize: true });
    texts.push(cleanOcrText(text));
  }
  const merged = dedupePages(texts);
  return cleanOcrText(merged);
}

export function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unknown';
}

// ===== 进度保存/恢复 =====

export function getScanCachePath(outputPath) {
  return resolve(dirname(outputPath), '.scan-cache.json');
}

export function getProgressPath(outputPath) {
  return resolve(dirname(outputPath), '.extract-progress.json');
}

export function saveScanCache(candidateList, outputPath) {
  const cachePath = getScanCachePath(outputPath);
  writeFileSync(cachePath, JSON.stringify({
    scannedAt: new Date().toISOString(),
    totalCandidates: candidateList.length,
    candidates: candidateList,
  }, null, 2), 'utf8');
  console.log(`扫描缓存已保存: ${cachePath} (${candidateList.length} 人)`);
}

export function loadScanCache(outputPath) {
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

export function saveProgress(processedGeekIds, candidates, outputPath) {
  const progressPath = getProgressPath(outputPath);
  writeFileSync(progressPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    processedCount: processedGeekIds.size,
    processedGeekIds: [...processedGeekIds],
    candidates,
  }, null, 2), 'utf8');
}

export function loadProgress(outputPath) {
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

export function cleanupCacheFiles(outputPath) {
  const files = [getScanCachePath(outputPath), getProgressPath(outputPath)];
  for (const f of files) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {}
  }
}

export function archiveOldOutput(outputDir, isResume) {
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

  // 逐个文件归档，跳过被锁的文件，避免 Windows 目录重命名 EPERM
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const archivedDir = `${outputDir}-${stamp}`;
  mkdirSync(archivedDir, { recursive: true });

  let moved = 0;
  for (const entry of entries) {
    const src = resolve(outputDir, entry);
    const dst = resolve(archivedDir, entry);
    try {
      renameSync(src, dst);
      moved++;
    } catch {
      // 文件被锁，跳过
    }
  }

  if (moved > 0) {
    console.log(`已归档 ${moved} 个文件到: ${archivedDir}`);
  } else {
    // 全部失败时清理空目录
    try { readdirSync(archivedDir).length === 0 && rmdirSync(archivedDir); } catch {}
  }
}

// ===== 统计数据上报 =====

export async function reportStats({ resume_count, start_time, status }) {
  const url = process.env.STATS_API_URL || 'http://192.168.201.39:8100/ai_efficiency/api/submit_screening_record/';
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

/**
 * 在 CDP frame tree 中递归查找匹配 URL 的 frame
 */
export function findFrameInTree(frameNode, url) {
  if (!frameNode) return null;
  const f = frameNode.frame;
  if (f && f.url && (f.url.includes(url) || url.includes(f.url))) return f;
  if (frameNode.childFrames) {
    for (const child of frameNode.childFrames) {
      const found = findFrameInTree(child, url);
      if (found) return found;
    }
  }
  return null;
}

/** 候选人列表滚动容器检测 JS 代码片段 */
export const FIND_LIST_CONTAINER_JS = `
var __item = document.querySelector('.geek-item');
var el = __item ? __item.parentElement : null;
while (el && el !== document.body && el !== document.documentElement) {
  if (el.scrollHeight > el.clientHeight + 5) break;
  el = el.parentElement;
}
if (!el || el === document.body || el === document.documentElement) {
  el = document.documentElement;
}
if (el === document.documentElement) {
  var __fb = document.querySelector('.geek-list') || document.querySelector('.chat-record');
  if (__fb && __fb.scrollHeight > __fb.clientHeight + 5) el = __fb;
}
`;

/**
 * DOM 提取失败时的深入诊断：定位简历 iframe 到底卡在哪一环。
 * 逐步打印：frame 匹配结果 → createIsolatedWorld 结果 → iframe 内 #resume 是否有 canvas、
 * 文本长度、滚动高度。用于区分两种失败：
 *   a) 简历正文是 canvas 图片渲染（#resume 高度≈0、无文本但有 canvas）→ 结构性无法 DOM 提取，只能 OCR
 *   b) frame 匹配 / context 创建失败（有文本但没拿到）→ 代码问题，可修
 * @param {string} targetId 标签页 targetId
 * @param {string} nestedSrc 简历 iframe 的 src
 * @param {string} label 日志前缀（区分页面）
 * @returns {object|null} 探测到的信息对象，拿不到返回 null
 */
export async function diagnoseResumeIframeDom(targetId, nestedSrc, label = 'DOM') {
  try {
    const framesResp = await proxyGet(`/frames?target=${targetId}`);
    if (!framesResp.frameTree) {
      console.warn(`  ${label}🔍 DOM诊断: /frames 未返回 frameTree`);
      return null;
    }
    // 1) frame 匹配
    const targetFrame = findFrameInTree(framesResp.frameTree, nestedSrc);
    if (!targetFrame) {
      console.warn(`  ${label}🔍 DOM诊断: frameTree 未匹配到嵌套Src=${(nestedSrc || '').slice(0, 80)}`);
      (function dump(node, depth) {
        if (!node) return;
        const f = node.frame;
        if (f) console.warn(`  ${label}🔍 DOM诊断:   frame[${depth}] url=${(f.url || '').slice(0, 100)}`);
        if (node.childFrames) node.childFrames.forEach((c) => dump(c, depth + 1));
      })(framesResp.frameTree);
      return null;
    }
    console.warn(`  ${label}🔍 DOM诊断: 匹配到 frame id=${targetFrame.id} url=${(targetFrame.url || '').slice(0, 100)}`);
    // 2) createIsolatedWorld
    let ctx = null;
    try {
      const iw = await proxyGet(`/isolated-world?target=${targetId}&frame=${encodeURIComponent(targetFrame.id)}`);
      if (iw && iw.executionContextId) {
        ctx = { id: iw.executionContextId };
        console.warn(`  ${label}🔍 DOM诊断: createIsolatedWorld OK contextId=${iw.executionContextId}`);
      } else {
        console.warn(`  ${label}🔍 DOM诊断: createIsolatedWorld 失败: ${JSON.stringify(iw)}`);
        return null;
      }
    } catch (e) {
      console.warn(`  ${label}🔍 DOM诊断: createIsolatedWorld 异常: ${e.message}`);
      return null;
    }
    // 3) iframe 内 #resume 文本长度 + canvas 探测（判断是图片简历还是 HTML 简历）
    try {
      const probe = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
        var resumeDiv = document.querySelector('#resume') || document.querySelector('body');
        if (!resumeDiv) return null;
        var text = (resumeDiv.textContent || '').replace(/\\s+/g, ' ').trim();
        var canvas = resumeDiv.querySelector('canvas');
        var cv = canvas ? { dataW: canvas.width, dataH: canvas.height, cssW: canvas.clientWidth, cssH: canvas.clientHeight } : null;
        var nestedIframes = Array.from(resumeDiv.querySelectorAll('iframe')).map(function(f){ return (f.src || f.getAttribute('src') || '').slice(0, 100); });
        return {
          textLen: text.length,
          sample: text.slice(0, 60),
          canvas: cv,
          resumeClientH: resumeDiv.clientHeight,
          resumeScrollH: resumeDiv.scrollHeight,
          nestedIframes: nestedIframes,
          docReady: document.readyState
        };
      })()`);
      console.warn(`  ${label}🔍 DOM诊断: iframe内探测结果=${JSON.stringify(probe && probe.value ? probe.value : probe)}`);
      return probe && probe.value ? probe.value : null;
    } catch (e) {
      console.warn(`  ${label}🔍 DOM诊断: eval 异常: ${e.message}`);
      return null;
    }
  } catch (e) {
    console.warn(`  ${label}🔍 DOM诊断: 异常: ${e.message}`);
    return null;
  }
}

/**
 * 兜底：在 frame 树里逐个轮询 resume 相关 frame，直到某个 frame 内读到简历正文。
 * 解决两类情况：① 简历 iframe 里还套了一层更深的简历 iframe（前一层只匹配到外壳）；
 * ② iframe 内容加载慢，单次读取时正文还没渲染出来。总耗时最多约 6s。
 * @param {string} targetId
 * @param {string} preferredSrc 简历 iframe 的 src（用于优先排序）
 * @param {string} label 日志前缀
 * @returns {string|null} 简历文本（≥DOM_MIN_TEXT_LEN 字），找不到返回 null
 */
export async function probeFramesForResumeText(targetId, preferredSrc, label = 'DOM') {
  let framesResp = null;
  try { framesResp = await proxyGet(`/frames?target=${targetId}`); } catch {}
  if (!framesResp || !framesResp.frameTree) return null;

  const frames = [];
  (function walk(node, depth) {
    if (!node) return;
    if (node.frame && node.frame.id) frames.push({ id: node.frame.id, url: node.frame.url || '', depth });
    if (node.childFrames) node.childFrames.forEach((c) => walk(c, depth + 1));
  })(framesResp.frameTree);

  // 过滤 chrome-extension / 后台页；resume 相关 URL 优先
  const candidates = frames.filter((f) => f.id && !/^chrome-extension:/.test(f.url));
  const rank = (f) => {
    let r = 0;
    if (preferredSrc && f.url && f.url.indexOf(preferredSrc.split('?')[0]) === 0) r += 100;
    if (/c-resume|resume/.test(f.url)) r += 60;
    return r;
  };
  candidates.sort((a, b) => rank(b) - rank(a));

  const deadline = Date.now() + 6000;
  for (const f of candidates) {
    if (Date.now() > deadline) break;
    let ctx = null;
    try {
      const iw = await proxyGet(`/isolated-world?target=${targetId}&frame=${encodeURIComponent(f.id)}`);
      if (iw && iw.executionContextId) ctx = { id: iw.executionContextId };
    } catch {}
    if (!ctx) continue;
    while (Date.now() < deadline) {
      try {
        const r = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
          var resumeDiv = document.querySelector('#resume') || document.querySelector('.resume-content');
          if (!resumeDiv) {
            // 仅当该 frame 是简历类页面时才兜底 body，避免抓到整个候选列表的文本
            if (!/c-resume|resume/.test(location.href)) return null;
            resumeDiv = document.body;
          }
          var text = (resumeDiv.textContent || '').replace(/\\s+/g, ' ').trim();
          if (text.length > ${DOM_MIN_TEXT_LEN}) { if (/${COPY_JUNK_RE}/.test(text)) return null; return text; }
          // v1.3.32: 该 frame 若只是 canvas 图片简历（无文字），换下一个 frame 探测，别再空转 6s
          var cv = document.querySelector('canvas');
          if (cv && cv.width > 50 && cv.height > 50) {
            // v1.3.42: WASM 渲染简历复制不可行，直接标记放弃；旧版 canvas 走复制尝试
            if (/wasm-resume-container|zhipin-boss\\/wasm|wasm-resume/i.test(document.body.innerHTML || '')) return '__WASM_CANVAS_RESUME__';
            return '__CANVAS_RESUME__';
          }
          return null;
        })()`);
        if (r && r.value === '__WASM_CANVAS_RESUME__') {
          // v1.3.42: WASM canvas 简历 DOM 无文字、复制处理器不生成文本，放弃复制直接截图
          break;
        }
        if (r && r.value === '__CANVAS_RESUME__') {
          // v1.3.39: canvas 简历 DOM 无文字，尝试真实 Ctrl+C 复制提取
          const copied = await tryExtractResumeTextByTrustedCopy(targetId, ctx, label);
          if (copied) return copied;
          break;
        }
        if (r && r.value) {
          console.log(`  ✓ DOM提取简历文本 (${label} frame兜底, ${r.value.length} 字)`);
          return r.value;
        }
      } catch {}
      await sleep(400);
    }
  }
  return null;
}

/**
 * 真实复制提取简历正文（v1.3.39）。
 * 背景：用户手动 Ctrl+C 能复制到完整简历原文（含教育、工作、项目、技能），
 * 证明页面有 copy 处理器会在复制时生成简历全文。此前用「合成 ClipboardEvent」触发不到
 * （copy=0），最可能是处理器校验了 event.isTrusted —— 合成事件不被信任，真实按键才被信任。
 * 方案：在简历文档（含外层页面）装 bubble 监听器，跑在页面处理器之后；再用 CDP
 * Input.dispatchKeyEvent 发送真实 Ctrl+A + Ctrl+C（浏览器视为真人操作），页面处理器生成全文写入
 * clipboardData，监听器读进 window.__resumeCopy，全程不碰系统剪贴板。
 * v1.3.40 实测：点击能把焦点带进跨域简历 iframe、copy 事件能触发，但文字为 0 ——
 * 点击把全选清掉了，处理器因无选中内容放弃生成。v1.3.41 改为「点击 → 重新全选 → Ctrl+A+C」。
 * @param {string} targetId 页面 target id
 * @param {{id:number}} ctx  简历 iframe 的 isolated world 执行上下文
 * @param {string} label 日志前缀（区分页面）
 * @returns {Promise<string|null>}
 */
// 页面 script/style 噪音特征：检测到即视为非简历文本（v1.3.36 防把 JS 代码误当简历文字）
export const COPY_JUNK_RE = 'APM\\.init|import\\.meta\\.url|System\\.import|__vite_is_modern_browser|vite-legacy|createElement\\(\\s*["\']script';

// 模拟复制总开关（v1.4.4 新增）：界面「开启模拟复制」选项。
// 开启=DOM提取→模拟复制→截图OCR；关闭=DOM提取→截图OCR（不碰系统剪贴板）。
// 默认开启（向后兼容）；三个提取脚本 main() 都调用 parseArgs()，由 --enable-copy 参数统一设置。
let enableCopyFlag = true;
export function setEnableCopyFlag(v) { enableCopyFlag = !!v; }
export function getEnableCopyFlag() { return enableCopyFlag; }

// 读系统剪贴板文本（PowerShell 兜底通道：页面复制处理器把全文写进 OS 剪贴板，直接读它最贴近手动复制）
function readOsClipboard() {
  try {
    const out = execSync(
      'powershell -NoProfile -Command "$t = Get-Clipboard -Raw -ErrorAction SilentlyContinue; if ($t -ne $null) { [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($t)) }"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    if (!out || !out.trim()) return '';
    return Buffer.from(out.trim(), 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

// 写系统剪贴板（用 base64 避开引号/特殊字符问题）
function setOsClipboard(text) {
  try {
    const b64 = Buffer.from(String(text), 'utf8').toString('base64');
    execSync(
      `powershell -NoProfile -Command "Set-Clipboard -Value ([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')))"`,
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
  } catch (e) {}
}

// 保存原剪贴板，结束后恢复（尽量不打扰用户正在复制的文字）
let prevClipboard = null;
function saveOsClipboard() {
  prevClipboard = readOsClipboard();
}
function restoreOsClipboard() {
  if (prevClipboard === null) return;
  setOsClipboard(prevClipboard);
  prevClipboard = null;
}

// 读并清空两处 copy 捕获（iframe 内 + 外层页面），返回 { text, evCtx, evOuter }
async function readCopyHooks(targetId, ctx) {
  let text = '', evCtx = '', evOuter = '';
  try {
    const r = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var t = window.__resumeCopy || '';
      var inf = (window.__resumeCopyInfo || []).join(',');
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      return JSON.stringify({ t: t, inf: inf });
    })()`);
    if (r && r.value) {
      const o = JSON.parse(r.value);
      text = o.t; evCtx = o.inf;
    }
  } catch {}
  try {
    const r2 = await cdpEval(targetId, `(function(){
      var t = window.__resumeCopyOuter || '';
      var inf = (window.__resumeCopyOuterInfo || []).join(',');
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      return JSON.stringify({ t: t, inf: inf });
    })()`);
    if (r2) {
      const o = JSON.parse(r2);
      if (o.t && o.t.length > text.length) text = o.t;
      evOuter = o.inf || '';
    }
  } catch {}
  return { text, evCtx, evOuter };
}

export async function tryExtractResumeTextByTrustedCopy(targetId, ctx, label = 'DOM') {
  if (!ctx || !ctx.id) return null;
  if (!enableCopyFlag) { console.log(`  ${label}🔍 模拟复制已关闭（界面设置），跳过复制直接截图`); return null; } // v1.4.4

  // v1.3.42: Boss 新版简历用 wasm-resume-container 渲染成 canvas（<div id=resume><canvas id=resume></canvas></div>），
  // DOM 零文字，且复制处理器不会为自动化复制生成文本（实测 iframe事件[BODY:0]、剪贴板不变）。
  // 只要是 WASM canvas 简历就立即放弃复制、直接交给截图 OCR，省 ~10s/人；旧版 canvas / HTML 简历仍走复制尝试。
  try {
    const wasm = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var b = document.body;
      if (b && /wasm-resume-container|zhipin-boss\\/wasm|wasm-resume/i.test(b.innerHTML || '')) return true;
      var c = document.getElementById('resume');
      if (c && c.tagName === 'CANVAS') return true;
      if (document.querySelector('#resume canvas')) return true;
      return false;
    })()`);
    if (wasm && wasm.value === true) {
      // v1.3.43: WASM canvas 简历复制走系统剪贴板，改为模拟「手动拖拽滚动选中 + Ctrl+C」再从系统剪贴板读取
      const copied = await tryExtractCanvasResumeByDragCopy(targetId, label);
      if (copied) return copied;
      console.log(`  ${label}🔍 复制提取(真实): 简历为 WASM canvas 渲染（拖拽复制也未命中），放弃复制直接截图`);
      return null;
    }
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取(真实): WASM 探测失败 ${e.message}`);
  }

  // 0) 结构诊断：iframe 里到底有没有可选文字 / 隐藏文字层 / 纯 canvas。
  //    决定「复制处理器是因为选中为空放弃」还是「处理器在别处」。
  try {
    const diag = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var out = {};
      try {
        var body = document.body;
        out.bodyText = (body && body.textContent || '').replace(/\\s+/g,' ').trim().length;
        var resume = document.getElementById('resume');
        out.resumeText = resume ? (resume.textContent||'').replace(/\\s+/g,' ').trim().length : -1;
        out.resumeHtml = resume ? resume.innerHTML.length : -1;
        var cvs = document.querySelector('canvas');
        out.canvas = cvs ? cvs.width+'x'+cvs.height : 'none';
        var layers = [];
        var els = document.querySelectorAll('*');
        for (var i=0;i<els.length && layers.length<6;i++){
          var el = els[i];
          if (el.children.length) continue;
          var t = (el.textContent||'').trim();
          if (t.length > 8 && /[一-龥A-Za-z]/.test(t)) {
            var st = getComputedStyle(el);
            layers.push({tag:el.tagName, cls:String(el.className||'').slice(0,30), len:t.length, disp:st.display, pos:st.position});
          }
        }
        out.layers = layers;
        try {
          var sel = window.getSelection();
          var r = document.createRange();
          if (resume && (resume.textContent||'').trim().length > 0) { r.selectNodeContents(resume); sel.removeAllRanges(); sel.addRange(r); out.selResume = sel.toString().length; }
          sel.removeAllRanges();
          if (body) { r.selectNodeContents(body); sel.addRange(r); out.selBody = sel.toString().length; }
        } catch(e) { out.selErr = e.message; }
      } catch(e) { out.err = e.message; }
      return JSON.stringify(out);
    })()`);
    if (diag && diag.value) console.log(`  ${label}🔍 复制提取结构诊断(iframe): ${diag.value}`);
  } catch {}
  // 外层弹窗结构：简历正文会不会就藏在弹窗容器里
  try {
    const od = await cdpEval(targetId, `(function(){
      var d = document.querySelector('.dialog-wrap.active');
      if (!d) return 'no-dialog';
      var t = (d.textContent||'').replace(/\\s+/g,' ').trim();
      return JSON.stringify({ len: t.length, hasResumeMark: /工作经历|教育经历|项目经验|期望职位|技能|自我评价/.test(t), preview: t.slice(0,80) });
    })()`);
    if (od) console.log(`  ${label}🔍 复制提取结构诊断(外层): ${od}`);
  } catch {}

  // 1) 装监听（iframe 内 + 外层页面），记录每次 copy 事件的目标与文字长度
  try {
    await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      if (window.__resumeCopyHook) document.removeEventListener('copy', window.__resumeCopyHook, false);
      window.__resumeCopyHook = function(e){
        try {
          var tag = (e.target && e.target.tagName) || '?';
          var t = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
          window.__resumeCopyInfo.push(tag + ':' + (t ? t.length : 0));
          if (t.length > window.__resumeCopy.length) window.__resumeCopy = t;
        } catch (err) {}
      };
      document.addEventListener('copy', window.__resumeCopyHook, false);
      return true;
    })()`);
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取(真实): 装监听失败 ${e.message}`);
    return null;
  }
  try {
    await cdpEval(targetId, `(function(){
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      if (window.__resumeCopyOuterHook) document.removeEventListener('copy', window.__resumeCopyOuterHook, false);
      window.__resumeCopyOuterHook = function(e){
        try {
          var t = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
          window.__resumeCopyOuterInfo.push(((e.target && e.target.tagName) || '?') + ':' + (t ? t.length : 0));
          if (t.length > window.__resumeCopyOuter.length) window.__resumeCopyOuter = t;
        } catch (err) {}
      };
      document.addEventListener('copy', window.__resumeCopyOuterHook, false);
      return true;
    })()`);
  } catch {}

  saveOsClipboard();
  setOsClipboard('__BCT_COPY_SENTINEL__');

  const picks = []; // 各尝试的捕获结果

  // ===== 尝试 A：点 iframe → iframe 内智能全选 → Ctrl+A+C（v1.3.41 方案，改选 #resume） =====
  let resA = { tag: 'A:点iframe+选resume+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    const clickSel = '.boss-popup__content .resume-detail-wrap iframe, .dialog-wrap.active .resume-detail-wrap iframe, .boss-popup__content .resume-detail-wrap, .dialog-wrap.active .resume-detail-wrap';
    await proxyPost(`/clickAt?target=${targetId}`, clickSel);
    await sleep(200);
    const f = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? document.activeElement.tagName : 'none');
    })()`);
    resA.focus = (f && f.value) ? f.value : '';
    const s = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      try {
        window.focus();
        var sel = window.getSelection();
        var resume = document.getElementById('resume');
        var body = document.body;
        sel.removeAllRanges();
        var r = document.createRange();
        if (resume && (resume.textContent||'').trim().length > 0) r.selectNodeContents(resume);
        else if (body) r.selectNodeContents(body);
        sel.addRange(r);
        return sel.toString().length;
      } catch(e) { return -1; }
    })()`);
    resA.sel = (s && typeof s.value === 'number') ? s.value : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取A: ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resA.evCtx = r.evCtx; resA.evOuter = r.evOuter; resA.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取A: 按键失败 ${e.message}`);
  }
  picks.push(resA);

  // ===== 尝试 B：真实点击外层弹窗空白区（焦点留在外层页面），全选外层 → Ctrl+A+C =====
  // 假设：copy 处理器注册在外层弹窗文档。手动复制时焦点在外层页面；
  // 事件不跨文档冒泡，之前一直把焦点给 iframe，外层处理器从未被触发。
  let resB = { tag: 'B:点外层+全选+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    // 在外层页面弹窗左上角放一个临时透明元素，真实点击它把焦点交给外层页面（避免点到 iframe/按钮）
    await cdpEval(targetId, `(function(){
      var d = document.querySelector('.dialog-wrap.active');
      if (!d) return 'no-dialog';
      var r = d.getBoundingClientRect();
      var old = document.getElementById('__bct_outer_click__');
      if (old) old.remove();
      var btn = document.createElement('div');
      btn.id = '__bct_outer_click__';
      btn.style.cssText = 'position:fixed;left:' + (r.left + 12) + 'px;top:' + (r.top + 12) + 'px;width:24px;height:24px;z-index:999999;';
      document.body.appendChild(btn);
      return 'ok';
    })()`);
    await proxyPost(`/clickAt?target=${targetId}`, '#__bct_outer_click__');
    await sleep(200);
    await cdpEval(targetId, `(function(){ var e = document.getElementById('__bct_outer_click__'); if (e) e.remove(); return true; })()`);
    const b = await cdpEval(targetId, `(function(){
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? (document.activeElement.tagName + '.' + String(document.activeElement.className||'').slice(0,20)) : 'none');
    })()`);
    resB.focus = b || '';
    const s = await cdpEval(targetId, `(function(){
      var sel = window.getSelection();
      if (sel && document.body) { sel.removeAllRanges(); sel.selectAllChildren(document.body); return sel.toString().length; }
      return -1;
    })()`);
    resB.sel = typeof s === 'number' ? s : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取B: ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resB.evCtx = r.evCtx; resB.evOuter = r.evOuter; resB.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取B: 按键失败 ${e.message}`);
  }
  picks.push(resB);

  // ===== 尝试 C：仅 window.focus() 外层 + 全选外层 → Ctrl+A+C（对照：不点也看外层处理器是否触发） =====
  let resC = { tag: 'C:外层focus+全选+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    const b = await cdpEval(targetId, `(function(){
      window.focus();
      try { document.body.setAttribute('tabindex','-1'); document.body.focus(); } catch(e) {}
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? (document.activeElement.tagName + '.' + String(document.activeElement.className||'').slice(0,20)) : 'none');
    })()`);
    resC.focus = b || '';
    const s = await cdpEval(targetId, `(function(){
      var sel = window.getSelection();
      if (sel && document.body) { sel.removeAllRanges(); sel.selectAllChildren(document.body); return sel.toString().length; }
      return -1;
    })()`);
    resC.sel = typeof s === 'number' ? s : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取C: ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resC.evCtx = r.evCtx; resC.evOuter = r.evOuter; resC.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取C: 按键失败 ${e.message}`);
  }
  picks.push(resC);

  // 2) 系统剪贴板兜底：哨兵还在 = 都没写入；变了 = 某次尝试真的生成了全文
  const osClip = readOsClipboard();
  const osHit = !!osClip && osClip !== '__BCT_COPY_SENTINEL__';
  restoreOsClipboard();
  await cleanupTrustedCopy(targetId, ctx);

  for (const p of picks) {
    console.log(`  ${label}🔍 复制提取(真实)诊断 ${p.tag}: 焦点=${p.focus} 选中=${p.sel} iframe事件[${p.evCtx || ''}] 外层事件[${p.evOuter || ''}] 捕获=${p.text ? p.text.length : 0}字 剪贴板=${osHit ? osClip.length : '未变'}`);
  }

  // 3) 取最长有效文本（页面监听优先，剪贴板兜底）
  let best = null;
  for (const p of picks) {
    const t = (p.text || '').replace(/\s+/g, ' ').trim();
    if (t.length >= DOM_MIN_TEXT_LEN && !new RegExp(COPY_JUNK_RE, 'i').test(t)) {
      if (!best || t.length > best.length) best = t;
    }
  }
  if (osHit && (!best || osClip.length > best.length)) {
    const t = osClip.replace(/\s+/g, ' ').trim();
    if (t.length >= DOM_MIN_TEXT_LEN && !new RegExp(COPY_JUNK_RE, 'i').test(t)) best = t;
  }
  if (best) {
    console.log(`  ✓ 真实复制提取简历文本 (${label}, ${best.length} 字)`);
    return best;
  }
  return null;
}

// ---- v1.3.43: WASM canvas 简历「拖拽滚动复制」----
// Boss 新版简历是 canvas 绘制（DOM 零文字），复制走 navigator.clipboard.writeText（直接写系统剪贴板），
// 页面内截获 copy 事件永远读到 0 字（历史 iframe事件[BODY:0]）。等价用户手动操作的正确做法：
//   清空系统剪贴板 → 真实鼠标按住拖选 → 滚动简历容器到最底（选中扩展） → 真实 Ctrl+C → powershell 读剪贴板全文。
function clearSystemClipboard() {
  try {
    execSync('powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()"', { timeout: 10000, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    console.warn(`  ⚠ 清空系统剪贴板失败: ${e.message}`);
  }
}

function readSystemClipboard() {
  try {
    const ps = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '$t = Get-Clipboard -Raw',
      'if($t){ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)) }',
    ].join('; ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { timeout: 15000, encoding: 'utf8', stdio: 'pipe' });
    const b64 = (out || '').trim();
    if (!b64) return '';
    return Buffer.from(b64, 'base64').toString('utf8');
  } catch (e) {
    console.warn(`  ⚠ 读取系统剪贴板失败: ${e.message}`);
    return '';
  }
}

export async function tryExtractCanvasResumeByDragCopy(targetId, label = 'DOM') {
  if (!enableCopyFlag) { console.log(`  ${label}🔍 模拟复制已关闭（界面设置），跳过复制直接截图`); return null; }
  // 注意：不依赖 ctx —— /canvas-copy 端点自己在浏览器里穿透 find 主页面/recommendFrame/c-resume，
  // 只需要 targetId（页面会话）。端点每次会先重载 c-resume iframe（确定性全新状态），
  // 拖拽失败时重试一次即可拿到全新状态。
  try {
    // 0) 清空系统剪贴板（避免读到上一次/用户复制的旧内容）
    clearSystemClipboard();
    await sleep(500);

    // 1) 代理端点：重载+拖拽滚动选中+Ctrl+C（端点内自动计算 canvas 主视口坐标与滚动距离）
    const r = await proxyPost(`/canvas-copy?target=${targetId}`, '{}');
    if (!r) { console.log(`  ${label}🔍 canvas复制: 无响应`); return null; }
    if (r.error || !r.ok) { console.log(`  ${label}🔍 canvas复制: 拖拽复制失败 ${r.error || 'unknown'}`); return null; }

    // 2) 从系统剪贴板读取全文
    await sleep(300);
    const raw = readSystemClipboard();
    const text = (raw || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
    if (text.length >= DOM_MIN_TEXT_LEN && !new RegExp(COPY_JUNK_RE, 'i').test(text)) {
      const d1 = r.diag ? `, 容器SH/CH=${r.diag.outerSH}/${r.diag.outerCH}, iframe内=${r.diag.innerSH}/${r.diag.innerVH}` : '';
      console.log(`  ✓ 复制提取(canvas拖拽滚动): ${text.length} 字 (滚动 ${r.scrollMax}px, 容器 ${r.scrollSel || '?'}${d1})`);
      return text;
    }
    if (text.length > 0) console.log(`  ${label}🔍 canvas复制: 首次剪贴板 ${text.length} 字不可用，重试一次`);

    // 3) 重试一次（端点内部会再重载 iframe，刷新 Boss 渲染状态）
    clearSystemClipboard();
    await sleep(400);
    const r2 = await proxyPost(`/canvas-copy?target=${targetId}`, '{}');
    if (r2 && r2.ok && !r2.error) {
      await sleep(300);
      const raw2 = readSystemClipboard();
      const text2 = (raw2 || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
      if (text2.length >= DOM_MIN_TEXT_LEN && !new RegExp(COPY_JUNK_RE, 'i').test(text2)) {
        const d2 = r2.diag ? `, 容器SH/CH=${r2.diag.outerSH}/${r2.diag.outerCH}, iframe内=${r2.diag.innerSH}/${r2.diag.innerVH}` : '';
        console.log(`  ✓ 复制提取(canvas拖拽滚动, 重试): ${text2.length} 字 (滚动 ${r2.scrollMax}px, 容器 ${r2.scrollSel || '?'}${d2})`);
        return text2;
      }
    }
    console.log(`  ${label}🔍 canvas复制: 重试仍无有效文本，放弃走截图`);
    return null;
  } catch (e) {
    console.warn(`  ${label}🔍 canvas复制异常: ${e.message}`);
    return null;
  }
}

async function cleanupTrustedCopy(targetId, ctx) {
  try {
    await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      if (window.__resumeCopyHook) { document.removeEventListener('copy', window.__resumeCopyHook, false); window.__resumeCopyHook = null; }
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      return true;
    })()`);
  } catch {}
  try {
    await cdpEval(targetId, `(function(){
      if (window.__resumeCopyOuterHook) { document.removeEventListener('copy', window.__resumeCopyOuterHook, false); window.__resumeCopyOuterHook = null; }
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      return true;
    })()`);
  } catch {}
}

/**
 * 尝试直接从 DOM 提取简历文本，跳过截图+OCR 流程
 * v1.3.15: 文本过短（<DOM_MIN_TEXT_LEN）视为抓到弹窗壳而非简历正文，返回 null 降级走截图 OCR
 * v1.3.30: Chrome 151+ 移除了 Runtime.getExecutionContexts，/frames 的 executionContexts 为空，
 *          改用 Page.createIsolatedWorld 拿 iframe 执行上下文；内容可能加载慢，轮询等待正文出现。
 */
// DOM 提取文本最短阈值：低于此值视为抓到弹窗壳（头部固定文案等）而非简历正文
const DOM_MIN_TEXT_LEN = 200;
export async function tryExtractResumeTextFromDOM(targetId) {
  // 取简历 iframe 的 src
  let iframeSrc = '';
  try {
    iframeSrc = await cdpEval(targetId, `(function(){
      var detail = document.querySelector('.resume-detail');
      if (!detail) return '';
      var iframe = detail.querySelector('iframe');
      if (!iframe) return '';
      return iframe.src || iframe.getAttribute('src') || '';
    })()`);
  } catch (e) {
    console.warn(`  🔍 DOM提取诊断: 读取 iframe src 失败: ${e.message}`);
    return null;
  }
  if (!iframeSrc) return null; // 弹窗无 iframe，交给调用方走方式二/截图

  // 取 frame 树
  let framesResp = null;
  try {
    framesResp = await proxyGet(`/frames?target=${targetId}`);
  } catch (e) {
    console.warn(`  🔍 DOM提取诊断: /frames 请求失败: ${e.message}`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }
  if (!framesResp || !framesResp.frameTree) {
    console.warn(`  🔍 DOM提取诊断: /frames 未返回 frameTree`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }

  // 在 frame 树中匹配简历 iframe
  const targetFrame = findFrameInTree(framesResp.frameTree, iframeSrc);
  if (!targetFrame || !targetFrame.id) {
    console.warn(`  🔍 DOM提取诊断: frameTree 未匹配到 iframe src=${(iframeSrc || '').slice(0, 80)}`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }

  // Chrome 151+ 移除了 Runtime.getExecutionContexts，优先旧 context，拿不到则用 createIsolatedWorld
  let ctx = (framesResp.executionContexts || []).find(c => c.frameId === targetFrame.id) || null;
  if (!ctx) {
    try {
      const iw = await proxyGet(`/isolated-world?target=${targetId}&frame=${encodeURIComponent(targetFrame.id)}`);
      if (iw && iw.executionContextId) ctx = { id: iw.executionContextId };
      else console.warn(`  🔍 DOM提取诊断: createIsolatedWorld 未返回 contextId: ${JSON.stringify(iw)}`);
    } catch (e) {
      console.warn(`  🔍 DOM提取诊断: createIsolatedWorld 异常: ${e.message}`);
    }
  }
  if (!ctx) {
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }

  // 在 iframe 执行上下文中读取简历文本（内容可能加载慢，轮询最多约 5s）。
  // v1.3.32: 首次读取即探测 canvas —— 简历若是 canvas 图片渲染（DOM 无文字），
  //           立刻放弃 DOM 提取，避免空转轮询 5s 再降级截图。
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let result = null;
    try {
      result = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
        var resumeDiv = document.querySelector('#resume') || document.querySelector('body');
        if (!resumeDiv) return null;
        var text = (resumeDiv.textContent || '').replace(/\\s+/g, ' ').trim();
        if (text.length > ${DOM_MIN_TEXT_LEN}) return text;
        var cv = document.querySelector('canvas');
        if (cv && cv.width > 50 && cv.height > 50) {
          // v1.3.42: WASM 渲染简历复制不可行，直接放弃走截图；旧版 canvas 仍尝试复制
          if (/wasm-resume-container|zhipin-boss\\/wasm|wasm-resume/i.test(document.body.innerHTML || '')) return '__WASM_CANVAS_RESUME__';
          return '__CANVAS_RESUME__';
        }
        return null;
      })()`);
    } catch (e) {
      console.warn(`  🔍 DOM提取诊断: eval-context 异常: ${e.message}`);
      break;
    }
    if (result && result.value === '__WASM_CANVAS_RESUME__') {
      // v1.3.43: WASM canvas 简历改为模拟拖拽滚动复制 + 读系统剪贴板
      const copied = await tryExtractCanvasResumeByDragCopy(targetId, 'DOM');
      if (copied) return copied;
      console.log('  → 简历为 WASM 图片渲染（拖拽复制也未命中），跳过 DOM 提取直接截图');
      return null;
    }
    if (result && result.value === '__CANVAS_RESUME__') {
      // v1.3.39: canvas 简历 DOM 无文字，但页面有 copy 处理器会生成简历全文
      // （用户手动 Ctrl+C 能复制到完整简历）。发真实 Ctrl+C 触发它。
      const copied = await tryExtractResumeTextByTrustedCopy(targetId, ctx, 'DOM');
      if (copied) return copied;
      console.log('  → 简历为 canvas 图片渲染（真实复制也未命中），跳过 DOM 提取直接截图');
      return null;
    }
    if (result && result.value) {
      console.log(`  ✓ DOM提取简历文本 (iframe执行上下文, ${result.value.length} 字)`);
      return result.value;
    }
    await sleep(500);
  }
  // 兜底：简历可能在更深一层的 iframe 里，轮询所有 resume 相关 frame
  const deepText = await probeFramesForResumeText(targetId, iframeSrc);
  if (deepText) return deepText;
  // 有 context 但文本不足阈值：探测是否 canvas 图片简历
  console.warn(`  🔍 DOM提取诊断: 有 context 但文本不足 ${DOM_MIN_TEXT_LEN} 字，探测简历渲染方式`);
  await diagnoseResumeIframeDom(targetId, iframeSrc);
  return null;
}

/**
 * 从简历文本中解析教育经历条目（时间、学校、专业、学历）
 * Boss直聘 OCR 简历文本典型格式：教育经历X大学X专业X学历 YYYY-YYYY
 */
export function parseEducationFromResume(resumeText) {
  if (!resumeText || resumeText.length < 50) return [];
  const results = [];

  // OCR 常见学历关键词错字映射（本科→本秦、硕土→硕士等）
  const DEGREE_KEYS = ['博士', '硕士', '硕土', '本科', '本秦', '本幸', '大专', '中专', '高中', '学士', '研究生', '双学位'];
  const DEGREE_NORMALIZE = { '硕土': '硕士', '本秦': '本科', '本幸': '本科' };
  const TIME_RANGE_RE = /(\d{4})\s*[-–—~～]\s*(\d{4})/;
  const SCHOOL_RE = /([一-龥]{2,}(?:大学|学院|研究所|学校))/;

  const text = resumeText.replace(/[ \t]+/g, ' ').trim();

  // 定位教育经历段落
  const eduHeaders = ['教育经历', '教育背景', '学历背景', '教朋经历', '教肓经历', '教育情况'];
  let eduSection = '';
  for (const header of eduHeaders) {
    const idx = text.indexOf(header);
    if (idx < 0) continue;
    eduSection = text.substring(idx);
    break;
  }
  if (!eduSection) {
    for (const line of text.split('\n')) {
      const eduEntries = parseEduLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE);
      if (eduEntries) { for (const e of eduEntries) { if (e.time) results.push(e); } }
    }
    return dedupeEduResults(results);
  }

  // 截断到下一段落
  for (const m of ['工作经历', '工作经验']) {
    const i = eduSection.indexOf(m);
    if (i > 0) eduSection = eduSection.substring(0, i);
  }

  for (const rawLine of eduSection.split('\n')) {
    let line = rawLine.trim();
    if (!line || line.length < 5 || line.includes('推荐')) continue;
    for (const h of eduHeaders) {
      if (line.startsWith(h)) { line = line.slice(h.length).trim(); break; }
    }
    line = line.replace(/^[^一-龥]+/, '').trim();
    if (line.length < 4) continue;
    // DOM 提取的简历文本通常没有换行，整段教育经历（可能含主修课程/在校经历/社团经历等干扰内容）
    // 会连成一个超长行。parseEduLine 有 200 字上限，直接解析会整段被拒。
    // 这里先把超长行按「学校名」切成多个短窗口，每个窗口单独解析，避免漏掉多段教育。
    const linesToParse = line.length > 200
      ? splitEduLongLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE)
      : [line];
    for (const subLine of linesToParse) {
      const eduEntries = parseEduLine(subLine, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE);
      if (eduEntries) { for (const e of eduEntries) results.push(e); }
    }
  }

  // 全文本扫描补充
  const seenKeys = new Set(results.map(r => r.school.substring(0, 3) + '|' + r.degree));
  for (const extraLine of text.split('\n')) {
    const extraEntries = parseEduLine(extraLine.trim(), DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE);
    if (!extraEntries) continue;
    for (const extraEntry of extraEntries) {
      if (!extraEntry.time) continue;
      const key = extraEntry.school.substring(0, 3) + '|' + extraEntry.degree;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      results.push(extraEntry);
    }
  }

  return dedupeEduResults(results);
}

/**
 * 把超长无换行的教育经历段落切成多个短窗口，每个窗口以学校名为锚点。
 * DOM 提取文本形如：'XX大学工业工程硕士 2025-2027 211院校QS世界大学排名TOP500YY学院机械设计制造及其自动化本科 2017-2021'
 * 以每个学校名为起点，截取到下一个学校名（或段落尾）前，得到一个独立的候选教育条目。
 */
function splitEduLongLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE) {
  const globalRE = new RegExp(SCHOOL_RE.source, 'g');
  const anchors = [];
  let m;
  while ((m = globalRE.exec(line)) !== null) {
    const afterChar = line[m.index + m[0].length] || '';
    if (afterChar === '生') continue; // 'XX大学生/高中生/中学生' 是身份称谓或竞赛名，不是学校名
    // 过滤 'QS世界大学排名' 这类把"世界大学"当学校名的噪音：学校名前面紧邻 QS/排名 等标识
    const before = line.slice(Math.max(0, m.index - 8), m.index);
    // 只跳过「QS世界大学/排名」这类噪音锚点本身（其后的真实校名不受影响）。
    // 例：'QS世界大学排名TOP500XX师范大学' → '世界大学' 是噪音应跳过，
    // 但紧跟其后的 'XX师范大学' 前面是 '500' 数字，不算噪音，必须保留。
    if (/QS\s*(?:世界|亚洲|地区)?大学|世界大学排名|院校等级|院校级/.test(before + m[0])) continue;
    // 只保留「学校名后跟学历关键词 或 时间区间」的锚点
    const after = line.slice(m.index + m[0].length, m.index + m[0].length + 20);
    const hasDegreeAfter = DEGREE_KEYS.some(d => after.includes(d));
    const hasTimeAfter = TIME_RANGE_RE.test(after);
    if (!hasDegreeAfter && !hasTimeAfter) continue;
    // 贪婪匹配可能把校名前的主修课程/经历内容吞进来（如"文化活动与会展策划XX大学"），
    // 校名起点修正为串内最后一个「XX大学/学院」出现的位置，保证窗口从真实校名开始。
    const lastIdx = m[1].lastIndexOf(line.match(/[一-龥]{2,}(?:大学|学院)$/) ? m[1].match(/([一-龥]{2,}(?:大学|学院))$/)[1] : '');
    const schoolStart = m.index + m[0].length - m[1].length; // match 串起点
    const realStart = schoolStart + (m[1].match(/([一-龥]{2,}(?:大学|学院))$/) ? m[1].length - m[1].match(/([一-龥]{2,}(?:大学|学院))$/)[1].length : 0);
    // 切窗边界用所有「大学/学院/学校」匹配（含噪音如"世界大学"），保证窗口短小不粘连；
    // 噪音条目在 parseEduLine 内通过 QS/排名/无学历词时间 过滤掉。
    anchors.push({ start: m.index, len: m[0].length });
  }
  if (anchors.length === 0) return [line];

  const windows = [];
  let prevEnd = 0; // 前一锚点结束位置，避免窗口重叠把前一校名尾部残余带进来
  for (let i = 0; i < anchors.length; i++) {
    const start = Math.max(prevEnd, anchors[i].start - 20); // 学校名前留一点上下文，但不越过前一锚点
    // 末尾取：下一个学校名前，或本学校名 + 时间区间 + 一小段尾巴
    let end;
    if (i + 1 < anchors.length) {
      end = anchors[i + 1].start;
    } else {
      // 最后一个学校名：取到时间区间结束后约 30 字符（学历信息通常在时间区间附近）
      const seg = line.slice(anchors[i].start);
      const tm = seg.match(TIME_RANGE_RE);
      end = tm ? anchors[i].start + tm.index + tm[0].length + 30 : line.length;
    }
    const win = line.slice(start, end).trim();
    if (win.length > 4 && win.length <= 300) windows.push(win);
    prevEnd = end;
  }
  return windows;
}

function parseEduLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE) {
  const t = line.trim();
  if (!t || t.length < 5 || t.length > 200) return null;

  // 行内须含学历关键词；或（学校名 + 4位年份区间）。
  // OCR 教育条目常见 '学校 | 专业 YYYY - YYYY'，行内未必带学历词（学历在卡片/正文其他位置）。
  const hasDegree = DEGREE_KEYS.some(d => t.includes(d));
  if (!hasDegree) {
    if (!t.match(SCHOOL_RE)) return null;
    if (!TIME_RANGE_RE.test(t)) return null;
  }

  const cleanedLine = t.replace(/^(?:办|色|刺|RN|R |esy |h s |nme|[^一-龥])+/g, '');

  const eduPos = cleanedLine.indexOf('教育经历');
  const searchArea = eduPos >= 0 ? cleanedLine.substring(eduPos + 4) : cleanedLine;

  // 找行中所有学校名，每个学校名生成一条记录
  const globalRE = new RegExp(SCHOOL_RE.source, 'g');
  const NOISE_PREFIXES = ['佛', '岑', '志', '心', '办', '策划'];
  const noiseWords = ['荣誉', '奖学金', '优秀', '共建', '获荣', '一等', '二等', '院校'];
  const entries = [];
  let match;

  while ((match = globalRE.exec(searchArea)) !== null) {
    let schoolName = match[1];

    // 'XX大学生/高中生/中学生' 是身份称谓或竞赛名（如"广西高校大学生翻译大赛"），不是学校名
    const afterChar = searchArea[match.index + match[0].length] || '';
    if (afterChar === '生') continue;
    // 组织名后缀：'XX大学研究生会/学生会/校友会/团委' 是学生组织，不是学历教育。
    // '广西大学公共管理学院研究生会' → 校名后紧跟 '研究生会'，'研究生' 是组织名的一部分，不是学历词。
    const afterOrg = searchArea.slice(match.index + match[0].length, match.index + match[0].length + 4);
    if (/^(研究生会|学生会|校友会|团委|党支部|研究生处)/.test(afterOrg)) continue;

    // 'QS世界大学排名' 等把"世界大学/XX大学"当学校名的噪音：学校名前面紧邻 QS/排名 等标识
    // 只跳过噪音锚点本身（如 '世界大学'），不误杀紧跟其后的真实校名：
    // 'QS世界大学排名TOP500XX师范大学' 中 'XX师范大学' 前是 '500' 数字，不是噪音。
    const beforeSchool = searchArea.slice(Math.max(0, match.index - 8), match.index);
    if (/QS\s*(?:世界|亚洲|地区)?大学|世界大学排名|院校等级|院校级/.test(beforeSchool + schoolName)) continue;

    // 取学校名附近上下文
    const schoolIdx = searchArea.indexOf(schoolName);
    const contextStart = Math.max(0, schoolIdx - 30);
    const contextEnd = Math.min(searchArea.length, schoolIdx + schoolName.length + 60);
    const context = searchArea.substring(contextStart, contextEnd);

    // 学历关键词或年份区间必须紧贴学校名之后（20字符内）。
    // 真实教育条目形如 'XX大学工业工程硕士 2025-2027'/'YY大学美术学本科 2021-2025'，
    // 学历词和时间都在学校名紧后；而'曾任学校招生办学生代表，支持学校本科...'里"本科"距学校名很远，
    // 不该构成教育条目。
    const afterSchool = searchArea.slice(schoolIdx + schoolName.length, schoolIdx + schoolName.length + 20);
    const degree = DEGREE_KEYS.find(d => afterSchool.includes(d));
    // 时间区间可能在专业名之后较远处（如 '劳动与社会保障本科 2023 - 2027'），
    // 20字符截断会把年份尾部切掉（'2023 - 2'），导致 time 缺失。
    // 改为在 context（学校名后 60 字符）内找时间区间；degree 仍用紧邻 20 字符判断。
    const afterWide = searchArea.slice(schoolIdx + schoolName.length, Math.min(searchArea.length, schoolIdx + schoolName.length + 60));
    const tm = afterWide.match(TIME_RANGE_RE);
    // 无学历词且无紧邻时间区间的学校名不算教育条目（过滤社团/活动/经历里提到的学校名）
    if (!degree && !tm) continue;
    // '曾任学校招生办学生代表，支持学校本科...'里"曾任学校/支持学校"不是学校名。
    // 以"学校"结尾的校名（如"XX外国语学校"）合法，但若没有时间区间且degree靠"本科"等远距词，
    // 多为"支持学校本科招生"这类非教育表述，丢弃。
    if (/学校$/.test(schoolName) && !tm) continue;

    // OCR噪声前缀：'策划XX大学'→'XX大学'（主修课程内容"文化活动与会展策划"粘上了校名）
    for (const noise of NOISE_PREFIXES) {
      if (schoolName.startsWith(noise) && schoolName.length > 4) {
        const stripped = schoolName.slice(noise.length);
        if (stripped.length >= 4 && /^[一-龥]{2,}(?:大学|学院)$/.test(stripped)) {
          schoolName = stripped; break;
        }
      }
    }
    if (schoolName.length > 6) {
      // 贪婪匹配可能把校名前的描述性内容吞进来（如"文化活动与会展策划XX大学"、
      // "审计职业道德等YY工业大学"）。正常长校名（"XX农业大学"）不含这些噪音词，
      // 只在匹配串含噪音词时，取最后一个噪音词之后的合法校名子串。
      // 用 lastIndexOf 逐个噪音词取最靠后的结束位置，避免 matchAll 因「曾任/任职」等
      // 重叠词只匹配第一个、丢掉后面的真实校名。
      const NOISE_WORDS = ['策划','曾任','支持','荣誉','经历','课程','描述','职业道德','专业排名','主修','在校','任职','负责','参与','协助','主管','运营','从事','等','暨','期间','就读','就职',
        // 主修课程内容粘上校名的长词（'数据库原理与应用XX师范学院'→'XX师范学院'）。
        // 用长词避免误伤真实校名（如"XX农业大学"不含这些长词）。
        '数据库原理','机器学习','数据分析','数据挖掘','与应用','心理测评','与测评','原理','测评','统计学','测量','咨询','建模','管理科学','研究','人工智能',
        // 平台前缀标签（'新就业形态劳动者XX学院'→'XX学院'）
        '新就业形态劳动者'];
      let lastNoiseEnd = -1;
      for (const w of NOISE_WORDS) {
        const idx = schoolName.lastIndexOf(w);
        if (idx >= 0) lastNoiseEnd = Math.max(lastNoiseEnd, idx + w.length);
      }
      if (lastNoiseEnd >= 0) {
        // '文化活动与会展策划XX大学'→尾'XX大学'；剥掉开头连接字（于/在/就/等）：
        // '曾任职于YY理工大学'→'YY理工大学'
        let candidate = schoolName.slice(lastNoiseEnd).replace(/^[于在就其的等暨、]+/, '');
        // 只接受"2字以上汉字 + 大学/学院/学校/研究所"的合法校名，
        // 否则保留原值（防 'XX大学'→'X大学' 这种误剥）。
        if (/^[一-龥]{2,}(?:大学|学院|学校|研究所)$/.test(candidate)) schoolName = candidate;
      }
      // 无噪音词但超长：校名后粘了院系名（'XX农业大学经济管理学院'）。
      // 取「第一个大学」之后、以学院/学校/研究所结尾的段作院系后缀剥离，只留主校名。
      // 只剥后缀段 ≤12 字、且整串确以院系后缀收尾的（防误伤"大学附属中学"这类校名，
      // 中学不在后缀列表里，自然不剥；'数据库原理与应用XX师范学院' 已由 NOISE_WORDS 处理）。
      if (schoolName.length > 10) {
        const m = schoolName.match(/^(.+?大学)(?:[一-龥]{1,12}(?:学院|学校|研究所))$/);
        if (m && m[1].length >= 4) schoolName = m[1];
      }
    }
    // 'XX大学附属中学/附属高中' 是中学全名的一部分，不是专业：
    // 'XX大学附属中学高中' → SCHOOL_RE 只匹配到 'XX大学'，'附属中学' 会被误当专业。
    // 把紧贴校名后的 '附属+中学/学校' 续名并入校名（'附属' 前无空格才合并，防误伤真专业）。
    // 中间段用惰性匹配取最短（'附属中学高中' → 只并入 '附属中学'，不吃掉紧跟的学历词 '高中'）。
    const affix = afterSchool.match(/^附属[一-龥]{0,8}?(?:中学|初中|高中|学校)/);
    if (affix) schoolName += affix[0];
    if (noiseWords.some(w => schoolName.includes(w))) continue;

    let major = '';
    const sIdx = context.indexOf(schoolName);
    if (degree) {
      const dIdx = context.indexOf(degree);
      if (sIdx >= 0 && dIdx > sIdx) {
        let mt = context.substring(sIdx + schoolName.length, dIdx).trim();
        mt = mt.replace(/^[,，、|\s]+/, '').replace(/[,，、|\s]+$/, '').replace(/[“”"]/g, '');
        if (mt && mt.length < 60) major = mt;
      }
    } else if (tm) {
      // 无学历关键词：取学校名到时间区间之间的文本作为专业
      // 'XX大学 | 国际中文教育 2024 - 2027' → 国际中文教育
      const tIdx = context.indexOf(tm[0]);
      if (sIdx >= 0 && tIdx > sIdx) {
        let mt = context.substring(sIdx + schoolName.length, tIdx).trim();
        mt = mt.replace(/^[,，、|\s·]+/, '').replace(/[,，、|\s·….…]+$/, '').replace(/[“”"|]+/g, '').replace(/\.{2,}|…+/g, '');
        if (mt && mt.length < 60) major = mt;
      }
    }

    const normalizedDegree = degree ? (({ '硕土': '硕士', '本秦': '本科', '本幸': '本科' })[degree] || degree) : '';
    entries.push({ time: tm ? tm[0].trim() : '', school: schoolName, major, degree: normalizedDegree });
  }

  return entries.length > 0 ? entries : null;
}

function dedupeEduResults(results) {
  // OCR常见错字纠正
  const OCR_CORRECTIONS = [
    ['碑腕', ''], ['碑胺', ''], ['碑腐', ''], ['春学院', '科学院'],
    ['时学院', '科学院'], ['拼泓', '指挥'], ['州拼泓', '州指挥'],
    ['R 其', '及其'], ['R其', '及其'], ['友其', '及其'],
    ['基尿', '基层'], ['春南', '暨南'],
    ['咤昏', '暨'],
    ['万程', '工程'], ['万喜理万', '万隆理工'],
    ['深圭', '深圳'], ['研完生', '研究生'],
    ['北京理工学院', '北京理工大学'],
    ['万程', '工程'], ['万喜理万', '万隆理工'],
    ['深圭', '深圳'], ['研完生', '研究生'],
  ];
  for (const entry of results) {
    for (const [wrong, right] of OCR_CORRECTIONS) {
      if (entry.school) entry.school = entry.school.split(wrong).join(right);
      if (entry.major) entry.major = entry.major.split(wrong).join(right);
    }
    if (entry.school) entry.school = entry.school.replace(/^中国中国/, '中国科学院').trim();
  }

  const ORDER = {博士: 0, 硕士: 1, 本科: 2, 大专: 3, 中专: 4, 高中: 5};
  const final = [];
  for (const r of results) {
    let isDup = false;
    for (const existing of final) {
      if (existing.degree !== r.degree) continue;
      if (existing.school.includes(r.school) || r.school.includes(existing.school) || (existing.school.length >= 4 && r.school.length >= 4 && existing.school.substring(0,3) === r.school.substring(0,3))) {
        isDup = true;
        if (r.school.length < existing.school.length) {
          existing.school = r.school;
          if (r.time && !existing.time) existing.time = r.time;
          if (r.major && !existing.major) existing.major = r.major;
        }
        break;
      }
    }
    if (!isDup) final.push({ ...r });
  }
  final.sort((a, b) => (ORDER[a.degree] ?? 99) - (ORDER[b.degree] ?? 99));
  return final;
}

// ===== CLI 参数解析（通用） =====

export function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key === 'all' || key === 'resume' || key === 'attach') {
        opts[key] = true;
      } else {
        opts[key] = args[i + 1];
        i++;
      }
    }
  }

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
    opts.count = 10;
    opts.extractAll = false;
  }

  opts.output = opts.output || 'output/zhipin-candidates.json';

  // v1.4.4：模拟复制开关（界面「开启模拟复制」传入 --enable-copy 1/0，默认开启）
  opts.enableCopy = opts['enable-copy'] !== '0';
  enableCopyFlag = opts.enableCopy;
  return opts;
}
