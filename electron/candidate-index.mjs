// electron/candidate-index.mjs — 「候选人查询」用的评分索引。
//
// 与历史批次（output-*/ 目录）刻意解耦：每批评分完成后，把「一人一条评价」追加进
// %AppData%\web-access\web-access\candidate-index.jsonl，删历史批次不会删掉它。
//
// 用 JSONL（一行一条 JSON）而不是一个大数组：每批只追加、不必整文件重写；查询时也能
// 逐行流式扫，索引涨到几十 MB 时不用把整个文件读进内存。
//
// 不存简历全文（几百 KB/人，会把索引撑到几百 MB），也不存 geekId —— 沟通 / 推荐 / 搜索
// 三个页面的候选人 ID 不是同一套编号，跨页面认不出同一个人，故按姓名归并。
import { resolve } from 'node:path';
import { existsSync, statSync, appendFileSync, createReadStream, mkdirSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { pinyinSearchText } from './pinyin.mjs';
import { summarizeScoredCandidate } from '../scripts/scored-candidate.mjs';

// 索引文件放在 userData 配置目录（调用方传入 CONFIG_DIR，见 config.mjs）。
// 目录由调用方给、本模块不碰 electron：这样整个文件在纯 Node 下也能直接跑（便于验证/重算）
const INDEX_FILENAME = 'candidate-index.jsonl';
const indexPathIn = (dir) => resolve(dir, INDEX_FILENAME);

// 查询结果上限：一个字（如「王」）可能命中几百人，全返回既慢又没法看。
// 100 人 × 每人 20 条足以覆盖「翻某个人旧账」这个用法，超出的在界面上提示再多输几个字。
const MAX_PEOPLE = 100;
const MAX_ENTRIES_PER_PERSON = 20;

// ISO 时间 → 「YYYY-MM-DD」本地日期（候选人查询列表里每条评价的日期标记）
function displayDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 把本次评过的人追加进索引，返回追加条数。调用点在评分收尾（incremental.mjs 的
// finalizeScoring，写 scored-candidates.json 的同一处）：那里拿着刚评完的候选人数组，
// 不必再把几 MB 的结果文件读一遍、解析一遍。异常由调用方兜住，不影响导出。
// 不去重：同一批重评就是一次新评价，按「全部保留」处理（查询列表按时间倒序展示）。
export function appendCandidateIndex(dir, candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return 0;

  const scoredAt = new Date().toISOString(); // 整批共用一个时间：同一批评语的时间戳本就相同
  const lines = [];
  for (const c of candidates) {
    // 展示行原样入库（与完成页 / 批次详情同源，见 scripts/scored-candidate.mjs）：
    // 查询时也能直接交给 renderResultsList，换阈值不会让旧记录的档位与等级对不上
    const row = summarizeScoredCandidate(c);
    lines.push(JSON.stringify({
      ...row,
      scoredAt,
      // 姓名 + 拼音首字母 + 全拼，小写入库：查询时只做一句 includes，
      // 不必每次现算（与岗位搜索共用 pinyin.mjs 的那套取值）
      search: pinyinSearchText(row.name),
    }));
  }

  mkdirSync(dir, { recursive: true }); // 首次运行、配置还没保存过时兜底
  appendFileSync(indexPathIn(dir), lines.join('\n') + '\n', 'utf-8');
  return lines.length;
}

// 按关键词查询（中文原文 / 拼音首字母 / 全拼都能命中），返回可直接交给
// renderResultsList 的扁平候选人数组。按人分组：组内时间倒序、组间按最近一次评分倒序，
// 同一个人的多条评价在列表里相邻。
export async function searchCandidateIndex(dir, query) {
  const q = String(query ?? '').trim().toLowerCase();
  const indexPath = indexPathIn(dir);
  if (!q || !existsSync(indexPath)) return { candidates: [] };

  const groups = new Map();
  const rl = createInterface({ input: createReadStream(indexPath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      // 廉价预筛：search 字段入库时已转小写，原始行里出现不了 q 的行（绝大多数）不必 JSON.parse
      if (!line.includes(q)) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue; // 半行 / 手改坏的记录：跳过，别让一条坏数据毁掉整次查询
      }
      if (!entry || typeof entry.name !== 'string' || typeof entry.search !== 'string') continue;
      if (!entry.search.includes(q)) continue;
      let group = groups.get(entry.name);
      if (!group) {
        group = { name: entry.name, entries: [] };
        groups.set(entry.name, group);
      }
      group.entries.push(entry);
    }
  } finally {
    rl.close();
  }

  // 组内、组间都按评分时间倒序；组间用「该人最近一次评分」，最近更新过的人排在前面
  for (const group of groups.values()) {
    group.entries.sort((a, b) => String(b.scoredAt || '').localeCompare(String(a.scoredAt || '')));
  }
  const ordered = [...groups.values()]
    .sort((a, b) => String(b.entries[0]?.scoredAt || '').localeCompare(String(a.entries[0]?.scoredAt || '')));

  const candidates = [];
  for (const group of ordered.slice(0, MAX_PEOPLE)) {
    for (const e of group.entries.slice(0, MAX_ENTRIES_PER_PERSON)) {
      // 入库的就是展示行，这里只补查询列表要的日期标记（scoredAt / search 不往界面送）
      const { scoredAt, search: _search, ...row } = e;
      candidates.push({ ...row, date: displayDate(scoredAt) });
    }
  }

  return { candidates };
}

// 清空索引（只删这个文件，历史批次与 Excel 一个都不动）。
// cleared 区分「真删了东西」与「本来就没有数据」：界面据此给完成提示或中性提示
export function clearCandidateIndex(dir) {
  const indexPath = indexPathIn(dir);
  if (!existsSync(indexPath)) return { cleared: false };
  let cleared = true;
  try {
    cleared = statSync(indexPath).size > 0; // 空文件（写过又手删内容）也算没数据
  } catch {}
  rmSync(indexPath, { force: true });
  return { cleared };
}
