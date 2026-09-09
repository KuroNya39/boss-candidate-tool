// electron/window.mjs — 主窗口创建、等比缩放锁定、6 个进度推送（renderer 进度全部经这里发出）。
import { BrowserWindow, screen } from 'electron';
import { resolve } from 'node:path';
import { ELECTRON_DIR, UNPACKED_ROOT } from './util.mjs';

let mainWindow = null;

// ===== 窗口创建 =====
// 设计稿内容区尺寸（CSS px）。窗口等比放大缩小（锁定宽高比），不是随便拉成任意形状：
// 缩放系数 zoom = min(内容宽/656, 内容高/720)，保证页面内容区按设计稿等比铺满，
// 固定像素布局无需改动即可精确铺满；用户拉伸窗口时跟随内容区实时缩放。
// 原 660×730 是「固定窗口」年代直接留下的旧内容区像素（660 不在设计系统，仅剩宽度观感参考）。
// 设计系统只约束内容列 max-width 720：只要宽度 ≤720，页面就整列流式铺满、不截断不居中。
// 竖长比例由用户从 8 网格方案中选定：656×720 = 82×8 × 90×8，宽:高 0.911（原 660 宽观感不变，
// 高度上移到 8 网格），既符合 8px 原则又不影响既有排版。
const DESIGN_W = 656;
const DESIGN_H = 720;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.5;

function clampZoom(z) {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
}

function fitZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  // 最小化期间内容区尺寸会被压缩/读到临时值，此时缩放会把整窗钉小；
  // 真正需要校准的是还原（restore）后的尺寸，见 createWindow 里的 restore 处理。
  if (mainWindow.isMinimized()) return;
  const [cw, ch] = mainWindow.getContentSize();
  const z = clampZoom(Math.min(cw / DESIGN_W, ch / DESIGN_H));
  if (Math.abs(mainWindow.webContents.getZoomFactor() - z) > 0.001) {
    mainWindow.webContents.setZoomFactor(z);
  }
}

// 锁定窗口宽高比：拖边角整体等比放大缩小（像放大缩小一张图），拉不成扁/瘦形状。
// 帧边框和标题栏不参与比例，需用「窗口尺寸 - 内容尺寸」的固定差值补偿——
// 锁定 (外宽-帧宽)/(外高-帧高) = 设计稿比例，内容区才严格等比，fitZoom 能让两个方向同时铺满。
// 仅普通窗口拉伸态生效；最大化时由系统接管、可能出现留白，属预期。
function lockAspectRatio() {
  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.setAspectRatio) return;
  const [wW, wH] = mainWindow.getSize();
  const [cW, cH] = mainWindow.getContentSize();
  const aspect = (DESIGN_W + (wW - cW)) / (DESIGN_H + (wH - cH));
  mainWindow.setAspectRatio(aspect);
}

export function createWindow() {
  // 启动尺寸：以光标所在显示器工作区为准，等比放大到设计稿并留出边距
  const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const s0 = clampZoom(Math.min((workArea.width * 0.92) / DESIGN_W, (workArea.height * 0.88) / DESIGN_H));

  mainWindow = new BrowserWindow({
    width: Math.round(DESIGN_W * s0),
    height: Math.round(DESIGN_H * s0),
    useContentSize: true,
    resizable: true,
    minWidth: 500,
    minHeight: 580,
    show: false,
    backgroundColor: '#f8fafc',
    title: 'BOSS直聘候选人AI评分助手',
    icon: resolve(UNPACKED_ROOT, 'build', 'app_icon_rounded.png'),
    webPreferences: {
      preload: resolve(ELECTRON_DIR, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.setMenu(null);
  mainWindow.webContents.on('did-finish-load', () => fitZoom());

  // 拖动改窗口大小时，系统会先按"下一次有效尺寸"分步触发 resize；
  // 如果每一条 resize 都立即 fitZoom，偶发会在某个中间帧读到临时的小内容区
  // 而把 zoom 钉小（整窗内容变小），直到再拖一下才恢复。改成防抖：
  // 只在最后一次 resize 之后 ~200ms（尺寸稳定）再 fitZoom 一次。
  let resizeTimer = null;
  mainWindow.on('resize', () => {
    if (mainWindow.isMinimized()) return; // 最小化时的临时 resize 不触发缩放
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fitZoom, 200);
  });
  // 从最小化还原时 resize 不一定触发，必须显式重新校准缩放与宽高比，否则会停留在变形态
  mainWindow.on('restore', () => {
    if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = null; }
    lockAspectRatio();
    fitZoom();
  });
  mainWindow.once('ready-to-show', () => {
    lockAspectRatio(); // 先锁宽高比（帧尺寸此刻已稳定），再缩放到位
    fitZoom();
    mainWindow.center();
    mainWindow.show();
  });
  mainWindow.loadFile(resolve(ELECTRON_DIR, 'renderer', 'index.html'));
}

// ===== 进度推送 =====
export function sendProgress(step, status, progress, message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('progress-update', { step, status, progress, message });
  }
}

export function sendDone(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('extraction-done', data);
  }
}

export function sendError(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('extraction-error', data);
  }
}

// ===== 打招呼进度推送 =====
export function sendGreetProgress(message, current, total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-progress', { message, current, total });
  }
}

export function sendGreetDone(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-done', data);
  }
}

export function sendGreetError(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('greet-error', data);
  }
}
