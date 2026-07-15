---
title: 评分速度优化 — 并行子 Agent + 内部小批量
date: 2026-05-13
status: ready for review
---

# 评分速度优化设计

## 背景

当前评分流程中，LLM 岗位相关性评分（0-50 分）是瓶颈。每评一位候选人需要一次独立的 LLM 往返（读模板、替换变量、LLM 评分、自检、写回），20 位候选人需要串行等待 20 次 LLM 回复，墙钟时间过长。

已有约束「单人节奏」是为了保障评分质量（防止 Agent 批量评分导致质量下降），但 20 人的场景下时间代价过高。

## 目标

- 将 20 人 LLM 评分的墙钟时间从~20 次 LLM 往返降到~2-3 次
- 保持评分质量不下降（格式校验、评语结构、违规自检）
- 不引入外部 API 依赖（保持 Claude Code 插件架构）

## 方案：并行子 Agent + 内部小批量

### 核心思路

```
主 Agent（编排者）
├─ 读取 scored-candidates.json
├─ 将候选人分给 N 个子 Agent
├─ 启动 N 个子 Agent（并行）
├─ 等待所有子 Agent 完成
├─ 合并结果，计算最终总分，导出 Excel

每个子 Agent 内部：
├─ 读取分配给自己的候选人子集
├─ 按 3-5 人一批，每批一次 LLM 调用
├─ 写出自己的评分结果文件
```

## 架构设计

### 1. 分组策略

候选人总数 C，子 Agent 数 N：

```
N = clamp(ceil(C / 5), 2, 5)
```

| 候选人 | 子 Agent | 每个子 Agent |
|--------|----------|-------------|
| <=10   | 2        | 3-5 人      |
| 11-15  | 3        | 4-5 人      |
| 16-25  | 4        | 4-6 人      |
| 26+    | 5        | 5-6 人      |

每个子 Agent 内再将候选人按 3-5 人分一批，每批一次 LLM 调用。

### 2. 子 Agent 隔离机制

每个子 Agent 写自己的临时结果文件，避免并发写冲突：

- `tmp/agent-0-results.json`
- `tmp/agent-1-results.json`
- ...

主 Agent 从这些文件读取后合并到 `scored-candidates.json`。

### 3. 合并流程

```
主 Agent:
1. 读取所有 tmp/agent-*-results.json
2. 将每个候选人的 jobRelevanceScore / jobRelevanceComment 合并到
   scored-candidates.json 的对应条目
3. 计算 totalScore = educationScore + workYearsScore + jobRelevanceScore
4. 更新 recommendationLevel
5. 写回 scored-candidates.json
6. 清理 tmp/agent-*-results.json
```

## 子 Agent 内部工作流

### 输入

每个子 Agent 收到：
- 候选人子集（对象列表，含 resumeText 等字段）
- 模板文件路径（with-jd 或 no-jd）
- 目标岗位信息（positionName / jobDescription）
- 自己的 Agent 编号（用于写结果文件）

### 批量评分流程

```
for each batch of 3-5 candidates:
  1. 读取模板文件（config/scoring-prompt-with-jd.txt 或 no-jd.txt）
  2. 将模板中的 {resumeText} 替换为当前批次的候选人简历（逐人填充）
  3. 将模板中的 {positionName} / {jobDescription.description} 替换为目标岗位信息
  4. 向 LLM 发送完整 prompt
  5. LLM 返回本批全部评分
  6. 自检：逐条对照格式约束做自检
  7. 若自检不通过 → 当批重评（最多重试 1 次）
  8. 将结果追加写入 tmp/agent-{n}-results.json
```

### LLM Prompt 格式（一批 3 人示例）

