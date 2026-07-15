# 候选人评分系统 V2 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为候选人评分系统新增默认评分模式（学历+年限+LLM岗位相关性），支持无筛选条件时全量评分排序。

**Architecture:** 在现有 `score-candidates.mjs` 基础上新增 `--default` 模式，内置学历/年限评分逻辑；`export-candidates.mjs` 新增分维度列；SKILL.md 更新流程文档供 Claude Code 编排 LLM 评分。

**Tech Stack:** Node.js ESM, xlsx 库, Claude API（对话中调用）

---

### Task 1: score-candidates.mjs 新增默认评分函数

**Files:**
- Modify: `scripts/score-candidates.mjs`

- [ ] **Step 1: 添加学历分计算函数**

在 `EDUCATION_ORDER` 常量之后，添加学历分映射和计算函数：

```javascript
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
```

- [ ] **Step 2: 添加工作年限分计算函数**

在学历分函数之后添加：

```javascript
// ===== 工作年限分计算 =====
function calcWorkYearsScore(workYearsStr) {
  const years = parseWorkYears(workYearsStr);
  if (years === null) return 0;
  // 应届生额外 +3
  const isFresh = /应届/.test(workYearsStr || '');
  const base = Math.min(years * 3, 30);
  return isFresh ? base + 3 : base;
}
```

- [ ] **Step 3: 添加默认评分主函数**

在 `scoreCandidate` 函数之后添加：

```javascript
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
```

- [ ] **Step 4: 修改 parseArgs 支持 --default 和 --position**

修改 `parseArgs` 函数，将 `default` 和 `position` 作为布尔/字符串参数处理：

```javascript
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
```

- [ ] **Step 5: 修改 main 函数支持默认模式**

在 `main` 函数中，根据 `opts.default` 分支处理：

```javascript
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
```

- [ ] **Step 6: 更新 export 列表**

在文件末尾的 `export` 块中添加新函数：

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
  scoreCandidateDefault,
  calcEducationScore,
  calcWorkYearsScore,
  EDUCATION_ORDER,
  EDUCATION_SCORES,
};
```

- [ ] **Step 7: 验证脚本可运行**

```bash
node scripts/score-candidates.mjs --input output/zhipin-candidates.json --default --position "AI应用开发工程师"
```

Expected: 输出 `Default scored N candidates`，生成的 JSON 中每个候选人含 `educationScore`、`workYearsScore`、`baseScore` 字段，`passed` 全部为 `true`。

- [ ] **Step 8: Commit**

```bash
git add scripts/score-candidates.mjs
git commit -m "feat: score-candidates 新增 --default 默认评分模式"
```

---

### Task 2: export-candidates.mjs 新增分维度列

**Files:**
- Modify: `scripts/export-candidates.mjs`

- [ ] **Step 1: 在 FIELD_CONFIG 中添加新字段**

在 `FIELD_CONFIG` 对象中添加以下字段（在 `education` 之后）：

```javascript
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
    header: '岗位评语',
    extract: (c) => c.jobRelevanceComment || '',
  },
```

- [ ] **Step 2: 更新 DEFAULT_FIELDS 数组**

替换 `DEFAULT_FIELDS` 为：

```javascript
const DEFAULT_FIELDS = [
  'name',
  'age',
  'workYears',
  'school',
  'education',
  'educationScore',
  'workYearsScore',
  'jobRelevanceScore',
  'jobRelevanceComment',
  'score',
  'passed',
  'recommendationLevel',
  'currentPosition',
  'currentCompany',
  'expectCity',
  'expectSalary',
  'recommendationReasons',
];
```

- [ ] **Step 3: 修改 passed 列提取逻辑，支持默认模式**

修改 `passed` 字段的 extract 函数：

```javascript
  passed: {
    header: '是否通过',
    extract: (c) => {
      // 默认评分模式下 passed 可能为 true 但无实际筛选意义，显示 '-'
      if (c._defaultMode) return '-';
      return c.passed ? '是' : '否';
    },
  },
