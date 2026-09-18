// electron/ipc.mjs — 全部 IPC handler：启动/取消提取、打招呼、评分结果、历史归档、输出目录、CDP 状态、岗位增删改查。
import { app, BrowserWindow, ipcMain, shell, dialog } from 'electron';
import { resolve, dirname, basename } from 'node:path';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { TIER_THRESHOLDS, scoreToTier, scoreToRecommendation, isPassed } from '../scripts/score-tiers.mjs';
import { formatComment } from '../scripts/format-comment.mjs';
import { termLog, sleep } from './util.mjs';
import { pinyinInitials } from './pinyin.mjs';
import {
  hasRunningTask, isRunActive, sendStdinSignal, scheduleForceKill,
  cancelled, setCancelled,
  currentProcess,
  skipToScoring, setSkipToScoring,
  tailFlushRequested, setTailFlushRequested,
  aiAbortController, setAiAbortController,
  OUTPUT_DIR, setOutputDir,
  apiConfig, setApiConfig,
  cdpStatus, setCdpStatus,
} from './state.mjs';
import { saveApiConfig, listRecommendJobs, addRecommendJob, getRecommendJobDesc, updateRecommendJob, renameRecommendJob, deleteRecommendJob } from './config.mjs';
import { archiveDirNameMatches, readRunMeta, resolveBatchSource, restoreHistoryToOutput } from './archive.mjs';
import { nonEmptyCandidates, restoreScorableCandidates } from './scoring.mjs';
import { launchChrome, startCdpProxy } from './chrome.mjs';
import { runPipeline } from './pipeline.mjs';
import { runGreeting } from './greet.mjs';

