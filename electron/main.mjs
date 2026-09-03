import { app, BrowserWindow, ipcMain, shell, dialog, powerSaveBlocker } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmSync, appendFileSync, copyFileSync, statSync } from 'node:fs';
import http from 'node:http';
import iconv from 'iconv-lite';
import { computeMatchScoreFromComment, parseMatchScoreFromComment, patchEducationDeductionComment } from './score-comment.mjs';
import { TIER_THRESHOLDS, thresholdForLevel, scoreToTier, scoreToRecommendation, isPassed } from '../scripts/score-tiers.mjs';
import { archiveOldOutput, cleanupCacheFiles } from '../scripts/extract-common.mjs';

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
  smtpUser: '', smtpPass: '', smtpFrom: '',
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
// v1.8.4: 日志统一带时间戳（文件 + 终端）。用来定位「两候选人之间等多久」这类耗时问题，
// 不带时间戳的日志看不出每一步实际花了多少秒。毫秒级便于测出 sub-second 的等待。
function tsPrefix() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]`;
}
function termLog(msg, stream = 'stdout') {
  const prefixed = `${tsPrefix()} ${msg}`;
  try {
    const buf = iconv.encode(prefixed, 'gbk');
    if (stream === 'stderr') {
      process.stderr.write(buf);
      process.stderr.write('\n');
    } else {
      process.stdout.write(buf);
      process.stdout.write('\n');
    }
  } catch {
    if (stream === 'stderr') process.stderr.write(prefixed + '\n');
    else process.stdout.write(prefixed + '\n');
  }
  // 追加到日志文件（同步 append，量不大，不阻塞主流程）
  try { appendFileSync(LOG_PATH, prefixed + '\n'); } catch {}
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
let tailFlushRequested = false; // v1.8.3：用户点「暂停」时置位，增量评分器下一轮把手头不满一批的零头立刻派发，让进度跟上提取
let aiAbortController = null; // 用于中断 AI 评分的正在请求
let actualExportPath = ''; // 导出脚本实际输出的文件路径（可能被另存）
let exportMailResult = { status: 'none', to: '', error: '' }; // 导出步骤的邮件发送结果（由 MAIL_OK/MAIL_FAIL 标记更新）

// 当前是否有真正在运行的任务：进程引用还在，且未退出、未被 kill 才算。
// 之前只看 currentProcess 是否非空，进程已退出但 close 事件还没触发（或取消竞态）时会
// 误报「已有任务运行中」，导致一轮跑完/取消后回首页点开始偶尔被拦。
function hasRunningTask() {
  return !!(currentProcess && currentProcess.exitCode === null && !currentProcess.killed);
}

// 向当前子进程 stdin 写一行控制信号（CANCEL/PAUSE/RESUME）。Windows 下 SIGTERM 不可靠，
// 靠 stdin 通知子进程自行清理。写失败时挂个空 error 监听吞掉 EPIPE，不弹未捕获错误。
function sendStdinSignal(signal) {
  const p = currentProcess;
  if (p?.stdin?.writable) {
    const onError = () => {};
    p.stdin.on('error', onError);
    p.stdin.write(signal + '\n');
    p.stdin.off('error', onError);
  }
}

// 延迟强杀当前子进程：等 6s 让子进程 doCleanup 先落盘进度再退出（v1.3.28 放宽到 6s）。
// 只杀同一个进程：取消/跳过/停止后若用户已快速开始新任务，currentProcess 已换，
// 不能再按旧引用强杀，否则会误杀新任务并残留一个空引用。
function scheduleForceKill() {
  const proc = currentProcess;
  setTimeout(() => {
    if (currentProcess === proc) { currentProcess.kill(); currentProcess = null; }
  }, 6000);
}

// CDP proxy & Chrome 状态
let cdpProxyProcess = null;
let cdpStatus = { state: 'initializing', message: '', chromePort: null };
// CDP 红点错误文案：渲染端按「未开启远程调试」判断需用户开启并自动重试，主进程两处设置保持一致
const CDP_ERR_REMOTE_DEBUG_OFF = 'Chrome 未开启远程调试';

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 660,
    height: 730,
    resizable: false,
    title: 'BOSS直聘候选人AI评分助手',
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
  // 扫描阶段（滚动列表收集候选人）：实时显示扫描进度，提示语换成「正在扫描候选人列表」
  const scanCount = line.match(/扫描进度:\s*(\d+)\/(\d+) 人/);
  if (scanCount) {
    return { progress: 0, message: `正在扫描候选人列表… ${scanCount[1]}/${scanCount[2]} 人` };
  }
  const scanAll = line.match(/扫描进度:\s*(\d+) 人/);
  if (scanAll) {
    return { progress: 0, message: `正在扫描候选人列表… 已发现 ${scanAll[1]} 人` };
  }
  // 提取阶段（逐人读取简历）：直接显示脚本输出的进度行（如 [12/40] 张三 (geekId=xxx)）
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
function runScript(scriptName, args, step, parseFn, extraEnv = {}, taskType = '') {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptPath = resolve(UNPACKED_ROOT, 'scripts', scriptName);
    const procCwd = app.isPackaged ? OUTPUT_DIR : APP_ROOT;

    termLog(`[main] start: scripts/${scriptName} ${args.join(' ')}`);
    const stepIntro = { 1: '正在扫描候选人列表…', 2: '正在用 AI 为候选人评分…', 3: '正在生成 Excel…' };
    sendProgress(step, 'running', 0, stepIntro[step] || `启动 ${scriptName}…`);

    const proc = spawn(process.execPath, [scriptPath, ...args], {
      cwd: procCwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv, ELECTRON_RUN_AS_NODE: '1' },
    });

    currentProcess = proc;
    proc._taskType = taskType; // 显式任务类型（'extract'/'export'/'greet'），供「暂停/继续提取」校验当前进程确为提取脚本（导出/打招呼也复用 currentProcess）

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
          // 脚本原始日志默认只进日志；只有「异常/失败」类才显示到界面，避免技术噪音上屏
          const t = line.trim();
          if (/❌|失败|错误|异常|无法|未找到|跳过/.test(t)) {
            sendProgress(step, 'running', null, t);
          }
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

// ===== Chrome 启动助手 =====
// 曾用特殊启动参数（禁用窗口遮挡/后台冻结渲染）来实现「边用边跑」模式，
// 实测该模式对截图/复制并无帮助（同窗口切后台标签页依旧失效，开两个 Chrome 窗口才有效），
// 已整体移除——Chrome 照常由用户自己打开，这里只保留「未运行时自动拉起」的便利。

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

// 提取脚本报「未找到已打开的XX页」时，按报错里的页名给出对应的操作提示
// （页名关键词需与 scripts/extract-*.mjs 的报错文案保持一致）
const PAGE_NOT_OPEN_HINTS = [
  ['推荐牛人页', 'BOSS直聘「推荐牛人」页并设置好筛选条件'],
  ['搜索页', 'BOSS直聘「搜索」页并设置好筛选条件'],
  ['沟通页', 'BOSS直聘「沟通」页并选择「未读」'],
];

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

// ===== AI 评分：提取与评分并行 =====
// v1.5.12：步骤1（提取）与步骤2（AI评分）并行。提取子进程每 5 人把已提取候选人写入
// .extract-progress.json，评分器轮询它，攒够 POOL_START_THRESHOLD 人后开始边提取边评分；
// 提取结束后读最终 zhipin-candidates.json 收尾补评。
// 用户确认的参数：并发批数从 6 降到 5（更保守防限流）；默认开启并行，不加开关。
const BATCH_SIZE = 3;              // 每批候选人数（保持 3 人一批，用户决定）
const SCORE_CONCURRENCY = 5;       // 同时并发批数（5批×3人≈15人，用户决定，原 6）
const POLL_MS = 1500;              // 提取过程中轮询进度文件的间隔
const POOL_START_THRESHOLD = 15;   // 提取到 15 人即开始边提取边评分（用户决定）
const FLUSH_TIMEOUT = 30000;       // 不满一批的尾巴等待 30s 就放行，避免一直卡到提取结束
const MAX_RESUME_LEN = 4000;       // 每份简历截断，避免 prompt 过长

// 候选人的稳定标识：geekId 优先（Boss 候选人唯一 id），缺失时退回 index 字段/数组下标
function candidateKeyOf(c, idx = 0) {
  return c.geekId || ('idx:' + (c.index ?? idx));
}

// 从解析后的数据里取「非空候选人数组」：兼容 {candidates:[...]} 和裸数组两种形状
function nonEmptyCandidates(raw) {
  const arr = Array.isArray(raw) ? raw : raw?.candidates;
  return Array.isArray(arr) && arr.length > 0 ? arr : null;
}

// 轻量判断：目录里是否有「可能含简历数据」的候选人文件（只看文件是否存在，不解析内容）。
// 给 has-scorable-data / 历史归档扫描 / 历史列表评分按钮这些「只要判断有没有」的场景用；
// 真正要拿数据时再走 restoreScorableCandidates，避免为布尔值做全量 JSON 解析 + 克隆候选人。
function hasScorableCandidates(dirPath) {
  return existsSync(resolve(dirPath, 'zhipin-candidates.json'))
    || existsSync(resolve(dirPath, '.extract-progress.json'))
    || existsSync(resolve(dirPath, 'scored-candidates.json'));
}

// 清掉候选人的旧评分数值字段，确保重新评分时不会被当作「已评过」而跳过
// （finalizeScoring 用 unscored = candidates.filter(c => typeof c.jobRelevanceScore !== 'number') 过滤）。
// 返回克隆后的新数组，不改动源对象。
function stripScoreFields(candidates) {
  return candidates.map((c) => {
    const clone = { ...c };
    delete clone.jobRelevanceScore;
    delete clone.jobRelevanceComment;
    delete clone.matchScore;
    delete clone.totalScore;
    delete clone.recommendationLevel;
    delete clone.passed;
    return clone;
  });
}

// 从某个运行目录解析「可用于评分」的候选人数据（任何含简历数据的来源）。
// 优先级：zhipin-candidates.json（完整提取）→ .extract-progress.json（提了一半的进度）→
// scored-candidates.json（已评分结果，仍带简历文本）。JSON 读到写一半/损坏按「无数据」处理。
// 只负责解析、不做加工（克隆/清分），需要干净候选人时由 restoreScorableCandidates 负责。
function readScorableCandidates(dirPath) {
  const pick = (name, kind) => {
    const p = resolve(dirPath, name);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const candidates = nonEmptyCandidates(raw);
      if (!candidates) return null;
      // 来源统一取「文件自带 source 优先，其次运行元数据，最后兜底 chat」；
      // || 短路避免每次都读 .run-meta.json（推荐/搜索脚本已把 source 写进数据文件）
      const source = raw?.source || readRunMeta(dirPath)?.source || 'chat';
      return { source, candidates, kind };
    } catch { return null; }
  };
  return pick('zhipin-candidates.json', 'zhipin')
    || pick('.extract-progress.json', 'progress')
    || pick('scored-candidates.json', 'scored');
}

// 把某目录里可评分的候选人数据还原到目标路径：zhipin 原样复制（加自拷贝守卫），
// 进度/评分数据则合成 { source, candidates } 标准格式写入（评分数据重评时清掉旧分数字段）。
// 返回 { source, count } 或 null（无数据/解析失败，由调用方自行提示具体原因）。
function restoreScorableCandidates(srcDir, destPath) {
  const data = readScorableCandidates(srcDir);
  if (!data) return null;
  if (data.kind === 'zhipin') {
    const src = resolve(srcDir, 'zhipin-candidates.json');
    if (resolve(src) !== resolve(destPath)) copyFileSync(src, destPath);
  } else {
    writeFileSync(destPath, JSON.stringify({ source: data.source, candidates: stripScoreFields(data.candidates) }, null, 2), 'utf-8');
  }
  return { source: data.source, count: data.candidates.length };
}

// 构建某岗位的批量评分 prompt 生成器（含模板/JD 文件加载）。
// getPoolCandidates: 返回该岗位当前所有已提取候选人（供沟通页无 JD 文件时从简历岗位描述兜底）。
function createPositionPromptBuilder(positionName, extractSource, getPoolCandidates) {
  const useWithJd = extractSource !== 'chat';
  const templateName = useWithJd ? 'scoring-prompt-with-jd.txt' : 'scoring-prompt-chat.txt';
  const templatePath = resolve(UNPACKED_ROOT, 'config', templateName);
  let template;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    throw new Error(`未找到评分模板: ${templatePath}`);
  }
  const dimensionsText = apiConfig.dimensions || '';
  const screeningCriteriaText = apiConfig.screeningCriteria || '';
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

  return function buildBatchPrompt(cands) {
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
      let jd = jdContent;
      if (!jd && typeof getPoolCandidates === 'function') {
        // 沟通页无 JD 文件时：从已提取候选人里取岗位描述作为 JD 文本
        for (const c of getPoolCandidates()) {
          if (c.jobDescription?.description) {
            jd = `${c.jobDescription.jobName || ''} ${c.jobDescription.salary || ''}\n\n${c.jobDescription.description}`.trim();
            break;
          }
        }
      }
      p = template
        .replace('{jdText}', jd || dimensionsText || '(无岗位JD描述)');
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
  };
}

// 执行一批评分（含失败重试/整批失败拆单重试/设 0 分兜底），原地写入 batch 内候选人的分数。
// run: { signal, buildBatchPrompt, onBatchDone(batch) }
async function scoreOneBatch(batch, run) {
  if (cancelled) return;

  const prompt = run.buildBatchPrompt(batch);
  const batchNames = batch.map(c => c.basicInfo?.name || c.geekId || '未知').join('、');
  termLog(`[AI评分] 评分批: ${batchNames}`);

  // 最多重试 2 次
  let lastError = null;
  for (let retry = 0; retry <= 2; retry++) {
    if (cancelled) return;
    try {
      const text = await callClaudeAPI(prompt, { signal: run.signal });
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
      if (run.signal.aborted) throw err;
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
        const singlePrompt = run.buildBatchPrompt([c]);
        const nm = c.basicInfo?.name || c.geekId || '未知';
        let singleError = null;
        for (let retry = 0; retry <= 2; retry++) {
          if (cancelled) return;
          try {
            const text = await callClaudeAPI(singlePrompt, { signal: run.signal });
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
            if (run.signal.aborted) throw err;
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

  run.onBatchDone(batch);
}

// 滑动窗口并发执行一批批的评分（并发上限 SCORE_CONCURRENCY）
async function runBatchWindow(batches, run) {
  const totalBatches = batches.length;
  const executing = new Set();
  for (let i = 0; i < Math.min(SCORE_CONCURRENCY, totalBatches); i++) {
    if (cancelled) break;
    const promise = scoreOneBatch(batches[i], run).finally(() => executing.delete(promise));
    executing.add(promise);
  }
  for (let i = SCORE_CONCURRENCY; i < totalBatches; i++) {
    if (cancelled) break;
    await Promise.race(executing);
    if (cancelled) break;
    const promise = scoreOneBatch(batches[i], run).finally(() => executing.delete(promise));
    executing.add(promise);
  }
  await Promise.allSettled(executing);
}

// 全量评分一组候选人（按岗位分组、3 人一批、并发窗口），原地写入分数。
// 用于「跳过提取直接评分」与收尾补评。
async function scoreCandidateList(candidates, extractSource, { signal, onBatchDone } = {}) {
  const groups = {};
  for (const c of candidates) {
    const job = c.positionInfo?.appliedJob || '未知岗位';
    if (!groups[job]) groups[job] = [];
    groups[job].push(c);
  }
  const positionNames = Object.keys(groups);
  for (const positionName of positionNames) {
    if (cancelled) break;

    const group = groups[positionName];
    const withResume = group.filter(c => c.resumeText);

    // 无简历的直接设 0 分
    for (const c of group) {
      if (!c.resumeText) {
        c.jobRelevanceScore = 0;
        c.jobRelevanceComment = '无在线简历';
        onBatchDone?.([c]);
      }
    }

    if (withResume.length === 0) continue;

    const buildBatchPrompt = createPositionPromptBuilder(positionName, extractSource, () => withResume);
    const batches = [];
    for (let i = 0; i < withResume.length; i += BATCH_SIZE) {
      batches.push(withResume.slice(i, i + BATCH_SIZE));
    }
    termLog(`[AI评分] 岗位 "${positionName}": ${withResume.length} 人，${batches.length} 批，并发 ${SCORE_CONCURRENCY} 批`);
    await runBatchWindow(batches, { signal, buildBatchPrompt, onBatchDone });
  }
}

// ===== 提取与评分并行：增量评分器 =====
// ctx: { outputDir, source, extractResult, skipIncremental, seedScores, scoringError }
//   - extractResult: 由 runPipeline 在提取子进程关闭/跳过恢复完成时设置 {ok:true}；失败设 {ok:false}
//   - skipIncremental: 跳过提取直接评分时为 true（不轮询进度文件，等 extractResult 后直接收尾）
//   - seedScores: 继续提取时为 true，用上次 scored-candidates.json 播种，只补评新增候选人
async function runIncrementalScoring(ctx) {
  const { outputDir, source } = ctx;
  const progressPath = resolve(outputDir, '.extract-progress.json');
  const finalPath = resolve(outputDir, 'zhipin-candidates.json');
  tailFlushRequested = false; // 本轮评分开始先清零：上次暂停残留的置位不该影响本轮（在下方循环里消费）

  // 可取消的 AI 评分：创建 AbortController，所有 API 请求共享
  aiAbortController = new AbortController();
  const signal = aiAbortController.signal;

  // 步骤1 一开始提取，步骤2 就同步显示等待提示（跳过提取直接评分时不显示，直接从收尾总览开始）
  if (!ctx.skipIncremental) {
    sendProgress(2, 'running', 0, `等待更多候选人（满 ${POOL_START_THRESHOLD} 人开始）`);
  }

  const scoredRefs = new Map();      // 候选人key -> 已评分对象（快照，分数/评语在对象上）
  const seenRefs = new Map();        // 候选人key -> 已提取对象（快照）
  const dispatchingRefs = new Set(); // 已进入批队列（排队或在飞）的 key，防止重复收集
  const promptBuilders = new Map();  // 岗位 -> buildBatchPrompt（懒加载缓存）
  const dispatchQueue = [];          // 待调度批次 [{cands, buildBatchPrompt}]
  const executing = new Set();       // 在飞批 promise（并发上限 SCORE_CONCURRENCY）
  const tailWait = new Map();        // 岗位 -> 尾巴首现时间（FLUSH 放行用）
  let lastSentKey = '';              // 进度去重
  let lastPollAt = 0;

  // 继续提取：把上次已评的分数播种进 scored 表，只补评新增候选人
  if (ctx.seedScores) {
    try {
      const prevPath = resolve(outputDir, 'scored-candidates.json');
      if (existsSync(prevPath)) {
        const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
        const list = prev.candidates || prev;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (typeof c.jobRelevanceScore === 'number') scoredRefs.set(candidateKeyOf(c, i), c);
        }
        termLog(`[AI评分] 已播种上次评分 ${scoredRefs.size} 人，只补评新增候选人`);
      }
    } catch (err) {
      termLog(`[AI评分] 播种上次评分失败: ${err.message}`, 'stderr');
    }
  }

  // —— 读进度文件（写一半/不存在本轮跳过） ——
  function readProgress() {
    try {
      if (!existsSync(progressPath)) return null;
      const raw = JSON.parse(readFileSync(progressPath, 'utf-8'));
      return Array.isArray(raw.candidates) ? raw.candidates : null;
    } catch {
      return null;
    }
  }

  // —— 并入新提取的候选人（去重；无简历的立即记 0 分，不占用 AI 调用） ——
  function absorb(candidates) {
    let added = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const key = candidateKeyOf(c, i);
      if (seenRefs.has(key)) continue;
      seenRefs.set(key, c);
      if (!c.resumeText) {
        c.jobRelevanceScore = 0;
        c.jobRelevanceComment = '无在线简历';
        scoredRefs.set(key, c);
      }
      added++;
    }
    return added;
  }

  // —— 进度上报（无变化不发，避免刷屏） ——
  function reportProgress() {
    const y = seenRefs.size;
    const x = scoredRefs.size;
    if (y === 0) return;
    // 没满 15 人：提示等待；满了但首批评分结果还没返回（x===0）：评分实际已开始，
    // 不能再显示「满 15 人开始」，否则会让人以为评分还没跑（renderer 据此把 ② 标灰）
    const msg = y < POOL_START_THRESHOLD
      ? `等待更多候选人（满 ${POOL_START_THRESHOLD} 人开始）`
      : x === 0
        ? `已满 ${POOL_START_THRESHOLD} 人，正在评分…`
        : `${x}/${y} 人`;
    const pct = Math.round((x / y) * 100);
    const key = pct + '|' + msg;
    if (key === lastSentKey) return;
    lastSentKey = key;
    sendProgress(2, 'running', pct, msg);
  }

  // —— 某岗位当前所有已提取候选人（沟通页 JD 兜底用） ——
  function seenForJob(job) {
    const list = [];
    for (const [, c] of seenRefs) {
      if ((c.positionInfo?.appliedJob || '未知岗位') === job) list.push(c);
    }
    return list;
  }

  // —— 某岗位的 prompt 生成器（懒加载 + 缓存） ——
  function builderFor(job) {
    let b = promptBuilders.get(job);
    if (!b) {
      b = createPositionPromptBuilder(job, source, () => seenForJob(job));
      promptBuilders.set(job, b);
    }
    return b;
  }

  // —— 收集待评分批次（每岗位 3 人一批；满阈值后；不满一批的尾巴超 FLUSH_TIMEOUT 放行） ——
  function collectBatches() {
    if (seenRefs.size < POOL_START_THRESHOLD) return [];
    const pendingByJob = {};
    for (const [key, c] of seenRefs) {
      if (scoredRefs.has(key) || dispatchingRefs.has(key)) continue;
      if (!c.resumeText) continue;
      const job = c.positionInfo?.appliedJob || '未知岗位';
      if (!pendingByJob[job]) pendingByJob[job] = [];
      pendingByJob[job].push(c);
    }
    const entries = [];
    const now = Date.now();
    for (const job of Object.keys(pendingByJob)) {
      const list = pendingByJob[job];
      const fullCount = Math.floor(list.length / BATCH_SIZE) * BATCH_SIZE;
      for (let i = 0; i < fullCount; i += BATCH_SIZE) {
        const batch = list.slice(i, i + BATCH_SIZE);
        for (const c of batch) dispatchingRefs.add(candidateKeyOf(c));
        entries.push({ cands: batch, buildBatchPrompt: builderFor(job) });
      }
      // 尾巴（不满一批）：等待 FLUSH_TIMEOUT 后放行，避免小尾巴一直卡到提取结束
      const tail = list.slice(fullCount);
      if (tail.length === 0) {
        tailWait.delete(job);
        continue;
      }
      const firstSeen = tailWait.get(job) ?? now;
      tailWait.set(job, firstSeen);
      // v1.8.3：用户点「暂停」时 tailFlushRequested 置位，零头立刻放行，让评分进度在暂停期间跟上提取的人数
      if (tailFlushRequested || now - firstSeen >= FLUSH_TIMEOUT) {
        for (const c of tail) dispatchingRefs.add(candidateKeyOf(c));
        entries.push({ cands: tail, buildBatchPrompt: builderFor(job) });
        tailWait.delete(job);
      }
    }
    return entries;
  }

  // —— 把排队批次调度到在飞集合（并发 ≤ SCORE_CONCURRENCY） ——
  function pump() {
    while (dispatchQueue.length > 0 && executing.size < SCORE_CONCURRENCY) {
      if (cancelled) return;
      const entry = dispatchQueue.shift();
      const run = {
        signal,
        buildBatchPrompt: entry.buildBatchPrompt,
        onBatchDone(batch) {
          for (const c of batch) scoredRefs.set(candidateKeyOf(c), c);
          reportProgress();
        },
      };
      const p = scoreOneBatch(entry.cands, run).finally(() => {
        executing.delete(p);
      });
      executing.add(p);
    }
  }

  // —— 收尾：以最终文件为唯一权威，合并已评分，补评差集，算派生字段并写结果 ——
  async function finalizeScoring() {
    if (cancelled) return;
    // 读最终文件（带小重试，防 Windows 刷盘延迟：脚本写文件后主进程立刻读可能读不到/读一半）
    let raw = null;
    for (let i = 0; i < 10; i++) {
      try {
        raw = JSON.parse(readFileSync(finalPath, 'utf-8'));
        if (raw && Array.isArray(raw.candidates || raw)) break;
      } catch {}
      if (cancelled) return;
      await sleep(500);
    }
    if (!raw) throw new Error('未找到 zhipin-candidates.json');
    const candidates = Array.isArray(raw.candidates) ? raw.candidates : raw;
    const extractSource = raw.source || source || 'chat';

    // 步骤2 收尾总览：共 X 人，分布在 Y 个岗位（只改提示文字、不动进度条）
    const jobCount = new Set(candidates.map(c => c.positionInfo?.appliedJob || '未知岗位')).size;
    sendProgress(2, 'running', undefined, `共 ${candidates.length} 人，${jobCount} 个岗位`);

    // 1) 合并增量阶段已评的分数（快照对象 → 最终对象）
    let merged = 0;
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const snap = scoredRefs.get(candidateKeyOf(c, i));
      if (snap && typeof snap.jobRelevanceScore === 'number') {
        c.jobRelevanceScore = snap.jobRelevanceScore;
        c.jobRelevanceComment = snap.jobRelevanceComment;
        merged++;
      }
    }
    termLog(`[AI评分] 收尾合并已评 ${merged}/${candidates.length} 人`);

    // 2) 补评差集（增量阶段没评到的，含提取结束时最后几个候选人）
    const unscored = candidates.filter(c => typeof c.jobRelevanceScore !== 'number');
    if (unscored.length > 0) {
      termLog(`[AI评分] 收尾补评 ${unscored.length} 人`);
      const countScoredNow = () => candidates.reduce((n, c) => n + (typeof c.jobRelevanceScore === 'number' ? 1 : 0), 0);
      await scoreCandidateList(unscored, extractSource, {
        signal,
        onBatchDone() {
          const scoredCount = countScoredNow();
          sendProgress(2, 'running', Math.round((scoredCount / candidates.length) * 100), `${scoredCount}/${candidates.length} 人`);
        },
      });
    } else if (!cancelled) {
      // 增量阶段已全部评完（无差集）：补一条人数提示，避免「总览 → 直接完成」没有人数
      sendProgress(2, 'running', 100, `${candidates.length}/${candidates.length} 人`);
    }
    if (cancelled) return;

    // 3) 派生字段 + 一次性写回 scored-candidates.json
    // 权威分数 = 从评语中解析各维度「独立得分×权重」程序化计算的加权基础分 - 其他扣分合计。
    // AI 手写的「匹配度评分」算术不可靠（实测多例手写分对不上公式），
    // 必须以评语内自带公式重算，保证与评语内容严格一致（打招呼等级过滤据此判断）。
    for (const c of candidates) {
      c.matchScore = computeMatchScoreFromComment(c.jobRelevanceComment) ??
        parseMatchScoreFromComment(c.jobRelevanceComment);
      c.totalScore = c.matchScore ?? (c.jobRelevanceScore || 0);
      // 学历硬性门槛兜底后，同步修正评语文字，避免「评语说不扣分、分数却扣了」的矛盾
      c.jobRelevanceComment = patchEducationDeductionComment(c.jobRelevanceComment);
      c.recommendationLevel = scoreToRecommendation(c.totalScore);
      c.passed = isPassed(c.totalScore);
    }
    const output = raw.candidates ? raw : { candidates: raw };
    writeFileSync(resolve(outputDir, 'scored-candidates.json'), JSON.stringify(output, null, 2), 'utf-8');
    termLog(`[AI评分] 完成，已写入 scored-candidates.json`);
    sendProgress(2, 'done', 100, 'AI 评分完成');
  }

  try {
    // —— 主循环：提取过程中轮询增量评分；提取结束收尾 ——
    while (true) {
      if (cancelled) {
        // 已在飞批由 cancel-extraction 的 abort 终止；等它们 settle，避免遗留未处理 rejection
        await Promise.allSettled([...executing]);
        return;
      }

      // 提取已结束（成功）：先把手头排队/在飞的批跑完，再收尾
      if (ctx.extractResult?.ok) {
        if (dispatchQueue.length > 0) pump();
        if (executing.size > 0) {
          await Promise.allSettled([...executing]);
          continue;
        }
        break;
      }
      // 提取失败：中止在飞请求并等它们 settle（不写结果文件，进度文件保留供继续提取）
      if (ctx.extractResult && !ctx.extractResult.ok) {
        try { aiAbortController.abort(); } catch {}
        await Promise.allSettled([...executing]);
        return;
      }
      // 无提取进行（跳过提取直接评分）：等 runPipeline 预置 extractResult（通常已就绪）
      if (ctx.skipIncremental) {
        await sleep(POLL_MS);
        continue;
      }

      // 正常增量轮询
      const now = Date.now();
      if (now - lastPollAt >= POLL_MS) {
        lastPollAt = now;
        const fresh = readProgress();
        if (fresh) {
          const added = absorb(fresh);
          if (added > 0) {
            const entries = collectBatches();
            if (entries.length > 0) dispatchQueue.push(...entries);
            reportProgress();
          }
        }
      }
      // v1.8.3：用户点「暂停」→ tailFlushRequested 置位，把手头不满一批的零头立刻派出去评分，
      // 暂停期间评分进度跟上提取人数（否则零头要等 FLUSH_TIMEOUT 30s 或再来人凑满一批）
      if (tailFlushRequested) {
        const flushEntries = collectBatches(); // collectBatches 内读取 flag 放行零头
        if (flushEntries.length > 0) {
          dispatchQueue.push(...flushEntries);
          reportProgress();
        }
        tailFlushRequested = false;
      }
      pump();

      // 等待：任一在飞批完成（好腾出并发位）或轮询时间到
      if (executing.size > 0) {
        await Promise.race([...executing].map(p => p.catch(() => {})).concat([sleep(POLL_MS)]));
      } else {
        await sleep(POLL_MS);
      }
    }

    // 提取结束 → 收尾
    await finalizeScoring();
  } finally {
    aiAbortController = null;
  }
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
// 在历史归档目录（output-YYYYMMDD-HHMM）里找最近一份含「可评分数据」的目录
// （完整提取数据 / 提取到一半的进度 / 已评分结果都算）。
// 用于「直接用上次数据评分（跳过提取）」：用户上一轮数据被归档后，仍能恢复出来直接重评分。
function findRecentArchiveWithScorable() {
  try {
    const parentDir = dirname(OUTPUT_DIR);
    const prefix = basename(OUTPUT_DIR) + '-';
    const dirs = readdirSync(parentDir)
      .filter((n) => n.startsWith(prefix))
      .sort() // 时间戳命名，字典序即时间序
      .reverse();
    for (const d of dirs) {
      if (hasScorableCandidates(resolve(parentDir, d))) {
        return { archiveDir: resolve(parentDir, d) };
      }
    }
  } catch {}
  return null;
}

// 历史归档目录名校验：必须形如 {输出目录名}-YYYYMMDD-HHMM，防止误删/误操作任意目录
function archiveDirNameMatches(name) {
  const baseName = basename(OUTPUT_DIR);
  return new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{4}$`).test(name);
}

