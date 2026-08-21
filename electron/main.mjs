import { app, BrowserWindow, ipcMain, shell, dialog, powerSaveBlocker } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmSync, appendFileSync } from 'node:fs';
import http from 'node:http';
import iconv from 'iconv-lite';
import { computeMatchScoreFromComment, parseMatchScoreFromComment, patchEducationDeductionComment } from './score-comment.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');

// 打包后 scripts/config/ocr-lang 在 asarUnpack 目录，子进程通过真实路径访问
const UNPACKED_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, 'app.asar.unpacked')
  : APP_ROOT;

function getDefaultOutputDir() {
  return app.isPackaged
    ? resolve(app.getPath('documents'), 'output')
    : resolve(APP_ROOT, 'output');
}

let OUTPUT_DIR = getDefaultOutputDir();
const CONFIG_DIR = resolve(app.getPath('userData'), 'web-access');
const CONFIG_PATH = resolve(CONFIG_DIR, 'api-config.json');
// 岗位描述统一存 userData（开发/打包一致）：重新安装/升级不丢，且各电脑独立。
// 旧的 config/jd-descriptions 已废弃（原始 JD 未处理格式），不再使用。
const JD_DIR = resolve(CONFIG_DIR, 'jd-descriptions');

// ===== 配置（持久化到 userData） =====
let apiConfig = {
  url: '', key: '', model: '',
  smtpHost: 'smtp.mxhichina.com', smtpPort: '25', smtpSecure: 'false',
  smtpUser: 'jenkins@allwinnertech.com', smtpPass: '', smtpFrom: '',
  emailPrefix: '', outputDir: '',
  dimensions: '',    // 3个核心评估维度及权重（JSON字符串）
  screeningCriteria: '', // 任职资格关键筛选项（换行分隔）
};

function loadApiConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      if (saved.url && saved.key && saved.model) {
        // 合并保存的字段，保留默认值补全缺失字段
        apiConfig = { ...apiConfig, ...saved };
        termLog(`[config] 已加载持久化配置: url=${saved.url}, model=${saved.model}`);
      }
      // outputDir 独立于 API 配置加载
      if (saved.outputDir) {
        OUTPUT_DIR = resolve(saved.outputDir, 'output');
        termLog(`[config] 输出目录: ${OUTPUT_DIR}`);
      }
    }
  } catch (err) {
    termLog(`[config] 加载持久化配置失败: ${err.message}`, 'stderr');
  }
}

function saveApiConfig(config) {
  try {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    termLog(`[config] 配置已保存到 ${CONFIG_PATH}`);
  } catch (err) {
    termLog(`[config] 保存配置失败: ${err.message}`, 'stderr');
  }
}

// ===== 终端日志 GBK 编码 =====
// 所有日志（含子脚本 stdout/stderr）同时写入日志文件，方便排查
const LOG_DIR = resolve(app.getPath('userData'), 'web-access');
const LOG_PATH = resolve(LOG_DIR, 'app.log');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
function termLog(msg, stream = 'stdout') {
  try {
    const buf = iconv.encode(msg, 'gbk');
    if (stream === 'stderr') {
      process.stderr.write(buf);
      process.stderr.write('\n');
    } else {
      process.stdout.write(buf);
      process.stdout.write('\n');
    }
  } catch {
    if (stream === 'stderr') process.stderr.write(msg + '\n');
    else process.stdout.write(msg + '\n');
  }
  // 追加到日志文件（同步 append，量不大，不阻塞主流程）
  try { appendFileSync(LOG_PATH, msg + '\n'); } catch {}
}

function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'gbk');
  }
}

let mainWindow = null;
let currentProcess = null;
let cancelled = false;
let skipToScoring = false; // 跳过提取步骤，直接使用已提取的数据进行评分
let skipRecovered = false; // skip 恢复成功标记，用于跳过后续 sendProgress 覆盖
let aiAbortController = null; // 用于中断 AI 评分的正在请求
let actualExportPath = ''; // 导出脚本实际输出的文件路径（可能被另存）
let exportMailResult = { status: 'none', to: '', error: '' }; // 导出步骤的邮件发送结果（由 MAIL_OK/MAIL_FAIL 标记更新）

// CDP proxy & Chrome 状态
let cdpProxyProcess = null;
let cdpStatus = { state: 'initializing', message: '', chromePort: null };

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 660,
    height: 730,
    resizable: false,
    title: 'Boss直聘候选人AI评分助手',
    icon: resolve(UNPACKED_ROOT, 'app_icon_rounded.png'),
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.loadFile(resolve(__dirname, 'renderer', 'index.html'));
}

// ===== 进度推送 =====
function sendProgress(step, status, progress, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress-update', { step, status, progress, message });
  }
}

function sendDone(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('extraction-done', data);
  }
}

function sendError(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('extraction-error', data);
  }
}

// ===== 打招呼进度推送 =====
function sendGreetProgress(message, current, total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-progress', { message, current, total });
  }
}

function sendGreetDone(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-done', data);
  }
}

function sendGreetError(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-error', data);
  }
}

// ===== stdout 进度解析 =====
function parseExtractProgress(line) {
  if (line.includes('提取结果摘要')) return { progress: 100, message: '提取完成' };
  const personMatch = line.match(/\[(\d+)\/(\d+)\]/);
  if (personMatch) {
    return { progress: Math.round((parseInt(personMatch[1]) / parseInt(personMatch[2])) * 100), message: line.trim() };
  }
  // 其他日志行不显示到界面
  return { skip: true };
}

function parseExportProgress(line) {
  // 捕获实际输出的文件路径（可能是被另存的）
  const pathMatch = line.match(/导出成功:\s+(.+)/) || line.match(/另存为:\s+(.+)/);
  if (pathMatch) {
    actualExportPath = pathMatch[1].trim();
  }
  if (line.includes('导出成功')) return { progress: 100, message: line.trim() };
  if (line.includes('共导出')) return { progress: 90, message: line.trim() };
  // 邮件发送结果标记（不显示到进度条，只记录状态供完成页判断是否真发成功）
  const mailOkMatch = line.match(/^MAIL_OK:(.+)$/);
  if (mailOkMatch) {
    exportMailResult = { status: 'ok', to: mailOkMatch[1].trim(), error: '' };
    return { skip: true };
  }
  const mailFailMatch = line.match(/^MAIL_FAIL:(.+)$/);
  if (mailFailMatch) {
    exportMailResult = { status: 'fail', to: '', error: mailFailMatch[1].trim() };
    return { skip: true };
  }
  return null;
}

// ===== 脚本执行 =====
function runScript(scriptName, args, step, parseFn, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptPath = resolve(UNPACKED_ROOT, 'scripts', scriptName);
    const procCwd = app.isPackaged ? OUTPUT_DIR : APP_ROOT;

    termLog(`[main] start: scripts/${scriptName} ${args.join(' ')}`);
    sendProgress(step, 'running', 0, `启动 ${scriptName}...`);

    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd: procCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
    });

    currentProcess = proc;

    const stderrLines = [];

    proc.stdout.on('data', (data) => {
      const lines = decodeBuffer(data).split('\n').filter(Boolean);
      for (const line of lines) {
        termLog(`[${scriptName}] ${line}`);
        const parsed = parseFn ? parseFn(line) : null;
        if (parsed?.skip) {
          // 不显示到界面
        } else if (parsed) {
          sendProgress(step, 'running', parsed.progress, parsed.message);
        } else {
          sendProgress(step, 'running', null, line.trim());
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = decodeBuffer(data).trim();
      if (text) {
        // 过滤状态上报噪音：往公司内网统计服务器上报失败/成功是无关紧要的，
        // 不该混进致命错误消息吓到用户（如 "Stats report failed: ..."）
        const isStatsNoise = /^Stats report/.test(text);
        if (!isStatsNoise) {
          stderrLines.push(text);
          if (stderrLines.length > 20) stderrLines.shift();
          // 将 stderr 也回传给 UI，使用户能看到邮件错误等
          sendProgress(step, 'running', null, text);
        }
        termLog(`[${scriptName} stderr] ${text}`, 'stderr');
      }
    });

    proc.on('error', (err) => {
      currentProcess = null;
      rejectPromise(cancelled ? new Error('已取消') : err);
    });

    proc.on('close', (code) => {
      currentProcess = null;
      if (cancelled) rejectPromise(new Error('已取消'));
      else if (code !== 0) {
        const extra = stderrLines.length > 0 ? '\n' + stderrLines.join('\n') : '';
        rejectPromise(new Error(`${scriptName} 退出码 ${code}${extra}`));
      } else {
        sendProgress(step, 'done', 100, `${scriptName} 完成`);
        resolvePromise();
      }
    });
  });
}

