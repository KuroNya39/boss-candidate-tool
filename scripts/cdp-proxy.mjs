#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常 Chrome
// 要求：Chrome 已开启 --remote-debugging-port
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
// 代理版本号：升级代理逻辑时递增。main.mjs 的 CDP_PROXY_VERSION 需同步。
// 版本不同 → 新实例会请求旧实例 /shutdown 退出后接管端口，保证 app 启动时运行的是最新代码。
const PROXY_VERSION = '1.3.17';
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const sessions = new Map(); // targetId -> sessionId

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// --- 自动发现 Chrome 调试端口 ---
async function discoverChromePort() {
  // 1. 尝试读 DevToolsActivePort 文件
  const possiblePaths = [];
  const platform = os.platform();

  if (platform === 'darwin') {
    const home = os.homedir();
    possiblePaths.push(
      path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
    );
  } else if (platform === 'linux') {
    const home = os.homedir();
    possiblePaths.push(
      path.join(home, '.config/google-chrome/DevToolsActivePort'),
      path.join(home, '.config/chromium/DevToolsActivePort'),
    );
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    possiblePaths.push(
      path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
      path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
    );
  }

  for (const p of possiblePaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8').trim();
      const lines = content.split('\n');
      const port = parseInt(lines[0]);
      if (port > 0 && port < 65536) {
        const ok = await checkPort(port);
        if (ok) {
          // 第二行是带 UUID 的 WebSocket 路径（如 /devtools/browser/xxx-xxx）
          // 非显式 --remote-debugging-port 启动时，Chrome 可能只接受此路径
          const wsPath = lines[1] || null;
          console.log(`[CDP Proxy] 从 DevToolsActivePort 发现端口: ${port}${wsPath ? ' (带 wsPath)' : ''}`);
          return { port, wsPath };
        }
      }
    } catch { /* 文件不存在，继续 */ }
  }

  // 2. 扫描常用端口
  const commonPorts = [9222, 9229, 9333];
  for (const port of commonPorts) {
    const ok = await checkPort(port);
    if (ok) {
      console.log(`[CDP Proxy] 扫描发现 Chrome 调试端口: ${port}`);
      return { port, wsPath: null };
    }
  }

  return null;
}

// 用 TCP 探测端口是否监听——避免 WebSocket 连接触发 Chrome 安全弹窗
// （WebSocket 探测会被 Chrome 视为调试连接，弹出授权对话框）
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

