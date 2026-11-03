# CLAUDE.md

本文件给 Claude Code 提供在本仓库工作的指引。
改界面先读 `docs/design-system.md`，改 README 先读 `docs/readme-style.md`。

## 项目概览

Electron 桌面应用：从 BOSS直聘 提取候选人简历 → AI 评分 → 导出 Excel（可选邮件发送）。
通过 CDP 代理控制一个开了远程调试的 Chrome 实例抓取页面。

## 目录与模块

```
electron/main.mjs        ← 主进程入口（应用生命周期 + --score-only）。业务模块按职责拆在同目录，
                           清单见 main.mjs 顶部注释：util / state / config / window / archive / scoring /
                           runner / chrome / incremental / pipeline / greet / ipc / candidate-index /
                           name-sort / pinyin / score-comment
electron/score-comment.mjs  ← 算分与评语校订：computeScoreBreakdown（加权基础分 − 学历扣分 − 任职资格扣分）
                           + patchScoreComment（把评语里手写的数字校正成程序口径）。纯函数，不依赖 Electron
electron/preload.js      ← Context bridge（electronAPI）
electron/renderer/       ← UI：index.html + 6 个 CSS（tokens / base / topbar / config / run / overlays，
                           按序 <link>，勿调换）+ 11 个 renderer-*.js（按序 <script src>，共享全局作用域）

scripts/cdp-proxy.mjs                   ← HTTP → WebSocket CDP 代理（端口 3456）
scripts/extract-common.mjs              ← 提取共用：CDP 调用、OCR 引擎、进度存取/续跑
scripts/extract-candidates-full.mjs     ← 沟通页提取
scripts/extract-recommend-candidates.mjs ← 推荐页提取
scripts/extract-search-candidates.mjs   ← 搜索页提取
scripts/greet-candidates.mjs            ← 批量打招呼
scripts/export-candidates.mjs           ← Excel 导出（可选邮件）
scripts/send-candidates-email.mjs       ← 邮件发送（nodemailer）
scripts/format-comment.mjs              ← 评语排版 + 界面加粗 HTML（唯一实现）
scripts/score-tiers.mjs                 ← 档位阈值（唯一数据源：5 星 91+ / 4 星 81+ / 3 星 61+ 通过线 …）
scripts/degree.mjs                      ← 学历词表（唯一数据源）
scripts/scored-candidate.mjs            ← 评分结果 → 展示行的唯一映射
scripts/process-icon.mjs                ← 应用图标处理（缩放 + 圆角）
scripts/make-ico.mjs                    ← 生成 electron-builder 用的 .ico
build.mjs                               ← 打包流水线（图标 → electron-builder → NSIS → release）

config/scoring-prompt-with-jd.md    ← 评分提示词（推荐/搜索页）
config/scoring-prompt-chat.md       ← 评分提示词（沟通页）
```

