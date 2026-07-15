# Boss 直聘候选人信息提取能力设计

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-04-21 | 初版，固定提取前 5 个候选人 |
| v2 | 2026-04-22 | 支持用户指定数量，增加参数规范、边界处理、重试机制 |

## 背景

在 web-access 现有架构基础上，增加 Boss 直聘招聘端「沟通」页面候选人信息提取能力。

## 目标

- 保留现有 web-access 浏览器接入能力
- 最小改造：仅更新站点经验文件，不修改核心代码
- 根据用户输入的数量，读取沟通页前 N 个候选人的基础信息并输出固定 JSON

## 参数设计

| 参数 | 默认值 | 边界 | 说明 |
|------|--------|------|------|
| 数量 (count) | 10 | 最小 1，最大 100 | 用户通过对话自然表达，Agent 从中解析 |

**边界处理规则**：
- 用户未指定数量 → 使用默认值 10
- 用户指定数量 < 1 → 使用最小值 1
- 用户指定数量 > 100 → 使用最大值 100，并在输出中提示用户
- 用户指定有效数量（1-100）→ 使用指定值

**数量解析示例**：
```
"读取前 10 个候选人" → count = 10
"提取候选人信息" → count = 10（默认）
"获取全部候选人" → count = 100（上限），提示"已按上限提取 100 个"
```

## 输出字段

| 字段 | 来源 | 示例 |
|------|------|------|
| `name` | 详情面板第一行 | 高健 |
| `age` | 详情面板（格式：XX岁） | 28岁 |
| `school` | 详情面板教育行 | 中国石油大学（华东） |
| `appliedJob` | 左侧列表卡片 | ai应用开发工程师 |

## 技术方案

### 架构设计

采用「站点经验模式」，完全复用 web-access 现有架构：

```
用户请求 → match-site.mjs 匹配关键词 → 读取 zhipin.com.md 站点经验
         → Agent 按经验指引调用 CDP API → 提取数据
```

### 页面结构分析

Boss 直聘招聘端「沟通」页面（`https://www.zhipin.com/web/chat`）采用左右分栏布局：

- **左侧**：候选人列表卡片（`.geek-item`），仅显示姓名和投递职位
- **右侧**：详情面板（`.base-info-single-container`），点击卡片后显示年龄、学校等信息

因此需要**交互式提取**：逐个点击候选人 → 等待详情加载 → 提取信息。

### 改动文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `references/site-patterns/zhipin.com.md` | 更新 | Boss 直聘站点经验，添加参数规范、边界处理、重试逻辑 |

**无需修改其他文件**：
- `SKILL.md`：现有架构已支持自动匹配站点经验
- `scripts/*.mjs`：通用 CDP API 已足够

### 提取流程

```
1. 解析用户请求，确定提取数量 N（应用边界规则）
2. 导航到 https://www.zhipin.com/web/chat
3. 循环 N 次（索引 0 到 N-1）：
   a. 点击第 i 个候选人卡片
   b. 等待 300ms（Vue 更新详情面板）
   c. 执行提取脚本
   d. 若返回 error:
      - 等待 500ms
      - 重新点击当前候选人卡片
      - 等待 300ms
      - 再次执行提取脚本
   e. 记录结果（成功或失败均记录）
4. 汇总输出 JSON
```

### 错误处理

- 提取失败时记录 `error` 字段，继续提取下一个候选人
- 最终输出包含成功和失败的完整记录
- 重试机制：详情面板未加载时，等待 500ms 后重新点击一次，仍失败则记录错误

### 提取脚本

```javascript
(function() {
  const detail = document.querySelector('.base-info-single-container');
  if (!detail) {
    return { error: '未找到详情面板，请确认已点击候选人' };
  }

  const lines = detail.innerText.split('\n').filter(l => l.trim());

  // 提取姓名（第一行）
  const name = lines[0]?.trim() || '';

  // 提取年龄（格式：XX岁）
  const ageLine = lines.find(l => l.includes('岁'));
  const age = ageLine ? ageLine.trim() : '';

  // 提取学校（格式：XX大学 · 专业 · 学历 或 XX学院 · 专业 · 学历）
  const eduLine = lines.find(l => l.includes('大学') || l.includes('学院'));
  const school = eduLine ? eduLine.split('·')[0]?.trim() : '';

  // 获取投递职位（从左侧列表卡片）
  const activeItem = document.querySelector('.geek-item.selected') ||
                     document.querySelector('.geek-item');
  const appliedJob = activeItem?.querySelector('.source-job')?.textContent?.trim() || '';

  return {
    name: name,
    age: age,
    school: school,
    appliedJob: appliedJob
  };
})();
```

### 输出示例

**正常输出**（用户请求 5 个）：

```json
{
  "requested": 5,
  "actual": 5,
  "candidates": [
    { "index": 1, "name": "高健", "age": "28岁", "school": "中国石油大学（华东）", "appliedJob": "ai应用开发工程师" },
    { "index": 2, "name": "罗煜", "age": "26岁", "school": "湖南工业大学", "appliedJob": "ai应用开发工程师" },
    { "index": 3, "name": "杨晨", "age": "27岁", "school": "武汉大学", "appliedJob": "ai应用开发工程师" },
    { "index": 4, "name": "罗唤金", "age": "26岁", "school": "中南大学", "appliedJob": "ai应用开发工程师" },
    { "index": 5, "name": "王康宁", "age": "23岁", "school": "深圳大学", "appliedJob": "ai应用开发工程师" }
  ]
}
```

**包含部分失败的输出**：

```json
{
  "requested": 5,
  "actual": 5,
  "candidates": [
    { "index": 1, "name": "高健", "age": "28岁", "school": "中国石油大学（华东）", "appliedJob": "ai应用开发工程师" },
    { "index": 2, "name": "罗煜", "age": "26岁", "school": "湖南工业大学", "appliedJob": "ai应用开发工程师" },
    { "index": 3, "error": "详情面板未加载" },
    { "index": 4, "name": "杨晨", "age": "27岁", "school": "武汉大学", "appliedJob": "ai应用开发工程师" },
    { "index": 5, "name": "罗唤金", "age": "26岁", "school": "中南大学", "appliedJob": "ai应用开发工程师" }
  ]
}
```

**触发上限的输出**（用户请求 150 个，超出最大值 100）：

```json
{
  "requested": 150,
  "actual": 100,
  "note": "请求数量超出上限，已按最大值 100 提取",
  "candidates": [
    // ... 100 个候选人信息
  ]
}
```

## 验证结果

在真实页面上测试通过：

```
点击候选人[1] → 等待 → 提取
{"name":"罗煜","age":"26岁","school":"湖南工业大学","appliedJob":"ai应用开发工程师"}
```

## 已知限制

1. **需要登录态**：未登录时页面重定向到登录页
2. **详情面板需点击触发**：年龄、学校不在列表卡片中
3. **DOM 更新延迟**：点击后需等待 300-500ms
4. **学校字段可能为空**：部分候选人未填写教育经历
5. **数量上限**：单次最多提取 20 个候选人

## 实现状态

### v1（已完成）
- [x] 站点经验文件：`references/site-patterns/zhipin.com.md` 已创建
- [x] 提取脚本已在真实页面验证通过

### v2（已完成）
- [x] 更新站点经验文件，添加参数规范、边界处理、重试逻辑
- [x] 更新设计文档（本文档）
