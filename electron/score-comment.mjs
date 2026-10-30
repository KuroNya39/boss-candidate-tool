/**
 * 评语 / 结构化评分数据 → 匹配度评分的程序化计算与评语文字修正。
 *
 * 只依赖评语文本与（可选的）AI 结构化字段，不依赖任何 Electron 全局对象，
 * 因此可被主进程的收尾算分与独立脚本共用，避免两处实现漂移。
 *
 * 权威分数一律由本模块算出（v1.21.0）：
 *   最终分 = clamp(加权基础分 − 学历扣分 − 任职资格扣分, 0, 100)
 * AI 自己写的「其他扣分合计」「匹配度评分」只活在评语文字里，**不参与计算**——
 * 实测它会在同一份评语里前后打架（合计行写「任职资格0 + 学历20」，下一节又写
 * 「这20是任职资格扣分」），信它就会算出多 20 或少 20 的分。没有例外：程序判不出来
 * 的地方一律不回头去信 AI 的数字，改成「按有利方向给分 + 在评语里挂一条【系统核验】提示」。
 *
 * 分工原则（v1.21.0）：**模型只负责给证据**（维度分、逐项达标判断、第一学历字符串），
 * **加权、扣分、取整全部由本模块算**。凡是模型判不了的，本模块也不替它编一个数，
 * 只在 notices 里写明「这里没核对过」，交人工确认。
 */
import { DEGREE_ANY_RE, DEGREE_BELOW_BACHELOR, DEGREE_BACHELOR_PLUS, DEGREE_SECONDARY, DEGREE_NON_STANDARD } from '../scripts/degree.mjs';
// 评语板块标题的唯一定义（排版与解析共用一份，避免改标题时一边改了另一边静默解析出 0 条）
import { SECTION_LABELS } from '../scripts/format-comment.mjs';

// —— 「这句不是 AI 评语」的两个兜底文案：评分、收尾、算分三处共用这一份 ——
// 写用常量、判用 isNonAiComment，别在别处再抄一遍字面量：改文案时判定要跟着走，
// 抄散了就会出现「文案改了、判定没改」，把兜底文案当成 AI 评语去解析。
export const NO_RESUME_COMMENT = '无在线简历';
const SCORE_FAILED_PREFIX = '评分失败：';
export const scoreFailedComment = (message) => `${SCORE_FAILED_PREFIX} ${message}`;
const NON_AI_COMMENT_RE = new RegExp(`^(${NO_RESUME_COMMENT}|${SCORE_FAILED_PREFIX})`);
export const isNonAiComment = (comment) => NON_AI_COMMENT_RE.test(String(comment || '').trim());

// —— 第一学历「低于全日制本科」的判定（解析与改写共用一份口径，避免漂移） ——
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
// 冒号后只许吃空格 / 制表符：用 \s* 会跨过换行，把下一行「最高学历：…本科…」当成第一学历，
// 于是「第一学历空着、判不出来」被误判成「达标不扣分」
const FIRST_DEGREE_RE = /第一学历\s*[:：][ \t]*([^\n]+)/;
const CERTAIN_BELOW_RE = new RegExp(DEGREE_BELOW_BACHELOR.join('|'));
const BACHELOR_PLUS_RE = new RegExp(DEGREE_BACHELOR_PLUS.join('|'));
const SECONDARY_RE = new RegExp(DEGREE_SECONDARY.join('|'));
// 非统招形式：这些写法本身就是非全日制学历，出现即算不达标（不受下面排除词影响）
const NON_STANDARD_RE = new RegExp(DEGREE_NON_STANDARD.join('|'));
// 「非全日制」要排除「未标注/按全日制参考/存疑」这类模棱两可的写法，避免误伤第一学历已是本科的候选人
const isNonFullTime = (t) => /非全日制/.test(t) && !/未标注|按全日制|存疑/.test(t);

/** 学历硬性门槛扣分：第一学历低于全日制本科时扣这个数（评语改写里也用它，别再写字面量 20） */
const EDU_GATE_DEDUCTION = 20;

