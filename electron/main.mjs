import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import iconv from 'iconv-lite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const OUTPUT_DIR = resolve(APP_ROOT, 'output');
const CONFIG_DIR = resolve(app.getPath('userData'), 'web-access');
const CONFIG_PATH = resolve(CONFIG_DIR, 'api-config.json');

// ===== 配置（持久化到 userData） =====
let apiConfig = {
  url: '', key: '', model: '',
  smtpHost: 'smtp.mxhichina.com', smtpPort: '25', smtpSecure: 'false',
  smtpUser: 'lixins@allwinnertech.com', smtpPass: '', smtpFrom: '',
  emailPrefix: '',
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

// ===== 窗口创建 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 640,
    height: 620,
    resizable: false,
    title: 'Boss直聘候选人提取分析',
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
  const scanMatch = line.match(/扫描进度:\s*(\d+)\s*人/);
  if (scanMatch) {
    return { progress: Math.min(parseInt(scanMatch[1]), 99), message: line.trim() };
  }
  return null;
}

function parseScoreProgress(line) {
  const match = line.match(/Scored (\d+) candidates/);
  if (match) return { progress: 100, message: line.trim() };
  return null;
}

function parseExportProgress(line) {
  if (line.includes('导出成功')) return { progress: 100, message: line.trim() };
  if (line.includes('共导出')) return { progress: 90, message: line.trim() };
  return null;
}

// ===== 脚本执行 =====
function runScript(scriptName, args, step, parseFn, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const scriptPath = resolve(APP_ROOT, 'scripts', scriptName);

    termLog(`[main] start: scripts/${scriptName} ${args.join(' ')}`);
    sendProgress(step, 'running', 0, `启动 ${scriptName}...`);

    const proc = spawn('node', [scriptPath, ...args], {
      cwd: APP_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });

    currentProcess = proc;

    proc.stdout.on('data', (data) => {
      const lines = decodeBuffer(data).split('\n').filter(Boolean);
      for (const line of lines) {
        termLog(`[${scriptName}] ${line}`);
        const parsed = parseFn ? parseFn(line) : null;
        if (parsed) {
          sendProgress(step, 'running', parsed.progress, parsed.message);
        } else {
          sendProgress(step, 'running', null, line.trim());
        }
      }
    });

    proc.stderr.on('data', (data) => {
      const text = decodeBuffer(data).trim();
      if (text) {
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
      else if (code !== 0) rejectPromise(new Error(`${scriptName} 退出码 ${code}`));
      else {
        sendProgress(step, 'done', 100, `${scriptName} 完成`);
        resolvePromise();
      }
    });
  });
}

// ===== AI 评分 =====

// 调公司 Claude API（Anthropic 格式）
async function callClaudeAPI(prompt) {
  const url = `${apiConfig.url}/v1/messages`.replace(/\/+v1/, '/v1'); // 防双斜杠
  termLog(`[AI评分] 调 API: ${url}, model=${apiConfig.model}`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': apiConfig.key,
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: apiConfig.model,
      max_tokens: 2000,
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

  // 策略1: 精确找 [{"candidateIndex"
  const idx = text.indexOf('[{"candidateIndex"');
  if (idx >= 0) {
    const end = text.lastIndexOf('}]');
    if (end > idx) jsonStr = text.slice(idx, end + 2);
  }

  // 策略2: 找 [ 紧接着 { 含 score 和 comment 的对象
  if (!jsonStr) {
    const match = text.match(/\[\s*\{[^}]*?score[^}]*?comment[^}]*?\}\s*\]/s);
    if (match) jsonStr = match[0];
  }

  // 策略3: 逐段尝试找有效的 JSON 数组（从后往前找 [）
  if (!jsonStr) {
    // 找所有 [ 的位置，从后往前试，找到第一个能解析为数组的
    const bracketPositions = [];
    let searchPos = 0;
    while (true) {
      const pos = text.indexOf('[', searchPos);
      if (pos === -1) break;
      bracketPositions.push(pos);
      searchPos = pos + 1;
    }
    // 从后往前试（越靠后的 [ 到 ] 范围越小，越可能是目标）
    for (let i = bracketPositions.length - 1; i >= 0; i--) {
      const start = bracketPositions[i];
      const end = text.lastIndexOf(']');
      if (end > start) {
        const candidate = text.slice(start, end + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] !== null && typeof parsed[0] === 'object') {
            jsonStr = candidate;
            break;
          }
        } catch {}
      }
    }
  }

  if (!jsonStr) {
    throw new Error(`API 返回未包含评分 JSON 数组`);
  }

  return JSON.parse(jsonStr);
}

// 将候选人分成 N 人一批
function chunkArray(arr, size) {
  const result = [];
  for (let i = 0; i < arr.length; i += size) result.push(arr.slice(i, i + size));
  return result;
}

