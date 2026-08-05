import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { spawn, execFile } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync, unlinkSync, rmSync } from 'node:fs';
import http from 'node:http';
import iconv from 'iconv-lite';

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
const JD_DIR = app.isPackaged
  ? resolve(CONFIG_DIR, 'jd-descriptions')
  : resolve(APP_ROOT, 'config', 'jd-descriptions');

// ===== 配置（持久化到 userData） =====
// SMTP 默认密码（编码存储，避免明文出现在源码中）
const DEFAULT_SMTP_PASS = Buffer.from('SmUxMjM0NTY=', 'base64').toString();  // Je123456

let apiConfig = {
  url: '', key: '', model: '',
  smtpHost: 'smtp.mxhichina.com', smtpPort: '25', smtpSecure: 'false',
  smtpUser: 'jenkins@allwinnertech.com', smtpPass: DEFAULT_SMTP_PASS, smtpFrom: '',
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
        stderrLines.push(text);
        if (stderrLines.length > 20) stderrLines.shift();
        termLog(`[${scriptName} stderr] ${text}`, 'stderr');
        // 将 stderr 也回传给 UI，使用户能看到邮件错误等
        sendProgress(step, 'running', null, text);
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
      max_tokens: 8000,
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
    // Anthropic 标准: type=text 的块
    const textBlock = data.content.find(c => c.type === 'text');
    if (textBlock?.text) {
      text = textBlock.text;
    } else {
      // 公司代理: 所有内容在 thinking 块中，拼接所有 thinking/text 字段
      text = data.content.map(c => c.thinking || c.text || '').filter(Boolean).join('\n');
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
            // 格式化评语：在章节标题前强制换行
            const formatted = comment
              .replace(/(匹配度评分|首句定性|维度权重|硬性技能|核心领域|刚性扣分说明|综合结论|岗位相关性分数|技术栈匹配|项目经验(?:相关|相关性)|行业经验)/g, '\n$1')
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
              // 格式化评语：在章节标题前强制换行
              const formatted = comment
                .replace(/(匹配度评分|首句定性|维度权重|硬性技能|核心领域|刚性扣分说明|综合结论|岗位相关性分数|技术栈匹配|项目经验(?:相关|相关性)|行业经验)/g, '\n$1')
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
  '--disable-features=CalculateNativeWinOcclusion',
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

    // 根据来源选择 prompt 模板
    const isRecommendScoring = extractSource === 'recommend' || extractSource === 'recommend-attach';
    const templateName = isRecommendScoring ? 'scoring-prompt-with-jd.txt' : 'scoring-prompt-chat.txt';
    const templatePath = resolve(UNPACKED_ROOT, 'config', templateName);
    let template;
    try {
      template = readFileSync(templatePath, 'utf-8');
    } catch {
      throw new Error(`未找到评分模板: ${templatePath}`);
    }

    // 读取固定输出格式模板（scoretext.md）
    const scoretextPath = resolve(UNPACKED_ROOT, 'config', 'scoretext.md');
    let scoretextFormat = '';
    try {
      scoretextFormat = readFileSync(scoretextPath, 'utf-8').trim();
    } catch {
      termLog(`[AI评分] ⚠ 未找到 scoretext.md，使用默认格式`);
    }

    // 读取用户配置的评分维度和任职资格筛选项
    const dimensionsText = apiConfig.dimensions || '';
    const screeningCriteriaText = apiConfig.screeningCriteria || '';

    // 尝试读取该岗位的 JD 描述文件，如有则覆盖 {dimensions}/{screeningCriteria}
    let jdContent = null;
    const safeName = positionName.replace(/[\\/:*?"<>|]/g, (c) => ({
      '\\': '＼', '/': '／', ':': '：', '*': '＊',
      '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
    })[c]);
    const jdFilePath = resolve(JD_DIR, safeName + '.txt');
    try {
      const raw = readFileSync(jdFilePath, 'utf-8').trim();
      if (raw) jdContent = raw;
    } catch {}

    if (isRecommendScoring && !jdContent && !dimensionsText) {
      termLog(`[AI评分] ⚠ 未配置核心评估维度，请先在设置中配置`, 'stderr');
    }

    // 沟通页：从候选人提取的 jobDescription 中获取 JD 文本（无 JD 文件时的后备）
    if (!isRecommendScoring && !jdContent) {
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

    async function scoreOneBatch(batch) {
      if (cancelled) return;

      // 构建多人 prompt
      let prompt;
      if (isRecommendScoring) {
        const dims = jdContent || dimensionsText;
        const criteria = jdContent || screeningCriteriaText;
        prompt = template
          .replace('{dimensions}', dims)
          .replace('{screeningCriteria}', criteria);
      } else {
        prompt = template
          .replace('{jdText}', jdContent || dimensionsText || '(无岗位JD描述)');
      }

      // 拼接本批所有候选人的简历
      const resumeSections = batch.map((c, i) => {
        const resumeForAI = (c.resumeText || '').length > MAX_RESUME_LEN
          ? (c.resumeText || '').slice(0, MAX_RESUME_LEN) + '\n\n...(后续内容略)'
          : (c.resumeText || '(无)');
        return `=== 候选人 ${i + 1}/${batch.length} ===\n` +
          `姓名：${c.basicInfo?.name || '未知'}\n` +
          `学历（来自页面）：${c.basicInfo?.education || '未知'}\n` +
          `工作年限（来自页面）：${c.basicInfo?.workYears || '未知'}\n` +
          `简历文本（仅供参考）：\n${resumeForAI}`;
      }).join('\n\n');

      prompt = prompt.replace('{resumeText}', resumeSections);

      // 附加批量输出格式要求
      prompt += `\n\n重要：本次请求要求 JSON 输出。请为以上每位候选人分别给出评分，严格只输出一个 JSON 数组（不要包含任何其他内容，不要用 markdown 代码块包裹）：\n` +
        `[\n` +
        batch.map((_, i) => `  {"candidateIndex": ${i}, "score": <0-100的整数>, "comment": "<按上方评语内容规范组织、完整包含匹配度评分/首句定性/维度匹配/任职资格/学历核查/综合结论各模块的评语，用\\n换行>"}`).join(',\n') +
        `\n]`;

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
        for (const c of batch) {
          c.jobRelevanceScore = 0;
          c.jobRelevanceComment = `评分失败: ${lastError.message}`;
        }
        termLog(`  ✗ 批次评分失败: ${lastError.message}`, 'stderr');
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
  // 总分 = AI 评分（0-100）
  for (const c of candidates) {
    c.totalScore = c.jobRelevanceScore || 0;
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
async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '') {
  cancelled = false;
  skipRecovered = false;

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

    // 构建导出参数：若有 emailPrefix，传给导出脚本自动发邮件
    let exportArgs = ['--input', scoredPath];
    const smtpEnv = {};
    if (apiConfig.emailPrefix) {
      let emailSubject = '候选人评分结果';
      if (isRecommendMode) emailSubject = '推荐牛人评分结果';
      else if (isSearchMode) emailSubject = '搜索页评分结果';
      exportArgs.push('--to-prefix', apiConfig.emailPrefix);
      exportArgs.push('--email-subject', emailSubject);
      // 传递 SMTP 配置给子进程
      if (apiConfig.smtpHost) smtpEnv.SMTP_HOST = apiConfig.smtpHost;
      if (apiConfig.smtpPort) smtpEnv.SMTP_PORT = apiConfig.smtpPort;
      if (apiConfig.smtpSecure) smtpEnv.SMTP_SECURE = apiConfig.smtpSecure;
      if (apiConfig.smtpUser) smtpEnv.SMTP_USER = apiConfig.smtpUser;
      if (apiConfig.smtpPass) smtpEnv.SMTP_PASS = apiConfig.smtpPass;
      if (apiConfig.smtpFrom) smtpEnv.SMTP_FROM = apiConfig.smtpFrom;
      termLog(`[main] 将发送邮件到 ${apiConfig.emailPrefix}@allwinnertech.com`);
    }
    await runScript('export-candidates.mjs', exportArgs, 3, parseExportProgress, smtpEnv);
    if (cancelled) return;

    sendProgress(3, 'done', 100, 'Excel 导出完成');

    // 清理临时文件（保留 scored-candidates.json 和 candidates.xlsx）
    cleanupTempFiles();

    sendDone({
      outputDir: OUTPUT_DIR,
      excelPath: actualExportPath || resolve(OUTPUT_DIR, 'candidates.xlsx'),
      emailTo: apiConfig.emailPrefix ? `${apiConfig.emailPrefix}@allwinnertech.com` : null,
    });
  } catch (err) {
    if (err.message === '已取消') {
      sendProgress(1, 'idle', 0, '已取消');
      sendProgress(2, 'idle', 0, '');
      sendProgress(3, 'idle', 0, '');
    } else {
      sendError({ message: err.message });
    }
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
    totalTargets = candidates.filter(c => (c.totalScore ?? c.jobRelevanceScore ?? 0) >= threshold).length;
  } catch (err) {
    termLog(`[greet] 读取评分数据失败: ${err.message}`, 'stderr');
  }

  termLog(`[greet] 开始批量打招呼，level=${level}，source=${source}，目标 ${totalTargets} 人`);

  const MAX_WAIT = 600000; // 最多等 10 分钟
  let greetCancelled = false;

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
          sendGreetError({ message: errMatch[1] });
          return;
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = decodeBuffer(data).trim();
      if (text) termLog(`[greet stderr] ${text}`, 'stderr');
    });

    proc.on('error', (err) => {
      currentProcess = null;
      if (!cancelled) {
        sendGreetError({ message: err.message });
      }
    });

    proc.on('close', (code) => {
      currentProcess = null;
      // 超时或用户取消时 cancelled=true，不再重复报错
      if (cancelled) return;
      // code=null 表示被信号杀死（非正常退出）
      if (code !== 0) {
        const msg = code === null
          ? '打招呼进程异常终止（可能被系统杀死）'
          : `greet-candidates.mjs 退出码 ${code}`;
        sendGreetError({ message: msg });
      }
    });

    // 超时保护（也会设置 cancelled，避免 close 事件重复报错）
    setTimeout(() => {
      if (currentProcess === proc) {
        cancelled = true; // 也标记全局取消，close 处理时不再报退出码错误
        greetCancelled = true;
        currentProcess = null;
        proc.kill();
        sendGreetError({ message: '打招呼超时' });
      }
    }, MAX_WAIT);

  } catch (err) {
    if (!greetCancelled) {
      sendGreetError({ message: err.message });
    }
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
    if (health?.status === 'ok') {
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
    runPipeline(count, skipExtract, extractAll, source, job);
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
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 2000);
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
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 2000);
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
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 2000);
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

  // "边用边跑"模式：带参数重启 Chrome，关闭 Windows 遮挡暂停渲染
  // （否则 Chrome 窗口被完全盖住/最小化时渲染暂停，CDP 截图会拿到空白帧）
  ipcMain.handle('launch-boss-mode-chrome', async (_event, { forceClose } = {}) => {
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
    spawn(chromePath, BOSS_MODE_CHROME_FLAGS, { detached: true, stdio: 'ignore' }).unref();
    return {
      ok: true,
      message: 'Chrome 已用「边用边跑」模式启动。首次使用请按 README 第 1 步，'
             + '在 chrome://inspect/#remote-debugging 里勾选「允许远程调试」，之后照常使用即可。',
    };
  });

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
    // 无界面模式：只跑评分+导出
    termLog('[main] 模式: --score-only (跳过提取，直接评分导出)');
    runPipeline(20, true, true, 'chat', '');
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
