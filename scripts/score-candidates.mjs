#!/usr/bin/env node

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ===== CLI 参数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (key === 'default') {
        opts.default = true;
      } else {
        opts[key] = args[i + 1];
        i++;
      }
    }
  }
  if (!opts.input) {
    console.error('Usage: node score-candidates.mjs --input <file> [--rules <file> | --default] [--position <name>] [--output <file>]');
    process.exit(1);
  }
  if (!opts.default && !opts.rules) {
    console.error('Error: must specify --rules <file> or --default');
    process.exit(1);
  }
  return opts;
}

// ===== 学历排序映射 =====
const EDUCATION_ORDER = ['高中', '中专', '大专', '本科', '硕士', '博士'];

function educationRank(value) {
  if (!value) return -1;
  const idx = EDUCATION_ORDER.indexOf(value);
  return idx >= 0 ? idx : -1;
}

// ===== 学历分映射 =====
const EDUCATION_SCORES = {
  '博士': 20,
  '硕士': 17,
  '本科': 14,
  '大专': 8,
  '中专': 4,
  '高中': 4,
};

function calcEducationScore(education) {
  if (!education) return 0;
  return EDUCATION_SCORES[education] ?? 0;
}

// ===== 工作年限分计算 =====
function calcWorkYearsScore(workYearsStr) {
  const years = parseWorkYears(workYearsStr);
  if (years === null) return 0;
  // 应届生额外 +3
  const isFresh = /应届/.test(workYearsStr || '');
  const base = Math.min(years * 3, 30);
  return isFresh ? base + 3 : base;
}

// ===== rawVisibleText 字段解析 =====

// 从 rawVisibleText 提取学历：按已知等级词匹配，取最高
function resolveEducationFromRaw(rawVisibleText) {
  if (!rawVisibleText) return null;
  // 从高到低匹配，取最高等级
  for (const level of [...EDUCATION_ORDER].reverse()) {
    // 匹配 \n{level}\n 模式（学历独立成行）
    if (rawVisibleText.includes(`\n${level}\n`)) {
      return level;
    }
  }
  return null;
}

// 从 rawVisibleText 提取工作年限
function resolveWorkYearsFromRaw(rawVisibleText) {
  if (!rawVisibleText) return null;

  // 应届生：匹配 "\d+年应届生"
  const freshMatch = rawVisibleText.match(/\n(\d+)年应届生\n/);
  if (freshMatch) {
    return 0;
  }

  // "1年以内"
  const withinMatch = rawVisibleText.match(/\n1年以内\n/);
  if (withinMatch) {
    return 0.5;
  }

  // "10年以上"
  const aboveMatch = rawVisibleText.match(/\n(\d+)年以上\n/);
  if (aboveMatch) {
    return parseInt(aboveMatch[1], 10);
  }

  // 普通年限：匹配 "\n\d+年\n"（注意排除年龄模式 "\d+岁"）
  const normalMatch = rawVisibleText.match(/\n(\d+)年\n/);
  if (normalMatch) {
    return parseInt(normalMatch[1], 10);
  }

  return null;
}

// ===== 字段路径解析 =====
function getFieldValue(obj, path) {
  return path.split('.').reduce((current, key) => {
    return current && current[key] !== undefined ? current[key] : null;
  }, obj);
}

// ===== 数组字段路径解析 =====
// 支持 "workExperience[].position" 格式：遍历数组，收集所有子字段值
function getFieldValues(obj, path) {
  const parts = path.split('.');
  let current = [obj];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '[]') {
      // 展开数组
      current = current.flatMap(item => Array.isArray(item) ? item : []);
    } else if (part.endsWith('[]')) {
      // "workExperience[]" 形式：取字段 + 展开数组
      const key = part.slice(0, -2);
      current = current
        .map(item => item && item[key] !== undefined ? item[key] : null)
        .flatMap(item => Array.isArray(item) ? item : []);
    } else {
      // 普通字段
      current = current.map(item => item && item[part] !== undefined ? item[part] : null);
    }
  }

  return current;
}

