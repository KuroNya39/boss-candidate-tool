// scripts/export-fields.mjs — Excel 导出的字段表与样式配置
// 「有哪几列、每列怎么取值、怎么分组、什么底色/对齐/列宽」全在这一个文件里。
// 加一列：先在 FIELD_CONFIG 里加一项，再把它挂进 FIELD_GROUPS（分组才认它）——
// 两处都改才出得来，别只改一处。
import { summarizeScoredCandidate, dimensionScores } from './scored-candidate.mjs';
import { parseWorkExperienceFromResume } from './resume-parse.mjs';

// ===== 字段配置 =====
// ===== 卡片文字兜底识别 =====
// 活跃度、求职状态这两项只有部分页面有独立的 DOM 元素（沟通页的活跃度、搜索页的求职状态），
// 其余情况靠整张卡片的文字兜底：提取时卡片全文都存进了 rawVisibleText，
// 而 BOSS 的措辞就那么几种固定说法——按固定说法精确匹配即可，认不到就留空，不会认错。
const ACTIVE_STATUS_RE = /(刚刚|今日|昨日|本周|本月|半年内|近\s*\d+\s*天|\d+\s*(?:日|天|周|月)内)\s*活跃/;

// 求职状态：「在职-考虑机会」这种带前缀的全称在哪儿都可信；
// 不带前缀的短说法（随时到岗、考虑机会…）只认卡片文字，不认简历正文，避免正文里恰好出现这几个字被误判
const JOB_STATUS_FULL_RE = /(?:在职|离职)\s*[-－—]\s*[^\s，,。;；、|/]{1,8}/;
const JOB_STATUS_BARE = ['随时到岗', '月内到岗', '考虑机会', '暂不考虑', '应届生', '在校生'];

// 期望信息：卡片 DOM 上只有「期望城市 / 期望岗位 / 期望薪资」三项，没有期望行业 ——
// 期望行业只存在于简历里。简历正文里那一块有两种排版，最终都归到同一套归类：
//   ① 截图 OCR 的排版：标题后面直接粘着一排用 | 隔开的值，标签还可能被 OCR 粘进上一行：
//      32 岁 | 6 年 | 硕士 | 在职-考虑机会…期望职位深圳 | 驱动开发工程师 | 行业不限 | 30-50K
//   ② 标题独占一行，下面每行一个值（拖拽复制 / DOM 提取）：城市 / 岗位 / 行业 / 薪资
//   两种排版的值顺序一致（「行业不限」也是行业值）。
// 小节标题有「期望职位」「求职期望」「最近关注」几种写法（实测同一批 10 份简历里三种都出现过）。
// 注意 ② 只对**带换行**的简历文本有效 —— 拖拽复制与截图 OCR 出来的文本都保留换行（实测
// output 里的简历正文 70~110 个换行）；万一某条路径把整份简历压成了一行，② 会认不到、留空，不会认错。
const EXPECT_SECTION_HEADS = ['最近关注', '期望职位', '求职期望', '求职意向', '期望岗位'];
// 简历里其它小节标题，用来判断「期望」块到哪儿结束
const RESUME_SECTION_HEADS = [
  '工作经历', '教育经历', '项目经历', '实习经历', '专业技能', '自我评价', '社团经历',
  '证书', '语言能力', '牛人分析器', '牛人最近7天沟通过的职位', '查看全部', '经历描述',
];
const SALARY_LINE_RE = /^(?:\d+\s*[-~－—至]\s*\d+\s*[Kk千万Ww]|\d+\s*[Kk千万Ww]|面议|薪资面议)$/;
const PIPE_RE = /[|｜]/;
const LEAD_COLONS_RE = /^[：:]+/;
// 一次找出标题（OCR 的排版里标题常出现在行中间），不用逐行 includes 五遍
const EXPECT_HEAD_RE = new RegExp(EXPECT_SECTION_HEADS.join('|'), 'g');
const DATE_LINE_RE = /^\d{4}\s*[.\-/年]/;

