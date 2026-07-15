---
title: SKILL.md 评分流程合规性改进
date: 2026-04-28
status: approved
---

# SKILL.md 评分流程合规性改进设计

## 背景

Claude Code 在执行 SKILL.md 中的候选人评分流程时，存在三个偏离：
1. **Prompt 偏离**：未使用 SKILL.md 定义的评分 prompt，而是用自己的措辞
2. **未分批写入**：未按"每 N 人写入文件"的要求分批保存，而是一次性写入
3. **未报告进度**：未在评分过程中向用户报告进度

根因：SKILL.md 的指令是"描述性"的，Claude 倾向于理解意图后灵活执行，而非逐字遵守。

## 目标

1. 评分 prompt 必须被逐字使用，不得改写
2. 评分过程中分批写入文件（防丢失）并报告进度
3. 保持 Claude 对话中评分的模式，不引入 API 调用脚本

## 改动

### 1. 评分 Prompt 独立文件

将 SKILL.md 中的两套评分 prompt 提取到独立文件：

- `config/scoring-prompt-with-jd.txt`：有岗位描述时的 prompt
- `config/scoring-prompt-no-jd.txt`：无岗位描述时的 prompt

**文件内容**：

`config/scoring-prompt-with-jd.txt`：
```
你是一位技术招聘专家。请根据以下岗位描述和候选人简历，评估其与目标岗位的匹配度。

岗位描述：
{jobDescription.description}

候选人简历：
{resumeText}

请给出：
1. 岗位相关性分数（0-50分）：基于技术栈匹配度、项目经验相关性、行业经验等
2. 简短评语（一句话）：说明评分理由

请严格按以下 JSON 格式输出：
{"jobRelevanceScore": <0-50>, "jobRelevanceComment": "<评语>"}
```

`config/scoring-prompt-no-jd.txt`：
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

### 2. SKILL.md 评分流程重构

将 SKILL.md 中"候选人评分"章节的 LLM 评分步骤从描述性改为步骤式 checklist，并加入 `<MUST>` 约束标记。

关键改动：

- 评分 prompt 不再内联在 SKILL.md 中，改为强制引用独立文件
- 分批写入从 5 人改为 10 人一批
- 步骤拆分为明确的 Step 1-5，每步一个动作

### 3. 分批写入策略

- **批次大小**：10 人
- **写入方式**：更新 `d.candidates` 中已评分候选人的 `jobRelevanceScore` 和 `jobRelevanceComment`，然后将整个 `d` 对象写回 `output/scored-candidates.json`
- **进度报告**：每批写入后向用户报告"已评分 X/Y 人"
- **无 resumeText 的候选人**：直接设置 `jobRelevanceScore=0`, `jobRelevanceComment="无在线简历"`，不消耗 LLM 调用

## 不做的事

- 不引入 API 调用脚本
- 不改变评分维度和分值
- 不改变其他流程步骤（脚本评分、Excel 导出等）
- 不改变条件筛选模式的流程

## 文件变更清单

| 文件 | 操作 |
|------|------|
| `config/scoring-prompt-with-jd.txt` | 新建 |
| `config/scoring-prompt-no-jd.txt` | 新建 |
| `SKILL.md` | 修改：重构评分流程章节 |