// ===== 智能字段解析（处理偏移问题） =====
function resolveField(candidate, fieldPath) {
  // 特殊路径：从 rawVisibleText 提取
  if (fieldPath === 'basicInfo.education') {
    const raw = candidate.rawVisibleText;
    const edu = resolveEducationFromRaw(raw);
    if (edu) return edu;
    // 回退到 basicInfo.education
    return candidate.basicInfo?.education || null;
  }

  if (fieldPath === 'basicInfo.workYears') {
    const raw = candidate.rawVisibleText;
    const years = resolveWorkYearsFromRaw(raw);
    if (years !== null) return `${years}年`;
    // 回退到 basicInfo.workYears
    return candidate.basicInfo?.workYears || null;
  }

  // resumeText 字段：直接返回简历全文（支持 contains/regex 等操作符匹配）
  if (fieldPath === 'resumeText') {
    return candidate.resumeText || null;
  }

  // 数组路径：返回所有值的数组
  if (fieldPath.includes('[]')) {
    return getFieldValues(candidate, fieldPath);
  }

  // 普通路径
  return getFieldValue(candidate, fieldPath);
}

// ===== 工作年限数值解析 =====
function parseWorkYears(value) {
  if (!value) return null;
  // "3年" → 3, "0.5年" → 0.5
  const match = String(value).match(/([\d.]+)年/);
  return match ? parseFloat(match[1]) : null;
}

// ===== 操作符比较 =====
function compareValues(actual, operator, expected, flags) {
  if (actual === null || actual === undefined) {
    if (operator === 'exists') return false;
    return false;
  }

  switch (operator) {
    case 'equals':
      return String(actual) === String(expected);

    case 'contains':
      if (Array.isArray(actual)) {
        return actual.some(item => String(item).includes(String(expected)));
      }
      return String(actual).includes(String(expected));

    case 'in':
      return Array.isArray(expected) && expected.includes(String(actual));

    case '>=':
      return compareOrdered(actual, expected) >= 0;

    case '>':
      return compareOrdered(actual, expected) > 0;

    case '<=':
      return compareOrdered(actual, expected) <= 0;

    case '<':
      return compareOrdered(actual, expected) < 0;

    case 'regex': {
      const reFlags = flags || '';
      try {
        const re = new RegExp(expected, reFlags);
        if (Array.isArray(actual)) {
          return actual.some(item => re.test(String(item)));
        }
        return re.test(String(actual));
      } catch {
        return false;
      }
    }

    case 'exists':
      return actual !== null && actual !== undefined && actual !== '';

    default:
      console.warn(`Unknown operator: ${operator}`);
      return false;
  }
}

function compareOrdered(actual, expected) {
  // 学历比较
  const eduRank = educationRank(actual);
  const eduExpectedRank = educationRank(expected);
  if (eduRank >= 0 && eduExpectedRank >= 0) {
    return eduRank - eduExpectedRank;
  }

  // 数值比较（工作年限等）
  const numActual = parseWorkYears(String(actual));
  const numExpected = parseWorkYears(String(expected));
  if (numActual !== null && numExpected !== null) {
    return numActual - numExpected;
  }

  // 字符串比较
  return String(actual).localeCompare(String(expected), 'zh-CN');
}

// ===== recommendationLevel 分档 =====
function getRecommendationLevel(score) {
  if (score >= 80) return 'strong';
  if (score >= 60) return 'good';
  if (score >= 40) return 'fair';
  return 'weak';
}

// ===== 单个候选人评分 =====
function scoreCandidate(candidate, rules) {
  const reasons = [];
  let passed = true;
  let rawScore = 0;
  let totalWeight = 0;

  // 1. exclude 检查（最高优先级）
  for (const rule of rules.exclude || []) {
    const actual = resolveField(candidate, rule.field);
    const result = compareValues(actual, rule.operator, rule.value, rule.flags);
    if (result === true) {
      reasons.push({
        rule: rule.reason,
        type: 'exclude',
        result: 'hit',
      });
      return {
        ...candidate,
        score: 0,
        passed: false,
        reasons,
        recommendationLevel: 'weak',
      };
    }
    reasons.push({
      rule: rule.reason,
      type: 'exclude',
      result: 'miss',
    });
  }

  // 2. mustHave 检查
  for (const rule of rules.mustHave || []) {
    const actual = resolveField(candidate, rule.field);
    const result = compareValues(actual, rule.operator, rule.value, rule.flags);
    if (result === false) {
      reasons.push({
        rule: rule.reason,
        type: 'mustHave',
        result: 'fail',
      });
      passed = false;
    } else {
      reasons.push({
        rule: rule.reason,
        type: 'mustHave',
        result: 'pass',
      });
    }
  }

  // mustHave 不通过则 score=0
  if (!passed) {
    return {
      ...candidate,
      score: 0,
      passed: false,
      reasons,
      recommendationLevel: 'weak',
    };
  }

  // 3. preferred 计算
  for (const rule of rules.preferred || []) {
    const actual = resolveField(candidate, rule.field);
    const result = compareValues(actual, rule.operator, rule.value, rule.flags);
    totalWeight += rule.weight || 0;

    if (result === true) {
      rawScore += rule.weight || 0;
      reasons.push({
        rule: rule.reason,
        type: 'preferred',
        result: 'pass',
        weight: rule.weight,
      });
    } else {
      reasons.push({
        rule: rule.reason,
        type: 'preferred',
        result: 'fail',
        weight: rule.weight,
      });
    }
  }

  // 4. 归一化分数
  // mustHave 全通过给 60 分基础分，preferred 在 60-100 之间加分
  // 无 preferred 规则时，mustHave 全通过给 100 分
  let score;
  if (!passed) {
    score = 0;
  } else if (totalWeight === 0) {
    score = 100;
  } else {
    const bonusRatio = rawScore / totalWeight; // 0~1
    score = Math.round(60 + bonusRatio * 40);
  }

  // 5. threshold 判定
  const threshold = rules.threshold ?? 60;
  const finalPassed = score >= threshold;

  return {
    ...candidate,
    score,
    passed: finalPassed,
    reasons,
    recommendationLevel: getRecommendationLevel(score),
  };
}