```
你是一位技术招聘专家。请根据以下候选人简历，评估其与目标岗位的匹配度。

注意：工作年限已有独立评分，本评估不考虑工作年限长短的影响。

目标岗位：AI应用开发工程师

=== 候选人 1/3 ===
姓名：张三
简历：
{resumeText_1}

=== 候选人 2/3 ===
姓名：李四
简历：
{resumeText_2}

=== 候选人 3/3 ===
姓名：王五
简历：
{resumeText_3}

请为每位候选人给出：
1. 岗位相关性分数（0-50分）：基于技术栈匹配度、项目经验相关性、行业经验等
2. 简短评语：说明评分理由（技术栈匹配：... | 项目经验相关性：... | 行业经验：...）

请严格按以下 JSON 格式输出（JSON 数组，每人一个对象）：
[
  {"candidateIndex": 0, "jobRelevanceScore": <0-50>, "jobRelevanceComment": "技术栈匹配：... | 项目经验相关性：... | 行业经验：..."},
  {"candidateIndex": 1, "jobRelevanceScore": <0-50>, "jobRelevanceComment": "技术栈匹配：... | 项目经验相关性：... | 行业经验：..."},
  {"candidateIndex": 2, "jobRelevanceScore": <0-50>, "jobRelevanceComment": "技术栈匹配：... | 项目经验相关性：... | 行业经验：..."}
]
```

### 无 resumeText 的处理

不消耗 LLM 调用，直接设置：
- `jobRelevanceScore = 0`
- `jobRelevanceComment = "无在线简历"`
- 立即写入结果文件

## 约束改动（相对当前 SKILL.md）

当前「评分执行硬约束」需要放宽以适应批量模式：

| 当前约束 | 新约束 |
|---------|--------|
| **单人节奏**：一轮最多评 1 人 | **小批量节奏**：一轮最多评 **5 人** |
| **模板现读现用**：每人读一次 | **模板读取一次**，Step 3.2 读入后整轮复用，每批输出填充后的完整 prompt 证明合规 |
| **简历现读现用**：每人实时读取 | **每批实时读取**本批候选人的简历 |
| **单人立即回写**：每人写一次 | **每批写一次**结果文件 |
| **输出格式**：单 JSON | **JSON 数组**，每人一个对象 |
| **违规自检**：不变 | 不变 |
| 评语三段结构、禁用年限描述 | 不变 |

## 错误处理

### 子 Agent 级别

| 错误类型 | 处理方式 |
|---------|---------|
| 子 Agent 超时（>5 分钟） | 主 Agent 跳过该子 Agent，记录错误，继续等待其他 |
| 子 Agent 返回格式错误 | 主 Agent 读取结果文件时做 JSON 校验，格式错误的视为该子 Agent 失败 |
| 子 Agent 完全失败 | 该子 Agent 负责的候选人设置 `jobRelevanceScore = 0, jobRelevanceComment = "评分失败"`，不影响其他子 Agent |

### 单批级别（子 Agent 内部）

| 错误类型 | 处理方式 |
|---------|---------|
| LLM 返回非 JSON | 重试一次，重试前重新发 prompt |
| LLM 返回 JSON 但字段缺失 | 重试一次，在 prompt 末尾附加强调格式要求 |
| 自检不通过 | 当批重评（最多重试 1 次） |

### 合并级别

- 总分计算遇到缺失字段 → 默认 0，不阻断流程
- 候选人出现在多个子 Agent 的结果中 → 以最后写回的为准
- 某个 tmp 文件不存在 → 跳过（视为该子 Agent 未处理）

## 与条件筛选模式的兼容

条件筛选流程（用户给了筛选条件）的 LLM 评分部分与默认评分完全相同：
- 第一步 `score-candidates.mjs --rules` 后输出 scored-candidates.json
- LLM 评分步骤使用同样的并行子 Agent + 内部小批量方案
- 合并总分时同样处理

唯一区别：条件筛选模式的 scored-candidates.json 只有 `passed` 的候选人，候选人数量可能更少，子 Agent 数按实际数量计算。

## 进度报告

主 Agent 在以下节点向用户报告：

1. **启动子 Agent 前**：`"准备并行评分：{C} 位候选人，{N} 个子 Agent，每批 3-5 人"`
2. **子 Agent 完成时**：`"子 Agent {n} 完成：已评 {m} 人"`
3. **全部完成时**：`"LLM 评分完成，准备合并总分"`
4. **合并完成时**：`"评分完成：{C} 人，最高分 {maxScore}，平均分 {avgScore}"`

