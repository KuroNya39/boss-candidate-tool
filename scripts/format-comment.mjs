// scripts/format-comment.mjs — AI 评语排版（唯一实现，软件内完成页与 Excel「AI评级理由」共用）
// 原逻辑长期只存在于 scripts/export-candidates.mjs（Excel 导出时强制排版）；
// v1.10.2 抽到这里供主进程 ipc.mjs 复用，让软件内展示与 Excel 输出同一份排版。
//
// 把 AI 输出的评语重排成 config/scoring-prompt-*.md「输出规范」的编号结构：
//   1.首句定性 / 2.3个评估维度的匹配情况(3维度+计分) / 3.任职资格的匹配情况 / 4.学历硬性门槛核查 / 5.综合结论
// 无论 AI 是否自带编号/换行，都强制按模板排版。
export const FORMAT_COMMENT_DIM_RE = '[^\\s：。，,；;！?！？…（）()]{2,30}（\\d{1,3}%，独立得分：\\d{1,3}分）\\s*[:：]';
// 模板里要独占一行的子项关键词：计分三行 + 学历核查四行（「学历硬性门槛扣分」在提示词的输出模板里）
// 下面两个正则共用这一份，新增子项只改这里
const SUBLINE_KW = '加权基础分计算|其他扣分合计|匹配度评分|第一学历|最高学历|学历硬性门槛扣分|合规性结论';

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
// 有固定编号的四个板块（维度那个由维度行反推位置，不走这里）：[标题, 编号]
const BLOCKS = [
  [SECTION_LABELS.firstSentence, 1],
  [SECTION_LABELS.qualifications, 3],
  [SECTION_LABELS.education, 4],
  [SECTION_LABELS.conclusion, 5],
];

// 下面这些正则每次 formatComment 都要用（每位候选人一次，导出/界面各一次），
// 全部在模块级建好，别在函数里反复 new RegExp。
// 固定板块标题 → 模板编号
const BLOCK_REWRITES = BLOCKS.map(([src, n]) => [new RegExp(src + '\\s*[:：]?'), `${n}.${src}：`]);
const DIM_HEAD_RE = new RegExp('[0-9一二三四五六七八九十]*[.、．]?\\s*' + SECTION_LABELS.dimensions + '\\s*[:：]?');
const BLOCK_NUMBER_HEAD_RE = new RegExp(
  '([0-9一二三四五六七八九十]+[.、．]\\s*)(?=(?:' + BLOCKS.map(([src]) => src).join('|') + '))',
  'g',
);
const DIM_RE = new RegExp('(' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const DIM_AFTER_BLANK_RE = new RegExp('\\n{2,}(?=' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const SUBLINE_HEAD_RE = new RegExp('(\\n+)(' + SUBLINE_KW + ')\\s*[:：]?', 'g');
const SUBLINE_INLINE_RE = new RegExp('(?<=。|；|）|：)(' + SUBLINE_KW + ')\\s*[:：]', 'g');
const DIM_BLOCK_HEAD_RE = new RegExp('(\\n+)(?=' + FORMAT_COMMENT_DIM_RE + ')');

export function formatComment(text) {
  if (!text) return '';
  let t = String(text);

  // 0) 去掉 AI 可能自带的板块编号/标题，避免重复（如 "1.首句定性"、"2.3个评估维度的匹配情况："）
  t = t.replace(DIM_HEAD_RE, '');
  t = t.replace(BLOCK_NUMBER_HEAD_RE, '');

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
  t = t.replace(/\n(?=[1-5]\.(?:首句定性|3个评估维度|任职资格的匹配情况|学历硬性门槛核查|综合结论))/g, '\n\n');

  // 6) 清理
  t = t.replace(/\n{3,}/g, '\n\n');
  // 修复旧数据中误换行的"刚性扣分"（非标题场景，如"刚性扣分。学历..."）
  t = t.replace(/\n刚性扣分(?!说明)/g, '刚性扣分');
  t = t.replace(/^\n+/, '');
  return t.trim();
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

/**
 * 把评语切成 [{ text, bold }] 片段。规则两条：
 *   ① 行首到第一个（括号外的）冒号之间加粗——编号标题、维度行、逐项条件名、计分行都靠它出层次
 *   ② 独占一行的【系统核验】这类方括号标题整行加粗
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
  String(text || '').split('\n').forEach((line, idx) => {
    if (idx > 0) push('\n', false);
    if (!line.trim()) return;
    if (SECTION_TITLE_RE.test(line)) return push(line, true);
    const end = labelEndIndex(line);
    if (end > 0 && end <= LABEL_MAX) {
      push(line.slice(0, end + 1), true);
      push(line.slice(end + 1), false);
    } else {
      push(line, false);
    }
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

