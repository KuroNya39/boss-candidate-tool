/**
 * 评语 → 匹配度评分的程序化计算与评语文字修正。
 *
 * 这些函数只依赖评语文本，不依赖任何 Electron 全局对象，因此可被 main.mjs
 * 和独立的重算脚本共用，避免两处实现漂移。
 */
import { DEGREE_ANY_RE, DEGREE_BELOW_BACHELOR, DEGREE_BACHELOR_PLUS, DEGREE_SECONDARY, DEGREE_NON_STANDARD } from '../scripts/degree.mjs';

// —— 第一学历「低于全日制本科」的判定（两个函数共用一份口径，避免漂移） ——
// 口径：第一学历不是全日制本科及以上（大专、专科、高职、中专、技校、高中、职高、成人、自考、
// 函授、非全日制等）一律按学历硬性门槛扣 20 分，只有全日制本科及以上不扣。
// 学历词本身来自 scripts/degree.mjs（提取/评分/导出全链路唯一一份词汇表），这里只定义「怎么判」。
// 判定顺序有讲究，别随便调换（每一步都有理由）：
//   ① 行内出现「大专/专科/高职/中专/中技/技校/初中」→ 直接扣。这些基本就是第一学历本身，
//      哪怕是「全日制大专，之后专升本读了全日制本科」这种写法，第一学历也确实是大专。
//   ② 行内有「本科及以上」、且没有任何非统招标记 → 不扣。这一步专门挡「第一学历是全日制本科、
//      但简历里也写了高中」的情况：AI 可能把高中一起塞进这一行、位置甚至排在本科前面，
//      不能看见「高中」两个字就扣分 —— 高中/职高属于中等教育，本来就不是任何人的第一学历。
//   ③ 成人/自考/函授等非统招形式 → 扣。
//   ④ 整行只剩「高中/职高」→ 扣。
//   ⑤ 明确标注「非全日制」→ 扣。
// 命中的词会写进评语（如「第一学历为大专」）；一行里出现多个学历词时取最靠左的那个（正则语义）。
const FIRST_DEGREE_RE = /第一学历\s*[:：]\s*([^\n]+)/;
const CERTAIN_BELOW_RE = new RegExp(DEGREE_BELOW_BACHELOR.join('|'));
const BACHELOR_PLUS_RE = new RegExp(DEGREE_BACHELOR_PLUS.join('|'));
const SECONDARY_RE = new RegExp(DEGREE_SECONDARY.join('|'));
// 非统招形式：这些写法本身就是非全日制学历，出现即算不达标（不受下面排除词影响）
const NON_STANDARD_RE = new RegExp(DEGREE_NON_STANDARD.join('|'));
// 「非全日制」要排除「未标注/按全日制参考/存疑」这类模棱两可的写法，避免误伤第一学历已是本科的候选人
const isNonFullTime = (t) => /非全日制/.test(t) && !/未标注|按全日制|存疑/.test(t);

/**
 * 结构化写法收窄判据：提示词要求 AI 按「学校 | 专业 | 学历层次 | 就读时间 | 全日制/非全日制」输出
 * （见 config/scoring-prompt-*.txt 步骤3），取得到分隔字段时就只用「层次段 + 形式段」判，
 * 免得专业名、备注里的字干扰。层次段是「高中/职高」时不收窄 —— 高中不可能是第一学历，
 * 多半是 AI 把简历里的中学经历也塞进来了，整行交给下面的阶梯判（阶梯第 ② 步能挡住
 * 「这一行里同时写着本科」的情况）。老评语（AI 没按分隔符写）直接整行判。
 */
function gateText(fdText) {
  const fields = fdText.split(/[|｜]/).map(s => s.trim()).filter(Boolean);
  if (fields.length < 3) return fdText;
  const level = fields.find(f => DEGREE_ANY_RE.test(f));
  if (!level || SECONDARY_RE.test(level)) return fdText;
  return [level, ...fields.filter(f => /全日制/.test(f))].join(' ');
}

/** 第一学历是否触发学历硬性门槛扣分：触发返回原因短语（如「第一学历为大专」），否则返回 null */
function educationGateReason(fdText) {
  if (!fdText) return null;
  const text = gateText(fdText);
  const certain = text.match(CERTAIN_BELOW_RE);
  if (certain) return `第一学历为${certain[0]}`;
  const nonStandard = text.match(NON_STANDARD_RE);
  const nonFullTime = isNonFullTime(text);
  if (BACHELOR_PLUS_RE.test(text) && !nonStandard && !nonFullTime) return null;
  if (nonStandard) return `第一学历为非全日制（${nonStandard[0]}）`;
  const secondary = text.match(SECONDARY_RE);
  if (secondary) return `第一学历为${secondary[0]}`;
  if (nonFullTime) return '第一学历为非全日制';
  return null;
}

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
  // 只要第一学历低于全日制本科（口径见 educationGateReason），教育扣分就强制为 20，
  // 任职资格扣分从评语独立解析，不依赖 AI 合计。
  const firstDegreeLine = comment.match(FIRST_DEGREE_RE);
  if (firstDegreeLine && educationGateReason(firstDegreeLine[1])) {
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
  return Math.max(0, Math.min(100, base - deductVal));
}

/** 直接解析评语中手写的「匹配度评分：XX分」作为兜底 */
export function parseMatchScoreFromComment(comment) {
  const ms = (comment || '').match(/匹配度评分\s*[:：]\s*(\d{1,3})/);
  return ms ? parseInt(ms[1], 10) : null;
}

/**
 * 学历硬性门槛评语文字修正：当评语第一学历低于全日制本科（口径见 educationGateReason）、
 * 而评语里「学历硬性门槛扣分」不足 20 分时，同步把评语相关数字和结论改对，
 * 避免「评语说不扣分、分数却扣了」的矛盾。
 * 每一处都单独判定，匹配不上就跳过，绝不改动评语其他内容。
 */
export function patchEducationDeductionComment(comment) {
  if (!comment) return comment;
  const fd = comment.match(FIRST_DEGREE_RE);
  if (!fd) return comment;
  const reason = educationGateReason(fd[1]);
  if (!reason) return comment;

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
  // 1) 学历硬性门槛扣分：X分（...）→ 20分（原因），并清掉残留的「故不扣分」类表述。
  //    括号里可能再套一层括号（提示词模板本身就是「（第一学历为…（如大专、中专、技校等）…）」），
  //    所以要按「允许一层嵌套」来匹配：只认第一个右括号会从内层截断，留下半句残文
  patched = patched.replace(/学历硬性门槛扣分\s*[:：]\s*\d{1,3}\s*分\s*（[^（）]*(?:（[^（）]*）[^（）]*)*）/g, `学历硬性门槛扣分：20分（${reason}，按硬性门槛规则扣除）`);
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
