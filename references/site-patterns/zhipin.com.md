---
domain: zhipin.com
aliases: [Boss直聘, BOSS直聘, boss直聘, boss]
outputFile: zhipin-candidates.json
updated: 2026-04-23
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
| 默认值 | 10 |
| 最小值 | 1 |
| 最大值 | 无上限（使用 --all 提取全部） |

**参数形式**：
- `--count N`：提取前 N 个候选人（N >= 1，无上限）
- `--all` 或 `--count 0`：提取全部候选人（自动滚动发现所有候选人）
- `--resume`：从上次中断处继续提取

**边界处理**：
- 用户未指定数量 → 使用默认值 10
- 用户指定数量 < 1 且不为 0 → 使用最小值 1
- 用户指定数量 = 0 → 提取全部（等同于 --all）
- "获取全部候选人" → 使用 --all

**虚拟滚动处理**：
- 沟通页候选人列表使用虚拟滚动，DOM 中仅保留约 20 个 .geek-item
- 全量提取时，脚本自动逐步滚动列表，收集所有 geekId
- 终止条件：连续 3 次滚动无新 geekId 发现，或滚动位置不再变化

**数量解析示例**：
- "读取前 10 个候选人" → --count 10
- "提取候选人信息" → --count 10（默认）
- "获取全部候选人" → --all
- "提取所有候选人" → --all

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
>
> **禁止行为**：
> - ❌ 不要执行 `document.querySelector` 检查页面状态
> - ❌ 不要查看 DOM 结构
> - ❌ 不要分析"为什么失败"
> - ❌ 不要尝试"修复"选择器

当提取返回脚本执行错误时（仅限 `Uncaught` 等异常，**不包括字段缺失**）：
1. 等待 500ms
2. 重新执行点击：`document.querySelectorAll('.geek-item')[i].click()`
3. 等待 300ms
4. 再次执行**本文件定义的提取脚本**（禁止修改）
5. 仍失败则返回空对象 `{}`，继续下一个

## 有效模式

### ⚠️ 强制约束（违反将导致提取失败）

**以下行为严格禁止**：
- ❌ 禁止自行编写新的提取脚本
- ❌ 禁止修改选择器
- ❌ 禁止尝试"检查页面结构"后重写逻辑
- ❌ 禁止分析错误原因或尝试"优化脚本"
- ❌ 禁止因为字段缺失而报错或重试
- ❌ 禁止执行 `document.querySelector` 等检查页面状态的脚本
- ❌ 禁止在提取失败后"查看当前页面 DOM"

**唯一允许的行为**：
- ✅ 严格使用本文件定义的脚本和流程
- ✅ 点击脚本返回 `undefined` 是正常的，继续执行
- ✅ 遇到 `Uncaught` 错误时仅按重试机制执行，不分析原因

### 读取沟通页前 N 个候选人详细信息（全量结构化输出）

> **重要**：必须严格使用本文件提供的脚本和流程。禁止自行编写或修改提取逻辑。如遇问题，仅允许使用下方定义的重试机制，不得重写脚本。

**入口**：直接导航到 `https://www.zhipin.com/web/chat`

**提取流程**（严格按此执行，禁止修改）：

1. 解析用户请求，确定提取数量 N（应用边界规则）
2. 循环 N 次（索引 0 到 N-1）：
   a. 执行点击脚本：`document.querySelectorAll('.geek-item')[i].click()`
   b. 等待 1000ms
   c. 执行**本文件定义的提取脚本**
   d. 若返回**脚本执行错误**（仅限 `Uncaught` 等异常）：
      - **不要分析错误原因**
      - **不要尝试修复脚本**
      - 等待 500ms
      - 重新执行点击脚本
      - 等待 1000ms
      - 再次执行提取脚本
      - 仍失败则返回 `{ "index": i+1 }`（空对象）
   e. 记录结果，继续下一个
3. 汇总输出 JSON

**点击候选人脚本**（唯一可用，禁止修改）：

```javascript
document.querySelectorAll('.geek-item')[i].click()
```

其中 `i` 为索引（0 到 N-1）。

> **重要**：此脚本返回 `undefined` 是正常行为，表示点击已执行。**不是错误，不要调试，继续执行提取脚本。**

**提取详情脚本**（点击后等待 1000ms，再执行。唯一可用，禁止修改）：

