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
import { commentToRuns } from './format-comment.mjs';

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
// 字段表、样式、分组、列宽都在 ./export-fields.mjs
import {
  DEFAULT_FIELDS, FIELD_CONFIG, FIELD_GROUPS, FIELD_GROUP_OF, SUB_GROUPS, SUB_GROUP_OF,
  COL_WIDTHS, DEFAULT_COL_WIDTH, FIELD_STYLES, FIELD_FONTS,
  ROW_BLOCK_HEIGHT, BASE_ROW_HEIGHT, DEFAULT_ALIGNMENT, THIN_BORDER, solidFill,
} from './export-fields.mjs';
// 教育经历的修正与排序在 ./export-education.mjs
import { enrichEducationFromComment, fillEducationGapsFromResumeText, sortEducationByDegree } from './export-education.mjs';

// ===== 数据转换 =====
// 「一人多段、占多行」的字段：extract 收第二个参数（行索引）就表示可展开（现在只有教育经历）。
// 合并单元格时这类字段按行留空、不能跨行合并，其余字段一人一份、要合并。
// 取值（transformCandidates 手里是配置对象）与合并（手里是字段名）共用这一份判据
const isExpandable = (cfg) => (cfg?.extract.length ?? 0) >= 2;
const isExpandedField = (field) => isExpandable(FIELD_CONFIG[field]);

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
        if (isExpandable(cfg)) {
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
  const groupHeaders = fields.map(f => FIELD_GROUP_OF.get(f)?.label);

  // 主标题行 (Row 2)：二级分组（AI评分 / 教育经历）显示分组名，其他用原始 header
  const mainHeaders = fields.map(f => SUB_GROUP_OF.get(f)?.label ?? FIELD_CONFIG[f]?.header ?? f);

  // 子标题行 (Row 3)：仅二级分组的成员显示原始 header，其他为空
  const subHeaders = fields.map(f => (SUB_GROUP_OF.has(f) ? FIELD_CONFIG[f]?.header ?? f : ''));

  return [groupHeaders, mainHeaders, subHeaders, ...rows];
}

// ===== 样式化导出 =====
/**
 * 创建带样式的 worksheet
 * 表头结构 3 行：分组标题（AI分析 / 基本信息 / 求职期望）/ 二级分组（AI评分 · 教育经历，
 * 横跨各自的子列）/ 列名（档位·匹配度评分·维度得分、学校·专业·学历·时间…）
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

  // 字段名 → 实际列序（0 基）。合并表头、补值、Row 1 样式下面都要用，放在最前：
  // 不写死字段名 —— 子列的先后顺序会调，写死字段名在调顺序后就会指错列
  const colIndex = new Map(fields.map((f, i) => [f, i]));

  // 2. 添加数据行
  //    评语列只给结论词上语义色、不加粗（界面那套加粗只做在软件里）；文字一个都不改。
  //    与 addRow 同一趟循环：行号就是 addRow 的隐式计数器，分成两趟得再维护一套下标
  const commentCol = colIndex.get('jobRelevanceComment');
  dataRows.forEach((row, i) => {
    ws.addRow(row);
    if (commentCol === undefined) return;
    const runs = commentToRuns(row[commentCol]);
    // 没有结论词就保持纯字符串，不为每格都造一个富文本
    if (runs.some((r) => r.font)) ws.getCell(dataStartRow + i, commentCol + 1).value = { richText: runs };
  });

  const totalRows = groupData.length; // 总行数

  // 3. 合并单元格

  // 一张分组定义表 → 各分组在**实际列序**里的区间（合并表头要横跨它）。
  // --fields 只导一部分时该组可能一列都没有，跳过
  const rangesOf = (defs) => defs.map((g) => {
    const idx = g.fields.map((f) => colIndex.get(f)).filter((i) => i !== undefined);
    return idx.length ? { start: Math.min(...idx), end: Math.max(...idx) } : null;
  }).filter(Boolean);
  // 「这列有没有二级标题」按字段名判（SUB_GROUP_OF 是唯一出处），不按区间判 ——
  // 区间只在合并表头那一处才真的需要
  const isSubCol = (i) => SUB_GROUP_OF.has(fields[i]);
  const expandedCols = fields.map(isExpandedField);

  // 每列所属的分组（null = 没有分组标题，如姓名、在线简历）。只算一次，下面合并 / 补值 / Row 1 样式共用
  const colGroups = fields.map(f => FIELD_GROUP_OF.get(f) || null);

  const merges = [];

  // 3a. 分组标题行合并（Row 1）
  for (const r of rangesOf(FIELD_GROUPS)) {
    merges.push({ s: { r: 1, c: r.start + 1 }, e: { r: 1, c: r.end + 1 } });
  }

  // 3b. 二级分组标题合并（Row 2, 横跨该组所有子列）：AI评分、教育经历各一条
  for (const r of rangesOf(SUB_GROUPS)) {
    merges.push({ s: { r: 2, c: r.start + 1 }, e: { r: 2, c: r.end + 1 } });
  }

  // 3c. 没有二级分组的列：有分组标题的合并 Row 2~3（去掉中间分隔线）；
  //     没有分组标题的（姓名、在线简历）直接合并 Row 1~3，标题占满三行表头高度，上方不留空档
  for (let c = 0; c < colCount; c++) {
    if (isSubCol(c)) continue;
    if (colGroups[c]) {
      merges.push({ s: { r: 2, c: c + 1 }, e: { r: 3, c: c + 1 } });
    } else {
      merges.push({ s: { r: 1, c: c + 1 }, e: { r: 3, c: c + 1 } });
    }
  }

  // 3d. 数据行垂直合并（同一候选人占多行时，一人一份的列合并成一格）。
  //     排除的是「可展开字段」——它们一人多段、每行一段（现在只有教育经历）；
  //     AI 评分数值列一人只有一个值，要跟姓名、评语一样跨行合并
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
      if (expandedCols[c]) continue;
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
    if (isSubCol(c)) continue;
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
    // 非二级分组的列跟 Row 3 纵向合并成一格，字体/底色/边框全由 Row 3 那趟决定 —— 这里直接跳过，
    // 免得写了又被覆盖（那样「表头不加粗」就成了循环顺序的副产物，谁调换两趟顺序谁就把加粗放回来）
    if (!isSubCol(colIdx)) return;
    // 二级分组标题（「AI评分」「教育经历」）横向合并、Row 3 够不着，字体在这里定：不加粗 ——
    // 它是子标题的总帽子，加粗会和下面真正的列名抢注意力
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

      cell.font = FIELD_FONTS[fieldKey] ?? { size: 11 };
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

