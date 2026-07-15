# UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete UI redesign of the candidate extraction tool with modern light-tech styling, card-based layout, and improved visual hierarchy.

**Architecture:** Pure frontend changes to HTML/CSS/JS in the Electron renderer. No backend/main process changes except the greeting progress text format. CSS uses custom properties for design tokens. HTML restructured into card-based layout with collapsible sections.

**Tech Stack:** Vanilla CSS (no framework), vanilla JS, Electron renderer process

## Global Constraints

- Window size: 660x730, non-resizable
- Must preserve all existing functionality (extraction, scoring, export, greeting)
- All design tokens must use CSS custom properties defined in `:root`
- Color values must match the spec exactly: `#f8fafc`, `#4f46e5`, `#7c3aed`, `#10b981`, `#0f172a`, etc.
- Must not modify `electron/main.mjs` or `electron/preload.js` except for greeting progress format
- All text remains in Chinese

---

### Task 1: CSS Design Tokens + Reset + Base Layout

**Files:**
- Modify: `electron/renderer/style.css` (lines 1-44)

- [ ] **Step 1: Replace CSS reset and body styles with design tokens**

Replace `*` reset, `body`, and `#app` styles:

```css
:root {
  --bg-page: #f8fafc;
  --bg-card: #ffffff;
  --bg-input: #f8fafc;
  --gradient-primary: linear-gradient(135deg, #4f46e5, #7c3aed);
  --gradient-hover: linear-gradient(135deg, #4338ca, #6d28d9);
  --text-primary: #0f172a;
  --text-secondary: #475569;
  --text-muted: #94a3b8;
  --color-success: #10b981;
  --color-warning: #f59e0b;
  --color-error: #ef4444;
  --border-card: #e2e8f0;
  --border-input: #cbd5e1;
  --shadow-card: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --shadow-elevated: 0 10px 25px rgba(0,0,0,0.08);
  --radius-card: 12px;
  --radius-btn: 8px;
  --radius-input: 6px;
  --transition-fast: 0.15s ease;
  --transition-normal: 0.25s ease;
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Microsoft YaHei', sans-serif;
  background: var(--bg-page);
  color: var(--text-primary);
  user-select: none;
  -webkit-app-region: drag;
}

#app {
  width: 610px;
  margin: 0 auto;
  padding: 20px 24px;
  min-height: 520px;
  -webkit-app-region: no-drag;
}

/* ===== Header ===== */
header h1 {
  font-size: 16px;
  font-weight: 600;
  text-align: center;
  color: var(--text-primary);
  margin-bottom: 16px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--border-card);
  letter-spacing: 0.3px;
}

/* ===== State ===== */
.state {
  display: none;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}
.state.active {
  display: flex;
}
```

- [ ] **Step 2: Run `npm start` to verify app loads without errors**

The app should render with the new background color and font. Header should be centered with a bottom border.

- [ ] **Step 3: Commit**

```bash
git add electron/renderer/style.css
git commit -m "style: add CSS design tokens and base layout"
```

---

### Task 2: Chrome Status Bar (new style)

**Files:**
- Modify: `electron/renderer/index.html` (chrome-status-bar section)
- Modify: `electron/renderer/style.css` (replace old chrome status styles)

- [ ] **Step 1: Update HTML for chrome status bar**

In `index.html`, replace the current chrome-status-bar with:

```html
<div class="status-bar" id="chrome-status-bar">
  <span class="status-dot" id="chrome-status-dot"></span>
  <span class="status-text" id="chrome-status-text">正在检查 CDP 代理...</span>
  <button id="btn-retry-chrome" class="btn-retry" style="display:none;">重试</button>
</div>
```

- [ ] **Step 2: Replace CSS for status bar**

Replace old `.chrome-status-bar`, `.chrome-status-dot`, `.chrome-status-text` styles with:

```css
/* ===== Chrome Status Bar ===== */
.status-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  font-size: 13px;
  color: var(--text-secondary);
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.status-dot.dot-green {
  background: var(--color-success);
  box-shadow: 0 0 6px rgba(16,185,129,0.4);
}
.status-dot.dot-yellow {
  background: var(--color-warning);
  box-shadow: 0 0 6px rgba(245,158,11,0.4);
  animation: status-pulse 1.5s infinite;
}
.status-dot.dot-red {
  background: var(--color-error);
  box-shadow: 0 0 6px rgba(239,68,68,0.4);
}
@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.status-text {
  flex: 1;
}
.btn-retry {
  font-size: 11px;
  padding: 3px 12px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-btn);
  background: var(--bg-card);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.btn-retry:hover {
  border-color: var(--color-error);
  color: var(--color-error);
}
```

- [ ] **Step 3: Run `npm start` to verify**

Status bar should show as a compact single line with colored dot.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/index.html electron/renderer/style.css
git commit -m "style: update chrome status bar design"
```

---

### Task 3: Card System + Source Toggle (Card-style)

**Files:**
- Modify: `electron/renderer/index.html` (source-section + hint + job-select-section)
- Modify: `electron/renderer/style.css` (new card and toggle styles)

- [ ] **Step 1: Add card wrapper + new source toggle HTML**

In `index.html`, after the status bar, replace the source-section, hints, and config-row with:

```html
<div class="card">
  <div class="card-title">运行配置</div>

  <!-- Source Toggle -->
  <div class="field-group">
    <label class="field-label">提取来源</label>
    <div class="toggle-group" id="source-toggle-group">
      <button class="toggle-btn active" data-source="recommend-attach">推荐牛人页</button>
      <button class="toggle-btn" data-source="chat">沟通页</button>
    </div>
  </div>

  <div id="recommend-hint" class="hint-box" style="display:none;">
    <span class="hint-icon">i</span>
    <span>请先在 Chrome 中打开 Boss 直聘推荐牛人页，并选择岗位、设置筛选条件，不要刷新页面</span>
  </div>
  <div id="chat-hint" class="hint-box" style="display:none;">
    <span class="hint-icon">i</span>
    <span>请先在 Chrome 中打开 Boss 直聘沟通页</span>
  </div>

  <!-- Job selector (recommend only) -->
  <div id="job-select-section" class="field-group" style="display:none;">
    <label class="field-label">目标岗位</label>
    <div class="job-selector">
      <span id="job-display" class="job-display placeholder">请选择岗位</span>
    </div>
  </div>

  <!-- Count -->
  <div class="field-group">
    <label class="field-label">提取数量</label>
    <div class="count-controls">
      <input type="number" id="count-input" class="input-number" value="20" min="1" max="999">
      <span class="count-unit">人</span>
      <label class="checkbox-label">
        <input type="checkbox" id="extract-all" checked>
        <span>提取全部</span>
      </label>
    </div>
  </div>

  <!-- Divider -->
  <div class="card-divider"></div>

  <!-- Auto Greet -->
  <div class="auto-greet-section">
    <label class="checkbox-label">
      <input type="checkbox" id="auto-greet-check">
      <span>分析完成后自动打招呼</span>
    </label>
    <div class="auto-greet-controls" id="auto-greet-controls" style="display:none;">
      <select id="auto-greet-level" class="input-select">
        <option value="5">五星（91-100分）</option>
        <option value="4" selected>四星及以上（81-90分）</option>
        <option value="3">三星及以上（61-80分）</option>
        <option value="2">二星及以上（31-60分）</option>
        <option value="0">全部候选人</option>
      </select>
    </div>
  </div>

  <!-- Start button -->
  <button id="btn-start" class="btn-primary btn-start">
    ▶ 开始提取分析
  </button>
</div>
```

Remove the old auto-greet-section from below (it's now inside the card).

- [ ] **Step 2: Add CSS for card, toggle, hint-box, field-group, etc.**

```css
/* ===== Card ===== */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-card);
  border-radius: var(--radius-card);
  padding: 20px;
  box-shadow: var(--shadow-card);
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.card-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  letter-spacing: 0.3px;
  text-transform: uppercase;
  opacity: 0.8;
}

/* ===== Field Group ===== */
.field-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

