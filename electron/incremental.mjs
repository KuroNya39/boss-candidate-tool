// electron/incremental.mjs — 提取与评分并行的增量评分器 + 收尾临时文件清理。
// 依赖底层 util/state/window/scoring/score-comment/score-tiers；被 pipeline 调用。
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { computeMatchScoreFromComment, parseMatchScoreFromComment, patchEducationDeductionComment } from './score-comment.mjs';
import { scoreToRecommendation, isPassed } from '../scripts/score-tiers.mjs';
import { termLog, sleep } from './util.mjs';
import { tailFlushRequested, setTailFlushRequested, setAiAbortController, aiAbortController, cancelled, OUTPUT_DIR } from './state.mjs';
import { sendProgress } from './window.mjs';
import { candidateKeyOf, BATCH_SIZE, SCORE_CONCURRENCY, createPositionPromptBuilder, scoreOneBatch, scoreCandidateList } from './scoring.mjs';
import { appendCandidateIndex } from './candidate-index.mjs';

// 增量评分器内部轮询/启动/放行阈值（用户确认的参数）
const POLL_MS = 1500;              // 提取过程中轮询进度文件的间隔
const POOL_START_THRESHOLD = 15;   // 提取到 15 人即开始边提取边评分（用户决定）
const FLUSH_TIMEOUT = 30000;       // 不满一批的尾巴等待 30s 就放行，避免一直卡到提取结束

