/**
 * extract-common.mjs - 候选人提取公共模块（提取主流程用）
 *
 * 这里只留「简历弹窗操作 + 截图 OCR + DOM 探测 + 命令行参数」这些提取主流程直接调用的东西。
 * 更底层 / 更独立的几块已按职责拆出去，用到时直接从各自的文件 import：
 *   ./cdp-base.mjs       ← CDP 代理调用、eval、截图、标签页回前台（最底层，别处也用它）
 *   ./progress-store.mjs ← 扫描缓存与逐人进度、取消落盘、输出归档
 *   ./canvas-copy.mjs    ← 模拟复制（真实 Ctrl+C / 拖拽选中 → 系统剪贴板）
 *   ./resume-parse.mjs   ← 简历文本 → 教育 / 工作经历（纯函数）
 *
 * Usage:
 *   import { cdpEval, sleep } from './cdp-base.mjs';
 *   import { parseEducationFromResume } from './resume-parse.mjs';
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { proxyGet, proxyPost, cdpEval, cdpScreenshot, sleep, randomDelay } from './cdp-base.mjs';
import {
  COPY_JUNK_RE, DOM_MIN_TEXT_LEN,
  setEnableCopyFlag, tryExtractResumeTextByTrustedCopy, tryExtractCanvasResumeByDragCopy,
} from './canvas-copy.mjs';
import { setRunSource } from './progress-store.mjs';

/**
 * 本脚本是不是「被直接执行」的那个（而不是被别的模块 import 进来）。
 * 提取/打招呼/导出脚本都拿它守卫 main()：一旦被 import（哪怕只是加载），
 * 绝不能自动开跑 —— 那些脚本会真的去点浏览器、开简历弹窗、占用系统剪贴板。
 * 用法： if (isMainModule(import.meta.url)) { main().catch(...); }
 */
export function isMainModule(moduleUrl) {
  return !!process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(moduleUrl));
}

// ===== 暂停/继续 步骤1 提取 =====
// 主进程通过 stdin 发 'PAUSE' / 'RESUME'。约定：提取脚本里每个不设上限的循环都要在循环
// 开头 await waitWhilePaused()——列表扫描（每轮滚动前）和逐人提取（处理下一个候选人前）
// 两个阶段都能在「单元之间」暂停；漏加的循环在对应阶段点「暂停」会无效（历史 bug）。
// 暂停时进程不退出、不关 CDP、内存里已提取数据不丢；waitWhilePaused 是 await 轮询，
// 不阻塞事件循环——暂停期间 CANCEL/SIGTERM 监听依然即时响应（暂停中能取消/跳过）。
let _paused = false;
export function setPaused(p) { _paused = !!p; }
export async function waitWhilePaused() {
  while (_paused) await sleep(200);
}

/**
 * 安装主进程控制通道：stdin 上统一解析 CANCEL/PAUSE/RESUME，SIGTERM 同样走取消。
 * 三个提取脚本共用一份（避免各自维护相同的命令分发）；CANCEL 各脚本行为相同——
 * 先 doCleanup 落盘进度再退出，因此把 onCancel 作为参数传进来即可。
 */
