// electron/pipeline.mjs — 主流程编排：归档→提取×评分并行→导出，含最近归档扫描与自愈补写 meta。
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { powerSaveBlocker } from 'electron';
import { archiveOldOutput, cleanupCacheFiles, hasBatchData } from '../scripts/progress-store.mjs';
import { termLog } from './util.mjs';
import { OUTPUT_DIR, apiConfig, cancelled, setCancelled, skipRecovered, setSkipRecovered, skipToScoring, setSkipToScoring, setExportMailResult, exportMailResult, actualExportPath, setRunActive, currentProcess, sendStdinSignal } from './state.mjs';
import { sendProgress, sendDone, sendError, requestJdDecision } from './window.mjs';
import { readRunMeta, writeRunMeta, resolveBatchSource, listArchiveDirs } from './archive.mjs';
import { hasScorableCandidates, restoreScorableCandidates, nonEmptyCandidates, sourceUsesFileJd } from './scoring.mjs';
import { runIncrementalScoring, cleanupTempFiles } from './incremental.mjs';
import { CONFIG_DIR, inspectJobDescription } from './config.mjs';
import { runScript, parseExtractProgress, parseExportProgress } from './runner.mjs';
import { isChromeRunning, getSourcePageUrl, launchChrome, buildPageNotOpenMessage, openUrlInChrome } from './chrome.mjs';

// ===== 主流程编排 =====
// 上一轮失败在第几步（1 提取 / 2 评分 / 3 导出），供出错页的「重试」从这一步接着跑。
// 只存在主进程内存里：软件重启后就没有「上一轮」了，本来就该从头开始。
// 运行中直接在这一格上推进（每过一个里程碑改一次），不另设局部镜像。
let lastFailedStep = 0;

// 在历史归档目录（<输出目录>/archive/YYYYMMDD-HHMM）里找最近一份含「可评分数据」的目录
// （完整提取数据 / 提取到一半的进度 / 已评分结果都算）。
// 用于「跳过提取 / 历史记录评分」：数据被归档后仍能恢复出来直接重新评分，无需重新提取。
function findRecentArchiveWithScorable() {
  const dirs = listArchiveDirs().sort((a, b) => b.name.localeCompare(a.name)); // 时间戳命名，字典序即时间序
  for (const d of dirs) {
    if (hasScorableCandidates(d.path)) return { archiveDir: d.path };
  }
  return null;
}

// ===== 岗位描述（JD）缺失拦截 =====
// 推荐页 / 搜索页的 JD 来自软件内岗位文件（文件名即岗位名）。把岗位改了名之后，数据里记的旧名字
// 查不到文件了，而评分侧读 JD 失败是被静默吞掉的：提示词里的维度与筛选项变成空槽，模型自己编一份 JD。
// 所以评分真正发第一个请求之前再查一次（开始前的预检在 renderer-actions.js），缺了就弹窗问用户：
// 补描述 / 另选岗位 / 不评了。用户取消时这条流水线停在「步骤 2 失败」态，已提取的数据原样保留。

// 数据里记的岗位名：提取结果优先，进度与评分结果兜底（推荐/搜索页整批只有一个岗位）。
// 用数据里的名字而不是界面传的名字——评分器是按候选人身上记的岗位名去找 JD 的
function readDataJobName(dir) {
  for (const file of ['zhipin-candidates.json', '.extract-progress.json', 'scored-candidates.json']) {
    try {
      const raw = JSON.parse(readFileSync(resolve(dir, file), 'utf-8'));
      const list = nonEmptyCandidates(raw) || [];
      for (const c of list) {
        const name = c?.positionInfo?.appliedJob || c?.appliedJob || '';
        if (name) return name;
      }
    } catch {}
  }
  return '';
}

