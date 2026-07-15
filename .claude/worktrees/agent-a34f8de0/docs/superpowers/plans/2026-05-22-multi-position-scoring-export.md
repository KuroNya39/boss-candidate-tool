# 多岗位评分与导出 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让评分和导出脚本支持按 `appliedJob` 区分多岗位，LLM 按岗位分组评分，Excel 按岗位分 sheet 导出。

**Architecture:** 提取阶段不动（已有 `appliedJob` + `jobDescription`），改动集中在评分脚本（加 `--position` 过滤）、LLM 评分流程（分组循环）、导出脚本（多 sheet 分组）。

**Tech Stack:** Node.js (CLI scripts), xlsx (Excel 导出)

---

### Task 1: score-candidates.mjs 新增 --position 参数

**Files:**
- Modify: `scripts/score-candidates.mjs:7-30` (CLI 解析), `:412-465` (main 函数)

**思路**：新增 `--position <岗位名>` CLI 参数，main 中读取后按 `positionInfo.appliedJob` 过滤候选人。

**Attention:**
- 传 `--position` 时，过滤条件必须精确匹配
- 不传时行为不变（向后兼容）
- 如果指定了 `--position` 但无匹配候选人，输出提示后退出

- [ ] **Step 1: score-candidates.mjs 新增 --position CLI 参数**

在 `parseArgs()` 函数中（约第 7-30 行），现有代码通过循环读取 `--key value` 对，会自动将 `--position` 后的值赋给 `opts.position`。只需在 usage 中增加文档即可。

修改 usage 行（约第 22 行）：
```javascript
// 从
if (!opts.input) {
  console.error('Usage: node score-candidates.mjs --input <file> [--rules <file> | --default] [--position <name>] [--output <file>]');
  process.exit(1);
}
// 不变，--position 已经出现在 usage 中即可，parse 逻辑自动支持
```

注意：当前 `parseArgs` 已经通过循环 `for (let i = 0; i < args.length; i++) { if (args[i].startsWith('--')) { ... opts[key] = args[i + 1]; i++; } }` 自动捕获所有 `--key value` 对，所以 `--position` 无需额外解析代码。

- [ ] **Step 2: main() 中添加过滤逻辑**

在 `main()` 中，`candidateList` 已经读取后（约第 416 行），在 `map` 之前加入过滤：

```javascript
// 在以下代码之前：
// let scoredCandidates;
// 加入：
const filteredList = opts.position
  ? candidateList.filter(c => (c.positionInfo?.appliedJob || '') === opts.position)
  : candidateList;

if (opts.position && filteredList.length === 0) {
  console.warn(`警告：未找到岗位 "${opts.position}" 的候选人`);
  console.warn(`可用的岗位: ${[...new Set(candidateList.map(c => c.positionInfo?.appliedJob || '').filter(Boolean))].join(', ')}`);
}

// 然后将 scoreCandidatesDefault(c) 从 candidateList 改为 filteredList
scoredCandidates = filteredList.map(c => scoreCandidateDefault(c));
```

- [ ] **Step 3: 修改 output 的 metadata**

同时确保 output 对象的 metadata 包含 `position` 字段（适配旧代码中已有的 `opts.position` 字段）：

约第 428 行，output 对象中已有 `position: opts.position || ''`，不变。

- [ ] **Step 4: 命令行验证**

```bash
# 不传 --position（旧行为）
node scripts/score-candidates.mjs --default --input output/zhipin-candidates.json
# 应正常评分全部候选人

# 传 --position
node scripts/score-candidates.mjs --default --position "ai应用开发工程师" --input output/zhipin-candidates.json
# 应只输出该岗位候选人
```

注意：当前测试数据中所有候选人都是 "ai应用开发工程师"，所以两种调用结果应一致。

- [ ] **Step 5: Commit**

```bash
git add scripts/score-candidates.mjs
git commit -m "feat: score-candidates.mjs 新增 --position 参数支持按岗位过滤"
```

---

### Task 2: export-candidates.mjs 多 sheet 导出

**Files:**
- Modify: `scripts/export-candidates.mjs:200-248` (main 函数)

**思路**：将 `main()` 中单 sheet 生成改为按 `positionInfo.appliedJob` 分组，每组一个 sheet。sheet 名取 `appliedJob`，超 31 字符截断，非法字符移除。

- [ ] **Step 1: 添加 sheet 名称安全处理函数**

在 `autoColumnWidth` 函数之后（约第 199 行之前），添加工具函数：

```javascript
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
```

- [ ] **Step 2: 改写 main() 中的分组导出逻辑**

将现有单 sheet 生成代码（约第 220-229 行）替换为：

```javascript
// 在原代码位置：
// const wb = XLSX.utils.book_new();
// const ws = XLSX.utils.aoa_to_sheet(data);
// ...
// XLSX.utils.book_append_sheet(wb, ws, '候选人');

// 替换为：
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

  const groupData = transformCandidates(groupCandidates, fields, mode);
  const ws = XLSX.utils.aoa_to_sheet(groupData);
  autoColumnWidth(ws, groupData, fields);

  const sheetName = safeSheetName(position);
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  sheetCount++;
}

// 如果没有任何分组（理论上不会发生），创建默认 sheet
if (sheetCount === 0) {
  const emptyData = [fields.map(f => FIELD_CONFIG[f]?.header || f)];
  const ws = XLSX.utils.aoa_to_sheet(emptyData);
  XLSX.utils.book_append_sheet(wb, ws, '候选人');
}
```