/**
 * 结构化写法收窄判据：提示词要求 AI 按「学校 | 专业 | 学历层次 | 就读时间 | 全日制/非全日制」输出
 * （见 config/scoring-prompt-*.md 的「输出规范」第 4 节），取得到分隔字段时就只用「层次段 + 形式段」判，
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

/**
 * 第一学历判定，一次给出结论与原因（解析与改写都只用这一个入口，别再把阶梯写第二遍）。
 *   verdict: 'below'   → 低于全日制本科，学历硬性门槛扣 20 分，reason 为原因短语
 *            'ok'      → 明确是全日制本科及以上，学历扣分必须为 0
 *            'unknown' → 判不出（评语没写全学历词），按 0 分处理并挂「学历待核实」提示交人工确认
 * 三种结论里只有 'below' 会扣分。'unknown' 也**不回头去采信 AI 写的学历扣分**（见文件头）：
 * 宁可放过（Excel 里有学历列，人工一眼能核对），不可冤枉（错扣 20 分能把 80 分的人压到不推荐）。
 */
function educationGate(fdText) {
  if (!fdText) return { verdict: 'unknown', reason: null };
  const text = gateText(fdText);
  const certain = text.match(CERTAIN_BELOW_RE);
  if (certain) return { verdict: 'below', reason: `第一学历为${certain[0]}` };
  const nonStandard = text.match(NON_STANDARD_RE);
  const nonFullTime = isNonFullTime(text);
  // 本科及以上且无非统招标记 → 达标。必须在「非统招 / 中等教育」之前判，见口径第 ② 步
  if (!nonStandard && !nonFullTime && BACHELOR_PLUS_RE.test(text)) return { verdict: 'ok', reason: null };
  if (nonStandard) return { verdict: 'below', reason: `第一学历为非全日制（${nonStandard[0]}）` };
  const secondary = text.match(SECONDARY_RE);
  if (secondary) return { verdict: 'below', reason: `第一学历为${secondary[0]}` };
  if (nonFullTime) return { verdict: 'below', reason: '第一学历为非全日制' };
  return { verdict: 'unknown', reason: null };
}

/**
 * 「优先项」字样：JD 里写「优先 / 非强制 / 加分 / 优选」的筛选项不是硬性门槛，
 * 不达标也不该扣分（实测原晓的「有camera经验者优先」被 AI 标成不达标，按项数算会白扣 5 分）。
 * AI 给的 tier 优先，缺省时按筛选项名称里的这些字样判——筛选项名称是照抄 JD 原文的，
 * 所以这一眼就等于「拿 JD 原文复核」，不必再单独读 JD 文件。
 */
const PRIORITY_HINT_RE = /优先|非强制|加分|优选/;

/**
 * 硬性字样：条件里明说「硬性 / 必须 / 强制」的，哪怕同一行也写着「优先」，也按硬性算
 * （「电子行业（硬性）；…从业背景为优先项」这种混合项，名字里有「优先」就整项跳过，
 * 等于放过硬性条件没达标的人）。刻意不收「精通 / 及以上 / 至少」——
 * 「硕士及以上学历优先」是纯优先项，收了会误判成硬性。
 * 提示词已要求把混合项拆成多行，这条兜底只对没拆开的老评语生效。
 * ⚠ 只该在**JD 原文**上生效：评语行首那个 `[硬性]` / `[优先]` 是模型打的标签，
 *   解析时已由 TIER_MARK_RE 剥出来当 tier（见下），别再让它混进名字里命中本正则，
 *   否则「[硬性] …者优先」会被白判成硬性不达标，与「以 JD 原文为准」的口径相反。
 */
const HARD_MARK_RE = /硬性|必须|(?<!非)强制/;

/**
 * 评语逐项行首的档位标签（提示词「输出规范」第 3 节要求每行以 [硬性] / [优先] 开头）。
 * 剥出来当 tier 用，剩下的才是条件原名——两件事分开，判硬性的规则才不会被模型标签劫持。
 */
const TIER_MARK_RE = /^[\[【]\s*(硬性|优先)\s*[\]】]\s*/;

/**
 * 任职资格扣分档位：按「硬性项不达标数」定档，替代原来「酌情扣减 5-15 分」的自由发挥
 * （实测 AI 会写出 20 分这种超出自己范围的数，且同一岗位不同人尺度不一）。
 * ⚠ 这套档位在 config/scoring-prompt-{with-jd,chat}.md 里也写给 AI 看了一份，
 *   只为让它评语里手写的数字别离得太远；**改这里记得同步那两处**，程序这份才是权威。
 */
function qualificationDeduction(hardFailCount) {
  if (hardFailCount <= 0) return 0;
  if (hardFailCount <= 2) return 5;
  if (hardFailCount <= 4) return 10;
  return 15;
}