// 每人只算一次。下面几个字段是「一次导出里每人各取一次」的（四个期望字段共用一份解析结果，
// 活跃度/求职状态/期望字段共用一份拼接文本），不缓存就是同一份简历反复切行、反复拼接。
// 缓存以候选人为键：transformCandidates 对每人只做一次浅拷贝，整行字段拿到的都是同一个对象，
// 所以命中正常，且拷贝在本次导出结束后即成垃圾、WeakMap 条目随之回收。
const memoByCandidate = (fn) => {
  const cache = new WeakMap();
  return (c) => {
    if (!cache.has(c)) cache.set(c, fn(c));
    return cache.get(c);
  };
};

// 展示行（档位 / 匹配度评分 / 排版后的评语）走与完成页、候选人查询同一份映射，Excel 不再自己算一遍
const displayRowOf = memoByCandidate(summarizeScoredCandidate);

// AI 评分拆出来的三个维度列：字段名、表头、取第几维。FIELD_CONFIG、二级分组、列宽都从这里派生，
// 加一维或调顺序只改这一处
const DIM_FIELDS = [0, 1, 2].map((i) => ({ key: `dim${i + 1}Score`, header: `维度${i + 1}得分`, idx: i }));

// 三个维度列各取一次，解析评语只做一遍
const dimScoresOf = memoByCandidate((c) => dimensionScores(c.scoreDetail, c.jobRelevanceComment));
/** 第几维的得分；该候选人没有这一维时留空，不补 0（0 分是有效值，混在一起会误读） */
const dimScoreOf = (idx) => (c) => dimScoresOf(c)[idx]?.score ?? '';

// 前两项固定是城市、岗位；剩下的项里，像薪资的当薪资，第一个不是薪资的当行业。
// maxIndustryLen 给行业一个长度上限：OCR 那种一行值的排版容易把后续正文一起切进来，收得更紧。
const classifyExpectValues = (values, maxIndustryLen) => {
  const out = { expectCity: values[0], expectPosition: values[1] };
  for (const v of values.slice(2)) {
    if (SALARY_LINE_RE.test(v)) { if (!out.expectSalary) out.expectSalary = v; continue; }
    if (!out.expectIndustry && v.length <= maxIndustryLen) out.expectIndustry = v;
  }
  return out;
};

const parseExpectSection = memoByCandidate((c) => {
  const text = c.resumeText || '';
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(s => s.trim());

  // ① OCR 排版：标题和值在同一行。先认这种，命中就不再看下一段的标题行。
  //    「后面带 |」是硬条件；「必须有像薪资的一项」是第二道——正文里恰好提到
  //    「期望职位… | …」不会带薪资，据此排除误命中。城市/岗位长度离谱也整行放弃。
  for (const line of lines) {
    EXPECT_HEAD_RE.lastIndex = 0;
    let m;
    while ((m = EXPECT_HEAD_RE.exec(line)) !== null) {
      const rest = line.slice(m.index + m[0].length);
      if (!PIPE_RE.test(rest)) continue;
      const values = rest.split(PIPE_RE).map(s => s.trim().replace(LEAD_COLONS_RE, '')).filter(Boolean);
      if (values.length < 2 || values[0].length > 20 || values[1].length > 30) continue;
      if (!values.some(v => SALARY_LINE_RE.test(v))) continue;
      return classifyExpectValues(values, 30);
    }
  }

  // ② 标题独占一行：下面每行一个值
  const headIdx = lines.findIndex(l => EXPECT_SECTION_HEADS.includes(l));
  if (headIdx < 0) return null;
  const values = [];
  for (let i = headIdx + 1; i < lines.length && values.length < 6; i++) {
    const l = lines[i];
    if (!l) continue;
    if (RESUME_SECTION_HEADS.includes(l)) break;
    if (l.length > 40) break;       // 长句 = 已经进正文了
    if (DATE_LINE_RE.test(l)) break; // 日期行 = 已经进经历区了
    values.push(l);
  }
  // 行业长度由上面「超过 40 字就停」兜住，这里不用再限
  return values.length >= 2 ? classifyExpectValues(values, 40) : null;
});

// 期望信息：卡片上没有「期望行业」这一项，只能从简历正文里认（带标签的写法也一并兜住）
const EXPECT_LABEL_RES = {
  expectCity: /期望(?:城市|地点|工作城市|工作地点)\s*[：:]\s*([^\n\r，,。;；]{1,20})/,
  expectPosition: /期望(?:职位|岗位|职业)\s*[：:]\s*([^\n\r，,。;；]{1,30})/,
  expectIndustry: /期望行业\s*[：:]\s*([^\n\r，,。;；]{1,30})/,
  expectSalary: /期望(?:薪资|薪水|月薪|待遇)\s*[：:]\s*([^\n\r，,。;；]{1,20})/,
};