/* ===== Toggle Group ===== */
.toggle-group {
  display: flex;
  gap: 0;
  background: var(--bg-page);
  border-radius: var(--radius-btn);
  padding: 3px;
  width: fit-content;
}
.toggle-btn {
  padding: 7px 20px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.toggle-btn.active {
  background: var(--gradient-primary);
  color: #fff;
  box-shadow: 0 1px 4px rgba(79,70,229,0.3);
}
.toggle-btn:hover:not(.active) {
  color: var(--text-primary);
  background: rgba(79,70,229,0.04);
}

/* ===== Hint Box ===== */
.hint-box {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 12px;
  color: #92400e;
  background: rgba(251,191,36,0.08);
  border-left: 3px solid var(--color-warning);
  border-radius: 6px;
  padding: 10px 14px;
  line-height: 1.5;
}
.hint-icon {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(251,191,36,0.2);
  color: var(--color-warning);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}

/* ===== Count Controls ===== */
.count-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.input-number {
  width: 72px;
  padding: 7px 10px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  font-size: 14px;
  text-align: center;
  outline: none;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: border-color var(--transition-fast);
  -webkit-app-region: no-drag;
}
.input-number:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
}
.input-number:disabled {
  background: #f1f5f9;
  color: var(--text-muted);
  cursor: not-allowed;
}
.count-unit {
  font-size: 13px;
  color: var(--text-secondary);
  margin-right: 8px;
}
.checkbox-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 13px;
  color: var(--text-secondary);
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] {
  cursor: pointer;
  accent-color: #4f46e5;
}

/* ===== Card Divider ===== */
.card-divider {
  height: 1px;
  background: var(--border-card);
  margin: 0;
}

/* ===== Auto Greet ===== */
.auto-greet-section {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.auto-greet-controls {
  display: flex;
  align-items: center;
  gap: 6px;
}
.input-select {
  padding: 5px 10px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  font-size: 13px;
  outline: none;
  background: var(--bg-card);
  color: var(--text-primary);
  cursor: pointer;
  -webkit-app-region: no-drag;
}
.input-select:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
}

/* ===== Start Button ===== */
.btn-start {
  width: 100%;
  padding: 14px;
  font-size: 16px;
  font-weight: 600;
  border: none;
  border-radius: var(--radius-btn);
  background: var(--gradient-primary);
  color: #fff;
  cursor: pointer;
  transition: all var(--transition-normal);
  letter-spacing: 0.5px;
  -webkit-app-region: no-drag;
}
.btn-start:hover {
  background: var(--gradient-hover);
  box-shadow: 0 4px 15px rgba(79,70,229,0.3);
}
.btn-start:active {
  transform: scale(0.98);
}
.btn-start:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}
```

- [ ] **Step 3: Run `npm start` to verify**

The card should render with:
- Title "运行配置"
- Toggle buttons for source selection
- Blue-purple gradient active state on toggle
- Hint box with left border accent
- Input fields with updated styling
- Gradient start button

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/index.html electron/renderer/style.css
git commit -m "style: add card layout, source toggle, and config fields"
```

---

### Task 4: Collapsible API Config + Output Dir

**Files:**
- Modify: `electron/renderer/index.html` (api-config section)
- Modify: `electron/renderer/style.css`

- [ ] **Step 1: Update HTML for collapsible API config**

Replace the current `.api-config` div with:

```html
<div class="card collapsible-card" id="api-config-card">
  <div class="collapsible-header" id="api-config-toggle">
    <div class="collapsible-header-left">
      <span class="collapsible-icon">⚙</span>
      <span class="collapsible-title">API 配置</span>
      <span id="config-status" class="config-badge config-missing">未配置</span>
    </div>
    <span class="collapsible-arrow" id="api-config-arrow">▸</span>
  </div>
  <div class="collapsible-body" id="api-config-body" style="display:none;">
    <div class="field-group">
      <label class="field-label">API 地址</label>
      <div class="input-wrap">
        <input type="text" id="api-url" class="input-text" placeholder="https://api.xxx.com">
        <span class="input-clear" data-target="api-url">×</span>
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">API Key</label>
      <div class="input-wrap">
        <input type="password" id="api-key" class="input-text" placeholder="sk-...">
        <span class="input-clear" data-target="api-key">×</span>
      </div>
    </div>
    <div class="field-group">
      <label class="field-label">模型名称</label>
      <div class="input-wrap">
        <input type="text" id="api-model" class="input-text" placeholder="claude-sonnet-...">
        <span class="input-clear" data-target="api-model">×</span>
      </div>
    </div>
    <div class="card-divider"></div>
    <div class="field-group">
      <label class="field-label">邮件通知（可选）</label>
      <div class="input-wrap">
        <input type="text" id="email-prefix" class="input-text" placeholder="zhangsan（发到 zhangsan@allwinnertech.com）">
        <span class="input-clear" data-target="email-prefix">×</span>
      </div>
    </div>
    <div class="card-divider"></div>
    <div class="output-row">
      <span class="output-label">输出目录：</span>
      <span id="output-dir" class="output-path">output/</span>
      <button id="btn-select-dir" class="btn-link">选择目录</button>
      <button id="btn-clear-history" class="btn-link btn-link-danger">清空历史</button>
    </div>
    <button id="btn-save-config" class="btn-save">保存配置</button>
  </div>
</div>
```

Remove the old `.api-config` div entirely.

- [ ] **Step 2: Add CSS for collapsible card**

```css
/* ===== Collapsible Card ===== */
.collapsible-card {
  padding: 0;
  overflow: hidden;
}
.collapsible-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  cursor: pointer;
  -webkit-app-region: no-drag;
  user-select: none;
  transition: background var(--transition-fast);
}
.collapsible-header:hover {
  background: #f8fafc;
}
.collapsible-header-left {
  display: flex;
  align-items: center;
  gap: 8px;
}
.collapsible-icon {
  font-size: 15px;
  opacity: 0.6;
}
.collapsible-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
}
.collapsible-arrow {
  font-size: 14px;
  color: var(--text-muted);
  transition: transform var(--transition-normal);
}
.collapsible-arrow.expanded {
  transform: rotate(90deg);
}
.collapsible-body {
  padding: 0 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  border-top: 1px solid var(--border-card);
}
.config-badge {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 500;
}
.config-badge.config-ok {
  background: rgba(16,185,129,0.1);
  color: var(--color-success);
}
.config-badge.config-missing {
  background: rgba(148,163,184,0.15);
  color: var(--text-muted);
}

/* ===== Input Text ===== */
.input-text {
  width: 100%;
  padding: 8px 32px 8px 12px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  font-size: 13px;
  outline: none;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: 'Consolas', 'Courier New', monospace;
  transition: border-color var(--transition-fast);
  -webkit-app-region: no-drag;
}
.input-text:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
}
.input-text::placeholder {
  color: var(--text-muted);
}

/* ===== Output Row ===== */
.output-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  flex-wrap: wrap;
}
.output-label {
  flex-shrink: 0;
}
.output-path {
  font-family: 'Consolas', 'Courier New', monospace;
  color: var(--text-primary);
  font-size: 12px;
  background: var(--bg-input);
  padding: 3px 8px;
  border-radius: 4px;
}
.btn-link {
  font-size: 12px;
  padding: 3px 10px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  background: var(--bg-card);
  color: #4f46e5;
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.btn-link:hover {
  border-color: #4f46e5;
  background: rgba(79,70,229,0.04);
}
.btn-link-danger {
  color: var(--color-error);
}
.btn-link-danger:hover {
  border-color: var(--color-error);
  background: rgba(239,68,68,0.04);
}

/* ===== Save Button ===== */
.btn-save {
  align-self: flex-start;
  padding: 7px 20px;
  font-size: 13px;
  font-weight: 500;
  border: none;
  border-radius: var(--radius-btn);
  background: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.btn-save:hover {
  background: #e2e8f0;
}
```

- [ ] **Step 3: Run `npm start` to verify**

