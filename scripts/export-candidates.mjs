#!/usr/bin/env node
/**
 * export-candidates.mjs - 候选人 Excel 导出脚本
 *
 * 将 scored-candidates.json 导出为 Excel 文件
 *
 * Usage:
 *   node scripts/export-candidates.mjs --input output/scored-candidates.json
 */

import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 动态导入 xlsx
let XLSX;
try {
  XLSX = await import('xlsx');
} catch {
  console.error('错误：未安装 xlsx 包');
  console.error('请运行: npm install xlsx');
  process.exit(1);
}

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
  if (score >= 80) return '五星';
  if (score >= 60) return '四星';
  if (score >= 40) return '三星';
  if (score >= 20) return '二星';
  return '一星';
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
  school: {
    header: '学校',
    extract: (c) => c.educationExperience?.[0]?.school || '',
  },
  education: {
    header: '学历',
    extract: (c) => c.basicInfo?.education || '',
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
    extract: (c) => c.jobRelevanceComment || '',
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
  'school',
  'education',
  'workYears',
  'resumeText',
];

// ===== 数据转换 =====
function transformCandidates(candidates, fields, mode = 'filter') {
  const enriched = candidates.map(c => ({
    ...c,
    _defaultMode: mode === 'default',
  }));
  const selectedConfig = fields.map(f => FIELD_CONFIG[f] || { header: f, extract: () => '' });

  const headers = selectedConfig.map(cfg => cfg.header);
  const rows = enriched.map(c =>
    selectedConfig.map(cfg => cfg.extract(c))
  );

  return [headers, ...rows];
}

function buildGroupedExportData(candidates, fields, mode = 'filter') {
  const data = transformCandidates(candidates, fields, mode);
  const headers = data[0];
  const rows = data.slice(1);
  const groupHeaders = fields.map((_, index) => {
    if (index === 0) return 'AI分析';
    if (index === 3) return '附加信息';
    return undefined;
  });
  return [groupHeaders, headers, ...rows];
}

// ===== 自动列宽 =====
function autoColumnWidth(ws, data, fields) {
  const colCount = data[0].length;
  const colWidths = [];

  for (let col = 0; col < colCount; col++) {
    const fieldKey = fields[col];
    // 在线简历列固定宽度：默认截断显示，点击单元格后在 Excel 编辑栏查看完整内容
    if (fieldKey === 'resumeText') {
      colWidths.push({ wch: 50 });
      continue;
    }
    let maxLen = 0;
    for (let row = 0; row < data.length; row++) {
      const cell = data[row][col];
      const len = String(cell).length;
      // 中文字符宽度加倍
      const width = len + String(cell).replace(/[^\x00-\xff]/g, 'xx').length / 2;
      maxLen = Math.max(maxLen, Math.min(width, 50)); // 最大 50
    }
    colWidths.push({ wch: maxLen + 2 }); // 加 padding
  }

  ws['!cols'] = colWidths;
}

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

function applyGroupedHeaders(ws) {
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 7 } },
  ];
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
  const wb = XLSX.utils.book_new();

  // 按 appliedJob 分组
  const positionGroups = new Map();
  for (const c of candidates) {
    const job = c.positionInfo?.appliedJob || '未知岗位';
    if (!positionGroups.has(job)) positionGroups.set(job, []);
    positionGroups.get(job).push(c);
  }

  let sheetCount = 0;
  for (const [position, groupCandidates] of positionGroups) {
    // 组内排序
    groupCandidates.sort((a, b) => (b.totalScore ?? b.score ?? 0) - (a.totalScore ?? a.score ?? 0));

    const groupData = buildGroupedExportData(groupCandidates, fields, mode);
    const ws = XLSX.utils.aoa_to_sheet(groupData);
    autoColumnWidth(ws, groupData, fields);
    applyGroupedHeaders(ws);

    const sheetName = safeSheetName(position);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    sheetCount++;
  }

  // 如果没有任何分组（理论上不会发生），创建默认 sheet
  if (sheetCount === 0) {
    const emptyData = buildGroupedExportData([], fields, mode);
    const ws = XLSX.utils.aoa_to_sheet(emptyData);
    applyGroupedHeaders(ws);
    XLSX.utils.book_append_sheet(wb, ws, '候选人');
  }

  // 输出路径
  const outputDir = dirname(inputPath);
  const outputPath = opts.output || resolve(outputDir, 'candidates.xlsx');
  mkdirSync(dirname(outputPath), { recursive: true });

  XLSX.writeFile(wb, outputPath);

  console.log(`导出成功: ${outputPath}`);
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
    await sendEmailAfterExport(opts, outputPath);
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
    console.log(`邮件发送成功: ${result.to}`);
  } catch (err) {
    console.error(`邮件发送失败: ${err.message}`);
  }
}

// 只在直接执行时运行主流程
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMainModule) {
  main().catch(err => {
    console.error(`导出失败: ${err.message}`);
    process.exit(1);
  });
}

export { FIELD_CONFIG, DEFAULT_FIELDS, transformCandidates, buildGroupedExportData, safeSheetName, toAiRating };