/** 维度行「（40%，独立得分：92分）」 */
const DIM_RE = /（\s*(\d{1,2})\s*%\s*[，,]\s*独立得分\s*[:：]\s*(\d{1,3})\s*分）/g;
/** 任职资格逐项行「[硬性] 学历要求（…）：达标。依据…」 */
const QUAL_LINE_RE = /^(.{1,80}?)[：:]\s*(达标|不达标|待核实)/;
/** 「学历硬性门槛扣分：X分」这个前缀：取原因、改数字几处共用一份，改提示词措辞只改这里 */
const EDU_DED_PREFIX = '学历硬性门槛扣分\\s*[:：]\\s*\\d{1,3}\\s*分';
/** 允许一层嵌套括号的括号体（提示词模板本身就在括号里再套一层括号） */
const NESTED_PAREN = '[^（）]*(?:（[^（）]*）[^（）]*)*';

/**
 * 「学历硬性门槛扣分：X分（第一学历为大专，按…）」里的**原因短语**。
 * 只在评语没写「第一学历：…」那一行时用作补充证据 —— 取的是 AI 写的**证词**，
 * 拿到后仍然交给 educationGate 下结论，不用它写的分（分数不由 AI 定）。
 */
const EDU_REASON_RE = new RegExp(EDU_DED_PREFIX + '\\s*[（(]\\s*(第一学历为[^）)]*)[）)]');

// 评语数值修正用的静态正则：模块级建好，别在 patchEducationDeductionComment 里
// 每人次 new RegExp 四遍（replace 会把 global 正则的 lastIndex 归零，复用安全）
const EDU_DED_PAREN_RE = new RegExp(`${EDU_DED_PREFIX}\\s*（${NESTED_PAREN}）`, 'g');
const EDU_DED_PLAIN_RE = new RegExp(EDU_DED_PREFIX, 'g');
const DED_TOTAL_PAREN_RE = new RegExp(`其他扣分合计\\s*[:：]\\s*\\d{1,3}\\s*分\\s*（(${NESTED_PAREN})）`, 'g');
const DED_TOTAL_PLAIN_RE = /其他扣分合计\s*[:：]\s*\d{1,3}\s*分/g;

/** 加权平均（各维度分按权重合成），无有效条目返回 null。所有数据来源都走这一个实现 */
function weightedMean(pairs) {
  let ws = 0, wsum = 0;
  for (const [w, s] of pairs) {
    if (!(w > 0) || !(s >= 0 && s <= 100)) continue;
    ws += w * s; wsum += w;
  }
  return wsum === 0 ? null : Math.round(ws / wsum);
}

/** 从结构化维度字段算加权基础分；字段缺失返回 null */
function baseFromDetail(detail) {
  const dims = detail?.dimensions?.length ? detail.dimensions : null;
  return dims ? weightedMean(dims.map(d => [Number(d?.weight), Number(d?.score)])) : null;
}

/** 从评语正文的维度行算加权基础分（老数据兜底）；解析不到返回 null */
function baseFromComment(comment) {
  return weightedMean([...String(comment || '').matchAll(DIM_RE)].map(m => [Number(m[1]), Number(m[2])]));
}

/** 判定结果归一：结构化字段可能是 fail/pending，评语里是 不达标/待核实 */
const VERDICT_FAIL_RE = /不达标|fail|否/i;
const VERDICT_PENDING_RE = /待核实|pending|unknown|存疑/i;
function normalizeVerdict(v) {
  const t = String(v ?? '').trim();
  if (VERDICT_FAIL_RE.test(t)) return 'fail';
  if (VERDICT_PENDING_RE.test(t)) return 'pending';
  return 'pass';
}

/**
 * 硬性项（优先项、待核实项都不算硬性不达标）。
 * 判定顺序：名字里明说「硬性/必须/强制」→ 硬性（混合项不能因为也写了「优先」就被放过）；
 * 其次 AI 给的 tier；最后才看名字里的优先字样（老评语没有 tier 时的兜底）。
 */
function isHardFail(item) {
  if (normalizeVerdict(item.verdict) !== 'fail') return false;
  const name = item.name || '';
  if (HARD_MARK_RE.test(name)) return true;
  if (item.tier === 'preferred' || item.tier === '优先') return false;
  return !PRIORITY_HINT_RE.test(name);
}

