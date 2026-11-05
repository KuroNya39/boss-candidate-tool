// scripts/format-comment.mjs — AI 评语排版（唯一实现，软件内完成页与 Excel「AI评级理由」共用）
// 原逻辑长期只存在于 scripts/export-candidates.mjs（Excel 导出时强制排版）；
// v1.10.2 抽到这里供主进程 ipc.mjs 复用，让软件内展示与 Excel 输出同一份排版。
//
// 把 AI 输出的评语重排成 config/scoring-prompt-*.md「输出规范」的编号结构：
//   1.首句定性(含风险提示) / 2.3 个评估维度的匹配情况(3维度+计分) / 3.任职资格的匹配情况 / 4.学历硬性门槛核查
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
// 计分四行 + 学历扣分行的标签：排版侧认行首换行，解析侧（score-comment.mjs）按「标签：X分」改数字，
// 两处共用这一份，改提示词措辞只改这里
export const AMOUNT_LABELS = {
  base: '加权基础分计算',
  dedTotal: '扣分合计',
  prioBonus: '优先项达标加分',
  match: '匹配度评分',
  eduDed: '学历硬性门槛扣分',
};
// 计分行的旧标签（就是下面这张表的键，改名时把旧名加进对应数组即可，别的不用动）：
// 历史评语里仍是旧写法，排版换行与数值校正都要认出来，否则老评语这一行会并进上一行、数字也不再校正
const AMOUNT_LABEL_ALIASES = { dedTotal: ['其他扣分合计'], prioBonus: ['优先项加分'] };
/** 匹配用的标签源（含旧名），改标签时不必再去 score-comment.mjs 补一遍 */
export const AMOUNT_LABEL_MATCH = Object.fromEntries(
  Object.entries(AMOUNT_LABELS).map(([key, label]) => [key, [label, ...(AMOUNT_LABEL_ALIASES[key] || [])].join('|')]),
);
// 模板里要独占一行的子项关键词：上面的计分行 + 学历核查四行。下面两个正则共用这一份，新增子项只改这里。
// 学历四行单独成串：它们还兼任第 4 节的「内容形状」（insertSectionHead 认它补回漏写的小节标题），
// 拆开才能两处共用一份
const EDU_AUX_KW = '第一学历|最高学历|合规性结论';
const EDU_SUBLINE_KW = `${AMOUNT_LABELS.eduDed}|${EDU_AUX_KW}`;
const SUBLINE_KW = Object.values(AMOUNT_LABEL_MATCH).join('|') + '|' + EDU_AUX_KW;

// 四个板块的标题字面量：**评语结构的唯一定义**。
// 解析侧（electron/score-comment.mjs 按标题切节算分、查缺节）也从这里 import，
// 改标题只改这一处；再叠加两份提示词模板的「输出规范」。
export const SECTION_LABELS = {
  firstSentence: '首句定性',
  dimensions: '3 个评估维度的匹配情况',
  qualifications: '任职资格的匹配情况',
  education: '学历硬性门槛核查',
};
// 标题的**宽松写法**：数量前缀「3 个」、数字后的空格与「的」都可能被漏写（「3个评估维度的匹配情况」
// 是改版前的标准写法；漏「的」的「3个评估维度匹配情况」在 2026-11-03 那批 315 人里占 96 人，
// 整个省掉「3 个」的「评估维度匹配情况」也见过）。由标准写法推导，改 SECTION_LABELS 不会漏改；
// 插标题用的仍是 SECTION_LABELS 的原文（识别的宽容不改变输出的唯一写法）
const looseTitle = (label) => label
  .replace(/^\d+\s*个\s*/, '(?:\\d+\\s*个\\s*)?')
  .replace(/\s+/g, '\\s*')
  .replaceAll('的', '\\s*的?\\s*');
const DIM_TITLE_SRC = looseTitle(SECTION_LABELS.dimensions);
// 任职资格逐项结论的三个词：解析侧（score-comment.mjs 按它切逐项行）与界面加粗共用，
// 改提示词措辞只改这里——否则会出现「解析还在认这个词、加粗却不认」的静默错位
export const VERDICT_LABELS = { pass: '达标', fail: '不达标', pending: '待核实' };

// 评语末尾【系统核验】段的标题。这一版起不再生成（旧批次存档里还有），但排版时仍要整段切掉——
// 它引用了「任职资格的匹配情况」等小节名，留着会被当成板块标题重排
const NOTICE_HEADER = '【系统核验】';

/** 只要正文：历史存档里的【系统核验】段在这里丢掉（formatComment 与缺节判定共用） */
function stripNotices(text) {
  const s = String(text || '');
  const at = s.indexOf('\n\n' + NOTICE_HEADER);
  return at === -1 ? s : s.slice(0, at);
}

