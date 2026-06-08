import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { fork } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from 'node:fs';
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

// ===== 配置（持久化到 userData） =====
// SMTP 默认密码（编码存储，避免明文出现在源码中）
const DEFAULT_SMTP_PASS = Buffer.from('SmUxMjM0NTY=', 'base64').toString();  // Je123456

let apiConfig = {
  url: '', key: '', model: '',
  smtpHost: 'smtp.mxhichina.com', smtpPort: '25', smtpSecure: 'false',
  smtpUser: 'jenkins@allwinnertech.com', smtpPass: DEFAULT_SMTP_PASS, smtpFrom: '',
  emailPrefix: '', outputDir: '',
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
let aiAbortController = null; // 用于中断 AI 评分的正在请求
let actualExportPath = ''; // 导出脚本实际输出的文件路径（可能被另存）

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 700,
    resizable: false,
    title: 'Boss直聘候选人提取分析',
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

    const proc = fork(scriptPath, args, {
      cwd: procCwd,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, ...extraEnv },
      silent: true,
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
      max_tokens: 4096,
      temperature: 0.3,
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

  // 从文本中提取 JSON 数组
  let jsonStr = null;

  // 去掉 markdown 代码块包裹
  const cleanText = text.replace(/^```(?:json)?\s*\n?/m, '').replace(/\n?```\s*$/m, '');

  // 策略1: 精确找 [{"candidateIndex"
  const idx = cleanText.indexOf('[{"candidateIndex"');
  if (idx >= 0) {
    const end = text.lastIndexOf('}]');
    if (end > idx) jsonStr = cleanText.slice(idx, end + 2);
  }

  // 策略2: 找 [ 紧接着 { 含 score 和 comment 的对象
  if (!jsonStr) {
    const match = cleanText.match(/\[\s*\{[^}]*?score[^}]*?comment[^}]*?\}\s*\]/s);
    if (match) jsonStr = match[0];
  }

  // 策略3: 逐段尝试找有效的 JSON 数组（从后往前找 [）
  if (!jsonStr) {
    const bracketPositions = [];
    let searchPos = 0;
    while (true) {
      const pos = cleanText.indexOf('[', searchPos);
      if (pos === -1) break;
      bracketPositions.push(pos);
      searchPos = pos + 1;
    }
    for (let i = bracketPositions.length - 1; i >= 0; i--) {
      const start = bracketPositions[i];
      const end = cleanText.lastIndexOf(']');
      if (end > start) {
        try {
          const parsed = JSON.parse(cleanText.slice(start, end + 1));
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] !== null && typeof parsed[0] === 'object') {
            jsonStr = cleanText.slice(start, end + 1);
            break;
          }
        } catch {}
      }
    }
  }

  // 策略4: 找 { 开头 .score. .comment. 结尾的单个对象并组装
  if (!jsonStr) {
    const objMatches = [...cleanText.matchAll(/\{"candidateIndex":\s*(\d+)\s*,\s*"jobRelevanceScore":\s*(\d+)\s*,\s*"jobRelevanceComment":\s*"((?:[^"\\]|\\.)*)"\s*\}/g)];
    if (objMatches.length > 0) {
      jsonStr = JSON.stringify(objMatches.map(m => ({
        candidateIndex: parseInt(m[1]),
        jobRelevanceScore: parseInt(m[2]),
        jobRelevanceComment: m[3],
      })));
    }
  }

  // 策略5: 尝试逐个提取 candidateIndex + jobRelevanceScore + jobRelevanceComment
  if (!jsonStr) {
    const singleMatches = [...cleanText.matchAll(/\{"candidateIndex":\s*(\d+)[^}]*?"jobRelevanceScore":\s*(\d+)[^}]*?"jobRelevanceComment":\s*"([^"]*)"[^}]*?\}/g)];
    if (singleMatches.length > 0) {
      const arr = singleMatches.map(m => ({
        candidateIndex: parseInt(m[1]),
        jobRelevanceScore: parseInt(m[2]),
        jobRelevanceComment: m[3],
      }));
      jsonStr = JSON.stringify(arr);
    }
  }

  if (!jsonStr) {
    const timestamp = Date.now();
    const debugPath = resolve(OUTPUT_DIR, `api-raw-response-${timestamp}.txt`);
    try { writeFileSync(debugPath, text, 'utf-8'); } catch {}
    termLog(`[AI评分] API返回未包含评分JSON，已保存到 ${debugPath}`, 'stderr');
    throw new Error(`API 返回未包含评分 JSON 数组`);
  }

  return JSON.parse(jsonStr);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// 将候选人分成 N 人一批
