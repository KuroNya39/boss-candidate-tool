/**
 * 档位阈值共享常量 —— 打分/打招呼/导出/统计的单一数据源。
 *
 * 档位划分（全链路必须一致）：
 *   5 星 = 强烈推荐（91 分以上）
 *   4 星 = 推荐（81 分以上）
 *   3 星 = 可考虑（61 分以上）  ← 通过线：61 分
 *   2 星 = 二星（31 分以上）
 *   1 星 = 一星（31 分以下）
 *
 * 为什么放在 scripts/ 而不是 electron/：
 * 打包后 scripts/ 在 app.asar.unpacked，被主进程 spawn 的子进程
 * （greet/export）只能 import 同目录（unpacked）的模块，够不到 electron/ 里的文件；
 * 而主进程可以经 asar 重定向 import scripts/（与它 import iconv-lite 走
 * asarUnpack 的 node_modules 同一机制）。因此这里作为唯一数据源，
 * main.mjs 用 '../scripts/score-tiers.mjs' 引入，脚本用 './score-tiers.mjs' 引入。
 */

export const TIER_THRESHOLDS = { 5: 91, 4: 81, 3: 61, 2: 31, 0: 0 };

/** 通过线：三星及以上（61 分）视为通过，可打招呼 */
export const PASS_THRESHOLD = 61;

/** 档位下拉/统计的显示文案（key 与 TIER_THRESHOLDS 一致，0 = 全部） */
export const TIER_LABELS = {
  5: '五星（91 分以上）',
  4: '四星及以上（81 分以上）',
  3: '三星及以上（61 分以上）',
  2: '二星及以上（31 分以上）',
  0: '全部候选人',
};

/** 分数 → 档位星数（1-5） */
export function scoreToTier(score) {
  if (score >= TIER_THRESHOLDS[5]) return 5;
  if (score >= TIER_THRESHOLDS[4]) return 4;
  if (score >= TIER_THRESHOLDS[3]) return 3;
  if (score >= TIER_THRESHOLDS[2]) return 2;
  return 1;
}

/** 分数 → 推荐级别文案 */
export function scoreToRecommendation(score) {
  if (score >= TIER_THRESHOLDS[5]) return '强烈推荐';
  if (score >= TIER_THRESHOLDS[4]) return '推荐';
  if (score >= TIER_THRESHOLDS[3]) return '可考虑';
  return '暂不推荐';
}

/** 分数 → 是否通过（可打招呼） */
export function isPassed(score) {
  return score >= PASS_THRESHOLD;
}

/** 等级 → 过滤阈值（打招呼等级过滤；未知等级回退四星 81 分） */
export function thresholdForLevel(level) {
  return TIER_THRESHOLDS[level] ?? TIER_THRESHOLDS[4];
}
