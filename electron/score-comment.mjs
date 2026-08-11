/**
 * 评语 → 匹配度评分的程序化计算与评语文字修正。
 *
 * 这些函数只依赖评语文本，不依赖任何 Electron 全局对象，因此可被 main.mjs
 * 和独立的重算脚本共用，避免两处实现漂移。
 */

/**
 * 从评语程序化计算匹配度评分。
 * AI 手写的「匹配度评分」经常与评论内公式不自洽（实测多例手写分对不上公式），
 * 因此以评语中「各维度独立得分 × 权重」重算加权基础分，再减「其他扣分合计」。
 * 返回 null 表示评论里没有可解析的维度得分（此时回退 parseMatchScoreFromComment）。
 */
export function computeMatchScoreFromComment(comment) {
  if (!comment) return null;
  // 维度条目格式：[评估维度名称]（权重%，独立得分：XX分） 或 （40%，独立得分：90分）
  const dimRe = /（\s*(\d{1,2})\s*%\s*[，,]\s*独立得分\s*[:：]\s*(\d{1,3})\s*分）/g;
  let m;
  let weightedSum = 0;
  let weightSum = 0;
  while ((m = dimRe.exec(comment)) !== null) {
    const w = parseInt(m[1], 10);
    const s = parseInt(m[2], 10);
    if (w <= 0 || s < 0 || s > 100) continue;
    weightedSum += w * s;
    weightSum += w;
  }
  if (weightSum === 0) return null;
  // 加权基础分 = Σ(得分×权重%)，即 weightedSum / 100。权重和为 100 时等价于 weightedSum / weightSum，
  // 用 weightSum 归一化兜底 AI 权重未写满 100 的情况。
  const base = Math.round(weightedSum / weightSum);
  // 其他扣分合计：XX分（无扣分填 0）
  const deduct = comment.match(/其他扣分合计\s*[:：]\s*(\d{1,3})\s*分/);
  let deductVal = deduct ? parseInt(deduct[1], 10) : 0;
  // 学历硬性门槛程序化兜底：AI 常以「最高学历已达标」为由豁免第一学历扣分（实测大量漏扣），
  // 甚至有时在「学历硬性门槛核查」写了扣 20 分、却忘了算进「其他扣分合计」。因此：
  // 只要第一学历明确为大专/非全日制，教育扣分就强制为 20，任职资格扣分从评语独立解析，不依赖 AI 合计。
  const firstDegreeLine = comment.match(/第一学历\s*[:：]\s*([^\n]+)/);
  if (firstDegreeLine) {
    const fdText = firstDegreeLine[1];
    const isDazhuan = /大专|专科/.test(fdText); // 第一学历层次为大专
    // 明确标注非全日制才触发；「未标注/按全日制参考/存疑」不算（避免误伤第一学历已是本科的候选人）
    const isFeiquanzhi = /非全日制/.test(fdText) && !/未标注|按全日制|存疑/.test(fdText);
    if (isDazhuan || isFeiquanzhi) {
      const qualDed = comment.match(/任职资格硬性不达标扣分\s*[:：]?\s*(\d{1,2})\s*分/);
      if (qualDed) {
        // 有任职资格分量 → 教育固定 20，任职资格按 AI 写的不达标扣分
        deductVal = parseInt(qualDed[1], 10) + 20;
      } else {
        // 解析不到任职资格分量 → 从合计补足教育扣分到 20
        const eduDed = comment.match(/学历硬性门槛扣分\s*[:：]\s*(\d{1,3})\s*分/);
        const eduVal = eduDed ? parseInt(eduDed[1], 10) : 0;
        if (eduVal < 20) deductVal += (20 - eduVal);
        else if (deductVal < 20) deductVal = 20;
      }
    }
  }
  return Math.max(0, Math.min(100, base - deductVal));
}

/** 直接解析评语中手写的「匹配度评分：XX分」作为兜底 */
export function parseMatchScoreFromComment(comment) {
  const ms = (comment || '').match(/匹配度评分\s*[:：]\s*(\d{1,3})/);
  return ms ? parseInt(ms[1], 10) : null;
}

/**
 * 学历硬性门槛评语文字修正：当评语第一学历为大专/非全日制、而评语里「学历硬性门槛扣分」不足 20 分时，
 * 同步把评语相关数字和结论改对，避免「评语说不扣分、分数却扣了」的矛盾。
 * 每一处都单独判定，匹配不上就跳过，绝不改动评语其他内容。
 */
