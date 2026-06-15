---
title: Boss 直聘仅提取未读候选人
date: 2026-05-22
status: draft
---

# Boss 直聘仅提取未读候选人

## 背景

目前 Boss 直聘候选人提取是全量模式——遍历沟通页左侧候选人列表，逐个点击提取详细信息。但实际使用中，用户只关心未读（新消息）候选人，已读候选人无提取价值。

沟通页顶部有"全部"和"未读"两个筛选按钮。weidu.txt 已验证点击"未读"按钮可行（`<SPAN>未读</SPAN>`，`clicked: true`），且点击后页面会重新加载，DOM 中的 `.geek-item` 只保留未读候选人，加载时间约 1 秒。

## 目标

将提取模式从"全量"改为默认"仅未读"，去掉全量选项。改动最小化，不引入新参数。

## 改动范围

| 文件 | 改动 | 行数 |
|------|------|------|
| `scripts/extract-candidates-full.mjs` | 在列表扫描前增加"切换到未读"步骤 | ~10 |
| `references/site-patterns/zhipin.com.md` | 更新提取流程，增加未读筛选步骤 | ~10 |

无新增依赖，无新增命令行参数。

## 详细设计

### 1. Node 脚本改动 (`scripts/extract-candidates-full.mjs`)

在 `main()` 流程中，创建 tab 并导航到沟通页后、`scanGeekIds()` 调用前，增加一个 `ensureUnreadFilter()` 步骤：

```
main() 流程（节选）：
  1. 创建 tab → https://www.zhipin.com/web/chat
  2. 等待页面加载完成 (waitForLoad)
  3. 确保已切换到"未读"筛选 → ensureUnreadFilter()
  4. 扫描候选人列表 → scanGeekIds()
  5. 逐个提取 → extractCandidates()
  ...
```

**`ensureUnreadFilter()` 实现逻辑**：

```javascript
async function ensureUnreadFilter(targetId) {
  // 通过 CDP eval 查找并点击"未读"按钮
  const result = await proxyPost(`/eval?target=${targetId}`, `
    (() => {
      const el = Array.from(document.querySelectorAll('span,button,a,div,li'))
        .find(el => (el.innerText || el.textContent || '').trim() === '未读');
      if (!el) return { clicked: false, reason: 'not found' };
      el.click();
      return { clicked: true, tag: el.tagName, cls: el.className,
               text: (el.innerText || el.textContent || '').trim() };
    })()
  `);

  if (!result.clicked) {
    console.warn('[ensureUnreadFilter] 未找到"未读"按钮，降级为全量提取');
    return;
  }

  // 等待列表刷新（点击后页面重新加载）
  await new Promise(r => setTimeout(r, 1500));
}
```

代码直接引用 weidu.txt 已验证的脚本。

### 2. 站点经验文件改动 (`zhipin.com.md`)

在"提取流程"章节的步骤 1 和步骤 2 之间，增加一步：

```
1. 解析用户请求，确定提取数量 N
+1.5. 切换到未读筛选：
+     a. 执行脚本找到并点击"未读"按钮（禁止修改脚本）
+     b. 等待 1500ms 让列表刷新
+     （若"未读"按钮不存在，记录警告后继续，降级为全量提取）
2. 循环 N 次（索引 0 到 N-1）：
   ...
```

同时更新"使用流程"章节，在导航到沟通页后增加同样的"切换到未读"步骤。

## 边界情况处理

| 场景 | 行为 |
|------|------|
| "未读"按钮不存在（结构变化/已在未读tab） | 记录 warning，继续提取（降级全量） |
| 点击后列表为空（无未读消息） | 正常提取，结果为空列表，不报错 |
| 点击后列表加载缓慢 | 等待 1500ms，沿用现有的等待加载逻辑 |
| 默认提取数量 | 保持不变（--count / --all 逻辑不变） |

## 不做的改动

- 不加 `--unread` / `--all-messages` 等新参数
- 不修改提取脚本本身
- 不修改输出结构
- 不改变重试/错误处理逻辑
