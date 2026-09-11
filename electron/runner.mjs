// electron/runner.mjs — 子进程脚本执行：spawn 提取/导出等脚本、解析 stdout 进度、接管当前进程状态。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { app } from 'electron';
import { termLog, decodeBuffer, UNPACKED_ROOT, APP_ROOT } from './util.mjs';
import { setCurrentProcess, setActualExportPath, setExportMailResult, cancelled, OUTPUT_DIR } from './state.mjs';
import { sendProgress } from './window.mjs';

// ===== stdout 进度解析 =====
function parseExtractProgress(line) {
  if (line.includes('提取结果摘要')) return { progress: 100, message: '提取完成' };
  // 扫描阶段（滚动列表收集候选人）：实时显示扫描进度，提示语换成「正在扫描候选人列表」
  const scanCount = line.match(/扫描进度：\s*(\d+)\/(\d+) 人/);
  if (scanCount) {
    return { progress: 0, message: `正在扫描候选人列表… ${scanCount[1]}/${scanCount[2]} 人` };
  }
  const scanAll = line.match(/扫描进度：\s*(\d+) 人/);
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
  const pathMatch = line.match(/导出成功：\s*(.+)/) || line.match(/另存为：\s*(.+)/);
  if (pathMatch) {
    setActualExportPath(pathMatch[1].trim());
  }
  if (line.includes('导出成功')) return { progress: 100, message: line.trim() };
  if (line.includes('共导出')) return { progress: 90, message: line.trim() };
  // 邮件发送结果标记（不显示到进度条，只记录状态供完成页判断是否真发成功）
  const mailOkMatch = line.match(/^MAIL_OK:(.+)$/);
  if (mailOkMatch) {
    setExportMailResult({ status: 'ok', to: mailOkMatch[1].trim(), error: '' });
    return { skip: true };
  }
  const mailFailMatch = line.match(/^MAIL_FAIL:(.+)$/);
  if (mailFailMatch) {
    setExportMailResult({ status: 'fail', to: '', error: mailFailMatch[1].trim() });
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

    setCurrentProcess(proc);
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
      setCurrentProcess(null);
      rejectPromise(cancelled ? new Error('已取消') : err);
    });

    proc.on('close', (code) => {
      setCurrentProcess(null);
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

export { parseExtractProgress, parseExportProgress, runScript };