function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
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
  let scoredCount = 0;
  const totalBatches = positionNames.reduce((sum, name) => {
    const withResume = groups[name].filter(c => c.resumeText);
    return sum + Math.ceil(withResume.length / 5);
  }, 0);
  let completedBatches = 0;

  for (const positionName of positionNames) {
    if (cancelled) { termLog('[AI评分] 用户取消'); break; }

    const group = groups[positionName];
    const withResume = group.filter(c => c.resumeText);

    // 无简历的直接设 0 分
    for (const c of group) {
      if (!c.resumeText) {
        c.jobRelevanceScore = 0;
        c.jobRelevanceComment = '无在线简历';
      }
    }

    if (withResume.length === 0) continue;

    // 读取 prompt 模板
    const templatePath = resolve(UNPACKED_ROOT, 'config', 'scoring-prompt-with-jd.txt');
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

    // 取岗位 JD：根据提取来源分流
    let jdText = '';
    if (extractSource === 'recommend') {
      // 推荐牛人页：从 config/jd-descriptions/ 目录读取对应岗位的 .txt 文件
      // 文件名 = 岗位名（替换 Windows 不允许的字符）
      const safeName = positionName.replace(/[\\/:*?"<>|]/g, (c) => ({
        '\\': '＼', '/': '／', ':': '：', '*': '＊',
        '?': '？', '"': '＂', '<': '＜', '>': '＞', '|': '｜'
      })[c]);
      const filePath = resolve(UNPACKED_ROOT, 'config', 'jd-descriptions', safeName + '.txt');
      try {
        if (existsSync(filePath)) {
          jdText = readFileSync(filePath, 'utf-8').trim();
        } else {
          termLog(`[AI评分] ⚠ 未找到 JD 文件: config/jd-descriptions/${safeName}.txt`);
        }
      } catch (err) {
        termLog(`[AI评分] 读取 JD 文件失败: ${err.message}`, 'stderr');
      }
    } else {
      // 沟通页：从候选人数据取
      jdText = withResume.find(c => c.jobDescription?.description)?.jobDescription?.description || '';
    }

    // 分批
    const batches = chunkArray(withResume, 5);
    termLog(`[AI评分] 岗位 "${positionName}": ${withResume.length} 人，${batches.length} 批`);

    // 并行发 API 请求
    const batchPromises = batches.map(async (batch, batchIdx) => {
      // 构建 prompt
      let prompt = template
        .replace('{jobDescription.description}', jdText)
        .replace('{positionName}', positionName);

      // 替换 {resumeText} 为逐人简历（含DOM直接读取的基础信息）
      const resumeSections = batch.map((c, i) =>
        `=== 候选人 ${i + 1}/${batch.length} ===\n` +
        `姓名：${c.basicInfo?.name || '未知'}\n` +
        `学历（来自页面）：${c.basicInfo?.education || '未知'}\n` +
        `工作年限（来自页面）：${c.basicInfo?.workYears || '未知'}\n` +
        `简历（OCR识别，仅供参考）：\n${c.resumeText || '(无)'}`
      ).join('\n\n');

      prompt = prompt.replace('{resumeText}', resumeSections);

      // 附加输出格式要求（多候选人模式）
      const commentFormat = scoretextFormat ||
        '匹配度评分：\n首句定性：\n\n维度权重（总权重100%）：\n1. \n2. \n3. \n4. \n5. \n\n硬性技能匹配度：\n核心领域能力匹配度：\n刚性扣分说明：\n\n综合结论：';
      // 转义换行符以嵌入 JSON 示例
      const escapedFormat = commentFormat.replace(/\n/g, '\\n');
      prompt += `\n\n重要：每位候选人必须独立评分，绝对禁止与其他候选人做横向比较。评语中不能说"相比其他人"、"在这些候选人中"、"排名第几"等比较性内容。每位候选人的评分只应基于其自身与JD的匹配程度。\n请只输出 JSON，不要包含任何其他文字。格式如下：\n[\n` +
        batch.map((_, i) => `  {"candidateIndex": ${i}, "jobRelevanceScore": 0-100, "jobRelevanceComment": "${escapedFormat}"}`).join(',\n') +
        `\n]\n评语的 jobRelevanceComment 字段必须严格按照以下结构填写（将内容填充到各标题之后）：\n${commentFormat}`;

      try {
        // 最多重试 2 次
        let results = null;
        for (let retry = 0; retry <= 2; retry++) {
          try {
            results = await callClaudeAPI(prompt, { signal });
            break;
          } catch (err) {
            if (signal.aborted) throw err; // 用户取消，不重试立即退出
            if (retry < 2) {
              termLog(`[AI评分] 第 ${batchIdx + 1} 批失败，${retry + 1}/2 重试: ${err.message}`, 'stderr');
              await sleep(2000);
            } else {
              throw err;
            }
          }
        }
        for (const r of results) {
          const idx = r.candidateIndex;
          if (idx >= 0 && idx < batch.length) {
            batch[idx].jobRelevanceScore = r.jobRelevanceScore ?? 0;
            const raw = r.jobRelevanceComment || '';
            // 统一评语换行格式：在章节标题前强制换行
            // 涵盖 with-jd 和 no-jd 两种模板的标题格式
            batch[idx].jobRelevanceComment = raw
              .replace(/(匹配度评分|首句定性|维度权重|硬性技能|核心领域|刚性扣分说明|综合结论|岗位相关性分数|技术栈匹配|项目经验(?:相关|相关性)|行业经验)/g, '\n$1')
              .replace(/\n{3,}/g, '\n\n')
              .replace(/^\n+/, '')
              .trim();
          }
        }
      } catch (err) {
        termLog(`[AI评分] 第 ${batchIdx + 1} 批最终失败: ${err.message}`, 'stderr');
        // 失败批的候选人设 0 分
        for (const c of batch) {
          c.jobRelevanceScore = 0;
          c.jobRelevanceComment = `评分失败: ${err.message}`;
        }
      }

      completedBatches++;
      const overall = Math.round(50 + (completedBatches / totalBatches) * 50);
      sendProgress(2, 'running', overall, `AI评分: ${completedBatches}/${totalBatches} 批完成`);
      scoredCount += batch.length;
      termLog(`[AI评分] 批次 ${batchIdx + 1}/${batches.length} 完成`);
    });

    await Promise.all(batchPromises);
    if (cancelled) break;
    termLog(`[AI评分] 岗位 "${positionName}" 评分完成 (${group.length} 人)`);
  }

  // 总分 = AI 评分（0-100）
  for (const c of candidates) {
    c.totalScore = c.jobRelevanceScore || 0;
    if (c.totalScore >= 86) c.recommendationLevel = '强烈推荐';
    else if (c.totalScore >= 72) c.recommendationLevel = '推荐';
    else if (c.totalScore >= 58) c.recommendationLevel = '可考虑';
    else c.recommendationLevel = '暂不推荐';
    c.passed = c.totalScore >= 58;
  }

  aiAbortController = null;

  // 写回 scored-candidates.json
  const resultPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
  const output = raw.candidates ? raw : { candidates: raw };
  writeFileSync(resultPath, JSON.stringify(output, null, 2), 'utf-8');
  termLog(`[AI评分] 完成，已写入 ${resultPath}`);
}

