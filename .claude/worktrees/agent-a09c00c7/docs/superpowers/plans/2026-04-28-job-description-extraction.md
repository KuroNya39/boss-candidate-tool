# 岗位描述（JD）提取与评分集成 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在候选人提取时同时提取岗位描述（JD），同一岗位只提取一次，LLM评分时用JD+简历替代仅用岗位名称。

**Architecture:** 在 extract-candidates-full.mjs 中新增 extractJobDescription 函数，提取基础信息后调用，用 Map 缓存去重。export-candidates.mjs 新增JD列。SKILL.md 更新LLM评分prompt。

**Tech Stack:** Node.js ESM, CDP Proxy API

---

### Task 1: extract-candidates-full.mjs 新增 JD 提取功能

**Files:**
- Modify: `scripts/extract-candidates-full.mjs`

- [ ] **Step 1: 添加 extractJobDescription 函数**

在 `EXTRACT_BASIC_INFO_SCRIPT` 常量之后、`clickOnlineResume` 函数之前，添加：

```javascript
// ===== 岗位描述提取 =====

async function extractJobDescription(targetId) {
  // 点击岗位名称
  const clickResult = await cdpEval(targetId, `(function(){
    var nameEl = document.querySelector('.position-name');
    if (!nameEl) return 'not-found';
    nameEl.click();
    return 'clicked';
  })()`);
  if (clickResult === 'not-found') return null;

  // 等待弹窗出现
  await randomDelay(1000, 1500);

  // 提取岗位描述
  const detail = await cdpEval(targetId, `(function(){
    var dialog = document.querySelector('.job-details-dialog');
    if (!dialog) return JSON.stringify(null);
    var info = {};
    try {
      var nameEl = dialog.querySelector('.name');
      if (nameEl) info.jobName = nameEl.textContent.trim();
    } catch(e) {}
    try {
      var salaryEl = dialog.querySelector('.salary');
      if (salaryEl) info.salary = salaryEl.textContent.trim();
    } catch(e) {}
    try {
      var detailContent = dialog.querySelector('.job-detail-content')
        || dialog.querySelector('.detail-content')
        || dialog.querySelector('.job-sec');
      if (detailContent) info.description = detailContent.textContent.trim();
      else info.description = dialog.textContent.trim();
    } catch(e) {}
    try {
      var tags = dialog.querySelectorAll('.job-tags span, .tag-list span');
      if (tags.length) info.tags = Array.from(tags).map(function(t){return t.textContent.trim()});
    } catch(e) {}
    return JSON.stringify(info);
  })()`);

  // 关闭弹窗
  await cdpEval(targetId, `(function(){
    var closeBtn = document.querySelector('.job-details-dialog .boss-popup__close');
    if (closeBtn) closeBtn.click();
  })()`);
  await randomDelay(500, 800);

  try {
    return JSON.parse(detail);
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: 在主流程中添加 JD 提取（带缓存）**

在主流程的候选人处理循环中，提取基础信息之后、打开在线简历之前，添加 JD 提取逻辑。

在 `// 3. 提取在线简历` 注释之前插入：

```javascript
        // 2.5 提取岗位描述（同一岗位只提取一次）
        const appliedJob = candidateData.positionInfo?.appliedJob || '';
        if (appliedJob && jobDescCache.has(appliedJob)) {
          candidateData.jobDescription = jobDescCache.get(appliedJob);
          console.log(`  ✓ 岗位描述(缓存): ${appliedJob}`);
        } else if (appliedJob) {
          console.log('  → 提取岗位描述...');
          try {
            const jd = await extractJobDescription(targetId);
            if (jd) {
              candidateData.jobDescription = jd;
              jobDescCache.set(appliedJob, jd);
              console.log(`  ✓ 岗位描述: ${jd.jobName || appliedJob}`);
            } else {
              console.log('  ℹ 未找到岗位描述弹窗');
            }
          } catch (e) {
            console.warn(`  ⚠ 岗位描述提取失败: ${e.message}`);
          }
        }
```

