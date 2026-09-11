// electron/pipeline.mjs — 主流程编排：归档→提取×评分并行→导出，含最近归档扫描与自愈补写 meta。
import { resolve, dirname, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { powerSaveBlocker } from 'electron';
import { archiveOldOutput, cleanupCacheFiles } from '../scripts/extract-common.mjs';
import { termLog } from './util.mjs';
import { OUTPUT_DIR, apiConfig, cancelled, setCancelled, skipRecovered, setSkipRecovered, skipToScoring, setSkipToScoring, setExportMailResult, exportMailResult, actualExportPath } from './state.mjs';
import { sendProgress, sendDone, sendError } from './window.mjs';
import { readRunMeta, resolveBatchSource } from './archive.mjs';
import { hasScorableCandidates, restoreScorableCandidates } from './scoring.mjs';
import { runIncrementalScoring, cleanupTempFiles } from './incremental.mjs';
import { runScript, parseExtractProgress, parseExportProgress } from './runner.mjs';
import { isChromeRunning, getSourcePageUrl, launchChrome, buildPageNotOpenMessage, openUrlInChrome } from './chrome.mjs';

// ===== 主流程编排 =====
// 在历史归档目录（output-YYYYMMDD-HHMM）里找最近一份含「可评分数据」的目录
// （完整提取数据 / 提取到一半的进度 / 已评分结果都算）。
// 用于「跳过提取 / 历史记录评分」：数据被归档后仍能恢复出来直接重新评分，无需重新提取。
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

async function runPipeline(count, skipExtract = false, extractAll = false, source = 'chat', job = '', enableCopy = true, resume = false) {
  setCancelled(false);
  setSkipRecovered(false);

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
        termLog(`[main] 归档旧输出目录跳过： ${e.message}`, 'stderr');
      }
      // 兜底：万一归档没挪干净（个别文件仍被占用留在原地），清掉评分器会误读的残留进度/扫描缓存。
      // 新开一轮的进度必须从零开始，绝不能沿用上一批候选人为新岗位抢先开评。
      // 复用 extract-common 的 cleanupCacheFiles（参数传目录内任一文件路径，它据此定位目录）
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
        termLog(`[main] Chrome 未运行，已自动启动并打开 ${pageLabel}页： ${openUrl}`);
        sendProgress(1, 'idle', 0,
          `检测到 Chrome 未运行，已自动启动并打开${pageLabel}页。`
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
      scoringError: null,
    };
    const scoringPromise = runIncrementalScoring(scoreCtx).catch((err) => {
      scoreCtx.scoringError = err;
    });

    if (!skipExtract) {
      sendProgress(1, 'running', 0, extractAll ? `正在扫描候选人列表（${pageLabel}页）…` : '正在扫描候选人列表…');
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
      // v1.4.8: 「跳过提取，直接用已有数据评分」——若当前输出目录没有完整的候选人文件，
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
    if (!existsSync(scoredPath)) throw new Error(`未找到评分结果文件： ${scoredPath}`);

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
      let emailSubject = '候选人评分结果';
      if (isRecommendMode) emailSubject = '推荐牛人评分结果';
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
    // 无论成功/取消/报错，结束运行都要恢复系统原有电源行为
    try {
      if (powerSaveBlocker.isStarted(keepAwakeId)) powerSaveBlocker.stop(keepAwakeId);
    } catch {}
  }
}

export { runPipeline };
