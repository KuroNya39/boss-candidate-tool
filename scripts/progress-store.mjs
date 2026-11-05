// scripts/progress-store.mjs — 提取进度与扫描缓存的存取（.scan-cache.json / .extract-progress.json）
// 只碰文件系统，不碰页面：三个提取脚本、取消清理、输出目录归档共用这一份。
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync, renameSync, rmdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { sleep } from './cdp-base.mjs';

// 取消/跳过时等当前那位候选人 OCR 收尾的上限（见 flushProgressOnCancel）。
// 主进程的强杀宽限必须比它大：electron/state.mjs 用这个常量加余量算强杀点，
// 改这里就够，别再去主进程里改一个对不上的数字
export const CLEANUP_OCR_GRACE_MS = 20000;

// 本子进程当前跑的来源（推荐/搜索/沟通）。由 parseArgs 从 --source 读入；
// 供 saveScanCache / saveProgress 写进数据文件，作为批次的「真实来源」存档——
// 即使 .run-meta.json 丢失/被覆盖，历史记录与「继续提取」仍能据此还原正确页面。
let currentRunSource = null;
export function setRunSource(v) { currentRunSource = v; }
export function getRunSource() { return currentRunSource; }

// ===== 进度保存/恢复 =====

export function getScanCachePath(outputPath) {
  return resolve(dirname(outputPath), '.scan-cache.json');
}

export function getProgressPath(outputPath) {
  return resolve(dirname(outputPath), '.extract-progress.json');
}

export function saveScanCache(candidateList, outputPath, source) {
  const cachePath = getScanCachePath(outputPath);
  writeFileSync(cachePath, JSON.stringify({
    scannedAt: new Date().toISOString(),
    totalCandidates: candidateList.length,
    source: source || currentRunSource || undefined, // 记录这批页面真实来源，meta 丢失/被覆盖后仍能从数据本身还原（推荐/搜索/沟通）
    candidates: candidateList,
  }, null, 2), 'utf8');
  console.log(`扫描缓存已保存： ${cachePath} （${candidateList.length} 人）`);
}

export function loadScanCache(outputPath) {
  const cachePath = getScanCachePath(outputPath);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(readFileSync(cachePath, 'utf8'));
    console.log(`加载扫描缓存： ${data.totalCandidates} 人（扫描于 ${data.scannedAt}）`);
    return data;
  } catch {
    return null;
  }
}

export function saveProgress(processedGeekIds, candidates, outputPath, source) {
  const progressPath = getProgressPath(outputPath);
  writeFileSync(progressPath, JSON.stringify({
    updatedAt: new Date().toISOString(),
    source: source || currentRunSource || undefined, // 记录这批页面真实来源，meta 丢失/被覆盖后仍能从数据本身还原（推荐/搜索/沟通）
    processedCount: processedGeekIds.size,
    processedGeekIds: [...processedGeekIds],
    candidates,
  }, null, 2), 'utf8');
}

// 取消/跳过时把进度落盘，并收尾「当前这位候选人」还没跑完的后台 OCR（三个提取脚本共用）。
// 参数：processedIds 已完成 id 的 Set；idOf(candidate) 取它在 Set 里的键（沟通页 geekId，
// 搜索页 expectId || geekId）；其余是脚本里的本地变量。
// v1.3.28：先落盘，别等 OCR 全部收尾——原来等完会被主进程的强杀超时抢先，最近几人白干。
// v1.16.0：等 OCR 的上限 3s → 20s。截图模式下当前这位的 OCR 正在后台跑（与下一位点击重叠），
// 3s 根本不够一份多页简历（实测约 1.5~2s/页，10 页要 15s+）：掐在半路的结果是他只落了半份简历、
// 甚至 resumeText 还是空的，却被写进「已完成」——恢复后拿空简历去评分（分数无意义），
// 下次 --resume 又会跳过他不重抓。主进程的强杀宽限按 CLEANUP_OCR_GRACE_MS 加余量（state.mjs）。
export async function flushProgressOnCancel({ processedIds, candidates, outputPath, prevOcr, pendingCandidate, idOf }) {
  try {
    const raced = await Promise.race([prevOcr.then(() => 'done'), sleep(CLEANUP_OCR_GRACE_MS).then(() => 'timeout')]);
    // 等不到头（超长简历）：把他从「已完成」里摘掉，本轮不评分，留给下次提取重新抓。
    // 只摘「OCR 还在跑的那一位」——弹窗没打开等主动跳过的候选人同样没有 resumeText，
    // 那种是有意跳过、要留在已完成里的，不能一起摘
    if (raced === 'timeout' && pendingCandidate && !pendingCandidate.resumeText) {
      processedIds.delete(idOf(pendingCandidate));
      const idx = candidates.indexOf(pendingCandidate);
      if (idx >= 0) candidates.splice(idx, 1);
      const who = (pendingCandidate.basicInfo && pendingCandidate.basicInfo.name) || idOf(pendingCandidate) || '当前候选人';
      console.log(`  ⏳ ${who} 的简历还没识别完，本轮不计入（下次提取会重新抓）`);
    }
    saveProgress(processedIds, candidates, outputPath);
    console.log(`  💾 取消前已保存进度（${processedIds.size} 人）`);
  } catch (e) {
    console.warn(`  ⚠ 取消前保存进度失败： ${e.message}`);
  }
}

export function loadProgress(outputPath) {
  const progressPath = getProgressPath(outputPath);
  if (!existsSync(progressPath)) return null;
  try {
    const data = JSON.parse(readFileSync(progressPath, 'utf8'));
    console.log(`加载提取进度： ${data.processedCount} 人已完成`);
    return data;
  } catch {
    return null;
  }
}

export function cleanupCacheFiles(outputPath) {
  const files = [getScanCachePath(outputPath), getProgressPath(outputPath)];
  for (const f of files) {
    try {
      if (existsSync(f)) unlinkSync(f);
    } catch {}
  }
}

export function archiveOldOutput(outputDir, isResume) {
  if (isResume) {
    console.log('恢复模式：保留现有 output 目录');
    return;
  }
  // 主进程已在启动子进程前把旧输出目录归档过了（pipeline 里做完归档才写本轮的 .run-meta.json）。
  // 子进程若再归档一次，会把主进程刚写好的本轮 meta 一起卷进归档目录：文件按分钟命名，
  // 两次归档同名合并，于是「上一批的数据」配上「这一批的来源/岗位」——历史记录里就会出现
  // 沟通页批次被标成推荐牛人页这类错标。故主进程下发的运行里子进程不再归档。
  if (process.env.BOSS_OUTPUT_PREARCHIVED === '1') return;
  if (!existsSync(outputDir)) return;
  let entries;
  try {
    entries = readdirSync(outputDir);
  } catch {
    return;
  }
  if (entries.length === 0) return;

  // 逐个文件归档，跳过被锁的文件，避免 Windows 目录重命名 EPERM
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
  const archivedDir = `${outputDir}-${stamp}`;
  mkdirSync(archivedDir, { recursive: true });

  let moved = 0;
  for (const entry of entries) {
    const src = resolve(outputDir, entry);
    const dst = resolve(archivedDir, entry);
    try {
      renameSync(src, dst);
      moved++;
    } catch {
      // 文件被锁，跳过
    }
  }

  if (moved > 0) {
    console.log(`已归档 ${moved} 个文件到： ${archivedDir}`);
  } else {
    // 全部失败时清理空目录
    try { readdirSync(archivedDir).length === 0 && rmdirSync(archivedDir); } catch {}
  }
}
