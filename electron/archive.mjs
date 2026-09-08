// electron/archive.mjs — 历史归档目录的元数据读取与还原（叶模块，供评分/主流程/IPC 共用）。
import { resolve, basename } from 'node:path';
import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { termLog } from './util.mjs';
import { OUTPUT_DIR } from './state.mjs';

// 历史归档目录名校验：必须形如 {输出目录名}-YYYYMMDD-HHMM，防止误删/误操作任意目录
export function archiveDirNameMatches(name) {
  const baseName = basename(OUTPUT_DIR);
  return new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d{8}-\\d{4}$`).test(name);
}

// 读取某目录里记录的运行元数据（来源/岗位/数量），供继续提取还原环境
export function readRunMeta(dir) {
  try {
    const metaPath = resolve(dir, '.run-meta.json');
    if (existsSync(metaPath)) return JSON.parse(readFileSync(metaPath, 'utf-8'));
  } catch {}
  return null;
}

// 读取某目录批次的「数据自带页面证据」：提取子进程已把 --source 写进扫描缓存/进度/结果文件，
// 这些文件只会由「真正跑过该页面的那次提取」生成。而 .run-meta.json 可能因评分流程/旧版 bug
// 丢失或被覆盖成 chat，评分兜底还可能把错误的 chat 一路写进结果文件——
// 故 'chat' 只是默认值、不算证据（真·沟通页批次靠 meta 里的 chat 记录），
// 只有数据明确写了推荐/搜索等具体页面时才以它为准，优先级同 readScorableCandidates：
// 完整输出 → 进度 → 扫描缓存 → 评分结果。
export function readBatchSource(dir) {
  const pick = (name) => {
    const p = resolve(dir, name);
    if (!existsSync(p)) return null;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf-8'));
      const s = raw?.source;
      return (typeof s === 'string' && s && s !== 'chat') ? s : null;
    } catch { return null; }
  };
  return pick('zhipin-candidates.json')
    || pick('.extract-progress.json')
    || pick('.scan-cache.json')
    || pick('scored-candidates.json')
    || null;
}

// 综合判断某目录批次在界面上应显示/续跑/评分所用的「页面来源」：
// 1) meta 里明确写了具体页面（推荐/搜索，非默认占位 chat）= 用户那批实际选的页面，最可信，直接用；
// 2) meta 只是 chat 或缺失（可能是旧版把别的页面盖成 chat，或 meta 丢失）→ 若数据里写了具体页面则以数据为准；
// 3) 都没线索才退回 chat（沟通页是默认来源；真·沟通批次的 meta 本就记 chat）。
// 这样既不会让推荐批次被误标成沟通，也不会让沟通批次因 meta 丢失而显示「未知来源」。
export function resolveBatchSource(dir, meta) {
  const metaSrc = meta?.source;
  if (metaSrc && metaSrc !== 'chat') return metaSrc;
  return readBatchSource(dir) || metaSrc || 'chat';
}

// 把一个历史归档目录还原为当前输出目录：先把当前输出目录挪开（若不为空），再改名还原。
// 返回 { ok } 或 { error }。
export function restoreHistoryToOutput(dirPath) {
  try {
    if (existsSync(OUTPUT_DIR)) {
      const entries = readdirSync(OUTPUT_DIR);
      if (entries.length > 0) {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
        renameSync(OUTPUT_DIR, `${OUTPUT_DIR}-${stamp}`);
        termLog(`[resume] 已把当前输出目录归档: ${OUTPUT_DIR}-${stamp}`);
      }
    }
    renameSync(dirPath, OUTPUT_DIR);
    termLog(`[resume] 已还原历史目录为输出目录: ${OUTPUT_DIR}`);
    return { ok: true };
  } catch (err) {
    termLog(`[resume] 还原目录失败: ${err.message}`, 'stderr');
    return { error: `还原历史目录失败: ${err.message}` };
  }
}