// ISO 时间 → 「YYYY-MM-DD HH:mm」本地时间显示（历史记录用）
function isoToDisplayTime(iso) {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch { return null; }
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

  ipcMain.handle('cancel-extraction', () => {
    setCancelled(true);
    if (currentProcess) {
      // 写入 stdin 通知子进程自行清理（Windows 下 SIGTERM 不可靠）
      sendStdinSignal('CANCEL');
      // 等 6s 让子进程 doCleanup 先落盘进度再退出，超时强制杀
      scheduleForceKill();
    }
    if (aiAbortController) { aiAbortController.abort(); setAiAbortController(null); }
    return { ok: true };
  });

  ipcMain.handle('skip-extraction', () => {
    setSkipToScoring(true);
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
    setTailFlushRequested(true); // v1.8.3：让增量评分器把手头不满一批的零头立刻评完（进度跟上暂停点）
    return { ok: true };
  });

  ipcMain.handle('resume-current-extraction', () => {
    if (currentProcess?._taskType !== 'extract') return { ok: false, reason: 'no-extract-process' };
    sendStdinSignal('RESUME');
    return { ok: true };
  });

  // 批量打招呼。opts.retry 为真 = 只补上次失败名单里的人
  ipcMain.handle('start-greeting', (_event, opts) => {
    if (hasRunningTask()) return { error: '已有任务运行中' };
    const level = opts?.level ?? 4;
    const source = opts?.source || 'recommend';
    runGreeting(level, source, { retry: !!opts?.retry });
    return { ok: true };
  });

  ipcMain.handle('cancel-greeting', () => {
    setCancelled(true);
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
          // 完成页展示与 Excel「AI评级理由」同源同排版（formatComment 统一加 1.2.3. 编号与换行）
          comment: formatComment(c.jobRelevanceComment || ''),
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
    setOutputDir(newDir);
    apiConfig.outputDir = parentDir;
    saveApiConfig(apiConfig);
    termLog(`[config] 输出目录已更改： ${newDir}`);
    return { path: newDir };
  });

  // 清空输出目录下的历史归档数据
  ipcMain.handle('clear-history', async () => {
    const parentDir = dirname(OUTPUT_DIR);
    const baseName = basename(OUTPUT_DIR);
    // 校验：baseName 必须只包含合法字符，避免误删
    if (!/^[a-zA-Z0-9_一-龥-]+$/.test(baseName)) {
      return { error: `输出目录名「${baseName}」包含非法字符，拒绝操作` };
    }

    let deletedCount = 0;
    let errorCount = 0;
    const matchedDirs = [];
    const skippedDirs = [];

    try {
      const entries = readdirSync(parentDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          termLog(`[clear-history] 跳过非目录： ${entry.name}`);
          continue;
        }
        // 归档目录名须形如 {输出目录名}-YYYYMMDD-HHMM（复用 archiveDirNameMatches，防止误删任意目录）
        if (!archiveDirNameMatches(entry.name)) {
          termLog(`[clear-history] 不匹配归档模式： ${entry.name}`);
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
                termLog(`[clear-history] ${entry.name} 删除失败，${retries} 次重试…`, 'stderr');
                await sleep(500);
              }
            }
          }
          if (lastErr) throw lastErr;
          termLog(`[clear-history] 已删除： ${entry.name}`);
          deletedCount++;
        } catch (err) {
          termLog(`[clear-history] 删除失败 ${entry.name}： ${err.message}`, 'stderr');
          errorCount++;
        }
      }
    } catch (err) {
      return { error: `读取目录失败： ${err.message}` };
    }

    termLog(`[clear-history] 匹配到的目录： ${JSON.stringify(matchedDirs)}`);
    termLog(`[clear-history] 未匹配的目录： ${JSON.stringify(skippedDirs)}`);

    return {
      ok: true,
      deleted: deletedCount,
      errors: errorCount,
      parentDir,
      matchedDirs,
      skippedDirs,
    };
  });

  // v1.5.0: 历史记录 —— 列出所有历史归档批次（含当前输出目录里的未完成批次）；v1.12.0 起展示为居中弹窗
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
          // 这一批此刻是否真的在跑（只有当前批次可能）。历史记录里「进行中」蓝胶囊只认这个标记，
          // 不靠文件状态猜：提取中进度文件在、提取收尾时进度文件已被删而评分还没落盘，
          // 两种阶段的文件状态完全不同，靠文件猜「在不在跑」必然猜错（详见 renderer-history.js 那段注释）。
          // 用 isRunActive() 而非 hasRunningTask()：评分是在主进程内跑的，不占子进程（见 state.mjs）
          isRunning: isCurrent && isRunActive(),
        };
        const meta = readRunMeta(dir);
        // 来源标签：meta 明确写的页面优先，其次数据文件写明的页面（meta 丢失/被盖成 chat 也能还原），
        // 都只是 chat/缺失才默认沟通页——避免推荐批次误标沟通，也避免沟通批次显示「未知来源」。
        info.meta = { ...(meta || {}), source: resolveBatchSource(dir, meta) };
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
      return { error: `读取历史记录失败： ${err.message}` };
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
          if (retries > 0) { termLog(`[delete-history] 删除失败，${retries} 次重试…`, 'stderr'); await sleep(500); }
        }
      }
      if (lastErr) throw lastErr;
      termLog(`[delete-history] 已删除： ${dirPath}`);
      return { ok: true };
    } catch (err) {
      return { error: `删除失败： ${err.message}` };
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

    // 用归档时记录的来源/岗位/数量继续跑；读不到元数据时退化为全量提取。
    // 来源取「meta 明确写的页面，否则数据文件写明的页面」，都不会因 meta 丢失/被盖成 chat 跑错页。
    const meta = readRunMeta(OUTPUT_DIR);
    const source = resolveBatchSource(OUTPUT_DIR, meta);
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
      termLog(`[rescore] 已从历史批次恢复可评分数据： ${dirPath}`);
    } catch (err) {
      return { error: `恢复数据失败： ${err.message}` };
    }
    const meta = readRunMeta(dirPath);
    // 来源取「该批次 meta 明确写的页面，否则数据文件写明的页面」
    const source = resolveBatchSource(dirPath, meta);
    const job = meta?.job || '';
    const extractAll = meta ? meta.extractAll !== false : true;
    const count = meta?.count || 0;
    runPipeline(count, true, extractAll, source, job, true, false); // skipExtract=true
    return { ok: true };
  });

  // API 配置 + SMTP 配置（持久化到磁盘）
  ipcMain.handle('set-api-config', (_event, config) => {
    setApiConfig(config); // merge 语义：与内存默认值/已保存值合并，保留未提交字段
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
    setCdpStatus({ state: 'connecting', message: '正在重试…', chromePort: null });
    startCdpProxy().catch(() => {});
    return { ...cdpStatus };
  });

  // 供「开始提取分析」按钮预检：Chrome 已就绪与否；未运行则自动拉起（渲染端若未连上会提示）
  ipcMain.handle('ensure-chrome-open', () => launchChrome({}));

  // GUI 版本号
  ipcMain.handle('get-app-version', () => app.getVersion());

  // —— 岗位增删改查（推荐牛人页岗位列表，存 jd-descriptions/*.txt，实现统一在 config.mjs） ——
  // 岗位列表，外加每条的「可搜索文本」（岗位名原文 + 拼音首字母，一次算好并统一转小写）：
  // 渲染进程搜索时只需一句 includes，原文匹配与拼音匹配合成一条路（输入 xsqd 能搜到「显示驱动工程师」）。
  // 拼音算不了 Node 模块，故在主进程算（见 pinyin.mjs）；随列表同一次返回，渲染进程不必再取一趟
  ipcMain.handle('get-recommend-jobs', () => {
    const jobs = listRecommendJobs();
    return { jobs, searchText: jobs.map(job => `${job} ${pinyinInitials(job)}`.toLowerCase()) };
  });

  ipcMain.handle('add-recommend-job', (_event, jobName, jobDesc) => addRecommendJob(jobName, jobDesc));

  ipcMain.handle('get-recommend-job-desc', (_event, jobName) => getRecommendJobDesc(jobName));

  ipcMain.handle('update-recommend-job', (_event, jobName, jobDesc) => updateRecommendJob(jobName, jobDesc));

  ipcMain.handle('rename-recommend-job', (_event, oldName, newName) => renameRecommendJob(oldName, newName));

  ipcMain.handle('delete-recommend-job', (_event, jobName) => deleteRecommendJob(jobName));
}

export { registerIPC };
