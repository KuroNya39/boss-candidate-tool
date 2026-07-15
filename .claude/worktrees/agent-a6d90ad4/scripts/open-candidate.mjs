#!/usr/bin/env node
/**
 * open-candidate.mjs - 在 Boss 直聘聊天页中打开候选人详情
 *
 * 通过 CDP Proxy 操作浏览器，按姓名搜索候选人并点击显示详情
 *
 * Usage:
 *   node scripts/open-candidate.mjs --name 贺涛
 */

import http from 'node:http';

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
  if (!opts.name) {
    console.error('Usage: node scripts/open-candidate.mjs --name <候选人姓名>');
    process.exit(1);
  }
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

// ===== 页面操作 =====

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

// 读取当前可见的 .geek-item 元素的 geekId 和姓名
async function readVisibleGeekItems(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var items = document.querySelectorAll('.geek-item');
    var result = [];
    for (var i = 0; i < items.length; i++) {
      var el = items[i];
      var id = el.id || el.getAttribute('data-id') || '';
      var geekId = id.split('-')[0] || '';
      var nameEl = el.querySelector('.name') || el.querySelector('.geek-name');
      var name = nameEl ? nameEl.textContent.trim() : '';
      result.push({ geekId: geekId, listName: name });
    }
    return JSON.stringify(result);
  })()`);
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// 滚动候选人列表容器向下
async function scrollListDown(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (!list) return JSON.stringify({ok: false, reason: 'no-list'});
    var before = list.scrollTop;
    list.scrollTop += Math.floor(list.clientHeight * 0.8);
    var after = list.scrollTop;
    return JSON.stringify({ok: true, scrollTop: after, scrollHeight: list.scrollHeight, scrolled: after > before});
  })()`);
  return JSON.parse(raw);
}