// 卡片全文 + 简历正文
const textOf = memoByCandidate((c) => [c.rawVisibleText, c.resumeText].filter(Boolean).join('\n'));

function findLabeled(text, re) {
  if (!text) return '';
  const m = text.match(re);
  return m ? m[1].trim() : '';
}

export function activeStatusOf(c) {
  // 沟通页有独立元素（basicInfo.activeStatus），最准
  if (c.basicInfo?.activeStatus) return c.basicInfo.activeStatus;
  const m = textOf(c).match(ACTIVE_STATUS_RE);
  return m ? m[0] : '';
}

export function jobStatusOf(c) {
  // 搜索页有独立的 DOM 元素，优先用它
  if (c.basicInfo?.jobStatus) return c.basicInfo.jobStatus;
  // 带前缀的全称（在职-考虑机会）在卡片和简历正文里都可信：在合并文本上认一次即可，
  // 不必先在卡片上认、认不到再在合并文本（包含卡片）上认第二遍
  const full = textOf(c).match(JOB_STATUS_FULL_RE);
  if (full) return full[0];
  // 不带前缀的短说法只认卡片文字，避免正文里恰好出现这几个字被误判
  const card = c.rawVisibleText || '';
  for (const w of JOB_STATUS_BARE) if (card.includes(w)) return w;
  return '';
}

// 顺序：卡片 DOM 里直接读到的结构化字段 → 简历正文的「期望」区块（两种排版已在
// parseExpectSection 里归一）→ 简历正文里带标签的写法
// （期望薪资在搜索页是 basicInfo.expectSalary，其余页面是 positionInfo.expectSalary，两个都认）
function expectOf(c, key) {
  const structured = c.positionInfo?.[key] || c.basicInfo?.[key];
  if (structured) return structured;
  const section = parseExpectSection(c);
  if (section && section[key]) return section[key];
  return findLabeled(textOf(c), EXPECT_LABEL_RES[key]);
}

// 在职时间：提取时已从简历补进 workExperience[0].time 的（v1.16.0 起）直接用；
// 老批次是提取阶段没补的，导出时再从简历正文认一次——重新导出老批次就能补上这一列。
// 取文档顺序的第一条（简历按时间倒序，第一条即最近一段工作），不按 embedded 过滤：
// embedded 只说明公司/职位不可信，日期本身仍然有效。
const tenureOf = memoByCandidate((c) => {
  const fromWork = c.workExperience?.[0]?.time;
  if (fromWork) return fromWork;
  return parseWorkExperienceFromResume(c.resumeText || '')[0]?.time || '';
});

