---
name: my-web-access
license: MIT
github: https://github.com/eze-is/web-access
description:
  所有联网操作必须通过此 skill 处理，包括：搜索、网页抓取、登录后操作、网络交互等。
  触发场景：用户要求搜索信息、查看网页内容、访问需要登录的网站、操作网页界面、抓取社交媒体内容（小红书、微博、推特等）、读取动态渲染页面、以及任何需要真实浏览器环境的网络任务。
user-invocable: true
metadata:
  author: 一泽Eze
  version: "2.6.0"
---

# web-access Skill

## 前置检查

在开始联网操作前，先检查 CDP 模式可用性：

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

未通过时引导用户完成设置：
- **Node.js 22+**：必需（使用原生 WebSocket）。版本低于 22 可用但需安装 `ws` 模块。
- **Chrome remote-debugging**：在 Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"** 即可，可能需要重启浏览器。

检查通过后并必须在回复中向用户直接展示以下须知，再启动 CDP Proxy 执行操作：

```
温馨提示：部分站点对浏览器自动化操作检测严格，存在账号封禁风险。已内置防护措施但无法完全避免，Agent 继续操作即视为接受。
```

## 浏览器 CDP 模式

通过 CDP Proxy 直连用户日常 Chrome，天然携带登录态，无需启动独立浏览器。
若无用户明确要求，不主动操作用户已有 tab，所有操作都在自己创建的后台 tab 中进行，保持对用户环境的最小侵入。不关闭用户 tab 的前提下，完成任务后关闭自己创建的 tab，保持环境整洁。

### 启动

```bash
node "${CLAUDE_SKILL_DIR}/scripts/check-deps.mjs"
```

脚本会依次检查 Node.js、Chrome 端口，并确保 Proxy 已连接（未运行则自动启动并等待）。Proxy 启动后持续运行。

### Proxy API

所有操作通过 curl 调用 HTTP API：

```bash
# 列出用户已打开的 tab
curl -s http://localhost:3456/targets

# 创建新后台 tab（自动等待加载）
curl -s "http://localhost:3456/new?url=https://example.com"

# 页面信息
curl -s "http://localhost:3456/info?target=ID"

# 执行任意 JS：可读写 DOM、提取数据、操控元素、触发状态变更、提交表单、调用内部方法
curl -s -X POST "http://localhost:3456/eval?target=ID" -d 'document.title'

# 捕获页面渲染状态（含视频当前帧）
curl -s "http://localhost:3456/screenshot?target=ID&file=/tmp/shot.png"

# 导航、后退
curl -s "http://localhost:3456/navigate?target=ID&url=URL"
curl -s "http://localhost:3456/back?target=ID"

# 点击（POST body 为 CSS 选择器）— JS el.click()，简单快速，覆盖大多数场景
curl -s -X POST "http://localhost:3456/click?target=ID" -d 'button.submit'

# 真实鼠标点击 — CDP Input.dispatchMouseEvent，算用户手势，能触发文件对话框
curl -s -X POST "http://localhost:3456/clickAt?target=ID" -d 'button.upload'

# 文件上传 — 直接设置 file input 的本地文件路径，绕过文件对话框
curl -s -X POST "http://localhost:3456/setFiles?target=ID" -d '{"selector":"input[type=file]","files":["/path/to/file.png"]}'

# 滚动（触发懒加载）
curl -s "http://localhost:3456/scroll?target=ID&y=3000"
curl -s "http://localhost:3456/scroll?target=ID&direction=bottom"

# 关闭 tab
curl -s "http://localhost:3456/close?target=ID"
```

### 页面内导航

两种方式打开页面内的链接：

- **`/click`**：在当前 tab 内直接点击用户视角中的可交互单元，简单直接，串行处理。适合需要在同一页面内连续操作的场景，如点击展开、翻页、进入详情等。
- **`/new` + 完整 URL**：使用目标链接的完整地址（包含所有URL参数），在新 tab 中打开。适合需要同时访问多个页面的场景。

很多网站的链接包含会话相关的参数（如 token），这些参数是正常访问所必需的。提取 URL 时应保留完整地址，不要裁剪或省略参数。

### 媒体资源提取

判断内容在图片里时，用 `/eval` 从 DOM 直接拿图片 URL，再定向读取——比全页截图精准得多。

