# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Electron desktop app for extracting candidate profiles from Boss直聘 (Boss Zhipin), performing AI scoring, and exporting results to Excel. Uses Chrome DevTools Protocol (CDP) via a proxy to control a Chrome browser instance for web scraping.

## Architecture

```
electron/main.mjs        ← Electron main process (pipeline orchestration, IPC, CDP proxy mgmt)
electron/score-comment.mjs ← Shared scoring helpers: compute match score from comment (weighted base − deductions, with 学历硬性门槛 programmatic backstop) + patch education-deduction comment text
electron/preload.js      ← Context bridge (electronAPI exposed to renderer)
electron/renderer/       ← UI (index.html, renderer.js, style.css)

scripts/cdp-proxy.mjs                   ← HTTP → WebSocket CDP proxy daemon (port 3456)
scripts/extract-common.mjs              ← Shared utilities (CDP calls, OCR engine, progress save/resume)
scripts/extract-candidates-full.mjs     ← Chat page candidate extraction
scripts/extract-recommend-candidates.mjs ← Recommend page candidate extraction
scripts/extract-search-candidates.mjs   ← Search page candidate extraction
scripts/greet-candidates.mjs            ← Batch "say hello" to scored candidates
scripts/export-candidates.mjs           ← Excel export + email sending
scripts/process-icon.mjs                ← App icon processing (resize + rounded corners)
scripts/make-ico.mjs                    ← Generate .ico for electron-builder
build.mjs                               ← Full build pipeline (icon → electron-builder → NSIS → release)

config/scoring-prompt-with-jd.txt   ← AI scoring prompt template (recommend page)
config/scoring-prompt-chat.txt       ← AI scoring prompt template (chat page)
```
> 岗位描述（JD）统一存用户数据目录 `%AppData%\web-access\web-access\jd-descriptions\`（开发/打包一致，重装不丢）。
> 旧的 `config/jd-descriptions` 已废弃，不要再往里面写。

### Pipeline Orchestration (in `main.mjs`)

The `runPipeline()` function drives three sequential steps:

1. **Extract**: Spawns `extract-candidates-full.mjs` or `extract-recommend-candidates.mjs` as a child process via `ELECTRON_RUN_AS_NODE=1`. Stdout is parsed via `parseExtractProgress()` for UI progress updates.
2. **AI Score**: `doAiScoring()` reads `zhipin-candidates.json`, groups by position, scores each candidate against JD via Anthropic API (concurrent sliding window of 20, 2 retries per candidate), writes `scored-candidates.json`.
3. **Export**: Spawns `export-candidates.mjs` child process. Stdout parsed via `parseExportProgress()`. Supports optional email sending via SMTP env vars.

Child process cancellation works by writing `CANCEL\n` to stdin, waiting 2s, then force-killing. AI API calls use an `AbortController` shared across all inflight requests.

### Data Flow

1. **Extraction**: Script → HTTP POST/GET → `cdp-proxy` (port 3456) → WebSocket → Chrome DevTools → Boss直聘 page
2. **OCR**: Screenshots captured via CDP → tesseract.js (`chi_sim`) → `cleanOcrText()` → `dedupePages()` → cleaned text
3. **Scoring**: Candidate data → Anthropic-compatible API (multiple response formats supported) → score + comment → `scored-candidates.json`
4. **Export**: `scored-candidates.json` → ExcelJS → `.xlsx` (optionally emailed via nodemailer)

### Three Extraction Modes

- **Chat page** (`/web/chat`): Clicks candidate cards in left panel, extracts basic info from DOM, opens online resume overlay via `clickOnlineResume()`. Resume dialog appears in `.resume-detail` element with an iframe.
- **Recommend page** (`/web/chat/recommend`): Page content is inside an `<iframe name="recommendFrame">`. All DOM operations use `iframeEval()` (evaluates JS in the iframe's `contentWindow`). Cards clicked directly to open resume popup (no separate "online resume" button). Supports `--attach` mode for manual filtering.
- **Search page** (`/web/chat/search`): Like the recommend page, content lives in an `<iframe name="searchFrame">` and all DOM operations go through `iframeEval()`. Only supports `--attach` mode (attaches to the user's open search tab via `/targets`; no auto-navigation). Resume popup structure: `.boss-popup__wrapper.boss-dialog.dialog-lib-resume` → `.boss-popup__content` → `.resume-detail-wrap` → iframe (`c-resume`, same cross-origin OOPIF situation as recommend). DOM extraction uses the same `findFrameInTree` + execution-context strategy. Greeting uses `--source search`.

### Key Patterns

- **Progress persistence**: `.scan-cache.json` (candidate list cache) + `.extract-progress.json` (per-candidate progress) in output dir. `--resume` flag reads these to skip already-processed candidates.
- **Cleanup**: `doCleanup()` pattern in extraction scripts handles SIGTERM/stdin CANCEL. Main process sends `CANCEL\n` to child process stdin, waits 2s, then force-kills.
- **OCR pipeline**: `captureResumeScreenshots()` scrolls the resume dialog page-by-page → `ocrScreenshots()` runs tesseract.js on each page → `dedupePages()` removes overlap between consecutive pages → `cleanOcrText()` normalizes whitespace, corrects OCR typos, strips boilerplate.
- **截图拉前台是条件式的（v1.3.28）**: `cdpScreenshot()` 每次截图前会先查 `document.visibilityState`，只有标签页不可见（被切到后台/最小化）才调 `/activate`（`Target.activateTarget`）拉回最前；Boss 页本来就在最前（如「开两个 Chrome」边跑边用）时不抢焦点，避免打断用户用别的窗口。拿不到可见状态（页面卡顿）时保守回退为照常 activate。`prepareTab()`（提取开始时）仍无条件 activate 一次。
- **DOM extraction fallback**: `tryExtractResumeTextFromDOM()` — extracts resume text directly from iframe via CDP `Page.getFrameTree` + `Runtime.executionContexts` before falling back to screenshot+OCR. v1.3.27 起再加一道「同域 iframe 直接读取」兜底：execution context 拿不到（非 OOPIF 的简历小网页）时，直接从父页面读 `iframe.contentDocument` 的 `#resume` 文本，绕过 CDP context 查找。v1.3.28 起搜索页再加一道「弹窗直接读文本」兜底（`tryExtractSearchResumeTextFromDOM`）：简历直接渲染在弹窗 DOM（无 iframe / iframe 读不到）时，直接读 `.resume-detail-wrap`/`.boss-popup__content` 的 textContent；全部失败会输出一次弹窗结构诊断。推荐页一直有这个兜底（方式二），搜索页此前漏了。
- **Score output parsing**: `parseSingleScoreResponse()` finds the first valid JSON `{score, comment}` object in the API response, handles markdown code blocks, formats comments with newlines before section headers.
- **权威分数 = 程序化计算**（v1.3.18）：AI 手写的「匹配度评分」算术不可靠，`computeMatchScoreFromComment()` 从评语解析各维度「独立得分×权重」重算加权基础分，再减「其他扣分合计」，作为 `totalScore`；评语里手写的匹配度评分只作解析兜底。打招呼等级过滤也据此判断。
- **学历硬性门槛程序化兜底**（v1.3.26）：AI 常以「最高学历已达标」为由豁免第一学历扣分。只要评语「第一学历」明确为大专/专科或非全日制，`computeMatchScoreFromComment()` 就强制扣 20 分（任职资格扣分从评语独立解析，不依赖 AI 合计）；`patchEducationDeductionComment()` 同步修正评语数字并视情况追加「系统说明」。这两个函数在 `electron/score-comment.mjs`，主进程与重算脚本共用。
- **教育经历顺序**：Excel 教育经历列最高学历在第一行、按时间由近到远排序（与推荐卡片 DOM 提取顺序一致）。简历解析优先（`fillEducationFromResumeText`），卡片学历只补充简历未覆盖的最高学历段。
- **API response compatibility**: `callClaudeAPI()` handles Anthropic standard format, Anthropic thinking blocks, OpenAI Chat format, and raw response formats.
- **Multi-position support**: Candidates grouped by `positionInfo.appliedJob`. Each position's JD loaded from userData `%AppData%\web-access\web-access\jd-descriptions\{position}.txt` (unified for dev/packaged since v1.3.15).
- **Auto-archiving**: Old output directories renamed to `output-YYYYMMDD-HHMM` before each new run (done in main process to avoid Windows EBUSY).
- **Windows GBK encoding**: `termLog()` and `decodeBuffer()` handle GBK encoding for stdout/stderr display on Windows terminals.