// ===== 主流程编排 =====
async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '') {
  cancelled = false;

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

    // 步骤 1: 提取（可跳过）
    if (!skipExtract) {
      const isRecommend = source === 'recommend' || source === 'recommend-attach';
      const isAttach = source === 'recommend-attach';
      const scriptName = isRecommend ? 'extract-recommend-candidates.mjs' : 'extract-candidates-full.mjs';
      const pageLabel = isAttach ? '推荐牛人页（手动筛选）' : (isRecommend ? '推荐牛人' : '沟通');
      sendProgress(1, 'running', 0, extractAll ? `准备提取全部候选人 (${pageLabel}页)...` : '准备提取候选人...');
      const extractArgs = extractAll
        ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
        : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
      if (job) {
        extractArgs.push('--job', job);
      }
      if (isAttach) {
        extractArgs.push('--attach');
      }
      await runScript(scriptName, extractArgs, 1, parseExtractProgress);
      if (cancelled) return;
      sendProgress(1, 'done', 100, '提取完成');
    } else {
      sendProgress(1, 'done', 100, '已跳过提取');
    }
    // 步骤 2: AI 评分（直接从 zhipin-candidates.json 读取）
    const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
    if (!existsSync(candidatesPath)) {
      throw new Error('未找到 zhipin-candidates.json');
    }
    sendProgress(2, 'running', 0, 'AI岗位相关性评分...');
    await doAiScoring();
    if (cancelled) return;

    // 步骤 3: 导出
    sendProgress(2, 'done', 100, '评分完成');
    sendProgress(3, 'running', 0, '准备导出 Excel...');
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) throw new Error(`未找到评分结果文件: ${scoredPath}`);

    // 构建导出参数：若有 emailPrefix，传给导出脚本自动发邮件
    let exportArgs = ['--input', scoredPath];
    const smtpEnv = {};
    if (apiConfig.emailPrefix) {
      const emailSubject = source === 'recommend' ? '推荐牛人评分结果' : '候选人评分结果';
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

    sendProgress(3, 'done', 100, '导出完成');
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
      try { currentProcess.stdin.write('CANCEL\n'); } catch {}
      // 等 2s 让子进程清理，超时强制杀
      setTimeout(() => {
        if (currentProcess) { currentProcess.kill(); currentProcess = null; }
      }, 2000);
    }
    if (aiAbortController) { aiAbortController.abort(); aiAbortController = null; }
    return { ok: true };
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

  // 读取推荐牛人页岗位列表（从 jd-descriptions/ 目录的 .txt 文件名反解）
  ipcMain.handle('get-recommend-jobs', () => {
    const dir = resolve(UNPACKED_ROOT, 'config', 'jd-descriptions');
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
    const dir = resolve(UNPACKED_ROOT, 'config', 'jd-descriptions');
    mkdirSync(dir, { recursive: true });
    const filePath = resolve(dir, safeName + '.txt');
    if (existsSync(filePath)) throw new Error(`岗位"${jobName}"已存在`);
    writeFileSync(filePath, jobDesc || '', 'utf-8');
    termLog(`[config] 已添加新岗位: ${jobName}`);
    return { ok: true };
  });
}

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  loadApiConfig();
  registerIPC();

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
  if (process.platform !== 'darwin') app.quit();
});
