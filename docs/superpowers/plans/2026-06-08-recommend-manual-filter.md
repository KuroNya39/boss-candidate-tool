# 推荐牛人页手动筛选模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Electron 应用中新增"推荐牛人页（手动筛选）"模式，让 HR 用户先在 Chrome 中手动设好筛选条件，然后程序附着到该页面提取筛选后的候选人。

**Architecture:** Electron UI 新增 radio 选项→ main process 传递 `--attach` 参数 → 提取脚本通过 CDP `/targets` 发现已有 tab 代替新建 tab，提取后不关闭 tab。

**Tech Stack:** Electron, CDP Proxy, Node.js

---

### Task 1: Electron UI — 新增 radio 选项

**Files:**
- Modify: `electron/renderer/index.html:60-63`
- Modify: `electron/renderer/renderer.js:253-259, 328-332`

- [ ] **Step 1: index.html 新增 "推荐牛人页（手动筛选）" radio**

在现有两个 radio 后面增加第三个：

```html
<label class="radio-label">
  <input type="radio" name="source" value="recommend">
  <span>推荐牛人页</span>
</label>
<label class="radio-label">
  <input type="radio" name="source" value="recommend-attach">
  <span>推荐牛人页（手动筛选）</span>
</label>
```

- [ ] **Step 2: renderer.js — 岗位选择区显示逻辑适配**

`recommend-attach` 和 `recommend` 一样需要显示岗位选择区。修改 line 329-332 的 `change` 事件处理：

```javascript
// 修改前:
jobSelectSection.style.display = radio.value === 'recommend' ? 'flex' : 'none';

// 修改后:
jobSelectSection.style.display = (radio.value === 'recommend' || radio.value === 'recommend-attach') ? 'flex' : 'none';
```

- [ ] **Step 3: Commit**

```bash
git add electron/renderer/index.html electron/renderer/renderer.js
git commit -m "feat(ui): 新增推荐牛人页手动筛选模式 radio 选项"
```

---

### Task 2: Electron main process — 传递 `--attach` 参数

**Files:**
- Modify: `electron/main.mjs:615-623`

- [ ] **Step 1: 在 `runPipeline` 中传递 `--attach` 参数**

```javascript
// 修改前 (line 615-623):
const scriptName = source === 'recommend' ? 'extract-recommend-candidates.mjs' : 'extract-candidates-full.mjs';
sendProgress(1, 'running', 0, extractAll ? `准备提取全部候选人 (${source === 'recommend' ? '推荐牛人' : '沟通'}页)...` : '准备提取候选人...');
const extractArgs = extractAll
  ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
  : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
if (job) {
  extractArgs.push('--job', job);
}

// 修改后:
const isRecommend = source === 'recommend' || source === 'recommend-attach';
const isAttach = source === 'recommend-attach';
const scriptName = isRecommend ? 'extract-recommend-candidates.mjs' : 'extract-candidates-full.mjs';
const pageLabel = isAttach ? '推荐牛人页（手动筛选）' : (isRecommend ? '推荐牛人' : '沟通');
sendProgress(1, 'running', 0, extractAll ? `准备提取全部候选人 (${pageLabel}页)...` : '准备提取候选人...');
const extractArgs = extractAll
  ? ['--all', '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')]
  : ['--count', String(count), '--output', resolve(OUTPUT_DIR, 'zhipin-candidates.json')];
if (job) {
  extractArgs.push('--job', job);
}
if (isAttach) {
  extractArgs.push('--attach');
}
```

- [ ] **Step 2: Commit**

```bash
git add electron/main.mjs
git commit -m "feat(main): 手动筛选模式传递 --attach 参数到提取脚本"
```

---

### Task 3: 提取脚本 — 解析 `--attach` 并发现已有 tab

**Files:**
- Modify: `scripts/extract-recommend-candidates.mjs:687-717` (extract-common.mjs 的 parseArgs)
  - Actually, the `parseArgs` function is in `scripts/extract-common.mjs`, but it's imported. Let me check again.

