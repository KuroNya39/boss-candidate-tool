---
title: 岗位描述（JD）提取与评分集成
date: 2026-04-28
status: approved
---

# 岗位描述（JD）提取与评分集成

## 背景

当前评分系统中，LLM 岗位相关性评分只基于岗位名称（如"AI应用开发工程师"），信息有限。Boss 直聘详情面板中，点击候选人求职岗位名称可弹出完整的岗位描述（JD），包含技术要求、职责等详细信息。将 JD 纳入评分可大幅提升匹配度评估的精准性。

## 目标

1. 在提取候选人时同时提取岗位描述（JD），同一岗位只提取一次
2. LLM 评分时同时传入 JD + 简历文本，替代仅用岗位名称的方式

## 设计

### JD 提取

**时机**：在 `extract-candidates-full.mjs` 中，提取基础信息之后、打开在线简历之前

**流程**：
1. 从 `positionInfo.appliedJob` 获取岗位名称
2. 检查缓存 `Map<jobName, jdData>`，如果已缓存则直接复用
3. 未缓存：点击 `.position-name` → 等待弹窗 → 提取 JD → 关闭弹窗 → 存入缓存
4. 将 JD 写入候选人数据的 `jobDescription` 字段

**弹窗提取逻辑**：
- 点击 `.position-name` 打开弹窗
- 从 `.job-details-dialog` 提取：
  - `jobName`：岗位名称
  - `salary`：薪资范围
  - `jobDescription`：JD 全文（要求+职责）
  - `tags`：标签列表
- 关闭弹窗：点击 `.boss-popup__close`

**缓存策略**：
- 内存中的 `Map`，按 `appliedJob` 文本去重
- 同一岗位名称只提取一次JD
- 提取结果同时写入候选人数据

**候选人数据新增字段**：
```json
{
  "jobDescription": {
    "jobName": "AI应用开发工程师",
    "salary": "15-22K 15薪",
    "description": "1. 熟悉RAGFlow... 职责：1. 参与公司智能客服平台...",
    "tags": ["深圳", "本科", "1-3年"]
  }
}
```

### LLM 评分集成

**SKILL.md 中 LLM 评分 prompt 更新**：

有JD时：
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

无JD时：沿用原有 prompt（只用岗位名称）

### Excel 导出

- `export-candidates.mjs` 新增 `jobDescription` 列，显示 JD 摘要（截断到前100字）
- 位置：在"岗位评语"列之后

### 脚本改动

**`extract-candidates-full.mjs`**：
- 新增 `extractJobDescription(targetId)` 函数
- 在主流程中，提取基础信息后调用，带缓存
- 注意：点击岗位名称弹窗可能不存在（某些页面结构不同），需容错

**`export-candidates.mjs`**：
- FIELD_CONFIG 新增 `jobDescription` 字段
- DEFAULT_FIELDS 新增 `jobDescription`

**`SKILL.md`**：
- 更新 LLM 评分 prompt，区分有JD/无JD两种情况

## MVP 范围

- JD 提取（带缓存）集成到提取脚本
- LLM 评分 prompt 支持JD输入
- Excel 新增JD列
- 不做：JD单独提取脚本、JD关键词自动提取