- [ ] **Step 3: 初始化缓存 Map**

在主流程的候选人处理循环之前（`for (let i = 0; i < toProcess.length; i++)` 之前），添加：

```javascript
  // 岗位描述缓存（同一岗位只提取一次）
  const jobDescCache = new Map();
```

- [ ] **Step 4: 验证脚本可运行**

```bash
node scripts/extract-candidates-full.mjs --count 3 --output output/test-jd.json
```

Expected: 每个候选人数据中包含 `jobDescription` 字段，相同岗位的候选人共享缓存。

- [ ] **Step 5: Commit**

```bash
git add scripts/extract-candidates-full.mjs
git commit -m "feat: 提取候选人时同时提取岗位描述(JD)，同一岗位缓存复用"
```

---

### Task 2: export-candidates.mjs 新增 JD 列

**Files:**
- Modify: `scripts/export-candidates.mjs`

- [ ] **Step 1: 在 FIELD_CONFIG 中添加 jobDescription 字段**

在 `jobRelevanceComment` 之后添加：

```javascript
  jobDescription: {
    header: '岗位描述',
    extract: (c) => {
      const jd = c.jobDescription;
      if (!jd) return '';
      const desc = jd.description || '';
      // 截断到前100字
      return desc.length > 100 ? desc.substring(0, 100) + '...' : desc;
    },
  },
```

- [ ] **Step 2: 更新 DEFAULT_FIELDS 数组**

在 `jobRelevanceComment` 之后添加 `'jobDescription'`：

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
  'jobDescription',
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

- [ ] **Step 3: 验证导出**

```bash
node scripts/export-candidates.mjs --input output/test-jd.json
```

Expected: Excel 包含"岗位描述"列。

- [ ] **Step 4: Commit**

```bash
git add scripts/export-candidates.mjs
git commit -m "feat: Excel导出新增岗位描述列"
```

---

### Task 3: 更新 SKILL.md LLM 评分 prompt

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: 更新 LLM 岗位相关性评分步骤**

将 SKILL.md 中第3步的 prompt 替换为区分有JD/无JD的版本：

```markdown
3. **LLM 岗位相关性评分**：读取 `output/scored-candidates.json`，注意候选人列表在 `d.candidates` 字段中（不是 `d` 本身）。逐个阅读候选人的 `resumeText`，使用以下 prompt 评分：

   **有岗位描述时**（候选人数据中有 `jobDescription.description`）：
   ```
   你是一位技术招聘专家。请根据以下岗位描述和候选人简历，评估其与目标岗位的匹配度。

   岗位描述：
   {jobDescription.description}

   候选人简历：
   {resumeText}

   请给出：
   1. 岗位相关性分数（0-50分）：基于技术栈匹配度、项目经验相关性、行业经验等
   2. 简短评语（一句话）：说明评分理由

   请严格按以下 JSON 格式输出：
   {"jobRelevanceScore": <0-50>, "jobRelevanceComment": "<评语>"}
   ```

   **无岗位描述时**（仅有岗位名称）：
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
```

- [ ] **Step 2: Commit**

```bash
git add SKILL.md
git commit -m "docs: SKILL.md 更新LLM评分prompt支持JD输入"
```

---

### Task 4: 端到端验证

**Files:**
- None (验证任务)

- [ ] **Step 1: 提取3个候选人，验证JD提取和缓存**

```bash
node scripts/extract-candidates-full.mjs --count 3 --output output/test-jd-e2e.json
```

验证：
- 每个候选人有 `jobDescription` 字段
- 相同岗位的候选人 JD 内容一致（缓存命中）

- [ ] **Step 2: 导出 Excel 验证新列**

```bash
node scripts/export-candidates.mjs --input output/test-jd-e2e.json
```

验证：Excel 包含"岗位描述"列，内容截断到100字。

- [ ] **Step 3: Commit（如有修复）**
