// electron/util.mjs — 路径、终端日志、通用工具（最底层，被所有模块依赖，不反向依赖任何业务模块）
import { app } from 'electron';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, appendFileSync, statSync, renameSync, rmSync, existsSync } from 'node:fs';
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

// 日志轮转：单个文件写满 LOG_MAX_BYTES 就往后顺延一份，最多留 LOG_KEEP 份
// （app.log + app.log.1 … app.log.4），更旧的直接删掉 —— 体积上限 = 5MB × 5 = 25MB。
// 启动时先量一次现有体积，之后按实际写入累加；写满就在写下一行之前轮转，
// 所以哪怕一次开好几天，也不会长成一个几百 MB 的巨型文件。
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_KEEP = 5;
let logBytes = 0;
try { logBytes = statSync(LOG_PATH).size; } catch {}
function rotateLogs() {
  try {
    // 从最旧的一份往后挪：.4 丢掉，.3→.4，.2→.3，.1→.2，app.log→.1
    rmSync(`${LOG_PATH}.${LOG_KEEP - 1}`, { force: true });
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? LOG_PATH : `${LOG_PATH}.${i - 1}`;
      if (existsSync(from)) renameSync(from, `${LOG_PATH}.${i}`);
    }
  } catch {}
  // 不管成没成，计数都从零开始：成功是换了新文件；失败（文件被占用等）则等再写满
  // 一个 LOG_MAX_BYTES 才重试 —— 否则被占用期间每一行日志都会重跑一遍整套改名
  logBytes = 0;
}
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
  // 追加到日志文件（同步 append，量不大，不阻塞主流程）；写满就先轮转，见上面的 rotateLogs
  try {
    if (logBytes >= LOG_MAX_BYTES) rotateLogs();
    const line = Buffer.from(prefixed + '\n', 'utf8');   // 编码一次，写盘和计数共用
    appendFileSync(LOG_PATH, line);
    logBytes += line.length;
  } catch {}
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
