#!/usr/bin/env node
/**
 * fetch-resumes.mjs - 在线简历提取脚本
 *
 * 从 scored-candidates.json 读取通过筛选的候选人，
 * 通过 CDP 逐个打开在线简历弹窗，截图后 OCR 提取文字，
 * 保存到 output/resumes/{name}-{index}.txt
 *
 * Usage:
 *   node scripts/fetch-resumes.mjs --input output/scored-candidates.json [--outdir output/resumes]
 *
 * 前置条件：
 *   - CDP Proxy 已运行（端口 3456）
 *   - Chrome 已登录 Boss 直聘招聘端
 *   - 沟通页候选人列表与评分时一致
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = 3456;

// ===== CLI 参数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      opts[key] = args[i + 1];
      i++;
    }
  }
  if (!opts.input) {
    console.error('Usage: node scripts/fetch-resumes.mjs --input <scored-candidates.json> [--outdir <dir>]');
    process.exit(1);
  }
  opts.outdir = opts.outdir || 'output/resumes';
  return opts;
}

// ===== CDP Proxy HTTP 调用 =====
function proxyGet(path) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://localhost:${PROXY_PORT}${path}`, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function proxyPost(path, data) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost', port: PROXY_PORT,
      path, method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { resolve(body); }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(data);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 随机延迟（模拟人类操作节奏，降低风控风险）
function randomDelay(minMs, maxMs) {
  const ms = minMs + Math.random() * (maxMs - minMs);
  return sleep(Math.round(ms));
}

// ===== CDP 快捷操作 =====
async function cdpEval(targetId, expr) {
  const result = await proxyPost(`/eval?target=${targetId}`, expr);
  if (result.error) throw new Error(`eval error: ${result.error}`);
  return result.value;
}

async function cdpScreenshot(targetId, filePath, clip) {
  let url = `/screenshot?target=${targetId}&file=${encodeURIComponent(filePath)}`;
  if (clip) {
    url += `&clip=${clip.x},${clip.y},${clip.width},${clip.height}`;
  }
  return proxyGet(url);
}

// ===== 在线简历弹窗操作 =====

// 等待候选人列表加载完成
async function waitForCandidateList(targetId, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const count = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`);
      if (count > 0) return count;
    } catch {}
    await sleep(800);
  }
  throw new Error('候选人列表未加载');
}

// 滚动候选人列表使目标 index 可见（处理虚拟滚动）
async function scrollToCandidate(targetId, index) {
  // 检查当前是否有足够的 .geek-item
  const count = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`);
  if (index - 1 < count) return; // 已在 DOM 中

  // 候选人列表容器
  const scrollExpr = `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list');
    if (!list) list = document.querySelector('.geek-list');
    if (!list) return 'no-list';
    // 渐进式滚动：每次向下滚动一屏高度
    list.scrollTop += list.clientHeight;
    return JSON.stringify({ scrolled: list.scrollTop, max: list.scrollHeight });
  })()`;

  for (let attempt = 0; attempt < 10; attempt++) {
    await cdpEval(targetId, scrollExpr);
    await randomDelay(800, 1500); // 等待虚拟滚动更新 DOM
    const newCount = await cdpEval(targetId, `document.querySelectorAll('.geek-item').length`);
    if (index - 1 < newCount) return;
  }
  console.warn(`    ⚠ index=${index} 超出当前可见范围，尝试直接点击`);
}

// 点击候选人卡片（index 为 1-based，含重试）
async function clickCandidate(targetId, index) {
  // 先确保目标候选人在 DOM 中
  await scrollToCandidate(targetId, index);

  // 第一次尝试
  try {
    await cdpEval(targetId, `document.querySelectorAll('.geek-item')[${index - 1}].click()`);
    await randomDelay(1500, 2500);
    return;
  } catch {}

  // 重试
  await randomDelay(800, 1200);
  await cdpEval(targetId, `document.querySelectorAll('.geek-item')[${index - 1}].click()`);
  await randomDelay(1500, 2500);
}

// 点击"在线简历"按钮
async function clickOnlineResume(targetId) {
  const result = await cdpEval(targetId, `(function(){
    var btn = document.querySelector('a.btn.resume-btn-online');
    if (!btn) return 'not-found';
    btn.click();
    return 'clicked';
  })()`);
  if (result === 'not-found') throw new Error('在线简历按钮未找到（该候选人可能未上传在线简历）');

  // 等待弹窗出现
  const maxWait = 8000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const hasDialog = await cdpEval(targetId, `!!document.querySelector('.resume-detail')`);
      if (hasDialog) {
        await randomDelay(1500, 2500); // 额外等待 canvas 渲染完成
        return;
      }
    } catch {}
    await sleep(600);
  }
  throw new Error('简历弹窗未出现');
}

// 获取弹窗区域的坐标（用于区域截图，只截弹窗不截侧边栏）
async function getDialogClip(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    // 尝试多种弹窗容器选择器
    var el = document.querySelector('.boss-popup__wrapper') ||
             document.querySelector('.dialog-wrap') ||
             document.querySelector('.resume-detail');
    if (!el) return JSON.stringify(null);
    var rect = el.getBoundingClientRect();
    return JSON.stringify({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  })()`);
  return JSON.parse(raw);
}

// 从弹窗中提取候选人姓名（用于验证名字是否匹配）
async function extractResumeNameFromDialog(targetId) {
  const name = await cdpEval(targetId, `(function(){
    // 尝试从简历弹窗中获取姓名
    var nameEl = document.querySelector('.resume-detail .name') ||
                 document.querySelector('.resume-detail .geek-name') ||
                 document.querySelector('.resume-detail h1') ||
                 document.querySelector('.resume-detail .resume-name') ||
                 document.querySelector('.boss-popup__body .name');
    if (nameEl) return nameEl.textContent.trim();
    // 兜底：从弹窗标题获取
    var titleEl = document.querySelector('.boss-popup__title');
    if (titleEl) return titleEl.textContent.trim();
    return '';
  })()`);
  return name;
}

// 获取简历 canvas 尺寸和滚动信息
async function getResumeScrollInfo(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var detail = document.querySelector('.resume-detail');
    if (!detail) return JSON.stringify({error: 'no .resume-detail'});
    return JSON.stringify({
      scrollHeight: detail.scrollHeight,
      clientHeight: detail.clientHeight,
      scrollTop: detail.scrollTop
    });
  })()`);
  return JSON.parse(raw);
}

// 探测简历容器的真实可滚动高度
// 思路：不信任 DOM 瞬时 scrollHeight（canvas 懒加载会让它在加载中虚低），
// 改用浏览器原生的 scrollTop 自动 clamp 行为：
//   设 scrollTop = 极大值 → 浏览器会把它截断到真实 maxScrollTop
//   读回 scrollTop 即得真实可滚动边界，再 + clientHeight 得真实总高
// 多轮稳定探测：连续 stableRounds 轮结果一致才认定为稳定高度，避免懒加载中途取值。
async function probeRealScrollHeight(targetId, { maxRounds = 6, stableRounds = 2 } = {}) {
  let lastH = -1;
  let stable = 0;
  let clientHeight = 0;
  let realScrollHeight = 0;
  let rounds = 0;
  for (let round = 0; round < maxRounds; round++) {
    rounds = round + 1;
    const raw = await cdpEval(targetId, `(function(){
      var d = document.querySelector('.resume-detail');
      if (!d) return JSON.stringify({error:'no .resume-detail'});
      var prev = d.scrollTop;
      d.scrollTop = 1e9;                // 故意越界
      var maxTop = d.scrollTop;         // 浏览器 clamp 后 = maxScrollTop
      d.scrollTop = prev;               // 恢复原位
      return JSON.stringify({
        clientHeight: d.clientHeight,
        maxScrollTop: maxTop,
        real: maxTop + d.clientHeight
      });
    })()`);
    const info = JSON.parse(raw);
    if (info.error) throw new Error(info.error);
    clientHeight = info.clientHeight;
    realScrollHeight = info.real;
    if (realScrollHeight === lastH) {
      stable++;
      if (stable >= stableRounds) break;
    } else {
      stable = 1;
      lastH = realScrollHeight;
    }
    await randomDelay(400, 700); // 给懒加载留时间
  }
  return { scrollHeight: realScrollHeight, clientHeight, rounds, stable };
}

// 滚动简历容器
async function scrollResume(targetId, scrollTop) {
  await cdpEval(targetId, `document.querySelector('.resume-detail').scrollTop = ${scrollTop}`);
  await randomDelay(500, 800); // 等待 canvas 重绘，加入随机性
}

// 关闭弹窗
async function closeResumeDialog(targetId) {
  await cdpEval(targetId, `(function(){
    var btn = document.querySelector('.boss-popup__close');
    if (btn) btn.click();
  })()`);
  await randomDelay(800, 1500);
}

// ===== 截图与 OCR =====

async function captureResumeScreenshots(targetId, candidateName, index, tempDir) {
  // 探测优先：用 scrollTop 自动 clamp 行为 + 多轮稳定探测拿到真实滚动高度
  const info = await probeRealScrollHeight(targetId, { maxRounds: 6, stableRounds: 2 });
  const { scrollHeight, clientHeight } = info;
  if (!scrollHeight || !clientHeight) throw new Error('无法探测简历容器尺寸');

  // 使用 75% 步进 (25% 重叠)，确保不遗漏内容
  const step = Math.floor(clientHeight * 0.75);
  const pages = Math.ceil((scrollHeight - clientHeight) / step) + 1;
  const screenshots = [];

  // 获取弹窗区域坐标用于裁剪截图
  const clip = await getDialogClip(targetId);
  if (clip) {
    console.log(`    弹窗区域: x=${clip.x}, y=${clip.y}, ${clip.width}x${clip.height}`);
  }

  console.log(`    简历高度(探测): ${scrollHeight}px, 可视: ${clientHeight}px, 步进: ${step}px, 需截 ${pages} 页 (探测${info.rounds}轮/稳定${info.stable})`);

  for (let page = 0; page < pages; page++) {
    const scrollTop = Math.min(page * step, scrollHeight - clientHeight);
    await scrollResume(targetId, scrollTop);
    const ssPath = resolve(tempDir, `${candidateName}-${index}-p${page}.png`);
    await cdpScreenshot(targetId, ssPath, clip);
    screenshots.push(ssPath);
    // 截图间随机延迟，降低操作频率
    if (page < pages - 1) await randomDelay(300, 600);
  }

  // 恢复滚动位置
  await scrollResume(targetId, 0);
  return screenshots;
}

async function ocrScreenshots(screenshots, worker) {
  const texts = [];
  for (let i = 0; i < screenshots.length; i++) {
    console.log(`    OCR 第 ${i + 1}/${screenshots.length} 页...`);
    const { data: { text } } = await worker.recognize(screenshots[i]);
    texts.push(text.trim());
  }
  return texts.join('\n\n');
}

// ===== 文件名安全处理 =====
function safeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'unknown';
}

// ===== 主流程 =====
async function main() {
  const opts = parseArgs();

  // 读取 scored-candidates
  const inputPath = resolve(opts.input);
  if (!existsSync(inputPath)) {
    console.error(`文件不存在: ${inputPath}`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(inputPath, 'utf8'));
  const candidates = (data.candidates || []).filter((c) => c.passed === true);

  if (candidates.length === 0) {
    console.log('没有通过筛选的候选人，无需提取简历。');
    process.exit(0);
  }

  // 按 index 排序（减少滚动切换）
  candidates.sort((a, b) => (a.index || 0) - (b.index || 0));

  console.log(`\n找到 ${candidates.length} 个通过筛选的候选人，开始提取在线简历...\n`);

  // 确保输出目录
  const outdir = resolve(opts.outdir);
  mkdirSync(outdir, { recursive: true });

  // 临时截图目录
  const tempDir = resolve(outdir, '.temp-screenshots');
  mkdirSync(tempDir, { recursive: true });

  // 初始化 OCR worker（复用跨所有候选人）
  console.log('初始化 OCR 引擎...');
  const { createWorker } = await import('tesseract.js');
  const worker = await createWorker('chi_sim+eng');
  console.log('OCR 引擎就绪\n');

  // 创建新 tab
  console.log('打开 Boss 直聘沟通页...');
  const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
  const targetId = newTab.targetId;
  console.log(`Tab 已创建: ${targetId}`);

  // 等待候选人列表加载
  console.log('等待页面加载...');
  try {
    const listCount = await waitForCandidateList(targetId, 15000);
    console.log(`页面已加载，候选人列表: ${listCount} 项\n`);
  } catch (e) {
    console.error(`页面加载失败: ${e.message}`);
    await proxyGet(`/close?target=${targetId}`);
    process.exit(1);
  }

  const results = { success: [], failed: [] };

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    const name = c.basicInfo?.name || `candidate-${c.index}`;
    const idx = c.index || (i + 1);
    let safename = safeName(name);

    console.log(`[${i + 1}/${candidates.length}] ${name} (index=${idx})`);

    try {
      // 1. 点击候选人
      console.log('  → 点击候选人卡片...');
      await clickCandidate(targetId, idx);

      // 2. 点击在线简历
      console.log('  → 打开在线简历...');
      await clickOnlineResume(targetId);

      // 2b. 验证弹窗中的候选人姓名
      try {
        const dialogName = await extractResumeNameFromDialog(targetId);
        if (dialogName && dialogName !== name) {
          console.warn(`  ⚠ 弹窗姓名 "${dialogName}" ≠ 期望姓名 "${name}"，以弹窗实际姓名为准`);
          safename = safeName(dialogName);
        } else if (dialogName) {
          console.log(`  ✓ 姓名验证通过: ${dialogName}`);
        }
      } catch { /* 姓名提取失败不影响主流程 */ }

      // 3. 截图（只截弹窗区域）
      console.log('  → 截图...');
      const screenshots = await captureResumeScreenshots(targetId, safename, idx, tempDir);

      // 4. OCR
      console.log('  → OCR 识别...');
      const text = await ocrScreenshots(screenshots, worker);

      // 5. 保存
      const outPath = resolve(outdir, `${safename}-${idx}.txt`);
      writeFileSync(outPath, text, 'utf8');
      console.log(`  ✓ 已保存: ${outPath} (${text.length} 字)\n`);
      results.success.push({ name: safename, index: idx, path: outPath, chars: text.length });

      // 6. 关闭弹窗
      await closeResumeDialog(targetId);
    } catch (err) {
      console.error(`  ✗ 失败: ${err.message}\n`);
      results.failed.push({ name, index: idx, error: err.message });

      // 尝试关闭可能打开的弹窗
      try { await closeResumeDialog(targetId); } catch {}
    }

    // 候选人之间加入较长的随机延迟（降低风控风险）
    if (i < candidates.length - 1) {
      const delayMs = 3000 + Math.random() * 5000;
      console.log(`  ⏳ 等待 ${(delayMs / 1000).toFixed(1)}s 后处理下一位...\n`);
      await sleep(delayMs);
    }
  }

  // 关闭 tab
  console.log('关闭 tab...');
  await proxyGet(`/close?target=${targetId}`);

  // 终止 OCR worker
  await worker.terminate();

  // 清理临时截图（可选保留）
  // rmSync(tempDir, { recursive: true, force: true });

  // 输出摘要
  console.log('\n========== 提取结果摘要 ==========');
  console.log(`成功: ${results.success.length} 人`);
  console.log(`失败: ${results.failed.length} 人`);
  if (results.success.length > 0) {
    console.log('\n成功列表:');
    for (const r of results.success) {
      console.log(`  ${r.name} (index=${r.index}): ${r.chars} 字 → ${r.path}`);
    }
  }
  if (results.failed.length > 0) {
    console.log('\n失败列表:');
    for (const r of results.failed) {
      console.log(`  ${r.name} (index=${r.index}): ${r.error}`);
    }
  }
  console.log(`\n简历保存目录: ${outdir}`);

  // 输出 JSON 摘要
  const summaryPath = resolve(outdir, 'fetch-summary.json');
  writeFileSync(summaryPath, JSON.stringify(results, null, 2), 'utf8');
  console.log(`摘要文件: ${summaryPath}`);
}

main().catch((err) => {
  console.error('致命错误:', err.message);
  process.exit(1);
});