```javascript
(function() {
  // 安全文本提取函数
  function safeText(el) {
    if (!el || !el.textContent) return '';
    return el.textContent.trim();
  }

  const result = {};

  // ===== 兜底：始终提取原始可见文本 =====
  try {
    const container = document.querySelector('.base-info-single-container');
    if (container) {
      result.rawVisibleText = container.innerText;
    }
  } catch (e) {}

  // ===== 基本信息 =====
  try {
    const basicDetail = document.querySelector('.base-info-single-detial');
    if (basicDetail) {
      const basicInfo = {};
      const divs = Array.from(basicDetail.querySelectorAll(':scope > div'))
        .filter(d => !d.classList.contains('active-time'));

      // 姓名
      const nameEl = basicDetail.querySelector('.base-name');
      const nameText = safeText(nameEl);
      if (nameText) {
        basicInfo.name = nameText;
      }

      // 年龄、工作年限、学历（过滤掉在线状态标签后，按顺序的第1、2、3个div）
      if (divs.length >= 2) {
        const ageText = safeText(divs[1]);
        if (ageText) basicInfo.age = ageText;
      }
      if (divs.length >= 3) {
        const workYearsText = safeText(divs[2]);
        if (workYearsText) basicInfo.workYears = workYearsText;
      }
      if (divs.length >= 4) {
        const eduText = safeText(divs[3]);
        if (eduText) basicInfo.education = eduText;
      }

      if (Object.keys(basicInfo).length > 0) {
        result.basicInfo = basicInfo;
      }
    }
  } catch (e) {}

  // ===== 工作与教育经历 =====
  try {
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

        const time = safeText(timeEl);
        const detail = safeText(detailEl);

        // 判断是工作还是教育：通过 time-content li 中 svg 元素的 className
        const svgEl = timeLi.querySelector('svg');
        const svgClass = svgEl ? svgEl.className.baseVal : '';
        const isEducation = svgClass.includes('shool');

        if (isEducation) {
          // 教育：学校 · 专业 · 学历
          const parts = detail ? detail.split('\u00b7').map(p => p.trim()) : [];
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
          const parts = detail ? detail.split('\u00b7').map(p => p.trim()) : [];
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
  } catch (e) {}

  // ===== 职位信息 =====
  try {
    const positionContent = document.querySelector('.position-content');
    if (positionContent) {
      const positionInfo = {};

      // 沟通职位
      const appliedJobEl = positionContent.querySelector('.position-name');
      const appliedJobText = safeText(appliedJobEl);
      if (appliedJobText) {
        positionInfo.appliedJob = appliedJobText;
      }

      // 期望
      const expectEl = positionContent.querySelector('.value.job');
      const expectText = safeText(expectEl);
      if (expectText) {
        // 格式：城市 · 职位 薪资
        const expectParts = expectText.split('\u00b7').map(p => p.trim());
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
  } catch (e) {}

  return result;
})();
```

**单个候选人输出格式**：