> `score-tiers` / `degree` 放在 `scripts/` 是有原因的：打包后 `scripts/` 在 `app.asar.unpacked`，
> 主进程 spawn 的子进程只能 import 同目录模块，够不到 `electron/`；主进程则可以用 `../scripts/` 引。
> 新的跨进程共享常量按这套约定放。
>
> 岗位描述（JD）统一存用户数据目录 `%AppData%\web-access\web-access\jd-descriptions\`
> （开发/打包一致，重装不丢）。旧的 `config/jd-descriptions` 已废弃，不要再往里写。

## 核心流程

### 主流程（`electron/pipeline.mjs` 的 `runPipeline()`）

1. **提取**：以 `ELECTRON_RUN_AS_NODE=1` 子进程跑提取脚本；stdout 经 `parseExtractProgress()` 转成 UI 进度。
2. **AI 评分**：读 `zhipin-candidates.json`，按岗位分组，对 JD 逐批评分，写 `scored-candidates.json`。
3. **导出**：子进程跑 `export-candidates.mjs`；stdout 经 `parseExportProgress()` 转进度。可附带 SMTP 发信。

取消：主进程向子进程 stdin 写 `CANCEL\n`，等 2s 再强杀。AI 请求共用一个 `AbortController`。

### 数据流

1. **提取**：脚本 → HTTP → `cdp-proxy`(3456) → WebSocket → Chrome DevTools → BOSS 页面
2. **OCR**：CDP 截图 → tesseract.js（`chi_sim`）→ `cleanOcrText()` → `dedupePages()`
3. **评分**：候选人数据 → Anthropic 兼容 API → 分数 + 评语 → `scored-candidates.json`
4. **导出**：`scored-candidates.json` → ExcelJS → `.xlsx`（可选 nodemailer 发信）

### 三种提取模式

- **沟通页**（`/web/chat`）：点左侧候选人卡片取基本信息，`clickOnlineResume()` 打开在线简历浮层；
  简历在 `.resume-detail` 里，内容在一个 iframe 中。
- **推荐页**（`/web/chat/recommend`）：页面内容在 `<iframe name="recommendFrame">` 里，所有 DOM 操作走
  `iframeEval()`（在 iframe 的 `contentWindow` 求值）。点卡片直接弹简历（没有单独的「在线简历」按钮）。
  支持 `--attach` 手动筛选。
- **搜索页**（`/web/chat/search`）：与推荐页同构，内容在 `<iframe name="searchFrame">`，一律走 `iframeEval()`。
  只有 `--attach` 模式（挂到用户已打开的搜索页，不自动跳转）。简历弹窗结构：
  `.boss-popup__wrapper.boss-dialog.dialog-lib-resume` → `.boss-popup__content` → `.resume-detail-wrap`
  → iframe（`c-resume`，与推荐页一样的跨域 OOPIF）。DOM 提取同样用 `findFrameInTree` + execution context。
  打招呼走 `--source search`。

## 关键机制

### 提取与 OCR

- **进度持久化**：输出目录里的 `.scan-cache.json`（候选人列表缓存）与 `.extract-progress.json`（逐人进度）；
  `--resume` 读这两份跳过已处理的人。
- **取消清理**：提取脚本的 `doCleanup()` 处理 SIGTERM / stdin CANCEL。主进程等
  `CLEANUP_OCR_GRACE_MS`（`extract-common.mjs` 导出，当前 20s）+ 6s 余量再强杀——子进程要先等当前
  那位的后台 OCR 收尾并落盘（`flushProgressOnCancel`，三个提取脚本共用）。
- **OCR 流水线**：`captureResumeScreenshots()` 逐页滚动截图 → `ocrScreenshots()` 逐页识别 →
  `dedupePages()` 去相邻页重叠 → `cleanOcrText()` 规范化空白、纠正 OCR 错字、剥样板文字。
- **截图拉前台是条件式的（v1.3.28）**：`cdpScreenshot()` 每次截图前查 `document.visibilityState`，
  只有标签页不可见（切后台/最小化）才调 `/activate`（`Target.activateTarget`）拉回最前；页面本来就在最前
  （如「开两个 Chrome 窗口」）时不抢焦点，免得打断用户。拿不到可见状态时保守地照常 activate。
  `prepareTab()`（提取开始时）仍无条件 activate 一次。
- **DOM 直读兜底**：截图 OCR 之前先试 `tryExtractResumeTextFromDOM()`，用 CDP `Page.getFrameTree` +
  `Runtime.executionContexts` 取 iframe 文本。三道补充：
  - v1.3.27「同域 iframe 直接读」：拿不到 execution context 时，从父页面读 `iframe.contentDocument`
    里的 `#resume` 文本。
  - v1.3.28 搜索页「弹窗直接读文本」（`tryExtractSearchResumeTextFromDOM`）：简历直接渲染在弹窗 DOM
    （无 iframe / iframe 读不到）时读 `.resume-detail-wrap` / `.boss-popup__content` 的 textContent。
    推荐页一直有这道兜底（方式二），搜索页此前漏了。
  - 全部失败时输出一次弹窗结构诊断。