function getWebSocketUrl(port, wsPath) {
  if (wsPath) return `ws://127.0.0.1:${port}${wsPath}`;
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// --- WebSocket 连接管理 ---
let chromePort = null;
let chromeWsPath = null;

let connectingPromise = null;
async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;
  if (connectingPromise) return connectingPromise;  // 复用进行中的连接

  if (!chromePort) {
    const discovered = await discoverChromePort();
    if (!discovered) {
      throw new Error(
        'Chrome 未开启远程调试端口。请用以下方式启动 Chrome：\n' +
        '  macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +
        '  Linux: google-chrome --remote-debugging-port=9222\n' +
        '  或在 chrome://flags 中搜索 "remote debugging" 并启用'
      );
    }
    chromePort = discovered.port;
    chromeWsPath = discovered.wsPath;
  }

  const wsUrl = getWebSocketUrl(chromePort, chromeWsPath);
  if (!wsUrl) throw new Error('无法获取 Chrome WebSocket URL');

  return connectingPromise = new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      connectingPromise = null;
      console.log(`[CDP Proxy] 已连接 Chrome (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      connectingPromise = null;
      ws = null;
      chromePort = null;
      chromeWsPath = null;
      const msg = e.message || e.error?.message || '连接失败';
      console.error('[CDP Proxy] 连接错误:', msg, '（端口缓存已清除，下次将重新发现）');
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      chromeWsPath = null;
      sessions.clear();
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }
      // session 失效时清理缓存，确保下次 ensureSession 重新 attach
      if (msg.method === 'Target.detachedFromTarget') {
        const { sessionId } = msg.params;
        for (const [tid, sid] of sessions) {
          if (sid === sessionId) sessions.delete(tid);
        }
      }
      // 拦截页面对 Chrome 调试端口的探测请求（反风控）
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, sessionId: sid } = msg.params;
        sendCDP('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

// 带自动重试的连接（每 5 秒重试一次）
async function connectWithRetry() {
  while (true) {
    try {
      await connect();
      return; // 连接成功
    } catch (e) {
      console.log(`[CDP Proxy] 连接 Chrome 失败，5 秒后重试: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

function sendCDP(method, params = {}, sessionId = null) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, 30000);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

// 已启用端口拦截的 session 集合（避免重复启用）
const portGuardedSessions = new Set();

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    const sid = resp.result.sessionId;
    sessions.set(targetId, sid);
    // 启用调试端口探测拦截
    await enablePortGuard(sid);
    return sid;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// 拦截页面对 Chrome 调试端口的探测（反风控）
// 只拦截 127.0.0.1:{chromePort} 的请求，不影响其他任何本地服务
async function enablePortGuard(sessionId) {
  if (!chromePort || portGuardedSessions.has(sessionId)) return;
  try {
    await sendCDP('Fetch.enable', {
      patterns: [
        { urlPattern: `http://127.0.0.1:${chromePort}/*`, requestStage: 'Request' },
        { urlPattern: `http://localhost:${chromePort}/*`, requestStage: 'Request' },
      ]
    }, sessionId);
    portGuardedSessions.add(sessionId);
  } catch { /* Fetch 域启用失败不影响主流程 */ }
}

// --- 等待页面加载 ---
async function waitForLoad(sessionId, timeoutMs = 15000) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }, sessionId);
        if (resp.result?.result?.value === 'complete') {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body ---
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接 Chrome
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({ status: 'ok', connected, sessions: sessions.size, chromePort, version: PROXY_VERSION }));
      return;
    }

    // /shutdown — 关闭 CDP 代理（用于新实例替换旧实例）
    if (pathname === '/shutdown') {
      res.end(JSON.stringify({ ok: true }));
      setTimeout(() => process.exit(0), 100);
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      const targets = resp.result.targetInfos;
      // all=1 返回全部类型（含 OOPIF iframe/worker，DOM 提取诊断用）；
      // 默认只返回 page 类型（保持兼容）
      const list = (q.all === '1') ? targets : targets.filter(t => t.type === 'page');
      res.end(JSON.stringify(list, null, 2));
    }

    // GET /new?url=xxx - 创建新后台 tab
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });
      const targetId = resp.result.targetId;

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      res.end(JSON.stringify(resp.result));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: q.url }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // GET /frames?target=xxx - 获取页面的 frame 树和所有执行上下文
    else if (pathname === '/frames') {
      const sid = await ensureSession(q.target);
      // Page.enable 必须在 getFrameTree 前调用
      try { await sendCDP('Page.enable', {}, sid); } catch {}
      const [frameTreeResp, contextsResp] = await Promise.all([
        sendCDP('Page.getFrameTree', {}, sid).catch(() => ({ result: null })),
        sendCDP('Runtime.getExecutionContexts', {}, sid).catch(() => ({ result: null })),
      ]);
      res.end(JSON.stringify({
        frameTree: frameTreeResp?.result?.frameTree || null,
        executionContexts: (contextsResp?.result?.contexts || []).map(ctx => ({
          id: ctx.id,
          frameId: ctx.auxData?.frameId || '',
          name: ctx.name || '',
          origin: ctx.origin || '',
        })),
      }));
    }

    // GET /isolated-world?target=xxx&frame=yyy - 为指定 frame 创建执行上下文
    // Chrome 151+ 移除了 Runtime.getExecutionContexts（/frames 里的 executionContexts 会一直为空），
    // DOM 提取改用 Page.createIsolatedWorld 按 frameId 拿 contextId，再配合 /eval-context 读简历文本。
    else if (pathname === '/isolated-world') {
      const sid = await ensureSession(q.target);
      const frameId = q.frame;
      if (!frameId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '缺少 frame 参数' }));
        return;
      }
      try { await sendCDP('Page.enable', {}, sid); } catch {}
      const worldName = 'resume_' + Math.random().toString(36).slice(2, 10);
      const resp = await sendCDP('Page.createIsolatedWorld', {
        frameId,
        worldName,
        grantUniversalAccess: true,
      }, sid);
      if (resp.result?.executionContextId !== undefined) {
        res.end(JSON.stringify({ executionContextId: resp.result.executionContextId }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.error?.message || 'createIsolatedWorld 失败' }));
      }
    }

    // POST /eval-context?target=xxx&context=123 - 在指定 execution context 中执行 JS
    else if (pathname === '/eval-context') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      const contextId = parseInt(q.context, 10);
      if (isNaN(contextId)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '缺少有效的 context 参数' }));
        return;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
        contextId,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // GET /isolated-world?target=xxx&frame=yyy - 为指定 frame 创建执行上下文
    // Chrome 151+ 移除了 Runtime.getExecutionContexts（/frames 里的 executionContexts 会一直为空），
    // DOM 提取改用 Page.createIsolatedWorld 按 frameId 拿 contextId，再配合 /eval-context 读简历文本。
    else if (pathname === '/isolated-world') {
      const sid = await ensureSession(q.target);
      const frameId = q.frame;
      if (!frameId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '缺少 frame 参数' }));
        return;
      }
      try { await sendCDP('Page.enable', {}, sid); } catch {}
      const worldName = 'resume_' + Math.random().toString(36).slice(2, 10);
      const resp = await sendCDP('Page.createIsolatedWorld', {
        frameId,
        worldName,
        grantUniversalAccess: true,
      }, sid);
      if (resp.result?.executionContextId !== undefined) {
        res.end(JSON.stringify({ executionContextId: resp.result.executionContextId }));
      } else {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.error?.message || 'createIsolatedWorld 失败' }));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /keyseq?target=xxx — 发送真实（trusted）按键序列，用于触发页面 copy 处理器
    // body: JSON { "keys": "ctrl+c" }；CDP Input 事件被浏览器视为真人按键，
    // 能通过 event.isTrusted 校验（合成 ClipboardEvent 做不到）。modifiers: Alt=1 Ctrl=2 Meta=4 Shift=8
    else if (pathname === '/keyseq') {
      const sid = await ensureSession(q.target);
      let body = {};
      try { body = JSON.parse(await readBody(req) || '{}'); } catch {}
      const CTRL = 2;
      const SEQ = {
        // 先全选再复制：部分简历页的 copy 处理器要求「有选中内容」才生成全文（手动 Ctrl+A→Ctrl+C 才能复制全简历）
        'ctrl+a+c': [
          { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 },
          { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: CTRL },
          { type: 'char', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: CTRL },
          { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers: CTRL },
          { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'char', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: CTRL },
        ],
        'ctrl+c': [
          { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 },
          { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'char', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL },
          { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: CTRL },
        ],
      };
      const events = SEQ[body.keys] || [];
      if (!events.length) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '不支持的按键序列: ' + body.keys }));
        return;
      }
      for (const ev of events) {
        await sendCDP('Input.dispatchKeyEvent', ev, sid);
      }
      res.end(JSON.stringify({ sent: events.length }));
    }

    // POST /canvas-copy?target=xxx — WASM canvas 简历拖拽滚动复制（模拟用户手动操作）
    // Boss 新版简历是 canvas 绘制（DOM 零文字），复制走 navigator.clipboard.writeText（系统剪贴板），
    // 页面内截获 copy 事件永远拿不到文本。正确做法：真实鼠标按住拖选 + 滚动简历容器 + 真实 Ctrl+C，
    // 文本进入系统剪贴板，由调用方用系统命令（powershell Get-Clipboard）读取。
    // 端点封装完整流程：计算 canvas 主视口坐标 → mousedown 顶部 → 拖到屏底 → 滚动容器到底 → mouseup → Ctrl+C。
    else if (pathname === '/canvas-copy') {
      const sid = await ensureSession(q.target);
      const sleepMs = ms => new Promise(r => setTimeout(r, ms));
      // 0) 轻量归零：canvas translateY 由 Boss 内部状态驱动，直接改滚动容器 scrollTop 同步不稳定
      //    （连续调用时 DOM scrollTop 归零但 canvas 停在底部 → 卡死态，滚轮也救不回）。普通情况（新弹窗）这样够用。
      //    滚动容器各页面不同：推荐/搜索页=.resume-detail-wrap，沟通页=.resume-detail；
      //    优先用 info 阶段缓存的 window.__resumeScrollEl，拿不到再按容器名找。
      const resetJs = `(function(){
        function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
        var rf = firstByName(document,'recommendFrame');
        var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
        var wrap = window.__resumeScrollEl || rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
        var out = '';
        if (wrap) { wrap.style.scrollBehavior = 'auto'; wrap.scrollTop = 0; out += 'outer:ok;'; }
        var f = window.__resumeIframe;
        if (f) {
          try {
            var idoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
            if (idoc && idoc.documentElement) { idoc.documentElement.scrollTop = 0; out += 'inner:ok;'; }
          } catch(e) {}
        }
        return out || 'no-wrap';
      })()`;
      // 卡死恢复：重载 c-resume iframe → Boss 简历渲染器全新启动，canvas 必然回顶（translateY=0）
      const reloadJs = `(function(){
        function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
        var rf = firstByName(document,'recommendFrame');
        var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
        var wrap = rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
        var iframe = wrap ? wrap.querySelector('iframe') : null;
        if (!iframe) return 'no-iframe';
        iframe.src = iframe.src; return 'reloading';
      })()`;
      await sendCDP('Runtime.evaluate', { expression: resetJs, returnByValue: true }, sid);
      // 1) 主页面穿透（通用，推荐页/搜索页/沟通页都支持）：
      //    找简历弹窗容器（.resume-detail-wrap 或 .resume-detail）→ 其内简历 iframe → canvas；
      //    用 frameOffset 逐层累加 iframe 偏移到主视口坐标。
      //    滚动容器各页面不同（推荐/搜索页=.resume-detail-wrap，沟通页=.resume-detail），
      //    从简历 iframe 向上探测「真正可滚动」的祖先作为滚动容器，缓存到 window.__resumeScrollEl 供滚动阶段复用。
      const infoJs = `(function(){
        function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
        function frameOffset(el){
          var ox=0, oy=0, curWin = el.ownerDocument ? el.ownerDocument.defaultView : null;
          var guard = 0;
          while (curWin && curWin !== window && guard++ < 10) {
            var fe = curWin.frameElement;
            if (!fe) break;
            var r = fe.getBoundingClientRect();
            ox += r.x; oy += r.y;
            curWin = curWin.parent;
          }
          return { x: ox, y: oy };
        }
        function isScr(el){
          if (!el || el.nodeType !== 1) return null;
          if (el.scrollHeight <= el.clientHeight + 1) return null;
          var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
          var oy = cs ? (cs.overflowY || '') : '';
          // 需同时接受 hidden：Boss 弹窗滚动容器常为 overflow:hidden（隐藏滚动条，但 scrollTop 仍可滚）。
          // 只认 auto/scroll/overlay 会把沟通页的 .resume-detail 排除 → scrollMax=0 → 复制不全。
          if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || oy === 'hidden') return el;
          return null;
        }
        function findScrollEl(iframe, doc){
          var p = iframe.parentElement;
          while (p && p !== doc.documentElement && p !== doc.body) {
            var sc = isScr(p);
            if (sc) return sc;
            p = p.parentElement;
          }
          var w = isScr(doc.querySelector('.resume-detail-wrap'));
          if (w) return w;
          var d = isScr(doc.querySelector('.resume-detail'));
          if (d) return d;
          return iframe.parentElement;
        }
        var scopes = [];
        var rf = firstByName(document,'recommendFrame');
        if (rf && rf.contentDocument) scopes.push(rf.contentDocument);
        scopes.push(document);
        for (var s=0; s<scopes.length; s++) {
          var doc = scopes[s];
          var wrap = doc.querySelector('.resume-detail-wrap') || doc.querySelector('.resume-detail');
          if (!wrap) continue;
          var iframe = wrap.querySelector('iframe');
          if (!iframe) continue;
          var idoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
          if (!idoc) continue;
          var cv = idoc.querySelector('#resume canvas') || idoc.querySelector('#resume') || idoc.querySelector('canvas');
          if (!cv) continue;
          var cv2 = cv.tagName === 'CANVAS' ? cv : (cv.querySelector ? cv.querySelector('canvas') : null);
          if (!cv2 || cv2.width < 50 || cv2.height < 50) continue;
          var cr = cv2.getBoundingClientRect();
          var off = frameOffset(iframe);
          var sc = findScrollEl(iframe, doc);
          var outerMax = Math.max(0, sc.scrollHeight - sc.clientHeight);
          // iframe 内部滚动兜底：若外层容器不可滚（沟通页个别情况），简历可能改在 c-resume iframe 内部滚动
          var idocSH = 0, idocVH = 0, innerMax = 0;
          try {
            idocSH = (idoc.documentElement ? idoc.documentElement.scrollHeight : 0) || (idoc.body ? idoc.body.scrollHeight : 0);
            idocVH = (iframe.contentWindow && iframe.contentWindow.innerHeight) || (idoc.documentElement ? (idoc.documentElement.clientHeight || 0) : 0);
            if (idocSH > idocVH) innerMax = idocSH - idocVH;
          } catch(e) {}
          window.__resumeScrollEl = sc;
          window.__resumeIframe = iframe;
          window.__resumeOuterMax = outerMax;
          window.__resumeInnerMax = innerMax;
          var canvasMain = { x: Math.round(off.x + cr.x), y: Math.round(off.y + cr.y), w: Math.round(cr.width), h: Math.round(cr.height) };
          var scrollMax = Math.max(outerMax, innerMax);
          var scrollSel = (sc.className || sc.id || sc.tagName || '?');
          var diag = { outer: scrollSel, outerSH: sc.scrollHeight, outerCH: sc.clientHeight, innerSH: idocSH, innerVH: idocVH };
          return JSON.stringify({ canvasMain: canvasMain, scrollMax: scrollMax, scope: s, winH: window.innerHeight, scrollSel: scrollSel, diag: diag });
        }
        return JSON.stringify({ error: 'no-canvas-scope' });
      })()`;
      // 1.5) 轮询等待 canvas 回顶。先短轮询 ≤2s（新弹窗通常立即在顶）；若一直没回顶（卡死态）→ 重载 iframe 重建
      //      渲染状态（确定性回顶），再轮询 ≤8s。仍不归顶则报错走截图。
      const pollInfo = async (rounds, gapMs) => {
        let last = { info: null, canvasY: null };
        for (let i = 0; i < rounds; i++) {
          const pollResp = await sendCDP('Runtime.evaluate', { expression: infoJs, returnByValue: true }, sid);
          try { last.info = JSON.parse(pollResp.result?.result?.value); } catch { last.info = null; }
          if (last.info && last.info.canvasMain) {
            last.canvasY = last.info.canvasMain.y;
            if (last.canvasY < 120) break;
          }
          await sleepMs(gapMs);
        }
        return last;
      };
      let { info, canvasY } = await pollInfo(4, 500);
      if (info && !info.error && canvasY !== null && canvasY >= 120) {
        console.log(`[canvas-copy] canvas 未回顶(y=${canvasY})，重载 c-resume iframe 重建渲染状态`);
        await sendCDP('Runtime.evaluate', { expression: reloadJs, returnByValue: true }, sid);
        await sleepMs(500);
        await sendCDP('Runtime.evaluate', { expression: resetJs, returnByValue: true }, sid);
        ({ info, canvasY } = await pollInfo(16, 500));
      }
      if (!info || info.error || canvasY === null || canvasY >= 120) {
        res.end(JSON.stringify({ error: `canvas 未归顶或找不到 (y=${canvasY})` }));
        return;
      }
      const { canvasMain, scrollMax, scope } = info;
      if (!canvasMain || canvasMain.h < 100) { res.end(JSON.stringify({ error: 'canvas 不在简历弹窗内' })); return; }

      // 2) 拖拽选中：从简历顶部文字区按住，拖到当前屏底部（不超出视口）
      const X0 = canvasMain.x + Math.round(canvasMain.w * 0.4);
      const Y0 = canvasMain.y + 60;                       // 顶部文字（跳过头部留白，尽量抓首行）
      let Y1 = canvasMain.y + canvasMain.h - 30;          // 当前屏底部
      if (info.winH) Y1 = Math.min(Y1, info.winH - 40);   // 视口钳制
      if (Y1 <= Y0 + 40) Y1 = Y0 + 40;
      await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0, y: Y0 }, sid);
      await sleepMs(100);
      await sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: X0, y: Y0, button: 'left', clickCount: 1, buttons: 1 }, sid);
      await sleepMs(80);
      const dragSteps = 12;
      for (let i = 1; i <= dragSteps; i++) {
        await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0, y: Y0 + Math.round((Y1 - Y0) * i / dragSteps), button: 'left', buttons: 1 }, sid);
        await sleepMs(20);
      }
      await sleepMs(100);

      // 3) 按住滚动容器到底（Boss 选中基于文档坐标，滚动后选区持续扩展）
      //    window.__resumeScrollEl 由 info 阶段缓存（各页面滚动容器不同，统一用它）
      const stepH = Math.max(300, Math.round(canvasMain.h * 0.9));
      let scrolled = 0;
      while (scrolled < scrollMax) {
        scrolled = Math.min(scrolled + stepH, scrollMax);
        const scrollJs = `(function(){
          var sc = window.__resumeScrollEl;
          if (!sc) {
            function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
            var rf = firstByName(document,'recommendFrame');
            var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
            sc = rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
          }
          var t = ${scrolled}, out = '';
          if (sc) {
            var om = window.__resumeOuterMax || 0;
            if (om > 0) { sc.scrollTop = Math.min(t, om); out += 'o'; }
          }
          var f = window.__resumeIframe;
          var im = window.__resumeInnerMax || 0;
          if (f && im > 0) {
            try {
              var idoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
              if (idoc && idoc.documentElement) { idoc.documentElement.scrollTop = Math.min(t, im); out += 'i'; }
            } catch(e) {}
          }
          return out || 'no';
        })()`;
        await sendCDP('Runtime.evaluate', { expression: scrollJs, returnByValue: true }, sid);
        await sleepMs(200);   // 等 Boss 平滑滚动 + 重绘（v1.4.5: 350→200，选区基于文档坐标，同步扩展）
        await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0 + 30, y: Y1, button: 'left', buttons: 1 }, sid);
        await sleepMs(70);
      }

      // 3.5) 选区延伸到内容最底部：滚到底后最后一行（页脚「…任何第三方平台…存储」）贴近画布底边，
      //      之前 Y1 留了 30px 余量，会把末字漏选，这里把选区终点压到画布底（视口内钳制）。
      let YB = Y1;
      const yBottom = Math.min(canvasMain.y + canvasMain.h - 2, (info.winH || 900) - 2);
      if (yBottom > Y1 + 10) {
        YB = yBottom;
        const extSteps = 8;
        for (let i = 1; i <= extSteps; i++) {
          await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0 + 30, y: Y1 + Math.round((YB - Y1) * i / extSteps), button: 'left', buttons: 1 }, sid);
          await sleepMs(20);
        }
        await sleepMs(150);
      }

      // 4) 松开 + 真实 Ctrl+C → 全文进入系统剪贴板
      await sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X0 + 30, y: YB, button: 'left', clickCount: 1, buttons: 0 }, sid);
      await sleepMs(300);
      const CTRL = 2;
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL }, sid);
      await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 }, sid);
      await sleepMs(350);
      res.end(JSON.stringify({ ok: true, canvasMain, scrollMax, scrolled, scope, winH: info.winH, yBottom: (info.winH || 900) - 2, scrollSel: info.scrollSel, diag: info.diag }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // POST /wheel?target=xxx — 真实鼠标滚轮事件（触发虚拟滚动懒加载）
    // body: JSON { "deltaY": 300, "steps": 3 }
    // deltaY > 0 = 向下滚动, deltaY < 0 = 向上滚动
    // 自动查找滚动容器中心坐标，发送真实 wheel 事件（Boss直聘虚拟滚动只响应真实鼠标事件）
    else if (pathname === '/wheel') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      const deltaY = body.deltaY || -300;
      const deltaX = body.deltaX || 0;
      const steps = body.steps || 1;

      let x = body.x;
      let y = body.y;

      // 如果没提供坐标，自动计算 .geek-item 父滚动容器的中心
      if (x == null || y == null) {
        const coordJs = `(() => {
          var item = document.querySelector('.geek-item');
          if (!item) return JSON.stringify({ x: 400, y: 400 });
          var el = item.parentElement;
          while (el && el.clientHeight < 100) el = el.parentElement;
          var rect = el.getBoundingClientRect();
          return JSON.stringify({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        })()`;
        const coordResp = await sendCDP('Runtime.evaluate', {
          expression: coordJs, returnByValue: true, awaitPromise: true,
        }, sid);
        try {
          const coord = JSON.parse(coordResp.result?.result?.value || '{"x":400,"y":400}');
          x = coord.x;
          y = coord.y;
        } catch { x = 400; y = 400; }
      }

      // 分步发送 wheel 事件（更平滑，更接近真实用户操作）
      const stepDeltaY = deltaY / steps;
      for (let i = 0; i < steps; i++) {
        await sendCDP('Input.dispatchMouseWheelEvent', {
          x: Math.round(x), y: Math.round(y),
          deltaX, deltaY: stepDeltaY,
          modifier: 0,
        }, sid);
      }

      res.end(JSON.stringify({ ok: true, x: Math.round(x), y: Math.round(y), deltaY, steps }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    // 可选区域裁剪: &clip=x,y,w,h（设备像素坐标）
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      // 唤醒页面：Boss 标签页被用户切走后可能被 Chrome 冻结（节能/后台优化），
      // 在线简历 canvas 会停在上一次绘制的状态（甚至空白）。截图前强制解除冻结。
      try { await sendCDP('Page.setWebLifecycleState', { state: 'active' }, sid); } catch {}
      try { await sendCDP('Emulation.setFocusEmulationEnabled', { enabled: true }, sid); } catch {}
      const format = q.format || 'png';
      const ssParams = {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
        // 截取完整布局视口（含 emulate 虚拟视口），避免窗口最小化/塌缩时只截到实际窗口大小
        captureBeyondViewport: true,
      };
      // 支持区域截图: clip=x,y,width,height
      // scale=2 可放大截图画面提升 OCR 清晰度（只影响分辨率，不改页面布局/DPR）
      if (q.clip) {
        const parts = q.clip.split(',').map(Number);
        if (parts.length === 4 && parts.every(n => !isNaN(n))) {
          ssParams.clip = {
            x: parts[0], y: parts[1], width: parts[2], height: parts[3],
            scale: parseFloat(q.scale || '1') || 1,
          };
        }
      }
      let resp = await sendCDP('Page.captureScreenshot', ssParams, sid);
      // session 可能已失效（页面刷新/iframe 重载后旧 session 被销毁），或返回了
      // "既无 error 也无 result"的空响应（简历弹窗内跨域 OOPIF iframe 加载/销毁竞态）。
      // 两种情况都按失效 session 处理：删除后重新 attach，重试一次。
      if (resp.error || !resp?.result?.data) {
        sessions.delete(q.target);
        // v1.3.12: OOPIF iframe 加载/销毁竞态时稍等再重试，给 iframe 完成渲染的时间
        await new Promise(r => setTimeout(r, 200));
        try {
          const newSid = await ensureSession(q.target);
          resp = await sendCDP('Page.captureScreenshot', ssParams, newSid);
        } catch {
          res.end(JSON.stringify({ error: 'target not found' }));
          return;
        }
      }
      // 重试后仍无数据：返回干净错误（不再崩在 resp.result.data），
      // 客户端会走它现有的 3 次重试循环，期间 iframe 完成渲染即可成功
      if (resp.error || !resp?.result?.data) {
        res.end(JSON.stringify({ error: resp.error?.message || '截图失败：未返回图像数据' }));
        return;
      }
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /activate?target=xxx - 把标签页真实带到最前（前台才持续出帧）
    // 用户切到别的标签页后，即使解除了冻结/节能，隐藏页面的合成器也可能停止出帧，
    // Page.captureScreenshot 会一直收不到画面而卡到 CDP 超时（30s）。
    // Target.activateTarget 让标签页真实可见 → 合成恢复 → 截图稳定。
    // 副作用：提取期间 Boss 页会保持在最前（用户已接受「沟通页保持最前」）。
    else if (pathname === '/activate') {
      const resp = await sendCDP('Target.activateTarget', { targetId: q.target }, null);
      res.end(JSON.stringify({ ok: !resp.error, error: resp.error?.message }));
    }

    // GET /emulate?target=xxx&width=1440&height=900&scale=2 - 强制设置 tab 的 viewport
    // width/height 建议传入实际窗口尺寸（见 /window-size）；scale 为设备像素倍率（DPR），
    // 只影响截图分辨率不影响 CSS 布局，设 2 可让 OCR 截图清晰一倍
    else if (pathname === '/emulate') {
      const sid = await ensureSession(q.target);
      const width = parseInt(q.width || '1440');
      const height = parseInt(q.height || '900');
      const scale = parseFloat(q.scale || '1') || 1;
      const reset = q.reset === '1' || q.reset === 'true';
      if (reset) {
        await sendCDP('Emulation.clearDeviceMetricsOverride', {}, sid);
        res.end(JSON.stringify({ reset: true }));
      } else {
        await sendCDP('Emulation.setDeviceMetricsOverride', {
          width, height,
          deviceScaleFactor: scale,
          mobile: false,
        }, sid);
        res.end(JSON.stringify({ width, height, scale, applied: true }));
      }
    }

    // GET /window-size?target=xxx - 获取 Chrome 窗口实际尺寸（浏览器级命令）
    // 最小化时 getWindowBounds 仍保留恢复尺寸，可用于按实际窗口设置视口而不变形
    else if (pathname === '/window-size') {
      const winResp = await sendCDP('Browser.getWindowForTarget', { targetId: q.target }, null);
      if (winResp.error) {
        res.end(JSON.stringify({ error: winResp.error.message || 'Browser.getWindowForTarget failed' }));
        return;
      }
      const windowId = winResp.result?.windowId;
      if (!windowId) {
        res.end(JSON.stringify({ error: '未获取到 windowId' }));
        return;
      }
      const boundsResp = await sendCDP('Browser.getWindowBounds', { windowId }, null);
      if (boundsResp.error) {
        res.end(JSON.stringify({ error: boundsResp.error.message || 'Browser.getWindowBounds failed' }));
        return;
      }
      const bounds = boundsResp.result?.bounds || {};
      res.end(JSON.stringify({
        width: Math.max(bounds.width || 1440, 300),
        height: Math.max(bounds.height || 900, 300),
        windowState: bounds.windowState || 'normal',
      }));
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new?url=': 'GET - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/frames?target=': 'GET - 获取 frame 树和所有执行上下文',
          '/isolated-world?target=&frame=': 'GET - 用 Page.createIsolatedWorld 为 frame 创建执行上下文（Chrome 151+）',
          '/eval-context?target=&context=': 'POST body=JS表达式 - 在指定执行上下文执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/keyseq?target=': 'POST body=JSON - 发送真实按键序列（Ctrl+C 触发页面 copy 处理器）',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/wheel?target=': 'POST body=JSON - 真实鼠标滚轮事件',
          '/screenshot?target=&file=': 'GET - 截图',
          '/activate?target=': 'GET - 把标签页带到最前（截图前保证前台出帧）',
          '/emulate?target=&width=&height=&scale=': 'GET - 强制设置 viewport（scale=DPR 倍率；reset=1 清除）',
          '/window-size?target=': 'GET - 获取 Chrome 窗口实际尺寸',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    http.get(url, { timeout: timeoutMs }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

async function main() {
  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 端口被占：判断是否已有健康实例。版本相同 → 复用退出；版本不同 → 请求旧实例退出后接管。
    const health = await httpGetJson(`http://127.0.0.1:${PORT}/health`);
    if (health && health.status === 'ok') {
      if (health.version === PROXY_VERSION) {
        console.log(`[CDP Proxy] 已有同版本实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
      // 旧版本实例（可能还在跑旧代码，截图守卫缺失）→ 请求它退出，等端口释放后由本实例接管
      console.log(`[CDP Proxy] 检测到旧版本实例 (version=${health.version})，请求退出以加载新代码...`);
      await httpGetJson(`http://127.0.0.1:${PORT}/shutdown`);
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300));
        if (await checkPortAvailable(PORT)) break;
      }
      if (!(await checkPortAvailable(PORT))) {
        console.error(`[CDP Proxy] 旧实例退出失败，端口 ${PORT} 仍被占用`);
        process.exit(1);
      }
    } else {
      console.error(`[CDP Proxy] 端口 ${PORT} 已被占用（非本代理）`);
      process.exit(1);
    }
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}（version=${PROXY_VERSION}）`);
    // 启动时尝试连接 Chrome，失败后自动重试
    connectWithRetry();
  });
}

// 防止未捕获异常导致进程崩溃
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常:', e.message);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
});

main();
