# 候选人筛选评分设计（纯脚本 v1）

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1 | 2026-04-23 | 初版设计（含 LLM 规则预留） |
| v1.1 | 2026-04-23 | 简化为纯脚本版本：去掉 LLM 规则、riskFlags；偏移修正改为 rawVisibleText 单源 |

## 背景

Boss 直聘候选人提取功能已完成，结果保存到 `output/zhipin-candidates.json`（40 个候选人，完整结构）。用户需要根据筛选条件对候选人进行评分和过滤。

## 目标

- 实现纯脚本筛选评分，不引入 LLM 参与判断
- MVP 输出 `scored-candidates.json`，不做 Excel 导出
- 不改动浏览器抓取逻辑

## 方案：规则配置文件 + 评分脚本

用户在对话中描述筛选条件，Agent 生成/更新规则配置，执行评分脚本。不自动触发。

## 规则配置结构

规则配置存放在 `config/filter-rules.json`：

```json
{
  "name": "AI应用开发工程师-初筛",
  "version": "1.0",
  "rules": {
    "mustHave": [
      {
        "field": "basicInfo.education",
        "operator": ">=",
        "value": "本科",
        "reason": "学历要求本科及以上"
      }
    ],
    "preferred": [
      {
        "field": "basicInfo.workYears",
        "operator": ">=",
        "value": "2年",
        "weight": 20,
        "reason": "2年以上工作经验加分"
      },
      {
        "field": "positionInfo.expectCity",
        "operator": "equals",
        "value": "深圳",
        "weight": 10,
        "reason": "期望城市匹配加分"
      },
      {
        "field": "workExperience[].position",
        "operator": "contains",
        "value": "Java",
        "weight": 15,
        "reason": "Java经验加分"
      }
    ],
    "exclude": [
      {
        "field": "basicInfo.education",
        "operator": "in",
        "value": ["高中", "中专", "初中"],
        "reason": "学历不符合最低要求"
      }
    ],
    "threshold": 60
  }
}
```

### 规则字段说明

| 字段 | 说明 |
|------|------|
| `field` | 候选人 JSON 中的路径，用点号分隔；数组遍历用 `[]` 标记（如 `workExperience[].position`） |
| `operator` | 比较操作符 |
| `value` | 比较值 |
| `weight` | 仅 preferred 规则，满足时加的分值 |
| `reason` | 人类可读的规则说明，输出到 reasons 中 |

### 操作符

| 操作符 | 适用类型 | 说明 | 示例 |
|--------|----------|------|------|
| `equals` | 字符串/数字 | 精确匹配 | `expectCity` equals "深圳" |
| `contains` | 字符串/数组 | 包含匹配 | `position` contains "Java" |
| `in` | 字符串 | 值在列表中 | `education` in ["高中","中专"] |
| `>=` / `>` / `<=` / `<` | 可排序值 | 比较 | `education` >= "本科", `workYears` >= "2年" |
| `regex` | 字符串 | 正则匹配 | `school` regex "985\|211" |
| `exists` | 任意 | 字段存在即满足 | `workExperience` exists |

### 数组字段匹配

`workExperience[].position` 表示遍历数组中每个元素的 `position` 字段，**任一匹配即满足**。适用于关键词命中场景（如"Java"、"支付"）。

## 字段解析：rawVisibleText 单源

`basicInfo` 字段因在线状态标签可能偏移（如 `workYears` 显示为 "24岁"，`education` 显示为 "2年"）。评分脚本从 `rawVisibleText` 作为唯一真实来源提取学历和工作年限。

### rawVisibleText 格式

每个候选人的 rawVisibleText 格式一致：

```
姓名 \n[活跃状态]\n年龄\n工作年限\n学历\n ...
```

示例：
```
"田信坤 \n刚刚活跃\n25岁\n3年\n本科\n ..."
"林晓楠 \n24岁\n27年应届生\n硕士\n ..."
```

### 提取规则

**学历**：在 rawVisibleText 中按已知等级词匹配（博士 > 硕士 > 本科 > 大专 > 中专 > 高中），取最高匹配。

**工作年限**：
- 匹配 `\n(\d+)年\n` 或 `\n(\d+)年应届生\n`，提取数字
- 应届生（如 "26年应届生"）解析为 0 年
- "1年以内" 解析为 0.5 年
- "10年以上" 解析为 10 年

**学历排序**（脚本内置）：高中 < 中专 < 大专 < 本科 < 硕士 < 博士

### 字段解析注册表

| field 路径 | 解析方式 |
|------------|----------|
| `basicInfo.education` | 从 rawVisibleText 提取学历 |
| `basicInfo.workYears` | 从 rawVisibleText 提取工作年限 |
| 其他路径 | 直接用点号路径取值 |