// 读取某目录里记录的运行元数据（来源/岗位/数量），供继续提取还原环境
function readRunMeta(dir) {
  try {
    const metaPath = resolve(dir, '.run-meta.json');
    if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {}
  return null;
}

// 把一个历史归档目录还原为当前输出目录：先把当前输出目录挪开（若不为空），再改名还原。
// 返回 { ok } 或 { error }。
function restoreHistoryToOutput(dirPath) {
  try {
    if (existsSync(OUTPUT_DIR)) {
      const entries = readdirSync(OUTPUT_DIR);
      if (entries.length > 0) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        renameSync(OUTPUT_DIR, `${OUTPUT_DIR}-${stamp}`);
        termLog(`[resume] 已把当前输出目录归档: ${OUTPUT_DIR}-${stamp}`);
      }
    }
    renameSync(dirPath, OUTPUT_DIR);
    termLog(`[resume] 已还原历史目录为输出目录: ${OUTPUT_DIR}`);
    return { ok: true };
  } catch (err) {
    termLog(`[resume] 还原目录失败: ${err.message}`, 'stderr');
    return { error: `还原历史目录失败: ${err.message}` };
  }
}

async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '', enableCopy = true, resume = false) {
  cancelled = false;
  skipRecovered = false;

  // 运行期间阻止系统休眠/显示器关闭（v1.3.27）：
  // 同事实测跑一批会因系统休眠后锁屏而暂停。powerSaveBlocker('prevent-display-sleep')
  // 让显示器不自动关闭、系统不自动睡眠，从而不会触发"唤醒后要重新登录"的锁屏。
  // 注意：公司 IT 强制锁屏策略（域策略/屏保锁定）压不住，那种需联系 IT 或运行前手动设置。
  const keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  try {
    // 归档旧输出目录（在主进程做，避免子进程 rename 时 EBUSY）。
    // resume 模式：历史目录已还原为 OUTPUT_DIR，续跑要保留进度文件，不再归档。
    // 只有旧目录里有真实数据才归档；只有 .run-meta.json 等残留时不归档，避免产生空批次文件夹。
    // v1.8.3：改「逐个文件归档」而非「整目录改名」。Windows 下只要目录里任一文件被占用
    // （最常见：Excel 还开着上次导出的 candidates.xlsx），整目录 rename 就会 EPERM，
    // 导致旧一批的 .extract-progress.json 留在原地——评分器一开跑就把上一轮的历史简历抢先开评。
    if (!skipExtract && !resume && existsSync(OUTPUT_DIR)) {
      try {
        const entries = readdirSync(OUTPUT_DIR);
        const hasRealData = entries.some((n) => n !== '.run-meta.json');
        if (hasRealData) {
          archiveOldOutput(OUTPUT_DIR, false); // 跳过被锁文件，其余照常归档，日志随主进程走 console
        }
      } catch (e) {
        termLog(`[main] 归档旧输出目录跳过: ${e.message}`, 'stderr');
      }
      // 兜底：万一归档没挪干净（个别文件仍被占用留在原地），清掉评分器会误读的残留进度/扫描缓存。
      // 新开一轮的进度必须从零开始，绝不能沿用上一批候选人为新岗位抢先开评。
      // 复用 extract-common 的 cleanupCacheFiles（参数传目录内任一文件路径，它据此定位目录）
      cleanupCacheFiles(resolve(OUTPUT_DIR, 'zhipin-candidates.json'));
    }

    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    // 评分型运行（skipExtract）不改写批次元数据：它只读 OUTPUT_DIR 里已有的数据，
    // 界面当前选的来源/岗位未必等于这批数据的真实来源。以前这里无条件重写 .run-meta.json，
    // 实测「直接用上次数据评分」会把推荐牛人页批次盖成 chat / count=0 / job 空——
    // 历史记录的来源标签、以及后续「继续提取」读到的还原配置都会跟着错。
    // 有旧 meta 时沿用其 source/job（评分提示词、打招呼开关也按真实来源走）并保留原 meta 不覆盖；
    // 没有旧 meta（首次评分兜底）才按传入参数补写。
    let prevMeta = null;
    if (skipExtract) {
      prevMeta = readRunMeta(OUTPUT_DIR);
      if (prevMeta?.source) source = prevMeta.source;
      if (prevMeta?.job && !job) job = prevMeta.job;
    }
    if (!(skipExtract && prevMeta)) {
      try {
        writeFileSync(resolve(OUTPUT_DIR, '.run-meta.json'), JSON.stringify({
          source, job: job || '', count, extractAll, startedAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
      } catch {}
    }

    const isRecommendMode = source === 'recommend' || source === 'recommend-attach';
    const isSearchMode = source === 'search';

    // ===== 步骤 1 + 2 并行 =====
    // v1.5.12：提取子进程跑步骤1的同时，评分器轮询 .extract-progress.json 边提取边评分；
    // 提取结束（成功/失败/跳过）后由评分器统一收尾（成功写 scored-candidates.json，失败不写）。
    let extractError = null; // 提取失败原因（先让评分器退出，再抛出）

    let scriptName;
    let pageLabel;
    const isAttach = source === 'recommend-attach' || source === 'search';
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

    // v1.4.6: Chrome 未运行时，自动启动 Chrome 并打开对应页面，
    // 提示用户设置好筛选条件后再次点击「开始提取分析」（不再直接报连接失败）。
    // 检查需在启动评分器之前完成，避免提前 return 时评分器空转。
    if (!skipExtract && !(await isChromeRunning())) {
      const openUrl = getSourcePageUrl(source);
      const launchRes = await launchChrome({ openUrl });
      if (launchRes.ok) {
        termLog(`[main] Chrome 未运行，已自动启动并打开 ${pageLabel}页: ${openUrl}`);
        sendProgress(1, 'idle', 0,
          `检测到 Chrome 未运行，已自动启动并打开${pageLabel}页。`
          + '请等待页面加载、登录 BOSS直聘并设置好筛选条件后，再次点击「开始提取分析」。');
        return;
      }
      termLog(`[main] Chrome 未运行，自动启动失败: ${launchRes.message}`, 'stderr');
    }

    // —— 启动并行评分器（提取过程中边提取边评分） ——
    const scoreCtx = {
      outputDir: OUTPUT_DIR,
      source,
      extractResult: null,          // 提取分支由下方设置；跳过提取分支预置 {ok:true}
      skipIncremental: skipExtract, // 跳过提取 → 不轮询进度文件，直接全量评分
      seedScores: resume,           // 继续提取 → 用上次评分播种，只补评新增候选人
      scoringError: null,
    };
    const scoringPromise = runIncrementalScoring(scoreCtx).catch((err) => {
      scoreCtx.scoringError = err;
    });

    if (!skipExtract) {
      sendProgress(1, 'running', 0, extractAll ? `正在扫描候选人列表 (${pageLabel}页)…` : '正在扫描候选人列表…');
      const extractArgs = extractAll
        ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
        : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
      if (job) {
        extractArgs.push('--job', job);
      }
      if (isAttach) {
        extractArgs.push('--attach');
      }
      if (resume) {
        extractArgs.push('--resume'); // v1.5.0: 继续提取，跳过已完成项
      }
      extractArgs.push('--enable-copy', enableCopy ? '1' : '0'); // v1.4.4 模拟复制开关

      let extractPromise;
      try {
        extractPromise = runScript(scriptName, extractArgs, 1, parseExtractProgress, {}, 'extract');
      } catch (err) {
        scoreCtx.extractResult = { ok: false, error: err };
        extractError = err;
      }
      if (extractPromise) {
        try {
          await extractPromise;
          scoreCtx.extractResult = { ok: true };
          if (!skipRecovered) sendProgress(1, 'done', 100, '候选人信息提取完成');
        } catch (err) {
          if (skipToScoring) {
            skipToScoring = false;
            skipRecovered = true;
            // 检查是否已有完整输出文件（脚本可能在 kill 前已完成）
            const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
            if (existsSync(candidatesPath)) {
              termLog('[main] 跳过提取，但 zhipin-candidates.json 已存在，直接使用');
              sendProgress(1, 'done', 100, '已跳过提取步骤');
              sendProgress(2, 'running', undefined, '已跳过提取，正在完成剩余评分…');
              scoreCtx.extractResult = { ok: true };
            } else {
              // 复用同一套「可评分数据恢复」逻辑：把 OUTPUT_DIR 里的进度/评分数据还原成标准候选人文件
              termLog('[main] 用户跳过提取，尝试从已有数据恢复');
              const restored = restoreScorableCandidates(OUTPUT_DIR, candidatesPath);
              if (!restored) {
                termLog('[main] 跳过提取失败：没有可恢复的候选人数据');
                sendError({ message: '暂无已提取的候选人数据，无法跳过。请等待提取到足够数据后再试。' });
                scoreCtx.extractResult = { ok: false, error: err };
                await scoringPromise;
                return;
              }
              termLog(`[main] 从已有数据恢复 ${restored.count} 名候选人`);
              sendProgress(1, 'done', 100, `已跳过提取，从进度恢复 ${restored.count} 人数据`);
              sendProgress(2, 'running', undefined, '已跳过提取，正在完成剩余评分…');
              scoreCtx.extractResult = { ok: true };
            }
          } else {
            // 提取失败：让评分器静默退出（不写结果文件），随后抛出原因
            scoreCtx.extractResult = { ok: false, error: err };
            extractError = err;
          }
        }
      }

      if (cancelled) {
        scoreCtx.extractResult = { ok: false, error: '已取消' };
        await scoringPromise;
        throw new Error('已取消');
      }

      // 等评分器收尾（提取成功 → 合并增量评分+补评写结果；提取失败 → 静默退出）
      await scoringPromise;
      if (cancelled) throw new Error('已取消');
      if (extractError) throw extractError;
      if (scoreCtx.scoringError) throw scoreCtx.scoringError;
    } else {
      // v1.4.8: 「直接用上次数据评分（跳过提取）」——若当前输出目录没有完整的候选人文件，
      // 依次从当前目录的进度/评分数据、最近一次历史归档里恢复（含只提取了一半就取消的数据）
      const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
      if (!existsSync(candidatesPath)) {
        // 数据源按优先级排：当前目录 → 最近一份含数据的归档；命中第一个能恢复的就用
        const sources = [OUTPUT_DIR];
        const found = findRecentArchiveWithScorable();
        if (found) sources.push(found.archiveDir);
        let restored = null;
        for (const srcDir of sources) {
          restored = restoreScorableCandidates(srcDir, candidatesPath);
          if (restored) {
            termLog(`[main] 从数据目录恢复可评分数据: ${srcDir}`);
            sendProgress(1, 'running', 30, srcDir === OUTPUT_DIR ? '正在恢复上次的数据…' : '正在从上次提取的数据恢复…');
            break;
          }
        }
        if (!restored) {
          // 无数据：评分器无意义，先让它退出再报错
          scoreCtx.extractResult = { ok: false, error: 'no data' };
          await scoringPromise;
          throw new Error('未找到已提取的候选人数据。请先点「开始提取分析」完成提取，或用上次跑完的数据。');
        }
      }
      sendProgress(1, 'done', 100, '已跳过提取，直接用已有数据评分');
      scoreCtx.extractResult = { ok: true };
      await scoringPromise;
      if (cancelled) throw new Error('已取消');
      if (scoreCtx.scoringError) throw scoreCtx.scoringError;
    }

    // 步骤 3: 导出
    sendProgress(2, 'done', 100, 'AI 评分完成');
    sendProgress(3, 'running', 0, '正在导出 Excel…');
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) throw new Error(`未找到评分结果文件: ${scoredPath}`);

    // 每次导出前重置邮件结果，避免残留上一次的状态
    exportMailResult = { status: 'none', to: '', error: '' };

    // 构建导出参数：若有 emailPrefix，传给导出脚本自动发邮件
    let exportArgs = ['--input', scoredPath];
    const smtpEnv = {};
    if (apiConfig.emailPrefix) {
      if (!apiConfig.smtpPass) {
        throw new Error('未配置邮箱密码：请到「设置」填写发件邮箱的密码后再发送邮件（公司邮箱若开启了三方客户端安全密码，要填邮箱设置里获取的"客户端安全密码"，不是登录密码）');
      }
      let emailSubject = '候选人评分结果';
      if (isRecommendMode) emailSubject = '推荐牛人评分结果';
      else if (isSearchMode) emailSubject = '搜索页评分结果';
      // 发件邮箱 = 收件邮箱 = 填的邮箱（必须填完整邮箱，含 @；工具会分享给不同公司使用，不再自动补域名）
      const emailUser = apiConfig.emailPrefix.trim();
      if (!emailUser.includes('@')) {
        throw new Error('「邮件通知」的邮箱请填写完整地址（含 @），例如 hr@example.com，否则无法发送邮件');
      }
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
    await runScript('export-candidates.mjs', exportArgs, 3, parseExportProgress, smtpEnv, 'export');
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
    } else if (err.message.includes('未找到已打开的')) {
      // 对应来源页面没打开：脚本退出码 + 页名 + URL 那串对用户太长又重复（主界面上方本来就有对应提示），
      // 这里只弹一句动作指引。不再自动重启 Chrome——那会关掉用户标签页。
      const hit = PAGE_NOT_OPEN_HINTS.find(([kw]) => err.message.includes(kw));
      const pageHint = hit ? hit[1] : '对应页面';
      sendError({ message: `请先在 Chrome 中打开 ${pageHint}，再点击「重试」。` });
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
    const threshold = thresholdForLevel(level);
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
  let greetDoneCount = 0; // 已处理的候选人计数（用于进度条真实推进）
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
    proc._taskType = 'greet';

    // 解析 stdout 中的打招呼进度
    proc.stdout.on('data', (data) => {
      const lines = decodeBuffer(data).split('\n').filter(Boolean);
      for (const line of lines) {
        termLog(`[greet] ${line}`);

        // GREET_STATUS: 单条结果
        const statusMatch = line.match(/^GREET_STATUS:(.+?)\|(.+?)\|(.+?)\|(.+)/);
        if (statusMatch) {
          greetDoneCount++;
          sendGreetProgress(statusMatch[4], greetDoneCount, totalTargets);
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
          cdpStatus = { state: 'error', message: CDP_ERR_REMOTE_DEBUG_OFF };
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
          cdpStatus = { state: 'error', message: CDP_ERR_REMOTE_DEBUG_OFF };
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
    if (hasRunningTask()) return { error: '已有任务运行中' };
    const count = opts?.count ?? 20;
    const skipExtract = opts?.skipExtract || false;
    const extractAll = opts?.extractAll || false;
    const source = opts?.source || 'chat';
    const job = opts?.job || '';
    const enableCopy = opts?.enableCopy !== false; // v1.4.4 模拟复制开关，默认开启
    runPipeline(count, skipExtract, extractAll, source, job, enableCopy);
    return { ok: true };
  });

  // 判断是否还有可用的上次候选人数据（当前目录或最近归档，含提取一半的进度/已评分结果），
  // 决定「直接用上次数据评分」按钮是否可点
  ipcMain.handle('has-scorable-data', () => {
    if (hasScorableCandidates(OUTPUT_DIR)) return true;
    return !!findRecentArchiveWithScorable();
  });

  ipcMain.handle('cancel-extraction', () => {
    cancelled = true;
    if (currentProcess) {
      // 写入 stdin 通知子进程自行清理（Windows 下 SIGTERM 不可靠）
      sendStdinSignal('CANCEL');
      // 等 6s 让子进程 doCleanup 先落盘进度再退出，超时强制杀
      scheduleForceKill();
    }
    if (aiAbortController) { aiAbortController.abort(); aiAbortController = null; }
    return { ok: true };
  });

  ipcMain.handle('skip-extraction', () => {
    skipToScoring = true;
    if (currentProcess) {
      sendStdinSignal('CANCEL');
      scheduleForceKill();
    }
    return { ok: true };
  });

  // 暂停/继续 步骤1 提取（仅对提取脚本生效；导出/打招呼进程的 currentProcess 被 _taskType 守卫排除）
  ipcMain.handle('pause-extraction', () => {
    if (currentProcess?._taskType !== 'extract') return { ok: false, reason: 'no-extract-process' };
    sendStdinSignal('PAUSE');
    tailFlushRequested = true; // v1.8.3：让增量评分器把手头不满一批的零头立刻评完（进度跟上暂停点）
    return { ok: true };
  });

  ipcMain.handle('resume-current-extraction', () => {
    if (currentProcess?._taskType !== 'extract') return { ok: false, reason: 'no-extract-process' };
    sendStdinSignal('RESUME');
    return { ok: true };
  });

  // 批量打招呼
  ipcMain.handle('start-greeting', (_event, opts) => {
    if (hasRunningTask()) return { error: '已有任务运行中' };
    const level = opts?.level ?? 4;
    const source = opts?.source || 'recommend';
    runGreeting(level, source);
    return { ok: true };
  });

  ipcMain.handle('cancel-greeting', () => {
    cancelled = true;
    if (currentProcess) {
      sendStdinSignal('CANCEL');
      scheduleForceKill();
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
      for (const c of candidates) {
        const score = c.totalScore ?? c.jobRelevanceScore ?? 0;
        if (score >= TIER_THRESHOLDS[5]) counts[5]++;
        if (score >= TIER_THRESHOLDS[4]) counts[4]++;
        if (score >= TIER_THRESHOLDS[3]) counts[3]++;
        if (score >= TIER_THRESHOLDS[2]) counts[2]++;
        counts[0] = candidates.length;
      }
      return { available: true, total: candidates.length, counts };
    } catch {
      return { available: false, total: 0, counts: {} };
    }
  });

  // 完成页结果可视化：读取最近一次评分结果，返回统计与候选人明细
  ipcMain.handle('get-scoring-results', () => {
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) return { available: false };
    try {
      const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
      const candidates = raw.candidates || raw;
      if (!Array.isArray(candidates) || candidates.length === 0) return { available: false };

      const tiers = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      let passed = 0;
      let sum = 0;
      const list = candidates.map((c) => {
        const score = c.totalScore ?? c.jobRelevanceScore ?? 0;
        const tier = scoreToTier(score);
        tiers[tier]++;
        if (isPassed(score)) passed++;
        sum += score;
        return {
          name: c.basicInfo?.name || c.geekId || '未知',
          position: c.positionInfo?.appliedJob || '',
          score,
          tier,
          level: c.recommendationLevel ?? scoreToRecommendation(score),
          passed: c.passed ?? isPassed(score),
          comment: c.jobRelevanceComment || '',
        };
      });
      // 分数从高到低排序，方便直接看到最值得打招呼的人
      list.sort((a, b) => b.score - a.score);
      return {
        available: true,
        total: candidates.length,
        passed,
        avgScore: Math.round((sum / candidates.length) * 10) / 10,
        passRate: Math.round((passed / candidates.length) * 1000) / 10,
        tiers,
        candidates: list,
      };
    } catch {
      return { available: false };
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

  // ISO 时间 → 「YYYY-MM-DD HH:mm」本地时间显示（历史记录用）
  function isoToDisplayTime(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d.getTime())) return null;
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch { return null; }
  }

  // v1.5.0: 历史记录抽屉 —— 列出所有历史归档批次（含当前输出目录里的未完成批次）
  ipcMain.handle('list-history', () => {
    const parentDir = dirname(OUTPUT_DIR);
    const list = [];
    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const isCurrent = entry.name === basename(OUTPUT_DIR);
        // 目录里是否有真实数据（有才展示；只有 .run-meta.json 的空批次不展示）
        const dirHasData = existsSync(resolve(parentDir, entry.name, '.extract-progress.json'))
          || existsSync(resolve(parentDir, entry.name, 'zhipin-candidates.json'))
          || existsSync(resolve(parentDir, entry.name, 'scored-candidates.json'))
          || existsSync(resolve(parentDir, entry.name, 'candidates.xlsx'));
        if (isCurrent) {
          // 当前输出目录只在有数据时才展示（否则是首次使用前的空目录）
          if (!dirHasData) continue;
        } else if (!archiveDirNameMatches(entry.name)) {
          continue;
        } else if (!dirHasData) {
          // 空归档批次（运行没产出任何数据）不展示，避免历史记录里混入空壳批次
          continue;
        }
        const dir = resolve(parentDir, entry.name);
        const candidatesPath = resolve(dir, 'zhipin-candidates.json');
        const scoredPath = resolve(dir, 'scored-candidates.json');
        const progressPath = resolve(dir, '.extract-progress.json');
        const hasCandidates = existsSync(candidatesPath);
        const hasScored = existsSync(scoredPath);
        const hasProgress = existsSync(progressPath);
        const info = {
          name: entry.name,
          path: dir,
          isCurrent,
          hasCandidates,
          hasScored,
          hasProgress,
          hasExcel: existsSync(resolve(dir, 'candidates.xlsx')),
          hasScorable: hasCandidates || hasScored || hasProgress, // 有简历数据就能评分（完整/进度/已评分均可），用已算好的存在性判断，避免再解析候选人大文件
        };
        const meta = readRunMeta(dir);
        if (meta) info.meta = meta;
        // 显示时间：归档名带 YYYYMMDD-HHMM；当前目录用元数据的 startedAt
        // （没有元数据时退回批次里最新数据文件的修改时间，避免显示「时间未知」）
        const stampMatch = entry.name.match(/(\d{8})-(\d{4})$/);
        if (stampMatch) {
          const [, ymd, hm] = stampMatch;
          info.time = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)} ${hm.slice(0, 2)}:${hm.slice(2, 4)}`;
        } else if (meta?.startedAt) {
          info.time = isoToDisplayTime(meta.startedAt);
        }
        if (!info.time) {
          try {
            let t = 0;
            for (const f of ['candidates.xlsx', 'scored-candidates.json', 'zhipin-candidates.json', '.extract-progress.json']) {
              const p = resolve(dir, f);
              if (existsSync(p)) t = Math.max(t, statSync(p).mtimeMs);
            }
            if (t > 0) info.time = isoToDisplayTime(new Date(t).toISOString());
          } catch {}
        }
        // 人数：优先候选人文件，其次进度文件，再次评分结果（完成后 zhipin 会被清理，从 scored 读）
        if (info.hasCandidates) {
          try {
            const raw = JSON.parse(readFileSync(candidatesPath, 'utf-8'));
            const arr = nonEmptyCandidates(raw);
            info.candidateCount = arr ? arr.length : 0;
          } catch { info.candidateCount = 0; }
        } else if (info.hasProgress) {
          try {
            const p = JSON.parse(readFileSync(progressPath, 'utf-8'));
            info.candidateCount = p.processedCount ?? (Array.isArray(p.candidates) ? p.candidates.length : 0);
          } catch { info.candidateCount = 0; }
        } else if (info.hasScored) {
          try {
            const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
            const arr = nonEmptyCandidates(raw);
            info.candidateCount = arr ? arr.length : 0;
          } catch { info.candidateCount = 0; }
        } else {
          info.candidateCount = 0;
        }
        list.push(info);
      }
      list.sort((a, b) => {
        if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1; // 当前未完成批次置顶
        return b.name.localeCompare(a.name);
      });
      return { ok: true, list };
    } catch (err) {
      return { error: `读取历史记录失败: ${err.message}` };
    }
  });

  // v1.5.0: 删除单个历史归档批次
  ipcMain.handle('delete-history', async (_event, dirPath) => {
    const parentDir = dirname(OUTPUT_DIR);
    const name = basename(dirPath);
    if (!dirPath || !archiveDirNameMatches(name) || resolve(dirPath) !== resolve(parentDir, name)) {
      return { error: '目标不是历史归档目录，拒绝删除' };
    }
    try {
      // Windows 文件锁问题：重试最多 3 次，每次等待 500ms（与 clear-history 一致）
      let retries = 3;
      let lastErr = null;
      while (retries > 0) {
        try {
          rmSync(dirPath, { recursive: true, force: true });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          retries--;
          if (retries > 0) { termLog(`[delete-history] 删除失败，${retries} 次重试...`, 'stderr'); await sleep(500); }
        }
      }
      if (lastErr) throw lastErr;
      termLog(`[delete-history] 已删除: ${dirPath}`);
      return { ok: true };
    } catch (err) {
      return { error: `删除失败: ${err.message}` };
    }
  });

  // v1.5.0: 打开历史归档目录
  ipcMain.handle('open-history', async (_event, dirPath) => {
    if (!dirPath || !existsSync(dirPath)) return { error: '目录不存在' };
    await shell.openPath(dirPath);
    return { ok: true };
  });

  // v1.5.0: 继续提取 —— 还原历史批次为输出目录，用 --resume 续跑，跳过已提取项
  ipcMain.handle('resume-extraction', (_event, opts) => {
    if (hasRunningTask()) return { error: '已有任务运行中' };
    const dirPath = opts?.archiveDir;
    if (!dirPath) return { error: '缺少参数' };
    const parentDir = dirname(OUTPUT_DIR);
    const name = basename(dirPath);
    const isCurrent = name === basename(OUTPUT_DIR);

    if (!isCurrent && (!archiveDirNameMatches(name) || resolve(dirPath) !== resolve(parentDir, name))) {
      return { error: '目标不是历史归档目录，无法继续提取' };
    }
    if (!existsSync(resolve(dirPath, '.extract-progress.json')) && !existsSync(resolve(dirPath, 'zhipin-candidates.json'))) {
      return { error: '该批次没有可继续的提取进度' };
    }

    if (!isCurrent) {
      const restored = restoreHistoryToOutput(dirPath);
      if (!restored.ok) return { error: restored.error };
    }

    // 用归档时记录的来源/岗位/数量继续跑；读不到元数据时退化为全量提取
    const meta = readRunMeta(OUTPUT_DIR);
    const source = meta?.source || 'chat';
    const job = meta?.job || '';
    const extractAll = meta ? meta.extractAll !== false : true;
    const count = meta?.count || 0;
    runPipeline(count, false, extractAll, source, job, true, true);
    return { ok: true };
  });

  // v1.5.0: 用某个历史批次（或当前批次）的提取数据重新评分（跳过提取，换模型后重评）
  ipcMain.handle('rescore-from-history', (_event, opts) => {
    if (hasRunningTask()) return { error: '已有任务运行中' };
    const dirPath = opts?.archiveDir;
    if (!dirPath) return { error: '缺少参数' };
    const parentDir = dirname(OUTPUT_DIR);
    const name = basename(dirPath);
    const isCurrent = name === basename(OUTPUT_DIR);
    if (isCurrent) {
      if (resolve(dirPath) !== resolve(OUTPUT_DIR)) return { error: '目标不是历史归档目录，无法重新评分' };
    } else if (!archiveDirNameMatches(name) || resolve(dirPath) !== resolve(parentDir, name)) {
      return { error: '目标不是历史归档目录，无法重新评分' };
    }
    // 该批次只要有简历数据（完整提取 / 提了一半的进度 / 已评分结果）就能重新评分
    try {
      const targetPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
      const restored = restoreScorableCandidates(dirPath, targetPath);
      if (!restored) return { error: '该批次没有可评分的数据（既无提取数据，也无评分结果）' };
      termLog(`[rescore] 已从历史批次恢复可评分数据: ${dirPath}`);
    } catch (err) {
      return { error: `恢复数据失败: ${err.message}` };
    }
    const meta = readRunMeta(dirPath);
    const source = meta?.source || 'chat';
    const job = meta?.job || '';
    const extractAll = meta ? meta.extractAll !== false : true;
    const count = meta?.count || 0;
    runPipeline(count, true, extractAll, source, job, true, false); // skipExtract=true
    return { ok: true };
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

  // 供「开始提取分析」按钮预检：Chrome 已就绪与否；未运行则自动拉起（渲染端若未连上会提示）
  ipcMain.handle('ensure-chrome-open', () => launchChrome({}));

  // GUI 版本号
  ipcMain.handle('get-app-version', () => app.getVersion());

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
