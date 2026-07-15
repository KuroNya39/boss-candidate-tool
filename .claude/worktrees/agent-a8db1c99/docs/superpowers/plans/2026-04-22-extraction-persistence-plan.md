# 提取结果持久化实现计划

## 概述

根据 spec 文档 `docs/superpowers/specs/2026-04-22-extraction-persistence-design.md` 实现。

## 任务列表

### 任务 1: 更新 SKILL.md

**文件**: `SKILL.md`

**操作**: 在"站点经验"章节之前，新增"提取结果持久化"章节

**内容**:
```markdown
## 提取结果持久化

当站点经验文件定义了 `outputFile` 字段时，提取结果必须保存到文件。

**触发条件**：站点经验 frontmatter 包含 `outputFile` 字段。

**保存规则**：
| 属性 | 值 |
|------|-----|
| 目录 | `./output/`（自动创建） |
| 文件名 | `outputFile` 字段值 |
| 策略 | 覆盖保存 |
| 格式 | JSON |

**执行时机**：在汇总输出后、向用户展示结果前执行保存。

**流程**：
1. 汇总数据为完整 JSON 结构
2. 检查站点经验是否定义 `outputFile`
3. 若有：
   - 确保 `./output/` 目录存在
   - 将 JSON 写入 `./output/{outputFile}`
4. 向用户输出结果，并告知文件路径
```

**位置**: 在 `## 站点经验` 章节之前插入

---

### 任务 2: 更新站点经验文件

**文件**: `references/site-patterns/zhipin.com.md`

**操作 2.1**: 更新 frontmatter，添加 `outputFile` 字段

```yaml
---
domain: zhipin.com
aliases: [Boss直聘, BOSS直聘, boss直聘, boss]
outputFile: zhipin-candidates.json
updated: 2026-04-22
---
```

**操作 2.2**: 修改"使用流程"步骤 7

将：
```
7. 汇总数据，输出 JSON 结果
```

改为：
```
7. 汇总数据，输出 JSON 结果
   - 检查站点经验 frontmatter 是否定义 `outputFile`
   - 若有，保存到 `./output/{outputFile}`
   - 向用户输出完整 JSON 结果，并告知文件路径
```

---

### 任务 3: 提交变更

提交所有文件修改。

---

## 验收

执行候选人提取测试，验证：
1. 结果保存到 `./output/zhipin-candidates.json`
2. LLM 告知用户文件路径
