# 候选人筛选评分（纯脚本 v1） Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现基于规则配置的纯脚本候选人筛选评分系统，输出 scored-candidates.json

**Architecture:** Node.js ESM 脚本读取候选人 JSON + 规则配置 JSON，从 rawVisibleText 提取学历和工作年限（偏移修正），执行 exclude → mustHave → preferred 三级筛选，计算归一化分数，输出评分结果。脚本独立运行，不依赖浏览器逻辑，不引入 LLM。

**Tech Stack:** Node.js (ESM), 无外部依赖

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `scripts/score-candidates.mjs` | 新增 | 评分脚本，核心逻辑 |
| `config/filter-rules.json` | 新增 | 默认规则配置示例 |
| `SKILL.md` | 修改 | 新增候选人筛选评分章节 |

---

### Task 1: 创建评分脚本骨架 + rawVisibleText 字段解析器

**Files:**
- Create: `scripts/score-candidates.mjs`

- [ ] **Step 1: 创建评分脚本骨架**

创建 `scripts/score-candidates.mjs`，包含 CLI 参数解析、文件读取、rawVisibleText 字段解析器：

```javascript
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
      opts[key] = args[i + 1];
      i++;
    }
  }
  if (!opts.input || !opts.rules) {
    console.error('Usage: node score-candidates.mjs --input <file> --rules <file> [--output <file>]');
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

  // 数组路径：返回所有值的数组
  if (fieldPath.includes('[]')) {
    return getFieldValues(candidate, fieldPath);
  }

  // 普通路径
  return getFieldValue(candidate, fieldPath);
}

export {
  parseArgs,
  educationRank,
  resolveEducationFromRaw,
  resolveWorkYearsFromRaw,
  getFieldValue,
  getFieldValues,
  resolveField,
  EDUCATION_ORDER,
};
```

- [ ] **Step 2: 验证脚本可加载**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => console.log(Object.keys(m)))"`
Expected: 输出导出函数名列表

- [ ] **Step 3: 验证 rawVisibleText 解析**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => { const raw1='田信坤 \n刚刚活跃\n25岁\n3年\n本科\n 在线简历'; const raw2='林晓楠 \n24岁\n27年应届生\n硕士\n 在线简历'; const raw3='蒋林峰 \n22岁\n1年以内\n本科\n 在线简历'; const raw4='林波 \n刚刚活跃\n47岁\n10年以上\n硕士\n 在线简历'; console.log('田信坤 edu:', m.resolveEducationFromRaw(raw1), 'work:', m.resolveWorkYearsFromRaw(raw1)); console.log('林晓楠 edu:', m.resolveEducationFromRaw(raw2), 'work:', m.resolveWorkYearsFromRaw(raw2)); console.log('蒋林峰 edu:', m.resolveEducationFromRaw(raw3), 'work:', m.resolveWorkYearsFromRaw(raw3)); console.log('林波 edu:', m.resolveEducationFromRaw(raw4), 'work:', m.resolveWorkYearsFromRaw(raw4)); })"`
Expected: `田信坤 edu: 本科 work: 3`, `林晓楠 edu: 硕士 work: 0`, `蒋林峰 edu: 本科 work: 0.5`, `林波 edu: 硕士 work: 10`

- [ ] **Step 4: Commit**

```bash
git add scripts/score-candidates.mjs
git commit -m "feat: 评分脚本骨架 + rawVisibleText 字段解析器"
```

---

### Task 2: 实现操作符比较逻辑

**Files:**
- Modify: `scripts/score-candidates.mjs`

- [ ] **Step 1: 添加操作符比较函数**

在 `scripts/score-candidates.mjs` 的 `export` 语句前添加：

```javascript
// ===== 工作年限数值解析 =====
function parseWorkYears(value) {
  if (!value) return null;
  // "3年" → 3, "0.5年" → 0.5
  const match = String(value).match(/([\d.]+)年/);
  return match ? parseFloat(match[1]) : null;
}

// ===== 操作符比较 =====
function compareValues(actual, operator, expected) {
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

    case 'regex':
      try {
        return new RegExp(expected).test(String(actual));
      } catch {
        return false;
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
```

更新导出列表：

```javascript
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
  EDUCATION_ORDER,
};
```

- [ ] **Step 2: 验证操作符逻辑**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => console.log('edu>=:', m.compareValues('本科', '>=', '大专'), 'work>=:', m.compareValues('3年', '>=', '2年'), 'city=:', m.compareValues('深圳', 'equals', '深圳'), 'contains:', m.compareValues('java开发工程师', 'contains', 'Java'), 'in:', m.compareValues('大专', 'in', ['高中','中专','大专'])))"`
Expected: `edu>=: true work>=: true city=: true contains: true in: true`

