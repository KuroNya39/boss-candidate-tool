/**
 * 一次性重算脚本：对已生成的 scored-candidates.json 重新应用
 * computeMatchScoreFromComment（含学历硬性门槛程序化兜底）与评语文字修正，
 * 不重新调用 AI。
 *
 * 用法：
 *   node scripts/reprocess-scored.mjs [输入路径] [输出路径]
 *   默认输入 = 桌面 output/scored-candidates.backup-rescore.json（干净的重评结果）
 *   默认输出 = 桌面 output/scored-candidates.json
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { computeMatchScoreFromComment, parseMatchScoreFromComment, patchEducationDeductionComment } from '../electron/score-comment.mjs';

const DEFAULT_DIR = resolve(homedir(), 'Desktop', 'output');
const inputPath = process.argv[2] || resolve(DEFAULT_DIR, 'scored-candidates.backup-rescore.json');
const outputPath = process.argv[3] || resolve(DEFAULT_DIR, 'scored-candidates.json');

const raw = JSON.parse(readFileSync(inputPath, 'utf-8'));
const output = raw.candidates ? raw : { candidates: raw };
const candidates = output.candidates;

let dazhuanCount = 0;
let changedCount = 0;
const changed = [];
for (const c of candidates) {
  const oldScore = c.totalScore;
  c.matchScore = computeMatchScoreFromComment(c.jobRelevanceComment) ??
    parseMatchScoreFromComment(c.jobRelevanceComment);
  c.totalScore = c.matchScore ?? (c.jobRelevanceScore || 0);
  c.jobRelevanceComment = patchEducationDeductionComment(c.jobRelevanceComment);
  if (c.totalScore >= 91) c.recommendationLevel = '强烈推荐';
  else if (c.totalScore >= 81) c.recommendationLevel = '推荐';
  else if (c.totalScore >= 61) c.recommendationLevel = '可考虑';
  else c.recommendationLevel = '暂不推荐';
  c.passed = c.totalScore >= 61;

  const fd = (c.jobRelevanceComment || '').match(/第一学历\s*[:：]\s*([^\n]+)/);
  const fdText = fd ? fd[1] : '';
  const isDazhuan = /大专|专科/.test(fdText);
  const isFeiquanzhi = /非全日制/.test(fdText) && !/未标注|按全日制|存疑/.test(fdText);
  if (isDazhuan || isFeiquanzhi) {
    dazhuanCount++;
    if (c.totalScore !== oldScore) {
      changedCount++;
      changed.push({ name: c.basicInfo?.name, oldScore, newScore: c.totalScore, fd: fdText.trim() });
    }
  }
}

writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

console.log(`已重算 ${candidates.length} 人 → ${outputPath}`);
console.log(`第一学历为大专/非全日制：${dazhuanCount} 人`);
console.log(`其中分数被新逻辑改判：${changedCount} 人`);
for (const c of changed) {
  console.log(`  ${c.name}：${c.oldScore} → ${c.newScore}（第一学历：${c.fd}）`);
}