- [ ] **Step 3: 更新控制台输出**

约第 238 行 `console.log(`导出成功: ${outputPath}`)` 之后，增加：

```javascript
console.log(`共导出 ${candidates.length} 条记录，${sheetCount} 个岗位`);

// 输出各岗位人数
for (const [position, groupCandidates] of positionGroups) {
  const passCount = groupCandidates.filter(c => c.passed !== false).length;
  console.log(`  ${position}: ${groupCandidates.length} 人 (通过 ${passCount})`);
}
```

- [ ] **Step 4: 命令行验证**

```bash
# 使用现有单岗位数据
node scripts/export-candidates.mjs --input output/scored-candidates.json
# 应生成一个 sheet 名为"ai应用开发工程师"的 Excel 文件

# 检查 Excel 文件
node -e "const X = require('xlsx'); const wb = X.readFile('output/candidates.xlsx'); console.log('Sheets:', wb.SheetNames);"
# 输出: Sheets: [ 'ai应用开发工程师' ]
```

- [ ] **Step 5: Commit**

```bash
git add scripts/export-candidates.mjs
git commit -m "feat: export-candidates.mjs 支持按岗位分多 sheet 导出"
```

---

### Task 3: SKILL.md LLM 评分流程更新

**Files:**
- Modify: `SKILL.md` (LLM 评分流程部分)

**思路**：将现有 LLM 评分 Step 3 中"全部候选人共享一个 JD"的流程，改为"按 appliedJob 分组后每组各自评分"。

- [ ] **Step 1: 修改 Step 3.1 — 读取候选人数据后增加岗位分析**

将 Step 3.1 改为：

```markdown
**Step 3.1**: 读取 `output/scored-candidates.json`，获取候选人列表（`d.candidates`）
- 分析 `candidates` 中 `positionInfo.appliedJob` 的分布
- 输出："发现 {N} 个岗位：{岗位1}({M1}人)、{岗位2}({M2}人)..."
```

- [ ] **Step 2: 修改 Step 3.2 — 岗位维度的 JD 读取**

将 Step 3.2 改为：

```markdown
**Step 3.2**: 读取模板文件并确定评分上下文
- 模板内容在本次评分会话内复用，无需每批重读
- 注意：不同岗位可能有不同的 JD，评分时需按岗位区分（见 Step 3.3 分组流程）
- 若所有候选人 `appliedJob` 相同，退化为旧行为（一次读取 `d.candidates[0].jobDescription.description`）
```

- [ ] **Step 3: 重写 Step 3.3 — 改为逐岗位分组**

将 Step 3.3 替换为：

```markdown
**Step 3.3**: 按岗位分组

1. 从 `d.candidates` 统计 `positionInfo.appliedJob` 的唯一值列表
2. 按岗位分组：
   ```
   岗位列表: [ai应用开发工程师(20人), Java开发(15人), 产品经理(15人)]
   ```
3. 逐岗位处理，每个岗位独立走 Step 3.4-3.5：
   - 从 `d.candidates` 中筛选出该岗位的候选人（`appliedJob === 岗位名`）
   - 取该岗位的 JD（组内任一候选人的 `jobDescription.description` 即可）
   - 该岗位候选人总数 C_pos
   - 子 Agent 数 N = clamp(ceil(C_pos / 5), 2, 5)
   - 将该岗位候选人平均分给 N 个子 Agent，每人 3-6 人
   - 进入 Step 3.4 并行评分
   - 评分结果合并回 `d.candidates`
4. 全部岗位完成后，继续 Step 4 合并总分
```

- [ ] **Step 4: 更新 Step 3.4 — 子 Agent prompt 明确岗位上下文**

原有的子 Agent prompt 基础上，在岗位分组场景下，prompt 末尾增加：

```
注意：当前评分的岗位是 "{岗位名}"，请确保只对该岗位的候选人进行评分。
评分依据使用该岗位的 JD（Job Description）。
```

另外 Step 3.4 的"子 Agent 收到自己的候选人子集"的描述中，增加说明：如果候选人子集中有不同岗位的（理论上不会），应跳过或报错。

- [ ] **Step 5: 更新进度报告文案**

在 Step 3.3 完成后输出进度时，改为按岗位报告：

```markdown
**进度报告**：
- 启动前："准备并行评分：共 {C} 位候选人，{P} 个岗位"
- 每个岗位启动前："评分岗位 [{岗位名}]: {C_pos} 位候选人，{N} 个子 Agent，每批 3-5 人"
- 每个岗位完成后："岗位 [{岗位名}] 评分完成"
- 全部完成时："LLM 评分完成，准备合并总分"
```

- [ ] **Step 6: 验证**

Review SKILL.md 整体一致性，确认：
- 单岗位场景下与旧流程行为一致
- 多岗位场景下各组独立评分
- 无遗漏的硬编码引用

- [ ] **Step 7: Commit**

```bash
git add SKILL.md
git commit -m "feat: SKILL.md LLM 评分流程支持按岗位分组"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Task 1 覆盖 `--position` 参数需求；Task 2 覆盖多 sheet 导出；Task 3 覆盖 LLM 分组评分 — 全部覆盖 spec 中的三个改动层面
- [x] **Placeholder scan**: 无 TBD/TODO/模糊描述，所有代码块包含完整代码
- [x] **Type consistency**: CLI 参数名 `--position` 在 scripts 和 SKILL.md 中一致；`positionInfo.appliedJob` 字段名与提取脚本一致
