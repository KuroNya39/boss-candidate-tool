---
domain: zhipin.com
aliases: [Boss直聘, BOSS直聘, boss直聘, boss]
updated: 2026-04-22
---

## 平台特征

- 招聘端「沟通」页面需要招聘者登录态
- 候选人列表通过 Vue 动态渲染，静态抓取无效
- 页面 URL：`https://www.zhipin.com/web/chat`（实际会跳转到 `/web/chat/index`）
- **交互式结构**：
  - 左侧：候选人列表卡片（`.geek-item`）
  - 右侧：详情面板（点击卡片后显示，`.base-info-single-container`）
- 基本信息、经历、职位期望等信息在详情面板中，需点击候选人才能获取

## 参数规范

### 数量参数 (count)

| 属性 | 值 |
|------|-----|
| 默认值 | 5 |
| 最小值 | 1 |
| 最大值 | 20 |

**边界处理**：
- 用户未指定数量 → 使用默认值 5
- 用户指定数量 < 1 → 使用最小值 1
- 用户指定数量 > 20 → 使用最大值 20，在输出中添加 `note` 字段提示用户
- 用户指定有效数量（1-20）→ 使用指定值

**数量解析示例**：
- "读取前 10 个候选人" → count = 10
- "提取候选人信息" → count = 5（默认）
- "获取全部候选人" → count = 20（上限），提示"已按上限提取 20 个"

### 错误处理

**核心原则**：
- **不报错**：字段缺失时省略该字段，不抛出错误
- **不推断**：严格按 DOM 结构提取，不做文本猜测
- **不补全**：字段缺失就是缺失，不填默认值
- **不重写**：提取脚本固定，禁止 LLM 修改

单字段缺失不是错误，直接省略。错误仅指脚本执行层面的异常（如 `Uncaught`）。

### 重试机制

> **遇到错误时的唯一处理方式**：不要尝试调试或重写脚本，只能按以下步骤重试。
>
> **关键**：遇到任何脚本执行错误（包括 `Uncaught`）都不要分析原因、不要调试、不要优化脚本。只能重试或返回空对象继续下一个。

当提取返回脚本执行错误时（仅限 `Uncaught` 等异常，**不包括字段缺失**）：
1. 等待 500ms
2. 重新执行点击：`document.querySelectorAll('.geek-item')[i].click()`
3. 等待 300ms
4. 再次执行**本文件定义的提取脚本**（禁止修改）
5. 仍失败则返回空对象 `{}`，继续下一个

**禁止行为**：
- 禁止自行编写新的提取脚本
- 禁止修改选择器
- 禁止尝试"检查页面结构"后重写逻辑
- 禁止分析错误原因或尝试"优化脚本"
- 禁止因为字段缺失而报错或重试

## 有效模式

### 读取沟通页前 N 个候选人详细信息（全量结构化输出）

> **重要**：必须严格使用本文件提供的脚本和流程。禁止自行编写或修改提取逻辑。如遇问题，仅允许使用下方定义的重试机制，不得重写脚本。

**入口**：直接导航到 `https://www.zhipin.com/web/chat`

**提取流程**（严格按此执行，禁止修改）：

1. 解析用户请求，确定提取数量 N（应用边界规则）
2. 循环 N 次（索引 0 到 N-1）：
   a. 执行点击脚本：`document.querySelectorAll('.geek-item')[i].click()`
   b. 等待 300ms
   c. 执行**本文件定义的提取脚本**
   d. 若返回**脚本执行错误**（仅限 `Uncaught` 等异常）：
      - **不要分析错误原因**
      - **不要尝试修复脚本**
      - 等待 500ms
      - 重新执行点击脚本
      - 等待 300ms
      - 再次执行提取脚本
      - 仍失败则返回 `{ "index": i+1 }`（空对象）
   e. 记录结果，继续下一个
3. 汇总输出 JSON

**点击候选人脚本**（唯一可用，禁止修改）：

```javascript
document.querySelectorAll('.geek-item')[i].click()
```

其中 `i` 为索引（0 到 N-1）。

