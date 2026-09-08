// electron/greet.mjs — 批量打招呼：spawn greet-candidates.mjs、解析 GREET_* 进度、超时保护。
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { app, powerSaveBlocker } from 'electron';
import { thresholdForLevel } from '../scripts/score-tiers.mjs';
import { termLog, decodeBuffer, UNPACKED_ROOT, APP_ROOT } from './util.mjs';
import { OUTPUT_DIR, currentProcess, cancelled, setCancelled, setCurrentProcess } from './state.mjs';
import { sendGreetProgress, sendGreetDone, sendGreetError } from './window.mjs';

// ===== 批量打招呼 =====
async function runGreeting(level, source = 'recommend') {
  setCancelled(false); // 重置取消标志
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

    setCurrentProcess(proc);
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
      setCurrentProcess(null);
      stopGreetKeepAwake();
      if (!cancelled) {
        sendGreetError({ message: err.message });
      }
    });

    proc.on('close', (code) => {
      clearTimeout(greetTimer);
      setCurrentProcess(null);
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
        setCancelled(true); // 也标记全局取消，close 处理时不再报退出码错误
        setCurrentProcess(null);
        proc.kill();
        sendGreetError({ message: '打招呼超时' });
      }
    }, MAX_WAIT);

  } catch (err) {
    stopGreetKeepAwake();
    sendGreetError({ message: err.message });
  }
}

export { runGreeting };
