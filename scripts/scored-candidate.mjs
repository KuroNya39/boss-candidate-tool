// scripts/scored-candidate.mjs — 「评分结果 → 展示行」的唯一映射（叶模块）。
//
// 完成页 / 批次详情（electron/ipc.mjs 的 buildScoringResults）与候选人查询索引
// （electron/candidate-index.mjs）都用它：分数取哪个字段、姓名缺省叫什么、
// 评语怎么排版，改规则只改这一处，三处展示不会各说各话。
import { scoreToTier, scoreToRecommendation, isPassed } from './score-tiers.mjs';
import { formatComment } from './format-comment.mjs';

export function summarizeScoredCandidate(c) {
  const score = c.totalScore ?? c.jobRelevanceScore ?? 0;
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
