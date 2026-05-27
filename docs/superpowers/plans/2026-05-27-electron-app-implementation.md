# Electron 桌面应用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为现有 CLI 脚本包装一个 Electron 桌面 GUI，实现一键提取→评分→导出。

**Architecture:** Electron 主进程通过 child_process.spawn 按顺序调用现有脚本，捕获 stdout 做进度推送；渲染进程用原生 HTML/CSS/JS 显示三段式进度。

**Tech Stack:** Electron,原生 HTML/CSS/JS, electron-builder

**Zero-change rule:** 现有 `scripts/` 下的 `.mjs` 文件**一个字符都不改**。

---

### Task 1: 安装 Electron 依赖 & 初始化

**Files:**
- Modify: `package.json`

**思路**：添加 electron 和 electron-builder 到 devDependencies。

- [ ] **Step 1: 安装 electron**

```bash
npm install --save-dev electron
```

- [ ] **Step 2: 安装 electron-builder**

```bash
npm install --save-dev electron-builder
```

- [ ] **Step 3: 更新 package.json 的 scripts 字段**

在 `package.json` 中添加：
```json
{
  "main": "electron/main.mjs",
  "scripts": {
    "start": "electron .",
    "pack": "electron-builder --win portable"
  }
}
```

---

### Task 2: 创建 electron/preload.mjs

**Files:**
- Create: `electron/preload.mjs`

**思路**：使用 contextBridge.exposeInMainWorld 暴露 4 个 IPC 方法给渲染进程，遵循 Electron 安全最佳实践。

**暴露的 API：**
- `window.electronAPI.startExtraction(count)` → 通知主进程开始
- `window.electronAPI.onProgress(callback)` → 监听进度更新
- `window.electronAPI.onDone(callback)` → 监听完成事件
- `window.electronAPI.onError(callback)` → 监听错误事件
- `window.electronAPI.openOutputDir()` → 打开输出目录
- `window.electronAPI.cancelExtraction()` → 取消任务

**Attention:**
- 使用 `ipcRenderer.on` 而非 `ipcRenderer.invoke`（因为主进程主动推送）
- 使用 `ipcRenderer.invoke` 用于请求-响应模式如 `openOutputDir`
- 清理监听器防止内存泄漏

- [ ] **Step 1: 编写 preload.mjs**

---

### Task 3: 创建 electron/main.mjs

**Files:**
- Create: `electron/main.mjs`

**思路**：Electron 主进程，负责窗口管理、脚本执行流程编排、IPC 通信。

**核心功能：**

1. **createWindow**: 创建 BrowserWindow，加载 renderer/index.html
2. **runPipeline(count)**: 按顺序执行三个脚本
   - `node scripts/extract-candidates-full.mjs --count <count>`
   - `node scripts/score-candidates.mjs --input output/zhipin-candidates.json --default`
   - `node scripts/export-candidates.mjs --input output/scored-candidates.json`
3. **parseProgress(step, stdoutLine)**: 解析 stdout 提取进度
4. **handleCancel()**: kill 子进程

**IPC通道实现：**
- `start-extraction` (invoke) → 验证 count，启动 runPipeline
- `cancel-extraction` (on) → 终止当前子进程
- `open-output` (invoke) → shell.openPath(outputDir)
- 主动推送: `progress-update` / `extraction-done` / `extraction-error`

**进度解析规则：**
- extract 阶段: 匹配 `[N/M] 姓名` → `progress = N/M`
- score 阶段: 匹配 `Scored N candidates` → 过半即 100%
- export 阶段: 匹配 `导出成功:` → 100%

**Attention:**
- 使用 `spawn` 而非 `exec`，带 `stdio: ['pipe', 'pipe', 'pipe']`
- 执行前 `process.chdir(appRoot)` 确保脚本路径正确
- 窗口创建时固定尺寸，禁止缩放（保持 UI 整洁）
- 子进程退出后检查 exit code，非 0 则推送错误
- 执行过程中禁用窗口关闭（或关闭时询问）

- [ ] **Step 1: 编写 main.mjs**

---

### Task 4: 创建 electron/renderer/index.html

**Files:**
- Create: `electron/renderer/index.html`

**UI 结构：**

**初始状态：**
- 标题区: "Boss直聘候选人提取分析"
- 配置区: 提取数量输入框 (type=number, default=20, min=1)
- 按钮: "开始提取分析" (大绿色按钮)
- 底部: 输出目录显示

**执行中状态：**
- 3 个步骤卡片垂直排列
  - 当前步骤: 高亮 + 进度条 + 百分比
  - 未到步骤: 灰显 + "等待中"
  - 已完成步骤: 绿色勾 + 摘要
- 取消按钮

**完成状态：**
- 大绿色 ✅
- 摘要: 提取 N 人 / 评分通过 N 人 / 导出文件
- "📂 打开输出目录" 按钮
- "重新开始" 按钮

**错误状态：**
- 红色 ❌
- 错误步骤 + 原因
- "重试" 按钮

- [ ] **Step 1: 编写 index.html**

---

### Task 5: 创建 electron/renderer/style.css

**Files:**
- Create: `electron/renderer/style.css`

**样式要点：**
- 简洁、干净，Windows 原生风格
- 主色调: #4CAF50 (绿色按钮), #f5f5f5 (背景)
- 步骤卡片: 白色背景，圆角，轻微阴影
- 进度条: 绿色渐变填充
- 整体宽度: 600px，居中

- [ ] **Step 1: 编写 style.css**

---

### Task 6: 创建 electron/renderer/renderer.js

**Files:**
- Create: `electron/renderer/renderer.js`

**功能：**
- 通过 `window.electronAPI` 与主进程通信
- 管理三种 UI 状态切换 (initial/running/done/error)
- 更新进度条和步骤文本
- 处理按钮点击事件

**状态机：**

```
initial → 用户点击"开始" → running
running → 全部完成 → done
running → 出错 → error
running → 用户取消 → initial
done → 用户点击"重新开始" → initial
error → 用户点击"重试" → running
```

- [ ] **Step 1: 编写 renderer.js**

---

### Task 7: 创建 electron-builder.yml

**Files:**
- Create: `electron-builder.yml`

**打包配置：**
```yml
appId: com.web-access.candidate-tool
productName: Boss直聘候选人提取分析
directories:
  output: dist
files:
  - electron/**/*
  - scripts/**/*
  - package.json
  - node_modules/**/*
  - "!node_modules/electron-builder/**"
win:
  target:
    - target: portable
      arch: [x64]
extraMetadata:
  main: electron/main.mjs
```

- [ ] **Step 1: 编写 electron-builder.yml**

---

### Task 8: 安装依赖 & 验证启动

- [ ] **Step 1: 安装依赖**

```bash
npm install
```

- [ ] **Step 2: 验证 Electron 能启动**

```bash
npm start
```

窗口能正常显示初始界面即可。

- [ ] **Step 3: 验证打包**

```bash
npm run pack
```

确认 dist/ 下生成 portable exe。