Actually, `extract-recommend-candidates.mjs` imports `parseArgs` from `extract-common.mjs`. I need to:
1. Add `--attach` support to `parseArgs` in `extract-common.mjs`
2. Add `findExistingRecommendTab()` function to `extract-recommend-candidates.mjs`
3. Modify the main flow in `extract-recommend-candidates.mjs`

**Files:**
- Modify: `scripts/extract-common.mjs:687-700` (parseArgs — add --attach boolean flag)
- Modify: `scripts/extract-recommend-candidates.mjs` (add find tab logic, modify main flow)

- [ ] **Step 1: extract-common.mjs — parseArgs 支持 --attach**

```javascript
// 在 line 693 的 if 条件中增加 --attach:
if (key === 'all' || key === 'resume' || key === 'attach') {
  opts[key] = true;
}
```

- [ ] **Step 2: extract-recommend-candidates.mjs — 添加 findExistingRecommendTab 函数**

在 import 区域后、`RECOMMEND_PAGE_URL` 常量后添加：

```javascript
/**
 * 通过 CDP /targets 查找用户已打开的推荐牛人页 tab
 * 用于 --attach 模式（手动筛选后附着到现有页面）
 */
async function findExistingRecommendTab() {
  const { proxyGet } = await import('./extract-common.mjs');
  const targets = await proxyGet('/targets');
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new Error('无法获取 Chrome tab 列表，请确保 CDP Proxy 已连接');
  }
  const tab = targets.find(t =>
    t.url && t.url.includes('/web/chat/recommend')
  );
  if (!tab || !tab.targetId) {
    throw new Error(
      '未找到已打开的推荐牛人页。\n' +
      '请先在 Chrome 中打开 https://www.zhipin.com/web/chat/recommend\n' +
      '并设置好筛选条件，然后重试。'
    );
  }
  console.log(`已附着到用户打开的推荐页: ${tab.url}`);
  return tab.targetId;
}
```

- [ ] **Step 3: extract-recommend-candidates.mjs — 修改 tab 创建逻辑**

在 `main()` 函数中，替换 line 844-847 的 tab 创建逻辑（从扫描阶段开始处）：

```javascript
// 修改前 (line 836-848):
if (scanCache) {
  cardInfos = scanCache.candidates;
  console.log(`跳过扫描阶段，使用缓存: ${cardInfos.length} 人\n`);
} else {
  // 创建新 tab
  console.log('打开 Boss 直聘推荐牛人页...');
  const newTab = await proxyGet(`/new?url=${RECOMMEND_PAGE_URL}`);
  targetId = newTab.targetId;
  console.log(`Tab 已创建: ${targetId}`);

// 修改后:
if (scanCache) {
  cardInfos = scanCache.candidates;
  console.log(`跳过扫描阶段，使用缓存: ${cardInfos.length} 人\n`);
} else {
  if (opts.attach) {
    // 手动筛选模式：附着到用户已打开的推荐页
    console.log('查找用户已打开的推荐牛人页...');
    targetId = await findExistingRecommendTab();
    console.log(`已附着到 Tab: ${targetId}\n`);
  } else {
    // 自动模式：创建新 tab
    console.log('打开 Boss 直聘推荐牛人页...');
    const newTab = await proxyGet(`/new?url=${RECOMMEND_PAGE_URL}`);
    targetId = newTab.targetId;
    console.log(`Tab 已创建: ${targetId}`);
  }
```

- [ ] **Step 4: extract-recommend-candidates.mjs — 修改 tab 关闭逻辑**

在 main() 函数末尾，替换 line 1169-1171 的 tab 关闭逻辑：

```javascript
// 修改前 (line 1169-1171):
// 关闭 tab
console.log('\n关闭 tab...');
await proxyGet(`/close?target=${targetId}`);

// 修改后:
if (!opts.attach) {
  // 自动模式才关闭 tab
  console.log('\n关闭 tab...');
  await proxyGet(`/close?target=${targetId}`);
} else {
  console.log('\n手动筛选模式：保留用户打开的 tab');
}
```

