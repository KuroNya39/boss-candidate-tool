#!/usr/bin/env node
/**
 * export-candidates.mjs - 候选人 Excel 导出脚本
 *
 * 将 scored-candidates.json 导出为带样式的 Excel 文件
 *
 * Usage:
 *   node scripts/export-candidates.mjs --input output/scored-candidates.json
 */

import { readFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { scoreToTier } from './score-tiers.mjs';
import { formatComment } from './format-comment.mjs';

// ===== CLI 参数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1];
      i++;
    }
  }
  if (!opts.input) {
    console.error('Usage: node scripts/export-candidates.mjs --input <scored-candidates.json> [--to-prefix <email>] [--email-subject <subject>]');
    process.exit(1);
  }
  return opts;
}

// ===== 字段配置 =====
function toAiRating(candidate) {
  const score = candidate.totalScore ?? candidate.score ?? 0;
  return '★'.repeat(scoreToTier(score));
}

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
// 期望行业只存在于简历里。简历正文里那一块是无标签的（标题下面依次排 城市 / 岗位 / 行业 / 薪资），
// 且小节标题有「期望职位」「求职期望」「最近关注」几种写法（实测同一批 10 份简历里三种都出现过）。
// 注意：下面按「一行一项」来切，所以只对**带换行**的简历文本有效 —— 拖拽复制与截图 OCR
// 出来的文本都保留换行（实测 output 里的简历正文 70~110 个换行）；万一某条路径把整份简历
// 压成了一行，这里会认不到、留空，不会认错。
const EXPECT_SECTION_HEADS = ['最近关注', '期望职位', '求职期望', '求职意向', '期望岗位'];
// 简历里其它小节标题，用来判断「期望」块到哪儿结束
const RESUME_SECTION_HEADS = [
  '工作经历', '教育经历', '项目经历', '实习经历', '专业技能', '自我评价', '社团经历',
  '证书', '语言能力', '牛人分析器', '牛人最近7天沟通过的职位', '查看全部', '经历描述',
];
const SALARY_LINE_RE = /^(?:\d+\s*[-~－—至]\s*\d+\s*[Kk千万Ww]|\d+\s*[Kk千万Ww]|面议|薪资面议)$/;

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

