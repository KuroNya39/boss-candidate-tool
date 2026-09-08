// electron/util.mjs — 路径、终端日志、通用工具（最底层，被所有模块依赖，不反向依赖任何业务模块）
import { app } from 'electron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, appendFileSync } from 'node:fs';
import iconv from 'iconv-lite';

// 本文件所在目录（electron/）。注：不导出 __dirname 这个裸名字（易与局部变量遮蔽），统一叫 ELECTRON_DIR。
export const ELECTRON_DIR = dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = resolve(ELECTRON_DIR, '..');

// 打包后 scripts/config/ocr-lang 在 asarUnpack 目录，子进程通过真实路径访问
export const UNPACKED_ROOT = app.isPackaged
  ? resolve(process.resourcesPath, 'app.asar.unpacked')
  : APP_ROOT;

// ===== 终端日志 GBK 编码 =====
// 所有日志（含子脚本 stdout/stderr）同时写入日志文件，方便排查
const LOG_DIR = resolve(app.getPath('userData'), 'web-access');
const LOG_PATH = resolve(LOG_DIR, 'app.log');
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}
// v1.8.4: 日志统一带时间戳（文件 + 终端）。用来定位「两候选人之间等多久」这类耗时问题，
// 不带时间戳的日志看不出每一步实际花了多少秒。毫秒级便于测出 sub-second 的等待。
function tsPrefix() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `[${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}]`;
}
export function termLog(msg, stream = 'stdout') {
  const prefixed = `${tsPrefix()} ${msg}`;
  try {
    const buf = iconv.encode(prefixed, 'gbk');
    if (stream === 'stderr') {
      process.stderr.write(buf);
      process.stderr.write('\n');
    } else {
      process.stdout.write(buf);
      process.stdout.write('\n');
    }
  } catch {
    if (stream === 'stderr') process.stderr.write(prefixed + '\n');
    else process.stdout.write(prefixed + '\n');
  }
  // 追加到日志文件（同步 append，量不大，不阻塞主流程）
  try { appendFileSync(LOG_PATH, prefixed + '\n'); } catch {}
}

export function decodeBuffer(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return iconv.decode(buf, 'gbk');
  }
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
