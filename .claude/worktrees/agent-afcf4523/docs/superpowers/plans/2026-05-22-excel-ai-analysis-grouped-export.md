# Excel AI 分析分组表头 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将候选人 Excel 导出格式改为两组大列：`AI分析` 和 `附加信息`，并把 0-100 总分转换为一星到五星的 AI 评级。

**Architecture:** 改动集中在 `scripts/export-candidates.mjs`。新增 `aiRating` 字段和分组表头生成函数；导出时使用两行表头和 Excel merge 配置实现大列分组，保留现有按岗位分 sheet 的逻辑。

**Tech Stack:** Node.js ESM, xlsx

---

## File Structure

- Modify: `scripts/export-candidates.mjs`
  - `FIELD_CONFIG`：新增 `aiRating` 字段，将 `totalScore ?? score` 映射为一星到五星。
  - `DEFAULT_FIELDS`：改为 `name, aiRating, jobRelevanceComment, age, school, education, workYears, resumeText`。
  - Add `buildGroupedExportData(candidates, fields, mode)`：生成两行表头 + 数据行。
  - Add `applyGroupedHeaders(ws)`：设置 `!merges`，将 A1:C1 合并为 `AI分析`，D1:H1 合并为 `附加信息`。
  - Update export loop：从 `transformCandidates` 切换为 `buildGroupedExportData`。

---

### Task 1: 写失败验证：Excel 表头分组与 AI 评级

**Files:**
- Test via inline Node command, no new test file required.
- Modify later: `scripts/export-candidates.mjs`

- [ ] **Step 1: Run failing verification before implementation**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const X = require('xlsx');
const input = 'tmp/export-grouped-header-input.json';
const output = 'tmp/export-grouped-header-output.xlsx';
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync(input, JSON.stringify({ mode: 'default', candidates: [
  {
    basicInfo: { name: '张三', age: '25', education: '本科', workYears: '3年' },
    educationExperience: [{ school: '清华大学' }],
    positionInfo: { appliedJob: 'AI工程师' },
    totalScore: 85,
    jobRelevanceComment: '技术栈匹配：好 | 项目经验相关性：好 | 行业经验：好',
    resumeText: '在线简历内容'
  }
] }, null, 2));
cp.execFileSync(process.execPath, ['scripts/export-candidates.mjs', '--input', input, '--output', output], { stdio: 'pipe' });
const wb = X.readFile(output);
const ws = wb.Sheets['AI工程师'];
const value = (addr) => ws[addr] && ws[addr].v;
const merges = (ws['!merges'] || []).map(m => `${m.s.r},${m.s.c}:${m.e.r},${m.e.c}`);
const expectedHeaders = {
  A1: 'AI分析', B1: undefined, C1: undefined,
  D1: '附加信息', E1: undefined, F1: undefined, G1: undefined, H1: undefined,
  A2: '姓名', B2: 'AI评级', C2: 'AI评级理由',
  D2: '年龄', E2: '学校', F2: '学历', G2: '工作年限', H2: '在线简历',
  A3: '张三', B3: '五星', C3: '技术栈匹配：好 | 项目经验相关性：好 | 行业经验：好',
  D3: '25', E3: '清华大学', F3: '本科', G3: '3年', H3: '在线简历内容'
};
for (const [addr, expected] of Object.entries(expectedHeaders)) {
  if (value(addr) !== expected) throw new Error(`${addr}: expected ${expected}, got ${value(addr)}`);
}
if (!merges.includes('0,0:0,2')) throw new Error(`missing AI分析 merge, got ${JSON.stringify(merges)}`);
if (!merges.includes('0,3:0,7')) throw new Error(`missing 附加信息 merge, got ${JSON.stringify(merges)}`);
console.log('grouped header export verification passed');
NODE
```

Expected before implementation: FAIL because current workbook has only one header row and no merged `AI分析` / `附加信息` headers.

---

### Task 2: 新增 AI 评级字段和默认导出字段

**Files:**
- Modify: `scripts/export-candidates.mjs:42-155`

- [ ] **Step 1: Add score-to-rating helper above FIELD_CONFIG**

Add before `const FIELD_CONFIG = {`:

```javascript
function toAiRating(candidate) {
  const score = candidate.totalScore ?? candidate.score ?? 0;
  if (score >= 80) return '五星';
  if (score >= 60) return '四星';
  if (score >= 40) return '三星';
  if (score >= 20) return '二星';
  return '一星';
}
```

- [ ] **Step 2: Add `aiRating` to FIELD_CONFIG**

Add after `name`:

```javascript
  aiRating: {
    header: 'AI评级',
    extract: (c) => toAiRating(c),
  },
```

- [ ] **Step 3: Rename comment field header**

Change `jobRelevanceComment.header` from:

```javascript
header: '评语',
```

to:

```javascript
header: 'AI评级理由',
```

- [ ] **Step 4: Replace DEFAULT_FIELDS**

Replace current `DEFAULT_FIELDS` with:

```javascript
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
```

---

### Task 3: 添加两行分组表头生成逻辑

**Files:**
- Modify: `scripts/export-candidates.mjs:157-171`

- [ ] **Step 1: Add grouped export data function after transformCandidates**

Add after `transformCandidates`:

```javascript
function buildGroupedExportData(candidates, fields, mode = 'filter') {
  const data = transformCandidates(candidates, fields, mode);
  const headers = data[0];
  const rows = data.slice(1);
  const groupHeaders = fields.map((_, index) => {
    if (index === 0) return 'AI分析';
    if (index === 3) return '附加信息';
    return '';
  });
  return [groupHeaders, headers, ...rows];
}
```

- [ ] **Step 2: Add merge helper after safeSheetName**

Add after `safeSheetName`:

```javascript
function applyGroupedHeaders(ws) {
  ws['!merges'] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } },
    { s: { r: 0, c: 3 }, e: { r: 0, c: 7 } },
  ];
}
```

---

### Task 4: 在导出循环中使用分组表头

**Files:**
- Modify: `scripts/export-candidates.mjs:241-260`

- [ ] **Step 1: Replace per-group sheet data creation**

Change inside the `for (const [position, groupCandidates] of positionGroups)` loop from:

```javascript
const groupData = transformCandidates(groupCandidates, fields, mode);
const ws = XLSX.utils.aoa_to_sheet(groupData);
autoColumnWidth(ws, groupData, fields);

