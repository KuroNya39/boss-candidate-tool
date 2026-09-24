/**
 * 学历词汇表 —— 提取 / 评分 / 导出全链路共用的单一数据源。
 *
 * 为什么放在 scripts/ 而不是 electron/：打包后 scripts/ 在 app.asar.unpacked，
 * 被主进程 spawn 的子进程（提取/导出）只能 import 同目录（unpacked）的模块，够不到
 * electron/ 里的文件；而主进程可以经 asar 重定向 import scripts/。因此这里作为唯一
 * 数据源，主进程用 '../scripts/degree.mjs' 引入，脚本用 './degree.mjs' 引入
 * （与 score-tiers.mjs 同一套约定）。
 */

// ===== 学历层次表（唯一数据源）：词 → 层次分，数值越大层次越高 =====
// 匹配取「最靠左」的学历词（正则语义），表内顺序只在同一位置能匹配多个词时才影响结果，
// 加词时注意把更长的写法排在前面（如「专升本」排在「专科」前）。
// 不收「小学」：没人拿小学当第一学历，而「小学教育」是常见专业名，收了会误判。
export const DEGREE_RANK = {
  博士: 6, 硕士: 5, 研究生: 5, 本科: 4, 学士: 4, 专升本: 4,
  大专: 3, 专科: 3, 高职: 3, 高专: 3,
  中专: 2, 中技: 2, 技校: 2, 高中: 1, 职高: 1, 初中: 0,
};

/** 本科层次线：层次分 ≥ 4 即「本科及以上」（本文件内部用，分组即按它切） */
const BACHELOR_RANK = 4;

const DEGREE_WORDS = Object.keys(DEGREE_RANK);

// ===== 分组（评分侧「学历硬性门槛」判定用；从上面的表派生，加词只改表） =====
/** 中等教育（高中/职高）：本身不可能是任何人的第一学历，只在整行没有本科及以上时才扣分 */
export const DEGREE_SECONDARY = ['高中', '职高'];
/** 明确低于本科的学历词：出现即认定第一学历不达标（评分阶梯第 ① 步） */
export const DEGREE_BELOW_BACHELOR = DEGREE_WORDS.filter(w => DEGREE_RANK[w] < BACHELOR_RANK && !DEGREE_SECONDARY.includes(w));
/** 本科及以上学历词（评分阶梯第 ② 步的豁免依据） */
export const DEGREE_BACHELOR_PLUS = DEGREE_WORDS.filter(w => DEGREE_RANK[w] >= BACHELOR_RANK);
/** 非统招形式（成人/自考/函授…）：不是学历层次，出现即算非全日制学历 */
export const DEGREE_NON_STANDARD = ['成人', '自考', '函授', '网络教育', '网教', '夜大', '电大', '开放大学'];

// ===== 匹配与排序 =====
/** 任意学历词的正则（非全局，可安全共用；取最靠左的命中）。
 *  要拼进别的正则就用它的 .source（顺序即上面的表序），别另存一份片段常量。 */
export const DEGREE_ANY_RE = new RegExp(DEGREE_WORDS.join('|'));

/** 学历层次分：文字里最靠左那个学历词的层次分，认不出返回 -1（排序时自然排最后） */
export function degreeRank(text) {
  const m = String(text || '').match(DEGREE_ANY_RE);
  return m === null ? -1 : DEGREE_RANK[m[0]];
}

// ===== 提取侧：OCR 常见学历错字（简历截图识别才有，别处用不上） =====
const DEGREE_OCR_TYPO = { 硕土: '硕士', 本秦: '本科', 本幸: '本科' };
/** 提取用的学历关键词表：全部学历词 + OCR 错字 + 「双学位」（学位类型不是层次，故不入层次表） */
export const DEGREE_EXTRACT_KEYS = [...DEGREE_WORDS, ...Object.keys(DEGREE_OCR_TYPO), '双学位'];
/** OCR 错字 → 正确写法（非错字原样返回） */
export function normalizeDegreeWord(word) {
  return DEGREE_OCR_TYPO[word] || word;
}
