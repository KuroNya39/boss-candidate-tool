// scripts/format-comment.mjs — AI 评语排版（唯一实现，软件内完成页与 Excel「AI评级理由」共用）
// 原逻辑长期只存在于 scripts/export-candidates.mjs（Excel 导出时强制排版）；
// v1.10.2 抽到这里供主进程 ipc.mjs 复用，让软件内展示与 Excel 输出同一份排版。
//
// 把 AI 输出的评语重排成 config/scoring-prompt-*.md「输出规范」的编号结构：
//   1.首句定性 / 2.3个评估维度的匹配情况(3维度+计分) / 3.任职资格的匹配情况 / 4.学历硬性门槛核查 / 5.综合结论
// 无论 AI 是否自带编号/换行，都强制按模板排版。
// 维度行括号里的「（40%，独立得分：92分）」：排版按它换行、解析按它取值，两处共用这一份。
// 容忍全/半角逗号冒号与空格（模型三种都写过）—— 改写法只改这里，不会出现一处认得出、另一处静默认不出
const DIM_PAREN_SRC = '（\\s*(\\d{1,3})\\s*%\\s*[，,]\\s*独立得分\\s*[:：]\\s*(\\d{1,3})\\s*分）';
export const FORMAT_COMMENT_DIM_RE = '[^\\s：。，,；;！?！？…（）()]{2,30}' + DIM_PAREN_SRC + '\\s*[:：]';
const DIM_LINE_RE = new RegExp(DIM_PAREN_SRC, 'g');

/** 评语里的各维度得分：[{ weight, score }]。算分侧（加权基础分）与 Excel 拆列共用这一份 */
export function parseDimensionScores(text) {
  return [...String(text || '').matchAll(DIM_LINE_RE)]
    .map((m) => ({ weight: Number(m[1]), score: Number(m[2]) }));
}
// 模板里要独占一行的子项关键词：计分三行 + 学历核查四行（「学历硬性门槛扣分」在提示词的输出模板里）
// 下面两个正则共用这一份，新增子项只改这里。学历四行单独成串：它们还兼任第 4 节的「内容形状」
// （insertSectionHead 认它补回漏写的小节标题），拆开才能两处共用一份
const EDU_SUBLINE_KW = '第一学历|最高学历|学历硬性门槛扣分|合规性结论';
const SUBLINE_KW = '加权基础分计算|其他扣分合计|匹配度评分|' + EDU_SUBLINE_KW;

// 五个板块的标题字面量：**评语结构的唯一定义**。
// 解析侧（electron/score-comment.mjs 按标题切节算分、查缺节）也从这里 import，
// 改标题只改这一处；再叠加两份提示词模板的「输出规范」。
export const SECTION_LABELS = {
  firstSentence: '首句定性',
  dimensions: '3个评估维度的匹配情况',
  qualifications: '任职资格的匹配情况',
  education: '学历硬性门槛核查',
  conclusion: '综合结论',
};
// 任职资格逐项结论的三个词：解析侧（score-comment.mjs 按它切逐项行）与界面加粗共用，
// 改提示词措辞只改这里——否则会出现「解析还在认这个词、加粗却不认」的静默错位
export const VERDICT_LABELS = { pass: '达标', fail: '不达标', pending: '待核实' };

// 评语末尾「系统核验」段的标题：score-comment.mjs 用它追加/重写这一段，本模块用它把这一段
// 排除在「小节标题是否已存在」的判断之外（这段会引用「任职资格的匹配情况」等小节名）
export const NOTICE_HEADER = '【系统核验】';

/** 正文与【系统核验】段的分界；没有这一段返回 -1（追加核验、插系统说明、判缺节三处共用） */
export function noticesSplitAt(text) {
  return String(text || '').indexOf('\n\n' + NOTICE_HEADER);
}

/** 同上但直接切开：[正文, 【系统核验】段（含它前面的空行）；没有这一段时为 ''] */
export function splitNotices(text) {
  const s = String(text || '');
  const at = noticesSplitAt(s);
  return at === -1 ? [s, ''] : [s.slice(0, at), s.slice(at)];
}

/**
 * 正文里缺哪几节（第 3/4/5 节，返回标题数组；一节不缺返回空数组）。
 * 只看【系统核验】段之前的正文 —— 那一段里点名的正是缺的节名，连它一起判等于永远不缺。
 * 收尾的「评语不完整」提示与评分时的补全重试共用这一份判定，别两处各写一遍。
 * 传进来的应是已排版（formatComment）过的评语：缺小节标题但内容齐全的，排完版就不算缺。
 */