### 技术事实
- 页面中存在大量已加载但未展示的内容——轮播中非当前帧的图片、折叠区块的文字、懒加载占位元素等，它们存在于 DOM 中但对用户不可见。以数据结构（容器、属性、节点关系）为单位思考，可以直接触达这些内容。
- DOM 中存在选择器不可跨越的边界（Shadow DOM 的 `shadowRoot`、iframe 的 `contentDocument`等）。eval 递归遍历可一次穿透所有层级，返回带标签的结构化内容，适合快速了解未知页面的完整结构。
- `/scroll` 到底部会触发懒加载，使未进入视口的图片完成加载。提取图片 URL 前若未滚动，部分图片可能尚未加载。
- 拿到媒体资源 URL 后，公开资源可直接下载到本地后用读取；需要登录态才可获取的资源才需要在浏览器内 navigate + screenshot。
- 短时间内密集打开大量页面（如批量 `/new`）可能触发网站的反爬风控。
- 平台返回的"内容不存在""页面不见了"等提示不一定反映真实状态，也可能是访问方式的问题（如 URL 缺失必要参数、触发反爬）而非内容本身的问题。

### 视频内容获取

用户 Chrome 真实渲染，截图可捕获当前视频帧。核心能力：通过 `/eval` 操控 `<video>` 元素（获取时长、seek 到任意时间点、播放/暂停/全屏），配合 `/screenshot` 采帧，可对视频内容进行离散采样分析。

### 登录判断

用户日常 Chrome 天然携带登录态，大多数常用网站已登录。

登录判断的核心问题只有一个：**目标内容拿到了吗？**

打开页面后先尝试获取目标内容。只有当确认**目标内容无法获取**且判断登录能解决时，才告知用户：
> "当前页面在未登录状态下无法获取[具体内容]，请在你的 Chrome 中登录 [网站名]，完成后告诉我继续。"

登录完成后无需重启任何东西，直接刷新页面继续。

### 任务结束

用 `/close` 关闭自己创建的 tab，必须保留用户原有的 tab 不受影响。

Proxy 持续运行，不建议主动停止——重启后需要在 Chrome 中重新授权 CDP 连接。

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

## 候选人筛选评分

当用户要求筛选候选人时（如"帮我筛选本科以上、2年经验的"），**自动完成以下全部步骤**，无需用户手动运行脚本：

### 执行步骤

1. **生成规则配置**：根据用户描述的筛选条件，生成或更新 `config/filter-rules.json`
2. **运行评分脚本**：
   ```bash
   node scripts/score-candidates.mjs \
     --input output/zhipin-candidates.json \
     --rules config/filter-rules.json \
     --output output/scored-candidates.json
   ```
3. **导出 Excel 文件**：
   ```bash
   node scripts/export-candidates.mjs \
     --input output/scored-candidates.json
   ```
   Excel 文件保存到 `output/candidates.xlsx`
4. **展示结果摘要**：向用户展示通过/未通过人数、Top 候选人列表（姓名、分数、等级）、Excel 文件路径

### 规则配置

规则存放在 `config/filter-rules.json`，包含三类规则：

- **exclude**：命中任一即否决（score=0, passed=false）
- **mustHave**：全部满足才进入评分，否则 passed=false
- **preferred**：加分项，满足加 weight，不满足不扣分

分数归一化到 0-100：`score = (满足的 weight 之和 / 所有 preferred 的 weight 之和) * 100`

### 操作符

| 操作符 | 说明 |
|--------|------|
| `equals` | 精确匹配 |
| `contains` | 包含匹配 |
| `in` | 值在列表中 |
| `>=` / `>` / `<=` / `<` | 比较（支持学历排序、年限数值） |
| `regex` | 正则匹配 |
| `exists` | 字段存在 |

### 字段解析

- **学历/工作年限**：从 `rawVisibleText` 提取（避免 basicInfo 偏移问题）
- **数组字段**：`workExperience[].position` 遍历数组，任一匹配即满足
- **学历排序**：高中 < 中专 < 大专 < 本科 < 硕士 < 博士
- **工作年限**：从 "3年" 提取数字 3，应届生为 0，"1年以内"为 0.5，"10年以上"为 10

| `resumeText` | 简历全文搜索 |

### 用户描述到规则的映射示例

| 用户说 | 规则 |
|--------|------|
| “本科以上” | mustHave: `basicInfo.education` >= "本科" |
| “不要大专及以下” | exclude: `basicInfo.education` in ["高中","中专","大专"] |
| “2年经验优先” | preferred: `basicInfo.workYears` >= "2年", weight=20 |
| “有Java经验” | preferred: `workExperience[].position` contains "Java", weight=15 |
| “期望深圳” | preferred: `positionInfo.expectCity` equals "深圳", weight=10 |
| “有支付相关经验” | preferred: `workExperience[].position` contains "支付", weight=15 |
| “985/211优先” | preferred: `resumeText` regex "985\|211", weight=15 |
| “简历中有Python” | preferred: `resumeText` contains "Python", weight=10 |