## Essential Commands

```bash
# Run Electron app (GUI mode)
npm start

# Standalone CDP proxy (debugging)
node scripts/cdp-proxy.mjs

# Extract candidates (chat page)
node scripts/extract-candidates-full.mjs --count 20

# Extract candidates (recommend page, all)
node scripts/extract-recommend-candidates.mjs --all

# Extract candidates (search page, attach to user's open tab)
node scripts/extract-search-candidates.mjs --attach --count 20

# Extract with resume support
node scripts/extract-candidates-full.mjs --resume --count 20

# Greet scored candidates (level 4 = 81+ points)
node scripts/greet-candidates.mjs --input output/scored-candidates.json --level 4

# Generate app icons
npm run icon          # process-icon.mjs (rounded corners)
npm run make-ico      # make-ico.mjs (build/icon.ico for electron-builder)

# Export to Excel
node scripts/export-candidates.mjs --input output/scored-candidates.json

# Full build (icon → electron-builder → NSIS → release)
npm run pack

# Run tests (email module)
npm run test:email

# Syntax check all files
node --check scripts/extract-common.mjs

# Score-only mode (no UI, skip extraction, score existing data)
node electron/main.mjs --score-only
```

## 版本号规则

**build.mjs 不再自动递增版本号**。打包前由人工/Claude 判断本轮改动性质，手动改 `package.json` 的 `version`，再执行打包：

