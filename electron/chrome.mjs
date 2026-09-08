// electron/chrome.mjs — Chrome 检测/自动拉起、来源页打开、CDP proxy 生命周期。
import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import { resolve } from 'node:path';
import { app } from 'electron';
import { termLog, sleep, UNPACKED_ROOT, APP_ROOT } from './util.mjs';
import { setCdpProxyProcess, setCdpStatus, cdpStatus, CDP_ERR_REMOTE_DEBUG_OFF } from './state.mjs';

// ===== Chrome 启动助手 =====
// 曾用特殊启动参数（禁用窗口遮挡/后台冻结渲染）来实现「边用边跑」模式，
// 实测该模式对截图/复制并无帮助（同窗口切后台标签页依旧失效，开两个 Chrome 窗口才有效），
// 已整体移除——Chrome 照常由用户自己打开，这里只保留「未运行时自动拉起」的便利。
import { existsSync } from 'node:fs';

function findChromePath() {
  const candidates = [
    process.env.PROGRAMFILES && resolve(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && resolve(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    process.env.LOCALAPPDATA && resolve(process.env.LOCALAPPDATA, 'Chromium/Application/chrome.exe'),
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

function isChromeRunning() {
  return new Promise((resolveRun) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], (err, stdout) => {
      if (err) return resolveRun(false);
      resolveRun(/chrome\.exe/i.test(stdout));
    });
  });
}

// 三个提取来源的页面 URL（提取脚本内同源常量）
const RECOMMEND_PAGE_URL = 'https://www.zhipin.com/web/chat/recommend';
const SEARCH_PAGE_URL = 'https://www.zhipin.com/web/chat/search';
const CHAT_PAGE_URL = 'https://www.zhipin.com/web/chat/index';

// 提取脚本报「未找到已打开的XX页」时，按报错里的页名给出对应的操作提示并自动打开对应页。
// 页名关键词需与 scripts/extract-*.mjs 的报错文案保持一致。
const PAGE_NOT_OPEN_HINTS = [
  ['推荐牛人页', '推荐牛人'],
  ['搜索页', '搜索'],
  ['沟通页', '沟通'],
];

// 把「页面没开」的报错翻成一句操作提示。三个来源统一同一句式；
// 没匹配到已知页名时返回 null，调用方按原样报错处理、不自动开页。
function buildPageNotOpenMessage(errMessage) {
  const hit = PAGE_NOT_OPEN_HINTS.find(([kw]) => errMessage.includes(kw));
  if (!hit) return null;
  const [, label] = hit;
  return `请先在 Chrome 中打开 BOSS直聘「${label}」页，设置好筛选条件后，点击「重试」。`;
}

// 在 Chrome 里打开指定网址：Chrome 未运行时直接拉起该网址；已在运行时（Windows）会
// 复用它并在新标签页里打开。返回是否成功发起。
function openUrlInChrome(url) {
  const chromePath = findChromePath();
  if (!chromePath) return false;
  try {
    spawn(chromePath, [url], { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}

// 按提取来源返回要打开的 Boss 页面（v1.4.6：Chrome 未运行时自动打开对应页面）
function getSourcePageUrl(source) {
  if (source === 'search') return SEARCH_PAGE_URL;
  if (source === 'recommend' || source === 'recommend-attach') return RECOMMEND_PAGE_URL;
  return CHAT_PAGE_URL; // 沟通页
}

// CDP 代理版本号（需与 scripts/cdp-proxy.mjs 的 PROXY_VERSION 同步）。
// 版本不匹配时强制重启代理，保证运行的是最新代码（避免旧代理的截图守卫缺失问题）。
const CDP_PROXY_VERSION = '1.3.17';

// 启动 Chrome：未运行时直接拉起（可选带 URL 打开对应提取来源页）；已运行则无需处理。
// 被 IPC handler 和 runPipeline 共用。message 仅在失败(ok:false)时有意义：成功后渲染端
// 不再弹「Chrome 已启动」提示，由统一的「Chrome 未连接」检查接管。
async function launchChrome({ openUrl = null } = {}) {
  const chromePath = findChromePath();
  if (!chromePath) {
    return {
      ok: false,
      message: '没有在常见位置找到 Chrome。请照常打开 Chrome，按 README 第 1 步开启远程调试后使用。',
    };
  }
  if (await isChromeRunning()) {
    return { ok: true, launched: false };
  }
  const args = openUrl ? [openUrl] : [];
  spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();
  return { ok: true, launched: true };
}

// ===== CDP Proxy 自动启动 =====
function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 1500 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(null); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function startCdpProxy() {
  // 1. 检查 CDP proxy 是否已在运行
  try {
    const health = await httpGet('http://127.0.0.1:3456/health');
    if (health?.status === 'ok' && health.version !== CDP_PROXY_VERSION) {
      // 旧版本代理（可能缺少截图守卫等新代码）→ 不复用，请求它退出后重新 spawn
      termLog(`[cdp] 检测到旧版 CDP 代理 (version=${health.version})，请求退出以加载新代码...`);
      try { await httpGet('http://127.0.0.1:3456/shutdown'); } catch {}
      await sleep(1500);
    } else if (health?.status === 'ok') {
      setCdpProxyProcess(null);
      if (health.connected) {
        setCdpStatus({ state: 'connected', message: '' });
        termLog(`[cdp] 发现已有 CDP 代理, Chrome 已连接`);
      } else {
        // 尝试触发重连（旧代理可能只是没触发 connect）
        termLog(`[cdp] 发现已有 CDP 代理但 Chrome 未连接，尝试触发重连...`);
        try { await httpGet('http://127.0.0.1:3456/targets'); } catch {}
        await sleep(3000);
        const retry = await httpGet('http://127.0.0.1:3456/health');
        if (retry?.connected) {
          setCdpStatus({ state: 'connected', message: '' });
          termLog(`[cdp] Chrome 重连成功`);
        } else {
          setCdpStatus({ state: 'error', message: CDP_ERR_REMOTE_DEBUG_OFF });
          termLog(`[cdp] Chrome 仍未连接`);
        }
      }
      return;
    }
  } catch (e) {
    termLog(`[cdp] 端口 3456 无响应，将启动新代理 (${e.message})`);
  }

  // 2. Fork CDP proxy
  termLog('[cdp] 启动 CDP 代理...');
  setCdpStatus({ state: 'connecting', message: '正在启动 CDP 代理...' });

  const proxyPath = resolve(UNPACKED_ROOT, 'scripts', 'cdp-proxy.mjs');
  const proxy = spawn(process.execPath, [proxyPath], {
    cwd: app.isPackaged ? process.resourcesPath : APP_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CDP_PROXY_PORT: '3456', ELECTRON_RUN_AS_NODE: '1' },
  });
  setCdpProxyProcess(proxy);

  proxy.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      termLog(`[cdp-proxy] ${line}`);
    }
  });
  proxy.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      termLog(`[cdp-proxy stderr] ${line}`, 'stderr');
    }
  });
  proxy.on('error', (err) => {
    termLog(`[cdp] 代理进程错误: ${err.message}`, 'stderr');
  });
  proxy.on('exit', (code) => {
    termLog(`[cdp] 代理进程退出 (code=${code})`);
    setCdpProxyProcess(null);
    if (cdpStatus.state !== 'connected') {
      setCdpStatus({ state: 'error', message: 'CDP 代理意外退出' });
    }
  });

  // 3. 等待 HTTP 服务器就绪（最长 10 秒），同时检查 Chrome 连接
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const health = await httpGet('http://127.0.0.1:3456/health');
      if (health?.status === 'ok') {
        if (health.connected) {
          setCdpStatus({ state: 'connected', message: '' });
          termLog('[cdp] CDP 代理已就绪，Chrome 已连接');
        } else {
          // 新代理有 connectWithRetry，会在后台自动重连，这里先显示提示
          // 同时手动触发一次重连
          try { httpGet('http://127.0.0.1:3456/targets').catch(() => {}); } catch {}
          setCdpStatus({ state: 'error', message: CDP_ERR_REMOTE_DEBUG_OFF });
          termLog('[cdp] CDP 代理已就绪，Chrome 未连接（后台自动重试中）');
        }
        return;
      }
    } catch {}
  }

  setCdpStatus({ state: 'error', message: 'CDP 代理启动失败' });
  termLog('[cdp] CDP 代理启动失败', 'stderr');
}

export { isChromeRunning, launchChrome, openUrlInChrome, getSourcePageUrl, buildPageNotOpenMessage, startCdpProxy };
