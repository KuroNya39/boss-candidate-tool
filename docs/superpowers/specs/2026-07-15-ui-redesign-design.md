# UI Redesign: Boss直聘候选人提取分析工具

## Overview

Complete UI/UX redesign of the Electron-based candidate extraction and analysis tool. Transform from a flat, unstructured interface into a modern, professional tool with clear visual hierarchy,科技感 light theme, and improved user experience.

## Design Principles

1. **Clear Information Hierarchy** — Separate "run configuration" from "global settings" via card-based layout
2. **Professional & Modern** — Light tech-style with glassmorphism accents, blue-purple gradients
3. **Efficiency First** — All daily operations visible in one view, no unnecessary clicks
4. **Visual Feedback** — Clear progress states, status indicators, and transitions

## Color System

| Token | Value | Usage |
|-------|-------|-------|
| `--bg-page` | `#f8fafc` | Page background |
| `--bg-card` | `#ffffff` | Card background |
| `--shadow-card` | `0 1px 3px rgba(0,0,0,0.06)` | Card shadow |
| `--gradient-primary` | `#4f46e5 → #7c3aed` | Primary button, active states |
| `--gradient-hover` | `#4338ca → #6d28d9` | Button hover |
| `--text-primary` | `#0f172a` | Primary text |
| `--text-secondary` | `#475569` | Secondary text |
| `--text-muted` | `#94a3b8` | Muted/placeholder text |
| `--color-success` | `#10b981` | Success states |
| `--color-warning` | `#f59e0b` | Warning states |
| `--color-error` | `#ef4444` | Error states |
| `--border-card` | `#e2e8f0` | Card border |
| `--border-input` | `#cbd5e1` | Input border |
| `--glass-bg` | `rgba(255,255,255,0.8)` | Glassmorphism effects |

## Typography

- Font stack: `'Inter', -apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif`
- Headings: 16px SemiBold
- Body: 14px Regular
- Small/辅助: 12px Regular

## Layout Structure

Window: 660×730, non-resizable (unchanged)

```
┌─────────────────────────────────────┐
│  Header: App title                  │
├─────────────────────────────────────┤
│  Chrome Status Bar (single line)    │
│                                     │
│  ┌── 运行配置 Card ─────────────┐   │ ← Main action area
│  │  Source toggle (card-style)  │   │
│  │  Hint text                   │   │
│  │  Job selector (recommend)    │   │
│  │  Count + extract all         │   │
│  │  Auto-greet (collapsible)    │   │
│  │  [Start button]              │   │
│  └──────────────────────────────┘   │
│                                     │
│  ┌── API配置 Card (collapsible) ─┐  │ ← Global settings, collapsed by default
│  │  Status text (collapsed)     │   │
│  │  Full form (expanded)        │   │
│  └──────────────────────────────┘   │
└─────────────────────────────────────┘
```

## Component Details

### 1. Chrome Status Bar
- Single line, left-aligned
- Green/red dot + status text + optional retry button
- `font-size: 13px`, `color: var(--text-secondary)`

### 2. Source Toggle (Card-style)
- Two toggle buttons side by side: "推荐牛人页" | "沟通页"
- Inactive: white bg, gray border, gray text
- Active: blue-purple gradient bg, white text
- `border-radius: 8px`, `padding: 8px 20px`
- Click toggles visual state (replaces radio buttons)

### 3. Hint Text
- Displayed below source toggle
- Yellow-tinted glass background (`rgba(251,191,36,0.1)`)
- Left border accent in amber
- `font-size: 12px`, `padding: 10px 14px`
- Content changes based on selected source

### 4. Job Selector
- Only visible when "推荐牛人页" selected
- Trigger button style: "请选择岗位 ▸" as placeholder, shows selected job name after selection
- Click opens modal (existing modal pattern, restyled)

### 5. Count Input
- Number input + "提取全部" checkbox
- Same layout as current but with updated input styles

### 6. Auto-Greet Section
- Divider line + checkbox "分析完成后自动打招呼"
- Dropdown with 5 rating levels (same options as current)
- Only visible when checkbox checked
- Separated from main config by a visual divider

### 7. Start Button
- Full-width within card
- Blue-purple gradient background
- `padding: 14px`, `font-size: 16px`
- Hover: slight scale-up (1.02) + deeper gradient
- Disabled: grayed out with reduced opacity

### 8. API Config (Collapsible)
- Header row: ⚙ icon + "API 配置" + status badge ("已配置 ✓" / "未配置")
- Click to toggle expand/collapse
- Expand shows: API URL, Key, Model, Email prefix, Output dir, Save button
- Smooth height transition on toggle

### 9. Running State (3 Steps)
- Steps 1-3 displayed as sections within a single card
- **Active step**: bright text, gradient progress bar, no gray overlay
- **Waiting step**: muted text, empty progress bar, slight transparency
- **Completed step**: green checkmark + green progress bar
- Progress bar shows percentage text overlay
- Skip button + Cancel button at bottom

### 10. Done State
- Large gradient circle checkmark icon
- Summary text (file name, email, output dir)
- Action buttons: Open Dir, Restart
- Greet section with level selector, progress bar, real-time candidate name display

### 11. Greeting Progress Fix
- **Current bug**: Per-candidate status messages like "打招呼成功" shown as global progress, misleading
- **Fix**: Replace per-candidate `GREET_STATUS` display with aggregate progress:
  - Progress text: `正在打招呼 (3/12) ···`
  - Show current candidate name briefly
  - Only show final result (`GREET_DONE`) as completion message

### 12. Error State
- Red circle X icon
- Error message in red-tinted card
- Retry button

### 13. Modals (Job Picker, Job Editor)
- Overlay: `rgba(15,23,42,0.5) + backdrop-filter: blur(4px)`
- Card: white bg, updated shadow
- Same layout as current but with new color tokens

### 14. "跳过提取" Button
- Amber/warning styled button
- Only visible during step 1 running
- Text: "⏭ 跳过提取简历"

## Design Tokens (CSS Variables)

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
```

## Files to Modify

- `electron/renderer/index.html` — Complete restructure
- `electron/renderer/style.css` — Full rewrite with design tokens
- `electron/renderer/renderer.js` — Update DOM refs, greeting progress text logic

## Out of Scope

- Backend/main process changes (except greeting progress text format)
- Window size/resizing changes
- Functional behavior of extraction/scoring/export pipeline
