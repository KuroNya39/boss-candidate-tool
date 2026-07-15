# 提取脚本统计数据上报 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 extract-candidates-full.mjs 末尾自动上报统计数据到 Django API，失败静默跳过。

**Architecture:** 在脚本入口记录 startTime，新增 reportStats() 函数用 Node.js 原生 fetch POST JSON 到 Django，主流程完成后调用。3 秒超时防卡住，catch 静默处理。

**Tech Stack:** Node.js 22+ 原生 fetch, AbortController

---

### Task 1: 添加 startTime 记录和 reportStats 函数

**Files:**
- Modify: `scripts/extract-candidates-full.mjs`

- [ ] **Step 1: 在脚本入口记录 startTime**

在 `const __dirname = dirname(fileURLToPath(import.meta.url));` (line 24) 之后添加：

```js
const startTime = new Date().toISOString();
```

- [ ] **Step 2: 添加 reportStats 函数**

在 `sleep()` 函数之后（line 103 之后），添加 `reportStats` 函数：

```js
// ===== 统计数据上报 =====
async function reportStats({ resume_count, start_time, status }) {
  const url = process.env.STATS_API_URL || 'http://localhost:8000/ai_efficiency/api/submit_screening_record/';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_count, start_time, status }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log('Stats reported successfully');
  } catch (e) {
    console.warn(`Stats report failed: ${e.message}`);
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/extract-candidates-full.mjs
git commit -m "feat: 添加 startTime 记录和 reportStats 函数"
```

---

### Task 2: 在主流程完成后调用 reportStats

**Files:**
- Modify: `scripts/extract-candidates-full.mjs`

- [ ] **Step 1: 在 main() 函数末尾、摘要输出之后调用 reportStats**

在 `console.log('========== 提取结果摘要 ==========');` 区块之后（约 line 1199 之后），添加上报调用：

```js
  // 上报统计数据
  await reportStats({
    resume_count: candidates.length,
    start_time: startTime,
    status: 'success',
  });
```

- [ ] **Step 2: 在 main().catch 中上报失败状态**

修改 `main().catch()` 块（line 1202-1205），在 `process.exit(1)` 之前上报 error 状态：

```js
main().catch(async (err) => {
  console.error('致命错误:', err.message);
  await reportStats({
    resume_count: 0,
    start_time: startTime,
    status: 'error',
  });
  process.exit(1);
});
```

- [ ] **Step 3: Commit**

```bash
git add scripts/extract-candidates-full.mjs
git commit -m "feat: 在主流程完成和错误时调用 reportStats 上报统计"
```

---

### Task 3: 验证脚本语法正确

- [ ] **Step 1: 检查脚本语法**

```bash
node --check scripts/extract-candidates-full.mjs
```

Expected: 无输出（语法正确）

- [ ] **Step 2: 验证 reportStats 函数可独立运行**

创建临时测试脚本验证 fetch + AbortController 逻辑：

```bash
node -e "
const startTime = new Date().toISOString();
async function reportStats({ resume_count, start_time, status }) {
  const url = process.env.STATS_API_URL || 'http://localhost:8000/ai_efficiency/api/submit_screening_record/';
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resume_count, start_time, status }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    console.log('Stats reported successfully');
  } catch (e) {
    console.warn('Stats report failed: ' + e.message);
  }
}
reportStats({ resume_count: 5, start_time: startTime, status: 'success' });
"
```

Expected: 输出 `Stats report failed: ...`（Django 未启动时静默失败）或 `Stats reported successfully`（Django 已启动时成功）

- [ ] **Step 3: Commit (if any fixes needed)**

If syntax check or test revealed issues, fix and commit.