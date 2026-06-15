---
title: Boss 直聘仅提取未读候选人 - 实现计划
date: 2026-05-22
source: docs/superpowers/specs/2026-05-22-boss-unread-only-design.md
---

# 实现计划：Boss 直聘仅提取未读候选人

## 概述

在提取流程开始前，先点击"未读"按钮筛选列表，使后续操作只针对未读候选人。

## 关键发现

`extract-candidates-full.mjs` 的主流程中创建了 **两个 tab**：
1. **Phase 1 (扫描)**：创建 tab，加载页面，扫描 geekIds，然后关闭 tab
2. **Phase 2 (提取)**：创建新 tab，加载页面，逐个提取

"未读"筛选需要在**每个 tab 创建并加载后**都执行一次。

## 任务清单

### 1. 脚本改动 (`scripts/extract-candidates-full.mjs`)

**改动点**：在 `main()` 函数中添加 `ensureUnreadFilter()` 函数，并在两处调用。

- [ ] 新增 `ensureUnreadFilter(targetId)` 函数：通过 CDP eval 点击"未读"按钮，等待 1500ms
- [ ] Phase 1 (line 1168)：`waitForCandidateList` 完成后、扫描开始前，调用 `ensureUnreadFilter`
- [ ] Phase 2 (line 1273)：`waitForCandidateList` 完成后、提取开始前，调用 `ensureUnreadFilter`

**`ensureUnreadFilter()` 实现**：

```javascript
async function ensureUnreadFilter(targetId) {
  const result = await proxyPost(`/eval?target=${targetId}`, `
    (() => {
      const el = Array.from(document.querySelectorAll('span,button,a,div,li'))
        .find(el => (el.innerText || el.textContent || '').trim() === '未读');
      if (!el) return { clicked: false, reason: 'not found' };
      el.click();
      return { clicked: true };
    })()
  `);

  if (!result.clicked) {
    console.warn('[未读筛选] 未找到"未读"按钮，降级为全量提取');
    return;
  }

  console.log('[未读筛选] 已切换到未读模式');
  await new Promise(r => setTimeout(r, 1500));
}
```

### 2. 站点经验文件改动 (`references/site-patterns/zhipin.com.md`)

- [ ] "使用流程"章节：在导航到沟通页后增加"切换到未读"步骤
- [ ] "提取流程"章节：在循环遍历前增加"切换到未读"步骤
- [ ] 添加"未读"点击脚本（与 weidu.txt 一致）

### 3. 验证

- [ ] 确认脚本运行时先打印 "[未读筛选] 已切换到未读模式" 再开始扫描
- [ ] 确认未读列表为空时，输出空列表不报错
- [ ] 确认"未读"按钮不存在时降级为全量提取

## 执行顺序

1. 修改 `scripts/extract-candidates-full.mjs`：新增 `ensureUnreadFilter` 函数 + 两处调用
2. 修改 `references/site-patterns/zhipin.com.md`：更新流程章节
3. 验证脚本行为