**提取详情脚本**（点击后等待 300ms，再执行。唯一可用，禁止修改）：

```javascript
(function() {
  const result = {};

  // ========== 基本信息 ==========
  const basicDetail = document.querySelector('.base-info-single-detial');
  if (basicDetail) {
    const basicInfo = {};
    const divs = basicDetail.querySelectorAll(':scope > div');

    // 姓名
    const nameEl = basicDetail.querySelector('.base-name');
    if (nameEl) {
      basicInfo.name = nameEl.textContent.trim();
    }

    // 年龄、工作年限、学历（按顺序的第2、3、4个div）
    if (divs.length >= 2 && divs[1].textContent.trim()) {
      basicInfo.age = divs[1].textContent.trim();
    }
    if (divs.length >= 3 && divs[2].textContent.trim()) {
      basicInfo.workYears = divs[2].textContent.trim();
    }
    if (divs.length >= 4 && divs[3].textContent.trim()) {
      basicInfo.education = divs[3].textContent.trim();
    }

    if (Object.keys(basicInfo).length > 0) {
      result.basicInfo = basicInfo;
    }
  }

  // ========== 工作经历 & 教育经历 ==========
  const timeList = document.querySelector('.time-content');
  const detailList = document.querySelector('.work-content');

  if (timeList && detailList) {
    const timeItems = timeList.querySelectorAll(':scope > li');
    const detailItems = detailList.querySelectorAll(':scope > li');

    const workExperience = [];
    const educationExperience = [];

    timeItems.forEach((timeLi, index) => {
      const detailLi = detailItems[index];
      if (!detailLi) return;

      const timeEl = timeLi.querySelector('.time');
      const detailEl = detailLi.querySelector('.value');

      const time = timeEl ? timeEl.textContent.trim() : '';
      const detail = detailEl ? detailEl.textContent.trim() : '';

      // 判断是工作还是教育
      const isEducation = timeLi.querySelector('[xlink\\:href="#icon-base-info-edu"]') ||
                          detailLi.querySelector('[xlink\\:href="#icon-base-info-edu"]');

      if (isEducation) {
        // 教育：学校 · 专业 · 学历
        const parts = detail.split('·').map(p => p.trim());
        const edu = {};
        if (time) edu.time = time;
        if (parts[0]) edu.school = parts[0];
        if (parts[1]) edu.major = parts[1];
        if (parts[2]) edu.degree = parts[2];
        if (Object.keys(edu).length > 0) {
          educationExperience.push(edu);
        }
      } else {
        // 工作：公司 · 职位
        const parts = detail.split('·').map(p => p.trim());
        const work = {};
        if (time) work.time = time;
        if (parts[0]) work.company = parts[0];
        if (parts[1]) work.position = parts[1];
        if (Object.keys(work).length > 0) {
          workExperience.push(work);
        }
      }
    });

    if (workExperience.length > 0) {
      result.workExperience = workExperience;
    }
    if (educationExperience.length > 0) {
      result.educationExperience = educationExperience;
    }
  }

  // ========== 职位信息 ==========
  const positionContent = document.querySelector('.position-content');
  if (positionContent) {
    const positionInfo = {};

    // 沟通职位
    const appliedJobEl = positionContent.querySelector('.position-name');
    if (appliedJobEl) {
      positionInfo.appliedJob = appliedJobEl.textContent.trim();
    }

    // 期望
    const expectEl = positionContent.querySelector('.value.job');
    if (expectEl) {
      const expectText = expectEl.textContent.trim();
      // 格式：城市 · 职位 薪资
      const expectParts = expectText.split('·').map(p => p.trim());
      if (expectParts[0]) {
        positionInfo.expectCity = expectParts[0];
      }
      if (expectParts[1]) {
        // 分离职位和薪资（薪资通常带K）
        const posSalary = expectParts[1].split(/\s+/);
        if (posSalary[0]) {
          positionInfo.expectPosition = posSalary[0];
        }
        if (posSalary[1]) {
          positionInfo.expectSalary = posSalary[1];
        }
      }
    }

    if (Object.keys(positionInfo).length > 0) {
      result.positionInfo = positionInfo;
    }
  }

  return result;
})();
```

