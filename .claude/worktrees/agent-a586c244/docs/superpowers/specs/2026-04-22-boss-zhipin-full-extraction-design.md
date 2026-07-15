# Boss 直聘候选人详情全量提取设计

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-04-21 | 初版，固定提取前 5 个候选人 |
| v2 | 2026-04-22 | 支持用户指定数量，增加参数规范、边界处理、重试机制 |
| v3 | 2026-04-22 | 改为全量提取模式，基于 DOM 结构分组输出 |

## 背景

v2 版本在测试中发现问题：LLM 遇到文档中没有覆盖的错误情况时，会尝试自行编写脚本或修改提取逻辑，而非遵循站点经验文档。

根本原因：v2 采用"目标字段提取"模式——只提取预定义的几个字段，当字段提取失败时触发错误处理流程，LLM 容易误判需要"修复"脚本。

## 目标

改为"全量采集"模式：进入候选人详情页后，基于 DOM 结构完整提取页面上可见的基础信息，输出统一 JSON 结构。缺失字段省略，不报错。

**核心原则**：
- 不报错：任何字段找不到都省略或留空
- 不推断：严格按 DOM 结构提取，不做文本猜测
- 不补全：字段缺失就是缺失，不填默认值
- 不重写：提取脚本固定，LLM 禁止修改

## 输出结构

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

**字段缺失处理**：字段不存在时省略该字段，不输出空字符串或 null。

```json
{
  "workExperience": [
    { "company": "XX公司" }
  ]
}
```

## DOM 结构映射

详情面板 (`.base-info-single-container`) 分三个区域：

### 1. 基本信息 (`.base-info-single-top`)

```
.base-info-single-detial
├── .base-info-item.name-contet > .base-name → 姓名
├── div (第2个) → 年龄
├── div (第3个) → 工作年限
└── div (第4个) → 学历
```

### 2. 经历 (`.experience-content`)

分为两个并列的 `ul`：

**时间列表** (`.time-content`)：
```
├── li (含 #icon-base-info-work) > .time → 工作时间
├── li (无图标) > .time → 工作时间
└── li (含 #icon-base-info-edu) > .time → 教育时间
```

**详情列表** (`.work-content`)：
```
├── li (含 #icon-base-info-work) > .value → "公司 · 职位"
├── li (无图标) > .value → "公司 · 职位"
└── li (含 #icon-base-info-edu) > .value → "学校 · 专业 · 学历"
```

**匹配规则**：时间列表和详情列表的 `li` 按顺序一一对应，通过图标区分工作/教育。

### 3. 职位信息 (`.position-content`)

```
├── .job-content
│   ├── .label (沟通职位：)
│   └── .value > .position-name → 沟通职位
└── .position-item.expect
    ├── .label (期望：)
    └── .value.job → "城市 · 职位 薪资"
```

## 提取脚本

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

## 错误处理

### 禁止行为

LLM 在提取过程中**禁止**：
- 自行编写新的提取脚本
- 修改选择器
- 尝试"检查页面结构"后重写逻辑
- 分析错误原因或尝试"优化脚本"

### 唯一允许的错误处理：重试

当提取返回任何错误（包括 `Uncaught`、脚本执行异常等）时：

1. 等待 500ms
2. 重新执行点击：`document.querySelectorAll('.geek-item')[i].click()`
3. 等待 300ms
4. 再次执行**本文件定义的提取脚本**（禁止修改）
5. 仍失败则返回空对象 `{}`，继续下一个

**注意**：单字段缺失不是错误，直接省略该字段即可。错误仅指脚本执行层面的异常。

## 完整输出格式

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
    }
  ]
}
```

## 参数规范

沿用 v2 的数量参数规范：

| 属性 | 值 |
|------|-----|
| 默认值 | 5 |
| 最小值 | 1 |
| 最大值 | 20 |

## 改动文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `references/site-patterns/zhipin.com.md` | 更新 | 替换为新的提取脚本和输出格式 |

## 已知限制

1. **需要登录态**：未登录时页面重定向到登录页
2. **详情面板需点击触发**：基本信息不在列表卡片中
3. **DOM 更新延迟**：点击后需等待 300-500ms
4. **候选人列表使用虚拟滚动**：首屏加载约 20 条
5. **数量上限**：单次最多提取 20 个候选人