API config card should show collapsed by default with "⚙ API 配置 [未配置] ▸" header. Click to expand/collapse.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/index.html electron/renderer/style.css
git commit -m "style: collapsible API config card with new design"
```

---

### Task 5: Running State (3 Steps) + Skip Button

**Files:**
- Modify: `electron/renderer/index.html` (state-running section)
- Modify: `electron/renderer/style.css` (step card styles)

- [ ] **Step 1: Update running state HTML**

Replace state-running content with:

```html
<div id="state-running" class="state">
  <div class="card">
    <div class="card-title">执行进度</div>

    <div class="step-item" id="step-1">
      <div class="step-item-header">
        <div class="step-item-left">
          <span class="step-number">1</span>
          <span class="step-item-title">提取候选人信息</span>
        </div>
        <span class="step-item-status" id="step-1-status">等待中</span>
      </div>
      <div class="step-progress">
        <div class="progress-track">
          <div class="progress-fill" id="step-1-bar"></div>
        </div>
        <span class="progress-pct" id="step-1-pct"></span>
      </div>
      <div class="step-msg" id="step-1-msg"></div>
    </div>

    <div class="step-divider"></div>

    <div class="step-item" id="step-2">
      <div class="step-item-header">
        <div class="step-item-left">
          <span class="step-number">2</span>
          <span class="step-item-title">AI 评分</span>
        </div>
        <span class="step-item-status" id="step-2-status">等待中</span>
      </div>
      <div class="step-progress">
        <div class="progress-track">
          <div class="progress-fill" id="step-2-bar"></div>
        </div>
        <span class="progress-pct" id="step-2-pct"></span>
      </div>
      <div class="step-msg" id="step-2-msg"></div>
    </div>

    <div class="step-divider"></div>

    <div class="step-item" id="step-3">
      <div class="step-item-header">
        <div class="step-item-left">
          <span class="step-number">3</span>
          <span class="step-item-title">导出 Excel</span>
        </div>
        <span class="step-item-status" id="step-3-status">等待中</span>
      </div>
      <div class="step-progress">
        <div class="progress-track">
          <div class="progress-fill" id="step-3-bar"></div>
        </div>
        <span class="progress-pct" id="step-3-pct"></span>
      </div>
      <div class="step-msg" id="step-3-msg"></div>
    </div>

    <div class="running-actions">
      <button id="btn-skip-extract" class="btn-skip" style="display:none;">⏭ 跳过提取简历</button>
      <button id="btn-cancel" class="btn-ghost">取消</button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add CSS for step items**

```css
/* ===== Step Items ===== */
.step-item {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.step-item-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.step-item-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.step-number {
  width: 24px;
  height: 24px;
  border-radius: 6px;
  background: var(--bg-page);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
  transition: all var(--transition-normal);
}
.step-item.active .step-number {
  background: var(--gradient-primary);
  color: #fff;
}
.step-item.done .step-number {
  background: var(--color-success);
  color: #fff;
}
.step-item-title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  transition: color var(--transition-normal);
}
.step-item.waiting .step-item-title {
  color: var(--text-muted);
}
.step-item-status {
  font-size: 12px;
  color: var(--text-muted);
}
.step-item.active .step-item-status {
  color: #4f46e5;
  font-weight: 500;
}
.step-item.done .step-item-status {
  color: var(--color-success);
}
.step-progress {
  display: flex;
  align-items: center;
  gap: 10px;
}
.progress-track {
  flex: 1;
  height: 6px;
  background: #e2e8f0;
  border-radius: 3px;
  overflow: hidden;
}
.progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 3px;
  transition: width 0.4s ease;
}
.step-item.active .progress-fill {
  background: var(--gradient-primary);
}
.step-item.done .progress-fill {
  background: var(--color-success);
}
.progress-pct {
  font-size: 12px;
  color: var(--text-muted);
  width: 36px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.step-msg {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.4;
  min-height: 18px;
}
.step-divider {
  height: 1px;
  background: var(--border-card);
}

/* ===== Running Actions ===== */
.running-actions {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding-top: 4px;
}

/* ===== Skip Button ===== */
.btn-skip {
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid #f59e0b;
  border-radius: var(--radius-btn);
  background: rgba(251,191,36,0.1);
  color: #92400e;
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.btn-skip:hover {
  background: rgba(251,191,36,0.2);
  border-color: #d97706;
}
.btn-skip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ===== Ghost Button ===== */
.btn-ghost {
  padding: 8px 18px;
  font-size: 13px;
  font-weight: 500;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-btn);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
  -webkit-app-region: no-drag;
}
.btn-ghost:hover {
  background: #f1f5f9;
  color: var(--text-primary);
}
```

