# SKILL.md 评分流程合规性改进 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 解决 Claude Code 执行评分流程时的三个偏离问题（prompt 偏离、未分批写入、未报告进度），通过 prompt 独立文件 + SKILL.md 步骤式重构来提升合规性。

**Architecture:** 评分 prompt 从 SKILL.md 提取到独立文件，SKILL.md 改为强制引用 + 步骤式 checklist，分批写入改为 10 人一批。

**Tech Stack:** 纯文件变更，无代码改动

---

### Task 1: 创建评分 prompt 独立文件

**Files:**
- Create: `config/scoring-prompt-with-jd.txt`
- Create: `config/scoring-prompt-no-jd.txt`

- [ ] **Step 1: 创建有岗位描述的 prompt 文件**

创建 `config/scoring-prompt-with-jd.txt`，内容为：

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

- [ ] **Step 2: 创建无岗位描述的 prompt 文件**

创建 `config/scoring-prompt-no-jd.txt`，内容为：

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

- [ ] **Step 3: 验证文件内容正确**

确认两个文件内容与 SKILL.md 中现有 prompt 完全一致（仅提取，不修改措辞）。

---

### Task 2: 重构 SKILL.md 评分流程章节

**Files:**
- Modify: `SKILL.md`

- [ ] **Step 1: 替换默认评分流程中的 LLM 评分步骤**

将 SKILL.md 第 176-214 行（从"3. **LLM 岗位相关性评分**"到"每评完 5 人，向用户报告进度"）替换为步骤式 checklist：

```markdown
3. **LLM 岗位相关性评分**：

   <MUST> 以下步骤必须逐一执行，不得跳过、合并或简化。评分 prompt 必须逐字使用 config/ 下的模板文件，不得改写或用自己的措辞替代。 </MUST>

   **Step 3.1**: 读取 `output/scored-candidates.json`，获取候选人列表（注意：列表在 `d.candidates` 字段中，不是 `d` 本身）

   **Step 3.2**: 判断是否有岗位描述 — 检查 `d.candidates[0].jobDescription.description` 是否存在

   **Step 3.3**: 读取对应的 prompt 模板文件：
   - 有岗位描述 → 读取 `config/scoring-prompt-with-jd.txt`
   - 无岗位描述 → 读取 `config/scoring-prompt-no-jd.txt`

   **Step 3.4**: 逐个评分候选人：
   - 对有 `resumeText` 的候选人：使用 prompt 模板（替换 `{positionName}`/`{jobDescription.description}` 和 `{resumeText}`）进行评分
   - 对无 `resumeText` 的候选人：直接设置 `jobRelevanceScore = 0`，`jobRelevanceComment = "无在线简历"`（不消耗 LLM 调用）

   **Step 3.5**: 每评完 10 人，执行以下操作：
   - 更新 `d.candidates` 中已评分候选人的 `jobRelevanceScore` 和 `jobRelevanceComment`
   - 将整个 `d` 对象写回 `output/scored-candidates.json`
   - 向用户报告："已评分 X/Y 人"
```

- [ ] **Step 2: 更新条件筛选流程中的 LLM 评分引用**

将 SKILL.md 第 233 行"3. **LLM 岗位相关性评分**：同默认评分流程第 3 步"保持不变（它已经引用默认流程的步骤）。

- [ ] **Step 3: 验证 SKILL.md 格式正确**

快速浏览修改后的 SKILL.md，确认：
- markdown 格式、缩进、代码块无误
- `<MUST>` 标签正确闭合
- 步骤编号连贯
- 条件筛选流程的引用仍然有效

---

### Task 3: 端到端验证

**Files:**
- None (验证任务)

- [ ] **Step 1: 确认 prompt 文件可读取**

```bash
cat config/scoring-prompt-with-jd.txt
cat config/scoring-prompt-no-jd.txt
```

Expected: 两个文件内容正确，包含 `{positionName}`/`{jobDescription.description}` 和 `{resumeText}` 占位符。

- [ ] **Step 2: 确认 SKILL.md 评分流程可理解**

阅读 SKILL.md 中修改后的评分流程，确认步骤清晰、无歧义、`<MUST>` 标签醒目。

- [ ] **Step 3: Commit**

```bash
git add config/scoring-prompt-with-jd.txt config/scoring-prompt-no-jd.txt SKILL.md
git commit -m "fix: 评分 prompt 独立文件 + SKILL.md 步骤式重构，提升 LLM 评分合规性"
```