export function missingSectionLabels(comment) {
  const [body] = splitNotices(comment);
  return [SECTION_LABELS.qualifications, SECTION_LABELS.education, SECTION_LABELS.conclusion]
    .filter((k) => !body.includes(k));
}

// 有固定编号的四个板块（维度那个由维度行反推位置，不走这里）：[标题, 编号]
const BLOCKS = [
  [SECTION_LABELS.firstSentence, 1],
  [SECTION_LABELS.qualifications, 3],
  [SECTION_LABELS.education, 4],
  [SECTION_LABELS.conclusion, 5],
];

// 下面这些正则每次 formatComment 都要用（每位候选人一次，导出/界面各一次），
// 全部在模块级建好，别在函数里反复 new RegExp。
const BLOCK_TITLES = BLOCKS.map(([src]) => src);
// 固定板块标题 → 模板编号
const BLOCK_REWRITES = BLOCKS.map(([src, n]) => [new RegExp(src + '\\s*[:：]?'), `${n}.${src}：`]);
const DIM_HEAD_RE = new RegExp('[0-9一二三四五六七八九十]*[.、．]?\\s*' + SECTION_LABELS.dimensions + '\\s*[:：]?');
// 五个板块标题拼成的正则片段：认编号、【】剥壳、判「这行是不是节标题」三处共用一份（加标题只改 SECTION_LABELS）
const ALL_TITLE_SRC = BLOCK_TITLES.concat(SECTION_LABELS.dimensions).join('|');
const BLOCK_NUMBER_HEAD_RE = new RegExp(
  '([0-9一二三四五六七八九十]+[.、．]\\s*)(?=(?:' + ALL_TITLE_SRC + '))',
  'g',
);
/** 板块之间空一行（第 5 步） */
const BLOCK_SEP_RE = new RegExp('\\n(?=[1-5]\\.(?:' + ALL_TITLE_SRC + '))', 'g');
const DIM_RE = new RegExp('(' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const DIM_AFTER_BLANK_RE = new RegExp('\\n{2,}(?=' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const SUBLINE_HEAD_RE = new RegExp('(\\n+)(' + SUBLINE_KW + ')\\s*[:：]?', 'g');
const SUBLINE_INLINE_RE = new RegExp('(?<=。|；|）|：)(' + SUBLINE_KW + ')\\s*[:：]', 'g');
const DIM_BLOCK_HEAD_RE = new RegExp('(\\n+)(?=' + FORMAT_COMMENT_DIM_RE + ')');

// 模型偶尔把板块标题包进方括号：开头先甩一个空的「【】」，标题则写成独占一行的「【」+ 空行 + 「3.任职资格的匹配情况：】」
// （2026-10-30 一批 45 人里 3 人这样）。这些括号不承载任何信息，只剥「空的一对」与「恰好包住板块标题的那对」，
// 正文里其他方括号一概不碰——行首的「[硬性]」/「[优先]」是算分要用的档位标签，更不能动。
const EMPTY_BRACKET_RE = /【\s*】/g;
const WRAPPED_TITLE_RE = new RegExp(
  '【\\s*((?:\\d+[.、．]\\s*)?(?:' + ALL_TITLE_SRC + ')\\s*[:：]?)\\s*】',
  'g',
);
// 节标题行（已归一：可选编号 + 标题 + 可选冒号）。判「当前行属于哪一节」必须认标题**形状**：
// 正文里顺口提到别的节名（如逐项行写「详见学历硬性门槛核查」）不能算换了节
const SECTION_TITLE_LINE_RE = new RegExp('^\\s*(?:\\d+[.、．]\\s*)?(' + ALL_TITLE_SRC + ')\\s*[:：]?');

// 第 3 / 4 节的**内容形状**：模型漏写小节标题时靠它把段落认回来（标题编号由第 1 步统一加）。
// 第 3 节的形状就是逐项行首的档位标签，解析侧（score-comment.mjs 剥出 tier）也认这一份，
// 提示词改标签写法只改这里
export const TIER_MARK_SRC = '[\\[【]\\s*(硬性|优先)\\s*[\\]】]';
const QUAL_ITEM_LINE_RE = new RegExp('^' + TIER_MARK_SRC);
const EDU_SUBLINE_LINE_RE = new RegExp('^(?:' + EDU_SUBLINE_KW + ')\\s*[:：]');

/**
 * 有内容、没标题 → 在该节第一条内容行前补一行标题。已有标题、或认不出这一节的内容时原样返回（幂等）。
 * 用途见 formatComment 第 0.2 步：标题缺了，逐项行会并进第 2 节，读起来像整节丢了。
 */
function insertSectionHead(text, label, lineRe) {
  if (text.includes(label)) return text;
  const lines = text.split('\n');
  const at = lines.findIndex((l) => lineRe.test(l.trim()));
  if (at === -1) return text;
  lines.splice(at, 0, `${label}：`);
  return lines.join('\n');
}

export function formatComment(text) {
  if (!text) return '';
  // 【系统核验】段是系统追加的固定结构，整段不参与下面的编号/换行重排：提示里会引用小节名
  // （如「缺少「任职资格的匹配情况」」），交给第 1 步会被当成板块标题加上编号、拆成带换行的
  // 残文（用户看到的就是「缺少「⏎⏎3.任职资格的匹配情况：」」）。切出来，正文排完再原样接回去
  const [src, notice] = splitNotices(text);
  let t = src;

  // 0) 剥掉模型自加的方括号壳（见上），再做编号/标题归一
  t = t.replace(EMPTY_BRACKET_RE, '');
  t = t.replace(WRAPPED_TITLE_RE, '$1');

  // 0.1) 去掉 AI 可能自带的板块编号/标题，避免重复（如 "1.首句定性"、"2.3个评估维度的匹配情况："）
  t = t.replace(DIM_HEAD_RE, '');
  t = t.replace(BLOCK_NUMBER_HEAD_RE, '');

  // 0.2) 模型只写内容、漏写第 3/4 节标题时补上（2026-11-02 一批 33 人里 15 人这样：逐项结论、
  //      学历核查一字不少，就是没有「3.任职资格的匹配情况：」这行，排出来整段并进第 2 节，
  //      看着像这两节丢了；缺标题也会让 score-comment.mjs 按标题切节时切出 0 条）。
  //      （【系统核验】段已在函数开头切走，不会把它引用的节名当成「标题已存在」）
  t = insertSectionHead(t, SECTION_LABELS.qualifications, QUAL_ITEM_LINE_RE);
  t = insertSectionHead(t, SECTION_LABELS.education, EDU_SUBLINE_LINE_RE);

  // 0.5) 首句定性标签兜底：模板里是「1. 首句定性：」+ 一句话，但模型常直接写总结句、漏掉标签
  //      （实测 deepseek 系 2026-10-30 那批：「整体匹配度中等偏上：…」直接起头）。
  //      首句本来就承担定性作用，补标签不改内容；已有标签时跳过，保持幂等。
  if (!t.includes(SECTION_LABELS.firstSentence)) {
    const lines = t.split('\n');
    const first = lines.findIndex(l => l.trim());
    // 只补标签、不写编号：编号由下面的 BLOCK_REWRITES 统一加，这里写「1.」会被它再包一层
    if (first !== -1) lines[first] = SECTION_LABELS.firstSentence + '：' + lines[first].trimStart();
    t = lines.join('\n');
  }

  // 1) 四个固定板块标题统一编号（模板结构），吞掉原冒号避免双冒号
  for (const [re, label] of BLOCK_REWRITES) {
    t = t.replace(re, '\n' + label);
  }

  // 2) 每个维度行前统一为一个换行（AI 没换行就补上，AI 换多了就并掉）
  t = t.replace(DIM_RE, '\n$1');
  t = t.replace(DIM_AFTER_BLANK_RE, '\n');

  // 3) 计分行、学历核查子行：行首换行统一为一个
  //    （关键词后必须跟冒号才视为标题，避免误切"匹配度评分：91分（=...其他扣分合计0...）"里的同名词）
  t = t.replace(SUBLINE_HEAD_RE, '\n$2：');
  //    AI 挤成一行时，句号/分号/冒号后出现的关键词也补换行（句号是安全的句子边界；
  //    冒号是给「4.学历硬性门槛核查：第一学历：…」这种把子项接在标题后面的写法用的）
  t = t.replace(SUBLINE_INLINE_RE, '\n$1：');

  // 4) 维度块标题（"2.3个评估维度的匹配情况："独占一行），插在第一条维度行前
  t = t.replace(DIM_BLOCK_HEAD_RE, '\n2.' + SECTION_LABELS.dimensions + '：\n');

  // 5) 板块之间空一行
  t = t.replace(BLOCK_SEP_RE, '\n\n');

  // 6) 清理
  t = t.replace(/\n{3,}/g, '\n\n');
  // 修复旧数据中误换行的"刚性扣分"（非标题场景，如"刚性扣分。学历..."）
  t = t.replace(/\n刚性扣分(?!说明)/g, '刚性扣分');
  t = t.replace(/^\n+/, '');
  // 7) 把【系统核验】段原样接回（它自带开头的空行，正文已 trim，直接拼即可）
  return t.trim() + notice;
}

// ===== 评语加粗（只给软件界面用：完成页 / 批次详情 / 候选人查询） =====
// Excel 导出保持纯文本（用户 2026-10-30 决定），别再把富文本接回 export-candidates.mjs。

/** 冒号前最多多少字才算「标签」；超过就当正文里偶然出现的冒号，不加粗 */
const LABEL_MAX = 60;

/**
 * 一行里「标签」的结束位置（冒号下标）。括号里的冒号不算：
 * 维度行「能力名（40%，独立得分：70分）：分析…」要整段当标题，不能从「独立得分：」处切断。
 * 找不到返回 -1。
 */
function labelEndIndex(line) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '（' || ch === '(') depth++;
    else if (ch === '）' || ch === ')') depth = Math.max(0, depth - 1);
    else if ((ch === '：' || ch === ':') && depth === 0) return i;
  }
  return -1;
}