- **canvas 简历复制提取（v1.4.0）**：iframe 里 `#resume` 有宽高正常的 `canvas` 且 textContent 不足阈值时：
  WASM 渲染（body 含 `wasm-resume-container` / `wasm-resume`）走 `tryExtractCanvasResumeByDragCopy()`，
  旧版 canvas 走 `tryExtractResumeTextByTrustedCopy()`。拖拽复制端点 `/canvas-copy`（cdp-proxy.mjs）
  模拟「鼠标选中 → 滚动容器 → 底部延伸选中 → 真实 Ctrl+C」，Boss 的 copy 处理器把全文写进**系统剪贴板**
  （页面级拦截看不到），调用方用 PowerShell `Get-Clipboard` 读走（base64）。要点：
  - 滚动容器各页不同（推荐/搜索页 `.resume-detail-wrap`，沟通页 `.resume-detail`）。端点从简历 iframe
    向上探测「可滚动」祖先；`overflowY` 须**同时接受 hidden**（Boss 弹窗常隐藏滚动条，只认 auto/scroll/overlay
    会把沟通页的 `.resume-detail` 排除 → scrollMax=0 → 复制不全）。结果缓存到
    `window.__resumeScrollEl` / `__resumeOuterMax` / `__resumeInnerMax` / `__resumeIframe`。
  - 外层容器不可滚时兜底滚 c-resume iframe 内部文档（`idoc.documentElement.scrollTop`）。
  - reset 时先短轮询归顶（≤2s），卡死才重载 c-resume iframe 再轮询（确定性回顶）。
  - 复制前会**清空系统剪贴板**（用户此时复制粘贴别的内容会被盖一下）。复制失败才退回截图 OCR。
- **最小化 vs 盖住（v1.4.4，实测修正）**：Chrome 最小化后渲染冻结，截图 OCR 必然变形。v1.4.3 的
  `/window-restore` 自动恢复窗口因会自己弹窗被否掉，已整体回退（代理无最小化特殊处理）。引导用户
  「别点最小化、用别的窗口盖住」即可。曾经的「边用边跑」启动参数（禁用 `CalculateNativeWinOcclusion` /
  `BackgroundTabFreeze` 等）**实测无效已整体移除**：同窗口切后台标签页依旧失效；开两个 Chrome 窗口
  （BOSS 页在独立窗口）无论盖不盖都正常。README「运行中的注意事项」第 1 条即此引导。
- **模拟复制开关（v1.4.4）**：`extract-common.mjs` 模块级 `enableCopyFlag`（默认 true，
  `parseArgs --enable-copy 0` 关闭），在两个复制入口开头守卫，关掉即 return null → 调用点自动降级走截图 OCR。
  renderer 复选框 → main 拼 `--enable-copy 1/0`。界面默认不勾选（电脑闲置才建议开，开启才借用系统剪贴板）。

### 评分与算分

- **批次与并发**：`BATCH_SIZE = 3`（每批 3 人）、`SCORE_CONCURRENCY = 5`（同时 5 批），都在 `scoring.mjs`。
  每批最多重试 2 次；整批失败时拆成单人逐个重试（v1.4.5 兜底），仍失败按 0 分兜底并记录。
- **响应解析**：`parseBatchScoreResponse()` 在回复里找第一段合法的 `[{candidateIndex, score, comment}]`
  JSON 数组（也认 Markdown 代码块），评语在各节标题前补换行。`callClaudeAPI()` 兼容 Anthropic 标准格式、
  thinking 块、OpenAI Chat 格式与裸响应。**剥思考块（v1.4.5，2026-08-21 实测定论）**：公司代理会把「思考」
  包成 `<antml-thinking>` **text 块**放在 content 最前（即使请求 `thinking:disabled`），真正的回答在后续块；
  只取第一个 text 块会拿到思考、丢掉回答 → 系统性「解析失败(无有效JSON)」。现在拼所有块再剥掉
  antml-thinking/thinking 块，在剩余文本里找 JSON；`max_tokens` 16000（防长批被截断）。
  部分模型有月度配额，超额报 `API 429 insufficient_quota`（如 qwen3.7-plus_Aliyun）。