/** 从评语第 3 节「任职资格的匹配情况」抠出逐项结论，作为没有结构化字段时的兜底 */
function qualificationItemsFromComment(comment) {
  const text = String(comment || '');
  const start = text.indexOf(SECTION_LABELS.qualifications);
  if (start === -1) return [];
  const endMarker = text.indexOf(SECTION_LABELS.education, start);
  const section = endMarker === -1 ? text.slice(start) : text.slice(start, endMarker);
  const items = [];
  for (const line of section.split('\n')) {
    const m = line.trim().match(QUAL_LINE_RE);
    if (!m) continue;
    const mark = m[1].match(TIER_MARK_RE);
    items.push({
      name: (mark ? m[1].slice(mark[0].length) : m[1]).trim(),
      verdict: m[2],
      tier: mark ? (mark[1] === '硬性' ? 'hard' : 'preferred') : undefined,
    });
  }
  return items;
}

/** JD 里「任职资格关键筛选项」的标签行（带序号的和裸标签两种排版都有） */
const JD_LABEL_RE = /^(?:\d+[.、]\s*)?(学历要求|专业要求|经验要求|行业\s*\/?\s*领域要求|技能\s*\/?\s*证书要求|其他硬性条件|其他要求|其他)\s*[：:\-—]\s*/;

/** JD 里这一节的标题：scoring.mjs 按它切出喂给模型的筛选项，这里按它切出核验数据，共用一份 */
export const JD_SCREENING_HEADING = '任职资格关键筛选项';

/**
 * 从 JD 原文取出程序核验要用的两个数：筛选项条数（下限）与是否写了明确经验年限。
 * 只认「任职资格关键筛选项」这一节；沟通页没有 JD 文件时返回 { itemCount: 0, workYears: null }，
 * 对应的核验自动跳过。
 */
export function parseJdRequirements(jdText) {
  const text = String(jdText || '');
  const at = text.indexOf(JD_SCREENING_HEADING);
  if (at === -1) return { itemCount: 0, workYears: null };

  let itemCount = 0;
  let workYears = null;
  for (const raw of text.slice(at).split('\n')) {
    const line = raw.trim();
    const label = line.match(JD_LABEL_RE);
    if (!label) continue;
    // 「其他硬性条件：无」这类占位行不构成一条真实条件，别算进下限
    if (!/^(无|无特殊要求|无硬性要求)[。；;]?$/.test(line.slice(label[0].length).trim())) itemCount++;
    if (!workYears && /经验要求/.test(label[1])) {
      workYears = yearsFromExperienceLine(line.slice(label[0].length));
    }
  }
  return { itemCount, workYears };
}

/**
 * 从「经验要求」正文里取**硬性**最低年限。按分句切（；;。），取第一个带年数的分句：
 * 该分句若带「优先 / 加分 / 非强制」字样，说明整条经验要求本身是软条件，返回 null 不核验
 * （如「具有2年以上技术背景者优先」）。后面那些分句里的「者优先」不影响前面的硬性年限
 * （如「3年及以上…；有芯片厂商经验者优先」→ 3 年）。
 */
function yearsFromExperienceLine(text) {
  for (const clause of String(text || '').split(/[；;。]/)) {
    const m = clause.match(/(\d+)\s*(?:[-–~]\s*\d+)?\s*年/);
    if (!m) continue;
    if (PRIORITY_HINT_RE.test(clause)) return null;
    const n = parseInt(m[1], 10);
    return n > 0 ? n : null;
  }
  return null;
}

/** 页面上的工作年限文本（「5年」「8年经验」等）→ 数字；取不出来返回 null，核验随之跳过 */
export function parseWorkYears(text) {
  const m = String(text || '').match(/(\d+(?:\.\d+)?)\s*年/);
  return m ? Number(m[1]) : null;
}

/**
 * 覆盖率类核验提示（只写进评语，**不改分**）。
 * 原则同全文：程序只认「明显对不上」的那一侧——能确定不够就说不够，
 * 确定不了「够」就闭嘴（JD 的年限要求常限定领域，程序只会算总年限）。
 *
 * ctx: { jdWorkYears, jdItemCount, candidateWorkYears }，由评分阶段从 JD 与页面上采集。
 */