// ===== 提取与评分并行：增量评分器 =====
// ctx: { outputDir, source, extractResult, skipIncremental, seedScores, indexDir, scoringError }
//   - extractResult: 由 runPipeline 在提取子进程关闭/跳过恢复完成时设置 {ok:true}；失败设 {ok:false}
//   - skipIncremental: 跳过提取直接评分时为 true（不轮询进度文件，等 extractResult 后直接收尾）
//   - seedScores: 继续提取时为 true，用上次 scored-candidates.json 播种，只补评新增候选人
//   - indexDir: 候选人查询索引目录（CONFIG_DIR）；收尾时只把本次真正评过的人记进去
async function runIncrementalScoring(ctx) {
  const { outputDir, source } = ctx;
  const progressPath = resolve(outputDir, '.extract-progress.json');
  const finalPath = resolve(outputDir, 'zhipin-candidates.json');
  setTailFlushRequested(false); // 本轮评分开始先清零：上次暂停残留的置位不该影响本轮（在下方循环里消费）

  // 可取消的 AI 评分：创建 AbortController，所有 API 请求共享
  const controller = new AbortController();
  setAiAbortController(controller);
  const signal = controller.signal;

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
  let lastSent = '';                 // 步骤2 上次已发的进度帧（去重用，见 sendStep2Progress）
  let lastPollAt = 0;

  // 继续提取：把上次已评的分数播种进 scored 表，只补评新增候选人
  const seededKeys = new Set(); // 播种进来的旧分：收尾写索引时排除，免得旧评价被记成今天评的
  if (ctx.seedScores) {
    try {
      const prevPath = resolve(outputDir, 'scored-candidates.json');
      if (existsSync(prevPath)) {
        const prev = JSON.parse(readFileSync(prevPath, 'utf-8'));
        const list = prev.candidates || prev;
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (typeof c.jobRelevanceScore === 'number') {
            seededKeys.add(candidateKeyOf(c, i));
            scoredRefs.set(candidateKeyOf(c, i), c);
          }
        }
        termLog(`[AI评分] 已播种上次评分 ${scoredRefs.size} 人，只补评新增候选人`);
      }
    } catch (err) {
      termLog(`[AI评分] 播种上次评分失败： ${err.message}`, 'stderr');
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

  // —— 步骤2 进度唯一出口：百分比与文字永远一起发，同样的数字+同样的话不重复发 ——
  // 「一起发」是硬要求：只发文字、不带百分比，进度条会冻在上一格，看着就像「没有进度了」
  // （收尾阶段踩过这个坑）。增量轮询与收尾补评都从这里出，谁也不必自己记得这条规矩。
  function sendStep2Progress(x, y, msg) {
    if (y === 0) return; // 空列表时别算 0/0（NaN%）
    const key = `${x}/${y}|${msg}`;
    if (key === lastSent) return;
    lastSent = key;
    sendProgress(2, 'running', Math.round((x / y) * 100), msg);
  }

  // —— 增量期进度上报（读已评/已见人数） ——
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
    sendStep2Progress(x, y, msg);
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

    // 步骤2 收尾总览：共 X 人，分布在 Y 个岗位。
    // 总览与「已评 x/y 人」合成一条提示：收尾阶段剩下的往往只有一两人（增量阶段已评掉绝大部分），
    // 总览若单独占一条，它会在补评那次 API 调用期间一直挂着（十几秒到几十秒）、进度条也停在原地，
    // 看着就像「只显示共X人X个岗位、后面没有进度了」（2026-10-10 实测：跳过提取 27 人只补评 2 人，
    // 总览挂满整段补评，之后唯一一条 100% 立刻被「AI 评分完成」顶掉）。合起来后两者兼得。
    const jobCount = new Set(candidates.map(c => c.positionInfo?.appliedJob || '未知岗位')).size;
    const overview = `共 ${candidates.length} 人，${jobCount} 个岗位`;

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

    // 收尾进度上报：合并后立刻报一次（进度条与人数马上反映真实状态，不必等第一批补评回来），
    // 之后每完成一批补评再报一次。已全部评完时这里就是 100%，补评分支自然跳过。
    const reportFinalProgress = () => {
      if (cancelled) return;
      const scoredCount = candidates.filter(c => typeof c.jobRelevanceScore === 'number').length;
      sendStep2Progress(scoredCount, candidates.length, `${overview} · 已评 ${scoredCount}/${candidates.length} 人`);
    };
    reportFinalProgress();

    // 2) 补评差集（增量阶段没评到的，含提取结束时最后几个候选人）
    const unscored = candidates.filter(c => typeof c.jobRelevanceScore !== 'number');
    if (unscored.length > 0) {
      termLog(`[AI评分] 收尾补评 ${unscored.length} 人`);
      await scoreCandidateList(unscored, extractSource, { signal, onBatchDone: reportFinalProgress });
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

    // 候选人查询索引：跟「结果已落盘」绑在一起（所有评分路径都汇到这），
    // 只记本次真正评过的人 —— 继续提取时播种进来的旧分不能按今天重记一遍。
    // 写失败只记日志：索引坏了也不能拖累导出。
    if (ctx.indexDir) {
      try {
        const freshlyScored = candidates.filter((c, i) => !seededKeys.has(candidateKeyOf(c, i)));
        const added = appendCandidateIndex(ctx.indexDir, freshlyScored);
        if (added > 0) termLog(`[候选查询] 已记录 ${added} 条评分到索引`);
      } catch (err) {
        termLog(`[候选查询] 写入索引失败（不影响本次导出）：${err?.message || err}`);
      }
    }
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
        setTailFlushRequested(false);
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
    setAiAbortController(null);
  }
}


function cleanupTempFiles() {
  const dir = OUTPUT_DIR;
  if (!existsSync(dir)) return;

  // 截图目录 .temp-screenshots/ 有意保留：用户要求跑完后还能回看 OCR 原始截图。
  // （体积较大时可在「设置 → 输出目录」里手动清理，或等下次归档时不占当前目录）

  const rawPath = resolve(dir, 'zhipin-candidates.json');
  if (existsSync(rawPath)) {
    try {
      unlinkSync(rawPath);
      termLog(`[main] 已清理： zhipin-candidates.json`);
    } catch (e) {
      termLog(`[main] 清理 zhipin-candidates.json 失败： ${e.message}`, 'stderr');
    }
  }

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith('api-raw-response-') && entry.endsWith('.txt')) {
        unlinkSync(resolve(dir, entry));
        termLog(`[main] 已清理： ${entry}`);
      }
    }
  } catch (e) {
    termLog(`[main] 清理 API 日志失败： ${e.message}`, 'stderr');
  }
}

export { runIncrementalScoring, cleanupTempFiles };