export function patchEducationDeductionComment(comment) {
  if (!comment) return comment;
  const fd = comment.match(/第一学历\s*[:：]\s*([^\n]+)/);
  if (!fd) return comment;
  const fdText = fd[1];
  const isDazhuan = /大专|专科/.test(fdText);
  const isFeiquanzhi = /非全日制/.test(fdText) && !/未标注|按全日制|存疑/.test(fdText);
  if (!(isDazhuan || isFeiquanzhi)) return comment;

  const reason = isDazhuan ? '第一学历为大专' : '第一学历为非全日制';

  // 任职资格硬性不达标扣分从评语独立解析（与 computeMatchScoreFromComment 口径一致）
  const qualDed = comment.match(/任职资格硬性不达标扣分\s*[:：]?\s*(\d{1,2})\s*分/);
  let newTotal;
  if (qualDed) {
    newTotal = parseInt(qualDed[1], 10) + 20;
  } else {
    const eduDed = comment.match(/学历硬性门槛扣分\s*[:：]\s*(\d{1,3})\s*分/);
    const oldEduVal = eduDed ? parseInt(eduDed[1], 10) : 0;
    const deductTotal = comment.match(/其他扣分合计\s*[:：]\s*(\d{1,3})\s*分/);
    const oldTotal = deductTotal ? parseInt(deductTotal[1], 10) : 0;
    if (oldEduVal < 20) newTotal = oldTotal + (20 - oldEduVal);
    else newTotal = Math.max(oldTotal, 20);
  }

  // 修正后的最终分数（base 从维度行解析，与 computeMatchScoreFromComment 一致）
  const dimRe = /（\s*(\d{1,2})\s*%\s*[，,]\s*独立得分\s*[:：]\s*(\d{1,3})\s*分）/g;
  let m, ws = 0, wsum = 0;
  while ((m = dimRe.exec(comment)) !== null) {
    const w = parseInt(m[1], 10), s = parseInt(m[2], 10);
    if (w <= 0 || s < 0 || s > 100) continue;
    ws += w * s; wsum += w;
  }
  const base = wsum === 0 ? null : Math.round(ws / wsum);
  const finalScore = base != null ? Math.max(0, Math.min(100, base - newTotal)) : null;

  // 记录 AI 手写的「匹配度评分」，判断是否需要追加系统说明（分数被系统改判时）
  const aiScoreMatch = comment.match(/匹配度评分\s*[:：]\s*(\d{1,3})\s*分/);
  const aiScore = aiScoreMatch ? parseInt(aiScoreMatch[1], 10) : null;
  const needNote = finalScore != null && aiScore != null && finalScore !== aiScore;

  let patched = comment;
  // 1) 学历硬性门槛扣分：X分（...）→ 20分（原因），并清掉残留的「故不扣分」类表述
  patched = patched.replace(/学历硬性门槛扣分\s*[:：]\s*\d{1,3}\s*分\s*（[^）]*）/g, `学历硬性门槛扣分：20分（${reason}，按硬性门槛规则扣除）`);
  patched = patched.replace(/学历硬性门槛扣分\s*[:：]\s*\d{1,3}\s*分/g, `学历硬性门槛扣分：20分`);
  // 2) 其他扣分合计：X分 → 新合计（教育扣分固定 20 + 任职资格扣分）
  patched = patched.replace(/其他扣分合计\s*[:：]\s*\d{1,3}\s*分/, `其他扣分合计：${newTotal}分`);
  // 3) 匹配度评分 → 修正后分数
  if (finalScore != null) {
    patched = patched.replace(/匹配度评分\s*[:：]\s*\d{1,3}\s*分/, `匹配度评分：${finalScore}分`);
  }
  // 4) 合规性结论：覆盖为「按规则扣 20 分」的原因说明
  patched = patched.replace(/(合规性结论：)[^\n]*/, `$1${reason}，按学历硬性门槛规则扣除20分。`);
  // 5) 若系统分数与 AI 手写分数不一致，追加说明，避免用户困惑
  if (needNote) {
    patched += `\n（系统说明：${reason}，已按「学历硬性门槛」规则由系统强制扣除 20 分。评语中 AI 手写的扣分合计、匹配度评分等数字若与最终分数不一致，一律以最终分数 ${finalScore} 分为准。）`;
  }
  return patched;
}