- **权威分数 = 程序化计算**（v1.3.18，v1.21.0 全面重写）：`computeScoreBreakdown()` 算
  `clamp(加权基础分 − 学历扣分 − 任职资格扣分, 0, 100)` 作 `totalScore`，打招呼的等级过滤也据它判断。
  - **AI 写的「其他扣分合计」「匹配度评分」不参与计算**，只活在评语文字里（收尾时由 `patchScoreComment`
    校正成程序口径）。实测它会在同一份评语里前后打架（合计行写「任职资格0 + 学历20」，下一节又说
    「这20是任职资格扣分」），信它会多扣或少扣 20 分（2026-10-30 那批 200 人里 130 人分数因此变化）。
  - **学历扣分**：第一学历全日制本科及以上 → 0；大专及以下 / 非统招 / 非全日制 → 20；
    **判不出 → 也按 0 分**，并在评语末尾挂「学历待核实」提示交人工（2026-10-30 决定）。原先「判不出就沿用
    AI 的扣分」已删——宁可放过（Excel 有学历列，人工一眼可核），不可冤枉（错扣 20 分能把 80 分压到不推荐）。
    `educationGate()` 返回三态，`'ok'` 是能推翻 AI 数字的前提，别退回两态。
  - **任职资格扣分**：按**硬性项不达标数**定档（0 项 0 分、1–2 项 5 分、3–4 项 10 分、≥5 项 15 分）。
    **优先项与「待核实」不扣分**：优先项按 JD 原文字样（优先 / 非强制 / 加分 / 优选 / 者优先）判定，
    AI 标的 tier 与之冲突时**以字样为准**。
  - **判定粒度是「一行一个条件」**：同一筛选项里硬性与优先混写时（实测 36 份 JD 有 8 处，如
    「3年及以上经验；有芯片厂商经验者优先」），提示词要求 AI 拆成多行各自打标——不拆则必然二选一，
    要么冤枉只差优先项的人，要么放过硬性没达标的人。程序侧兜底 `HARD_MARK_RE`（硬性 / 必须 / 非「非强制」
    的强制）优先于其他判据：名字里明说硬性的，哪怕同处写了「优先」也按硬性算。刻意不收
    「精通 / 及以上 / 至少」，否则「硕士及以上学历优先」会被误判成硬性。
  - **行首的 `[硬性]` / `[优先]` 是标签，不是条件名**（2026-10-30）：提示词要求第 3 节每行以它开头，
    `qualificationItemsFromComment` 用 `TIER_MARK_RE` 剥出来当 `tier`（与结构化字段的 `tier: hard/preferred`
    归一）。**必须剥**：`HARD_MARK_RE` 靠「硬性」二字判定，标签留在名字里会命中它，把「…者优先」判成
    硬性不达标白扣 5 分——等于架空「以 JD 原文字样为准」。
  - **数据来源两条路**：新批次读 AI 返回的结构化字段 `dimensions` / `qualifications` / `education`
    （挂在候选人的 `scoreDetail` 上，随 `scored-candidates.json` 落盘）；字段缺失时退回解析评语文本
    （第 3 节逐项结论 + 维度行），再不行才用 AI 的 `score`。**降级路径必须一直在**，否则一次格式抽风就整批丢分。
- **程序只判「对不上的那一侧」，结果挂【系统核验】（v1.21.0）**：
  `computeScoreBreakdown(comment, detail, ctx)` 的第三参 `ctx` 由两半拼成——岗位级那半
  （`jdWorkYears` / `jdItemCount`）在评分阶段随分数存进候选人的 `scoreContext`，取自
  `createPositionPromptBuilder` 返回的 `requirements`（建 prompt 时按 `parseJdRequirements` 算一次，
  随 `run` 传给 `scoreOneBatch`；**别挂成函数属性、也别让每个调用方各传一份**，漏传的路径会静默失去核验）；
  页面工作年限那半由收尾从 `c.basicInfo.workYears` 现算，不落盘（存了会过期）。所以收尾算分不必再读 JD 文件。
  `notices` 由 `appendScoringNotices()` 写成评语末尾的【系统核验】段（UI 与 Excel 都直接展示评语，
  挂这里即全局可见；幂等，重复收尾不叠加）。**这些提示一律不改分**——程序能确定的只有「明显不够」，
  确定不了「够」，所以只提示、不替模型下结论。五类：
  - **工作年限存疑**：JD「经验要求」有明确 `N年`（`parseJdRequirements` 按 `；;。` 切分句，第一个带年数的
    分句若含优先字样则整条视为软条件返回 null——「具有2年以上技术背景者优先」不核验，「3年及以上…者优先」
    算 3 年），且页面 `basicInfo.workYears` 换算后 `< N`，而模型把它判成了达标。**单向**：JD 的年限常限定
    领域（「3 年以上半导体经验」），程序只会算总年限，所以只在「程序算出不够」时提示。
  - **筛选项可能漏判**：程序数 JD「任职资格关键筛选项」的标签行数当**下限**（`其他硬性条件：无` 这类占位行
    不算；39 份 JD 全部能数出来，2–6 条），模型返回条数少于下限时提示。拆分只会让模型吐得更多，
    所以只判「少于下限」。沟通页无 JD 文件时不核验。
  - **待核实偏多**：`pending >= 3` 且占一半以上时提示。提示词里已删掉「待核实项一律不扣分」这句**给模型看的**
    说法（等于告诉它有个免费逃生舱），改成待核实必须写明缺什么信息、有可判断内容就必须给明确结论。
  - **维度分解析失败**：结构化字段和评语维度行都拿不到时退回 AI 的 `score`，并挂提示说明「本分数未经程序重算」。
    `无在线简历` / `评分失败` 两类不算 AI 评语，不挂提示。
  - **评语不完整**：正文缺「任职资格的匹配情况」「学历硬性门槛核查」「综合结论」任一节时提示。实测：prompt
    末尾加结构化 JSON 字段后，deepseek 系只在正文写前两节、把第 3/4 节当成 `qualifications` / `education`
    字段表达（2026-10-30，3 人批 784 字 vs 旧模板 1400–1800 字；2026-11-02 的 200 人批里 18 人正文停在
    「匹配度评分」）。分数不受影响，但评语是给人看的。已在 schema 说明里明确「结构化字段是副本，不能替代
    正文第 3、4 节」。两处配合：**评分时补全重试**——`scoreOneBatch` 收尾挑出缺节的人
    （`missingSectionLabels`），逐人重问一次要求写全 1–5 节，只有确实更完整才替换；**判缺节只看正文**
    （它会先切掉【系统核验】段——那一段点名的正是缺的节名，连它一起判等于永远不缺）。
