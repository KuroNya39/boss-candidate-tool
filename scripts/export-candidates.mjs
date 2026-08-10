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
    console.error('Usage: node scripts/export-candidates.mjs --input <scored-candidates.json> [--to-prefix <email-prefix>] [--email-domain <domain>] [--email-subject <subject>]');
    process.exit(1);
  }
  return opts;
}

// ===== 字段配置 =====
function toAiRating(candidate) {
  const score = candidate.totalScore ?? candidate.score ?? 0;
  const count = score >= 91 ? 5 : score >= 81 ? 4 : score >= 61 ? 3 : score >= 31 ? 2 : 1;
  return '★'.repeat(count);
}

// 统一评语换行格式（与 main.mjs 中的格式化逻辑保持一致）
// 把 AI 输出的评语重排成 config/scoring-prompt-*.txt「最终输出模板」的编号结构：
//   1.首句定性 / 2.3个评估维度的匹配情况(3维度+计分) / 3.任职资格的匹配情况 / 4.学历硬性门槛核查 / 5.综合结论
// 无论 AI 是否自带编号/换行，导出 Excel 时都强制按模板排版。
const FORMAT_COMMENT_DIM_RE = '[^\\s：。，,；;！?！？…（）()]{2,30}（\\d{1,3}%，独立得分：\\d{1,3}分）\\s*[:：]';
function formatComment(text) {
  if (!text) return '';
  let t = String(text);

  // 0) 去掉 AI 可能自带的板块编号/标题，避免重复（如 "1.首句定性"、"2.3个评估维度的匹配情况："）
  t = t.replace(/[0-9一二三四五六七八九十]*[.、．]?\s*3个评估维度的匹配情况\s*[:：]?/, '');
  t = t.replace(/([0-9一二三四五六七八九十]+[.、．]\s*)(?=(首句定性|任职资格的匹配情况|学历硬性门槛核查|综合结论))/g, '');

  // 1) 四个固定板块标题统一编号（模板结构），吞掉原冒号避免双冒号
  const blocks = [
    [/首句定性/, '1.首句定性：'],
    [/任职资格的匹配情况/, '3.任职资格的匹配情况：'],
    [/学历硬性门槛核查/, '4.学历硬性门槛核查：'],
    [/综合结论/, '5.综合结论：'],
  ];
  for (const [re, label] of blocks) {
    t = t.replace(new RegExp(re.source + '\\s*[:：]?'), '\n' + label);
  }

  // 2) 每个维度行前统一为一个换行（AI 没换行就补上，AI 换多了就并掉）
  t = t.replace(new RegExp('(' + FORMAT_COMMENT_DIM_RE + ')', 'g'), '\n$1');
  t = t.replace(new RegExp('\\n{2,}(?=' + FORMAT_COMMENT_DIM_RE + ')', 'g'), '\n');

  // 3) 计分行、学历核查子行：行首换行统一为一个
  //    （关键词后必须跟冒号才视为标题，避免误切"匹配度评分：91分（=...其他扣分合计0...）"里的同名词）
  t = t.replace(/(\n+)(加权基础分计算|其他扣分合计|匹配度评分)\s*[:：]?/g, '\n$2：');
  t = t.replace(/(\n+)(第一学历|最高学历|合规性结论)\s*[:：]?/g, '\n$2：');
  //    AI 挤成一行时，句号/分号后出现的关键词也补换行（句号是安全的句子边界）
  t = t.replace(/(?<=。|；|）)(加权基础分计算|其他扣分合计|匹配度评分)\s*[:：]/g, '\n$1：');
  t = t.replace(/(?<=。|；|）)(第一学历|最高学历|合规性结论)\s*[:：]/g, '\n$1：');

  // 4) 维度块标题（"2.3个评估维度的匹配情况："独占一行），插在第一条维度行前
  t = t.replace(new RegExp('(\\n+)(?=' + FORMAT_COMMENT_DIM_RE + ')'), '\n2.3个评估维度的匹配情况：\n');

  // 5) 板块之间空一行
  t = t.replace(/\n(?=[1-5]\.(?:首句定性|3个评估维度|任职资格的匹配情况|学历硬性门槛核查|综合结论))/g, '\n\n');

  // 6) 清理
  t = t.replace(/\n{3,}/g, '\n\n');
  // 修复旧数据中误换行的"刚性扣分"（非标题场景，如"刚性扣分。学历..."）
  t = t.replace(/\n刚性扣分(?!说明)/g, '刚性扣分');
  t = t.replace(/^\n+/, '');
  return t.trim();
}