- [ ] **Step 5: 验证并测试**

Run: `node -e "
  // 验证 --attach 参数解析
  const { parseArgs } = require('./scripts/extract-common.mjs');
  const oldArgv = process.argv;
  process.argv = ['node', 'test', '--count', '10', '--attach', '--output', 'test.json'];
  const opts = parseArgs();
  console.assert(opts.attach === true, 'attach should be true');
  console.assert(opts.count === 10, 'count should be 10');
  console.log('--attach 参数解析测试通过');
"`

(Note: this uses ESM, so run with `--input-type=module` or similar. Actually the simplest test is to manually inspect the code path.)

- [ ] **Step 6: Commit**

```bash
git add scripts/extract-common.mjs scripts/extract-recommend-candidates.mjs
git commit -m "feat(extract): 推荐页手动筛选模式支持 --attach 参数"
```

---

### Task 4: 文档更新

**Files:**
- Modify: `references/site-patterns/zhipin.com.md`

- [ ] **Step 1: 在推荐牛人页提取章节补充手动筛选模式说明**

在 `references/site-patterns/zhipin.com.md` 的推荐牛人页提取章节末尾追加：

```markdown
### 手动筛选模式

> 更新于 2026-06-08。支持 HR 用户手动设置筛选条件后提取。

使用场景：HR 需要在推荐牛人页使用筛选功能（学历、年龄、性别、院校等），筛选出精准候选人列表后再提取。

**操作流程**：
1. 在 Chrome 中手动打开 `https://www.zhipin.com/web/chat/recommend`
2. 点击右上角筛选按钮，设置筛选条件，点击确定
3. 候选人列表刷新为筛选后结果
4. 在 Electron 应用中选择"推荐牛人页（手动筛选）"来源
5. 设置提取数量、岗位等参数
6. 点击"开始提取分析"
7. 程序自动发现已打开的推荐页 tab，直接提取

**技术说明**：
- 程序通过 CDP `/targets` 接口发现用户已打开的 tab（匹配 URL 包含 `/web/chat/recommend`）
- 提取完成后不关闭 tab
- 提取过程中请勿操作该页面
```

- [ ] **Step 2: Commit**

```bash
git add references/site-patterns/zhipin.com.md
git commit -m "docs: 补充推荐牛人页手动筛选模式说明"
```

---

### Task 5: 集成测试（手动验证）

- [ ] **Step 1: 准备测试环境**
  - 确认 CDP Proxy 已运行（端口 3456）
  - 确认 Chrome 已登录 Boss 直聘招聘端

- [ ] **Step 2: 手动测试 —— 推荐牛人页（自动模式）不受影响**
  1. 在 Electron 应用中选择"推荐牛人页"
  2. 设置提取数量 3，选定岗位
  3. 点击"开始提取分析"
  4. 验证：程序自动打开新 tab，正常提取

- [ ] **Step 3: 手动测试 —— 推荐牛人页（手动筛选模式）找不到 tab 的错误提示**
  1. 在 Electron 应用中选择"推荐牛人页（手动筛选）"
  2. 确保 Chrome 中没有打开推荐页
  3. 点击"开始提取分析"
  4. 验证：显示明确错误"未找到已打开的推荐牛人页..."

- [ ] **Step 4: 手动测试 —— 推荐牛人页（手动筛选模式）正常流程**
  1. 在 Chrome 中打开 `https://www.zhipin.com/web/chat/recommend`
  2. 设置筛选条件，点击确定
  3. 在 Electron 应用中选择"推荐牛人页（手动筛选）"
  4. 设置提取数量 3，选定岗位
  5. 点击"开始提取分析"
  6. 验证：程序发现已有 tab，提取 3 个候选人简历，完成后不关闭 tab
  7. 验证：提取结果中的候选人确实是筛选后的（与筛选条件匹配）