export function installStdinControls(onCancel) {
  const cancelAndExit = () => (onCancel ? onCancel() : Promise.resolve()).finally(() => process.exit(1));
  process.stdin.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg === 'CANCEL') cancelAndExit();
    else if (msg === 'PAUSE') setPaused(true);
    else if (msg === 'RESUME') setPaused(false);
  });
  if (process.stdin && typeof process.stdin.unref === 'function') {
    process.stdin.unref();
  }
  process.on('SIGTERM', cancelAndExit);
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
            console.log(`    弹窗尺寸稳定： ${state.width}x${state.height}, iframe=${state.hasIframe}, resume=${state.hasResume}, canvas=${state.hasCanvas}，内容${contentReady ? '就绪' : '未就绪'}${sizeWarn}`);
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
      console.log(`    等待内容渲染…（第${retry + 1}次）`);
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
    console.log(`    弹窗区域： x=${clip.x}, y=${clip.y}, ${clip.width}x${clip.height} （source=${clip.source}${clip.detailWidth ? ', detailW=' + clip.detailWidth : ''}）`);
  }
  console.log(`    检测源： ${source || 'unknown'}${canvasSize ? ', Canvas: ' + canvasSize : ''}${info.heights ? ', ' + info.heights : ''}${info.debug ? ', debug: ' + info.debug : ''}`);
  console.log(`    简历高度： ${scrollHeight}px，可视： ${clientHeight}px，步进： ${step}px，需截 ${pages} 页`);

  let prevActualTop = -1;
  for (let page = 0; page < pages; page++) {
    const scrollTop = Math.min(page * step, scrollHeight - clientHeight);
    await scrollResume(targetId, scrollTop);

    const actualScrollTop = parseInt(await cdpEval(targetId, `document.querySelector('.resume-detail').scrollTop`)) || 0;
    console.log(`    第${page + 1}页： 目标=${scrollTop}，实际=${actualScrollTop}`);

    if (page > 0 && actualScrollTop <= prevActualTop) {
      console.log(`    ⚡ 已到达底部（滚动停滞在 ${actualScrollTop}），跳过剩余 ${pages - page} 页`);
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
        console.warn(`    ⚠ 截图第 ${page + 1}/${pages} 页失败（${retry + 1}/3）： ${e.message}`);
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

    // v1.9.10: 页间等待 100-300ms（三页截图节奏统一，仍保留防反爬节奏）
    if (page < pages - 1) await randomDelay(100, 300);
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
    console.log(`    OCR 第 ${i + 1}/${screenshots.length} 页…`);
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
      console.warn(`  ${label}🔍 DOM诊断： /frames 未返回 frameTree`);
      return null;
    }
    // 1) frame 匹配
    const targetFrame = findFrameInTree(framesResp.frameTree, nestedSrc);
    if (!targetFrame) {
      console.warn(`  ${label}🔍 DOM诊断： frameTree 未匹配到嵌套Src=${(nestedSrc || '').slice(0, 80)}`);
      (function dump(node, depth) {
        if (!node) return;
        const f = node.frame;
        if (f) console.warn(`  ${label}🔍 DOM诊断：   frame[${depth}] url=${(f.url || '').slice(0, 100)}`);
        if (node.childFrames) node.childFrames.forEach((c) => dump(c, depth + 1));
      })(framesResp.frameTree);
      return null;
    }
    console.warn(`  ${label}🔍 DOM诊断： 匹配到 frame id=${targetFrame.id} url=${(targetFrame.url || '').slice(0, 100)}`);
    // 2) createIsolatedWorld
    let ctx = null;
    try {
      const iw = await proxyGet(`/isolated-world?target=${targetId}&frame=${encodeURIComponent(targetFrame.id)}`);
      if (iw && iw.executionContextId) {
        ctx = { id: iw.executionContextId };
        console.warn(`  ${label}🔍 DOM诊断： createIsolatedWorld OK contextId=${iw.executionContextId}`);
      } else {
        console.warn(`  ${label}🔍 DOM诊断： createIsolatedWorld 失败： ${JSON.stringify(iw)}`);
        return null;
      }
    } catch (e) {
      console.warn(`  ${label}🔍 DOM诊断： createIsolatedWorld 异常： ${e.message}`);
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
      console.warn(`  ${label}🔍 DOM诊断： iframe内探测结果=${JSON.stringify(probe && probe.value ? probe.value : probe)}`);
      return probe && probe.value ? probe.value : null;
    } catch (e) {
      console.warn(`  ${label}🔍 DOM诊断： eval 异常： ${e.message}`);
      return null;
    }
  } catch (e) {
    console.warn(`  ${label}🔍 DOM诊断： 异常： ${e.message}`);
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
          console.log(`  ✓ DOM提取简历文本（${label} frame兜底，${r.value.length} 字）`);
          return r.value;
        }
      } catch {}
      await sleep(400);
    }
  }
  return null;
}

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
    console.warn(`  🔍 DOM提取诊断： 读取 iframe src 失败： ${e.message}`);
    return null;
  }
  if (!iframeSrc) return null; // 弹窗无 iframe，交给调用方走方式二/截图

  // 取 frame 树
  let framesResp = null;
  try {
    framesResp = await proxyGet(`/frames?target=${targetId}`);
  } catch (e) {
    console.warn(`  🔍 DOM提取诊断： /frames 请求失败： ${e.message}`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }
  if (!framesResp || !framesResp.frameTree) {
    console.warn(`  🔍 DOM提取诊断： /frames 未返回 frameTree`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }

  // 在 frame 树中匹配简历 iframe
  const targetFrame = findFrameInTree(framesResp.frameTree, iframeSrc);
  if (!targetFrame || !targetFrame.id) {
    console.warn(`  🔍 DOM提取诊断： frameTree 未匹配到 iframe src=${(iframeSrc || '').slice(0, 80)}`);
    await diagnoseResumeIframeDom(targetId, iframeSrc);
    return null;
  }

  // Chrome 151+ 移除了 Runtime.getExecutionContexts，优先旧 context，拿不到则用 createIsolatedWorld
  let ctx = (framesResp.executionContexts || []).find(c => c.frameId === targetFrame.id) || null;
  if (!ctx) {
    try {
      const iw = await proxyGet(`/isolated-world?target=${targetId}&frame=${encodeURIComponent(targetFrame.id)}`);
      if (iw && iw.executionContextId) ctx = { id: iw.executionContextId };
      else console.warn(`  🔍 DOM提取诊断： createIsolatedWorld 未返回 contextId： ${JSON.stringify(iw)}`);
    } catch (e) {
      console.warn(`  🔍 DOM提取诊断： createIsolatedWorld 异常： ${e.message}`);
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
      console.warn(`  🔍 DOM提取诊断： eval-context 异常： ${e.message}`);
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
      console.log(`  ✓ DOM提取简历文本（iframe执行上下文，${result.value.length} 字）`);
      return result.value;
    }
    await sleep(500);
  }
  // 兜底：简历可能在更深一层的 iframe 里，轮询所有 resume 相关 frame
  const deepText = await probeFramesForResumeText(targetId, iframeSrc);
  if (deepText) return deepText;
  // 有 context 但文本不足阈值：探测是否 canvas 图片简历
  console.warn(`  🔍 DOM提取诊断： 有 context 但文本不足 ${DOM_MIN_TEXT_LEN} 字，探测简历渲染方式`);
  await diagnoseResumeIframeDom(targetId, iframeSrc);
  return null;
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
  setEnableCopyFlag(opts.enableCopy);

  // 记录本子进程的真实来源（主进程传入 --source，如 recommend-attach / search / chat）
  if (opts.source) setRunSource(opts.source);
  return opts;
}