```

- [ ] **Step 4: 在 transformCandidates 中传入模式标记**

修改 `transformCandidates` 函数，接受 `mode` 参数：

```javascript
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
```

- [ ] **Step 5: 修改 main 函数传递 mode**

在 `main` 函数中，读取输入后判断模式并传递：

```javascript
function main() {
  const opts = parseArgs();

  const inputPath = resolve(opts.input);
  const input = JSON.parse(readFileSync(inputPath, 'utf-8'));
  const candidates = input.candidates || input;

  const fields = opts.fields
    ? opts.fields.split(',').map(f => f.trim())
    : DEFAULT_FIELDS;

  const mode = input.mode === 'default' ? 'default' : 'filter';
  const data = transformCandidates(candidates, fields, mode);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);

  autoColumnWidth(ws, data);

  XLSX.utils.book_append_sheet(wb, ws, '候选人');

  const outputDir = dirname(inputPath);
  const outputPath = opts.output || resolve(outputDir, 'candidates.xlsx');
  mkdirSync(dirname(outputPath), { recursive: true });

  XLSX.writeFile(wb, outputPath);

  console.log(`导出成功: ${outputPath}`);
  console.log(`共导出 ${candidates.length} 条记录`);

  if (input.totalCandidates && input.passedCount) {
    console.log(`筛选规则: ${input.filterName || '未知'} (v${input.filterVersion || '?'})`);
    console.log(`通过率: ${input.passedCount}/${input.totalCandidates} (${Math.round(input.passedCount / input.totalCandidates * 100)}%)`);
  } else if (input.mode === 'default') {
    console.log(`评分模式: 默认评分 (全量)`);
  }
}
```

- [ ] **Step 6: 验证导出**

```bash
node scripts/export-candidates.mjs --input output/scored-candidates.json
```

Expected: Excel 文件包含新列（学历分、年限分、岗位相关性分、岗位评语），默认模式下"是否通过"列显示"-"。

- [ ] **Step 7: Commit**

```bash
git add scripts/export-candidates.mjs
git commit -m "feat: export-candidates 新增分维度列和默认模式支持"
```

---

### Task 3: 更新 SKILL.md 文档

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: 重写候选人筛选评分章节**

将 SKILL.md 中的 `## 候选人筛选评分` 章节替换为以下内容：

