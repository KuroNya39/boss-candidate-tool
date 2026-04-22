# Boss 直聘候选人信息提取能力设计

## 背景

在 web-access 现有架构基础上，增加 Boss 直聘招聘端「沟通」页面候选人信息提取能力。

## 目标

- 保留现有 web-access 浏览器接入能力
- 最小改造：仅新增站点经验文件，不修改核心代码
- 读取沟通页前 5 个候选人的基础信息并输出固定 JSON

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
| `references/site-patterns/zhipin.com.md` | 新建 | Boss 直聘站点经验，包含提取脚本 |

**无需修改其他文件**：
- `SKILL.md`：现有架构已支持自动匹配站点经验
- `scripts/*.mjs`：通用 CDP API 已足够

### 提取流程

```
1. 导航到 https://www.zhipin.com/web/chat
2. 循环 5 次（索引 0-4）：
   a. 点击第 N 个候选人卡片
   b. 等待 300ms（Vue 更新详情面板）
   c. 执行提取脚本，记录结果
3. 汇总输出 JSON
```

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

```json
{
  "total": 5,
  "candidates": [
    { "index": 1, "name": "高健", "age": "28岁", "school": "中国石油大学（华东）", "appliedJob": "ai应用开发工程师" },
    { "index": 2, "name": "罗煜", "age": "26岁", "school": "湖南工业大学", "appliedJob": "ai应用开发工程师" },
    { "index": 3, "name": "杨晨", "age": "27岁", "school": "武汉大学", "appliedJob": "ai应用开发工程师" },
    { "index": 4, "name": "罗唤金", "age": "26岁", "school": "中南大学", "appliedJob": "ai应用开发工程师" },
    { "index": 5, "name": "王康宁", "age": "23岁", "school": "深圳大学", "appliedJob": "ai应用开发工程师" }
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

## 实现状态

- [x] 站点经验文件：`references/site-patterns/zhipin.com.md` 已创建
- [x] 提取脚本已在真实页面验证通过