## 在线简历提取

在第一轮提取中即完成基础信息 + 在线简历的全量提取。

### 触发条件

- 用户要求提取候选人信息（包含在线简历）

### 执行步骤

1. **确定提取范围**：
   - "提取前 N 个" → `--count N`
   - "提取全部" / "提取所有" → `--all`
   - 未指定数量 → `--count 10`（默认）
2. **后台运行全量提取脚本**（必须使用 `run_in_background`，因提取耗时可能超过 10 分钟）：
   ```bash
   node scripts/extract-candidates-full.mjs \
     --all \
     --output output/zhipin-candidates.json
   ```
   > **重要**：此脚本必须后台运行（Bash 工具的 `run_in_background: true`），不要同步等待。脚本完成后会自动通知。
3. **运行期间主动报告进度**：脚本后台运行后，设置定时任务每 2 分钟读取进度文件并向用户报告：
   ```bash
   node -e "const p=JSON.parse(require('fs').readFileSync('output/.extract-progress.json','utf8')); console.log(`进度: ${p.processedCount} 人已完成, 更新于 ${p.updatedAt}`)"
   ```
   使用 CronCreate 设置定时进度报告（`recurring: true`），脚本完成后用 CronDelete 取消定时任务。
4. 脚本自动完成（两阶段提取）：
   - **扫描阶段**：逐步滚动列表收集所有 geekId（`--all` 模式）
   - **提取阶段**：逐个处理候选人（通过 geekId 精准定位）
   - 提取基础信息 + 打开在线简历弹窗 + 截图 + OCR
   - 保存到 `output/zhipin-candidates.json`（含 `resumeText` 字段）
   - 同时保存单独简历 txt 到 `output/resumes/`
5. **脚本完成后**：取消进度定时任务，读取输出文件，向用户展示提取数量、有简历数量、文件路径

### 中断恢复

如果提取过程中中断（如网络断开、手动停止）：
```bash
node scripts/extract-candidates-full.mjs --all --resume
```
脚本将从上次进度继续，跳过已扫描和已提取的候选人。

### 注意事项

- Boss 直聘的在线简历通过 Canvas 渲染（反爬），采用截图 + OCR 方案
- 并非所有候选人都有在线简历，脚本会自动跳过
- OCR 识别结果可能包含少量误字，但技术关键词识别率较高
- `resumeText` 字段可用于筛选评分（如筛选 985/211 院校）
- 依赖 `tesseract.js`（已在 package.json 中）
- 全量提取大量候选人时耗时较长（每人约 10-15 秒），使用 `--resume` 可中断后继续

## 站点经验

**核心原则**：本 skill 专门用于流程化提取任务。站点经验文件定义的流程具有最高优先级，必须严格按其执行。

**禁止行为**：
- ❌ 禁止自主判断或调整流程
- ❌ 禁止检查页面结构
- ❌ 禁止修改选择器或脚本
- ❌ 禁止"优化"或"修复"任何内容

**唯一允许的行为**：
- ✅ 严格按站点经验定义的脚本和流程执行
- ✅ 遇到错误时仅按重试机制执行

---

操作中积累的特定网站经验，按域名存储在 `references/site-patterns/` 下。

确定目标网站后，如果前置检查输出的 site-patterns 列表中有匹配的站点，必须读取对应文件获取先验知识（平台特征、有效模式、已知陷阱）。经验内容标注了发现日期，当作可能有效的提示而非保证——如果按经验操作失败，回退通用模式并更新经验文件。

CDP 操作成功完成后，如果发现了有必要记录经验的新站点或新模式（URL 结构、平台特征、操作策略），主动写入对应的站点经验文件。只写经过验证的事实，不写未确认的猜测。

文件格式：
```markdown
---
domain: example.com
aliases: [示例, Example]
updated: 2026-03-19
---
## 平台特征
架构、反爬行为、登录需求、内容加载方式等事实

## 有效模式
已验证的 URL 模式、操作策略、选择器

## 已知陷阱
什么会失败以及为什么
```
经验/陷阱内容标注发现日期，当作"可能有效的提示"而非"保证正确的事实"。

## References 索引

| 文件 | 何时加载 |
|------|---------|
| `references/cdp-api.md` | 需要 CDP API 详细参考、JS 提取模式、错误处理时 |
| `references/site-patterns/{domain}.md` | 确定目标网站后，读取对应站点经验 |
