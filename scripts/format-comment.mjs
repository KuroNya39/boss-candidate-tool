// scripts/format-comment.mjs — AI 评语排版（唯一实现，软件内完成页与 Excel「AI评级理由」共用）
// 原逻辑长期只存在于 scripts/export-candidates.mjs（Excel 导出时强制排版）；
// v1.10.2 抽到这里供主进程 ipc.mjs 复用，让软件内展示与 Excel 输出同一份排版。
//
// 把 AI 输出的评语重排成 config/scoring-prompt-*.txt「最终输出模板」的编号结构：
//   1.首句定性 / 2.3个评估维度的匹配情况(3维度+计分) / 3.任职资格的匹配情况 / 4.学历硬性门槛核查 / 5.综合结论
// 无论 AI 是否自带编号/换行，都强制按模板排版。
export const FORMAT_COMMENT_DIM_RE = '[^\\s：。，,；;！?！？…（）()]{2,30}（\\d{1,3}%，独立得分：\\d{1,3}分）\\s*[:：]';
// 模板里要独占一行的子项关键词：计分三行 + 学历核查四行（「学历硬性门槛扣分」在提示词的输出模板里）
// 下面两个正则共用这一份，新增子项只改这里
const SUBLINE_KW = '加权基础分计算|其他扣分合计|匹配度评分|第一学历|最高学历|学历硬性门槛扣分|合规性结论';

// 下面这些正则每次 formatComment 都要用（每位候选人一次，导出/界面各一次），
// 全部在模块级建好，别在函数里反复 new RegExp。
// 固定板块标题 → 模板编号（保留可读的字面量写法，这里统一编译）
const BLOCK_REWRITES = [
  [/首句定性/, '1.首句定性：'],
  [/任职资格的匹配情况/, '3.任职资格的匹配情况：'],
  [/学历硬性门槛核查/, '4.学历硬性门槛核查：'],
  [/综合结论/, '5.综合结论：'],
].map(([re, label]) => [new RegExp(re.source + '\\s*[:：]?'), label]);
const DIM_RE = new RegExp('(' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const DIM_AFTER_BLANK_RE = new RegExp('\\n{2,}(?=' + FORMAT_COMMENT_DIM_RE + ')', 'g');
const SUBLINE_HEAD_RE = new RegExp('(\\n+)(' + SUBLINE_KW + ')\\s*[:：]?', 'g');
const SUBLINE_INLINE_RE = new RegExp('(?<=。|；|）|：)(' + SUBLINE_KW + ')\\s*[:：]', 'g');
const DIM_BLOCK_HEAD_RE = new RegExp('(\\n+)(?=' + FORMAT_COMMENT_DIM_RE + ')');

export function formatComment(text) {
  if (!text) return '';
  let t = String(text);

  // 0) 去掉 AI 可能自带的板块编号/标题，避免重复（如 "1.首句定性"、"2.3个评估维度的匹配情况："）
  t = t.replace(/[0-9一二三四五六七八九十]*[.、．]?\s*3个评估维度的匹配情况\s*[:：]?/, '');
  t = t.replace(/([0-9一二三四五六七八九十]+[.、．]\s*)(?=(首句定性|任职资格的匹配情况|学历硬性门槛核查|综合结论))/g, '');

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
  t = t.replace(DIM_BLOCK_HEAD_RE, '\n2.3个评估维度的匹配情况：\n');

  // 5) 板块之间空一行
  t = t.replace(/\n(?=[1-5]\.(?:首句定性|3个评估维度|任职资格的匹配情况|学历硬性门槛核查|综合结论))/g, '\n\n');

  // 6) 清理
  t = t.replace(/\n{3,}/g, '\n\n');
  // 修复旧数据中误换行的"刚性扣分"（非标题场景，如"刚性扣分。学历..."）
  t = t.replace(/\n刚性扣分(?!说明)/g, '刚性扣分');
  t = t.replace(/^\n+/, '');
  return t.trim();
}