**单个候选人输出格式**：

```json
{
  "basicInfo": {
    "name": "于自豪",
    "age": "24岁",
    "workYears": "2年",
    "education": "本科"
  },
  "workExperience": [
    {
      "time": "2024.03-2026.03",
      "company": "元展科技（佛山）有限公司",
      "position": "自然语言处理算法"
    },
    {
      "time": "2024.03-2026.03",
      "company": "元展科技",
      "position": "算法工程师"
    }
  ],
  "educationExperience": [
    {
      "time": "2020-2024",
      "school": "郑州工程技术学院",
      "major": "物联网工程技术",
      "degree": "本科"
    }
  ],
  "positionInfo": {
    "appliedJob": "ai应用开发工程师",
    "expectCity": "深圳",
    "expectPosition": "深度学习",
    "expectSalary": "15-25K"
  }
}
```

**字段缺失示例**（部分字段不存在时省略）：

```json
{
  "basicInfo": {
    "name": "张三",
    "age": "28岁"
  },
  "workExperience": [
    {
      "company": "XX公司"
    }
  ]
}
```

**完整输出格式**：

```json
{
  "requested": 5,
  "actual": 5,
  "candidates": [
    {
      "index": 1,
      "basicInfo": { "name": "于自豪", "age": "24岁", "workYears": "2年", "education": "本科" },
      "workExperience": [
        { "time": "2024.03-2026.03", "company": "元展科技", "position": "算法工程师" }
      ],
      "educationExperience": [
        { "time": "2020-2024", "school": "郑州工程技术学院", "major": "物联网工程技术", "degree": "本科" }
      ],
      "positionInfo": { "appliedJob": "ai应用开发工程师", "expectCity": "深圳", "expectPosition": "深度学习", "expectSalary": "15-25K" }
    },
    {
      "index": 2,
      "basicInfo": { "name": "李四", "age": "26岁", "workYears": "3年", "education": "硕士" }
    }
  ]
}
```

触发上限的输出（用户请求 30 个）：

```json
{
  "requested": 30,
  "actual": 20,
  "note": "请求数量超出上限，已按最大值 20 提取",
  "candidates": [
    // ... 20 个候选人信息
  ]
}
```

## 使用流程

1. 确认 Chrome 已登录 Boss 直聘招聘端
2. 执行前置检查：`node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"`
3. 解析用户请求，确定提取数量 N（应用边界规则）
4. 创建新 tab：`curl -s "http://localhost:3456/new?url=https://www.zhipin.com/web/chat"`
5. 等待页面加载完成
6. **循环 N 次**（索引 0 到 N-1）：
   - 执行：`curl -s -X POST "http://localhost:3456/eval?target=xxx" -d "document.querySelectorAll('.geek-item')[i].click()"`
   - 等待 300ms
   - 执行提取脚本
   - 若返回脚本执行错误（仅限 `Uncaught` 等异常）：等待 500ms → 重新点击 → 等待 300ms → 再次提取
   - 记录结果
7. 汇总数据，保存到文件 `data/raw_candidates.json`
8. 关闭 tab：`curl -s "http://localhost:3456/close?target=xxx"`
9. 向用户简要报告：提取成功，已保存到 `data/raw_candidates.json`

**输出方式**：
- 数据保存到文件，不在聊天中输出完整 JSON
- 后续筛选、打分、导出等操作基于该文件进行

## 已知陷阱

- **未登录时**页面会重定向到登录页，提取结果为空对象
- **详情面板需点击触发**：基本信息不在列表卡片中，必须点击进入详情才能获取
- **DOM 更新延迟**：点击后需等待 300-500ms 让 Vue 更新详情面板
- **字段可能缺失**：部分候选人可能未填写某些信息，字段缺失时自动省略
- 候选人列表使用虚拟滚动，首屏加载约 20 条
- **数量上限**：单次最多提取 20 个候选人
- **脚本执行可能返回 `Uncaught` 错误**：这是 CDP 执行异常或时序问题，触发重试机制，不要尝试修复
