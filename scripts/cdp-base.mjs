// scripts/cdp-base.mjs — 跟 cdp-proxy 说话的最底层封装（不依赖本目录其他模块）
// 只做三件事：HTTP 调用、在页面里 eval、截图前把标签页带回前台。
// 提取 / 模拟复制 / 打招呼都从这里取，别各模块各抄一份。
//
// 唯一出口是 cdp-proxy（HTTP 3456 → WebSocket → Chrome DevTools），本模块不直接连 Chrome。
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';

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

export function proxyPost(path, data, timeoutMs = 60000) {
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
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

// 复制/截图前确保 Boss 标签页在前台（与 cdpScreenshot 同款条件式守卫，v1.8.3）：
// 真实鼠标拖选 + Ctrl+C 复制需要页面在前台才能把全文写进系统剪贴板。用户切走标签页后，
// 后台页被 Chrome 冻结/降速——复制要么干等 60s 客户端超时，要么只复制出几十个字判失败重试。
// 只有真被切走（隐藏）才 /activate 拉回最前；Boss 页本就在最前（如「开两个 Chrome 窗口」）
// 时零开销、不抢焦点。拿不到可见状态时保守回退为照常 activate（同 cdpScreenshot 口径）。
export async function ensureTabActive(targetId) {
  try {
    if (!(await isTabVisible(targetId))) {
      try { await proxyGet(`/activate?target=${targetId}`); return true; } catch { return false; }
    }
    return false;
  } catch { return false; }
}

export async function cdpScreenshot(targetId, filePath, clip) {
  // 截图前按需把标签页真实带到最前（Target.activateTarget，ensureTabActive）。
  // 用户切到别的标签页后，隐藏页面的合成器可能停止出帧，Page.captureScreenshot
  // 会卡到 CDP 超时（之前实测 30s 超时、截图失败）。activate 让页面前台出帧 → 截图稳定。
  // v1.3.28：Boss 页本来就在最前（如「开两个 Chrome 窗口」）时不再强制拉回，不抢用户焦点；
  // 只有真的被切走（隐藏）时才激活。拿不到可见状态时保守处理：照旧 activate 保证截图稳定。
  await ensureTabActive(targetId);
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
    throw new Error(`截图文件未保存： ${filePath}, proxy响应： ${JSON.stringify(result)}`);
  }
  const stat = readFileSync(filePath);
  if (stat.length === 0) {
    throw new Error(`截图文件为空： ${filePath}`);
  }
  return result;
}