/**
 * 正文里缺哪几节（第 3/4 节，返回标题数组；一节不缺返回空数组）。
 * 1 节不查——排版只会补上标签、不保证有内容（首行本身就是节标题时标签下仍是空的）；
 * 5 节「综合结论」已并入 1 节，不再单列。
 * 只看【系统核验】段之前的正文 —— 那一段里点名的正是缺的节名，连它一起判等于永远不缺。
 * 评分时的「补全重试」用它挑出缺节的人，别在别处另写一份判定。
 * 传进来的应是已排版（formatComment）过的评语：缺小节标题但内容齐全的，排完版就不算缺。
 */
export function missingSectionLabels(comment) {
  const body = stripNotices(comment);
  return [SECTION_LABELS.qualifications, SECTION_LABELS.education]
    .filter((k) => !body.includes(k));
}

// 有固定编号的四个板块（维度那个由维度行反推位置，不走这里）：[标题, 编号]
const BLOCKS = [
  [SECTION_LABELS.firstSentence, 1],
  [SECTION_LABELS.qualifications, 3],
  [SECTION_LABELS.education, 4],
];

// 下面这些正则每次 formatComment 都要用（每位候选人一次，导出/界面各一次），
// 全部在模块级建好，别在函数里反复 new RegExp。
// 固定板块标题 → 模板编号。**只改真正处在标题位置的**：行首，或紧跟句末标点/冒号、换行之后。
// 不这么限定，正文里顺口提一句标题名就会被硬拆开——实测白宇那条写「…重算为67分，与首句定性一致）」，
// 排出来变成「…与⏎⏎1.首句定性：一致）」，排版反而把评语弄乱了
// 标题前只认**水平**空白：用 \s* 会让「。⏎⏎4.学历…」从那个句号处匹配、把句号挤到单独一行
// （标题本来就在行首，该从换行处匹配）
// 认标题用宽松写法：编号剥离、节判定、剥壳都认「任职资格匹配情况」这种省「的」的写法，
// 唯独这里不认的话，那一行会被剥掉编号却加不回来（同一份标题词表，别只认一半）
const BLOCK_REWRITES = BLOCKS.map(([src, n]) => [
  new RegExp('(^|[\\n。；;：])[ \\t]*' + looseTitle(src) + '\\s*[:：]?', 'g'),
  `$1\n${n}.${src}：`,
]);
// 去掉 AI 自带的维度标题。必须全局剥：同一份评语里常同时有旧写法与标准写法，
// 只剥第一处会把另一处留给第 4 步插出第二个标题
const DIM_HEAD_RE = new RegExp('[0-9一二三四五六七八九十]*[.、．]?\\s*(?:' + DIM_TITLE_SRC + ')\\s*[:：]?', 'g');
// 四个板块标题（一律按上面的宽松写法）拼成的正则片段：认编号、【】剥壳、判「这行是不是节标题」、
// 删章节标签行四处共用一份（加标题只改 SECTION_LABELS）
const ALL_TITLE_SRC = Object.values(SECTION_LABELS).map(looseTitle).join('|');
const BLOCK_NUMBER_HEAD_RE = new RegExp(
  '([0-9一二三四五六七八九十]+[.、．]\\s*)(?=(?:' + ALL_TITLE_SRC + '))',
  'g',
);
/** 板块之间空一行（第 5 步） */
const BLOCK_SEP_RE = new RegExp('\\n(?=\\d+\\.(?:' + ALL_TITLE_SRC + '))', 'g');
const DIM_RE = new RegExp('(' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const DIM_AFTER_BLANK_RE = new RegExp('\\n{2,}(?=' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const SUBLINE_HEAD_RE = new RegExp('(\\n+)(' + SUBLINE_KW + ')\\s*[:：]?', 'g');
const SUBLINE_INLINE_RE = new RegExp('(?<=。|；|）|：)(' + SUBLINE_KW + ')\\s*[:：]', 'g');
const DIM_BLOCK_HEAD_RE = new RegExp('(\\n+)(?=' + FORMAT_COMMENT_DIM_RE + ')');

// 模型偶尔把板块标题包进方括号：开头先甩一个空的「【】」，标题则写成独占一行的「【」+ 空行 + 「3.任职资格的匹配情况：】」
// （2026-10-30 一批 45 人里 3 人这样）。这些括号不承载任何信息，只剥「空的一对」与「恰好包住板块标题的那对」，
// 正文里其他方括号一概不碰——行首的「[硬性]」/「[优先]」是算分要用的档位标签，更不能动。
const EMPTY_BRACKET_RE = /【\s*】/g;
// 模型偶尔把下一行开头的英文词漏在上一节末尾（实测只有 Linux 一例：维度名以它开头，维度行里反而少了它），
// 单独占一行或缀在句号后。只认纯字母单词——带数字或符号的（CET-6、K8s）可能是正文，不动
const STRAY_WORD_RE = /(^|[。；])[ \t]*[A-Za-z]{2,}[ \t]*$/gm;
// 「可选编号 + 板块标题 + 可选冒号」：剥壳、删标签行、判节标题三条路共用，加一种标题写法只改这里
const NUM_PREFIX_SRC = '(?:\\d+[.、．]\\s*)?';
const TITLE_LINE_SRC = NUM_PREFIX_SRC + '(?:' + ALL_TITLE_SRC + ')\\s*[:：]?';
const WRAPPED_TITLE_RE = new RegExp('【\\s*(' + TITLE_LINE_SRC + ')\\s*】', 'g');
// 模型（2026-11 起 deepseek 系高发：一天 449 人里 347 人）会在小节标题前多写一行章节标签，
// 内容就是标题的简写（【任职资格匹配情况】、【评估维度匹配情况】——省「的」，也省「3 个」）。
// 删掉「整行就是一个方括号」那种：它在界面上会被当独立标题加粗，最显眼，内容又与下一行完全重复。
// 「【维度1】Linux」这类行尾还有内容的、以及【系统核验】（开头已切走）都不动。
// 不看下一行是什么：真标题漏写时 insertSectionHead 会按内容形状补回来，留下的反而是个没人管的裸标签行。
// 标题写法从 SECTION_LABELS 推导（ALL_TITLE_SRC），别在这里另抄词表——改了标题却漏改词表，这行就会静默漏删
const BRACKET_LABEL_RE = new RegExp('^[ \\t]*【\\s*' + TITLE_LINE_SRC + '\\s*】[ \\t]*\\r?\\n', 'gm');
// 节标题行（已归一：可选编号 + 标题 + 可选冒号）。判「当前行属于哪一节」必须认标题**形状**：
// 正文里顺口提到别的节名（如逐项行写「详见学历硬性门槛核查」）不能算换了节
const SECTION_TITLE_LINE_RE = new RegExp('^\\s*' + NUM_PREFIX_SRC + '(' + ALL_TITLE_SRC + ')\\s*[:：]?');

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
  // 【系统核验】段（只有旧批次存档里还有）整段丢掉：它会引用小节名（如「缺少「任职资格的匹配情况」」），
  // 留在正文里会被第 1 步当成板块标题加上编号、拆成带换行的残文
  let t = stripNotices(text);

  // 0) 剥掉模型自加的方括号壳（见上）与节间多吐的英文残片，再做编号/标题归一。
  //    残片必须排在 0.5 补「首句定性」标签之前：它若正好是第一行，补完标签就成了「首句定性：Linux」
  t = t.replace(EMPTY_BRACKET_RE, '');
  t = t.replace(STRAY_WORD_RE, '$1');
  // 章节标签整行先删：排在剥壳之前，否则「【学历硬性门槛核查】」会被剥成光秃秃的标题行，
  // 下一行真正的标题再被编号合并，拼出「4.学历硬性门槛核查：学历硬性门槛核查：」
  t = t.replace(BRACKET_LABEL_RE, '');
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
  //    （关键词后必须跟冒号才视为标题，避免误切"匹配度评分：91分（=...扣分合计0...）"里的同名词）
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
  return t.trim();
}

// ===== 评语强调（界面加粗 + 上色；Excel 只上色不加粗） =====
// 界面：完成页 / 批次详情 / 候选人查询走 commentToHtml（<b> 与 cmt-* 颜色）。
// Excel：走 commentToRuns，只给三个结论词上色、**一律不加粗**（用户要求）。

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

// 三个逐项结论词：只在第 3 节任职资格里生效，各上一档语义色（红 / 黄 / 绿），是人工扫评语时
// 最先要找的东西。「不达标」「待核实」加粗，「达标」只上色不加粗——它条条都有，加粗反而糊成一片。
// 交替顺序把 不达标 放最前：它含「达标」，顺序反了会把「不达标」切成「不」+「达标」。
// 带捕获组是给 split 用的：分出来的奇数下标正好是这几个词
const QUAL_VERDICT_RE = new RegExp(
  `(${VERDICT_LABELS.fail}|${VERDICT_LABELS.pending}|${VERDICT_LABELS.pass})`,
  'g',
);
// 结论词 → 语义色族。三个词都在表里（写全，别用「其余当成功」兜底：
// 将来加第四个结论词或改措辞时，漏改这里会静默变绿，而不是报错）
const VERDICT_TONES = {
  [VERDICT_LABELS.pass]: 'success',
  [VERDICT_LABELS.pending]: 'warning',
  [VERDICT_LABELS.fail]: 'error',
};

/**
 * 把评语切成 [{ text, bold, tone }] 片段。规则三条：
 *   ① 行首到第一个（括号外的）冒号之间加粗——编号标题、维度行、逐项条件名、计分行都靠它出层次
 *   ② 独占一行的方括号标题（如【系统核验】，旧批次评语里还有）整行加粗
 *   ③ 第 3 节「任职资格的匹配情况」里的「达标」「不达标」「待核实」各带一条 tone
 *      （success / error / warning），渲染时上对应的语义色；「不达标」「待核实」另加粗（「达标」不加）
 * 只有排版含义，不改文本内容；存储的评语保持纯文本（索引/邮件/复制都不受影响）。
 */
function commentEmphasisSegments(text) {
  const out = [];
  const push = (str, bold, tone) => {
    if (!str) return;
    const last = out[out.length - 1];
    // tone 也要比：不然「不达标」会和紧挨着的加粗片段合并，丢掉上色标记
    if (last && last.bold === bold && last.tone === tone) last.text += str;
    else out.push({ text: str, bold, tone });
  };
  // 正文里标出三个结论词（只在本节内调用）：色是共有的，粗只给「不达标 / 待核实」
  const pushVerdicts = (str) => {
    str.split(QUAL_VERDICT_RE).forEach((s, i) => {
      if (i % 2 === 0) return push(s, false);
      push(s, s !== VERDICT_LABELS.pass, VERDICT_TONES[s]);
    });
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
    // 第 3 节的逐项行以 [硬性] / [优先] 打头，是明确的结构标记：条目名再长也照加粗。
    // 60 字的上限是给「正文里偶然出现的冒号」兜底的，不该管到这种行——
    // 实测「[硬性] 熟悉GPIO、I2C、SPI…等驱动：」一串外设名能到 70+ 字，被上限挡掉后整条都不加粗，
    // 扫评语时看不出这行是个条目（候选人索引里 1358 行 / 41685 行）。非标签行一旦超过 60 字仍不加粗。
    const hasLabel = end > 0 && (end <= LABEL_MAX || QUAL_ITEM_LINE_RE.test(line));
    if (hasLabel) push(line.slice(0, end + 1), true);
    const rest = hasLabel ? line.slice(end + 1) : line;
    if (inQual) pushVerdicts(rest);
    else push(rest, false);
  });
  return out;
}

