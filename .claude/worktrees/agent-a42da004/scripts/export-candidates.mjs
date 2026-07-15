#!/usr/bin/env node
/**
 * export-candidates.mjs - 候选人 Excel 导出脚本
 *
 * 将 scored-candidates.json 导出为 Excel 文件
 *
 * Usage:
 *   node scripts/export-candidates.mjs --input output/scored-candidates.json
 */

import { readFileSync, mkdirSync } from 'node:fs';
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
    console.error('Usage: node scripts/export-candidates.mjs --input <scored-candidates.json>');
    process.exit(1);
  }
  return opts;
}

// ===== 字段配置 =====
const FIELD_CONFIG = {
  name: {
    header: '姓名',
    extract: (c) => c.basicInfo?.name || '',
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
    header: '评语',
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
    extract: (c) => c.score ?? 0,
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
  'age',
  'workYears',
  'school',
  'education',
  'score',
  'educationScore',
  'workYearsScore',
  'jobRelevanceScore',
  'jobRelevanceComment',
  'passed',
  'recommendationLevel',
  'currentPosition',
  'currentCompany',
  'expectCity',
  'expectSalary',
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

// ===== 主流程 =====
function main() {
  const opts = parseArgs();

  // 读取输入
  const inputPath = resolve(opts.input);
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const candidates = input.candidates || input;

  // 按总分降序排序
  candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  // 字段选择（支持 --fields 参数）
  const fields = opts.fields
    ? opts.fields.split(',').map(f => f.trim())
    : DEFAULT_FIELDS;

  const mode = input.mode === 'default' ? 'default' : 'filter';
  const data = transformCandidates(candidates, fields, mode);

  // 创建工作簿
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);

  // 自动列宽
  autoColumnWidth(ws, data, fields);

  // 在线简历列：单元格保留完整内容（Excel 点击时编辑栏可看全文），默认不换行 → 宽度截断显示
  // 不设置 wrapText（xlsx 社区版不支持写单元格样式），行高保持默认
  XLSX.utils.book_append_sheet(wb, ws, '候选人');

  // 输出路径
  const outputDir = dirname(inputPath);
  const outputPath = opts.output || resolve(outputDir, 'candidates.xlsx');
  mkdirSync(dirname(outputPath), { recursive: true });

  XLSX.writeFile(wb, outputPath);

  console.log(`导出成功: ${outputPath}`);
  console.log(`共导出 ${candidates.length} 条记录`);

  // 统计信息
  if (input.totalCandidates && input.passedCount) {
    console.log(`筛选规则: ${input.filterName || '未知'} (v${input.filterVersion || '?'})`);
    console.log(`通过率: ${input.passedCount}/${input.totalCandidates} (${Math.round(input.passedCount / input.totalCandidates * 100)}%)`);
  } else if (input.mode === 'default') {
    console.log(`评分模式: 默认评分 (全量)`);
  }
}

// 只在直接执行时运行主流程
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMainModule) {
  main();
}

export { FIELD_CONFIG, DEFAULT_FIELDS, transformCandidates };