- [ ] **Step 3: 验证数组 contains 匹配**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => console.log('array contains:', m.compareValues(['java开发工程师', 'Java'], 'contains', 'Java'), 'array no match:', m.compareValues(['前端开发工程师', 'Python'], 'contains', 'Java')))"`
Expected: `array contains: true array no match: false`

- [ ] **Step 4: Commit**

```bash
git add scripts/score-candidates.mjs
git commit -m "feat: 实现操作符比较逻辑（equals/contains/in/>=/regex/exists）"
```

---

### Task 3: 实现评分主流程

**Files:**
- Modify: `scripts/score-candidates.mjs`

- [ ] **Step 1: 添加评分函数和主流程**

在 `scripts/score-candidates.mjs` 中添加评分核心逻辑（在 `export` 语句前）：

```javascript
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
    const result = compareValues(actual, rule.operator, rule.value);
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
    const result = compareValues(actual, rule.operator, rule.value);
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
    const result = compareValues(actual, rule.operator, rule.value);
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
  const score = totalWeight > 0 ? Math.round((rawScore / totalWeight) * 100) : 0;

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

// ===== 主流程 =====
function main() {
  const opts = parseArgs();

  // 读取输入
  const candidates = JSON.parse(readFileSync(resolve(opts.input), 'utf-8'));
  const rulesConfig = JSON.parse(readFileSync(resolve(opts.rules), 'utf-8'));

  const candidateList = candidates.candidates || candidates;
  const rules = rulesConfig.rules;

  // 评分
  const scoredCandidates = candidateList.map(c => scoreCandidate(c, rules));

  // 按 score 降序排列
  scoredCandidates.sort((a, b) => b.score - a.score);

  // 统计
  const passedCount = scoredCandidates.filter(c => c.passed).length;

  const output = {
    filterName: rulesConfig.name,
    filterVersion: rulesConfig.version,
    filteredAt: new Date().toISOString(),
    inputFile: resolve(opts.input),
    totalCandidates: scoredCandidates.length,
    passedCount,
    threshold: rules.threshold ?? 60,
    candidates: scoredCandidates,
  };

  // 输出
  const outputPath = opts.output || resolve(dirname(resolve(opts.input)), 'scored-candidates.json');
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');

  console.log(`Scored ${scoredCandidates.length} candidates, ${passedCount} passed`);
  console.log(`Output: ${outputPath}`);
}

main();
```

更新导出列表，添加 `scoreCandidate` 和 `getRecommendationLevel`：

```javascript
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
  EDUCATION_ORDER,
};
```

- [ ] **Step 2: 验证主流程可执行（缺少参数时应报错）**

Run: `node scripts/score-candidates.mjs 2>&1 || true`
Expected: 输出 usage 信息

- [ ] **Step 3: Commit**

```bash
git add scripts/score-candidates.mjs
git commit -m "feat: 实现评分主流程（exclude/mustHave/preferred 三级筛选 + 归一化分数）"
```

---

### Task 4: 创建默认规则配置

**Files:**
- Create: `config/filter-rules.json`

- [ ] **Step 1: 创建规则配置文件**

创建 `config/filter-rules.json`：

```json
{
  "name": "AI应用开发工程师-初筛",
  "version": "1.0",
  "rules": {
    "mustHave": [
      {
        "field": "basicInfo.education",
        "operator": ">=",
        "value": "本科",
        "reason": "学历要求本科及以上"
      }
    ],
    "preferred": [
      {
        "field": "basicInfo.workYears",
        "operator": ">=",
        "value": "2年",
        "weight": 20,
        "reason": "2年以上工作经验加分"
      },
      {
        "field": "positionInfo.expectCity",
        "operator": "equals",
        "value": "深圳",
        "weight": 10,
        "reason": "期望城市匹配加分"
      },
      {
        "field": "workExperience[].position",
        "operator": "contains",
        "value": "Java",
        "weight": 15,
        "reason": "Java经验加分"
      }
    ],
    "exclude": [
      {
        "field": "basicInfo.education",
        "operator": "in",
        "value": ["高中", "中专", "初中"],
        "reason": "学历不符合最低要求"
      }
    ],
    "threshold": 60
  }
}
```

- [ ] **Step 2: 端到端测试**

Run: `node scripts/score-candidates.mjs --input output/zhipin-candidates.json --rules config/filter-rules.json --output output/scored-candidates.json`
Expected: 输出评分统计，`output/scored-candidates.json` 生成

- [ ] **Step 3: 检查输出格式**

Run: `node -e "const d=require('./output/scored-candidates.json'); console.log('total:', d.totalCandidates, 'passed:', d.passedCount, 'threshold:', d.threshold); d.candidates.slice(0,3).forEach(c => console.log(c.basicInfo?.name||c.name, 'score:', c.score, 'passed:', c.passed, 'level:', c.recommendationLevel))"`
Expected: 显示候选人评分结果