// AI 评语排版统一收口到 ./format-comment.mjs（软件内完成页与 Excel 共用同一份），此处只导入使用
export const FIELD_CONFIG = {
  name: {
    header: '姓名',
    extract: (c) => c.basicInfo?.name || '',
  },
  // AI 评分拆成三组：档位（星级）/ 最终分 / 三个维度分。
  // 维度列按序号命名是刻意的：每个岗位的维度名各不相同，按名称做表头会让不同 sheet 的列义漂移
  tier: {
    header: '档位',
    extract: (c) => '★'.repeat(displayRowOf(c).tier),
  },
  matchScore: {
    header: '匹配度评分',
    extract: (c) => displayRowOf(c).score,
  },
  ...Object.fromEntries(DIM_FIELDS.map(({ key, header, idx }) => [key, { header, extract: dimScoreOf(idx) }])),
  activeStatus: {
    header: '活跃度',
    extract: (c) => activeStatusOf(c),
  },
  age: {
    header: '年龄',
    extract: (c) => c.basicInfo?.age || '',
  },
  workYears: {
    header: '工作年限',
    extract: (c) => c.basicInfo?.workYears || '',
  },
  jobStatus: {
    header: '求职状态',
    extract: (c) => jobStatusOf(c),
  },
  // 教育经历展开为4列，extract 第二个参数 rowIdx 表示该候选人的第几段教育
  eduTime: {
    header: '时间',
    extract: (c, rowIdx) => c.educationExperience?.[rowIdx]?.time || '',
  },
  eduSchool: {
    header: '学校',
    extract: (c, rowIdx) => c.educationExperience?.[rowIdx]?.school || '',
  },
  eduMajor: {
    header: '专业',
    extract: (c, rowIdx) => c.educationExperience?.[rowIdx]?.major || '',
  },
  eduDegree: {
    header: '学历',
    extract: (c, rowIdx) => {
      const degree = c.educationExperience?.[rowIdx]?.degree;
      if (degree) return degree;
      // 后备：educationExperience 为空时在第1行显示最高学历
      if (rowIdx === 0 && (!c.educationExperience || c.educationExperience.length === 0)) {
        return c.basicInfo?.education || '';
      }
      return '';
    },
  },
  educationScore: {
    header: '学历分',
    extract: (c) => c.educationScore ?? '',
  },
  workYearsScore: {
    header: '年限分',
    extract: (c) => c.workYearsScore ?? '',
  },
  jobRelevanceScore: {
    header: '岗位相关性分',
    extract: (c) => c.jobRelevanceScore ?? '',
  },
  jobRelevanceComment: {
    header: 'AI评语',
    extract: (c) => displayRowOf(c).comment,
  },
  jobDescription: {
    header: '岗位描述',
    extract: (c) => {
      const jd = c.jobDescription;
      if (!jd) return '';
      const desc = jd.description || '';
      return desc.length > 100 ? desc.substring(0, 100) + '...' : desc;
    },
  },
  score: {
    header: '分数',
    extract: (c) => c.totalScore ?? c.score ?? 0,
  },
  passed: {
    header: '是否通过',
    extract: (c) => {
      if (c._defaultMode) return '-';
      return c.passed ? '是' : '否';
    },
  },
  recommendationLevel: {
    header: '推荐等级',
    extract: (c) => c.recommendationLevel || '',
  },
  // 「在职」三项取自工作经历第一段（最近一段）；已离职的候选人这里显示的是他最近一份工作
  currentCompany: {
    header: '在职企业',
    extract: (c) => c.workExperience?.[0]?.company || '',
  },
  currentPosition: {
    header: '在职岗位',
    extract: (c) => c.workExperience?.[0]?.position || '',
  },
  currentTenure: {
    header: '在职时间',
    extract: (c) => tenureOf(c),
  },
  expectCity: {
    header: '期望城市',
    extract: (c) => expectOf(c, 'expectCity'),
  },
  expectPosition: {
    header: '期望岗位',
    extract: (c) => expectOf(c, 'expectPosition'),
  },
  expectIndustry: {
    header: '期望行业',
    extract: (c) => expectOf(c, 'expectIndustry'),
  },
  expectSalary: {
    header: '期望薪资',
    extract: (c) => expectOf(c, 'expectSalary'),
  },
  recommendationReasons: {
    header: '推荐理由',
    extract: (c) => {
      // 只提取 type=preferred 且 result=pass 的规则
      const reasons = c.reasons?.filter(
        r => r.type === 'preferred' && r.result === 'pass'
      ) || [];
      return reasons.map(r => r.rule).join('、') || '';
    },
  },
  resumeText: {
    header: '在线简历',
    extract: (c) => c.resumeText || '',
  },
};

// 教育经历子字段列表（在列标题行合并为"教育经历"，子标题行显示具体字段名）。
// 「哪些列属于教育经历」由下面的 SUB_GROUPS 引用它，别再在合并、样式里另写一份
const EDU_SUB_FIELDS = ['eduSchool', 'eduMajor', 'eduDegree', 'eduTime'];

// AI 评分拆出来的数值列：表头第二级合并成一块「AI评分」，第三级才是列名
const AI_SCORE_SUB_FIELDS = ['tier', 'matchScore', ...DIM_FIELDS.map((d) => d.key)];