const FIELD_CONFIG = {
  name: {
    header: '姓名',
    extract: (c) => c.basicInfo?.name || '',
  },
  aiRating: {
    header: 'AI评级',
    extract: (c) => toAiRating(c),
  },
  age: {
    header: '年龄',
    extract: (c) => c.basicInfo?.age || '',
  },
  workYears: {
    header: '工作年限',
    extract: (c) => c.basicInfo?.workYears || '',
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
    header: 'AI评级理由',
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
  currentPosition: {
    header: '当前职位',
    extract: (c) => c.workExperience?.[0]?.position || '',
  },
  currentCompany: {
    header: '当前公司',
    extract: (c) => c.workExperience?.[0]?.company || '',
  },
  expectCity: {
    header: '期望城市',
    extract: (c) => c.positionInfo?.expectCity || '',
  },
  expectSalary: {
    header: '期望薪资',
    extract: (c) => c.positionInfo?.expectSalary || '',
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

// 默认导出字段顺序
const DEFAULT_FIELDS = [
  'name',
  'aiRating',
  'jobRelevanceComment',
  'age',
  'eduTime',
  'eduSchool',
  'eduMajor',
  'eduDegree',
  'workYears',
  'resumeText',
];

// ===== 分组配置 =====
const FIELD_GROUPS = [
  { label: 'AI分析', start: 0, end: 2 },
  { label: '附加信息', start: 3, end: 9 },
];
// 教育经历子字段列表（在列标题行合并为"教育经历"，子标题行显示具体字段名）
const EDU_SUB_FIELDS = ['eduTime', 'eduSchool', 'eduMajor', 'eduDegree'];

// ===== 字段样式配置 =====
const FIELD_STYLES = {
  name: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD6E8F0' } },   // 柔蓝
  },
  aiRating: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } },   // 柔黄
  },
  jobRelevanceComment: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2EFDA' } },   // 柔绿
    alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
  },
  age: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4EC' } },   // 柔粉
  },
  eduTime: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } },   // 柔橙
  },
  eduSchool: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } },   // 柔橙
  },
  eduMajor: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } },   // 柔橙
  },
  eduDegree: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3E0' } },   // 柔橙
  },
  workYears: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE0F7FA' } },   // 柔青
  },
  resumeText: {
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } },   // 柔灰
    alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
  },
};

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
  const colHeaders = data[0];   // 字段原始 header: 姓名, AI评级, ..., 时间, 学校, 专业, 学历, ...
  const rows = data.slice(1);

  // 分组标题行 (Row 1)
  const groupHeaders = fields.map(() => undefined);
  for (const g of FIELD_GROUPS) {
    for (let i = g.start; i <= g.end; i++) {
      if (i < groupHeaders.length) groupHeaders[i] = g.label;
    }
  }

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
function applyGroupHeaderStyle(ws, lastCol, groupLabel, fillColor) {
  // groupHeaderRowIndex 是 exceljs 中的行号，在第 1 行处理时传入
}

/**
 * 创建带样式的 worksheet
 * 表头结构 3 行：分组标题 / 主标题（教育经历合并）/ 子标题（时间·学校·专业·学历）
 */
