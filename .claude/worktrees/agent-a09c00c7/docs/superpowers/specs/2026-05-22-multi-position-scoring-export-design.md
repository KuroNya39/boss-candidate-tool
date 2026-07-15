# 多岗位评分与导出设计

## 背景

当前项目仅支持单一岗位场景：提取全部候选人时假设所有候选人申请的是同一个岗位，评分和导出时也不做岗位区分。

实际使用中，一个 Boss 直聘招聘账号可能同时发布多个岗位（如"AI应用开发工程师"、"Java开发"、"产品经理"），同一聊天列表中混合了申请不同岗位的候选人。需要支持：

1. 按岗位区分候选人（提取时已具备数据，仅需下游感知）
2. 模型根据每个候选人对应的岗位 JD 进行评分
3. 一个 Excel 文件中不同 sheet 对应不同岗位

## 设计原则

- **不改变提取阶段**：`positionInfo.appliedJob` 和 `jobDescription` 已在 `zhipin-candidates.json` 中，按人按岗位天然记录
- **最小改动**：只改评分和导出两个下游环节，不改上游提取和整体 pipeline 结构
- **向后兼容**：单岗位场景与现有行为一致

## 数据模型

提取阶段数据无需改动。每条候选人记录天然是一个 `(候选人, 岗位)` 组合：

```json
{
  "geekId": "_550140689",
  "positionInfo": { "appliedJob": "AI应用开发工程师" },
  "jobDescription": { "description": "职位详情..." }
}
```

同一人申请不同岗位时，Boss 直聘会生成不同会话和 `geekId`，数据中表现为独立记录，无需额外去重。

## 改动范围

### 1. 基础评分脚本 `score-candidates.mjs`

**新增 `--position` CLI 参数**

```
# 全部岗位（旧行为）
node scripts/score-candidates.mjs --default --input output/zhipin-candidates.json

# 只评指定岗位
node scripts/score-candidates.mjs --default --position "AI应用开发工程师" --input output/zhipin-candidates.json
```

**实现**：在 `main()` 中，读取 `candidates` 后判断 `opts.position`，如果指定了则按 `positionInfo.appliedJob` 过滤。

### 2. LLM 评分流程 `SKILL.md`

当前流程（Step 3）假设全部候选人共享一个 JD（取 `candidates[0].jobDescription.description`），改为分组循环。

**原流程**：
1. 读取 `scored-candidates.json`
2. 取 `candidates[0].jobDescription.description` 作为 JD
3. 全部候选人平均分给子 Agent → 每批 3-5 人 → 填充模板 → 评分

**新流程**：
1. 读取 `scored-candidates.json`
2. 统计 `positionInfo.appliedJob` 分布（有哪些岗位、各多少人），展示给用户
3. 逐岗位处理：
   a. 筛选该岗位候选人（过滤 `appliedJob === 岗位名` 或复用 `--position` 产出的子集）
   b. 取该岗位 JD（组内候选人共享，取任一即可）
   c. 组内走现有评分流程：平均分给子 Agent → 每批 3-5 人 → 填充 `scoring-prompt-with-jd.txt` → 发 LLM → 收结果
   d. 结果合并回 `scored-candidates.json`
4. 全部岗位完成后，合并总分（不变）

**组内评分逻辑不变**：
- 模板统一使用 `config/scoring-prompt-with-jd.txt`（用户已确认）
- 子 Agent 每批 3-5 人
- 结构化输出 + 自检

### 3. 导出脚本 `export-candidates.mjs`

**核心改动**：`main()` 中按 `positionInfo.appliedJob` 分组，每组生成一个 sheet。

**实现**：
- 读取 `candidates` 后，用 `Map<appliedJob, candidates[]>` 分组
- 每个组按 `totalScore` 降序排序
- 每个组调用 `transformCandidates` 转为二维数组
- 每个组调用 `XLSX.utils.aoa_to_sheet` + `XLSX.utils.book_append_sheet`
- sheet 名 = `appliedJob`（超 31 字符截断，移除 `\ / ? * [ ] :` 等非法字符）
- 所有 sheet 共用 `DEFAULT_FIELDS`

**边界情况**：
- 全部候选人 `appliedJob` 相同 → 只有一个 sheet（向后兼容）
- 空分组 → 跳过，不生成空 sheet
- 岗位名含非法字符 → 自动过滤

## 完整流程

```
提取（不变）
  ↓ output/zhipin-candidates.json（含 appliedJob + jobDescription）
基础评分（可选 --position 过滤）
  ↓ output/scored-candidates.json
LLM 评分（按 appliedJob 分组 → 每组各自用 JD + 子 Agent 并行）
  ↓ 合并回 scored-candidates.json
导出（按 appliedJob 拆多 sheet）
  ↓ output/candidates.xlsx
  ├── Sheet「AI应用开发工程师」
  ├── Sheet「Java开发」
  └── Sheet「产品经理」
```

## 向后兼容

- 单岗位场景：`score-candidates.mjs` 不传 `--position` 时行为不变，Excel 仍只含一个 sheet
- 已存在的 `scored-candidates.json` 格式不变，只是新增 `--position` 过滤能力
- `FIELD_CONFIG` 和 `DEFAULT_FIELDS` 不变
