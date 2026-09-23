// electron/main.mjs — 应用入口（瘦身版）。
// 原 2623 行已按职责拆分到同目录兄弟模块（依赖见下），这里只保留生命周期 + --score-only 无界面分支：
//   util.mjs       路径/日志/工具        state.mjs       全部可变状态+setter
//   config.mjs     配置与岗位存储         window.mjs      窗口+进度推送
//   archive.mjs    历史归档读写           scoring.mjs     AI 评分
//   runner.mjs     子进程脚本执行         chrome.mjs      Chrome/CDP proxy
//   incremental.mjs 增量评分器           pipeline.mjs    主流程编排
//   greet.mjs      批量打招呼             ipc.mjs         IPC handler
import { app, BrowserWindow } from 'electron';
import { mkdirSync } from 'node:fs';
import { termLog } from './util.mjs';
import { loadApiConfig, JD_DIR } from './config.mjs';
import { registerIPC } from './ipc.mjs';
import { createWindow } from './window.mjs';
import { startCdpProxy } from './chrome.mjs';
import { runPipeline } from './pipeline.mjs';
import { currentProcess, setCurrentProcess, cdpProxyProcess, setCdpProxyProcess } from './state.mjs';

// ===== 应用生命周期 =====
app.whenReady().then(() => {
  // 启动版权 banner：只写终端与 app.log，界面上没有日志面板，日常使用看不到。
  // 作用是留下署名痕迹（署名 + 仓库 + 许可协议），别指望它拦住想抄的人。
  termLog(`[main] BOSS直聘候选人AI评分助手 v${app.getVersion()} · © 2026 KuroNya39 · github.com/KuroNya39 · PolyForm Noncommercial 1.0.0`);
  loadApiConfig();
  mkdirSync(JD_DIR, { recursive: true });
  registerIPC();

  // 非阻塞启动 CDP 代理（后台进行，不阻塞窗口创建）
  startCdpProxy();

  const scoreOnly = process.argv.includes('--score-only');
  if (scoreOnly) {
    // 无界面模式：只跑评分+导出（跑完自动退出，避免无窗口进程挂起）
    termLog('[main] 模式： --score-only（跳过提取，直接评分导出）');
    runPipeline(20, true, true, 'chat', '').then(() => {
      termLog('[main] --score-only 完成，进程退出');
      app.exit(0);
    }).catch((err) => {
      termLog(`[main] --score-only 异常： ${err.message}`, 'stderr');
      app.exit(1);
    });
    return;
  }

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (currentProcess) { currentProcess.kill(); setCurrentProcess(null); }
  if (cdpProxyProcess) { cdpProxyProcess.kill(); setCdpProxyProcess(null); }
  if (process.platform !== 'darwin') app.quit();
});