- [ ] **Step 3: Run `npm start` to verify**

Running state should show 3 step items with progress bars and divider lines between them.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/index.html electron/renderer/style.css
git commit -m "style: restyle running state with step items and progress"
```

---

### Task 6: Done State + Error State + Modals

**Files:**
- Modify: `electron/renderer/index.html` (state-done, state-error)
- Modify: `electron/renderer/style.css`

- [ ] **Step 1: Update done state HTML**

Replace state-done content with:

```html
<div id="state-done" class="state">
  <div class="card">
    <div class="result-header">
      <div class="result-icon-circle success">
        <span class="result-icon-check">✓</span>
      </div>
      <div class="result-title">全部完成！</div>
    </div>
    <div class="result-summary" id="done-summary"></div>
    <div class="result-actions">
      <button id="btn-open-dir" class="btn-primary btn-action">📂 打开输出目录</button>
      <button id="btn-restart" class="btn-ghost">🔄 重新开始</button>
    </div>

    <div id="greet-section" class="greet-section" style="display:none;">
      <div class="card-divider"></div>
      <div class="greet-title">批量打招呼</div>
      <div class="greet-controls">
        <select id="greet-level" class="input-select">
          <option value="5">五星（91-100分）</option>
          <option value="4" selected>四星及以上（81-90分）</option>
          <option value="3">三星及以上（61-80分）</option>
          <option value="2">二星及以上（31-60分）</option>
          <option value="0">全部候选人</option>
        </select>
        <span id="greet-count" class="greet-count-text"></span>
      </div>
      <div class="greet-actions">
        <button id="btn-start-greet" class="btn-primary btn-small">开始打招呼</button>
        <button id="btn-cancel-greet" class="btn-ghost btn-small" style="display:none;">取消</button>
      </div>
      <div id="greet-progress" class="greet-progress" style="display:none;">
        <div class="progress-track">
          <div class="progress-fill" id="greet-progress-bar"></div>
        </div>
        <div class="greet-progress-text" id="greet-progress-text"></div>
      </div>
      <div id="greet-result" class="greet-result" style="display:none;"></div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Update error state HTML**

Replace state-error content with:

```html
<div id="state-error" class="state">
  <div class="card">
    <div class="result-header">
      <div class="result-icon-circle error">
        <span class="result-icon-check">✕</span>
      </div>
      <div class="result-title">执行出错</div>
    </div>
    <div class="error-message" id="error-message"></div>
    <button id="btn-retry" class="btn-primary btn-action" style="align-self:center;">重试</button>
  </div>
</div>
```

- [ ] **Step 3: Add CSS for result states and modals**