```markdown
## 候选人评分

当用户要求对候选人评分或筛选时，**自动完成以下全部步骤**，无需用户手动运行脚本。

### 两种模式

- **默认评分**：用户未给筛选条件（如"帮我评分"、"给这些候选人打分"）
- **条件筛选**：用户给了筛选条件（如"帮我筛选本科以上、2年经验的"）

### 默认评分流程

评分维度：**总分 = 学历分(0-20) + 工作年限分(0-30) + 岗位相关性分(0-50)**

1. **确定目标岗位**：优先用户指定（如"按AI应用开发岗位评分"），否则从候选人数据的 `positionInfo.appliedJob` 提取
2. **运行默认评分脚本**：
   ```bash
   node scripts/score-candidates.mjs \
     --default \
     --position "目标岗位名称" \
     --input output/zhipin-candidates.json \
     --output output/scored-candidates.json
   ```
3. **LLM 岗位相关性评分**：逐个阅读候选人的 `resumeText`，使用以下 prompt 评分：
   ```
   你是一位技术招聘专家。请根据以下候选人简历，评估其与目标岗位的匹配度。

   目标岗位：{positionName}

   候选人简历：
   {resumeText}

   请给出：
   1. 岗位相关性分数（0-50分）：基于技术栈匹配度、项目经验相关性、行业经验等
   2. 简短评语（一句话）：说明评分理由

   请严格按以下 JSON 格式输出：
   {"jobRelevanceScore": <0-50>, "jobRelevanceComment": "<评语>"}
   ```
   - 无 `resumeText` 的候选人：`jobRelevanceScore = 0`，`jobRelevanceComment = "无在线简历"`
   - 每评完 5 人，将结果写入 `output/scored-candidates.json`（防丢失）
   - 每评完 5 人，向用户报告进度
4. **合并总分**：`totalScore = educationScore + workYearsScore + jobRelevanceScore`，更新 JSON 中每个候选人的 `score` 和 `recommendationLevel`
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **展示结果摘要**：向用户展示 Top 候选人列表（姓名、总分、各维度分、评语）、Excel 文件路径

### 条件筛选流程

1. **生成规则配置**：根据用户描述的筛选条件，生成或更新 `config/filter-rules.json`
2. **运行评分脚本**：
   ```bash
   node scripts/score-candidates.mjs \
     --input output/zhipin-candidates.json \
     --rules config/filter-rules.json \
     --output output/scored-candidates.json
   ```
3. **LLM 岗位相关性评分**：同默认评分流程第 3 步
4. **合并总分**：同默认评分流程第 4 步
5. **导出 Excel**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
6. **展示结果摘要**：向用户展示通过/未通过人数、Top 候选人列表、Excel 文件路径

### 评分规则

#### 学历分（0-20）

| 学历 | 分数 |
|------|------|
| 博士 | 20 |
| 硕士 | 17 |
| 本科 | 14 |
| 大专 | 8 |
| 中专/高中 | 4 |
| 未知 | 0 |

#### 工作年限分（0-30）

- 公式：`min(years * 3, 30)`
- 应届生额外 +3 分

#### 岗位相关性分（0-50）

- LLM 阅读简历文本评估，基于技术栈匹配度、项目经验相关性、行业经验
- 无在线简历的候选人：0 分

### 规则配置（条件筛选模式）

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

| `resumeText` | 简历全文搜索 |

### 用户描述到规则的映射示例

| 用户说 | 规则 |
|--------|------|
| "本科以上" | mustHave: `basicInfo.education` >= "本科" |
| "不要大专及以下" | exclude: `basicInfo.education` in ["高中","中专","大专"] |
| "2年经验优先" | preferred: `basicInfo.workYears` >= "2年", weight=20 |
| "有Java经验" | preferred: `workExperience[].position` contains "Java", weight=15 |
| "期望深圳" | preferred: `positionInfo.expectCity` equals "深圳", weight=10 |
| "有支付相关经验" | preferred: `workExperience[].position` contains "支付", weight=15 |
| "985/211优先" | preferred: `resumeText` regex "985\|211", weight=15 |
| "简历中有Python" | preferred: `resumeText` contains "Python", weight=10 |
```

- [ ] **Step 2: 验证 SKILL.md 格式正确**

快速浏览 SKILL.md 确认 markdown 格式、缩进、代码块无误。

- [ ] **Step 3: Commit**

```bash
git add SKILL.md
git commit -m "docs: SKILL.md 更新候选人评分章节，支持默认评分和条件筛选两种模式"
```

---

### Task 4: 端到端验证

**Files:**
- None (验证任务)

- [ ] **Step 1: 运行默认评分**

```bash
node scripts/score-candidates.mjs --default --position "AI应用开发工程师" --input output/zhipin-candidates.json --output output/scored-candidates.json
```

Expected: 所有候选人被评分，`passed` 全部为 `true`，含 `educationScore`、`workYearsScore`、`baseScore` 字段。

- [ ] **Step 2: 检查输出 JSON 结构**

```bash
node -e "const d=JSON.parse(require('fs').readFileSync('output/scored-candidates.json','utf8')); console.log('mode:', d.mode); console.log('position:', d.position); console.log('total:', d.totalCandidates); const c=d.candidates[0]; console.log('sample:', {name:c.basicInfo?.name, educationScore:c.educationScore, workYearsScore:c.workYearsScore, baseScore:c.baseScore, score:c.score, passed:c.passed})"
```

Expected: `mode: default`, `position: AI应用开发工程师`, 各分数字段有值。

- [ ] **Step 3: 运行条件筛选（回归测试）**

```bash
node scripts/score-candidates.mjs --input output/zhipin-candidates.json --rules config/filter-rules.json --output output/scored-candidates.json
```

Expected: 沿用现有逻辑，输出 passed/未通过 候选人。

- [ ] **Step 4: 导出 Excel**

```bash
node scripts/export-candidates.mjs --input output/scored-candidates.json
```

Expected: Excel 包含新列，默认模式下"是否通过"列显示"-"。

- [ ] **Step 5: Commit（如有修复）**

如有任何修复，提交。