const SECTION_TITLE_RE = /^\s*【[^】]*】\s*$/;

// 「不达标 / 待核实」单独加粗（「达标」不加）：只在第 3 节任职资格里生效。
// 不加「达标」两个字是因为它到处都有、加粗反而糊成一片；不达标与待核实通常只出现在逐项结论里，
// 是人工扫评语时最先要找的东西。注意 不达标 含 达标，正则只匹配 不达标 本身。
// 带捕获组是给 split 用的：分出来的奇数下标正好是要加粗的那几个词
const QUAL_VERDICT_RE = new RegExp(`(${VERDICT_LABELS.fail}|${VERDICT_LABELS.pending})`, 'g');

/**
 * 把评语切成 [{ text, bold }] 片段。规则三条：
 *   ① 行首到第一个（括号外的）冒号之间加粗——编号标题、维度行、逐项条件名、计分行都靠它出层次
 *   ② 独占一行的【系统核验】这类方括号标题整行加粗
 *   ③ 第 3 节「任职资格的匹配情况」里的「不达标」「待核实」加粗（结论最需要一眼看到，「达标」不加）
 * 只有排版含义，不改文本内容；存储的评语保持纯文本（索引/邮件/复制都不受影响）。
 */
function commentEmphasisSegments(text) {
  const out = [];
  const push = (str, bold) => {
    if (!str) return;
    const last = out[out.length - 1];
    if (last && last.bold === bold) last.text += str;
    else out.push({ text: str, bold });
  };
  // 正文里标出「不达标 / 待核实」（只在本节内调用）
  const pushVerdicts = (str) => {
    str.split(QUAL_VERDICT_RE).forEach((s, i) => push(s, i % 2 === 1));
  };
  let inQual = false;   // 当前行是否属于第 3 节（遇到别的板块标题就退出）
  String(text || '').split('\n').forEach((line, idx) => {
    if (idx > 0) push('\n', false);
    if (!line.trim()) return;
    if (SECTION_TITLE_RE.test(line)) return push(line, true);
    // 先更新板块状态再排版本行：标题行本身也要算进它自己那一节
    const title = line.match(SECTION_TITLE_LINE_RE);
    if (title) inQual = title[1] === SECTION_LABELS.qualifications;
    const end = labelEndIndex(line);
    const hasLabel = end > 0 && end <= LABEL_MAX;
    if (hasLabel) push(line.slice(0, end + 1), true);
    const rest = hasLabel ? line.slice(end + 1) : line;
    if (inQual) pushVerdicts(rest);
    else push(rest, false);
  });
  return out;
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** 评语 → 转义好的 HTML（完成页用 innerHTML 渲染；<b> 由本模块统一生成） */
export function commentToHtml(text) {
  return commentEmphasisSegments(text)
    .map((s) => {
      const safe = s.text.replace(/[&<>]/g, (ch) => HTML_ESCAPE[ch]);
      return s.bold ? `<b>${safe}</b>` : safe;
    })
    .join('');
}