- **评语里的数字与程序分数对不上时会被改写**（2026-10-30 改，此前「一律不改写」）：收尾时
  `patchScoreComment(comment, bd)` 核对三处——「学历硬性门槛扣分」、「其他扣分合计」（连括号里的分项）、
  「匹配度评分」；改学历那处时把「合规性结论」那句一并换成同一口径（否则留下「扣 0 分、结论却写扣 20 分」的
  自相矛盾）。**对得上的那一处一个字都不动**；全都对就全文不改、也不追加说明；确实改过才在末尾挂
  「（系统说明：基础分 − 任职资格 − 学历 = 最终分）」。幂等，重复收尾不叠加。两个坑：
  - 「匹配度评分」先认冒号后紧跟的「N分」（模板标准写法，最可靠；实测
    `匹配度评分：67分（= 加权基础分 72 分 - 5 分）` 取末尾会读成 5）；没紧跟才取行内**最后一个**「N分」——
    AI 常写「72 - 10 = 62分」，取冒号后第一个数会读到 72，末端的矛盾就漏了。
  - 「其他扣分合计」括号里若写着分项数字，要和程序分项逐位比（忽略空格，否则自己写的分项第二次认不出来、
    反复重写），不然会留下「合计 5 分（= 任职资格 10 + 学历 0）」的残文。

  起因：2026-10-30 一批里 AI 把 1 项硬性不达标按 10 分扣（程序档位是 5 分），评语写「匹配度评分：62分」
  而列表显示 67。这些函数在 `electron/score-comment.mjs`，只依赖评语文本与结构化字段、不依赖 Electron，
  方便单独拿出来重算历史批次。
- **增量评分的批次节奏（2026-10-30）**：提取脚本每 5 人才写一次 `.extract-progress.json`，主进程每 1.5s 读一次，
  所以**待评队列是 5 人一包进来的**，步骤 2 的分母也按 5 跳；派批每岗位满 3 人就发（`BATCH_SIZE`，并发 5 批）。
  不满 3 人的尾巴**按人计时**：队首那位等满 `FLUSH_TIMEOUT`（60s）才整条放行。`collectBatches()`
  **只在新候选人进来（或用户点暂停）时才被调用**，所以这个阈值决定的是「下一包到达时，零头并进去还是被
  单独发一次 API」——30s 时几乎每包都要单独发一次（45 人那批实测 17 次调用 vs 最少 15 次），60s 基本都能
  并进下一包。原先按「岗位尾巴队列存在多久」计时（队列一直不空就永不重置），会让刚到的候选人蹭别人的等待、
  被当场单独成批。分子每批 +3（或尾巴 +1/+2）是正常的，不是丢人也不是重复。
- **多岗位**：按 `positionInfo.appliedJob` 分组，每组的 JD 从
  `%AppData%\web-access\web-access\jd-descriptions\{岗位名}.txt` 读（v1.3.15 起开发/打包统一走 userData）。