## 评分逻辑

### 评分流程

```
候选人数据 + 规则配置
        │
        ▼
  ┌─ exclude 检查 ──→ 命中任一 → passed=false, score=0
  │
  ├─ mustHave 检查 ──→ 任一不满足 → passed=false, score=0
  │
  ├─ preferred 计算 ──→ 满足的规则累加 weight → 得到 rawScore
  │
  ├─ 归一化 ──→ score = rawScore / totalWeight * 100
  │
  └─ threshold 判定 ──→ score >= threshold → passed=true
```

### 关键设计

1. **exclude 优先级最高**：命中 exclude 直接否决，不继续计算
2. **mustHave 是门槛**：全部满足才进入评分，否则 `passed=false`
3. **preferred 是加分项**：每条满足加对应 `weight`，不满足不扣分
4. **分数归一化到 0-100**：`score = (满足的 weight 之和 / 所有 preferred 的 weight 之和) * 100`
5. **threshold 默认 60**：归一化后的分数达到 threshold 才算 passed

### recommendationLevel

基于 score 分档：

| 等级 | 分数范围 |
|------|----------|
| `strong` | 80-100 |
| `good` | 60-79 |
| `fair` | 40-59 |
| `weak` | 0-39 |

`passed=false` 的候选人也有 recommendationLevel，方便用户参考。

## 输出结构

`output/scored-candidates.json`：

```json
{
  "filterName": "AI应用开发工程师-初筛",
  "filterVersion": "1.0",
  "filteredAt": "2026-04-23T10:30:00+08:00",
  "inputFile": "output/zhipin-candidates.json",
  "totalCandidates": 40,
  "passedCount": 25,
  "threshold": 60,
  "candidates": [
    {
      "index": 1,
      "name": "崔宁",
      "basicInfo": { "name": "崔宁", "age": "27岁", "workYears": "4年", "education": "本科" },
      "workExperience": [],
      "educationExperience": [],
      "positionInfo": {},
      "score": 75,
      "passed": true,
      "reasons": [
        { "rule": "学历要求本科及以上", "type": "mustHave", "result": "pass" },
        { "rule": "2年以上工作经验加分", "type": "preferred", "result": "pass", "weight": 20 },
        { "rule": "期望城市匹配加分", "type": "preferred", "result": "fail", "weight": 10 }
      ],
      "recommendationLevel": "good"
    }
  ]
}
```

### 设计要点

1. **候选人原始数据完整保留**：方便后续查看，不需要回溯源文件
2. **candidates 按 score 降序排列**：最匹配的排最前
3. **passed=false 的候选人也包含**：用户可能想看为什么没过
4. **reasons 逐条记录**：每条规则的判定结果，透明可审计

## 执行流程

1. 用户在对话中描述筛选条件
2. Agent 生成或更新 `config/filter-rules.json`
3. 执行评分脚本：
   ```bash
   node scripts/score-candidates.mjs \
     --input output/zhipin-candidates.json \
     --rules config/filter-rules.json \
     --output output/scored-candidates.json
   ```
4. 保存结果到 `output/scored-candidates.json`
5. 向用户展示筛选结果摘要

## 评分脚本

`scripts/score-candidates.mjs`：

**输入**：候选人 JSON 文件路径 + 规则配置 JSON 文件路径
**输出**：`scored-candidates.json` 到 output 目录

**脚本职责**：
- 从 rawVisibleText 提取学历和工作年限（偏移修正）
- 解析 field 路径，从候选人数据中取值（含数组遍历）
- 执行 operator 比较（equals, contains, in, >=, >, <=, <, regex, exists）
- 计算 score、passed、recommendationLevel
- 按 score 降序排列输出

## 改动文件

| 文件 | 操作 | 说明 |
|------|------|------|
| `scripts/score-candidates.mjs` | 新增 | 评分脚本 |
| `config/filter-rules.json` | 新增 | 默认规则配置（示例） |
| `SKILL.md` | 更新 | 新增候选人筛选评分章节 |

## MVP 范围

**包含**：
- 规则配置 JSON 格式（mustHave, preferred, exclude, threshold）
- 评分脚本（字段级规则，脚本可处理的操作符）
- rawVisibleText 单源字段解析（偏移修正）
- 数组字段遍历匹配（如 workExperience[].position）
- 输出 scored-candidates.json

**不包含**：
- Excel 导出
- LLM 规则执行（纯脚本，不引入 LLM 判断）
- riskFlags 检测逻辑
- 规则配置交互式编辑