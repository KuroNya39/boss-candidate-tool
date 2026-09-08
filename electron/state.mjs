// electron/state.mjs — 全部顶层可变运行状态 + 控制助手。
// 约定：读取用活绑定（import { OUTPUT_DIR } 等，ESM 活绑定自动跟随最新值）；
// 重新赋值一律走 setter（imported binding 不可重绑，会抛错）。跨模块迁移时代码改动只落在赋值处。
import { app } from 'electron';
import { resolve } from 'node:path';
import { APP_ROOT } from './util.mjs';

function getDefaultOutputDir() {
  return app.isPackaged
    ? resolve(app.getPath('documents'), 'output')
    : resolve(APP_ROOT, 'output');
}

export let OUTPUT_DIR = getDefaultOutputDir();

// ===== 配置（内存镜像；持久化由 config.mjs 负责） =====
export let apiConfig = {
  url: '', key: '', model: '',
  smtpHost: 'smtp.mxhichina.com', smtpPort: '25', smtpSecure: 'false',
  smtpUser: '', smtpPass: '', smtpFrom: '',
  emailPrefix: '', outputDir: '',
  dimensions: '',    // 3个核心评估维度及权重（JSON字符串）
  screeningCriteria: '', // 任职资格关键筛选项（换行分隔）
};

// ===== 运行状态 =====
export let currentProcess = null;
export let cancelled = false;
export let skipToScoring = false; // 跳过提取步骤，直接使用已提取的数据进行评分
export let skipRecovered = false; // skip 恢复成功标记，用于跳过后续 sendProgress 覆盖
export let tailFlushRequested = false; // v1.8.3：用户点「暂停」时置位，增量评分器下一轮把手头不满一批的零头立刻派发，让进度跟上提取
export let aiAbortController = null; // 用于中断 AI 评分的正在请求
export let actualExportPath = ''; // 导出脚本实际输出的文件路径（可能被另存）
export let exportMailResult = { status: 'none', to: '', error: '' }; // 导出步骤的邮件发送结果（由 MAIL_OK/MAIL_FAIL 标记更新）

// ===== CDP proxy & Chrome 状态 =====
export let cdpProxyProcess = null;
export let cdpStatus = { state: 'initializing', message: '', chromePort: null };
// CDP 红点错误文案：渲染端按「未开启远程调试」判断需用户开启并自动重试，主进程两处设置保持一致
export const CDP_ERR_REMOTE_DEBUG_OFF = 'Chrome 未开启远程调试';

// ===== setter（唯一允许的重绑入口） =====
export function setOutputDir(p) { OUTPUT_DIR = p; }
export function setApiConfig(partial) { apiConfig = { ...apiConfig, ...partial }; }
export function setCurrentProcess(p) { currentProcess = p; }
export function setCancelled(b) { cancelled = b; }
export function setSkipToScoring(b) { skipToScoring = b; }
export function setSkipRecovered(b) { skipRecovered = b; }
export function setTailFlushRequested(b) { tailFlushRequested = b; }
export function setAiAbortController(c) { aiAbortController = c; }
export function setActualExportPath(s) { actualExportPath = s; }
export function setExportMailResult(o) { exportMailResult = o; }
export function setCdpProxyProcess(p) { cdpProxyProcess = p; }
export function setCdpStatus(o) { cdpStatus = o; }

// 当前是否有真正在运行的任务：进程引用还在，且未退出、未被 kill 才算。
// 之前只看 currentProcess 是否非空，进程已退出但 close 事件还没触发（或取消竞态）时会
// 误报「已有任务运行中」，导致一轮跑完/取消后回首页点开始偶尔被拦。
export function hasRunningTask() {
  return !!(currentProcess && currentProcess.exitCode === null && !currentProcess.killed);
}

// 向当前子进程 stdin 写一行控制信号（CANCEL/PAUSE/RESUME）。Windows 下 SIGTERM 不可靠，
// 靠 stdin 通知子进程自行清理。写失败时挂个空 error 监听吞掉 EPIPE，不弹未捕获错误。
export function sendStdinSignal(signal) {
  const p = currentProcess;
  if (p?.stdin?.writable) {
    const onError = () => {};
    p.stdin.on('error', onError);
    p.stdin.write(signal + '\n');
    p.stdin.off('error', onError);
  }
}

// 延迟强杀当前子进程：等 6s 让子进程 doCleanup 先落盘进度再退出（v1.3.28 放宽到 6s）。
// 只杀同一个进程：取消/跳过/停止后若用户已快速开始新任务，currentProcess 已换，
// 不能再按旧引用强杀，否则会误杀新任务并残留一个空引用。
export function scheduleForceKill() {
  const proc = currentProcess;
  setTimeout(() => {
    if (currentProcess === proc) { currentProcess.kill(); currentProcess = null; }
  }, 6000);
}