```css
/* ===== Result Header ===== */
.result-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}
.result-icon-circle {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
}
.result-icon-circle.success {
  background: linear-gradient(135deg, #10b981, #34d399);
}
.result-icon-circle.error {
  background: linear-gradient(135deg, #ef4444, #f87171);
}
.result-icon-check {
  font-size: 28px;
  color: #fff;
  font-weight: 700;
}
.result-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

/* ===== Result Summary ===== */
.result-summary {
  font-size: 14px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.8;
  padding: 4px 0;
}

/* ===== Result Actions ===== */
.result-actions {
  display: flex;
  gap: 10px;
  justify-content: center;
}
.btn-action {
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all var(--transition-normal);
  -webkit-app-region: no-drag;
}
.btn-action:hover {
  box-shadow: 0 4px 15px rgba(79,70,229,0.3);
}

/* ===== Error Message ===== */
.error-message {
  background: rgba(239,68,68,0.06);
  border: 1px solid rgba(239,68,68,0.15);
  border-radius: 8px;
  padding: 12px 16px;
  font-size: 13px;
  color: var(--color-error);
  line-height: 1.5;
  word-break: break-all;
}

/* ===== Greet Section ===== */
.greet-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-top: 4px;
}
.greet-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}
.greet-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}
.greet-count-text {
  font-size: 12px;
  color: var(--text-muted);
}
.greet-actions {
  display: flex;
  gap: 8px;
}
.greet-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.greet-progress-text {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
}
.greet-result {
  font-size: 13px;
  color: var(--color-success);
  text-align: center;
  padding: 10px;
  background: rgba(16,185,129,0.06);
  border: 1px solid rgba(16,185,129,0.15);
  border-radius: 6px;
}
.greet-result.greet-result-error {
  color: var(--color-error);
  background: rgba(239,68,68,0.06);
  border-color: rgba(239,68,68,0.15);
}

/* ===== Modal Overlay ===== */
.dialog-overlay {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  background: rgba(15,23,42,0.4);
  backdrop-filter: blur(4px);
  -webkit-backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog-box {
  background: var(--bg-card);
  border-radius: var(--radius-card);
  padding: 24px 28px;
  width: 500px;
  max-width: 90vw;
  box-shadow: var(--shadow-elevated);
}
.dialog-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 18px;
}
.dialog-field {
  margin-bottom: 14px;
}
.dialog-field label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}
.dialog-field input,
.dialog-field textarea {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-input);
  border-radius: var(--radius-input);
  font-size: 14px;
  outline: none;
  background: var(--bg-input);
  color: var(--text-primary);
  transition: border-color var(--transition-fast);
}
.dialog-field input:focus,
.dialog-field textarea:focus {
  border-color: #4f46e5;
  box-shadow: 0 0 0 3px rgba(79,70,229,0.1);
}
.dialog-field textarea {
  font-family: inherit;
  resize: vertical;
  line-height: 1.5;
}
.dialog-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}
.dialog-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
}

/* ===== Primary & Secondary Button (reusable) ===== */
.btn-primary {
  background: var(--gradient-primary);
  color: #fff;
  padding: 10px 24px;
  font-size: 14px;
  font-weight: 500;
  border: none;
  border-radius: var(--radius-btn);
  cursor: pointer;
  transition: all var(--transition-normal);
  -webkit-app-region: no-drag;
}
.btn-primary:hover {
  background: var(--gradient-hover);
  box-shadow: 0 4px 15px rgba(79,70,229,0.3);
}
.btn-primary:disabled {
  background: #cbd5e1;
  cursor: not-allowed;
  box-shadow: none;
}
.btn-small {
  padding: 7px 18px;
  font-size: 13px;
}
```

- [ ] **Step 4: Run `npm start` to verify**

Done state shows gradient circle checkmark, action buttons, and greet section. Error state shows error card with X icon.

- [ ] **Step 5: Commit**

```bash
git add electron/renderer/index.html electron/renderer/style.css
git commit -m "style: restyle done state, error state, modals with new design"
```

---

### Task 7: renderer.js Updates + Greeting Progress Fix

**Files:**
- Modify: `electron/renderer/renderer.js`

- [ ] **Step 1: Update DOM references for new/changed elements**

Update the following DOM references in renderer.js:
- Keep existing references where elements IDs haven't changed
- `btnCancel` → no change (id stays `btn-cancel`)
- `chrom-status-bar` → changed to `chrome-status-bar` (keep old id or use new class)
- Remove old `api-config-title`, `sub-section-title` references (no longer exist in this form)
- Update `configStatus` to use new badge element
- Add reference for `api-config-toggle` and `api-config-body` for collapsible behavior

New references to add:
```js
const apiConfigToggle = document.getElementById('api-config-toggle');
const apiConfigBody = document.getElementById('api-config-body');
const apiConfigArrow = document.getElementById('api-config-arrow');
```

- [ ] **Step 2: Add collapsible toggle handler**

```js
// Collapsible API Config
apiConfigToggle.addEventListener('click', () => {
  const isHidden = apiConfigBody.style.display === 'none';
  apiConfigBody.style.display = isHidden ? 'flex' : 'none';
  apiConfigArrow.classList.toggle('expanded', isHidden);
});
```

