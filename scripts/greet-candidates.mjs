#!/usr/bin/env node
/**
 * greet-candidates.mjs - 批量自动打招呼
 *
 * 读取 scored-candidates.json，按等级阈值过滤候选人，
 * 通过 CDP 在推荐牛人页上自动点击「打招呼」按钮。
 *
 * Usage:
 *   node scripts/greet-candidates.mjs --input output/scored-candidates.json --level 4
 *   node scripts/greet-candidates.mjs --retry output/greet-retry.json   # 只重试上次失败名单
 *
 * --level 参数（档位阈值见 ./score-tiers.mjs）：
 *   5 = 五星（91 分以上）
 *   4 = 四星及以上（81 分以上）
 *   3 = 三星及以上（61 分以上）
 *   2 = 二星及以上（31 分以上）
 *   0 = 全部候选人
 *
 * 失败重试机制：普通整批跑完时，把「点过按钮但没确认成功」的人（太频繁/风控/超时/异常）
 * 写进 <input 同目录>/greet-retry.json；界面据此把按钮变成「重试」。--retry 模式只打名单
 * 里的人，不再按等级过滤；跑完把仍失败的人写回（全成功则删除名单）。
 * GREET_DONE 第 5 字段 = 本轮可重试失败数，前 4 位与旧版同义、skip 收窄为不可重试跳过。
 */

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  proxyGet, proxyPost, sleep, cdpEval,
} from './extract-common.mjs';
import { TIER_THRESHOLDS } from './score-tiers.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// 致命错误统一走 GREET_ERROR（stdout），main.mjs 的 stdout 解析才能识别并上报真实原因；
// 所有已知致命路径都从这里退出，stderr 只留给未捕获异常的兜底诊断。
function fatal(msg) {
  console.log(`\nGREET_ERROR:${msg}`);
  process.exit(1);
}

// ===== 停止信号（来自主进程 stdin 的 CANCEL）=====
// main.mjs 的「停止打招呼」会往本脚本 stdin 写一行 CANCEL。旧版脚本不监听 stdin，
// 点了停止后仍在继续给后面的候选人打招呼，直到 6 秒后被主进程强杀（浏览器里已经发出多余招呼）。
// 现在收到 CANCEL 立即置位 stopRequested，唤醒正在等待的延时/单人操作，主循环随即收手退出。
let stopRequested = false;
let stopResolve = null; // 停止时触发的 resolve（只创建一次，所有等待者共享）
const stopSignal = new Promise((resolve) => { stopResolve = resolve; });
function requestStop() {
  if (stopRequested) return;
  stopRequested = true;
  if (stopResolve) stopResolve();
}
// 可取消延时：正常睡满 ms，或已收到停止指令立即返回。
async function cancellableSleep(ms) {
  if (stopRequested) return;
  await Promise.race([sleep(ms), stopSignal]);
}
// 安装停止监听：stdin 的 CANCEL 与 SIGTERM 都走 requestStop。
function installStopHandler() {
  process.stdin.on('data', (data) => {
    if (data.toString().trim() === 'CANCEL') requestStop();
  });
  if (process.stdin && typeof process.stdin.unref === 'function') process.stdin.unref();
  process.on('SIGTERM', requestStop);
}

// ===== CLI 参数解析 =====
// 普通模式必须给 --input；重试模式只给 --retry（名单自带信息，无需再按等级过滤大文件）
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { level: 4, source: 'recommend' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) opts.input = args[++i];
    if (args[i] === '--level' && args[i + 1]) opts.level = parseInt(args[++i], 10);
    if (args[i] === '--source' && args[i + 1]) opts.source = args[++i];
    if (args[i] === '--retry' && args[i + 1]) opts.retry = args[++i]; // 重试名单路径
  }
  if (!opts.input && !opts.retry) {
    fatal('缺少 --input 或 --retry 参数。\nUsage： node greet-candidates.mjs --input <scored-candidates.json> --level <5|4|3|2|0> --source <recommend|search> | --retry <greet-retry.json>');
  }
  return opts;
}

// ===== 可重试失败名单 =====
// 只记「点过按钮但没确认成功」的人（uncertain / 单人超时 / 异常 = 太频繁或风控挡下）。
// 名单文件在 <input 同目录>/greet-retry.json；内容 [{geekId, name, matchScore}] 自带信息，
// 重试时不必再 join 庞大的 scored-candidates.json。已成功 / 已打过 / 页面找不到的人不进名单。
const RETRY_FILE = 'greet-retry.json';
// 重试名单路径：--retry 给了就用它（重试模式读写同一处），否则默认在 input 同目录
function retryPath(opts) {
  return opts.retry || (opts.input ? resolve(dirname(opts.input), RETRY_FILE) : '');
}
// 整批正常开始：清掉可能残留的旧名单（普通模式从零算，不沿用上一批的失败）
function clearRetryFile(path) {
  if (!path) return;
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {}
}
// 跑完收尾：把仍失败的人写回名单（供「重试」只补这些人）；没有失败则删掉旧名单
function writeRetryFile(path, retryList) {
  if (!path) return;
  try {
    if (retryList.length === 0) {
      clearRetryFile(path);
    } else {
      writeFileSync(path, JSON.stringify(retryList, null, 2), 'utf-8');
    }
  } catch (err) {
    console.log(`[greet] 写入可重试名单失败： ${err.message}`);
  }
}