// 表头第二级的分组（Row 1 是 FIELD_GROUPS 的分组标题，Row 2 是这里，Row 3 才是列名）。
// 「哪些列属于哪个二级分组」只按这两张表判，别再在合并、样式里各写一份
export const SUB_GROUPS = [
  { label: 'AI评分', fields: AI_SCORE_SUB_FIELDS },
  { label: '教育经历', fields: EDU_SUB_FIELDS },
];
export const SUB_GROUP_OF = new Map(SUB_GROUPS.flatMap(g => g.fields.map(f => [f, g])));

// 默认导出字段顺序。
// 注意：同一分组的成员必须相邻（合并表头按「最小下标 ~ 最大下标」算）——AI 评分的五个数值列、
// 教育经历四个子字段，中间都别插别的字段，否则会被并进那条合并标题里
export const DEFAULT_FIELDS = [
  'name',
  ...AI_SCORE_SUB_FIELDS,
  'jobRelevanceComment',
  'activeStatus',
  'age',
  'workYears',
  'jobStatus',
  'eduSchool',
  'eduMajor',
  'eduDegree',
  'eduTime',
  'currentCompany',
  'currentPosition',
  'currentTenure',
  'expectCity',
  'expectPosition',
  'expectIndustry',
  'expectSalary',
  'resumeText',
];

// ===== 分组配置 =====
// 用字段名列出成员，**不写列下标**：列区间由 createStyledSheet 按实际列序算。
// 写死下标的话，DEFAULT_FIELDS 插一个字段、或 --fields 只导一部分，区间就整体错位；
// 而且错了不报错 —— 区间落空那步直接跳过，只会静默少一条标题条。
// 组内成员在 DEFAULT_FIELDS 里必须连续（标题条是一整条，合并要一个区间）。
// headerFill / headerText 是分组标题条（表头第 1 行）的底色与字色。
// 注意这三个底色是亮色（相对亮度 0.24~0.56），白字对比度只有 3.56 / 3.06 / 1.71 —— 都低于
// 「正文级文字 4.5」那条线，黄色那条尤其浅。这是选定的配色，不是疏漏；真要压白字得把底色压深
// （深一档的蓝/绿/黄），但那样就不是这三个色了。
// 三组必须各不相同：相邻两组同色时，两条标题条会连成一整条，分组边界就看不出来了。
export const FIELD_GROUPS = [
  {
    label: 'AI分析',
    fields: [...AI_SCORE_SUB_FIELDS, 'jobRelevanceComment'],
    headerFill: 'FF4285F4', headerText: 'FFFFFFFF', // 蓝
  },
  {
    label: '基本信息',
    fields: [
      'activeStatus', 'age', 'workYears', 'jobStatus',
      ...EDU_SUB_FIELDS,
      'currentCompany', 'currentPosition', 'currentTenure',
    ],
    headerFill: 'FF34A853', headerText: 'FFFFFFFF', // 绿
  },
  { label: '求职期望', fields: ['expectCity', 'expectPosition', 'expectIndustry', 'expectSalary'], headerFill: 'FFFBBC05', headerText: 'FFFFFFFF' }, // 黄
];
// 字段 → 所属分组（没有分组标题的字段查不到）。按表头、底色两处都查它，别再各写一遍 find/includes
export const FIELD_GROUP_OF = new Map(FIELD_GROUPS.flatMap(g => g.fields.map(f => [f, g])));

// ===== 字段样式配置 =====
// exceljs 的纯色填充写法很啰嗦，同色的字段又多，收一个工厂函数
export const solidFill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// 列底色一个语义小分块一种色相，全部取浅色（明度 L* 都在 91 以上、彩度 C* 都不超过 16）。
// 这里**不跟标题条的色相挂钩**：分组由标题条那条带子表达，列底色只管「把相邻的列分开」。
// 所以配色唯一的硬约束是相邻两列要够开 —— 浅色之间色差本就小，不够就糊成一片
// （实测相邻的异色列 ΔE 全部 ≥ 10.5，最紧的是 AI 评分数值列 → AI评语）。
const FIELD_TINTS = {
  name: 'FFDBEAF6',      // 淡蓝
  aiScore: 'FFFCF3D5',   // 淡黄
  aiComment: 'FFE1F0DC', // 淡绿
  status: 'FFFBE3EA',    // 淡粉
  tenure: 'FFDCF0F3',    // 淡青
  edu: 'FFFCE9D6',       // 淡橙
  expect: 'FFEBE4F7',    // 淡紫
  plain: 'FFF2F2F2',     // 中性灰
};

