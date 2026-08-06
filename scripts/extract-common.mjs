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

// 按 Chrome 实际窗口尺寸设置视口（DPR=2 提升 OCR 截图清晰度）。
// 正常窗口下用实际尺寸 → 网页不变形；最小化时 /window-size 仍返回恢复尺寸 → 锁住布局防塌缩。
// 失败时回退 1440x900。
export async function forceViewport(targetId) {
  let width = 1440, height = 900;
  try {
    const ws = await proxyGet(`/window-size?target=${targetId}`);
    if (ws && !ws.error && ws.width && ws.height) {
      width = ws.width;
      height = ws.height;
    }
  } catch {}
  try {
    const r = await proxyGet(`/emulate?target=${targetId}&width=${width}&height=${height}&scale=2`);
    console.log(`已设置视口 ${width}x${height}（scale=2，兼容最小化 + OCR 清晰度）`);
    return r;
  } catch (e) {
    console.warn(`设置视口失败（不影响运行）: ${e.message}`);
    return null;
  }
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

export async function cdpScreenshot(targetId, filePath, clip) {
  // v1.3.11: 改回 PNG 无损。JPEG q80 的块效应 + 色度抽样破坏中文细字边缘，
  // tesseract 二值化放大噪声；代价是文件更大、编码略慢，OCR 准确率优先。
  let url = `/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}&format=png`;
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

export async function closeBossPopup(targetId, popupSelector, label = '弹窗') {
  // 先尝试 Escape 键关闭（keydown + keyup 兼容 React 等框架）
  await cdpEval(targetId, `(function(){
    ['keydown','keyup'].forEach(function(type){
      document.dispatchEvent(new KeyboardEvent(type, {
        key: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true
      }));
    });
  })()`);
  await randomDelay(400, 800);

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
  await randomDelay(800, 1500);

  if (closed === 'not-exist') return true;

  const stillVisible = await cdpEval(targetId, `(function(){
    var popup = document.querySelector('${popupSelector}');
    if (popup && popup.offsetParent !== null) return 'still-visible';
    return 'closed';
  })()`);

  if (stillVisible === 'still-visible') {
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

export async function closeResumeDialog(targetId) {
  return closeBossPopup(targetId, '.resume-detail', '简历弹窗');
}

// ===== 简历截图 =====

export async function captureResumeScreenshots(targetId, safename, tempDir) {
  let info = await getResumeScrollInfo(targetId);
  if (info.error) throw new Error(info.error);

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
          await randomDelay(1200, 2000);
          await scrollResume(targetId, scrollTop);
          await sleep(500);
        }
      }
    }
    if (!success) {
      throw new Error(`截图第 ${page + 1}/${pages} 页多次失败`);
    }

    if (page < pages - 1) await randomDelay(300, 500);
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
    const { data: { text } } = await worker.recognize(screenshots[i]);
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
 * 尝试直接从 DOM 提取简历文本，跳过截图+OCR 流程
 */
export async function tryExtractResumeTextFromDOM(targetId) {
  try {
    const iframeSrc = await cdpEval(targetId, `(function(){
      var detail = document.querySelector('.resume-detail');
      if (!detail) return '';
      var iframe = detail.querySelector('iframe');
      if (!iframe) return '';
      return iframe.src || iframe.getAttribute('src') || '';
    })()`);
    if (!iframeSrc) return null;
    const framesResp = await proxyGet(`/frames?target=${targetId}`);
    if (!framesResp.frameTree) return null;
    let targetFrame = null;
    function findById(frames, url) {
      if (!frames) return null;
      if (frames.frame && frames.frame.url && url.includes(frames.frame.url)) return frames.frame;
      if (frames.childFrames) { for (const child of frames.childFrames) { const found = findById(child, url); if (found) return found; } }
      return null;
    }
    function findUrlContains(frames, url) {
      if (!frames) return null;
      if (frames.frame && frames.frame.url && frames.frame.url.includes(url)) return frames.frame;
      if (frames.childFrames) { for (const child of frames.childFrames) { const found = findUrlContains(child, url); if (found) return found; } }
      return null;
    }
    targetFrame = findById(framesResp.frameTree, iframeSrc);
    if (!targetFrame) targetFrame = findUrlContains(framesResp.frameTree, iframeSrc);
    if (!targetFrame || !targetFrame.id) return null;
    const contexts = framesResp.executionContexts || [];
    const ctx = contexts.find(c => c.frameId === targetFrame.id);
    if (!ctx) return null;
    const result = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var resumeDiv = document.querySelector('#resume') || document.querySelector('body');
      if (!resumeDiv) return null;
      var text = (resumeDiv.textContent || '').replace(/\\s+/g, ' ').trim();
      return text.length > 50 ? text : null;
    })()`);
    return result.value || null;
  } catch { return null; }
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
    const eduEntries = parseEduLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE);
    if (eduEntries) { for (const e of eduEntries) results.push(e); }
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

function parseEduLine(line, DEGREE_KEYS, TIME_RANGE_RE, SCHOOL_RE) {
  const t = line.trim();
  if (!t || t.length < 5 || t.length > 200) return null;

  // 整行必须至少包含一个学历关键词
  if (!DEGREE_KEYS.some(d => t.includes(d))) return null;

  const cleanedLine = t.replace(/^(?:办|色|刺|RN|R |esy |h s |nme|[^一-龥])+/g, '');

  const eduPos = cleanedLine.indexOf('教育经历');
  const searchArea = eduPos >= 0 ? cleanedLine.substring(eduPos + 4) : cleanedLine;

  // 找行中所有学校名，每个学校名生成一条记录
  const globalRE = new RegExp(SCHOOL_RE.source, 'g');
  const NOISE_PREFIXES = ['佛', '岑', '志', '心', '办'];
  const noiseWords = ['荣誉', '奖学金', '优秀', '共建', '获荣', '一等', '二等', '院校'];
  const entries = [];
  let match;

  while ((match = globalRE.exec(searchArea)) !== null) {
    let schoolName = match[1];

    // 取学校名附近上下文
    const schoolIdx = searchArea.indexOf(schoolName);
    const contextStart = Math.max(0, schoolIdx - 30);
    const contextEnd = Math.min(searchArea.length, schoolIdx + schoolName.length + 60);
    const context = searchArea.substring(contextStart, contextEnd);

    const degree = DEGREE_KEYS.find(d => context.includes(d));
    if (!degree) continue;

    const tm = context.match(TIME_RANGE_RE);

    // OCR噪声前缀
    for (const noise of NOISE_PREFIXES) {
      if (schoolName.startsWith(noise) && schoolName.length > 4) {
        const stripped = schoolName.slice(noise.length);
        if (stripped.length >= 4 && /^[一-龥]{2,}(?:大学|学院)$/.test(stripped)) {
          schoolName = stripped; break;
        }
      }
    }
    if (schoolName.length > 10) {
      let best = schoolName;
      for (let ci = 1; ci <= schoolName.length - 4; ci++) {
        const sub = schoolName.substring(ci);
        if (sub.length >= 4 && /^[一-龥]{4,}(?:大学|学院)$/.test(sub) && sub.length < best.length) best = sub;
      }
      if (best.length < schoolName.length) schoolName = best;
    }
    if (schoolName.length > 15) {
      const shorter = schoolName.match(/([一-龥]{2,}(?:大学|学院))/);
      if (shorter) schoolName = shorter[1];
      else continue;
    }
    if (noiseWords.some(w => schoolName.includes(w))) continue;

    let major = '';
    const dIdx = context.indexOf(degree);
    const sIdx = context.indexOf(schoolName);
    if (sIdx >= 0 && dIdx > sIdx) {
      let mt = context.substring(sIdx + schoolName.length, dIdx).trim();
      mt = mt.replace(/^[,，、\s]+/, '').replace(/[,，、\s]+$/, '').replace(/[“”"]/g, '');
      if (mt && mt.length < 60) major = mt;
    }

    const normalizedDegree = ({ '硕土': '硕士', '本秦': '本科', '本幸': '本科' })[degree] || degree;
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
  return opts;
}