const sheetName = safeSheetName(position);
XLSX.utils.book_append_sheet(wb, ws, sheetName);
```

to:

```javascript
const groupData = buildGroupedExportData(groupCandidates, fields, mode);
const ws = XLSX.utils.aoa_to_sheet(groupData);
autoColumnWidth(ws, groupData, fields);
applyGroupedHeaders(ws);

const sheetName = safeSheetName(position);
XLSX.utils.book_append_sheet(wb, ws, sheetName);
```

- [ ] **Step 2: Replace empty sheet header data**

Change empty sheet fallback from:

```javascript
const emptyData = [fields.map(f => FIELD_CONFIG[f]?.header || f)];
const ws = XLSX.utils.aoa_to_sheet(emptyData);
XLSX.utils.book_append_sheet(wb, ws, '候选人');
```

to:

```javascript
const emptyData = buildGroupedExportData([], fields, mode);
const ws = XLSX.utils.aoa_to_sheet(emptyData);
applyGroupedHeaders(ws);
XLSX.utils.book_append_sheet(wb, ws, '候选人');
```

- [ ] **Step 3: Export new helpers**

Change final export from:

```javascript
export { FIELD_CONFIG, DEFAULT_FIELDS, transformCandidates, safeSheetName };
```

to:

```javascript
export { FIELD_CONFIG, DEFAULT_FIELDS, transformCandidates, buildGroupedExportData, safeSheetName, toAiRating };
```

---

### Task 5: 验证导出格式

**Files:**
- Verify: `scripts/export-candidates.mjs`

- [ ] **Step 1: Run grouped header verification again**

Run the exact command from Task 1 Step 1.

Expected after implementation:

```text
grouped header export verification passed
```

- [ ] **Step 2: Run multi-position regression verification**

Run:

```bash
node - <<'NODE'
const fs = require('fs');
const cp = require('child_process');
const X = require('xlsx');
const input = 'tmp/export-multi-position-input.json';
const output = 'tmp/export-multi-position-output.xlsx';
fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync(input, JSON.stringify({ mode: 'default', candidates: [
  { basicInfo: { name: 'A' }, positionInfo: { appliedJob: 'AI工程师' }, score: 80, passed: true },
  { basicInfo: { name: 'B' }, positionInfo: { appliedJob: 'Java/后端:工程师' }, score: 90, passed: false }
] }, null, 2));
cp.execFileSync(process.execPath, ['scripts/export-candidates.mjs', '--input', input, '--output', output], { stdio: 'pipe' });
const wb = X.readFile(output);
const expected = ['Java后端工程师', 'AI工程师'];
if (JSON.stringify(wb.SheetNames) !== JSON.stringify(expected)) {
  throw new Error(`Expected sheets ${JSON.stringify(expected)}, got ${JSON.stringify(wb.SheetNames)}`);
}
console.log('multi-position export verification passed:', JSON.stringify(wb.SheetNames));
NODE
```

Expected:

```text
multi-position export verification passed: ["Java后端工程师","AI工程师"]
```

- [ ] **Step 3: Run syntax check**

Run:

```bash
node --check scripts/export-candidates.mjs
```

Expected: command exits 0 with no output.

- [ ] **Step 4: Clean generated verification files**

Run:

```bash
rm -f tmp/export-grouped-header-input.json tmp/export-grouped-header-output.xlsx tmp/export-multi-position-input.json tmp/export-multi-position-output.xlsx
```

---

## Self-Review Checklist

- [x] **Spec coverage:** Covers both big columns (`AI分析`, `附加信息`), all eight requested subcolumns, five-star AI rating, and existing multi-position sheet behavior.
- [x] **Placeholder scan:** No TBD/TODO placeholders; all code snippets and commands are explicit.
- [x] **Type consistency:** Uses existing candidate fields: `basicInfo.name`, `basicInfo.age`, `educationExperience[0].school`, `basicInfo.education`, `basicInfo.workYears`, `resumeText`, `jobRelevanceComment`, `totalScore ?? score`.