// ===== 查找 tab =====
async function findTab(source) {
  const targets = await proxyGet('/targets');
  const list = Array.isArray(targets) ? targets : targets.targets || [];
  const urlPattern = source === 'search' ? '/web/chat/search' : '/web/chat/recommend';
  const pageName = source === 'search' ? '搜索页' : '推荐牛人页';
  const tab = list.find(t => t.url && t.url.includes(urlPattern));
  if (!tab || !tab.targetId) {
    throw new Error(
      `未找到${pageName}标签页。\n` +
      `请确保已打开 https://www.zhipin.com${urlPattern}。`
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
  if (parsed.error) throw new Error(`iframe 操作失败： ${parsed.error}`);
  return parsed.value;
}

// ===== 核心：给单个候选人打招呼/联系Ta =====
async function greetCandidate(targetId, geekId, name, source = 'recommend') {
  const isSearch = source === 'search';
  const cardSelector = isSearch
    ? `a[data-jid="${geekId}"]`
    : `.card-inner[data-geekid="${geekId}"], .card-inner[data-geek="${geekId}"]`;
  // 兼容两种卡片结构：推荐/精选导航 li.card-item，最新导航 .candidate-card-wrap
  const liSelector = isSearch ? 'li.geek-info-card' : 'li.card-item, .candidate-card-wrap';
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
    // 等待按钮状态变更，确认成功（停止指令可打断等待，尽快收手）
    await cancellableSleep(1500);

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
  installStopHandler(); // 尽早监听，主流程任何阶段收到停止都能即时响应

  const retryMode = !!opts.retry; // 重试：只打上次「点过没成」的人
  const rPath = retryPath(opts);

  // 目标列表统一成 [{geekId, name, matchScore}]：普通模式读评分数据按等级过滤；
  // 重试模式读失败名单（不再按 level 过滤，只补名单里的人）
  let targets;
  let sourceInfo;
  if (retryMode) {
    if (!rPath || !existsSync(rPath)) {
      fatal(`未找到可重试名单： ${rPath || '未知路径'}`);
    }
    let list;
    try {
      list = JSON.parse(readFileSync(rPath, 'utf-8'));
    } catch (err) {
      fatal(`读取可重试名单失败： ${err.message}`);
    }
    if (!Array.isArray(list) || list.length === 0) {
      console.log('GREET_DONE:0|0|0|0|0'); // 名单已空：无事可做，干净收尾
      return;
    }
    targets = list.filter(t => t && t.geekId && t.name).map(t => ({
      geekId: t.geekId,
      name: t.name,
      matchScore: t.matchScore ?? 0,
    }));
    sourceInfo = `重试上次失败的 ${targets.length} 人`;
  } else {
    // 普通整批：先清掉上一批可能残留的失败名单，从零开始
    clearRetryFile(rPath);

    // 1. 读取评分数据
    if (!existsSync(opts.input)) {
      fatal(`未找到文件： ${opts.input}`);
    }
    const raw = JSON.parse(readFileSync(opts.input, 'utf-8'));
    const candidates = raw.candidates || raw;
    if (!Array.isArray(candidates) || candidates.length === 0) {
      fatal('候选人列表为空');
    }

    // 2. 按等级阈值过滤
    const threshold = TIER_THRESHOLDS[opts.level];
    if (threshold === undefined) {
      fatal(`无效的等级： ${opts.level}，可用值： 5, 4, 3, 2, 0`);
    }

    const matched = candidates.filter(c => {
      // 匹配度评分优先（与评语/输出结果严格一致），无则退回 totalScore/jobRelevanceScore
      const score = c.matchScore ?? c.totalScore ?? c.jobRelevanceScore ?? 0;
      return score >= threshold;
    });

    if (matched.length === 0) {
      console.log('GREET_DONE:0|0|0|0|0'); // 该档没人可打
      return;
    }

    targets = matched.map(c => ({
      geekId: c.geekId,
      name: c.basicInfo?.name || c.geekId || '未知',
      matchScore: c.matchScore ?? c.totalScore ?? c.jobRelevanceScore ?? 0,
    }));
    sourceInfo = `共匹配 ${targets.length} 人（level=${opts.level}）`;
  }

  console.log(`${sourceInfo}\n`);

  // 3. 连接 CDP，找到对应 tab
  const targetId = await findTab(opts.source);
  const pageName = opts.source === 'search' ? '搜索页' : '推荐牛人页';
  console.log(`已找到${pageName}标签页： ${targetId}\n`);

  // 4. 逐人打招呼（每人 30 秒超时，防止单个人卡死整个流程）
  const PER_CANDIDATE_TIMEOUT = 30000;

  let successCount = 0;
  let alreadyCount = 0;
  let notFoundCount = 0;
  let skipCount = 0; // 不可重试的跳过：页面根本没有可点的打招呼按钮
  let retryableCount = 0; // 可重试失败（uncertain/timeout/error，多为太频繁或风控），收进失败名单
  const retryList = []; // 本轮「点过没成」的人快照，跑完写回名单供「重试」

  for (let i = 0; i < targets.length; i++) {
    if (stopRequested) break; // 收到停止：不再处理下一个候选人

    const c = targets[i];
    const name = c.name || `候选人${i + 1}`;
    const geekId = c.geekId;
    const score = c.matchScore ?? 0;

    if (!geekId) {
      console.log(`GREET_STATUS:${name}|无geekId|skip|缺少 geekId`);
      skipCount++;
      continue;
    }

    console.log(`[${i + 1}/${targets.length}] ${name} （${score}分）…`);

    // 单个候选人超时保护（30s），防止单个人卡死整个流程；停止指令也参与竞争，
    // 这样单个候选人卡住时点停止也能立刻收手，不必干等 30 秒
    let result = 'timeout';
    try {
      const timer = new Promise(resolve =>
        setTimeout(() => resolve('timeout'), PER_CANDIDATE_TIMEOUT)
      );
      result = await Promise.race([
        greetCandidate(targetId, geekId, name, opts.source),
        timer,
        stopSignal.then(() => 'cancelled'),
      ]);
    } catch (err) {
      console.log(`[greet] ${name} 异常： ${err.message}`);
      result = 'error';
    }

    if (result === 'cancelled') break; // 用户点了停止，直接收手

    // 结果归类。success/already-greeted/not-found/skip 的状态行已在 greetCandidate 内打印，
    // 只有 timeout / error 是主循环产生的（超时兜底 / catch 异常），这里补打保证进度计数完整
    switch (result) {
      case 'success':
        successCount++;
        break;
      case 'already-greeted':
        alreadyCount++; // 已是「继续沟通/已联系」，绝不重复发
        break;
      case 'not-found':
        notFoundCount++; // 页面里找不到：重试也找不到，不进失败名单
        break;
      case 'uncertain':
      case 'timeout':
      case 'error':
        // 可重试失败：点过但没确认成功（多为太频繁/风控挡下）。收进失败名单，
        // 界面「重试」只补这批人；已打过/已成功的经上面前置判断不会进来，不会重复发
        if (result === 'timeout') console.log(`GREET_STATUS:${name}|${geekId}|timeout|操作超时（30s）`);
        else if (result === 'error') console.log(`GREET_STATUS:${name}|${geekId}|error|处理异常`);
        retryableCount++;
        retryList.push({ geekId, name, matchScore: score });
        break;
      default:
        skipCount++; // skip：页面无打招呼按钮可点，重试也无意义
    }

    // 间隔 2-5 秒防风控（v1.8.3：原 3-5 秒收紧到 2-5 秒，用户要稍快一些）；
    // 间隔期间收到停止指令也立即中断，不等满防风控时间
    if (i < targets.length - 1 && !stopRequested) {
      const delay = 2000 + Math.random() * 3000;
      await cancellableSleep(delay);
    }
  }

  // 5. 输出统计。用户主动停止时不发 GREET_DONE（主进程 cancelled 分支会静默收尾），
  // 只留一行日志，避免把「中途停止」当成完整跑完上报给界面；停止时也不写失败名单，
  // 这样上一批失败名单保持原样，之后仍可「重试」
  if (stopRequested) {
    console.log('\n已收到停止指令，停止后续打招呼');
    return;
  }

  // 跑完正常收尾：把本轮仍「点过没成」的人写回名单（供界面「重试」只补这批）；
  // 本轮全成功则名单为空 → 删除文件，按钮随之回到「开始打招呼」
  writeRetryFile(rPath, retryList);

  // GREET_DONE: success | already | notFound | skipped(不可重试) | retryable(可重试失败)
  console.log(`\nGREET_DONE:${successCount}|${alreadyCount}|${notFoundCount}|${skipCount}|${retryableCount}`);
}

main().catch(err => fatal(err.message));