const parseExpectBlock = memoByCandidate((c) => {
  const text = c.resumeText || '';
  if (!text) return null;
  const lines = text.split(/\r?\n/).map(s => s.trim());
  const headIdx = lines.findIndex(l => EXPECT_SECTION_HEADS.includes(l));
  if (headIdx < 0) return null;

  const block = [];
  for (let i = headIdx + 1; i < lines.length && block.length < 6; i++) {
    const l = lines[i];
    if (!l) continue;
    if (RESUME_SECTION_HEADS.includes(l)) break;
    if (l.length > 40) break;              // 长句 = 已经进正文了
    if (/^\d{4}\s*[.\-/年]/.test(l)) break; // 日期行 = 已经进经历区了
    block.push(l);
  }
  if (block.length < 2) return null;

  // 前两行固定是城市、岗位；剩下的行里，像薪资的当薪资，其余第一个当行业
  const out = { expectCity: block[0], expectPosition: block[1] };
  for (const l of block.slice(2)) {
    if (SALARY_LINE_RE.test(l)) { if (!out.expectSalary) out.expectSalary = l; continue; }
    if (!out.expectIndustry) out.expectIndustry = l;
  }
  return out;
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

function activeStatusOf(c) {
  // 沟通页有独立元素（basicInfo.activeStatus），最准
  if (c.basicInfo?.activeStatus) return c.basicInfo.activeStatus;
  const m = textOf(c).match(ACTIVE_STATUS_RE);
  return m ? m[0] : '';
}

function jobStatusOf(c) {
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

// 顺序：卡片 DOM 里直接读到的结构化字段 → 简历正文的「期望」区块 → 简历正文里带标签的写法
// （期望薪资在搜索页是 basicInfo.expectSalary，其余页面是 positionInfo.expectSalary，两个都认）
function expectOf(c, key) {
  const structured = c.positionInfo?.[key] || c.basicInfo?.[key];
  if (structured) return structured;
  const block = parseExpectBlock(c);
  if (block && block[key]) return block[key];
  return findLabeled(textOf(c), EXPECT_LABEL_RES[key]);
}

// AI 评语排版统一收口到 ./format-comment.mjs（软件内完成页与 Excel 共用同一份），此处只导入使用
const FIELD_CONFIG = {
  name: {
    header: '姓名',
    extract: (c) => c.basicInfo?.name || '',
  },
  aiRating: {
    header: 'AI评分',
    extract: (c) => toAiRating(c),
  },
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
    extract: (c) => formatComment(c.jobRelevanceComment || ''),
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
    extract: (c) => c.workExperience?.[0]?.time || '',
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

// 默认导出字段顺序。
// 注意：教育经历四个子字段必须相邻（合并表头按「最小下标 ~ 最大下标」算），中间别插别的字段
const DEFAULT_FIELDS = [
  'name',
  'aiRating',
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

// 教育经历子字段列表（在列标题行合并为"教育经历"，子标题行显示具体字段名）。
// 也是「哪些列属于教育经历」的唯一出处 —— 分组归属、合并区间都按它判
const EDU_SUB_FIELDS = ['eduSchool', 'eduMajor', 'eduDegree', 'eduTime'];

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
const FIELD_GROUPS = [
  { label: 'AI分析', fields: ['aiRating', 'jobRelevanceComment'], headerFill: 'FF4285F4', headerText: 'FFFFFFFF' }, // 蓝
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

// ===== 字段样式配置 =====
// exceljs 的纯色填充写法很啰嗦，同色的字段又多，收一个工厂函数
const solidFill = (argb) => ({ type: 'pattern', pattern: 'solid', fgColor: { argb } });

// 列底色一个语义小分块一种色相，全部取浅色（明度 L* 都在 91 以上、彩度 C* 都不超过 16）。
// 这里**不跟标题条的色相挂钩**：分组由标题条那条带子表达，列底色只管「把相邻的列分开」。
// 所以配色唯一的硬约束是相邻两列要够开 —— 浅色之间色差本就小，不够就糊成一片
// （实测相邻的异色列 ΔE 全部 ≥ 10.5，最紧的是 AI评分 → AI评语）。
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
  aiRating: 'aiScore',
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

// 由上面两张表拼出「字段 → 样式」。上面只写数据，这里只写拼法，加字段不必再抄一遍
const FIELD_STYLES = Object.fromEntries(
  Object.entries(FIELD_TINT_BY_FIELD).map(([field, tint]) => {
    const style = { fill: solidFill(FIELD_TINTS[tint]) };
    if (FIELD_ALIGNMENTS[field]) style.alignment = FIELD_ALIGNMENTS[field];
    return [field, style];
  })
);

// 列宽（Excel 的宽度单位约等于一个数字字符，一个汉字占 2 个单位）。不在表里的列用常规宽
const COL_WIDTHS = {
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
const DEFAULT_COL_WIDTH = 18;

// 行高（磅）。每个候选人统一占 ROW_BLOCK_HEIGHT，不再按内容撑高 —— 理由见 createStyledSheet 里的说明。
// 与表头那三行（28/24/20，见「5. 设置行高」）无关：那两个是表头、这两个是数据行，别顺手合并
const ROW_BLOCK_HEIGHT = 409; // 表格单行上限 409.5 磅，取 409 留一点余量
const BASE_ROW_HEIGHT = 24;   // 数据行基础行高；候选人占多行时（多条教育经历）块内换行也用这个

// 默认对齐方式：垂直居中、水平居中
const DEFAULT_ALIGNMENT = { horizontal: 'center', vertical: 'middle' };

// 通用边框：细实线
const THIN_BORDER = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

// ===== 数据转换 =====
function getExpandedRowCount(candidate) {
  const eduList = candidate.educationExperience || [];
  return Math.max(1, eduList.length);
}

function transformCandidates(candidates, fields, mode = 'filter') {
  const enriched = candidates.map(c => ({
    ...c,
    _defaultMode: mode === 'default',
  }));
  const selectedConfig = fields.map(f => FIELD_CONFIG[f] || { header: f, extract: () => '' });

  const headers = selectedConfig.map(cfg => cfg.header);

  const rows = [];
  for (const c of enriched) {
    const rowCount = getExpandedRowCount(c);
    for (let ri = 0; ri < rowCount; ri++) {
      const row = selectedConfig.map(cfg => {
        if (cfg.extract.length >= 2) {
          // expandable field: 传入行索引取对应的教育经历段
          return cfg.extract(c, ri);
        }
        // 固定字段：只在第1行填入值，其余行留空
        return ri === 0 ? cfg.extract(c) : '';
      });
      rows.push(row);
    }
  }

  return [headers, ...rows];
}

function buildGroupedExportData(candidates, fields, mode = 'filter') {
  const data = transformCandidates(candidates, fields, mode);
  const rows = data.slice(1);

  // 分组标题行 (Row 1)：按字段名的分组归属填标签（与 createStyledSheet 里的 colGroups 同一判据）
  const groupHeaders = fields.map(f => {
    const g = FIELD_GROUPS.find(g => g.fields.includes(f));
    return g ? g.label : undefined;
  });

  // 主标题行 (Row 2)：教育经历子字段显示"教育经历"，其他用原始 header
  const mainHeaders = fields.map(f => {
    if (EDU_SUB_FIELDS.includes(f)) return '教育经历';
    const cfg = FIELD_CONFIG[f];
    return cfg ? cfg.header : f;
  });

  // 子标题行 (Row 3)：仅教育经历子字段显示原始 header，其他为空
  const subHeaders = fields.map(f => {
    const cfg = FIELD_CONFIG[f];
    return cfg ? cfg.header : '';
  });
  for (let i = 0; i < subHeaders.length; i++) {
    if (!EDU_SUB_FIELDS.includes(fields[i])) subHeaders[i] = '';
  }

  return [groupHeaders, mainHeaders, subHeaders, ...rows];
}

// ===== 样式化导出 =====
/**
 * 创建带样式的 worksheet
 * 表头结构 3 行：分组标题 / 主标题（教育经历合并）/ 子标题（学校·专业·学历·时间）
 */
async function createStyledSheet(wb, sheetName, groupData, fields) {
  const ws = wb.addWorksheet(sheetName);

  const groupHeaders = groupData[0];  // 分组标题行
  const mainHeaders  = groupData[1];  // 主标题行
  const subHeaders   = groupData[2];  // 子标题行
  const dataRows     = groupData.slice(3); // 数据行

  const colCount = fields.length;

  // 1. 添加 3 行表头 (exceljs 行号从 1 开始)
  ws.addRow(groupHeaders.map(h => h || ''));
  ws.addRow(mainHeaders.map(h => h || ''));
  ws.addRow(subHeaders);
  const dataStartRow = 4; // 数据起始行号

  // 2. 添加数据行
  for (const row of dataRows) {
    ws.addRow(row);
  }

  const totalRows = groupData.length; // 总行数

  // 3. 合并单元格

  // 教育经历列下标：EDU_SUB_FIELDS 里落在 fields 中的那些。
  // 不写死某个字段名 —— 四个子列的先后顺序会调（现为 学校/专业/学历/时间），
  // 写死字段名在调顺序后就会指错列。
  const eduIdx = fields.flatMap((f, i) => (EDU_SUB_FIELDS.includes(f) ? [i] : []));
  // 合并表头要横跨四列，所以还得有个区间（取最小/最大下标）；一列都没有时为 null
  const eduColRange = eduIdx.length
    ? { start: Math.min(...eduIdx), end: Math.max(...eduIdx) }
    : null;
  // 「这列是不是教育经历」按字段名判（EDU_SUB_FIELDS 是唯一出处），不按上面的区间判 ——
  // 区间只在合并表头那一处才真的需要
  const isEduCol = (i) => EDU_SUB_FIELDS.includes(fields[i]);

  // 每列所属的分组（null = 没有分组标题，如姓名、在线简历）。只算一次，下面合并 / 补值 / Row 1 样式共用
  const colGroups = fields.map(f => FIELD_GROUPS.find(g => g.fields.includes(f)) || null);

  // 3a. 分组标题行合并（Row 1）。区间按字段名在**实际列序**里的位置算；
  //     该组一个字段都没导出（--fields 只导了一部分）时跳过
  const merges = [];
  for (const g of FIELD_GROUPS) {
    const idx = g.fields.map(f => fields.indexOf(f)).filter(i => i >= 0);
    if (!idx.length) continue;
    merges.push({ s: { r: 1, c: Math.min(...idx) + 1 }, e: { r: 1, c: Math.max(...idx) + 1 } });
  }

  // 3b. 主标题行"教育经历"合并（Row 2, 横跨四个子列）
  if (eduColRange) {
    merges.push({ s: { r: 2, c: eduColRange.start + 1 }, e: { r: 2, c: eduColRange.end + 1 } });
  }

  // 3c. 非教育列合并表头：有分组标题的合并 Row 2~3（去掉中间分隔线）；
  //     没有分组标题的（姓名、在线简历）直接合并 Row 1~3，标题占满三行表头高度，上方不留空档
  for (let c = 0; c < colCount; c++) {
    if (isEduCol(c)) continue;
    if (colGroups[c]) {
      merges.push({ s: { r: 2, c: c + 1 }, e: { r: 3, c: c + 1 } });
    } else {
      merges.push({ s: { r: 1, c: c + 1 }, e: { r: 3, c: c + 1 } });
    }
  }

  // 3d. 数据行垂直合并（同一候选人的非教育列）
  const mergeBlocks = [];
  let blockStart = dataStartRow;
  for (let r = dataStartRow; r <= totalRows; r++) {
    const nameVal = groupData[r - 1]?.[0];
    if (nameVal && r > blockStart) {
      mergeBlocks.push({ start: blockStart, end: r - 1 });
      blockStart = r;
    }
  }
  if (blockStart <= totalRows) {
    mergeBlocks.push({ start: blockStart, end: totalRows });
  }

  for (const block of mergeBlocks) {
    if (block.end - block.start < 1) continue;
    for (let c = 0; c < colCount; c++) {
      if (isEduCol(c)) continue;
      merges.push({ s: { r: block.start, c: c + 1 }, e: { r: block.end, c: c + 1 } });
    }
  }

  // 先写值再合并（exceljs mergeCells 会保留左上角单元格的值）
  for (const m of merges) {
    ws.mergeCells(m.s.r, m.s.c, m.e.r, m.e.c);
  }

  // 部分 exceljs 版本合并后清空了左上单元格的值，此处补回
  // （无分组列的左上角在 Row 1，不是 Row 2 —— 合并的是 1~3 行）
  for (let c = 0; c < colCount; c++) {
    if (isEduCol(c)) continue;
    const v = groupData[1]?.[c];
    if (!v) continue;
    ws.getCell(colGroups[c] ? 2 : 1, c + 1).value = v;
  }

  // 4. 设置列宽
  for (let col = 0; col < colCount; col++) {
    ws.getColumn(col + 1).width = COL_WIDTHS[fields[col]] ?? DEFAULT_COL_WIDTH;
  }

  // 5. 设置行高
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 24;
  ws.getRow(3).height = 20;

  // 冻结前三行（分组标题 + 主标题 + 子标题）
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  // 6. 应用样式

  // --- 分组标题行样式 (Row 1) ---
  // 逐列取格（不用 eachCell）：这趟要按列判断有没有所属分组，有分组的才上底色和白色粗体字，
  // 无分组列（姓名、在线简历）留给下面 Row 2 那趟 —— 它们的表头是 1~3 行合并的整块
  for (let colIdx = 0; colIdx < colCount; colIdx++) {
    const cell = ws.getCell(1, colIdx + 1);
    const group = colGroups[colIdx];
    if (group) {
      cell.fill = solidFill(group.headerFill);
      cell.font = { bold: true, color: { argb: group.headerText }, size: 12 };
      cell.alignment = { ...DEFAULT_ALIGNMENT };
      cell.border = THIN_BORDER;
    }
  }

  // --- 主标题行样式 (Row 2) ---
  const mainRowRef = ws.getRow(2);
  mainRowRef.eachCell((cell, colNum) => {
    const colIdx = colNum - 1;
    // 非教育列跟 Row 3 纵向合并成一格，字体/底色/边框全由 Row 3 那趟决定 —— 这里直接跳过，
    // 免得写了又被覆盖（那样「表头不加粗」就成了循环顺序的副产物，谁调换两趟顺序谁就把加粗放回来）
    if (!isEduCol(colIdx)) return;
    // 只有「教育经历」这一格（横向合并 4 列、Row 3 够不着）的字体在这里定：不加粗 ——
    // 它是子标题「时间/学校/专业/学历」的总帽子，加粗会和下面真正的列名抢注意力
    cell.font = { size: 11, color: { argb: 'FF000000' } };
    cell.alignment = { ...DEFAULT_ALIGNMENT };
    cell.border = THIN_BORDER;
    const fieldStyle = FIELD_STYLES[fields[colIdx]];
    if (fieldStyle && fieldStyle.fill) {
      cell.fill = fieldStyle.fill;
    }
  });

  // --- 子标题行样式 (Row 3) ---
  const subRowRef = ws.getRow(3);
  subRowRef.eachCell((cell, colNum) => {
    const colIdx = colNum - 1;
    const fieldKey = fields[colIdx];
    const fieldStyle = FIELD_STYLES[fieldKey];
    cell.font = { size: 10, color: { argb: 'FF000000' } };
    cell.alignment = { ...DEFAULT_ALIGNMENT };
    cell.border = THIN_BORDER;
    if (fieldStyle && fieldStyle.fill) {
      cell.fill = fieldStyle.fill;
    }
  });

  // --- 数据行样式 ---
  for (let r = dataStartRow; r <= totalRows; r++) {
    const rowRef = ws.getRow(r);
    rowRef.height = BASE_ROW_HEIGHT;
    rowRef.eachCell((cell, colNum) => {
      const colIdx = colNum - 1;
      const fieldKey = fields[colIdx];
      const fieldStyle = FIELD_STYLES[fieldKey];

      if (fieldStyle && fieldStyle.alignment) {
        cell.alignment = fieldStyle.alignment;
      } else {
        cell.alignment = { ...DEFAULT_ALIGNMENT };
      }

      cell.font = { size: 11 };
      if (fieldKey === 'aiRating') {
        cell.font = { size: 14, color: { argb: 'FFFFA500' } };
      }
      cell.border = THIN_BORDER;
    });
  }

  // --- 行高：每个候选人统一占 ROW_BLOCK_HEIGHT ---
  // 曾经是按内容撑高：评语按每行 35 字、简历按每行 25 字估行数再乘行高。问题出在简历 ——
  // 简历长度在 390~16390 字之间，估出来的行高就跟着在 1012~11808 磅之间跳（差 12 倍），
  // 而表格单行上限只有 409.5 磅：写进去的值全部越界，等于白算，各家表格软件怎么处理还各不相同。
  // 整份简历本来就塞不进一行，所以放弃撑高，一律取上限做统一高度，看全文靠点单元格。
  // 用 mergeBlocks（同一份候选人分块）而不是直接按行设 —— 多条教育经历的候选人占好几行，
  // 按行设会变成好几倍高，那就又不统一了。块内首行拿走剩余高度，其余行保持基础行高。
  for (const block of mergeBlocks) {
    const span = block.end - block.start + 1;
    const firstRowHeight = ROW_BLOCK_HEIGHT - (span - 1) * BASE_ROW_HEIGHT;
    // 兜底：块跨行数很多时（mergeBlocks 分块退化成一整块，或单个候选人教育经历异常多）上面会算出负数
    ws.getRow(block.start).height = Math.max(BASE_ROW_HEIGHT, firstRowHeight);
  }

  return ws;
}

// ===== 工具函数 =====
/**
 * 将岗位名转为合法的 Excel sheet 名
 * - 最长 31 字符
 * - 移除非法字符：\ / ? * [ ] :
 */
function safeSheetName(name) {
  if (!name) return '候选人';
  let safe = name.replace(/[\\\/\?\*\[\]:]/g, '');
  if (safe.length > 31) safe = safe.slice(0, 31);
  return safe || '候选人';
}

/**
 * 生成不重复的 sheet 名。ExcelJS 判重大小写不敏感（worksheet.js 用 toLowerCase 比较），
 * 冲突时追加序号后缀 _2/_3/...；后缀拼接前先截断 base，保证 base+suffix <= 31 字符，
 * 避免 ExcelJS 内部先截断再判重把后缀吃掉导致仍冲突。
 */
function makeUniqueSheetName(baseName, usedLower) {
  const base = baseName || '候选人';
  const firstKey = base.toLowerCase();
  if (!usedLower.has(firstKey)) {
    usedLower.add(firstKey);
    return base;
  }
  for (let n = 2; n < 100; n++) {
    const suffix = `_${n}`;
    const maxBaseLen = 31 - suffix.length;
    const trimmed = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
    const candidate = trimmed + suffix;
    const key = candidate.toLowerCase();
    if (!usedLower.has(key)) {
      usedLower.add(key);
      return candidate;
    }
  }
  // 极端兜底（理论上不可达）
  const fallback = base.slice(0, 24) + '_' + Date.now().toString().slice(-6);
  usedLower.add(fallback.toLowerCase());
  return fallback;
}

// ===== 教育经历修正：以 AI 评语中的「第一学历/最高学历」为准绳 =====
// 正则从 OCR 简历文本里抠教育经历对噪音很脆弱：OCR 会把校名前的汉字吞进学校名
// （'起东北财经大学'）、把校内二级学院误当学校（'通识学院 2022-2023'）。
// 而 AI 评语模板强制含格式稳定的两行：
//   第一学历：重庆工商大学，大数据管理与应用，本科，全日制。
//   最高学历：重庆工商大学，大数据管理与应用，本科（在读），全日制。
// 导出前用这两行修正 educationExperience：校名/专业/学历以 AI 为准，时间沿用原条目。

// 校名像不像真学校：以大学/学院/学校/研究所结尾、不含 OCR 噪音词（证书/资格/收藏/英语等）。
// 用于过滤 OCR 把证书列表、页面文案误认成学校的假条目（如'资格证书大学'）。
function schoolLooksReal(name) {
  const n = (name || '').replace(/\s+/g, '');
  if (!n || n.length < 4) return false;
  if (!/(?:大学|学院|学校|研究所)$/.test(n)) return false;
  if (/证书|资格|英语|人力资源|收藏|经历概览|招聘|比赛|大赛|奖学金|志愿|竞赛|实习/.test(n)) return false;
  return true;
}

// 从 AI 评语解析教育条目，返回 [{school, major, degree}]，按「学校+学历」去重。
// AI 分隔「学校/专业/学历」可能用逗号、空格、顿号、竖线或「+」任一种
// （如'××大学××学院+电子科学与技术+本科+2011-2015，全日制'），统一按这些分隔符切段解析。
function parseEducationFromComment(comment) {
  if (!comment) return [];
  const DEGREE_RE = /(?:本科|硕士|博士|研究生|大专|专科|高职|专升本|高中|中专|初中)/;
  const SCHOOL_END_RE = /(?:大学|学院|学校|研究所)$/;
  const SEP_RE = /[+，,、|\s]+/;
  const results = [];
  const seen = new Set();
  const lineRe = /(?:第一学历|最高学历)\s*[:：]\s*([^\n。；;]+)/g;
  let m;
  while ((m = lineRe.exec(comment)) !== null) {
    const raw = m[1].trim();
    if (!raw || /^(无|未明确|未提供|不详|未找到|没有)/.test(raw)) continue;
    // 去掉「毕业院校/学校」前缀、时间区间及「全日制/在读」等注释，
    // 让行内只剩「学校+专业+学历」；时间区间先捕获，供教育条目补空时间用。
    let line = raw.replace(/^(?:毕业院校|学校)\s*[:：]?\s*/, '').trim();
    const timeMatch = line.match(/(\d{4})\s*[-–—~～至]\s*(\d{4})/);
    const aiTime = timeMatch ? `${timeMatch[1]} - ${timeMatch[2]}` : '';
    line = line.replace(/\d{4}\s*[-–—~～至]\s*\d{4}[^+，,。；;]*/g, '')
               .replace(/[（(][^）)]*[)）]/g, '')
               .replace(/[,，、+]?\s*(?:全日制|非全日制)\s*[^+，,。；;]*/g, '')
               .replace(/[+，,、|\s]+$/, '').trim();
    if (!line) continue;
    // 按分隔符切段。独立学院校名是整体（如'××大学××学院'），
    // 必须以整个首段作为学校，不能用非贪婪正则提前切断在第一个「大学」处。
    const segs = line.split(SEP_RE).map(s => s.trim()).filter(Boolean);
    if (segs.length === 0) continue;
    let school = SCHOOL_END_RE.test(segs[0]) ? segs[0] : '';
    if (!school) {
      // 首段不像学校（整行无分隔符、校名被专业粘连）：回退贪心匹配最长校名
      const sm = line.match(/([一-龥]{2,}(?:大学|学院|学校|研究所))/);
      school = sm ? sm[1] : '';
    }
    if (!school || !schoolLooksReal(school)) continue; // 疑似识别错误的垃圾校名，跳过该行
    const si = segs.indexOf(school);
    let major = '';
    let degree = '';
    if (si >= 0) {
      // 学历 = 学校段之后第一个含学历词的段；专业 = 学校段与学历段之间的段
      let di = -1;
      for (let i = si + 1; i < segs.length; i++) {
        if (DEGREE_RE.test(segs[i])) { di = i; break; }
      }
      if (di >= 0) {
        degree = segs[di];
        major = segs.slice(si + 1, di).join(' ').replace(/专业$/, '').trim();
      }
    } else {
      // 校名非完整段（粘连场景）：学历词取行内第一个，专业取校名与学历词之间
      const dm = line.match(DEGREE_RE);
      if (dm) {
        degree = dm[0];
        const start = line.indexOf(school) + school.length;
        major = line.slice(start, dm.index).replace(/[+，,、|\s]+/g, ' ').replace(/专业$/, '').trim();
      }
    }
    const key = school + '|' + degree;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ school, major, degree, time: aiTime });
  }
  return results;
}

// 学校名模糊匹配：OCR 抓出的校名可能带前缀噪音（'起东北财经大学' vs '东北财经大学'）
function schoolNamesMatch(a, b) {
  const na = (a || '').replace(/\s+/g, '');
  const nb = (b || '').replace(/\s+/g, '');
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) {
    // 短名要足够具体，避免 'XX大学' 与 'XX大学附属中学' 这类包含关系乱配
    return Math.min(na.length, nb.length) >= 4;
  }
  return false;
}

// 用 AI 评语修正候选人的 educationExperience
function enrichEducationFromComment(c) {
  const aiList = parseEducationFromComment(c.jobRelevanceComment);
  if (aiList.length === 0) return;
  const existing = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  const merged = [];
  const used = new Set();
  for (const ai of aiList) {
    // 找现有条目里学校模糊匹配的，复用其时间
    let hit = -1;
    for (let i = 0; i < existing.length; i++) {
      if (used.has(i)) continue;
      if (schoolNamesMatch(existing[i].school, ai.school)) { hit = i; break; }
    }
    if (hit >= 0) {
      used.add(hit);
      const ex = existing[hit];
      merged.push({
        time: ai.time || ex.time || '',
        school: ai.school,
        major: ai.major || ex.major || '',
        degree: ai.degree || ex.degree || '',
      });
    } else {
      merged.push({ time: ai.time || '', school: ai.school, major: ai.major, degree: ai.degree });
    }
  }
  // 现有条目若与 AI 校名都不匹配：多是误抓的二级学院名/OCR噪音（特征：缺学历或缺专业，或校名不像真学校），丢弃；
  // 完整（有学历+专业）且校名像真学校的条目 AI 漏了也保留，避免误删。
  for (let i = 0; i < existing.length; i++) {
    if (used.has(i)) continue;
    const ex = existing[i];
    if (ex.degree && ex.major && schoolLooksReal(ex.school)) merged.push(ex);
  }
  if (merged.length > 0) c.educationExperience = merged;
}

// ===== 从简历文本补教育条目的时间/专业（导出兜底） =====
// OCR 常把一条教育记录拆到相邻两行（一行校名、一行时间），parseEduLine 要求学历词/时间
// 紧跟校名后，跨行的条目会被漏掉；AI 补进的条目时间/专业因此是空（如徐女士本科）。
// 这里在校名前后窗口里找年份区间补时间；专业只在「校名后是干净文本」时才补，防把
// "负责人/专业排名"这类 OCR 噪音当专业。
function findSchoolContextFromText(resumeText, school) {
  if (!resumeText || !school) return { time: '', major: '' };
  const t = resumeText.replace(/[ \t]+/g, ' ').trim();
  const idx = t.indexOf(school);
  if (idx < 0) return { time: '', major: '' };
  const before = t.slice(Math.max(0, idx - 60), idx);
  const after = t.slice(idx + school.length, Math.min(t.length, idx + school.length + 90));
  const win = before + school + after;
  const tm = win.match(/(\d{4})\s*[-–—~～至]\s*(\d{4})/);
  const time = tm ? `${tm[1]} - ${tm[2]}` : '';
  // 专业：校名后到「时间/专业排名/主修课程」等锚点前的文本；含 OCR 噪音词则放弃
  const mj = after.match(/^[,，、|\s:：·]*([^,，、|\s:：·\d][^,，、|\s:：·\n]{1,24}?)(?=\s*(?:\d{4}|专业排名|主修课程|排名|在校经历|荣誉|工作经历|经历概览|证书|本科|硕士|博士|学历))/);
  let major = '';
  // 必须含汉字（防 OCR 标点残片如 '.…' 当专业），且不含噪音词
  if (mj && /[一-龥]/.test(mj[1]) &&
      !/负责人|专业排名|主修课程|统计|调研|收藏|经历概览|排名|四级|六级|证[书件]|竞赛|协会|社团|志愿服务|奖学金|主修/.test(mj[1])) {
    major = mj[1];
  }
  return { time, major };
}

function fillEducationGapsFromResumeText(c) {
  const edu = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  if (edu.length === 0) return;
  const text = c.resumeText || c.rawVisibleText || '';
  for (const e of edu) {
    if (e.time && e.major) continue;
    const { time, major } = findSchoolContextFromText(text, e.school);
    if (e.time || !time) { /* 已有时间则不动 */ } else { e.time = time; }
    if (e.major || !major) { /* 已有专业则不动 */ } else { e.major = major; }
  }
}

// ===== 教育经历排序：最高学历排最上面 =====
// AI 评语按「第一学历 → 最高学历」顺序生成，直接照搬会让本科排硕士上面。
// 导出前按学历层次从高到低重排（博士 > 硕士 > 本科 > 大专/专科 > 高中 > 中专/初中），同级别保持原顺序。
const DEGREE_RANK = { '博士': 6, '研究生': 5, '硕士': 5, '本科': 4, '学士': 4, '专升本': 4, '大专': 3, '专科': 3, '高职': 3, '高专': 3, '高中': 2, '中专': 2, '职高': 2, '中技': 2, '初中': 1, '小学': 0 };
function degreeRank(d) {
  const s = String(d || '').trim();
  for (const [k, v] of Object.entries(DEGREE_RANK)) if (s.includes(k)) return v;
  return -1; // 未知学历 → 排最后
}
function sortEducationByDegree(c) {
  const edu = Array.isArray(c.educationExperience) ? c.educationExperience : [];
  if (edu.length < 2) return;
  c.educationExperience = edu
    .map((e, i) => ({ e, i }))
    .sort((a, b) => degreeRank(b.e.degree) - degreeRank(a.e.degree) || a.i - b.i)
    .map((x) => x.e);
}

// ===== 主流程 =====
async function main() {
  const opts = parseArgs();

  // 读取输入
  const inputPath = resolve(opts.input);
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const candidates = input.candidates || input;

  // 用 AI 评语修正教育经历（校名/专业/学历以 AI 为准，修复 OCR 抓脏的学校名、丢掉误抓条目）
  candidates.forEach(enrichEducationFromComment);
  // 从简历文本补空时间/专业（OCR 跨行拆散的条目，如徐女士本科）
  candidates.forEach(fillEducationGapsFromResumeText);
  // 教育经历按学历从高到低排序（最高学历排最上面）
  candidates.forEach(sortEducationByDegree);

  // 按总分降序排序
  candidates.sort((a, b) => (b.totalScore ?? b.score ?? 0) - (a.totalScore ?? a.score ?? 0));

  // 字段选择（支持 --fields 参数）
  const fields = opts.fields
    ? opts.fields.split(',').map(f => f.trim())
    : DEFAULT_FIELDS;

  const mode = input.mode === 'default' ? 'default' : 'filter';

  // 创建工作簿
  const wb = new ExcelJS.Workbook();
  wb.creator = 'AI评分系统';
  wb.created = new Date();

  // 按 appliedJob 分组
  const positionGroups = new Map();
  for (const c of candidates) {
    const job = c.positionInfo?.appliedJob || '未知岗位';
    if (!positionGroups.has(job)) positionGroups.set(job, []);
    positionGroups.get(job).push(c);
  }

  let sheetCount = 0;
  const usedSheetNames = new Set();
  for (const [position, groupCandidates] of positionGroups) {
    // 组内排序
    groupCandidates.sort((a, b) => (b.totalScore ?? b.score ?? 0) - (a.totalScore ?? a.score ?? 0));

    const groupData = buildGroupedExportData(groupCandidates, fields, mode);
    const sheetName = makeUniqueSheetName(safeSheetName(position), usedSheetNames);

    await createStyledSheet(wb, sheetName, groupData, fields);
    sheetCount++;
  }

  // 如果没有任何分组，创建默认 sheet
  if (sheetCount === 0) {
    const emptyData = buildGroupedExportData([], fields, mode);
    await createStyledSheet(wb, '候选人', emptyData, fields);
  }

  // 输出路径
  const outputDir = dirname(inputPath);
  const outputPath = opts.output || resolve(outputDir, 'candidates.xlsx');
  mkdirSync(dirname(outputPath), { recursive: true });

  // 写临时文件，避免被占用的文件直接写入报错
  const tmpPath = outputPath + '.tmp';
  await wb.xlsx.writeFile(tmpPath);

  // 尝试覆盖目标文件
  let finalPath = outputPath;
  try {
    // 删除旧文件（忽略文件不存在）
    try { unlinkSync(outputPath); } catch {}
    renameSync(tmpPath, outputPath);
  } catch (err) {
    // 文件被占用（如 Excel 打开中），改用带时间戳的文件名
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    finalPath = resolve(dirname(outputPath), `candidates-${ts}.xlsx`);
    renameSync(tmpPath, finalPath);
    console.warn(`输出文件被占用，已另存为： ${finalPath}`);
  }

  console.log(`导出成功： ${finalPath}`);
  console.log(`共导出 ${candidates.length} 条记录，${sheetCount} 个岗位`);

  // 输出各岗位人数
  for (const [position, groupCandidates] of positionGroups) {
    const passCount = groupCandidates.filter(c => c.passed !== false).length;
    console.log(`  ${position}： ${groupCandidates.length} 人（通过 ${passCount}）`);
  }

  // 统计信息
  if (input.totalCandidates && input.passedCount) {
    console.log(`筛选规则： ${input.filterName || '未知'} （v${input.filterVersion || '?'}）`);
    console.log(`通过率： ${input.passedCount}/${input.totalCandidates} （${Math.round(input.passedCount / input.totalCandidates * 100)}%）`);
  } else if (input.mode === 'default') {
    console.log(`评分模式： 默认评分（全量）`);
  }

  // 邮件发送（可选，--to-prefix 时触发）
  if (opts['to-prefix']) {
    await sendEmailAfterExport(opts, finalPath);
  }
}

async function sendEmailAfterExport(opts, excelPath) {
  if (!existsSync(excelPath)) {
    console.error(`无法发送邮件：附件文件不存在 ${excelPath}`);
    return;
  }
  try {
    const { sendCandidateEmail } = await import('./send-candidates-email.mjs');
    const result = await sendCandidateEmail({
      toPrefix: opts['to-prefix'],
      attachmentPath: excelPath,
      subject: opts['email-subject'] || undefined,
    });
    // MAIL_OK / MAIL_FAIL 是给主进程解析的机器标记，主进程据此判断邮件是否真的发出去了，
    // 避免导出脚本退出码为 0 时界面误报「邮件已发送」（实际可能认证失败没发出去）
    console.log(`MAIL_OK:${result.to}`);
    console.log(`邮件发送成功： ${result.to}`);
  } catch (err) {
    console.log(`MAIL_FAIL:${err.message}`);
    console.error(`邮件发送失败： ${err.message}`);
  }
}

// 只在直接执行时运行主流程
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch(err => {
    console.error(`导出失败： ${err.message}`);
    process.exit(1);
  });
}

export { FIELD_CONFIG, DEFAULT_FIELDS, FIELD_GROUPS, transformCandidates, buildGroupedExportData, safeSheetName, toAiRating, formatComment, activeStatusOf, jobStatusOf };