- [ ] **Step 4: Commit**

```bash
git add config/filter-rules.json
git commit -m "feat: 添加默认筛选规则配置（AI应用开发工程师初筛）"
```

---

### Task 5: 更新 SKILL.md 添加筛选评分章节

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: 在 SKILL.md 的「提取结果持久化」章节后添加筛选评分章节**

在 `## 提取结果持久化` 章节之后、`## 站点经验` 章节之前，添加：

```markdown
## 候选人筛选评分

当用户在对话中描述筛选条件时（如"按本科+2年经验筛选候选人"），执行筛选评分流程。

### 流程

1. 根据用户描述，生成或更新 `config/filter-rules.json`
2. 执行评分脚本：
   ```bash
   node scripts/score-candidates.mjs \
     --input output/zhipin-candidates.json \
     --rules config/filter-rules.json \
     --output output/scored-candidates.json
   ```
3. 向用户展示筛选结果摘要

### 规则配置

规则存放在 `config/filter-rules.json`，包含三类规则：

- **exclude**：命中任一即否决（score=0, passed=false）
- **mustHave**：全部满足才进入评分，否则 passed=false
- **preferred**：加分项，满足加 weight，不满足不扣分

分数归一化到 0-100：`score = (满足的 weight 之和 / 所有 preferred 的 weight 之和) * 100`

### 操作符

| 操作符 | 说明 |
|--------|------|
| `equals` | 精确匹配 |
| `contains` | 包含匹配 |
| `in` | 值在列表中 |
| `>=` / `>` / `<=` / `<` | 比较（支持学历排序、年限数值） |
| `regex` | 正则匹配 |
| `exists` | 字段存在 |

### 字段解析

- **学历/工作年限**：从 `rawVisibleText` 提取（避免 basicInfo 偏移问题）
- **数组字段**：`workExperience[].position` 遍历数组，任一匹配即满足
- **学历排序**：高中 < 中专 < 大专 < 本科 < 硕士 < 博士
- **工作年限**：从 "3年" 提取数字 3，应届生为 0，"1年以内"为 0.5，"10年以上"为 10
```

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs: SKILL.md 新增候选人筛选评分章节"
```

---

### Task 6: 端到端验证 + 边界情况测试

**Files:**
- None (validation only)

- [ ] **Step 1: 验证 exclude 规则生效**

Run: `node -e "const d=require('./output/scored-candidates.json'); const excluded=d.candidates.filter(c=>!c.passed&&c.reasons.some(r=>r.type==='exclude'&&r.result==='hit')); console.log('Excluded by exclude rule:', excluded.length); excluded.forEach(c=>console.log(c.basicInfo?.name||c.name))"`
Expected: 显示被 exclude 规则排除的候选人（如郑代辉，大专）

- [ ] **Step 2: 验证 mustHave 规则生效**

Run: `node -e "const d=require('./output/scored-candidates.json'); const failed=d.candidates.filter(c=>!c.passed&&c.reasons.some(r=>r.type==='mustHave'&&r.result==='fail')); console.log('MustHave failed:', failed.length); failed.forEach(c=>console.log(c.basicInfo?.name||c.name))"`
Expected: 显示 mustHave 不通过的候选人

- [ ] **Step 3: 验证评分排序和归一化**

Run: `node -e "const d=require('./output/scored-candidates.json'); const passed=d.candidates.filter(c=>c.passed); console.log('Passed candidates (sorted by score):'); passed.forEach(c=>console.log(c.basicInfo?.name||c.name, 'score:', c.score, 'level:', c.recommendationLevel))"`
Expected: 按分数降序显示通过的候选人

- [ ] **Step 4: 验证 rawVisibleText 偏移修正**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => { const c={rawVisibleText:'林晓楠 \n24岁\n27年应届生\n硕士\n 在线简历',basicInfo:{name:'林晓楠',age:'24岁',education:'硕士',workYears:'27年应届生'}}; console.log('education:', m.resolveField(c, 'basicInfo.education'), 'workYears:', m.resolveField(c, 'basicInfo.workYears')) })"`
Expected: `education: 硕士 workYears: 0年`

- [ ] **Step 5: 验证数组字段匹配**

Run: `node -e "import('./scripts/score-candidates.mjs').then(m => { const c={rawVisibleText:'test\n本科\n',workExperience:[{position:'java开发工程师'},{position:'Java'}]}; console.log('positions:', m.resolveField(c, 'workExperience[].position'), 'contains Java:', m.compareValues(m.resolveField(c, 'workExperience[].position'), 'contains', 'Java')) })"`
Expected: `positions: [ 'java开发工程师', 'Java' ] contains Java: true`

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: 评分脚本边界情况修复"
```