```json
{
  "rawVisibleText": "于自豪\n24岁\n2年\n本科\n2024.03-2026.03\n元展科技（佛山）有限公司\n自然语言处理算法...",
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
  "rawVisibleText": "张三\n28岁\n...\nXX公司...",
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

**极端情况输出**（所有结构化提取都失败）：

```json
{
  "rawVisibleText": "于自豪\n24岁\n2年..."
}
```

**完整输出格式**：

```json
{
  "requested": 5,
  "actual": 5,
  "totalScanned": 5,
  "extractedAt": "2026-04-27T10:00:00.000Z",
  "candidates": [
    {
      "index": 1,
      "geekId": "755961891",
      "rawVisibleText": "于自豪\n24岁\n2年\n本科...",
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
      "geekId": "665734008",
      "rawVisibleText": "李四\n26岁\n3年\n硕士...",
      "basicInfo": { "name": "李四", "age": "26岁", "workYears": "3年", "education": "硕士" }
    }
  ]
}
```

全量提取输出（--all 模式）：

```json
{
  "requested": "all",
  "actual": 150,
  "totalScanned": 150,
  "extractedAt": "2026-04-27T10:30:00.000Z",
  "candidates": [
    // ... 150 个候选人信息
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
   - 执行点击脚本，返回 `undefined` 是正常的（表示点击已执行）
   - 等待 1000ms
   - 执行提取脚本
   - 若返回 `Uncaught` 错误：等待 500ms → 重新点击 → 等待 1000ms → 再次提取（不要分析原因，不要检查页面）
   - 记录结果
7. 汇总数据，输出 JSON 结果
   - 检查站点经验 frontmatter 是否定义 `outputFile`
   - 若有，保存到 `./output/{outputFile}`
   - 向用户输出完整 JSON 结果，并告知文件路径
8. 关闭 tab：`curl -s "http://localhost:3456/close?target=xxx"`

## 在线简历提取

> 更新于 2026-04-24。在第一轮提取中即完成基础信息 + 在线简历的全量提取。

### 平台特征

- 候选人卡片（`.geek-item`）的 `id` 和 `data-id` 属性包含 **geekId**（如 `id="755961891-0"`），这是稳定的唯一标识，不随列表变化而改变
- 点击详情面板中的“在线简历”按钮会弹出弹窗（非新页面）
- 弹窗内简历通过 **iframe + Canvas** 渲染（反爬措施），无法直接提取 DOM 文本
- Canvas 被标记为 tainted，无法通过 `toDataURL` 导出
- 关闭弹窗后自动回到原候选人详情面板
- 并非所有候选人都有在线简历，部分仅有附件简历或无简历

### geekId 稳定标识

候选人卡片的 `id` 属性格式为 `{geekId}-{n}`，如 `id="755961891-0"`。

提取 geekId：`el.id.split('-')[0]`

通过 geekId 定位候选人：`document.querySelector('[id^="${geekId}-"]')`

此标识不随新求职者插入列表而变化，解决了 index 偏移问题。

### DOM 结构

| 元素 | 选择器 |
|------|--------|
| 候选人卡片 | `.geek-item`（`id` 含 geekId） |
| 在线简历按钮 | `a.btn.resume-btn-online` |
| 简历弹窗容器 | `.resume-detail` |
| Canvas iframe | `.resume-detail iframe` |
| 关闭按钮 | `.dialog-wrap.active .close-btn`（注意：在 `.resume-detail` 外层） |
| 弹窗层级 | `.dialog-wrap.active > .boss-popup__wrapper > .boss-popup__content > .boss-dialog__body > ... > .close-btn` |

### 全量提取脚本（基础信息 + 在线简历）

```bash
# 提取前 20 个候选人
node scripts/extract-candidates-full.mjs --count 20

# 提取全部候选人
node scripts/extract-candidates-full.mjs --all

# 从中断处恢复
node scripts/extract-candidates-full.mjs --all --resume

# 指定输出路径
node scripts/extract-candidates-full.mjs --all --output output/zhipin-candidates.json
```

脚本流程（两阶段提取）：

**阶段 1（扫描）**：逐步滚动列表，收集所有候选人的 geekId + 姓名
- 去重：使用 geekId（稳定标识）避免虚拟滚动重复
- 终止：连续 3 次滚动无新 geekId，或滚动到底部
- 扫描结果缓存到 `output/.scan-cache.json`

**阶段 2（提取）**：逐个处理每个候选人（通过 geekId 精准定位）
1. 滚动使候选人可见 → 点击卡片 → 提取右侧基础信息
2. 点击 `a.btn.resume-btn-online` 打开弹窗
3. 滚动截图 + OCR 提取简历文本（保存为 `resumeText` 字段）
4. 关闭弹窗，保存进度，继续下一个
5. 每 5 人自动保存进度到 `output/.extract-progress.json`
6. 每 50 人额外停顿 30 秒（防风控）

输出 `output/zhipin-candidates.json`（含 resumeText），同时保存单独简历文件到 `output/resumes/{name}-{geekId}.txt`

**可恢复性**（--resume）：
- 扫描结果缓存：`output/.scan-cache.json`
- 提取进度缓存：`output/.extract-progress.json`
- 中断后使用 --resume 可跳过已完成的扫描和提取
- 完成后自动清理缓存文件

## 已知陷阱

- **未登录时**页面会重定向到登录页，提取结果为空对象
- **详情面板需点击触发**：基本信息不在列表卡片中，必须点击进入详情才能获取
- **DOM 更新延迟**：点击后需等待 1000ms 让 Vue 更新详情面板（2026-04-23 修正：300ms 不够，会导致经历和职位信息提取失败）
- **curl 传递特殊字符会被破坏**（2026-04-23）：通过 curl `-d` 传递 JS 脚本时，`·`（U+00B7）和 `#` 等特殊字符会被破坏，导致 `split('·')` 和 `querySelector('[xlink\\:href="#icon-base-info-edu"]')` 失效。解决方案：用 `split('\u00b7')` 代替字面量 `·`，用 `useEl.getAttribute('href').includes('edu')` 代替 CSS 属性选择器
- Bash curl 传递多行 JS 会报错（2026-04-22）：通过 curl -d 传递多行 JavaScript 代码会返回 Uncaught 错误。解决方案：① 压缩成单行；② 或先获取原始文本（如 innerText.substring(0,500)），再本地解析
- **basicInfo 字段偏移已修复**（2026-04-23）：当候选人在线状态标签（“刚刚活跃”、“今日活跃”等）存在时，它作为 `.base-info-single-detial` 的一个 div 子元素（class 为 `active-time`），导致 age/workYears/education 字段偏移。脚本已改为过滤掉 `active-time` div，字段不再偏移
- **字段可能缺失**：部分候选人可能未填写某些信息，字段缺失时自动省略
- 候选人列表使用虚拟滚动，首屏加载约 20 条
- **脚本执行可能返回 `Uncaught` 错误**：这是 CDP 执行异常或时序问题，触发重试机制，不要尝试修复
- **在线简历为 Canvas 渲染**（2026-04-24）：点击”在线简历”弹窗内的内容通过 iframe + Canvas 渲染（反爬措施），无法直接提取 DOM 文本。需通过截图 + OCR 方式获取简历文字内容
- **部分候选人无在线简历**（2026-04-24）：并非所有候选人都有”在线简历”按钮，部分候选人可能仅有附件简历或无简历，脚本会自动跳过
- **虚拟滚动列表**（2026-04-27）：候选人列表使用虚拟滚动，DOM 中仅保留约 20 个 .geek-item。提取全部候选人时需逐步滚动发现所有 geekId，滚动过快可能导致部分候选人未被渲染
- **大量候选人提取耗时**（2026-04-27）：每提取一位候选人（含简历）约需 10-15 秒，500 位候选人约需 80-125 分钟。使用 --resume 可在中断后继续
- **geekId 顺序稳定性**（2026-04-27）：geekId 本身稳定不变，但列表中 geekId 的出现顺序可能因新候选人加入而变化。长时间提取过程中如果有新候选人加入，扫描结果可能与实际列表有差异
