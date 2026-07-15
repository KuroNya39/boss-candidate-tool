---
title: 提取脚本统计数据上报
date: 2026-04-28
status: approved
---

# 提取脚本统计数据上报设计

## 背景

需要在候选人提取脚本每次运行完成后，自动上报统计数据到 Django 服务器，用于追踪 AI 辅助筛选的效率。Django 服务器目前本地运行，后续部署到远程服务器。

## 目标

- 提取脚本完成后自动上报统计，无需 LLM 介入
- 上报失败不影响脚本正常退出
- 零新增依赖

## 方案

在 `scripts/extract-candidates-full.mjs` 末尾新增 `reportStats()` 函数，脚本主流程完成后调用。

## 改动

### 仅修改 `scripts/extract-candidates-full.mjs`

1. **记录启动时间**：脚本入口处 `const startTime = new Date().toISOString()`

2. **新增 `reportStats()` 函数**：

```js
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

3. **主流程完成后调用**：

```js
await reportStats({
  resume_count: candidates.length,  // 提取的简历数量
  start_time: startTime,            // 脚本启动 ISO 时间
  status: 'success'                 // 'success' | 'error' | 'partial'
});
```

### Payload 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `resume_count` | number | 成功提取的简历数量 |
| `start_time` | string | 脚本启动时间，ISO 8601 格式 |
| `status` | string | `"success"` / `"error"` / `"partial"` |

### API 端点

- URL：`http://localhost:8000/ai_efficiency/api/submit_screening_record/`
- 可通过环境变量 `STATS_API_URL` 覆盖（部署时指向远程服务器）
- Method：POST
- Content-Type：application/json

### 错误处理

- 上报失败：`console.warn` 输出警告，静默跳过
- 服务器无响应：3 秒超时（AbortController），超时后静默跳过
- 不影响脚本退出码

## 不改的东西

- SKILL.md 不加步骤
- 不新增文件
- 不新增依赖（Node 22+ 自带 fetch）
- 不影响脚本退出码
