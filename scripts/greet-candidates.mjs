#!/usr/bin/env node
/**
 * greet-candidates.mjs - 批量自动打招呼
 *
 * 读取 scored-candidates.json，按等级阈值过滤候选人，
 * 通过 CDP 在推荐牛人页上自动点击「打招呼」按钮。
 *
 * Usage:
 *   node scripts/greet-candidates.mjs --input output/scored-candidates.json --level 4
 *
 * --level 参数：
 *   5 = 五星（91-100分）
 *   4 = 四星及以上（81-90分）
 *   3 = 三星及以上（61-80分）
 *   2 = 二星及以上（31-60分）
 *   0 = 全部候选人
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proxyGet, proxyPost, sleep, cdpEval,
} from './extract-common.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// ===== CLI 参数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { level: 4, source: 'recommend' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    if (args[i] === '--level' && args[i + 1]) opts.level = parseInt(args[++i], 10);
    if (args[i] === '--source' && args[i + 1]) opts.source = args[++i];
  }
  if (!opts.input) {
    console.error('Usage: node greet-candidates.mjs --input <scored-candidates.json> --level <5|4|3|2|0> --source <recommend|search>');
    process.exit(1);
  }
  return opts;
}

// ===== 等级阈值 =====
const LEVEL_THRESHOLDS = { 5: 91, 4: 81, 3: 61, 2: 31, 0: 0 };

// ===== 查找 tab =====
async function findTab(source) {
  const targets = await proxyGet('/targets');
  const list = Array.isArray(targets) ? targets : targets.targets || [];
  const urlPattern = source === 'search' ? '/web/chat/search' : '/web/chat/recommend';
  const pageName = source === 'search' ? '搜索页' : '推荐牛人页';
  const tab = list.find(t => t.url && t.url.includes(urlPattern));
  if (!tab || !tab.targetId) {
    throw new Error(
      `未找到${pageName} tab。\n` +
      `请确保已打开 https://www.zhipin.com${urlPattern}`
    );
  }
  return tab.targetId;
}

// ===== iframe 内 JS 执行 =====
async function iframeEval(targetId, expr, source = 'recommend') {
  const frameName = source === 'search' ? 'searchFrame' : 'recommendFrame';
  const wrapped = `(function(){
    var iframe = document.querySelector('iframe[name=${frameName}]');
    if (!iframe) return JSON.stringify({error: 'no-${frameName}'});
    try {
      var iwin = iframe.contentWindow;
      if (!iwin || !iwin.document) return JSON.stringify({error: 'no-content-window'});
      var result = iwin.eval(${JSON.stringify(expr)});
      return JSON.stringify({ok: true, value: result});
    } catch(e) {
      return JSON.stringify({error: e.message});
    }
  })()`;
  const raw = await cdpEval(targetId, wrapped);
  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`iframe 操作失败: ${parsed.error}`);
  return parsed.value;
}

// ===== 核心：给单个候选人打招呼/联系Ta =====
async function greetCandidate(targetId, geekId, name, source = 'recommend') {
  const isSearch = source === 'search';
  const cardSelector = isSearch
    ? `a[data-jid="${geekId}"]`
    : `.card-inner[data-geekid="${geekId}"]`;
  const liSelector = isSearch ? 'li.geek-info-card' : 'li.card-item';
  const btnSelector = isSearch ? 'button.btn-getcontact' : 'button.btn.btn-greet';

  // 搜索页的"联系Ta"按钮有 btn-getcontact 类，推荐页是 btn-greet
  const expr = `(function(){
    var targetEl = document.querySelector('${cardSelector}');
    if (!targetEl) return 'not-found';
    var card = targetEl.closest('${liSelector}');
    if (!card) return 'not-found';
    var btn = card.querySelector('${btnSelector}');
    if (!btn) {
      // 检查是否是已联系/已打招呼状态
      var anyBtn = card.querySelector('button');
      var btnText = anyBtn ? anyBtn.textContent.trim() : '';
      if (btnText === '继续沟通') return 'already-greeted';
      if (btnText.includes('沟通过')) return 'already-greeted';
      if (btnText.includes('已联系')) return 'already-greeted';
      return 'no-greet-btn:' + btnText;
    }
    btn.click();
    return 'clicked';
  })()`;

  const result = await iframeEval(targetId, expr, source);

  if (result === 'not-found') {
    console.log(`GREET_STATUS:${name}|${geekId}|not-found|页面中未找到该候选人`);
    return 'not-found';
  }
  if (result === 'already-greeted') {
    console.log(`GREET_STATUS:${name}|${geekId}|already-greeted|已打过招呼/已联系过`);
    return 'already-greeted';
  }
  if (result === 'clicked') {
    // 等待按钮状态变更，确认成功
    await sleep(1500);

    // 验证按钮状态
    const verify = `(function(){
      var targetEl = document.querySelector('${cardSelector}');
      if (!targetEl) return 'lost';
      var card = targetEl.closest('${liSelector}');
      if (!card) return 'lost';
      var btn = card.querySelector('button');
      return btn ? btn.textContent.trim() : 'no-btn';
    })()`;
    const verified = await iframeEval(targetId, verify, source);

    if (verified === '继续沟通' || verified.includes('沟通过') || verified === '立即沟通' || verified.includes('已联系')) {
      console.log(`GREET_STATUS:${name}|${geekId}|success|联系/打招呼成功`);
      return 'success';
    } else {
      console.log(`GREET_STATUS:${name}|${geekId}|uncertain|点击后状态=${verified}`);
      return 'uncertain';
    }
  }

  // no-greet-btn:xxx
  console.log(`GREET_STATUS:${name}|${geekId}|skip|${result}`);
  return 'skip';
}

// ===== 主流程 =====
async function main() {
  const opts = parseArgs();

  // 1. 读取评分数据
  if (!existsSync(opts.input)) {
    console.error(`未找到文件: ${opts.input}`);
    process.exit(1);
  }
  const raw = JSON.parse(readFileSync(opts.input, 'utf-8'));
  const candidates = raw.candidates || raw;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    console.error('候选人列表为空');
    process.exit(1);
  }

  // 2. 按等级阈值过滤
  const threshold = LEVEL_THRESHOLDS[opts.level];
  if (threshold === undefined) {
    console.error(`无效的等级: ${opts.level}，可用值: 5, 4, 3, 0`);
    process.exit(1);
  }

  const targets = candidates.filter(c => {
    const score = c.totalScore ?? c.jobRelevanceScore ?? 0;
    return score >= threshold;
  });

  if (targets.length === 0) {
    console.log('GREET_DONE:0|0|0|0|没有符合条件的候选人');
    return;
  }

  console.log(`共 ${candidates.length} 人，等级 >= ${threshold} 分，目标 ${targets.length} 人\n`);

  // 3. 连接 CDP，找到对应 tab
  const targetId = await findTab(opts.source);
  const pageName = opts.source === 'search' ? '搜索页' : '推荐牛人页';
  console.log(`已找到${pageName} tab: ${targetId}\n`);

  // 4. 逐人打招呼（每人 30 秒超时，防止单个人卡死整个流程）
  const PER_CANDIDATE_TIMEOUT = 30000;

  let successCount = 0;
  let alreadyCount = 0;
  let notFoundCount = 0;
  let skipCount = 0;

  for (let i = 0; i < targets.length; i++) {
    const c = targets[i];
    const name = c.basicInfo?.name || c.geekId || `候选人${i + 1}`;
    const geekId = c.geekId;
    const score = c.totalScore ?? c.jobRelevanceScore ?? 0;

    if (!geekId) {
      console.log(`GREET_STATUS:${name}|无geekId|skip|缺少 geekId`);
      skipCount++;
      continue;
    }

    console.log(`[${i + 1}/${targets.length}] ${name} (${score}分) ...`);

    // 单个候选人超时保护（30s），防止单个人卡死整个流程
    let result = 'timeout';
    try {
      const timer = new Promise(resolve =>
        setTimeout(() => resolve('timeout'), PER_CANDIDATE_TIMEOUT)
      );
      result = await Promise.race([
        greetCandidate(targetId, geekId, name, opts.source),
        timer,
      ]);
    } catch (err) {
      console.log(`[greet] ${name} 异常: ${err.message}`);
      result = 'error';
    }

    switch (result) {
      case 'success':
        successCount++;
        break;
      case 'already-greeted':
        alreadyCount++;
        break;
      case 'not-found':
        notFoundCount++;
        break;
      case 'timeout':
        console.log(`GREET_STATUS:${name}|${geekId}|timeout|操作超时(30s)`);
        skipCount++;
        break;
      default:
        skipCount++;
    }

    // 间隔 3-5 秒防风控
    if (i < targets.length - 1) {
      const delay = 3000 + Math.random() * 2000;
      await sleep(delay);
    }
  }

  // 5. 输出统计
  console.log(`\nGREET_DONE:${successCount}|${alreadyCount}|${notFoundCount}|${skipCount}`);
}

main().catch(err => {
  console.error(`\nGREET_ERROR:${err.message}`);
  process.exit(1);
});