const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * 评语 → 转义好的 HTML（完成页用 innerHTML 渲染；<b> / <span> 由本模块统一生成）。
 * 带 tone 的片段挂一个 class，具体颜色由渲染进程的 CSS 决定（各取语义色族的 -strong 深字），
 * 主进程不写死颜色——Excel 那条路是 commentToRuns，颜色在 TONE_ARGB 里。
 */
// 三个结论词的两种渲染放在同一张表：界面要 class、Excel 要 ARGB，共用一套色族名。
// ARGB 必须与 tokens.css 的 --color-*-strong 同值——导出跑在子进程里、读不到 CSS 变量，
// 只能在这里存一份，改语义色时两处一起改（界面那条走 overlays.css 的 .cmt-*）
const TONES = {
  success: { cls: 'cmt-pass', argb: 'FF007A3D' },
  warning: { cls: 'cmt-warn', argb: 'FFA35905' },
  error: { cls: 'cmt-fail', argb: 'FFC0261F' },
};
/** Excel 富文本用的颜色（ARGB），按色族名取；由上一张表派生，别在这里另抄一份 */
export const TONE_ARGB = Object.fromEntries(Object.entries(TONES).map(([tone, s]) => [tone, s.argb]));

/**
 * 评语 → ExcelJS richText 片段：三个结论词上语义色、其余原样，Excel 里一律不加粗。
 * 切分复用 commentEmphasisSegments（与界面同一套），别在导出侧另写一份。
 */
export function commentToRuns(text) {
  return commentEmphasisSegments(text).map(({ text: t, tone }) =>
    tone ? { text: t, font: { color: { argb: TONE_ARGB[tone] } } } : { text: t },
  );
}

export function commentToHtml(text) {
  return commentEmphasisSegments(text)
    .map((s) => {
      const safe = s.text.replace(/[&<>]/g, (ch) => HTML_ESCAPE[ch]);
      if (!s.bold && !s.tone) return safe;
      // 加粗用 <b>，只上色的用 <span>：「达标」加粗会把逐项结论糊成一片
      const tag = s.bold ? 'b' : 'span';
      const cls = s.tone ? ` class="${TONES[s.tone].cls}"` : '';
      return `<${tag}${cls}>${safe}</${tag}>`;
    })
    .join('');
}

