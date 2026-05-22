# 评分速度优化 — 实施计划

基于设计文档 `docs/superpowers/specs/2026-05-13-scoring-speed-optimization-design.md`

## 文件变更

仅修改 `SKILL.md` 一个文件，涉及 2 处改动。

---

## 改动 1：默认评分流程 Step 3（LLM 岗位相关性评分）

**位置：** SKILL.md 第 176-212 行

**操作：** 替换 Step 3 全部内容（硬约束 `<MUST>` 块 + Step 3.1~3.5）

**旧内容：** 单人节奏约束（每轮 1 人）+ 逐人自检 + 逐人写回 `scored-candidates.json`

**新内容：**

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
   - 将候选人平均分给 N 个子 Agent，每批最多 5 人

   **Step 3.4**: 并行启动子 Agent
   - 每个子 Agent 的职责（隔离执行，互不影响）：
     - 接收自己的候选人子集
     - 内部按 3-5 人分一批
     - 每批：读取模板 → 填充简历 → 发 LLM → 自检 → 追加写入 `tmp/agent-{n}-results.json`
     - 无 resumeText 的候选人不消耗 LLM 调用
   - 使用 Agent 工具并行启动所有子 Agent

   **Step 3.5**: 等待所有子 Agent 完成
   - 读取所有 `tmp/agent-*-results.json`
   - 将 `jobRelevanceScore` / `jobRelevanceComment` 合并到 `d.candidates` 对应条目
   - 清理 `tmp/agent-*-results.json`

   **进度报告**：
   - 启动前：`"准备并行评分：{C} 位候选人，{N} 个子 Agent，每批 3-5 人"`
   - 子 Agent 完成时：`"子 Agent {n} 完成：已评 {m} 人"`
   - 全部完成时：`"LLM 评分完成，准备合并总分"`
```

---

## 改动 2：岗位相关性分说明

**位置：** SKILL.md 第 262 行

**操作：** 更新文字引用

**旧内容：**
```
- **此部分由 Agent 逐位调用模板完成，违反 Step 3.4 的单人节奏或模板透明约束即视为无效评分，须重评**
```

**新内容：**
```
- **此部分由 Agent 在子 Agent 内按批调用模板完成，违反 Step 3.4 的评分约束或模板透明约束即视为无效评分，须重评**
```

---

## 条件筛选流程

**位置：** SKILL.md 第 231 行

**动作：** 不修改。该行已写 `同默认评分流程第 3 步`，默认流程更新后自动生效。

---

## 实施顺序

1. 修改默认评分流程 Step 3（改动 1）
2. 修改岗位相关性分说明文字（改动 2）
3. 确认条件筛选流程部分无需额外修改
4. 验证：重新读取 SKILL.md 确认新旧约束替换完整、无残留