// 换了岗位 JD 之后改写批次元数据里的岗位名：否则下次「重新评分」还按旧名字去查，接着找不到
function writeMetaJob(dir, jobName) {
  try {
    const meta = readRunMeta(dir) || {};
    meta.job = jobName;
    writeFileSync(resolve(dir, '.run-meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
  } catch (e) {
    termLog(`[main] 改写 .run-meta.json 岗位名失败： ${e.message}`, 'stderr');
  }
}

// 问用户把岗位描述落实一下，返回 { ok: true, name } 或 { ok: false, reason, jobName }。
// 循环的三种出口：核对通过 / 用户补完描述（内容已非空就算数）/ 用户取消（或关掉弹窗）
async function resolveJobDescription(jobName) {
  let current = jobName;
  for (;;) {
    const info = inspectJobDescription(current);
    if (info.state === 'ok') return { ok: true, name: current };
    const reason = info.state; // 'missing' | 'short'：弹窗按这两种缺口各说各的
    const reply = await requestJdDecision({ reason, jobName: current });
    const action = reply?.action;
    if (action !== 'picked' && action !== 'edited') return { ok: false, reason, jobName: current };
    const next = (typeof reply.job === 'string' ? reply.job.trim() : '') || current;
    // 刚在编辑框里存过内容、名字也没变：哪怕不到 30 字也照用——文件里有内容，模型就不会自己编
    if (action === 'edited' && next === current && inspectJobDescription(current).state !== 'missing') {
      return { ok: true, name: current };
    }
    current = next;
  }
}

async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '', enableCopy = true, resume = false, retry = false, rescoreDir = '') {
  setCancelled(false);
  setSkipRecovered(false);

  // 出错页的「重试」：从上一轮**失败的那一步**接着跑，不回到步骤 1 把已提取的候选人重提一遍。
  // 失败步数记在 lastFailedStep（本模块内存，进程重启即失效——重启后本就该从头来）。
  // 只有渲染进程显式传 retry 才用它：用户点「返回」重新开始是一次全新的运行，不能沿用旧值，
  // 所以每次进这里都清掉，用完不残留。
  const retryFrom = retry ? lastFailedStep : 0;
  lastFailedStep = 0;
  // 步骤 3 失败 = 评分结果已经在了，只重导出；步骤 2 失败 = 提取数据在，跳过提取重新评分。
  // 步骤 1 失败（含「页面未打开」）没有可复用的东西，照常从头提取
  const exportOnly = retryFrom === 3 && existsSync(resolve(OUTPUT_DIR, 'scored-candidates.json'));
  if (retryFrom === 2 || exportOnly) skipExtract = true;

  // 运行期间阻止系统休眠/显示器关闭（v1.3.27）：
  // 同事实测跑一批会因系统休眠后锁屏而暂停。powerSaveBlocker('prevent-display-sleep')
  // 让显示器不自动关闭、系统不自动睡眠，从而不会触发"唤醒后要重新登录"的锁屏。
  // 注意：公司 IT 强制锁屏策略（域策略/屏保锁定）压不住，那种需联系 IT 或运行前手动设置。
  const keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');
  try {
    // 这一轮开始了：历史记录的「进行中」胶囊据此判断（见 state.mjs 的 isRunActive）。
    // 放在 try 里而不是函数头，是为了让下面的 finally 兜住所有出口——否则中途抛错会把
    // 标记留在 true，那一批就永远显示成「进行中」
    setRunActive(true);
    // 归档旧输出目录（在主进程做，避免子进程 rename 时 EBUSY）。
    // resume 模式：历史目录已还原为 OUTPUT_DIR，续跑要保留进度文件，不再归档。
    // 只有旧目录里有真实数据才归档；只有 .run-meta.json 等残留时不归档，避免产生空批次文件夹。
    // v1.8.3：改「逐个文件归档」而非「整目录改名」。Windows 下只要目录里任一文件被占用
    // （最常见：Excel 还开着上次导出的 candidates.xlsx），整目录 rename 就会 EPERM，
    // 导致旧一批的 .extract-progress.json 留在原地——评分器一开跑就把上一轮的历史简历抢先开评。
    if (!skipExtract && !resume && existsSync(OUTPUT_DIR)) {
      try {
        // archive 目录是历史批次的家，不算「这一批有数据」；只剩 meta 的空目录也不归档
        if (hasBatchData(OUTPUT_DIR)) {
          archiveOldOutput(OUTPUT_DIR, false); // 跳过被锁文件，其余照常归档，日志随主进程走 console
        }
      } catch (e) {
        termLog(`[main] 归档旧输出目录跳过： ${e.message}`, 'stderr');
      }
      // 兜底：万一归档没挪干净（个别文件仍被占用留在原地），清掉评分器会误读的残留进度/扫描缓存。
      // 新开一轮的进度必须从零开始，绝不能沿用上一批候选人为新岗位抢先开评。
      // 复用 progress-store 的 cleanupCacheFiles（参数传目录内任一文件路径，它据此定位目录）
      cleanupCacheFiles(resolve(OUTPUT_DIR, 'zhipin-candidates.json'));
    }

    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

    // 评分型运行（skipExtract）不改写批次元数据：它只读 OUTPUT_DIR 里已有的数据，
    // 界面当前选的来源/岗位未必等于这批数据的真实来源。以前这里无条件重写 .run-meta.json，
    // 实测「跳过提取直接评分」会把推荐牛人页批次盖成 chat / count=0 / job 空——
    // 历史记录的来源标签、以及后续「继续提取」读到的还原配置都会跟着错。
    // 有旧 meta 时保留原 meta 不覆盖，source/job 沿用批次真实记录（评分提示词、打招呼开关按真实来源走）；
    // 没有旧 meta（首次评分兜底）才按 resolveBatchSource 解析出的来源补写。
    let prevMeta = null;
    if (skipExtract) {
      prevMeta = readRunMeta(OUTPUT_DIR);
      // 评分/恢复类运行：来源以本批次真实记录为准（meta 明确写的页面优先；
      // meta 只是 chat/缺失时改用数据里写明的具体页面，两者皆无才默认 chat）。
      // job 数据里没有记录，仍取 meta。
      source = resolveBatchSource(OUTPUT_DIR, prevMeta);
      if (prevMeta?.job && !job) job = prevMeta.job;
    }
    if (!(skipExtract && prevMeta)) {
      try {
        writeFileSync(resolve(OUTPUT_DIR, '.run-meta.json'), JSON.stringify({
          source, job: job || '', count, extractAll, startedAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
      } catch (e) {
        termLog(`[main] 警告：写入 .run-meta.json 失败：${e.message}`, 'stderr');
      }
    }

    const isRecommendMode = source === 'recommend' || source === 'recommend-attach';
    const isSearchMode = source === 'search';
    // 推荐页 / 搜索页的岗位描述来自软件内文件；沟通页的 JD 从 BOSS 页面读，不走这套检查。
    // 与评分侧（提示词模板选型）共用同一个判据，别在这里另写一份
    const usesFileJd = sourceUsesFileJd(source);
    // 非空 = 岗位描述没落实，评分不开始（随后按步骤 2 失败收尾，数据原样保留）
    let jdAbort = null;

    // ===== 步骤 1 + 2 并行 =====
    // v1.5.12：提取子进程跑步骤1的同时，评分器轮询 .extract-progress.json 边提取边评分；
    // 提取结束（成功/失败/跳过）后由评分器统一收尾（成功写 scored-candidates.json，失败不写）。
    let extractError = null; // 提取失败原因（先让评分器退出，再抛出）

    // pageLabel 自带「页」字（拼消息时不再补），且只按用户看到的三个来源取名：
    // recommend 与 recommend-attach 是同一个「推荐牛人页」（前者脚本自己开页面，只在命令行用），
    // 界面上不区分，提示语里也不必提「手动筛选」
    let scriptName;
    let pageLabel;
    const isAttach = source === 'recommend-attach' || source === 'search';
    if (isSearchMode) {
      scriptName = 'extract-search-candidates.mjs';
      pageLabel = '搜索页';
    } else if (isRecommendMode) {
      scriptName = 'extract-recommend-candidates.mjs';
      pageLabel = '推荐牛人页';
    } else {
      scriptName = 'extract-candidates-full.mjs';
      pageLabel = '沟通页';
    }

    // v1.4.6: Chrome 未运行时，自动启动 Chrome 并打开对应页面，
    // 提示用户设置好筛选条件后再次点击「开始提取分析」（不再直接报连接失败）。
    // 检查需在启动评分器之前完成，避免提前 return 时评分器空转。
    if (!skipExtract && !(await isChromeRunning())) {
      const openUrl = getSourcePageUrl(source);
      const launchRes = await launchChrome({ openUrl });
      if (launchRes.ok) {
        termLog(`[main] Chrome 未运行，已自动启动并打开 ${pageLabel}： ${openUrl}`);
        sendProgress(1, 'idle', 0,
          `检测到 Chrome 未运行，已自动启动并打开${pageLabel}。`
          + '请等待页面加载、登录 BOSS直聘并设置好筛选条件后，再次点击「开始提取分析」。');
        return;
      }
      termLog(`[main] Chrome 未运行，自动启动失败： ${launchRes.message}`, 'stderr');
    }

    // —— 启动并行评分器（提取过程中边提取边评分） ——
    const scoreCtx = {
      outputDir: OUTPUT_DIR,
      source,
      extractResult: null,          // 提取分支由下方设置；跳过提取分支预置 {ok:true}
      skipIncremental: skipExtract, // 跳过提取 → 不轮询进度文件，直接全量评分
      seedScores: resume,           // 继续提取 → 用上次评分播种，只补评新增候选人
      indexDir: CONFIG_DIR,         // 候选人查询索引：收尾时记录本次评过的人
      scoringError: null,
      // 评分时换了岗位（旧名查不到 JD，用户当场重新指认）：整批都按新岗位的 JD 出题，
      // 结果里的岗位名也一并改成它（收尾时改写，见 incremental.mjs 的 finalizeScoring）
      jobNameOverride: '',
      // 评分器在发出第一批请求之前调一次：核对岗位描述。缺 → 弹窗问用户；取消 → 抛错停下整轮。
      // 放在这里而不是流水线开头，是因为提取要跑很久：改名可能发生在提取途中
      ensureJd: null,
    };
    if (usesFileJd) {
      scoreCtx.ensureJd = async () => {
        // 岗位名取数据里记的那个（评分器就是按它找 JD 的）；数据还没写出来才退回界面传的
        const initialName = readDataJobName(OUTPUT_DIR) || job || '';
        if (!initialName) {
          termLog('[AI评分] ⚠ 数据里没有记录岗位名，跳过岗位描述检查', 'stderr');
          return;
        }
        const resolved = await resolveJobDescription(initialName);
        if (!resolved.ok) {
          const message = resolved.reason === 'missing'
            ? `未找到目标岗位「${resolved.jobName}」的岗位描述，本次未开始评分。`
            : `目标岗位「${resolved.jobName}」缺少岗位描述，本次未开始评分。`;
          // 存 Error 本身：下面收尾时还要拿它当「步骤 2 失败」的原因，不必再从字符串重新包一遍
          jdAbort = new Error(message);
          // 提取还在跑就一并停下：评分已经被拦下，让提取再空跑一小时毫无意义
          if (currentProcess?._taskType === 'extract') sendStdinSignal('CANCEL');
          throw jdAbort;
        }
        if (resolved.name !== initialName) {
          termLog(`[AI评分] 岗位描述改用「${resolved.name}」（数据里记的是「${initialName}」）`);
          scoreCtx.jobNameOverride = resolved.name;
          writeMetaJob(OUTPUT_DIR, resolved.name);
        }
      };
    }
    const scoringPromise = exportOnly ? Promise.resolve() : runIncrementalScoring(scoreCtx).catch((err) => {
      scoreCtx.scoringError = err;
    });

    if (exportOnly) {
      // 步骤 1 上一轮已经跑完（只有导出失败才走这里）：补一条「已完成」，
      // 免得重试时卡片停在「等待中」、看着像跳过了这一步（步骤 2 下面统一报）
      sendProgress(1, 'done', 100, '候选人信息提取完成');
    } else if (!skipExtract) {
      // 两种数量模式同一句话：消息里只报「在哪个页面扫」，勾不勾「提取全部」看不出差别
      sendProgress(1, 'running', 0, `正在扫描候选人列表（${pageLabel}）…`);
      const extractArgs = extractAll
        ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
        : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
      if (job) {
        extractArgs.push('--job', job);
      }
      // v1.9.3: 把真实来源下传给提取子进程，让它写进扫描缓存/进度/结果文件，
      // 这样即使 .run-meta.json 丢失或被评分流程覆盖，批次数据本身仍记得自己来自哪个页面。
      extractArgs.push('--source', source);
      if (isAttach) {
        extractArgs.push('--attach');
      }
      if (resume) {
        extractArgs.push('--resume'); // v1.5.0: 继续提取，跳过已完成项
      }
      extractArgs.push('--enable-copy', enableCopy ? '1' : '0'); // v1.4.4 模拟复制开关

      let extractPromise;
      try {
        // BOSS_OUTPUT_PREARCHIVED：本函数开头已归档过旧输出目录、并写好了本轮的 .run-meta.json，
        // 子进程不必（也不能）再归档一次——否则会把本轮 meta 卷进上一批的归档目录，导致来源错标。
        extractPromise = runScript(scriptName, extractArgs, 1, parseExtractProgress, { BOSS_OUTPUT_PREARCHIVED: '1' }, 'extract');
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
            setSkipToScoring(false);
            setSkipRecovered(true);
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

      // 岗位描述没落实（评分器在发第一批请求前被拦下，提取已被叫停）：
      // 按「步骤 2 失败」收尾。lastFailedStep=2 → 点「重试」跳过提取、直接重新走一遍检查
      if (jdAbort) {
        lastFailedStep = 2;
        scoreCtx.extractResult = { ok: false, error: jdAbort };
        await scoringPromise;
        throw jdAbort;
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
      lastFailedStep = 2; // 提取已成功：之后再出错都算步骤 2
      if (scoreCtx.scoringError) throw scoreCtx.scoringError;
    } else {
      // v1.4.8: 「已跳过提取，直接使用已有数据进行评分」——若当前输出目录没有完整的候选人文件，
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
            termLog(`[main] 从数据目录恢复可评分数据： ${srcDir}`);
            sendProgress(1, 'running', 30, '正在恢复上次提取的数据…');
            break;
          }
        }
        if (!restored) {
          // 无数据：评分器无意义，先让它退出再报错
          scoreCtx.extractResult = { ok: false, error: 'no data' };
          await scoringPromise;
          throw new Error('未找到已提取的候选人数据。请先点击「开始提取分析」进行提取，或使用上次已提取的数据进行评分。');
        }
      }
      sendProgress(1, 'done', 100, '已跳过提取，直接使用已有数据进行评分');
      scoreCtx.extractResult = { ok: true };
      await scoringPromise;
      if (cancelled) throw new Error('已取消');
      lastFailedStep = 2;
      if (scoreCtx.scoringError) throw scoreCtx.scoringError;
    }

    // 步骤 3: 导出
    sendProgress(2, 'done', 100, 'AI 评分完成');
    sendProgress(3, 'running', 0, '正在导出 Excel…');
    const scoredPath = resolve(OUTPUT_DIR, 'scored-candidates.json');
    if (!existsSync(scoredPath)) throw new Error(`未找到评分结果文件：${scoredPath}`);
    lastFailedStep = 3; // 评分结果已在，之后出错都能直接重导出

    // v1.9.3 自愈：这轮跑到评分完成，确保当前目录一定留有 .run-meta.json。
    // 个别异常流程（早期写 meta 被占用/被跳过）可能留下「有数据没 meta」的批次，
    // 历史记录会显示未知来源、继续提取也无从还原页面——这里兜底补写一份。
    try {
      const metaPath = resolve(OUTPUT_DIR, '.run-meta.json');
      if (!existsSync(metaPath)) {
        let total = count;
        let firstJob = job || '';
        try {
          const raw = JSON.parse(readFileSync(scoredPath, 'utf-8'));
          const arr = Array.isArray(raw?.candidates) ? raw.candidates : (Array.isArray(raw) ? raw : null);
          if (arr && arr.length > 0) {
            total = arr.length;
            if (!firstJob) firstJob = arr[0]?.positionInfo?.appliedJob || arr[0]?.appliedJob || '';
          }
        } catch {}
        const resolved = resolveBatchSource(OUTPUT_DIR, readRunMeta(OUTPUT_DIR));
        writeFileSync(metaPath, JSON.stringify({
          source: resolved,
          job: firstJob,
          count: typeof total === 'number' && total > 0 ? total : 0,
          extractAll,
          startedAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
        termLog(`[main] 自愈：补写缺失的 .run-meta.json（source=${resolved}）`);
      }
    } catch (e) {
      termLog(`[main] 补写 .run-meta.json 失败：${e.message}`, 'stderr');
    }

    // 每次导出前重置邮件结果，避免残留上一次的状态
    setExportMailResult({ status: 'none', to: '', error: '' });

    // 构建导出参数：若有 emailPrefix，传给导出脚本自动发邮件
    let exportArgs = ['--input', scoredPath];
    const smtpEnv = {};
    if (apiConfig.emailPrefix) {
      if (!apiConfig.smtpPass) {
        throw new Error('未配置邮箱密码：请在「设置」填写邮箱密码后再发送邮件（若邮箱开启了「三方客户端安全密码」功能，须填写该密码，而非邮箱登录密码）');
      }
      // 邮件主题统一成「来源页 + 评分结果」，收件人一眼看出这批候选人是从哪个页面抓的
      let emailSubject = '沟通页评分结果';
      if (isRecommendMode) emailSubject = '推荐牛人页评分结果';
      else if (isSearchMode) emailSubject = '搜索页评分结果';
      // 发件邮箱 = 收件邮箱 = 填的邮箱（必须填完整邮箱，含 @；工具会分享给不同公司使用，不再自动补域名）
      const emailUser = apiConfig.emailPrefix.trim();
      if (!emailUser.includes('@')) {
        throw new Error('「邮箱地址」请填写完整地址（含 @），例如 hr@example.com，否则无法发送邮件');
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

    // 导出可能因文件被占用改用带时间戳的文件名，后面的写回与完成页都用这一份
    const excelPath = actualExportPath || resolve(OUTPUT_DIR, 'candidates.xlsx');

    // 历史批次「重新评分」：把这一轮的结果与 Excel 写回原批次目录，覆盖它上次的分数。
    // 不写回的话，重新评分只在输出目录多出一批，原批次永远停在上一次的分数上。
    // 只在这一轮完整跑完（评分 + 导出都成功）时写，半路失败保持原样。
    if (rescoreDir) {
      try {
        copyFileSync(scoredPath, resolve(rescoreDir, 'scored-candidates.json'));
        if (existsSync(excelPath)) copyFileSync(excelPath, resolve(rescoreDir, 'candidates.xlsx'));
        // 原批次没有 meta（老批次）才补一份：有就保持它自己那份，别把工作副本的标记顺回来
        if (!existsSync(resolve(rescoreDir, '.run-meta.json'))) {
          const metaJson = readRunMeta(OUTPUT_DIR);
          if (metaJson) {
            delete metaJson.rescoredFrom;
            writeRunMeta(rescoreDir, metaJson);
          }
        }
        termLog(`[rescore] 新评分结果已写回批次目录： ${rescoreDir}`);
      } catch (e) {
        // 写回失败不影响本次结果（输出目录里仍是完整的一份），只记日志
        termLog(`[rescore] 写回批次目录失败：${e.message}`, 'stderr');
      }
    }

    // 邮件是否真的发出去了以脚本标记为准：只有 MAIL_OK 才算已发送，
    // 认证失败等情况下不再误报「邮件已发送至」
    const emailSent = exportMailResult.status === 'ok';
    sendDone({
      outputDir: OUTPUT_DIR,
      excelPath,
      emailTo: emailSent ? exportMailResult.to : null,
      emailError: exportMailResult.status === 'fail' ? exportMailResult.error : '',
    });
  } catch (err) {
    // lastFailedStep 已在运行中按里程碑推进，这里不必再记（步骤 1 失败时它仍是进函数时清掉的 0）
    if (err.message === '已取消') {
      sendProgress(1, 'idle', 0, '已取消');
      sendProgress(2, 'idle', 0, '');
      sendProgress(3, 'idle', 0, '');
    } else if (err.message.includes('未找到已打开的')) {
      // 对应来源页面没打开：自动打开对应页带用户过去（只打开正确页面，不再重启 Chrome——
      // 那会关掉用户标签页），同时只报一句「该怎么做」，不贴长串退出码。
      const pageMsg = buildPageNotOpenMessage(err.message);
      if (pageMsg) {
        openUrlInChrome(getSourcePageUrl(source));
        termLog(`[main] 页面未打开，已自动打开来源页： ${getSourcePageUrl(source)}`);
      }
      sendError({ message: pageMsg || '请先在 Chrome 中打开 BOSS直聘对应页面，设置好筛选条件后，点击「重试」。' });
    } else {
      sendError({ message: err.message });
    }
  } finally {
    // 无论成功/取消/报错，这一轮都结束了：历史记录的「进行中」胶囊要立刻熄灭，
    // 不能等到下一次运行——否则被停止/报错的批次会一直显示成还在跑
    setRunActive(false);
    // 无论成功/取消/报错，结束运行都要恢复系统原有电源行为
    try {
      if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    } catch {}
  }
}

export { runPipeline };