// 字段 → 用哪个底色。同色的字段写在同一行：改色只动 FIELD_TINTS，改归属只动这里
const FIELD_TINT_BY_FIELD = {
  name: 'name',
  // AI 评分的五个数值列同属一块，共用一色；列与列之间靠细边框分开
  ...Object.fromEntries(AI_SCORE_SUB_FIELDS.map((f) => [f, 'aiScore'])),
  jobRelevanceComment: 'aiComment',
  // 个人情况
  activeStatus: 'status', age: 'status', workYears: 'status', jobStatus: 'status',
  // 教育经历
  eduSchool: 'edu', eduMajor: 'edu', eduDegree: 'edu', eduTime: 'edu',
  // 在职情况
  currentCompany: 'tenure', currentPosition: 'tenure', currentTenure: 'tenure',
  // 求职期望
  expectCity: 'expect', expectPosition: 'expect', expectIndustry: 'expect', expectSalary: 'expect',
  resumeText: 'plain',
};

// 除底色外还要额外样式的字段：长文本左对齐 + 自动换行
const FIELD_ALIGNMENTS = {
  jobRelevanceComment: { horizontal: 'left', vertical: 'top', wrapText: true },
  resumeText: { horizontal: 'left', vertical: 'top', wrapText: true },
};

// 数据行里另设字体的字段：星级（★）大一号、橙色，扫表时一眼定位档位
export const FIELD_FONTS = {
  tier: { size: 14, color: { argb: 'FFFFA500' } },
};

// 由上面两张表拼出「字段 → 样式」。上面只写数据，这里只写拼法，加字段不必再抄一遍
export const FIELD_STYLES = Object.fromEntries(
  Object.entries(FIELD_TINT_BY_FIELD).map(([field, tint]) => {
    const style = { fill: solidFill(FIELD_TINTS[tint]) };
    if (FIELD_ALIGNMENTS[field]) style.alignment = FIELD_ALIGNMENTS[field];
    return [field, style];
  })
);

// 列宽（Excel 的宽度单位约等于一个数字字符，一个汉字占 2 个单位）。不在表里的列用常规宽
export const COL_WIDTHS = {
  // AI 评分那几列装的都是 2~3 个字 / 三位数，按表头文字定宽（一个汉字占 2 单位）
  tier: 15,         // ★★★★★：星号在中文字体里按全角宽算，8 放不下五星（表头「档位」本身只要 4）
  matchScore: 12,   // 表头「匹配度评分」正好 10 单位，留一点余量
  ...Object.fromEntries(DIM_FIELDS.map((d) => [d.key, 12])), // 同上，「维度N得分」
  jobRelevanceComment: 90, // 评语是长段落，要给够
  resumeText: 60,          // 简历全文更长，但太宽会把整表撑得没法看，取 60 靠自动换行 + 固定行高截断
  // 学校与专业同宽（两列内容同类，宽度不一致会显得参差）。取值按较长的一类定：
  // 中文校名一般 4~10 字，专业名最长到 11 字左右（「机械设计制造及其自动化」）；
  // 22 够放下 11 字，又只比常规列(18)宽一点，不会空出一大截
  eduSchool: 22,
  eduMajor: 22,
  eduTime: 16,   // 「2020.09-2024.06」这类，比常规列窄一档
  eduDegree: 8,  // 「本科」两个字，最窄
};
export const DEFAULT_COL_WIDTH = 18;

// 行高（磅）。每个候选人统一占 ROW_BLOCK_HEIGHT，不再按内容撑高 —— 理由见 createStyledSheet 里的说明。
// 与表头那三行（28/24/20，见「5. 设置行高」）无关：那两个是表头、这两个是数据行，别顺手合并
export const ROW_BLOCK_HEIGHT = 409; // 表格单行上限 409.5 磅，取 409 留一点余量
export const BASE_ROW_HEIGHT = 24;   // 数据行基础行高；候选人占多行时（多条教育经历）块内换行也用这个

// 默认对齐方式：垂直居中、水平居中
export const DEFAULT_ALIGNMENT = { horizontal: 'center', vertical: 'middle' };

// 通用边框：细实线
export const THIN_BORDER = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};