### 展示与导出

- **评语排版只有一份实现**：`scripts/format-comment.mjs`。完成页/批次详情/候选人查询/Excel 都调它，
  改排版规则只改这一处。`SECTION_LABELS` 是评语结构的唯一定义，解析侧（`score-comment.mjs`）也从这里 import。
  容忍全/半角逗号冒号与空格。主要兜底：
  - 模型漏写「首句定性：」标签时补在首个非空行（只补标签不补编号，编号由 `BLOCK_REWRITES` 统一加）。
  - 模型把板块标题包进方括号时剥壳——只剥「空的一对」和「恰好包住板块标题的那对」。行首的 `[硬性]` / `[优先]`
    是算分要用的档位标签，**不能动**。
  - 模型只写内容、漏写第 3/4 节标题时，按内容形状补回（`insertSectionHead`：3 节认行首 `[硬性]`/`[优先]`，
    4 节认 `第一学历：`/`学历硬性门槛扣分：` 等子行；2026-11-02 一批 33 人里 15 人如此，内容一字不少，
    排出来却像整节丢了）。补标题只在【系统核验】段之前判。
  - 维度节标题的别名「3个评估维度匹配情况」（漏「的」，2026-11-03 那批 315 人里 96 人）与标准写法同等对待；
    剥标题必须**全局**剥，否则同一份评语里的别名行与标准标题行会各留一个。
  - 模型偶尔把下一行开头的英文词漏在上一节末尾（实测只有 Linux 一例：维度名以它开头，维度行里反而少了它），
    单独占一行或缀在句号后 —— 排版时清掉。只认纯字母单词，带数字/符号的（`CET-6`、`K8s`）不动。
    这一步必须排在补「首句定性」标签**之前**，否则残片会变成「首句定性：Linux」。
- **评语加粗只做在软件界面**（2026-10-30）：`commentEmphasisSegments` / `commentToHtml` 加粗三处——行首到第一个
  括号外冒号、「独占一行的【…】标题」、第 3 节里的「不达标 / 待核实」（「达标」不加，避免糊成一片）。
  `commentHtml` 由主进程 `ipc.mjs` 的 `toDisplayRow()` **现算、不入库**（索引 JSONL 与 `scored-candidates.json`
  存的仍是纯文本，复制/邮件不受影响）；展示行**只带 `commentHtml`、不带纯文本 `comment`**（候选人查询一次可回
  上千行，两份内容白传）。`toDisplayRow` 里会先 `formatComment` 再转 HTML——历史存档里的旧格式在展示时一并修好。
  **Excel 导出不要富文本**（用户明确要求）：`export-candidates.mjs` 写普通字符串，别把 ExcelJS 的 `richText`
  接回来。
- **评分结果 → 展示行只有一份映射**：`scripts/scored-candidate.mjs` 的 `summarizeScoredCandidate()`
  （分数口径 `finalScore`、缺省姓名、评语排版都在这），`buildScoringResults` 与候选人索引共用。
- **候选人索引（v1.20.0）**：评分收尾时（`incremental.mjs` 的 `finalizeScoring`，写完 `scored-candidates.json`
  的同一处）调 `appendCandidateIndex(CONFIG_DIR, 本次评过的候选人数组)`——用内存里的数组，不重读结果文件；
  继续提取时播种的旧分不算本次，不重复记。写入 `%AppData%\web-access\web-access\candidate-index.jsonl`
  （一行一条，只追加不重写；查询走流式 `readline`）。与历史批次**刻意解耦**：删历史批次不影响它，清空也只删
  这一个文件。只存姓名/分数/等级/通过/岗位/评语/时间/姓名拼音串，**不存简历全文、不存 geekId**（三个页面的
  ID 不是同一套编号，跨页面认不出同一个人，故按姓名归并）。写失败只记日志、不阻断导出。UI 入口：左上角 ⋮
  菜单第三项「候选人查询」，按姓名（中文/拼音首字母/全拼）搜索；结果按人分组，组间 `compareNames`、组内按
  评分时间倒序。
- **教育经历顺序**：Excel 教育经历列最高学历在第一行、按时间由近到远（与推荐卡片 DOM 顺序一致）。简历解析优先
  （`fillEducationFromResumeText`），卡片学历只补简历未覆盖的最高学历段。
