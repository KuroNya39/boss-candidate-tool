// electron/data-usage.mjs — 「清空……」按钮旁那句占用提示的口径。
// 两个数字与两个清空动作严格对齐：历史记录只算会被 clear-history 删掉的归档目录，
// 候选人数据只算 candidate-index.jsonl —— 提示的数就是点下去能腾出来的空间。
// 两个清空动作各自删什么：归档目录见 ipc.mjs 的 clear-history，索引见 candidate-index.mjs。
//
// 两边分开算、由调用方指定要哪一个：候选人查询只 stat 一个索引文件，
// 历史记录却要递归扫成千上万张截图，顺手把另一边算完是白花几秒磁盘 I/O。
import { resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { listArchiveDirs } from './archive.mjs';
import { CONFIG_DIR } from './config.mjs';
import { candidateIndexPath } from './candidate-index.mjs';

// 递归累加目录里普通文件的大小，同一层并发发起，别一个个 await 排队。
// 读不到的条目录按 0 算：这是提示，不是账目，不该因为某个文件被占用就让整句提示消失。
async function dirSize(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const sizes = await Promise.all(entries.map(async (entry) => {
    const entryPath = resolve(dir, entry.name);
    if (entry.isDirectory()) return dirSize(entryPath);
    if (!entry.isFile()) return 0;
    try { return (await stat(entryPath)).size; } catch { return 0; }
  }));
  return sizes.reduce((sum, n) => sum + n, 0);
}

// 历史记录占用：只算 <输出目录>/archive/ 下名字形如 YYYYMMDD-HHMM 的归档目录。
// 当前输出目录（正在跑 / 待继续的那批）清空动作不动它，这里也不算。
export async function historyUsageBytes() {
  const dirs = listArchiveDirs();
  const sizes = await Promise.all(dirs.map((dir) => dirSize(dir.path)));
  return sizes.reduce((sum, n) => sum + n, 0);
}

// 候选人数据占用：索引文件本身的体积
export async function candidateUsageBytes() {
  try {
    return (await stat(candidateIndexPath(CONFIG_DIR))).size;
  } catch {
    return 0;
  }
}