// ===== 默认评分（无筛选条件） =====
function scoreCandidateDefault(candidate) {
  // 从 rawVisibleText 解析学历和年限
  const raw = candidate.rawVisibleText;
  const education = resolveEducationFromRaw(raw) || candidate.basicInfo?.education || null;
  const workYearsStr = resolveWorkYearsFromRaw(raw) !== null
    ? `${resolveWorkYearsFromRaw(raw)}年`
    : candidate.basicInfo?.workYears || null;

  const educationScore = calcEducationScore(education);
  const workYearsScore = calcWorkYearsScore(workYearsStr);
  const baseScore = educationScore + workYearsScore;

  return {
    ...candidate,
    educationScore,
    workYearsScore,
    baseScore,
    score: baseScore, // 暂时只含基础分，LLM 岗位分后续补充
    passed: true, // 默认模式下全部通过
    reasons: [],
    recommendationLevel: getRecommendationLevel(baseScore),
  };
}

// ===== 主流程 =====
function main() {
  const opts = parseArgs();

  const candidates = JSON.parse(readFileSync(resolve(opts.input), 'utf-8'));
  const candidateList = candidates.candidates || candidates;

  let scoredCandidates;
  let output;

  if (opts.default) {
    // 默认评分模式
    scoredCandidates = candidateList.map(c => scoreCandidateDefault(c));
    scoredCandidates.sort((a, b) => b.score - a.score);

    output = {
      mode: 'default',
      position: opts.position || '',
      filteredAt: new Date().toISOString(),
      inputFile: resolve(opts.input),
      totalCandidates: scoredCandidates.length,
      candidates: scoredCandidates, // 保留全部候选人
    };
  } else {
    // 条件筛选模式（沿用现有逻辑）
    const rulesConfig = JSON.parse(readFileSync(resolve(opts.rules), 'utf-8'));
    const rules = rulesConfig.rules;

    scoredCandidates = candidateList.map(c => scoreCandidate(c, rules));
    scoredCandidates.sort((a, b) => b.score - a.score);
    const passedCandidates = scoredCandidates.filter(c => c.passed);

    output = {
      filterName: rulesConfig.name,
      filterVersion: rulesConfig.version,
      filteredAt: new Date().toISOString(),
      inputFile: resolve(opts.input),
      totalCandidates: scoredCandidates.length,
      passedCount: passedCandidates.length,
      threshold: rules.threshold ?? 60,
      candidates: passedCandidates,
    };
  }

  const outputPath = opts.output || resolve(dirname(resolve(opts.input)), 'scored-candidates.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  if (opts.default) {
    console.log(`Default scored ${scoredCandidates.length} candidates`);
  } else {
    console.log(`Scored ${scoredCandidates.length} candidates, ${output.passedCount} passed`);
  }
  console.log(`Output: ${outputPath}`);
}

// 只在直接执行时运行主流程（import 时不运行）
const isMainModule = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
if (isMainModule) {
  main();
}

export {
  parseArgs,
  educationRank,
  parseWorkYears,
  resolveEducationFromRaw,
  resolveWorkYearsFromRaw,
  getFieldValue,
  getFieldValues,
  resolveField,
  compareValues,
  compareOrdered,
  getRecommendationLevel,
  scoreCandidate,
  scoreCandidateDefault,
  calcEducationScore,
  calcWorkYearsScore,
  EDUCATION_ORDER,
  EDUCATION_SCORES,
};
