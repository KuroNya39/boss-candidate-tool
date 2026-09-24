// electron/scoring.mjs — AI 评分：Anthropic API 调用、批量响应解析、候选人数据恢复、分批并发评分。
// 依赖底层 util/state/config/archive；被 incremental/pipeline/ipc 使用，不反向依赖它们。
import { resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { termLog, sleep, UNPACKED_ROOT } from './util.mjs';
import { apiConfig, OUTPUT_DIR, cancelled } from './state.mjs';
import { JD_DIR } from './config.mjs';
import { readRunMeta } from './archive.mjs';
import { formatComment } from '../scripts/format-comment.mjs';

// ===== AI 评分常量（user 确认的参数：并发批数从 6 降到 5 更保守防限流；默认开启并行，不加开关） =====
export const BATCH_SIZE = 3;              // 每批候选人数（保持 3 人一批，用户决定）
export const SCORE_CONCURRENCY = 5;       // 同时并发批数（5批×3人≈15人，用户决定，原 6）
const MAX_RESUME_LEN = 4000;              // 每份简历截断，避免 prompt 过长

// ===== AI 评分 =====

// 调 API（Anthropic 格式）
async function callClaudeAPI(prompt, { signal } = {}) {
  const url = `${apiConfig.url}/v1/messages`.replace(/\/+v1/, '/v1'); // 防双斜杠
  termLog(`[AI评分] 调 API： ${url}, model=${apiConfig.model}`);

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
    termLog(`[AI评分] 完整返回： ${JSON.stringify(data).slice(0, 2000)}`, 'stderr');
    throw new Error(`API 返回内容为空，请检查 API 地址和格式`);
  }

  return text;
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
              // 评语排版统一走 formatComment（唯一实现，与完成页/Excel 同一份；它幂等，后面再排一次也不会变形）
              const formatted = formatComment(comment);
              results.push({ candidateIndex: idx, score, comment: formatted });
              valid = true;
            } else {
              results.push({ candidateIndex: idx ?? -1, score: score ?? 0, comment: comment ?? '（AI评分未生成评语）' });
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

// ===== AI 评分：提取与评分并行（候选人与评分逻辑） =====

// 候选人的稳定标识：geekId 优先（Boss 候选人唯一 id），缺失时退回 index 字段/数组下标
export function candidateKeyOf(c, idx = 0) {
  return c.geekId || ('idx:' + (c.index ?? idx));
}

// 从解析后的数据里取「非空候选人数组」：兼容 {candidates:[...]} 和裸数组两种形状
export function nonEmptyCandidates(raw) {
  const arr = Array.isArray(raw) ? raw : raw?.candidates;
  return Array.isArray(arr) && arr.length > 0 ? arr : null;
}

// 轻量判断：目录里是否有「可能含简历数据」的候选人文件（只看文件是否存在，不解析内容）。
// 给 历史归档扫描 / 历史列表评分按钮这些「只要判断有没有」的场景用；
// 真正要拿数据时再走 restoreScorableCandidates，避免为布尔值做全量 JSON 解析 + 克隆候选人。
export function hasScorableCandidates(dirPath) {
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
export function restoreScorableCandidates(srcDir, destPath) {
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
export function createPositionPromptBuilder(positionName, extractSource, getPoolCandidates) {
  const useWithJd = extractSource !== 'chat';
  const templateName = useWithJd ? 'scoring-prompt-with-jd.txt' : 'scoring-prompt-chat.txt';
  const templatePath = resolve(UNPACKED_ROOT, 'config', templateName);
  let template;
  try {
    template = readFileSync(templatePath, 'utf-8');
  } catch {
    throw new Error(`未找到评分模板： ${templatePath}`);
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
        .replace('{jdText}', jd || dimensionsText || '（无岗位JD描述）');
    }

    // 拼接本批所有候选人的简历（基础信息/教育经历来自页面 DOM，可靠性高；简历正文为 OCR 仅供参考）
    const resumeSections = cands.map((c, i) => {
      const resumeForAI = (c.resumeText || '').length > MAX_RESUME_LEN
        ? (c.resumeText || '').slice(0, MAX_RESUME_LEN) + '\n\n…（后续内容略）'
        : (c.resumeText || '（无）');
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
export async function scoreOneBatch(batch, run) {
  if (cancelled) return;

  const prompt = run.buildBatchPrompt(batch);
  const batchNames = batch.map(c => c.basicInfo?.name || c.geekId || '未知').join('、');
  termLog(`[AI评分] 评分批： ${batchNames}`);

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
            termLog(`  ✓ ${nm}： ${r.score}分`);
          }
        }
        lastError = null;
        break;
      }
      lastError = new Error('解析失败（无有效JSON）');
      if (retry < 2) {
        const ts = Date.now();
        const debugPath = resolve(OUTPUT_DIR, `api-raw-response-${ts}.txt`);
        try { writeFileSync(debugPath, text, 'utf-8'); } catch {}
        termLog(`  ⚠ 解析失败： ${debugPath}，${retry + 1}/2 重试`, 'stderr');
        await sleep(2000);
      }
    } catch (err) {
      if (run.signal.aborted) throw err;
      lastError = err;
      if (retry < 2) {
        termLog(`  ⚠ 请求失败： ${err.message}，${retry + 1}/2 重试`, 'stderr');
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
      termLog(`  ↻ 批次评分失败（${lastError.message}），改为逐人重试 ${batch.length} 人`, 'stderr');
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
              termLog(`  ✓ ${nm}： ${results[0].score}分（逐人重试）`);
              recovered++;
              singleError = null;
              break;
            }
            singleError = new Error('解析失败（无有效JSON）');
          } catch (err) {
            if (run.signal.aborted) throw err;
            singleError = err;
          }
          if (retry < 2) await sleep(2000);
        }
        if (singleError) {
          c.jobRelevanceScore = 0;
          c.jobRelevanceComment = `评分失败： ${singleError.message}`;
        }
      }
      termLog(`  ↻ 逐人重试完成：成功 ${recovered}/${batch.length} 人`, 'stderr');
    } else {
      for (const c of batch) {
        c.jobRelevanceScore = 0;
        c.jobRelevanceComment = `评分失败： ${lastError.message}`;
      }
      termLog(`  ✗ 批次评分失败： ${lastError.message}`, 'stderr');
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
export async function scoreCandidateList(candidates, extractSource, { signal, onBatchDone } = {}) {
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
    termLog(`[AI评分] 岗位「${positionName}」： ${withResume.length} 人，${batches.length} 批，并发 ${SCORE_CONCURRENCY} 批`);
    await runBatchWindow(batches, { signal, buildBatchPrompt, onBatchDone });
  }
}
