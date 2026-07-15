---
title: 候选人评分系统 V2 — 默认评分 + 在线简历岗位相关性
date: 2026-04-27
status: approved
---

# 候选人评分系统 V2 设计

## 背景

当前评分系统（`score-candidates.mjs`）是纯规则驱动，必须指定 `--rules` 配置文件，且只保留 passed 候选人。现已实现在线简历提取（`resumeText`），需要将简历内容纳入评分考量，并支持无筛选条件时的默认评分模式。

## 目标

1. **默认评分模式**：用户未给筛选条件时，对所有候选人评分，不筛掉任何人，Excel 按分数降序排列
2. **在线简历纳入评分**：通过 LLM 阅读简历文本，评估岗位相关性
3. **条件筛选模式**：用户给了筛选条件时，沿用现有规则 + LLM 岗位相关性分，结果体现 passed

## 评分模型

**总分 = 学历分(0-20) + 工作年限分(0-30) + 岗位相关性分(0-50)**

### 学历分（脚本计算）

| 学历 | 分数 |
|------|------|
| 博士 | 20 |
| 硕士 | 17 |
| 本科 | 14 |
| 大专 | 8 |
| 中专 | 4 |
| 高中 | 4 |
| 未知 | 0 |

### 工作年限分（脚本计算）

- 公式：`min(years * 3, 30)`
- 示例：0年=0, 3年=9, 5年=15, 10年+=30
- 应届生(0年)额外 +3 分

### 岗位相关性分（LLM 评分）

- LLM 阅读简历文本，结合目标岗位，给出 0-50 分
- 同时输出简短评语（一句话）
- 无 `resumeText` 的候选人：分数=0，评语="无在线简历"

## 两种模式

### 默认评分（无筛选条件）

触发：用户说"帮我评分"、"给这些候选人打分"等

1. 读取 `output/zhipin-candidates.json`
2. 确定目标岗位：优先用户指定，否则从 `positionInfo.appliedJob` 提取
3. 运行 `score-candidates.mjs --default`，算学历分+年限分
4. Claude Code 逐个阅读 `resumeText`，LLM 给出岗位相关性分+评语
5. 合并总分：`totalScore = educationScore + workYearsScore + jobRelevanceScore`
6. 导出 Excel，包含所有候选人，按总分降序

### 条件筛选（有筛选条件）

触发：用户说"帮我筛选本科以上、2年经验的"等

1. 生成规则配置 `config/filter-rules.json`（沿用现有逻辑）
2. 运行 `score-candidates.mjs --rules config/filter-rules.json`
3. Claude Code 逐个阅读 `resumeText`，LLM 给出岗位相关性分+评语
4. 合并总分
5. 导出 Excel，`passed` 列反映规则筛选结果

## 执行流程

### Claude Code 主导（方案 B：单阶段）

Claude Code 作为编排者，协调脚本和 LLM 评分：

```
用户指令 → Claude Code 读取数据 → 脚本算基础分 → LLM 补岗位分 → 合并 → 导出 Excel
```

### LLM 评分 Prompt

```
你是一位技术招聘专家。请根据以下候选人简历，评估其与目标岗位的匹配度。

目标岗位：{positionName}

候选人简历：
{resumeText}

请给出：
1. 岗位相关性分数（0-50分）：基于技术栈匹配度、项目经验相关性、行业经验等
2. 简短评语（一句话）：说明评分理由

请严格按以下 JSON 格式输出：
{"jobRelevanceScore": <0-50>, "jobRelevanceComment": "<评语>"}
```

### 批量处理

- 逐个候选人评分，每次一个 LLM 调用
- 每评完 5 人，将结果写入 JSON 文件（防丢失）
- 进度报告：每评完 5 人向用户报告进度

## 脚本改动

### `score-candidates.mjs`

- 新增 `--default` 模式：不需要 `--rules`，用内置默认规则算学历分+年限分
- 新增 `--position` 参数：传入目标岗位名称（写入输出 JSON）
- 输出新增字段：
  - `educationScore`：学历分(0-20)
  - `workYearsScore`：工作年限分(0-30)
  - `baseScore`：基础总分(0-50)
- 默认模式下：所有候选人 `passed = true`，不筛掉任何人
- 条件筛选模式下：沿用现有 exclude/mustHave/preferred 逻辑，基础分计算方式不变

### `export-candidates.mjs`

- 新增列：
  - `educationScore`：学历分
  - `workYearsScore`：年限分
  - `jobRelevanceScore`：岗位相关性分
  - `jobRelevanceComment`：岗位评语
- 默认模式下：不显示 `passed` 列（或显示为"-"）
- 条件筛选模式下：显示 `passed` 列

### `SKILL.md`

- 更新候选人筛选评分章节，区分默认评分和条件筛选两种流程
- 默认评分流程写入 SKILL.md 供 Claude Code 参考

## Excel 输出格式

### 默认评分模式

| 姓名 | 学历 | 学历分 | 工作年限 | 年限分 | 岗位相关性分 | 岗位评语 | 总分 | 推荐等级 |
|------|------|--------|----------|--------|-------------|----------|------|----------|

### 条件筛选模式

| 姓名 | 学历 | 学历分 | 工作年限 | 年限分 | 岗位相关性分 | 岗位评语 | 总分 | 是否通过 | 推荐等级 | 推荐理由 |
|------|------|--------|----------|--------|-------------|----------|------|----------|----------|----------|

## 第一版（MVP）范围

- `score-candidates.mjs` 新增 `--default` 模式
- `export-candidates.mjs` 新增列支持
- SKILL.md 更新默认评分流程
- LLM 评分由 Claude Code 在对话中执行（非脚本集成）
- 不做：配置文件映射、本地模型调用、批量 LLM 评分优化