- **次版本（x.y.0）**：新增功能 / 明显增强 / 界面或流程变化（如加新页面、改评分逻辑）。例：`1.3.16 → 1.4.0`
- **补丁位（x.y.z）**：修 bug / 微调 / 无用户可见变化的内部改动。例：`1.4.0 → 1.4.1`
- **主版本（x.0.0）**：重大不兼容 / 架构级重写（内部工具基本用不上）

build.mjs 会校验：目标版本 tag 若已存在（发布过）则拒绝打包，提示先升版本号。发布说明的提交范围 = 最近一个已发布 tag 到当前 HEAD。

**一天可更新多个版本号**（同一天可以多次 bump、多次构建发布）。但 **GitHub release 只保留当天最新的一版**：发布新版时自动删除当天较早发布的 release 及其 tag（build.mjs 发布后执行清理，只留当天最新）。**当天全部版本的更新内容合并到当天这一个 release 的 notes 里**，**每个版本各列一个「### vX.Y.Z 更新内容」小节**，同一版本的多条改动按时间顺序排在该小节下。

**Release note 格式（手写友好风格，参考 v1.3.14）**：`## 更新内容（M月D日）` 头 + `### vX.Y.Z 更新内容` 小节头 + 描述性 bullet（`**要点**：说明`），不要用 git commit 列表（`chore:`/`fix:` 前缀）作为更新内容。发布前在项目根目录手写 `RELEASE_NOTES.md`（含日期头、版本小节头、当天全部更新内容），build.mjs 会把它作为完整定稿直接使用（下载表自动追加）；不写则自动生成友好结构草稿（版本小节头 + 最近 tag 到 HEAD 的 commit 列表，需发布前人工改写成描述性 bullet）。

## CDP Proxy

The proxy (`scripts/cdp-proxy.mjs`) is a core dependency. It:

- Auto-discovers Chrome's remote debugging port (via `DevToolsActivePort` file or scan on ports 9222/9229/9333)
- Reconnects with retry on failure (`connectWithRetry`)
- Exposes HTTP API on port 3456: `/eval`, `/screenshot`, `/click`, `/new`, `/navigate`, `/frames`, `/wheel`, `/eval-context`, `/health`
- Manages per-target CDP sessions (`ensureSession`) so operations run against the correct browser target
- Includes anti-detection features (TCP-based port probe to avoid Chrome auth popup, `clickAt` for real mouse events)

## Development Notes

- All code uses ESM (`"type": "module"` in package.json, `.mjs` extensions)
- Node.js 22+ required (uses native WebSocket)
- Chrome must have remote debugging enabled (chrome://inspect/#remote-debugging)
- OCR language pack: `ocr-lang/chi_sim.traineddata.gz`
- JD descriptions directory: `%AppData%\web-access\web-access\jd-descriptions\` (one .txt file per position, filename = position name; userData since v1.3.15, no longer `config/jd-descriptions/`)
- SMTP default: `smtp.mxhichina.com:25` (overridable via API config UI)
- The AI scoring prompt template uses `{dimensions}`, `{screeningCriteria}`, `{resumeText}` placeholders
- `output/` is gitignored; old runs auto-archived to `output-YYYYMMDD-HHMM/`