子 Agent 内部不做进度报告（避免并发输出混乱），由主 Agent 统一汇总。

## SKILL.md 改动

### 需要修改的章节

**「默认评分流程」第 3 步 — LLM 岗位相关性评分**

将 Step 3.1 ~ Step 3.5 替换为：

```
3. **LLM 岗位相关性评分**：

   <MUST 评分执行硬约束（违反任意一条即视为无效评分，必须重评）>
   1. **小批量节奏**：一轮 Agent 回复最多处理 **5 位**候选人。每批 3-5 人，批内逐人在 prompt 中填充简历。
   2. **模板透明**：`config/scoring-prompt-with-jd.txt` 或 `config/scoring-prompt-no-jd.txt` 在 Step 3.2 读取一次，本评分会话内复用。每批产出时**必须输出填充后的完整 prompt 文本**（证明模板被逐字使用、变量已被替换）。
   3. **简历现读现用**：每批从 `scored-candidates.json` 的 `d.candidates` 中实时读取本批候选人的 `resumeText`，禁止复述或总结。
   4. **每批立即回写**：每评完 **一批** 立即追加写入 `tmp/agent-{n}-results.json`，再处理下一批。
   5. **输出格式硬约束**：
      - 严格输出 JSON 数组：`[{"candidateIndex": <索引>, "jobRelevanceScore": <0-50>, "jobRelevanceComment": "..."}]`
      - `candidateIndex` 对应本批内的序号（从 0 开始）
      - 评语三段结构、禁用年限描述（同原有规则）
   6. **违规自检**：每批产出后逐条对照上述 5 条规则做自检并显式声明通过。
   </MUST>

   **Step 3.1**: 读取 `output/scored-candidates.json`，获取候选人列表（`d.candidates`）

   **Step 3.2**: 判断模板类型 — 检查 `d.candidates[0].jobDescription.description` 是否存在

   **Step 3.3**: 计算分组
   - 候选人总数 C
   - 子 Agent 数 N = clamp(ceil(C / 5), 2, 5)
   - 将候选人平均分给 N 个子 Agent

   **Step 3.4**: 并行启动子 Agent
   - 每个子 Agent 的职责（隔离执行，互不影响）：
     - 接收自己的候选人子集
     - 内部按 3-5 人分一批
     - 每批：读取模板 → 填充简历 → 发 LLM → 自检 → 写 `tmp/agent-{n}-results.json`
     - 无 resumeText 的候选人不消耗 LLM 调用
   - 使用 Agent 工具并行启动所有子 Agent

   **Step 3.5**: 等待所有子 Agent 完成，合并结果
   - 读取 `tmp/agent-*-results.json`
   - 合并 `jobRelevanceScore` / `jobRelevanceComment` 到 `d.candidates`
   - 清理临时文件

   **进度报告**：主 Agent 在「启动前」「全部完成后」各报告一次
```

**「条件筛选流程」第 3 步**

同样替换为以上并行子 Agent + 小批量方案（标注"同默认评分流程第 3 步"即可，无需重复内容）。

## 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `SKILL.md` | 修改 | 替换 LLM 评分步骤（Step 3.1~3.5），单人节奏→小批量 + 并行子 Agent |
| `config/scoring-prompt-with-jd.txt` | 不改 | 模板内容不变，填充方式由 prompt 内逐人填充适配 |
| `config/scoring-prompt-no-jd.txt` | 不改 | 同上 |
| `scripts/score-candidates.mjs` | 不改 | 规则评分脚本不变，只改流程编排 |
| `scripts/export-candidates.mjs` | 不改 | 导出脚本不变 |
| `tmp/` | 使用 | 子 Agent 临时结果文件写入此目录 |

## 不做的事

- 不引入外部 API（保持 Claude Code 插件架构）
- 不改动评分维度、分值计算公式、Excel 导出格式
- 不改动规则评分脚本（`score-candidates.mjs`）本身
- 不改动简历提取流程（`fetch-resumes.mjs`）
- 不对无 resumeText 的候选人消耗 LLM 调用
