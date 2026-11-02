// scripts/scored-candidate.mjs — 「评分结果 → 展示行」的唯一映射（叶模块）。
//
// 完成页 / 批次详情（electron/ipc.mjs 的 buildScoringResults）与候选人查询索引
// （electron/candidate-index.mjs）都用它：分数取哪个字段、姓名缺省叫什么、
// 评语怎么排版，改规则只改这一处，三处展示不会各说各话。
import { scoreToTier, scoreToRecommendation, isPassed } from './score-tiers.mjs';
import { formatComment, parseDimensionScores } from './format-comment.mjs';

/** 最终分：优先 totalScore，其次岗位相关性分（老数据），都没有按 0。展示与导出共用这一条口径 */
export const finalScore = (c) => c.totalScore ?? c.jobRelevanceScore ?? 0;

/**
 * 维度得分：[{ weight, score }]。优先用评分时存下的结构化字段 scoreDetail.dimensions，
 * 缺失（或全部无效）时退回评语里的维度行。算分侧（加权基础分）与 Excel 的「维度N得分」
 * 都走这一条取数口径，换数据形状只改这里。
 */
export function dimensionScores(detail, comment) {
  const dims = Array.isArray(detail?.dimensions) ? detail.dimensions : [];
  const valid = dims
    .map((d) => ({ weight: Number(d?.weight), score: Number(d?.score) }))
    .filter((d) => d.weight > 0 && d.score >= 0 && d.score <= 100);
  return valid.length ? valid : parseDimensionScores(comment);
}

export function summarizeScoredCandidate(c) {
  const score = finalScore(c);
  return {
    name: c.basicInfo?.name || c.geekId || '未知',
    position: c.positionInfo?.appliedJob || '',
    score,
    tier: scoreToTier(score),
    level: c.recommendationLevel ?? scoreToRecommendation(score),
    passed: c.passed ?? isPassed(score),
    // 完成页展示与 Excel「AI评级理由」同源同排版（formatComment 统一加 1.2.3. 编号与换行）
    comment: formatComment(c.jobRelevanceComment || ''),
  };
}