// ===== AI 评分 =====

// 调 API（Anthropic 格式）
async function callClaudeAPI(prompt, { signal } = {}) {
  const url = `${apiConfig.url}/v1/messages`.replace(/\/+v1/, '/v1'); // 防双斜杠
  termLog(`[AI评分] 调 API: ${url}, model=${apiConfig.model}`);

  const res = await fetch(url, {
    signal, // 传递中止信号
    method: 'POST',
    headers: {
      'x-api-key': apiConfig.key,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: apiConfig.model,
      // v1.4.5: 8000 → 16000。deepseek 系列推理模型即使 thinking 禁用，代理仍会把思考
      // 作为 <antml-thinking> 文本块返回，占用大部分输出预算；预算不足时 JSON 答案被截断
      // → "解析失败"。加大预算保证完整答案落盘（代理实测支持 16000）。
      max_tokens: 16000,
      temperature: 0.3,
      // 禁用思考模式：模型在长 prompt 下思考会占用大量 token，
      // 把输出 JSON 挤掉导致"解析失败"。禁用后直接输出结果，更稳。
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${errText.slice(0, 500)}`);
  }

  const data = await res.json();

  // 尝试多种响应格式，获取纯文本内容
  let text = null;

  if (Array.isArray(data.content)) {
    // v1.4.5: 公司代理会把模型的「思考」包成 <antml-thinking> 文本块放在最前，
    // 真正的回答是后面的 text 块。之前只取第一个 text 块 = 拿到思考、丢掉回答 →
    // 系统性"解析失败(无有效JSON)"（2026-08-21 实测：content 为 [思考块, 答案块]）。
    // 改为：拼接所有块，剥掉 antml-thinking / thinking 思考块，让解析器在剩余文本里找 JSON。
    const blocks = data.content.map(c => c.thinking || c.text || '').filter(Boolean);
    if (blocks.length > 0) {
      text = blocks
        .join('\n')
        .replace(/<antml-thinking>[\s\S]*?<\/antml-thinking>/g, '')
        .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
        .trim();
    }
  }
  // 回退：取 content[0].text（旧格式）
  if (!text && data.content?.[0]?.text) {
    text = data.content[0].text;
  }
  // OpenAI Chat 格式: data.choices[0].message.content
  if (!text && data.choices?.[0]?.message?.content) {
    text = data.choices[0].message.content;
  }
  // 直接返回文本
  if (!text && typeof data === 'string') {
    text = data;
  }
  // data.response 字段
  if (!text && data.response) {
    text = typeof data.response === 'string' ? data.response : JSON.stringify(data.response);
  }
  // data.text 字段
  if (!text && data.text) {
    text = typeof data.text === 'string' ? data.text : JSON.stringify(data.text);
  }
  // data.message?.content
  if (!text && data.message?.content) {
    text = typeof data.message.content === 'string' ? data.message.content : data.message.content[0]?.text || JSON.stringify(data.message.content);
  }
  // data.data?.choices?.[0]?.message?.content
  if (!text && data.data?.choices?.[0]?.message?.content) {
    text = data.data.choices[0].message.content;
  }
  // 最后兜底: 直接JSON序列化搜索
  if (!text) {
    text = JSON.stringify(data);
  }

  if (!text) {
    termLog(`[AI评分] 完整返回: ${JSON.stringify(data).slice(0, 2000)}`, 'stderr');
    throw new Error(`API 返回内容为空，请检查 API 地址和格式`);
  }

  return text;
}

function parseSingleScoreResponse(text) {
    // 去掉 markdown 代码块包裹
    const cleanText = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
    if (!cleanText) return null;

    // 逐个尝试解析 {...} JSON 对象
    let searchPos = 0;
    while (true) {
      const start = cleanText.indexOf('{', searchPos);
      if (start === -1) break;

      let depth = 0;
      let end = -1;
      for (let i = start; i < cleanText.length; i++) {
        if (cleanText[i] === '{') depth++;
        else if (cleanText[i] === '}') depth--;
        if (depth === 0) { end = i; break; }
      }

      if (end > start) {
        try {
          const parsed = JSON.parse(cleanText.slice(start, end + 1));
          const score = parsed.score ?? parsed.jobRelevanceScore ?? null;
          const comment = parsed.comment ?? parsed.jobRelevanceComment ?? parsed.reason ?? null;
          if (typeof score === 'number' && typeof comment === 'string') {
            // 格式化评语：在章节标题前强制换行（与 export-candidates.mjs 的 formatComment 对齐当前模板）
            const formatted = comment
              .replace(/(匹配度评分|首句定性|任职资格的匹配情况|学历硬性门槛核查|综合结论|加权基础分计算|其他扣分合计)/g, '\n$1')
              .replace(/\n{3,}/g, '\n\n')
              .replace(/^\n+/, '')
              .trim();
            return { score, comment: formatted };
          }
          // 兼容只有分数的情况
          if (typeof score === 'number') {
            return { score, comment: comment || '(AI评分未生成评语)' };
          }
        } catch {}
      }
      searchPos = start + 1;
    }

    return null;
  }

/**
 * 解析批量评分返回的 JSON 数组 [{candidateIndex, score, comment}]
 * 兼容 markdown 代码块包裹和前后多余文本
 */
function parseBatchScoreResponse(text) {
  if (!text) return null;

  const cleanText = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '').trim();
  if (!cleanText) return null;

  // 逐个尝试解析 [...] JSON 数组
  let searchPos = 0;
  while (true) {
    const start = cleanText.indexOf('[', searchPos);
    if (start === -1) break;

    let depth = 0;
    let end = -1;
    for (let i = start; i < cleanText.length; i++) {
      if (cleanText[i] === '[') depth++;
      else if (cleanText[i] === ']') depth--;
      if (depth === 0) { end = i; break; }
    }

    if (end > start) {
      try {
        const parsed = JSON.parse(cleanText.slice(start, end + 1));
        if (Array.isArray(parsed) && parsed.length > 0) {
          const results = [];
          let valid = false;
          for (const item of parsed) {
            const idx = item?.candidateIndex ?? item?.index ?? null;
            const score = item?.score ?? item?.jobRelevanceScore ?? null;
            const comment = item?.comment ?? item?.jobRelevanceComment ?? item?.reason ?? null;
            if (typeof idx === 'number' && typeof score === 'number' && typeof comment === 'string') {
              // 格式化评语：在章节标题前强制换行（与 export-candidates.mjs 的 formatComment 对齐当前模板）
              const formatted = comment
                .replace(/(匹配度评分|首句定性|任职资格的匹配情况|学历硬性门槛核查|综合结论|加权基础分计算|其他扣分合计)/g, '\n$1')
                .replace(/\n{3,}/g, '\n\n')
                .replace(/^\n+/, '')
                .trim();
              results.push({ candidateIndex: idx, score, comment: formatted });
              valid = true;
            } else {
              results.push({ candidateIndex: idx ?? -1, score: score ?? 0, comment: comment ?? '(AI评分未生成评语)' });
            }
          }
          if (valid) return results;
        }
      } catch {}
    }
    searchPos = start + 1;
  }

  return null;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ===== "边用边跑"模式：带参数启动 Chrome =====
// Windows 会在 Chrome 窗口被完全盖住/最小化时暂停渲染（遮挡检测），
// 导致 CDP 截图拿到空白帧。以下参数可关闭该行为，让用户边用电脑边跑。

const BOSS_MODE_CHROME_FLAGS = [
  // v1.3.24: 同时关闭节能模式/后台标签页冻结/唤醒节流——
  // 否则用户切到别的标签页后 Boss 标签页被 Chrome 冻结，简历 canvas 停止绘制导致截图空白
  '--disable-features=CalculateNativeWinOcclusion,EnergySaver,BackgroundTabFreeze,IntensiveWakeUpThrottling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
];

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

function killChrome() {
  return new Promise((resolveKill) => {
    execFile('taskkill', ['/IM', 'chrome.exe'], () => resolveKill(true));
  });
}

function waitChromeExit(timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolveWait) => {
    const poll = async () => {
      const running = await isChromeRunning();
      if (!running || Date.now() - start > timeoutMs) return resolveWait(!running);
      setTimeout(poll, 300);
    };
    poll();
  });
}

// 推荐牛人页 URL（extract-recommend-candidates.mjs 中的同源常量）
const RECOMMEND_PAGE_URL = 'https://www.zhipin.com/web/chat/recommend';

// CDP 代理版本号（需与 scripts/cdp-proxy.mjs 的 PROXY_VERSION 同步）。
// 版本不匹配时强制重启代理，保证运行的是最新代码（避免旧代理的截图守卫缺失问题）。
const CDP_PROXY_VERSION = '1.3.17';

// 用「边用边跑」模式重启 Chrome，可选带目标 URL 打开（如推荐牛人页）。
// 被 IPC handler 和 runPipeline 的推荐页缺失弹窗共用。
// 返回 { ok, needClose?, message }。
async function launchBossModeChrome({ forceClose = false, openUrl = null } = {}) {
  const chromePath = findChromePath();
  if (!chromePath) {
    return {
      ok: false,
      message: '没有在常见位置找到 Chrome。请照常打开 Chrome，按 README 第 1 步开启远程调试后使用；'
             + '也可以手动用带参数方式启动 Chrome，或用闲置电脑方案。',
    };
  }
  if (await isChromeRunning()) {
    if (!forceClose) {
      return {
        ok: false,
        needClose: true,
        message: 'Chrome 正在运行。要让新参数生效，需要先完全关闭 Chrome（会关闭当前打开的标签页）。',
      };
    }
    await killChrome();
    if (!(await waitChromeExit())) {
      // 优雅关闭超时，强制关闭
      await new Promise((r) => execFile('taskkill', ['/F', '/IM', 'chrome.exe'], () => r()));
    }
  }
  const args = [...BOSS_MODE_CHROME_FLAGS];
  if (openUrl) args.push(openUrl);
  spawn(chromePath, args, { detached: true, stdio: 'ignore' }).unref();
  return {
    ok: true,
    message: openUrl
      ? `Chrome 已用「边用边跑」模式启动，并打开推荐牛人页。首次使用请按 README 第 1 步，`
        + '在 chrome://inspect/#remote-debugging 里勾选「允许远程调试」，之后照常使用即可。'
      : 'Chrome 已用「边用边跑」模式启动。首次使用请按 README 第 1 步，'
        + '在 chrome://inspect/#remote-debugging 里勾选「允许远程调试」，之后照常使用即可。',
  };
}

// 判断当前运行的 Chrome 是否处于「边用边跑」模式（命令行含 CalculateNativeWinOcclusion 禁用参数）
function isChromeBossMode() {
  return new Promise((resolveMode) => {
    // 优先用 wmic（Win10 可用、快），失败回退 PowerShell Get-CimInstance
    const getCmdline = (cmd, args, cb) => {
      execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
        cb(err ? '' : (stdout || ''));
      });
    };
    getCmdline('wmic', ['process', 'where', "name='chrome.exe'", 'get', 'commandline', '/format:list'], (wmicOut) => {
      if (wmicOut.includes('CalculateNativeWinOcclusion')) {
        return resolveMode(true);
      }
      getCmdline('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"name='chrome.exe'\").CommandLine"], (psOut) => {
        resolveMode(psOut.includes('CalculateNativeWinOcclusion'));
      });
    });
  });
}

async function doAiScoring() {
  const sourcePath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
  if (!existsSync(sourcePath)) throw new Error('未找到 zhipin-candidates.json');

  const raw = JSON.parse(readFileSync(sourcePath, 'utf-8'));
  const candidates = raw.candidates || raw;
  const extractSource = raw.source || 'chat'; // 'chat'(沟通页) 或 'recommend'(推荐牛人页)

  // 可取消的 AI 评分：创建 AbortController，所有 API 请求共享
  aiAbortController = new AbortController();
  const signal = aiAbortController.signal;

  // 按岗位分组
  const groups = {};
  for (const c of candidates) {
    const job = c.positionInfo?.appliedJob || '未知岗位';
    if (!groups[job]) groups[job] = [];
    groups[job].push(c);
  }

  const positionNames = Object.keys(groups);
  const totalCandidates = candidates.length;
  const totalNoResume = candidates.filter(c => !c.resumeText).length;

  termLog(`[AI评分] 共 ${totalCandidates} 人，${positionNames.length} 个岗位，无简历 ${totalNoResume} 人`);
  sendProgress(2, 'running', 50, `AI评分: ${totalCandidates} 人，${positionNames.length} 个岗位`);

  // 逐岗位评分
  let completedInPosition = 0; // 全局累计计数（跨岗位不重置）
  for (const positionName of positionNames) {
    if (cancelled) { termLog('[AI评分] 用户取消'); break; }

    const group = groups[positionName];
    const withResume = group.filter(c => c.resumeText);

    // 无简历的直接设 0 分
    for (const c of group) {
      if (!c.resumeText) {
        c.jobRelevanceScore = 0;
        c.jobRelevanceComment = '无在线简历';
        completedInPosition++;
      }
    }

    if (withResume.length === 0) continue;

    // 根据来源选择 prompt 模板：
    // 只有沟通页用 chat 模板（AI 自行从 JD 提取维度权重）；
    // 推荐牛人页和搜索页都用 with-jd 模板（直接采用配置好的维度/筛选项）
    const useWithJd = extractSource !== 'chat';
    const templateName = useWithJd ? 'scoring-prompt-with-jd.txt' : 'scoring-prompt-chat.txt';
    const templatePath = resolve(UNPACKED_ROOT, 'config', templateName);
    let template;
    try {
      template = readFileSync(templatePath, 'utf-8');
    } catch {
      throw new Error(`未找到评分模板: ${templatePath}`);
    }

    // 读取用户配置的评分维度和任职资格筛选项
    const dimensionsText = apiConfig.dimensions || '';
    const screeningCriteriaText = apiConfig.screeningCriteria || '';

    // 尝试读取该岗位的 JD 描述文件。
    // 岗位描述文件有两种可能格式：
    //   1) 结构化：含「核心评估维度及权重」「任职资格关键筛选项」两个 section → 分别填入对应槽位
    //   2) 原始 JD：无 section 标记 → 整段作为 JD 文本兜底（老数据兼容）
    let jdContent = null;
    let jdDimensions = '';
    let jdScreeningCriteria = '';
    const safeName = positionName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const jdFilePath = resolve(JD_DIR, safeName + '.txt');
    try {
      const raw = readFileSync(jdFilePath, 'utf-8').trim();
      if (raw) jdContent = raw;
      // 按 section 解析：优先取「核心评估维度及权重」和「任职资格关键筛选项」两个部分
      const dimMatch = raw.match(/核心评估维度及?权重[\s\S]*?(?=(任职资格关键筛选项|$))/);
      if (dimMatch) jdDimensions = dimMatch[0].trim();
      const criteriaMatch = raw.match(/任职资格关键筛选项[\s\S]*$/);
      if (criteriaMatch) jdScreeningCriteria = criteriaMatch[0].trim();
    } catch {}

    if (useWithJd && !jdContent && !dimensionsText) {
      termLog(`[AI评分] ⚠ 未配置核心评估维度，请先在设置中配置`, 'stderr');
    }

    // 沟通页：从候选人提取的 jobDescription 中获取 JD 文本（无 JD 文件时的后备）
    if (!useWithJd && !jdContent) {
      for (const c of withResume) {
        if (c.jobDescription?.description) {
          const jdText = `${c.jobDescription.jobName || ''} ${c.jobDescription.salary || ''}\n\n${c.jobDescription.description}`;
          jdContent = jdText.trim();
          termLog(`[AI评分] 使用候选人提取的岗位描述作为 JD 文本`);
          break;
        }
      }
    }

    // 批量评分：每批 BATCH_SIZE 人，1 次 API 调用；按批并发
    // 保持 3 人一批（用户决定）。注意：deepseek-v4-flash_DeepSeek 当前思考无上限，3 人一批会
    // 把输出预算全烧在 <antml-thinking> 上导致解析失败（2026-08-21 实测）；换 GLM-5_SLB/kimi-k2.5-SLB
    // 这类非无界思考模型后 3 人一批正常。若日后换回深思考模型，可考虑 BATCH_SIZE=1（单候选人实测稳定）。
    const BATCH_SIZE = 3;
    const CONCURRENCY = 6; // 并发批数（6批×3人≈18人同时，避免 API 限流）
    const totalInPosition = withResume.length;

    // 分批
    const batches = [];
    for (let i = 0; i < totalInPosition; i += BATCH_SIZE) {
      batches.push(withResume.slice(i, i + BATCH_SIZE));
    }
    const totalBatches = batches.length;
    termLog(`[AI评分] 岗位 "${positionName}": ${totalInPosition} 人，${totalBatches} 批，并发 ${CONCURRENCY} 批`);

    const MAX_RESUME_LEN = 4000; // 每份简历截断，避免 prompt 过长

    // 构建批量评分 prompt（批内候选人数任意；失败逐人重试时复用）
    function buildBatchPrompt(cands) {
      let p;
      if (useWithJd) {
        // 结构化岗位文件：维度/筛选项分别填槽（权重、硬性条件真正生效）
        // 原始 JD 文件（无 section）：整段兜底填两个槽位（与旧行为一致）
        const dims = jdDimensions || jdContent || dimensionsText;
        const criteria = jdScreeningCriteria || jdContent || screeningCriteriaText;
        p = template
          .replace('{dimensions}', dims)
          .replace('{screeningCriteria}', criteria);
      } else {
        p = template
          .replace('{jdText}', jdContent || dimensionsText || '(无岗位JD描述)');
      }

      // 拼接本批所有候选人的简历（基础信息/教育经历来自页面 DOM，可靠性高；简历正文为 OCR 仅供参考）
      const resumeSections = cands.map((c, i) => {
        const resumeForAI = (c.resumeText || '').length > MAX_RESUME_LEN
          ? (c.resumeText || '').slice(0, MAX_RESUME_LEN) + '\n\n...(后续内容略)'
          : (c.resumeText || '(无)');
        // 结构化教育经历逐条列出（AI 评学历时不再依赖 OCR 正文）
        const eduList = Array.isArray(c.educationExperience) && c.educationExperience.length > 0
          ? c.educationExperience.map(e =>
              `- ${e.time || ''} | ${e.school || ''} | ${e.major || ''} | ${e.degree || ''}`.replace(/ \| $/, '')).join('\n')
          : '- 无';
        return `=== 候选人 ${i + 1}/${cands.length} ===\n` +
          `姓名：${c.basicInfo?.name || '未知'}\n` +
          `学历（来自页面）：${c.basicInfo?.education || '未知'}\n` +
          `教育经历（来自页面，可靠性高）：\n${eduList}\n` +
          `工作年限（来自页面）：${c.basicInfo?.workYears || '未知'}\n` +
          `简历文本（OCR 识别，仅供参考，可能有错误）：\n${resumeForAI}`;
      }).join('\n\n');

      p = p.replace('{resumeText}', resumeSections);

      // 附加批量输出格式要求
      p += `\n\n重要：本次请求要求 JSON 输出。请为以上每位候选人分别给出评分，严格只输出一个 JSON 数组（不要包含任何其他内容，不要用 markdown 代码块包裹）：\n` +
        `[\n` +
        cands.map((_, i) => `  {"candidateIndex": ${i}, "score": <0-100的整数，必须严格等于该候选人评语中的"匹配度评分：XX分">, "comment": "<按上方评语内容规范组织、完整包含匹配度评分/首句定性/维度匹配/任职资格/学历核查/综合结论各模块的评语，用\\n换行>"}`).join(',\n') +
        `\n]`;
      return p;
    }

    async function scoreOneBatch(batch) {
      if (cancelled) return;

      const prompt = buildBatchPrompt(batch);
      const batchNames = batch.map(c => c.basicInfo?.name || c.geekId || '未知').join('、');
      termLog(`[AI评分] 评分批: ${batchNames}`);

      // 最多重试 2 次
      let lastError = null;
      for (let retry = 0; retry <= 2; retry++) {
        if (cancelled) return;
        try {
          const text = await callClaudeAPI(prompt, { signal });
          const results = parseBatchScoreResponse(text);
          if (results && results.length > 0) {
            for (const r of results) {
              const idx = r.candidateIndex;
              if (idx >= 0 && idx < batch.length) {
                batch[idx].jobRelevanceScore = r.score;
                batch[idx].jobRelevanceComment = r.comment;
                const nm = batch[idx].basicInfo?.name || batch[idx].geekId || '未知';
                termLog(`  ✓ ${nm}: ${r.score}分`);
              }
            }
            lastError = null;
            break;
          }
          lastError = new Error('解析失败(无有效JSON)');
          if (retry < 2) {
            const ts = Date.now();
            const debugPath = resolve(OUTPUT_DIR, `api-raw-response-${ts}.txt`);
            try { writeFileSync(debugPath, text, 'utf-8'); } catch {}
            termLog(`  ⚠ 解析失败: ${debugPath}，${retry + 1}/2 重试`, 'stderr');
            await sleep(2000);
          }
        } catch (err) {
          if (signal.aborted) throw err;
          lastError = err;
          if (retry < 2) {
            termLog(`  ⚠ 请求失败: ${err.message}，${retry + 1}/2 重试`, 'stderr');
            await sleep(2000);
          }
        }
      }

      // 失败批的候选人设 0 分
      if (lastError) {
        // v1.4.5 兜底：多人的批整体失败时，拆成单候选人逐个重试——
        // 单候选人 prompt 触发模型过度思考的概率远低于多人批（deepseek 3人批实测思考无上限，
        // 单候选人稳定出分），模型偶尔抽风时不至于整批丢失。
        if (batch.length > 1) {
          let recovered = 0;
          termLog(`  ↻ 批次评分失败(${lastError.message})，改为逐人重试 ${batch.length} 人`, 'stderr');
          for (const c of batch) {
            if (cancelled) return;
            const singlePrompt = buildBatchPrompt([c]);
            const nm = c.basicInfo?.name || c.geekId || '未知';
            let singleError = null;
            for (let retry = 0; retry <= 2; retry++) {
              if (cancelled) return;
              try {
                const text = await callClaudeAPI(singlePrompt, { signal });
                const results = parseBatchScoreResponse(text);
                if (results && results.length > 0 && typeof results[0].score === 'number') {
                  c.jobRelevanceScore = results[0].score;
                  c.jobRelevanceComment = results[0].comment;
                  termLog(`  ✓ ${nm}: ${results[0].score}分 (逐人重试)`);
                  recovered++;
                  singleError = null;
                  break;
                }
                singleError = new Error('解析失败(无有效JSON)');
              } catch (err) {
                if (signal.aborted) throw err;
                singleError = err;
              }
              if (retry < 2) await sleep(2000);
            }
            if (singleError) {
              c.jobRelevanceScore = 0;
              c.jobRelevanceComment = `评分失败: ${singleError.message}`;
            }
          }
          termLog(`  ↻ 逐人重试完成：成功 ${recovered}/${batch.length} 人`, 'stderr');
        } else {
          for (const c of batch) {
            c.jobRelevanceScore = 0;
            c.jobRelevanceComment = `评分失败: ${lastError.message}`;
          }
          termLog(`  ✗ 批次评分失败: ${lastError.message}`, 'stderr');
        }
      }

      completedInPosition += batch.length;
      const overall = Math.round(50 + (completedInPosition / totalCandidates) * 50);
      sendProgress(2, 'running', overall, `AI评分: ${completedInPosition}/${totalCandidates} 人`);
    }

    // 按批滑动窗口执行
    const executing = new Set();
    for (let i = 0; i < Math.min(CONCURRENCY, totalBatches); i++) {
      if (cancelled) break;
      const promise = scoreOneBatch(batches[i]).finally(() => executing.delete(promise));
      executing.add(promise);
    }
    for (let i = CONCURRENCY; i < totalBatches; i++) {
      if (cancelled) break;
      await Promise.race(executing);
      if (cancelled) break;
      const promise = scoreOneBatch(batches[i]).finally(() => executing.delete(promise));
      executing.add(promise);
    }
    await Promise.allSettled(executing);
    termLog(`[AI评分] 岗位 "${positionName}" 评分完成 (${totalInPosition} 人)`);
  }
  // 总分 = AI 评分（0-100）。
  // 权威分数 = 从评语中解析各维度「独立得分×权重」程序化计算的加权基础分 - 其他扣分合计。
  // AI 手写的「匹配度评分」算术不可靠（实测多例手写分对不上公式），
  // 必须以评语内自带公式重算，保证与评语内容严格一致（打招呼等级过滤据此判断）。
  for (const c of candidates) {
    c.matchScore = computeMatchScoreFromComment(c.jobRelevanceComment) ??
      parseMatchScoreFromComment(c.jobRelevanceComment);
    c.totalScore = c.matchScore ?? (c.jobRelevanceScore || 0);
    // 学历硬性门槛兜底后，同步修正评语文字，避免「评语说不扣分、分数却扣了」的矛盾
    c.jobRelevanceComment = patchEducationDeductionComment(c.jobRelevanceComment);
    if (c.totalScore >= 91) c.recommendationLevel = '强烈推荐';
    else if (c.totalScore >= 81) c.recommendationLevel = '推荐';
    else if (c.totalScore >= 61) c.recommendationLevel = '可考虑';
    else c.recommendationLevel = '暂不推荐';
    c.passed = c.totalScore >= 61;
  }

  aiAbortController = null;

  // 写回 scored-candidates.json
  const resultPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
  const output = raw.candidates ? raw : { candidates: raw };
  writeFileSync(resultPath, JSON.stringify(output, null, 2), 'utf-8');
  termLog(`[AI评分] 完成，已写入 ${resultPath}`);
}

function cleanupTempFiles() {
  const dir = OUTPUT_DIR;
  if (!existsSync(dir)) return;

  const screenshotsDir = resolve(dir, '.temp-screenshots');
  if (existsSync(screenshotsDir)) {
    try {
      rmSync(screenshotsDir, { recursive: true, force: true });
      termLog(`[main] 已清理截图目录: .temp-screenshots/`);
    } catch (e) {
      termLog(`[main] 清理截图目录失败: ${e.message}`, 'stderr');
    }
  }

  const rawPath = resolve(dir, 'zhipin-candidates.json');
  if (existsSync(rawPath)) {
    try {
      unlinkSync(rawPath);
      termLog(`[main] 已清理: zhipin-candidates.json`);
    } catch (e) {
      termLog(`[main] 清理 zhipin-candidates.json 失败: ${e.message}`, 'stderr');
    }
  }

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('api-raw-response-') && entry.endsWith('.txt')) {
        unlinkSync(resolve(dir, entry));
        termLog(`[main] 已清理: ${entry}`);
      }
    }
  } catch (e) {
    termLog(`[main] 清理 API 日志失败: ${e.message}`, 'stderr');
  }
}

// ===== 主流程编排 =====
async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '', enableCopy = true) {
  cancelled = false;
  skipRecovered = false;

  // 运行期间阻止系统休眠/显示器关闭（v1.3.27）：
  // 同事实测跑一批会因系统休眠后锁屏而暂停。powerSaveBlocker('prevent-display-sleep')
  // 让显示器不自动关闭、系统不自动睡眠，从而不会触发"唤醒后要重新登录"的锁屏。
  // 注意：公司 IT 强制锁屏策略（域策略/屏保锁定）压不住，那种需联系 IT 或运行前手动设置。
  const keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  try {
    // 归档旧输出目录（在主进程做，避免子进程 rename 时 EBUSY）
    if (!skipExtract && existsSync(OUTPUT_DIR)) {
      try {
        const entries = readdirSync(OUTPUT_DIR);
        if (entries.length > 0) {
          const now = new Date();
          const pad = (n) => String(n).padStart(2, '0');
          const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
          const archived = `${OUTPUT_DIR}-${stamp}`;
          renameSync(OUTPUT_DIR, archived);
          termLog(`[main] 已归档旧输出目录: ${archived}`);
        }
      } catch (e) {
        termLog(`[main] 归档旧输出目录跳过: ${e.message}`, 'stderr');
      }
    }

    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    const isRecommendMode = source === 'recommend' || source === 'recommend-attach';
    const isSearchMode = source === 'search';

    // 步骤 1: 提取（可跳过）
    if (!skipExtract) {
      const isAttach = source === 'recommend-attach' || source === 'search';
      let scriptName;
      let pageLabel;
      if (isSearchMode) {
        scriptName = 'extract-search-candidates.mjs';
        pageLabel = '搜索';
      } else if (isRecommendMode) {
        scriptName = 'extract-recommend-candidates.mjs';
        pageLabel = isAttach ? '推荐牛人页（手动筛选）' : '推荐牛人';
      } else {
        scriptName = 'extract-candidates-full.mjs';
        pageLabel = '沟通';
      }
      sendProgress(1, 'running', 0, extractAll ? `正在提取候选人信息 (${pageLabel}页)...` : '正在提取候选人信息...');
      const extractArgs = extractAll
        ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
        : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
      if (job) {
        extractArgs.push('--job', job);
      }
      if (isAttach) {
        extractArgs.push('--attach');
      }
      extractArgs.push('--enable-copy', enableCopy ? '1' : '0'); // v1.4.4 模拟复制开关
      try {
        await runScript(scriptName, extractArgs, 1, parseExtractProgress);
      } catch (err) {
        if (skipToScoring) {
          skipToScoring = false;
          skipRecovered = true;
          // 检查是否已有完整输出文件（脚本可能在 kill 前已完成）
          const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
          if (existsSync(candidatesPath)) {
            termLog('[main] 跳过提取，但 zhipin-candidates.json 已存在，直接使用');
            sendProgress(1, 'done', 100, '已跳过提取步骤');
          } else {
            termLog('[main] 用户跳过提取，尝试从进度文件恢复数据');
            const progressPath = resolve(OUTPUT_DIR, '.extract-progress.json');
            if (!existsSync(progressPath)) {
              termLog('[main] 跳过提取失败：尚无已提取的候选人数据');
              sendError({ message: '暂无已提取的候选人数据，无法跳过。请等待提取到足够数据后再试。' });
              return;
            }
            const progressData = JSON.parse(readFileSync(progressPath, 'utf-8'));
            const candidates = progressData.candidates || [];
            if (candidates.length === 0) {
              termLog('[main] 跳过提取失败：进度文件中无候选人数据');
              sendError({ message: '进度文件中无候选人数据，无法跳过。请等待提取到足够数据后再试。' });
              return;
            }
            termLog(`[main] 从进度文件恢复 ${candidates.length} 名候选人`);
            const output = { source: isSearchMode ? 'search' : (isRecommendMode ? 'recommend' : 'chat'), candidates };
            writeFileSync(candidatesPath, JSON.stringify(output, null, 2), 'utf-8');
            sendProgress(1, 'done', 100, `已跳过提取，从进度恢复 ${candidates.length} 人数据`);
          }
        } else {
          throw err;
        }
      }
      if (cancelled) return;
      if (!skipRecovered) {
        sendProgress(1, 'done', 100, '候选人信息提取完成');
      }
    } else {
      sendProgress(1, 'done', 100, '已跳过提取步骤');
    }
    // 步骤 2: AI 评分（直接从 zhipin-candidates.json 读取）
    const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
    if (!existsSync(candidatesPath)) {
      throw new Error('未找到 zhipin-candidates.json');
    }
    sendProgress(2, 'running', 0, '正在 AI 评分...');
    await doAiScoring();
    if (cancelled) return;

    // 步骤 3: 导出
    sendProgress(2, 'done', 100, 'AI 评分完成');
    sendProgress(3, 'running', 0, '正在导出 Excel...');
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) throw new Error(`未找到评分结果文件: ${scoredPath}`);

    // 每次导出前重置邮件结果，避免残留上一次的状态
    exportMailResult = { status: 'none', to: '', error: '' };

    // 构建导出参数：若有 emailPrefix，传给导出脚本自动发邮件
    let exportArgs = ['--input', scoredPath];
    const smtpEnv = {};
    if (apiConfig.emailPrefix) {
      if (!apiConfig.smtpPass) {
        throw new Error('未配置邮箱密码：请到「API 配置」填写发件邮箱的密码后再发送邮件（公司邮箱若开启了三方客户端安全密码，要填邮箱设置里获取的"客户端安全密码"，不是登录密码）');
      }
      let emailSubject = '候选人评分结果';
      if (isRecommendMode) emailSubject = '推荐牛人评分结果';
      else if (isSearchMode) emailSubject = '搜索页评分结果';
      // 发件邮箱 = 收件邮箱 = 填的邮箱（填完整邮箱直接使用；只填前缀则补域名，兼容旧配置）
      const rawEmail = apiConfig.emailPrefix.trim();
      const emailUser = rawEmail.includes('@') ? rawEmail : `${rawEmail}@allwinnertech.com`;
      exportArgs.push('--to-prefix', emailUser);
      exportArgs.push('--email-subject', emailSubject);
      // 传递 SMTP 配置给子进程
      if (apiConfig.smtpHost) smtpEnv.SMTP_HOST = apiConfig.smtpHost;
      if (apiConfig.smtpPort) smtpEnv.SMTP_PORT = apiConfig.smtpPort;
      if (apiConfig.smtpSecure) smtpEnv.SMTP_SECURE = apiConfig.smtpSecure;
      smtpEnv.SMTP_USER = emailUser;
      if (apiConfig.smtpPass) smtpEnv.SMTP_PASS = apiConfig.smtpPass;
      smtpEnv.SMTP_FROM = emailUser;
      termLog(`[main] 将发送邮件到 ${emailUser}`);
    }
    await runScript('export-candidates.mjs', exportArgs, 3, parseExportProgress, smtpEnv);
    if (cancelled) return;

    sendProgress(3, 'done', 100, 'Excel 导出完成');

    // 清理临时文件（保留 scored-candidates.json 和 candidates.xlsx）
    cleanupTempFiles();

    // 邮件是否真的发出去了以脚本标记为准：只有 MAIL_OK 才算已发送，
    // 认证失败等情况下不再误报「邮件已发送至」
    const emailSent = exportMailResult.status === 'ok';
    sendDone({
      outputDir: OUTPUT_DIR,
      excelPath: actualExportPath || resolve(OUTPUT_DIR, 'candidates.xlsx'),
      emailTo: emailSent ? exportMailResult.to : null,
      emailError: exportMailResult.status === 'fail' ? exportMailResult.error : '',
    });
  } catch (err) {
    if (err.message === '已取消') {
      sendProgress(1, 'idle', 0, '已取消');
      sendProgress(2, 'idle', 0, '');
      sendProgress(3, 'idle', 0, '');
    } else if ((source === 'recommend' || source === 'recommend-attach')
               && err.message.includes('未找到已打开的推荐牛人页')) {
      // v1.3.12: 推荐页未打开 → 弹窗询问是否重启 Chrome 并打开推荐页（替代纯红色错误文本）
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['重新启动 Chrome 并打开推荐页', '取消'],
        defaultId: 0,
        cancelId: 1,
        message: '未找到已打开的推荐牛人页',
        detail: '检测到 Chrome 已打开，但推荐牛人页 (zhipin.com/web/chat/recommend) 未打开。\n'
              + '是否用「边用边跑」模式重启 Chrome 并打开该页面？\n'
              + '（会先关闭当前打开的标签页，重启后自动打开推荐页）',
      });
      if (response === 0) {
        const res = await launchBossModeChrome({ forceClose: true, openUrl: RECOMMEND_PAGE_URL });
        sendProgress(1, 'idle', 0, res.ok
          ? '已重启 Chrome 并打开推荐页，请设置好筛选条件后再次点击「开始提取分析」'
          : `重启 Chrome 失败：${res.message}`);
      } else {
        sendError({ message: err.message });
      }
    } else {
      sendError({ message: err.message });
    }
  } finally {
    // 无论成功/取消/报错，结束运行都要恢复系统原有电源行为
    try {
      if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    } catch {}
  }
}

// ===== 批量打招呼 =====
async function runGreeting(level, source = 'recommend') {
  cancelled = false; // 重置取消标志
  const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
  if (!existsSync(scoredPath)) {
    sendGreetError({ message: '未找到评分结果文件，请先完成评分' });
    return;
  }

  // 读取评分数据，计算各等级人数用于进度显示
  let totalTargets = 0;
  try {
    const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
    const candidates = raw.candidates || raw;
    const thresholds = { 5: 91, 4: 81, 3: 61, 2: 31, 0: 0 };
    const threshold = thresholds[level] ?? 81;
    totalTargets = candidates.filter(c => (c.matchScore ?? c.totalScore ?? c.jobRelevanceScore ?? 0) >= threshold).length;
  } catch (err) {
    termLog(`[greet] 读取评分数据失败: ${err.message}`, 'stderr');
  }

  termLog(`[greet] 开始批量打招呼，level=${level}，source=${source}，目标 ${totalTargets} 人`);

  // 打招呼也是长任务，运行期间同样阻止系统休眠/显示器关闭（与 runPipeline 一致）
  const greetKeepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  const stopGreetKeepAwake = () => {
    try { if (powerSaveBlocker.isStarted(greetKeepAwakeId)) powerSaveBlocker.stop(greetKeepAwakeId); } catch {}
  };

  // 超时随目标人数伸缩：每人约 10 秒预算（点击+验证+防风控间隔+余量），
  // 下限 5 分钟、上限 30 分钟。81 人 ≈ 13.5 分钟，避免大量候选人逼近旧 10 分钟硬超时被杀。
  // 预算必须小于脚本侧 PER_CANDIDATE_TIMEOUT(30s) + 单人体检开销，否则主进程会中途杀掉单个候选人。
  const BUDGET_PER_TARGET = 10_000;
  const MAX_WAIT = Math.min(30 * 60 * 1000, Math.max(5 * 60 * 1000, totalTargets * BUDGET_PER_TARGET));
  let greetFatalSent = false; // GREET_ERROR 已上报真实原因，close 时不再重复报泛化退出码
  let lastStderr = ''; // 脚本最近一行 stderr，供 close 无 GREET_ERROR 时兜底诊断
  let greetTimer = null; // 超时定时器，close/error 时清理，避免进程退出后仍被持有

  try {
    const greetPath = resolve(UNPACKED_ROOT, 'scripts', 'greet-candidates.mjs');
    const procCwd = app.isPackaged ? OUTPUT_DIR : APP_ROOT;

    const proc = spawn(process.execPath, [greetPath,
      '--input', scoredPath,
      '--level', String(level),
      '--source', source,
    ], {
      cwd: procCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });

    currentProcess = proc;

    // 解析 stdout 中的打招呼进度
    proc.stdout.on('data', (data) => {
      const lines = decodeBuffer(data).split('\n').filter(Boolean);
      for (const line of lines) {
        termLog(`[greet] ${line}`);

        // GREET_STATUS: 单条结果
        const statusMatch = line.match(/^GREET_STATUS:(.+?)\|(.+?)\|(.+?)\|(.+)/);
        if (statusMatch) {
          sendGreetProgress(statusMatch[4], 0, 0);
          continue;
        }

        // GREET_DONE: 最终统计
        const doneMatch = line.match(/^GREET_DONE:(\d+)\|(\d+)\|(\d+)\|(\d+)/);
        if (doneMatch) {
          sendGreetDone({
            success: parseInt(doneMatch[1]),
            already: parseInt(doneMatch[2]),
            notFound: parseInt(doneMatch[3]),
            skipped: parseInt(doneMatch[4]),
          });
          continue;
        }

        // GREET_ERROR: 致命错误
        const errMatch = line.match(/^GREET_ERROR:(.+)/);
        if (errMatch) {
          greetFatalSent = true; // 真实原因已上报，close 时不再重复报泛化退出码
          sendGreetError({ message: errMatch[1] });
          return;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = decodeBuffer(data).trim();
      if (text) {
        lastStderr = text; // 记录最近一行，close 无 GREET_ERROR 时兜底展示
        termLog(`[greet stderr] ${text}`, 'stderr');
      }
    });

    proc.on('error', (err) => {
      clearTimeout(greetTimer);
      currentProcess = null;
      stopGreetKeepAwake();
      if (!cancelled) {
        sendGreetError({ message: err.message });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(greetTimer);
      currentProcess = null;
      stopGreetKeepAwake();
      // 超时或用户取消时 cancelled=true，不再重复报错
      if (cancelled) return;
      // 已通过 GREET_ERROR 上报过真实原因，跳过泛化退出码，避免覆盖真实错误
      if (greetFatalSent) return;
      // code=null 表示被信号杀死（非正常退出）
      if (code !== 0) {
        const base = code === null
          ? '打招呼进程异常终止（可能被系统杀死）'
          : `greet-candidates.mjs 退出码 ${code}`;
        // 已知致命路径脚本已统一走 GREET_ERROR（上面已处理）；这里仅兜底未知异常
        // （未捕获抛错/被系统杀死）——用最近一行 stderr 让用户看到原始报错
        sendGreetError({ message: lastStderr ? `${base}\n${lastStderr}` : base });
      }
    });

    // 超时保护（也会设置 cancelled，避免 close 事件重复报错）
    greetTimer = setTimeout(() => {
      if (currentProcess === proc) {
        cancelled = true; // 也标记全局取消，close 处理时不再报退出码错误
        currentProcess = null;
        proc.kill();
        sendGreetError({ message: '打招呼超时' });
      }
    }, MAX_WAIT);

  } catch (err) {
    stopGreetKeepAwake();
    sendGreetError({ message: err.message });
  }
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
      cdpProxyProcess = null;
      if (health.connected) {
        cdpStatus = { state: 'connected', message: '' };
        termLog(`[cdp] 发现已有 CDP 代理, Chrome 已连接`);
      } else {
        // 尝试触发重连（旧代理可能只是没触发 connect）
        termLog(`[cdp] 发现已有 CDP 代理但 Chrome 未连接，尝试触发重连...`);
        try { await httpGet('http://127.0.0.1:3456/targets'); } catch {}
        await sleep(3000);
        const retry = await httpGet('http://127.0.0.1:3456/health');
        if (retry?.connected) {
          cdpStatus = { state: 'connected', message: '' };
          termLog(`[cdp] Chrome 重连成功`);
        } else {
          cdpStatus = { state: 'error', message: 'Chrome 未开启远程调试，请在 chrome://inspect/#remote-debugging 中勾选"允许远程调试"' };
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
  cdpStatus = { state: 'connecting', message: '正在启动 CDP 代理...' };

  const proxyPath = resolve(UNPACKED_ROOT, 'scripts', 'cdp-proxy.mjs');
  cdpProxyProcess = spawn(process.execPath, [proxyPath], {
    cwd: app.isPackaged ? process.resourcesPath : APP_ROOT,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CDP_PROXY_PORT: '3456', ELECTRON_RUN_AS_NODE: '1' },
  });

  cdpProxyProcess.stdout.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      termLog(`[cdp-proxy] ${line}`);
    }
  });
  cdpProxyProcess.stderr.on('data', (data) => {
    for (const line of data.toString().split('\n').filter(Boolean)) {
      termLog(`[cdp-proxy stderr] ${line}`, 'stderr');
    }
  });
  cdpProxyProcess.on('error', (err) => {
    termLog(`[cdp] 代理进程错误: ${err.message}`, 'stderr');
  });
  cdpProxyProcess.on('exit', (code) => {
    termLog(`[cdp] 代理进程退出 (code=${code})`);
    cdpProxyProcess = null;
    if (cdpStatus.state !== 'connected') {
      cdpStatus = { state: 'error', message: 'CDP 代理意外退出' };
    }
  });

  // 3. 等待 HTTP 服务器就绪（最长 10 秒），同时检查 Chrome 连接
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    try {
      const health = await httpGet('http://127.0.0.1:3456/health');
      if (health?.status === 'ok') {
        if (health.connected) {
          cdpStatus = { state: 'connected', message: '' };
          termLog('[cdp] CDP 代理已就绪，Chrome 已连接');
        } else {
          // 新代理有 connectWithRetry，会在后台自动重连，这里先显示提示
          // 同时手动触发一次重连
          try { httpGet('http://127.0.0.1:3456/targets').catch(() => {}); } catch {}
          cdpStatus = { state: 'error', message: 'Chrome 未开启远程调试，请在 chrome://inspect/#remote-debugging 中勾选"允许远程调试"' };
          termLog('[cdp] CDP 代理已就绪，Chrome 未连接（后台自动重试中）');
        }
        return;
      }
    } catch {}
  }

  cdpStatus = { state: 'error', message: 'CDP 代理启动失败' };
  termLog('[cdp] CDP 代理启动失败', 'stderr');
}

// ===== IPC 注册 =====
function registerIPC() {
  ipcMain.handle('start-extraction', (_event, opts) => {
    if (currentProcess) return { error: '已有任务运行中' };
    const count = opts?.count ?? 20;
    const skipExtract = opts?.skipExtract || false;
    const extractAll = opts?.extractAll || false;
    const source = opts?.source || 'chat';
    const job = opts?.job || '';
    const enableCopy = opts?.enableCopy !== false; // v1.4.4 模拟复制开关，默认开启
    runPipeline(count, skipExtract, extractAll, source, job, enableCopy);
    return { ok: true };
  });

  ipcMain.handle('cancel-extraction', () => {
    cancelled = true;
    if (currentProcess) {
      // 写入 stdin 通知子进程自行清理（Windows 下 SIGTERM 不可靠）
      try {
        if (currentProcess?.stdin?.writable) {
          const onError = () => {};
          currentProcess.stdin.on('error', onError);
          currentProcess.stdin.write('CANCEL\n');
          currentProcess.stdin.off('error', onError);
        }
      } catch {}
      // 等 2s 让子进程清理，超时强制杀
      // v1.3.28：强杀等待放宽到 6s，让子进程 doCleanup 先落盘进度再退出
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 6000);
    }
    if (aiAbortController) { aiAbortController.abort(); aiAbortController = null; }
    return { ok: true };
  });

  ipcMain.handle('skip-extraction', () => {
    skipToScoring = true;
    if (currentProcess) {
      try {
        if (currentProcess?.stdin?.writable) {
          const onError = () => {};
          currentProcess.stdin.on('error', onError);
          currentProcess.stdin.write('CANCEL\n');
          currentProcess.stdin.off('error', onError);
        }
      } catch {}
      // v1.3.28：强杀等待放宽到 6s，让子进程 doCleanup 先落盘进度再退出
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 6000);
    }
    return { ok: true };
  });

  // 批量打招呼
  ipcMain.handle('start-greeting', (_event, opts) => {
    if (currentProcess) return { error: '已有任务运行中' };
    const level = opts?.level ?? 4;
    const source = opts?.source || 'recommend';
    runGreeting(level, source);
    return { ok: true };
  });

  ipcMain.handle('cancel-greeting', () => {
    cancelled = true;
    if (currentProcess) {
      try {
        if (currentProcess?.stdin?.writable) {
          const onError = () => {};
          currentProcess.stdin.on('error', onError);
          currentProcess.stdin.write('CANCEL\n');
          currentProcess.stdin.off('error', onError);
        }
      } catch {}
      // v1.3.28：强杀等待放宽到 6s，让子进程 doCleanup 先落盘进度再退出
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 6000);
    }
    return { ok: true };
  });

  // 获取评分候选人各等级人数（供打招呼 UI 展示）
  ipcMain.handle('get-greet-candidate-counts', () => {
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) return { available: false, total: 0, counts: {} };
    try {
      const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
      const candidates = raw.candidates || raw;
      if (!Array.isArray(candidates)) return { available: false, total: 0, counts: {} };
      const counts = { 5: 0, 4: 0, 3: 0, 2: 0, 0: 0 };
      const thresholds = { 5: 91, 4: 81, 3: 61, 2: 31, 0: 0 };
      for (const c of candidates) {
        const score = c.totalScore ?? c.jobRelevanceScore ?? 0;
        if (score >= 91) counts[5]++;
        if (score >= 81) counts[4]++;
        if (score >= 61) counts[3]++;
        if (score >= 31) counts[2]++;
        counts[0] = candidates.length;
      }
      return { available: true, total: candidates.length, counts };
    } catch {
      return { available: false, total: 0, counts: {} };
    }
  });

  ipcMain.handle('open-output', async () => {
    if (existsSync(OUTPUT_DIR)) await shell.openPath(OUTPUT_DIR);
    return { ok: true };
  });

  ipcMain.handle('get-output-dir', () => OUTPUT_DIR);

  ipcMain.handle('select-output-dir', async () => {
    const win = BrowserWindow.getFocusedWindow();
    if (!win) return { error: 'no window' };

    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: OUTPUT_DIR,
    });

    if (result.canceled || !result.filePaths.length) return { canceled: true };

    const parentDir = result.filePaths[0];
    const newDir = resolve(parentDir, 'output');
    mkdirSync(newDir, { recursive: true });
    OUTPUT_DIR = newDir;
    apiConfig.outputDir = parentDir;
    saveApiConfig(apiConfig);
    termLog(`[config] 输出目录已更改: ${newDir}`);
    return { path: newDir };
  });

  // 清空输出目录下的历史归档数据
  ipcMain.handle('clear-history', async () => {
    const parentDir = dirname(OUTPUT_DIR);
    const baseName = basename(OUTPUT_DIR);
    // 校验：baseName 必须只包含合法字符，避免误删
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5-]+$/.test(baseName)) {
      return { error: `输出目录名 "${baseName}" 包含非法字符，拒绝操作` };
    }
    // 归档目录名格式：{baseName}-YYYYMMDD-HHMM
    const archivePattern = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{4}$`);

    let deletedCount = 0;
    let errorCount = 0;
    const matchedDirs = [];
    const skippedDirs = [];

    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          termLog(`[clear-history] 跳过非目录: ${entry.name}`);
          continue;
        }
        if (!archivePattern.test(entry.name)) {
          termLog(`[clear-history] 不匹配归档模式: ${entry.name}`);
          skippedDirs.push(entry.name);
          continue;
        }

        matchedDirs.push(entry.name);
        const fullPath = resolve(parentDir, entry.name);
        try {
          // Windows 文件锁问题：重试最多 3 次，每次等待 500ms
          let retries = 3;
          let lastErr = null;
          while (retries > 0) {
            try {
              rmSync(fullPath, { recursive: true, force: true });
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e;
              retries--;
              if (retries > 0) {
                termLog(`[clear-history] ${entry.name} 删除失败，${retries} 次重试...`, 'stderr');
                await sleep(500);
              }
            }
          }
          if (lastErr) throw lastErr;
          termLog(`[clear-history] 已删除: ${entry.name}`);
          deletedCount++;
        } catch (err) {
          termLog(`[clear-history] 删除失败 ${entry.name}: ${err.message}`, 'stderr');
          errorCount++;
        }
      }
    } catch (err) {
      return { error: `读取目录失败: ${err.message}` };
    }

    termLog(`[clear-history] 归档模式: ${archivePattern}`);
    termLog(`[clear-history] 匹配到的目录: ${JSON.stringify(matchedDirs)}`);
    termLog(`[clear-history] 未匹配的目录: ${JSON.stringify(skippedDirs)}`);

    return {
      ok: true,
      deleted: deletedCount,
      errors: errorCount,
      parentDir,
      matchedDirs,
      skippedDirs,
    };
  });

  // API 配置 + SMTP 配置（持久化到磁盘）
  ipcMain.handle('set-api-config', (_event, config) => {
    apiConfig = { ...apiConfig, ...config };
    saveApiConfig(apiConfig);
    return { ok: true };
  });

  ipcMain.handle('get-api-config', () => ({ ...apiConfig }));

  ipcMain.handle('get-api-config-status', () => {
    return { configured: !!(apiConfig.url && apiConfig.key && apiConfig.model) };
  });

  // 评分配置（维度 + 任职资格筛选项）
  ipcMain.handle('set-scoring-config', (_event, config) => {
    if (config.dimensions !== undefined) apiConfig.dimensions = config.dimensions;
    if (config.screeningCriteria !== undefined) apiConfig.screeningCriteria = config.screeningCriteria;
    saveApiConfig(apiConfig);
    termLog(`[config] 评分配置已保存`);
    return { ok: true };
  });

  ipcMain.handle('get-scoring-config', () => ({
    dimensions: apiConfig.dimensions || '',
    screeningCriteria: apiConfig.screeningCriteria || '',
  }));

  // CDP/Chrome 状态
  ipcMain.handle('get-cdp-status', () => ({ ...cdpStatus }));

  ipcMain.handle('retry-cdp-connection', async () => {
    if (cdpStatus.state === 'connected') return { ...cdpStatus };
    cdpStatus = { state: 'connecting', message: '正在重试...', chromePort: null };
    startCdpProxy().catch(() => {});
    return { ...cdpStatus };
  });

  // 供「开始提取分析」按钮做预检：Chrome 是否已在「边用边跑」模式
  ipcMain.handle('check-boss-mode', async () => {
    const chromePath = findChromePath();
    const running = await isChromeRunning();
    let bossMode = false;
    if (running) {
      bossMode = await isChromeBossMode();
    }
    return { chromePath, running, bossMode };
  });

  // GUI 版本号
  ipcMain.handle('get-app-version', () => app.getVersion());

  // "边用边跑"模式：带参数重启 Chrome，关闭 Windows 遮挡暂停渲染
  // （否则 Chrome 窗口被完全盖住/最小化时渲染暂停，CDP 截图会拿到空白帧）
  ipcMain.handle('launch-boss-mode-chrome', (_event, opts) => launchBossModeChrome(opts));

  // 读取推荐牛人页岗位列表（从 jd-descriptions/ 目录的 .txt 文件名反解）
  ipcMain.handle('get-recommend-jobs', () => {
    const dir = JD_DIR;
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir).filter(f => f.endsWith('.txt'));
    return files
      .map(f => f.replace(/\.txt$/, ''))
      // 反转文件名中的全角符号 → 半角（/ 是 Windows 不允许的字符）
      .map(name => name.replace(/／/g, '/').replace(/：/g, ':').replace(/＊/g, '*'))
      .sort();
  });

  // 添加新岗位：创建对应的 .txt 文件并写入 JD 描述
  ipcMain.handle('add-recommend-job', (_event, jobName, jobDesc) => {
    if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
    // 与 JD 读取逻辑保持一致：替换 Windows 不允许的字符
    const safeName = jobName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const dir = JD_DIR;
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, safeName + '.txt');
    if (existsSync(filePath)) throw new Error(`岗位"${jobName}"已存在`);
    writeFileSync(filePath, jobDesc || '', 'utf-8');
    termLog(`[config] 已添加新岗位: ${jobName}`);
    return { ok: true };
  });

  // 读取岗位 JD 描述
  ipcMain.handle('get-recommend-job-desc', (_event, jobName) => {
    if (!jobName) return '';
    const safeName = jobName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const filePath = resolve(JD_DIR, safeName + '.txt');
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8');
  });

  // 更新岗位描述（岗位名不可改，只更新 .txt 内容）
  ipcMain.handle('update-recommend-job', (_event, jobName, jobDesc) => {
    if (!jobName || typeof jobName !== 'string') throw new Error('岗位名不能为空');
    const safeName = jobName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const filePath = resolve(JD_DIR, safeName + '.txt');
    if (!existsSync(filePath)) throw new Error(`岗位"${jobName}"不存在`);
    writeFileSync(filePath, jobDesc || '', 'utf-8');
    termLog(`[config] 已更新岗位描述: ${jobName}`);
    return { ok: true };
  });

  // 删除岗位
  ipcMain.handle('delete-recommend-job', (_event, jobName) => {
    if (!jobName) throw new Error('岗位名不能为空');
    const safeName = jobName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const filePath = resolve(JD_DIR, safeName + '.txt');
    if (!existsSync(filePath)) throw new Error(`岗位"${jobName}"不存在`);
    unlinkSync(filePath);
    termLog(`[config] 已删除岗位: ${jobName}`);
    return { ok: true };
  });
}

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  loadApiConfig();
  mkdirSync(JD_DIR, { recursive: true });
  registerIPC();

  // 非阻塞启动 CDP 代理（后台进行，不阻塞窗口创建）
  startCdpProxy();

  const scoreOnly = process.argv.includes('--score-only');
  if (scoreOnly) {
    // 无界面模式：只跑评分+导出（跑完自动退出，避免无窗口进程挂起）
    termLog('[main] 模式: --score-only (跳过提取，直接评分导出)');
    runPipeline(20, true, true, 'chat', '').then(() => {
      termLog('[main] --score-only 完成，进程退出');
      app.exit(0);
    }).catch((err) => {
      termLog(`[main] --score-only 异常: ${err.message}`, 'stderr');
      app.exit(1);
    });
    return;
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentProcess) { currentProcess.kill(); currentProcess = null; }
  if (cdpProxyProcess) { cdpProxyProcess.kill(); cdpProxyProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});