function coverageNotices(items, ctx) {
  const notices = [];
  if (items.length === 0) return notices;
  const { jdWorkYears, jdItemCount, candidateWorkYears } = ctx || {};

  // ① 工作年限：只有「程序算出的总年限 < JD 硬性要求」而模型判达标时才提示，单向。
  // 取不到工作年限时是 undefined / null，比不出大小，自然不会误报「页面显示 0 年」
  const expItem = items.find((it) => /经验|年限/.test(it.name || ''));
  if (jdWorkYears > 0 && candidateWorkYears != null
      && expItem && normalizeVerdict(expItem.verdict) === 'pass' && candidateWorkYears < jdWorkYears) {
    notices.push(`工作年限存疑：JD 要求 ${jdWorkYears} 年以上，页面显示 ${candidateWorkYears} 年，但经验项被判为达标，请人工复核。`);
  }

  // ② 筛选项覆盖度：JD 有几条标签行就是下限（提示词要求把混写项拆开，正常只会吐得更多）
  if (jdItemCount > 0 && items.length < jdItemCount) {
    notices.push(`筛选项可能漏判：JD 共 ${jdItemCount} 条筛选项，评语只判定了 ${items.length} 条，可能少算不达标项。`);
  }

  // ③ 待核实过多：提示词已要求写明缺什么信息，这里只把整体比例过高的标出来
  const pending = items.filter((it) => normalizeVerdict(it.verdict) === 'pending').length;
  if (pending >= 3 && pending * 2 >= items.length) {
    notices.push(`待核实偏多：${items.length} 条筛选项中有 ${pending} 条标为待核实，可能未做实质判断。`);
  }
  return notices;
}

/**
 * 计算一份评语的完整得分明细。detail 是 AI 返回的 JSON 结构化字段（可能为 null/残缺），
 * ctx 是评分阶段采集的 JD / 页面数据（可省略，省略时跳过覆盖率核验）。
 * 返回 { verdict, eduReason, eduDed, qualDed, score, notices }；
 * 解析不到任何维度得分时返回 null（这种情况由调用方决定怎么兜底并标记）。
 * verdict / eduReason 一并给出，调用方（评语改写）不必再把学历阶梯重走一遍。
 */
export function computeScoreBreakdown(comment, detail = null, ctx = null) {
  const base = baseFromDetail(detail) ?? baseFromComment(comment);
  if (base == null) return null;

  const text = String(comment || '');
  const firstDegree = detail?.education?.firstDegree
    || (text.match(FIRST_DEGREE_RE) || [])[1]
    || (text.match(EDU_REASON_RE) || [])[1]
    || '';
  const { verdict, reason } = educationGate(firstDegree);
  const notices = [];
  if (verdict === 'unknown') {
    // 判不出第一学历：**不扣分**并把「没核查过」显式写出来，交人工确认。
    // 绝不沿用 AI 手写的数字 —— 那正是本模块存在的理由（见文件头）。
    notices.push('学历待核实：评语与结构化字段都没给出可判定的第一学历，本次未扣学历硬性门槛分，请人工确认。');
  }
  const eduDed = verdict === 'below' ? EDU_GATE_DEDUCTION : 0;

  const items = detail?.qualifications?.length ? detail.qualifications : qualificationItemsFromComment(comment);
  const qualDed = qualificationDeduction(items.filter(isHardFail).length);
  notices.push(...coverageNotices(items, ctx));
  // 评语缺节：模型拿到结构化字段后，可能只在正文里写前两节（实测 deepseek 系一次 3 人批，
  // 12 条 qualifications 都给了，正文却停在「匹配度评分」）。结论本身没丢（分数照样按结构化字段算），
  // 但评语是给人看的，缺哪节必须显式标出来，否则用户会以为评估只做到维度为止。
  const missingSections = [SECTION_LABELS.qualifications, SECTION_LABELS.education, SECTION_LABELS.conclusion]
    .filter((k) => !text.includes(k));
  if (missingSections.length > 0) {
    notices.push(`评语不完整：缺少「${missingSections.join('」「')}」小节，分数仍按结构化字段计算，请对照复核。`);
  }

  const score = Math.max(0, Math.min(100, base - eduDed - qualDed));
  return { verdict, eduReason: reason, eduDed, qualDed, score, notices };
}

const NOTICE_HEADER = '【系统核验】';

/**
 * 把核验提示挂到评语末尾（UI 与 Excel 都直接展示评语，所以挂这里就等于全局可见）。
 * 幂等：已有的【系统核验】段落会先被剥掉再重写，重复收尾不会叠加两份。
 */
export function appendScoringNotices(comment, notices) {
  const list = (notices || []).filter(Boolean);
  const at = String(comment || '').indexOf('\n\n' + NOTICE_HEADER);
  const head = at === -1 ? (comment || '') : String(comment).slice(0, at);
  if (list.length === 0) return head;
  return `${head}\n\n${NOTICE_HEADER}\n${list.map((n) => `- ${n}`).join('\n')}`;
}