- **期望字段的来源别混**（2026-10 实测）：搜索卡片 `.exp-box.expect-exp-box` 里 `span.render-two` 依次是
  **城市、岗位**（老卡片只有城市，代码有回退）——期望岗位不用等 OCR；卡片上**没有期望行业与在职时间**，
  这两项只能从简历正文来（在职时间靠 `parseWorkExperienceFromResume` 解析「工作经历」段：v1.16.0 起提取时
  补进 `workExperience[0].time`，导出时为空再补一次，重新导出老批次也能填上）。OCR 出的期望行形如
  `期望职位深圳 | 驱动开发工程师 | 行业不限 | 30-50K`：标签与城市粘连、整行还可能并进上一行。
  `export-candidates.mjs` 的 `parseExpectSection` 一个解析器认两种排版（标题与值同行 / 标题独占一行），
  归到同一套「城市 / 岗位 / 其余项里认薪资与行业」；OCR 那种行必须带 `|` 且有一项像薪资才算数（防正文误命中）。

### 界面交互

- **历史批次详情（v1.20.0）**：历史记录里 `hasScored` 的条目整卡可点（行内按钮除外），打开只读的「批次详情」，
  内容与完成页同一套渲染（`buildScoringResults(dir)` + `renderResultsInto`），别另写一份。它与历史记录**互切**
  而不叠层：用 `swapDialogs(historyOverlay, batchDetailOverlay, …)`（与目标岗位 ⇄ 编辑岗位同一套交叉过渡，
  用户要求），关掉退回历史记录、焦点回到刚才那条。Esc 链必须先判批次详情、再判历史记录——互切动画期间两者
  `display` 都是 `flex`，否则一次 Esc 关两层。`openDialog`/`closeDialog` 的焦点按层栈（`dialogFocusStack`）
  管理保留，供确认弹窗这类真正的叠层使用。
- **目标岗位搜索支持拼音**（`xsqd` → 显示驱动工程师，`neihe`/`neih` → 内核）：`electron/pinyin.mjs` 用
  **pinyin-pro** 取两串——首字母串（按词判多音字：重庆→cq、长沙→cs；覆盖次常用字：深圳→sz、东莞→dg）
  与全拼串（内核→neihe）。渲染进程拿不到 Node 模块，故由主进程 `get-recommend-jobs` 通道**随岗位列表一起**
  返回每条的可搜索文本（岗位名原文 + 首字母串 + 全拼串，已转小写），渲染进程按下标做一句 `includes`——
  原文匹配与拼音匹配合成一条路，不另开通道、不另存平行结构。
  - pinyin-pro 默认用空格分音节（`x s q d`、`nei he`），必须传 `separator: ''`，否则连起来搜不到。
  - 两串之间用空格隔开（`${initials} ${full}`），短查询可能同时命中两串，属正常；全拼串会放宽匹配面
    （`he` 也能搜到「内核」），拼音搜索本就如此，不额外加长度限制。
  - `pinyinSearchText()` 是纯函数，结果按岗位名 memo（列表每次刷新都会重算，但最多只有一个名字变了）。
  - 试过但**不能用**的两个无依赖方案（都实测过，别再走一遍）：① GB2312 边界法（23 个边界字 + iconv 比大小）
    只覆盖一级字库 3755 字，「圳」在二级字库、按部首笔画排，取不到首字母 → `sz` 搜不到深圳；
    ② `Intl.Collator('zh-Hans-u-co-pinyin')` 覆盖面全，但多音字读音与 GB2312 不一致（「曾」读 céng、
    「长」读 zhǎng），边界字错位，「西安」会被判成 ZA。
- **姓名 / 岗位名排序统一用 `compareNames`（`electron/name-sort.mjs`）**：拼音序
  （`Intl.Collator('zh-Hans-CN', { numeric: true })`），字母/数字开头排最前、数字按数值比（`P7` < `P10`）。
  「目标岗位」列表与「候选人查询」结果共用；以后任何面向用户的姓名/岗位列表也走它，别再手写 `Intl.Collator`
  （`pinyin.mjs` 里那套只用于**搜索匹配**、取不出首字母，两件事别混）。

### 基础设施