// 滚动候选人列表容器向上
async function scrollListUp(targetId) {
  const raw = await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (!list) return JSON.stringify({ok: false, reason: 'no-list'});
    var before = list.scrollTop;
    list.scrollTop -= Math.floor(list.clientHeight * 0.8);
    var after = list.scrollTop;
    return JSON.stringify({ok: true, scrollTop: after, scrolled: after < before});
  })()`);
  return JSON.parse(raw);
}

// 重置列表滚动到顶部
async function scrollListToTop(targetId) {
  await cdpEval(targetId, `(function(){
    var list = document.querySelector('.chat-record') || document.querySelector('.user-list') || document.querySelector('.geek-list');
    if (list) list.scrollTop = 0;
  })()`);
  await randomDelay(800, 1200);
}

// 通过 geekId 精准定位并点击候选人卡片
async function clickCandidateByGeekId(targetId, geekId) {
  const clickExpr = `(function(){
    var el = document.querySelector('[id^="${geekId}-"]');
    if (el) { el.click(); return 'ok-by-id'; }
    el = document.querySelector('[data-id^="${geekId}-"]');
    if (el) { el.click(); return 'ok-by-data-id'; }
    return 'not-found';
  })()`;

  let result;
  try {
    result = await cdpEval(targetId, clickExpr);
  } catch {
    result = 'error';
  }

  if (result !== 'not-found' && result !== 'error') {
    await randomDelay(1500, 2500);
    return result;
  }

  // geekId 不在 DOM 中，通过滚动搜索
  await scrollListToTop(targetId);
  for (let attempt = 0; attempt < 20; attempt++) {
    const scroll = await scrollListDown(targetId);
    await randomDelay(500, 800);
    try {
      result = await cdpEval(targetId, clickExpr);
    } catch {
      result = 'error';
    }
    if (result !== 'not-found' && result !== 'error') {
      await randomDelay(1500, 2500);
      return result;
    }
    if (!scroll.ok || !scroll.scrolled) break;
  }

  // 向下未找到，尝试向上滚动
  for (let attempt = 0; attempt < 10; attempt++) {
    const scroll = await scrollListUp(targetId);
    await randomDelay(500, 800);
    try {
      result = await cdpEval(targetId, clickExpr);
    } catch {
      result = 'error';
    }
    if (result !== 'not-found' && result !== 'error') {
      await randomDelay(1500, 2500);
      return result;
    }
    if (!scroll.ok || !scroll.scrolled) break;
  }

  throw new Error(`无法定位候选人 geekId=${geekId}`);
}

// ===== 按姓名搜索候选人 =====
async function findCandidateByName(targetId, name) {
  const seenGeekIds = new Set();
  await scrollListToTop(targetId);

  let prevScrollTop = -1;
  for (let attempt = 0; attempt < 100; attempt++) {
    const visibleItems = await readVisibleGeekItems(targetId);

    for (const item of visibleItems) {
      if (!item.geekId || seenGeekIds.has(item.geekId)) continue;
      seenGeekIds.add(item.geekId);

      // 模糊匹配：姓名包含搜索词或搜索词包含姓名
      if (item.listName && (item.listName.includes(name) || name.includes(item.listName))) {
        return item;
      }
    }

    const scroll = await scrollListDown(targetId);
    if (!scroll.ok || !scroll.scrolled) break;
    if (scroll.scrollTop === prevScrollTop) break;
    prevScrollTop = scroll.scrollTop;
    await randomDelay(600, 1000);
  }

  return null;
}

// ===== 查找或创建 Boss 聊天页 tab =====
async function findOrCreateChatTab() {
  try {
    const targets = await proxyGet('/targets');
    // targets 是数组，每个元素有 url 和 targetId
    if (Array.isArray(targets)) {
      const chatTab = targets.find(t =>
        t.url && (t.url.includes('zhipin.com/web/chat') || t.url.includes('zhipin.com/web/geek/chat'))
      );
      if (chatTab && chatTab.targetId) {
        console.log(`复用已有聊天页 tab: ${chatTab.targetId}`);
        return chatTab.targetId;
      }
    }
  } catch (e) {
    console.warn(`查询已有 tab 失败: ${e.message}`);
  }

  // 新建 tab
  console.log('打开 Boss 直聘沟通页...');
  const newTab = await proxyGet('/new?url=https://www.zhipin.com/web/chat');
  console.log(`Tab 已创建: ${newTab.targetId}`);
  return newTab.targetId;
}

// ===== 主流程 =====
async function main() {
  const opts = parseArgs();
  const name = opts.name;

  console.log(`搜索候选人: ${name}\n`);

  // 1. 查找或创建聊天页 tab
  const targetId = await findOrCreateChatTab();

  // 2. 等待列表加载
  console.log('等待页面加载...');
  const listCount = await waitForCandidateList(targetId, 15000);
  console.log(`页面已加载，候选人列表: ${listCount} 项\n`);

  // 3. 按姓名搜索
  console.log(`搜索姓名: ${name}...`);
  const found = await findCandidateByName(targetId, name);

  if (!found) {
    console.error(`未找到姓名包含"${name}"的候选人`);
    process.exit(1);
  }

  console.log(`找到候选人: ${found.listName} (geekId=${found.geekId})`);

  // 4. 点击候选人卡片
  console.log('点击候选人卡片...');
  await clickCandidateByGeekId(targetId, found.geekId);

  // 5. 等待详情面板显示
  console.log('等待详情面板显示...');
  const maxWait = 8000;
  const start = Date.now();
  let detailShown = false;
  while (Date.now() - start < maxWait) {
    try {
      const state = await cdpEval(targetId, `(function(){
        var detail = document.querySelector('.base-info-single-container');
        if (detail) {
          var rect = detail.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return 'detail-shown';
        }
        var resume = document.querySelector('.resume-detail');
        if (resume) {
          var rect = resume.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return 'resume-shown';
        }
        return 'waiting';
      })()`);
      if (state === 'detail-shown' || state === 'resume-shown') {
        detailShown = true;
        break;
      }
    } catch {}
    await sleep(500);
  }

  if (detailShown) {
    console.log(`\n已打开 ${found.listName} 的详情页`);
  } else {
    console.log(`\n已点击 ${found.listName}，但详情面板未及时显示（可能需要手动查看）`);
  }
}

main().catch(e => {
  console.error(`错误: ${e.message}`);
  process.exit(1);
});
