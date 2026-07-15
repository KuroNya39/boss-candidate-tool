---
date: 2026-04-30
status: draft
---

# 修复简历截图只截第一页的问题

## 问题

大约一半候选人的在线简历只截了1张图，导致 OCR 丢失大量简历内容。

## 根因

Boss 直聘简历弹窗有两种渲染模式：

| 模式 | 滚动机制 | `.resume-detail.scrollTop` |
|------|---------|---------------------------|
| iframe + canvas | canvas 通过 `translateY` 模拟滚动 | 不变（始终为0） |
| 纯 DOM | `.resume-detail` 正常滚动 | 正常变化 |

当前 `scrollResume` 只设置 `.resume-detail.scrollTop`，对 iframe+canvas 模式无效。

`captureResumeScreenshots` 的停滞检测（第812行）通过读取 `scrollTop` 判断是否到底：

```js
if (page > 0 && actualScrollTop <= prevActualTop) {
  break; // canvas 模式下 scrollTop 始终不变，第2页就触发
}
```

canvas 模式下 `scrollTop` 始终不变，第2页就触发停滞检测，提前终止截图。

## 修复方案

区分两种滚动模式，分别处理滚动和停滞检测。

### 1. `getResumeScrollInfo` 新增 `scrollMode` 字段

在返回对象中新增 `scrollMode`：
- `'canvas'`：iframe+canvas 模式（`source` 为 `iframe-canvas-div` 时）
- `'dom'`：纯 DOM 模式（其他所有情况）

### 2. `scrollResume` 支持 canvas 模式滚动

canvas 模式下，进入 iframe 修改 canvas 元素的 CSS transform：

```js
// canvas 模式
var iframe = document.querySelector('.resume-detail iframe');
var idoc = iframe.contentDocument || iframe.contentWindow.document;
var canvas = idoc.querySelector('canvas#resume') || idoc.querySelector('canvas');
if (canvas) {
  canvas.style.transform = 'translateY(-' + scrollTop + 'px)';
}
```

dom 模式保持现有 `el.scrollTop = scrollTop` 逻辑。

`scrollResume` 函数签名新增 `scrollMode` 参数：

```js
async function scrollResume(targetId, scrollTop, scrollMode = 'dom')
```

### 3. 停滞检测根据模式选择判断方式

canvas 模式下，读取 canvas 的实际 `translateY` 值判断是否滚动成功：

```js
// canvas 模式：读取 canvas transform
const actualTranslateY = await cdpEval(targetId, `(function(){
  var iframe = document.querySelector('.resume-detail iframe');
  var idoc = iframe.contentDocument || iframe.contentWindow.document;
  var canvas = idoc.querySelector('canvas#resume') || idoc.querySelector('canvas');
  if (!canvas) return 0;
  var style = window.getComputedStyle(canvas);
  var matrix = style.transform;
  // matrix = "matrix(1, 0, 0, 1, 0, X)" → X 是 translateY
  var match = matrix.match(/matrix\\(([^)]+)\\)/);
  if (match) {
    var parts = match[1].split(',').map(Number);
    return -parts[5]; // translateY 是负值，取反
  }
  return 0;
})()`);

if (page > 0 && actualTranslateY <= prevActualTop) {
  break;
}
prevActualTop = actualTranslateY;
```

dom 模式保持现有 `scrollTop` 检测逻辑。

### 4. 截图后重置 canvas 位置

在 `captureResumeScreenshots` 返回前，如果是 canvas 模式，将 canvas 的 `translateY` 重置为0：

```js
if (scrollMode === 'canvas') {
  await scrollResume(targetId, 0, 'canvas');
}
```

### 改动范围

| 文件 | 函数 | 改动 |
|------|------|------|
| extract-candidates-full.mjs | `getResumeScrollInfo` | 新增 `scrollMode` 字段 |
| extract-candidates-full.mjs | `scrollResume` | 新增 canvas 模式滚动逻辑 |
| extract-candidates-full.mjs | `captureResumeScreenshots` | 传递 `scrollMode`，调整停滞检测，截图后重置 |

无新增文件，无新增依赖。

## 风险

- canvas 的 `transform` 可能被 Boss 直聘的 JS 覆盖：如果页面有滚动事件监听器会重置 transform，需要在滚动后立即截图，避免被覆盖
- iframe 跨域限制：当前代码已在同源 iframe 中操作 `contentDocument`，如果 Boss 直聘改为跨域 iframe 则此方案失效（但现有代码已依赖此能力，说明目前同源）