- **自动归档**：每次新运行前把旧输出目录改名 `output-YYYYMMDD-HHMM`（在主进程做，避开 Windows EBUSY）。
- **Windows GBK**：`termLog()` 与 `decodeBuffer()` 处理 stdout/stderr 的 GBK 解码。
- **CDP 代理**（`scripts/cdp-proxy.mjs`，核心依赖）：
  - 自动发现 Chrome 调试端口（读 `DevToolsActivePort` 文件，或扫 9222/9229/9333），失败重试（`connectWithRetry`）。
  - HTTP API 在 3456：`/eval`、`/screenshot`、`/click`、`/new`、`/navigate`、`/frames`、`/wheel`、
    `/eval-context`、`/health`（另有 `/canvas-copy`，见 canvas 提取）。
  - 按 target 管理 CDP 会话（`ensureSession`），操作落在正确的浏览器 target 上。
  - 反检测：TCP 探测端口（避免 Chrome 弹鉴权框）、`clickAt` 发真实鼠标事件。

## 常用命令

```bash
npm start                                      # 运行应用（GUI）
node scripts/cdp-proxy.mjs                     # 单独跑 CDP 代理（调试）
node scripts/extract-candidates-full.mjs --count 20        # 沟通页提取
node scripts/extract-recommend-candidates.mjs --all        # 推荐页提取
node scripts/extract-search-candidates.mjs --attach --count 20   # 搜索页（挂到已打开的标签页）
node scripts/extract-candidates-full.mjs --resume --count 20     # 断点续跑
node scripts/greet-candidates.mjs --input output/scored-candidates.json --level 4   # 批量打招呼（4 星 = 81+）
node scripts/export-candidates.mjs --input output/scored-candidates.json            # 导出 Excel
npm run icon                                   # 处理应用图标（圆角）
npm run make-ico                               # 生成 build/icon.ico
npm run pack                                   # 完整打包（图标 → electron-builder → NSIS → release）
npm run test:email                             # 邮件模块测试
node --check scripts/extract-common.mjs        # 语法检查
node electron/main.mjs --score-only            # 只评分（无界面，跳过提取）
```

## 版本号与发布

**build.mjs 不再自动递增版本号**。打包前由人工/Claude 判断本轮改动性质，手动改 `package.json` 的 `version`：

- **次版本（x.y.0）**：新增功能 / 明显增强 / 界面或流程变化。例：`1.3.16 → 1.4.0`
- **补丁位（x.y.z）**：修 bug / 微调 / 无用户可见变化的内部改动。例：`1.4.0 → 1.4.1`
- **主版本（x.0.0）**：重大不兼容 / 架构级重写（内部工具基本用不上）

build.mjs 会校验：目标版本 tag 若已存在则拒绝打包。发布说明的提交范围 = 最近一个已发布 tag 到 HEAD。

**一天可更新多个版本号**，但 **GitHub release 只保留当天最新一版**：发布新版时自动删除当天较早的 release
及其 tag。**当天全部版本的更新内容合并到当天这一个 release 的 notes 里**，每个版本各列一个
「### vX.Y.Z 更新内容」小节，同一版本的多条改动按时间顺序排在该小节下。

**Release note 格式（手写友好风格，参考 v1.3.14）**：`## 更新内容（M月D日）` 头 + `### vX.Y.Z 更新内容`
小节头 + 描述性 bullet（`**要点**：说明`），不要用 git commit 列表（`chore:`/`fix:` 前缀）当更新内容。
发布前在项目根目录手写 `RELEASE_NOTES.md`（含日期头、版本小节头、当天全部更新内容），build.mjs 会把它作为
完整定稿直接使用（下载表自动追加）；不写则自动生成结构草稿（版本小节头 + 最近 tag 到 HEAD 的 commit 列表），
需发布前人工改写成描述性 bullet。

## 开发约定

- 全部 ESM（`"type": "module"`，`.mjs`）；需要 Node.js 22+（原生 WebSocket）。
- Chrome 须开远程调试（`chrome://inspect/#remote-debugging`）；OCR 语言包在 `ocr-lang/chi_sim.traineddata.gz`。
- SMTP 默认 `smtp.mxhichina.com:25`（可在 API 配置界面覆盖）。
- 评分提示词模板占位符：`{dimensions}`、`{screeningCriteria}`、`{resumeText}`。
- `output/` 已 gitignore；旧结果自动归档成 `output-YYYYMMDD-HHMM/`。