- [ ] **Step 3: Update source toggle from radio buttons to card-style toggle**

Replace the radio button change events and source toggle logic. The new toggle uses button click handlers:

```js
// Source toggle (card-style buttons)
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const source = btn.dataset.source;
    selectedSource = source;
    // ... existing source change logic (hints, job selector, etc.)
  });
});
```

- [ ] **Step 4: Update handleProgress for new step structure**

The `stepCards` object needs to reference the new progress percentage elements:

```js
const stepCards = {
  1: {
    card: document.getElementById('step-1'),
    bar: document.getElementById('step-1-bar'),
    pct: document.getElementById('step-1-pct'),
    msg: document.getElementById('step-1-msg'),
    status: document.getElementById('step-1-status'),
  },
  // ... same for 2, 3
};
```

Update `handleProgress` to set `.step-item.active`, `.step-item.done`, `.step-item.waiting` classes and update the `pct` element.

- [ ] **Step 5: Fix greeting progress text**

Replace the current `onGreetProgress` handler to show a fixed progress message instead of per-candidate status:

```js
registerCleanup(
  window.electronAPI.onGreetProgress((data) => {
    // Fix: show "正在打招呼" instead of per-candidate status messages
    const msg = data.message || '';
    if (msg.includes('success') || msg.includes('已打') || msg.includes('未找到') || msg.includes('跳过')) {
      greetProgressText.textContent = '正在打招呼中...';
    } else {
      greetProgressText.textContent = msg || '正在打招呼中...';
    }
  })
);
```

Also in `btnStartGreet` click handler, change the initial text from `'准备中...'` to `'正在打招呼中...'`.

- [ ] **Step 6: Run `npm start` to verify all functionality**

Test the full flow:
1. Source toggle clicks work correctly
2. Collapsible API config opens/closes
3. Steps render with correct active/done/waiting states
4. Greeting starts with "正在打招呼中..." text instead of per-candidate statuses
5. Cancel, restart, retry all work

- [ ] **Step 7: Commit**

```bash
git add electron/renderer/renderer.js
git commit -m "refactor: update renderer for new UI, fix greeting progress text"
```

---

### Task 8: Clean Up Old CSS + Polish

**Files:**
- Modify: `electron/renderer/style.css`

- [ ] **Step 1: Remove all old CSS that was replaced**

Search for and remove these unused old style sections:
- Old `.api-config`, `.api-field`, `.sub-section-title` styles
- Old `.source-section`, `.radio-label` styles  
- Old `.recommend-hint` styles (replaced by `.hint-box`)
- Old `.config-section`, `.config-row` styles
- Old `.step-card` styles (replaced by `.step-item`)
- Old `.greet-section` top-level styles (moved inside card)
- Old `.output-dir-info` styles
- Old `.btn-dir-select` styles
- Old `.btn-secondary`, `.btn-warning` styles (replaced by `.btn-ghost`, `.btn-skip`)

- [ ] **Step 2: Add transition to collapsible body for smooth open/close**

```css
.collapsible-body {
  max-height: 0;
  overflow: hidden;
  transition: max-height var(--transition-normal), padding var(--transition-normal);
}
/* When expanded, JS sets inline style display:flex; a max-height animation would need JS to set max-height */
```

Note: Since collapsible animation with `max-height` requires JS-set values, keep the simpler `display: none/flex` toggle but add a subtle opacity transition:

```css
.collapsible-body {
  padding: 0 20px 20px;
  display: none;
  flex-direction: column;
  gap: 14px;
  border-top: 1px solid var(--border-card);
  animation: fadeIn 0.2s ease;
}
@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Wait — `display: none` elements can't animate. Keep it as-is with the JS `display` toggle. The fade animation would need the body to always be in the DOM but hidden via max-height. This is fine for now.

- [ ] **Step 3: Verify no broken styles**

Run `npm start` and check every state and component visually.

- [ ] **Step 4: Commit**

```bash
git add electron/renderer/style.css
git commit -m "style: remove old CSS, polish transitions and animations"
```
