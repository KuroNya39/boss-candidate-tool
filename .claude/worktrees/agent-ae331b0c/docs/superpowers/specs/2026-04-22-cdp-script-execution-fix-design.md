# CDP 脚本执行修复设计：原始文本提取 + 本地解析

## 问题

复杂 JS 脚本通过 Bash curl 传递时，遇到以下问题：
1. 多行脚本在 curl `-d` 参数中格式错误
2. 脚本内单引号与 Bash 单引号冲突
3. 导致 CDP 执行返回 `Uncaught` 错误

## 解决方案

改为"简化 CDP 提取 + 本地解析"模式：

1. **CDP 端**：执行极简单行脚本，仅获取原始文本
2. **本地端**：Node.js 解析原始文本，输出结构化 JSON

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                      执行流程                                │
├─────────────────────────────────────────────────────────────┤
│  1. 点击候选人 → 等待 300ms                                  │
│  2. CDP 执行简化脚本（单行）→ 返回原始文本 JSON              │
│  3. 本地 Node.js 解析文本 → 输出结构化 JSON                  │
│  4. 汇总所有候选人                                          │
└─────────────────────────────────────────────────────────────┘
```

## CDP 提取脚本

**要求**：
- 单行，无换行
- 无单引号（使用双引号）
- 仅获取原始文本，不做解析

```javascript
JSON.stringify({raw:document.querySelector(".base-info-single-container")?.innerText||"",basic:document.querySelector(".base-info-single-detial")?.innerText||"",experience:document.querySelector(".experience-content")?.innerText||"",position:document.querySelector(".position-content")?.innerText||""})
```

**curl 调用**：

```bash
curl -s -X POST "http://localhost:3456/eval?target=xxx" \
  -d 'JSON.stringify({raw:document.querySelector(".base-info-single-container")?.innerText||"",basic:document.querySelector(".base-info-single-detial")?.innerText||"",experience:document.querySelector(".experience-content")?.innerText||"",position:document.querySelector(".position-content")?.innerText||""})'
```

## 本地解析模块

**文件**：`scripts/parse-candidate.mjs`

**输入**：

```json
{
  "raw": "于自豪\n24岁\n2年\n本科\n2024.03-2026.03\n元展科技（佛山）有限公司\n自然语言处理算法...",
  "basic": "于自豪\n24岁\n2年\n本科",
  "experience": "2024.03-2026.03\n元展科技（佛山）有限公司\n自然语言处理算法\n2020-2024\n郑州工程技术学院\n物联网工程技术\n本科",
  "position": "沟通职位：\nai应用开发工程师\n期望：\n深圳 · 深度学习 15-25K"
}
```

**输出**：

```json
{
  "rawVisibleText": "于自豪\n24岁\n2年\n本科...",
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

### 解析规则

#### 基本信息 (basic)

按换行分割，取前 4 个非空行：
- 第 1 行 → 姓名
- 第 2 行 → 年龄
- 第 3 行 → 工作年限
- 第 4 行 → 学历

#### 经历 (experience)

按换行分割，每 3 行一组：
- 第 1 行 → 时间（格式：YYYY.MM-YYYY.MM 或 YYYY-YYYY）
- 第 2 行 → 公司/学校
- 第 3 行 → 职位/专业·学历

**区分工作和教育**：
- 第 2 行或第 3 行包含"学校"、"学院"、"大学"关键词 → 教育经历
- 否则 → 工作经历

**教育经历解析**（第 3 行按 `·` 分割）：
- 第 1 部分 → 专业
- 第 2 部分 → 学历

#### 职位 (position)

按换行分割：
- "沟通职位："后一行 → appliedJob
- "期望："后一行 → 按 `·` 分割为城市和职位薪资，再按空格分割职位和薪资

### 解析脚本伪代码

```javascript
function parseCandidate(rawData) {
  const result = { rawVisibleText: rawData.raw };

  // 基本信息
  const basicLines = rawData.basic.split('\n').filter(l => l.trim());
  if (basicLines.length >= 1) result.basicInfo = { name: basicLines[0] };
  if (basicLines.length >= 2) result.basicInfo.age = basicLines[1];
  if (basicLines.length >= 3) result.basicInfo.workYears = basicLines[2];
  if (basicLines.length >= 4) result.basicInfo.education = basicLines[3];

  // 经历
  const expLines = rawData.experience.split('\n').filter(l => l.trim());
  for (let i = 0; i + 2 < expLines.length; i += 3) {
    const time = expLines[i];
    const org = expLines[i + 1];
    const detail = expLines[i + 2];

    const isEdu = /学校|学院|大学/.test(org) || /学校|学院|大学/.test(detail);

    if (isEdu) {
      const parts = detail.split('·').map(p => p.trim());
      result.educationExperience.push({
        time,
        school: org,
        major: parts[0],
        degree: parts[1]
      });
    } else {
      const parts = detail.split('·').map(p => p.trim());
      result.workExperience.push({
        time,
        company: org,
        position: parts[0] || detail
      });
    }
  }

  // 职位
  const posLines = rawData.position.split('\n').filter(l => l.trim());
  // ... 解析职位信息

  return result;
}
```

## 错误处理

### CDP 脚本失败

1. 等待 500ms
2. 重新点击候选人
3. 等待 300ms
4. 再次执行 CDP 脚本
5. 仍失败 → 返回 `{ "index": n }`

### 本地解析失败

- 保留 `rawVisibleText`
- 其他字段省略
- 不抛出错误

## 文件改动

| 文件 | 操作 | 说明 |
|------|------|------|
| `references/site-patterns/zhipin.com.md` | 更新 | 替换提取脚本为简化版，更新流程 |
| `scripts/parse-candidate.mjs` | 新增 | 本地解析模块 |

## 使用流程（更新后）

1. 确认 Chrome 已登录 Boss 直聘招聘端
2. 执行前置检查：`node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"`
3. 解析用户请求，确定提取数量 N
4. 创建新 tab：`curl -s "http://localhost:3456/new?url=https://www.zhipin.com/web/chat"`
5. 等待页面加载
6. 循环 N 次（索引 0 到 N-1）：
   - 执行点击脚本：`document.querySelectorAll('.geek-item')[i].click()`
   - 等待 300ms
   - 执行简化 CDP 提取脚本
   - 若失败：重试一次，仍失败返回 `{ "index": i+1 }`
   - 调用本地解析：`node scripts/parse-candidate.mjs "$rawJson"`
   - 记录结果
7. 汇总数据，输出 JSON
8. 保存到 `./output/zhipin-candidates.json`
9. 关闭 tab

## 优势

1. **稳定性**：简化 CDP 脚本无复杂语法，执行稳定
2. **可调试**：本地解析可打印中间结果，便于排查
3. **可迭代**：解析规则变更只需修改本地脚本，无需改 CDP 脚本
4. **兼容性**：避免 Bash 引号嵌套问题