async function createStyledSheet(wb, sheetName, groupData, fields) {
  const ws = wb.addWorksheet(sheetName);

  const groupHeaders = groupData[0];  // 分组标题行
  const mainHeaders  = groupData[1];  // 主标题行
  const subHeaders   = groupData[2];  // 子标题行
  const dataRows     = groupData.slice(3); // 数据行

  const colCount = fields.length;
  const eduFirstIdx = fields.indexOf('eduTime'); // 教育经历起始列（0-based）

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

  // 教育经历列范围
  const eduColRange = { start: eduFirstIdx >= 0 ? eduFirstIdx : 0, end: eduFirstIdx >= 0 ? eduFirstIdx + 3 : -1 };

  // 3a. 分组标题行合并（Row 1）
  const merges = [];
  for (const g of FIELD_GROUPS) {
    if (g.start < colCount && g.end < colCount) {
      merges.push({ s: { r: 1, c: g.start + 1 }, e: { r: 1, c: g.end + 1 } });
    }
  }

  // 3b. 主标题行"教育经历"合并（Row 2, cols eduFirstIdx+1 ~ eduFirstIdx+4）
  if (eduFirstIdx >= 0) {
    merges.push({ s: { r: 2, c: eduFirstIdx + 1 }, e: { r: 2, c: eduFirstIdx + 4 } });
  }

  // 3c. 非教育列 Row 2~Row 3 合并（去掉中间的分隔线）
  for (let c = 0; c < colCount; c++) {
    if (c >= eduColRange.start && c <= eduColRange.end) continue;
    merges.push({ s: { r: 2, c: c + 1 }, e: { r: 3, c: c + 1 } });
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
      if (c >= eduColRange.start && c <= eduColRange.end) continue;
      merges.push({ s: { r: block.start, c: c + 1 }, e: { r: block.end, c: c + 1 } });
    }
  }

  // 先写值再合并（exceljs mergeCells 会保留左上角单元格的值）
  for (const m of merges) {
    ws.mergeCells(m.s.r, m.s.c, m.e.r, m.e.c);
  }

  // 部分 exceljs 版本合并后清空了左上单元格的值，此处补回
  for (let c = 0; c < colCount; c++) {
    if (c >= eduColRange.start && c <= eduColRange.end) continue;
    const v = groupData[1]?.[c];
    if (v) ws.getCell(2, c + 1).value = v;
  }

  // 4. 设置列宽
  for (let col = 0; col < colCount; col++) {
    const fieldKey = fields[col];
    const colIdx = col + 1;

    if (fieldKey === 'jobRelevanceComment') {
      ws.getColumn(colIdx).width = 90;
    } else if (fieldKey === 'resumeText') {
      ws.getColumn(colIdx).width = 60;
    } else if (fieldKey === 'eduSchool') {
      ws.getColumn(colIdx).width = 28;
    } else if (fieldKey === 'eduTime') {
      ws.getColumn(colIdx).width = 16;
    } else if (fieldKey === 'eduMajor') {
      ws.getColumn(colIdx).width = 16;
    } else if (fieldKey === 'eduDegree') {
      ws.getColumn(colIdx).width = 8;
    } else {
      ws.getColumn(colIdx).width = 18;
    }
  }

  // 5. 设置行高
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 24;
  ws.getRow(3).height = 20;

  // 冻结前三行（分组标题 + 主标题 + 子标题）
  ws.views = [{ state: 'frozen', ySplit: 3 }];

  // 6. 应用样式

  // --- 分组标题行样式 (Row 1) ---
  const groupRowRef = ws.getRow(1);
  groupRowRef.eachCell((cell, colNum) => {
    const colIdx = colNum - 1;
    const group = FIELD_GROUPS.find(g => colIdx >= g.start && colIdx <= g.end);
    if (group) {
      cell.fill = group.label === 'AI分析'
        ? { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } }
        : { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF70AD47' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 12 };
    }
    cell.alignment = { ...DEFAULT_ALIGNMENT };
    cell.border = THIN_BORDER;
  });

  // --- 主标题行样式 (Row 2) ---
  const mainRowRef = ws.getRow(2);
  mainRowRef.eachCell((cell, colNum) => {
    const colIdx = colNum - 1;
    const fieldKey = fields[colIdx];
    const fieldStyle = FIELD_STYLES[fieldKey];
    cell.font = { bold: true, size: 11, color: { argb: 'FF000000' } };
    cell.alignment = { ...DEFAULT_ALIGNMENT };
    cell.border = THIN_BORDER;
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
    // 仅教育经历子标题用灰色，非教育列（已合并到 Row 2）不设灰色
    const isEdu = colIdx >= eduColRange.start && colIdx <= eduColRange.end;
    cell.font = isEdu
      ? { size: 10, color: { argb: 'FF666666' } }
      : { size: 10, color: { argb: 'FF000000' } };
    cell.alignment = { ...DEFAULT_ALIGNMENT };
    cell.border = THIN_BORDER;
    if (fieldStyle && fieldStyle.fill) {
      cell.fill = fieldStyle.fill;
    }
  });

  // --- 数据行样式 ---
  for (let r = dataStartRow; r <= totalRows; r++) {
    const rowRef = ws.getRow(r);
    rowRef.height = 24; // 统一基础行高
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

    // AI评级理由 自动撑高行（按显式换行 + 每段字数估算，留足余量）
    const commentIdx = fields.indexOf('jobRelevanceComment');
    if (commentIdx >= 0) {
      const commentText = String(groupData[r - 1]?.[commentIdx] ?? '');
      if (commentText) {
        // 列宽约90字符，中文字符占2个单位 → 每行约45个中文字。
        // 先按显式换行拆分再逐段估行数，避免重排后行数变多导致被截断。
        const commentLines = commentText.split('\n');
        let lineCount = 0;
        for (const ln of commentLines) {
          lineCount += Math.max(1, Math.ceil(ln.length / 35)); // 保守估算每行35字
        }
        rowRef.height = Math.max(lineCount * 22, 60);
      }
    }
    // 在线简历 自动撑高行
    const resumeIdx = fields.indexOf('resumeText');
    if (resumeIdx >= 0) {
      const resumeText = String(groupData[r - 1]?.[resumeIdx] ?? '');
      if (resumeText && resumeText.length > 50) {
        // 在线简历通常很长，列宽60字符 → 每行约30个中文字
        const lineCount = Math.ceil(resumeText.length / 25);
        rowRef.height = Math.max(lineCount * 18, rowRef.height || 60);
      }
    }
    // 教育经历行高
    if (eduFirstIdx >= 0) {
      for (let c = eduFirstIdx; c <= eduFirstIdx + 3; c++) {
        const val = String(groupData[r - 1]?.[c] ?? '');
        if (val) { rowRef.height = Math.max(rowRef.height || 22, 22); break; }
      }
    }
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

// ===== 主流程 =====
async function main() {
  const opts = parseArgs();

  // 读取输入
  const inputPath = resolve(opts.input);
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const candidates = input.candidates || input;

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
    console.warn(`输出文件被占用，已另存为: ${finalPath}`);
  }

  console.log(`导出成功: ${finalPath}`);
  console.log(`共导出 ${candidates.length} 条记录，${sheetCount} 个岗位`);

  // 输出各岗位人数
  for (const [position, groupCandidates] of positionGroups) {
    const passCount = groupCandidates.filter(c => c.passed !== false).length;
    console.log(`  ${position}: ${groupCandidates.length} 人 (通过 ${passCount})`);
  }

  // 统计信息
  if (input.totalCandidates && input.passedCount) {
    console.log(`筛选规则: ${input.filterName || '未知'} (v${input.filterVersion || '?'})`);
    console.log(`通过率: ${input.passedCount}/${input.totalCandidates} (${Math.round(input.passedCount / input.totalCandidates * 100)}%)`);
  } else if (input.mode === 'default') {
    console.log(`评分模式: 默认评分 (全量)`);
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
      domain: opts['email-domain'] || undefined,
      subject: opts['email-subject'] || undefined,
    });
    // MAIL_OK / MAIL_FAIL 是给主进程解析的机器标记，主进程据此判断邮件是否真的发出去了，
    // 避免导出脚本退出码为 0 时界面误报「邮件已发送」（实际可能认证失败没发出去）
    console.log(`MAIL_OK:${result.to}`);
    console.log(`邮件发送成功: ${result.to}`);
  } catch (err) {
    console.log(`MAIL_FAIL:${err.message}`);
    console.error(`邮件发送失败: ${err.message}`);
  }
}

// 只在直接执行时运行主流程
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMainModule) {
  main().catch(err => {
    console.error(`导出失败: ${err.message}`);
    process.exit(1);
  });
}

export { FIELD_CONFIG, DEFAULT_FIELDS, transformCandidates, buildGroupedExportData, safeSheetName, toAiRating, formatComment };