/** 直接解析评语中手写的「匹配度评分：XX分」作为兜底（维度分解析不出来时才用） */
export function parseMatchScoreFromComment(comment) {
  const ms = (comment || '').match(/匹配度评分\s*[:：]\s*(\d{1,3})/);
  return ms ? parseInt(ms[1], 10) : null;
}

/**
 * 学历硬性门槛评语文字修正：第一学历低于全日制本科时为扣 20 分，
 * 若评语里写的不是 20 分，同步把相关数字和结论改对，避免「评语说不扣分、分数却扣了」的矛盾。
 * 第一学历达标 / 判不出时一个字都不改——分数按规则算，评语保留 AI 原话（用户 2026-10-30 决定）。
 * 每一处都单独判定，匹配不上就跳过，绝不改动评语其他内容。
 *
 * bd 是调用方算好的明细：必须由调用方传进来，本函数不自己算——它手里只有评语文本，
 * 自己重算会走「解析评语」那条路，跟评分时按结构化字段算出的结果可能不一致
 * （同一条评语只该算一次，用哪份数据算由调用方定）。
 */
export function patchEducationDeductionComment(comment, bd) {
  if (!comment || !bd) return comment;
  if (bd.verdict !== 'below') return comment;
  const reason = bd.eduReason;
  const newTotal = bd.eduDed + bd.qualDed;
  const finalScore = bd.score;

  // 记录 AI 手写的「匹配度评分」，判断是否需要追加系统说明（分数被系统改判时）
  const aiScore = parseMatchScoreFromComment(comment);
  const needNote = aiScore != null && finalScore !== aiScore;

  let patched = comment;
  // 1) 学历硬性门槛扣分：X分（...）→ 20分（原因），并清掉残留的「故不扣分」类表述。
  //    括号里可能再套一层括号（提示词模板本身就是「（第一学历为…（如大专、中专、技校等）…）」），
  //    所以要按「允许一层嵌套」来匹配：只认第一个右括号会从内层截断，留下半句残文
  patched = patched.replace(
    EDU_DED_PAREN_RE,
    `学历硬性门槛扣分：${EDU_GATE_DEDUCTION}分（${reason}，按硬性门槛规则扣除）`
  );
  patched = patched.replace(EDU_DED_PLAIN_RE, `学历硬性门槛扣分：${EDU_GATE_DEDUCTION}分`);
  // 2) 其他扣分合计：X分 → 新合计（学历 20 + 任职资格档位扣分）。
  //    括号里若写着「= …0分 + …20分」这类具体数字，一并换成新分项，
  //    否则会留下「合计 25 分（= 0 分 + 20 分）」这种自相矛盾的残文
  const breakdownText = `= 任职资格硬性不达标扣分${bd.qualDed}分 + 学历硬性门槛扣分${bd.eduDed}分`;
  patched = patched.replace(
    DED_TOTAL_PAREN_RE,
    (m, inner) => `其他扣分合计：${newTotal}分（${/\d/.test(inner) ? breakdownText : inner}）`
  );
  patched = patched.replace(DED_TOTAL_PLAIN_RE, `其他扣分合计：${newTotal}分`);
  // 3) 匹配度评分 → 修正后分数。AI 常写成「38 - 20 = 18分」这种算式，
  //    只换末尾数字会留下「38 - 20 = 13分」的假算式，所以算式形态整段换成新分数
  patched = patched.replace(/匹配度评分\s*[:：](?:\s*\d{1,3}\s*分|[^\n]*)/, `匹配度评分：${finalScore}分`);
  // 4) 合规性结论：覆盖为「按规则扣分」的原因说明
  patched = patched.replace(/(合规性结论：)[^\n]*/, `$1${reason}，按学历硬性门槛规则扣除${EDU_GATE_DEDUCTION}分。`);
  // 5) 若系统分数与 AI 手写分数不一致，追加说明，避免用户困惑
  if (needNote) {
    patched += `\n（系统说明：${reason}，已按「学历硬性门槛」规则由系统扣除 ${EDU_GATE_DEDUCTION} 分；任职资格按硬性不达标项数档位计。评语中的扣分合计、匹配度评分等手写数字若与最终分数不一致，一律以最终分数 ${finalScore} 分为准。）`;
  }
  return patched;
}