async function doAiScoring() {
  const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
  if (!existsSync(scoredPath)) throw new Error('未找到 scored-candidates.json');

  const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
  const candidates = raw.candidates || raw;

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
    const templatePath = resolve(APP_ROOT, 'config', 'scoring-prompt-with-jd.txt');
    let template;
    try {
      template = readFileSync(templatePath, 'utf-8');
    } catch {
      throw new Error(`未找到评分模板: ${templatePath}`);
    }

    // 取岗位 JD
    const jdText = withResume.find(c => c.jobDescription?.description)?.jobDescription?.description || '';

    // 分批
    const batches = chunkArray(withResume, 5);
    termLog(`[AI评分] 岗位 "${positionName}": ${withResume.length} 人，${batches.length} 批`);

    // 并行发 API 请求
    const batchPromises = batches.map(async (batch, batchIdx) => {
      // 构建 prompt
      let prompt = template
        .replace('{jobDescription.description}', jdText)
        .replace('{positionName}', positionName);

      // 替换 {resumeText} 为逐人简历
      const resumeSections = batch.map((c, i) =>
        `=== 候选人 ${i + 1}/${batch.length} ===\n姓名：${c.basicInfo?.name || '未知'}\n简历：\n${c.resumeText || '(无)'}`
      ).join('\n\n');

      prompt = prompt.replace('{resumeText}', resumeSections);

      // 附加输出格式要求（多候选人模式）
      prompt += `\n\n请为以上每位候选人分别给出评分。\n请严格按以下 JSON 数组格式输出：\n[\n` +
        batch.map((_, i) => `  {"candidateIndex": ${i}, "jobRelevanceScore": <0-50>, "jobRelevanceComment": "技术栈匹配：... | 项目经验相关性：... | 行业经验：..."}`).join(',\n') +
        `\n]`;

      try {
        const results = await callClaudeAPI(prompt);
        for (const r of results) {
          const idx = r.candidateIndex;
          if (idx >= 0 && idx < batch.length) {
            batch[idx].jobRelevanceScore = r.jobRelevanceScore ?? 0;
            batch[idx].jobRelevanceComment = r.jobRelevanceComment || '';
          }
        }
      } catch (err) {
        termLog(`[AI评分] 第 ${batchIdx + 1} 批失败: ${err.message}`, 'stderr');
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
    termLog(`[AI评分] 岗位 "${positionName}" 评分完成 (${group.length} 人)`);
  }

  // 合并总分
  for (const c of candidates) {
    c.totalScore = (c.educationScore || 0) + (c.workYearsScore || 0) + (c.jobRelevanceScore || 0);
    if (c.totalScore >= 80) c.recommendationLevel = '强烈推荐';
    else if (c.totalScore >= 65) c.recommendationLevel = '推荐';
    else if (c.totalScore >= 50) c.recommendationLevel = '可考虑';
    else c.recommendationLevel = '暂不推荐';
    c.passed = c.totalScore >= 50;
  }

  // 写回
  const output = raw.candidates ? raw : { candidates: raw };
  writeFileSync(scoredPath, JSON.stringify(output, null, 2), 'utf-8');
  termLog(`[AI评分] 完成，已写入 ${scoredPath}`);
}

// ===== 主流程编排 =====
async function runPipeline(count, skipExtract = false, extractAll = false) {
  cancelled = false;

  try {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    // 步骤 1: 提取（可跳过）
    if (!skipExtract) {
      sendProgress(1, 'running', 0, extractAll ? '准备提取全部候选人...' : '准备提取候选人...');
      const extractArgs = extractAll ? ['--all'] : ['--count', String(count)];
      await runScript('extract-candidates-full.mjs', extractArgs, 1, parseExtractProgress);
      if (cancelled) return;
      sendProgress(1, 'done', 100, '提取完成');
    } else {
      sendProgress(1, 'done', 100, '已跳过提取');
    }
    // 步骤 2: AI 评分（基础评分 + 岗位相关性评分）
    const candidatesPath = resolve(OUTPUT_DIR, 'zhipin-candidates.json');
    if (existsSync(candidatesPath)) {
      sendProgress(2, 'running', 0, '基础评分...');
      await runScript('score-candidates.mjs', ['--input', candidatesPath, '--default'], 2, parseScoreProgress);
      if (cancelled) return;
    } else {
      termLog('[AI评分] zhipin-candidates.json 不存在，跳过基础评分步骤');
      sendProgress(2, 'running', 0, '跳过基础评分...');
    }
    sendProgress(2, 'running', 50, 'AI岗位相关性评分...');
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
      exportArgs.push('--to-prefix', apiConfig.emailPrefix);
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
      excelPath: resolve(OUTPUT_DIR, 'candidates.xlsx'),
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
    runPipeline(count, skipExtract, extractAll);
    return { ok: true };
  });

  ipcMain.handle('cancel-extraction', () => {
    if (currentProcess) { cancelled = true; currentProcess.kill(); currentProcess = null; }
    return { ok: true };
  });

  ipcMain.handle('open-output', async () => {
    if (existsSync(OUTPUT_DIR)) await shell.openPath(OUTPUT_DIR);
    return { ok: true };
  });

  ipcMain.handle('get-output-dir', () => OUTPUT_DIR);

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
}

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  loadApiConfig(); // 启动时加载持久化的 API 配置
  registerIPC();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentProcess) { currentProcess.kill(); currentProcess = null; }
  if (process.platform !== 'darwin') app.quit();
});
