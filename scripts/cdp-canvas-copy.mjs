// scripts/cdp-canvas-copy.mjs — /canvas-copy 端点：WASM canvas 简历的「拖拽选中 + 真实 Ctrl+C」复制
//
// Boss 新版简历由 canvas 绘制（DOM 零文字），复制走 navigator.clipboard.writeText（系统剪贴板），
// 页面内截获 copy 事件永远拿不到文本。正确做法：真实鼠标按住拖选 + 滚动简历容器 + 真实 Ctrl+C，
// 文本进入系统剪贴板，由调用方用系统命令（powershell Get-Clipboard）读取。
// 端点封装完整流程：计算 canvas 主视口坐标 → mousedown 顶部 → 拖到屏底 → 滚动容器到底 → mouseup → Ctrl+C。
// 从 cdp-proxy.mjs 拆出来（那是一张平铺路由表，这个端点独占近 400 行）。
// 依赖由调用方注入（sendCDP / ensureSession / sleep），本模块不自己连 Chrome。

/**
 * 处理 POST /canvas-copy?target=xxx
 * @param {{q: Record<string,string>, res: import('node:http').ServerResponse,
 *          ensureSession: (targetId: string) => Promise<string>,
 *          sendCDP: (method: string, params?: object, sessionId?: string|null) => Promise<any>,
 *          sleep: (ms: number) => Promise<void>}} deps
 */
export async function handleCanvasCopy({ q, res, ensureSession, sendCDP, sleep }) {
  const sid = await ensureSession(q.target);
  // v1.8.4: 单次拖拽复制硬上限。超过说明这份简历渲染太重或页面卡住——若继续硬跑，客户端会在
  // 自己的 20s 超时处放弃请求，而服务器的拖拽还停在这个页面上，下一位/OCR 的鼠标指令就会和它
  // 在同一页面打架（重叠拖拽，两份复制互相污染）。到点干净收尾返回错误，由客户端直接走截图。
  const copyStart = Date.now();
  const COPY_DEADLINE_MS = 15000;
  const copyOverdue = () => Date.now() - copyStart > COPY_DEADLINE_MS;
  let dragX = null, dragY = null; // 拖拽进行中的鼠标坐标，超时收尾时先松开按钮
  const bailCopy = async (why) => {
    if (dragX !== null && dragY !== null) {
      try {
        await sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dragX, y: dragY, button: 'left', clickCount: 1, buttons: 0 }, sid);
      } catch {}
    }
    res.end(JSON.stringify({ error: why, elapsed: Date.now() - copyStart }));
  };
  // 0) 轻量归零：canvas translateY 由 Boss 内部状态驱动，直接改滚动容器 scrollTop 同步不稳定
  //    （连续调用时 DOM scrollTop 归零但 canvas 停在底部 → 卡死态，滚轮也救不回）。普通情况（新弹窗）这样够用。
  //    滚动容器各页面不同：推荐/搜索页=.resume-detail-wrap，沟通页=.resume-detail；
  //    优先用 info 阶段缓存的 window.__resumeScrollEl，拿不到再按容器名找。
  const resetJs = `(function(){
    function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
    var rf = firstByName(document,'recommendFrame');
    var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
    var wrap = window.__resumeScrollEl || rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
    var out = '';
    if (wrap) { wrap.style.scrollBehavior = 'auto'; wrap.scrollTop = 0; out += 'outer:ok;'; }
    var f = window.__resumeIframe;
    if (f) {
      try {
        var idoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (idoc && idoc.documentElement) { idoc.documentElement.scrollTop = 0; out += 'inner:ok;'; }
      } catch(e) {}
    }
    return out || 'no-wrap';
  })()`;
  // 卡死恢复：重载 c-resume iframe → Boss 简历渲染器全新启动，canvas 必然回顶（translateY=0）
  const reloadJs = `(function(){
    function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
    var rf = firstByName(document,'recommendFrame');
    var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
    var wrap = rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
    var iframe = wrap ? wrap.querySelector('iframe') : null;
    if (!iframe) return 'no-iframe';
    iframe.src = iframe.src; return 'reloading';
  })()`;
  await sendCDP('Runtime.evaluate', { expression: resetJs, returnByValue: true }, sid);
  // 1) 主页面穿透（通用，推荐页/搜索页/沟通页都支持）：
  //    找简历弹窗容器（.resume-detail-wrap 或 .resume-detail）→ 其内简历 iframe → canvas；
  //    用 frameOffset 逐层累加 iframe 偏移到主视口坐标。
  //    滚动容器各页面不同（推荐/搜索页=.resume-detail-wrap，沟通页=.resume-detail），
  //    从简历 iframe 向上探测「真正可滚动」的祖先作为滚动容器，缓存到 window.__resumeScrollEl 供滚动阶段复用。
  const infoJs = `(function(){
    function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
    function frameOffset(el){
      var ox=0, oy=0, curWin = el.ownerDocument ? el.ownerDocument.defaultView : null;
      var guard = 0;
      while (curWin && curWin !== window && guard++ < 10) {
        var fe = curWin.frameElement;
        if (!fe) break;
        var r = fe.getBoundingClientRect();
        ox += r.x; oy += r.y;
        curWin = curWin.parent;
      }
      return { x: ox, y: oy };
    }
    function isScr(el){
      if (!el || el.nodeType !== 1) return null;
      if (el.scrollHeight <= el.clientHeight + 1) return null;
      var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
      var oy = cs ? (cs.overflowY || '') : '';
      // 需同时接受 hidden：Boss 弹窗滚动容器常为 overflow:hidden（隐藏滚动条，但 scrollTop 仍可滚）。
      // 只认 auto/scroll/overlay 会把沟通页的 .resume-detail 排除 → scrollMax=0 → 复制不全。
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay' || oy === 'hidden') return el;
      return null;
    }
    function findScrollEl(iframe, doc){
      var p = iframe.parentElement;
      while (p && p !== doc.documentElement && p !== doc.body) {
        var sc = isScr(p);
        if (sc) return sc;
        p = p.parentElement;
      }
      var w = isScr(doc.querySelector('.resume-detail-wrap'));
      if (w) return w;
      var d = isScr(doc.querySelector('.resume-detail'));
      if (d) return d;
      return iframe.parentElement;
    }
    var scopes = [];
    var rf = firstByName(document,'recommendFrame');
    if (rf && rf.contentDocument) scopes.push(rf.contentDocument);
    scopes.push(document);
    // 命中测试：从顶层文档按坐标逐层钻进 iframe，返回最上层命中的那个元素
    function topHit(x, y){
      var w = window, dx = x, dy = y, el = null, guard = 0;
      while (guard++ < 10) {
        try { el = w.document.elementFromPoint(dx, dy); } catch(e) { return null; }
        if (!el) return null;
        if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
          var nd = null;
          try { nd = el.contentDocument; } catch(e) { nd = null; }
          if (!nd) return el;
          var r = el.getBoundingClientRect();
          dx -= r.x; dy -= r.y;
          w = el.contentWindow;
          continue;
        }
        return el;
      }
      return el;
    }
    // 命中元素是否属于这份弹窗（跨 iframe 逐层向上找祖先）
    function belongsTo(el, wrap, idoc){
      var n = el, guard = 0;
      while (n && guard++ < 40) {
        if (n === wrap) return true;
        if (n.ownerDocument === idoc) return true;
        var d = n.ownerDocument;
        var fe = (d && d.defaultView) ? d.defaultView.frameElement : null;
        if (!fe) return false;
        n = fe;
      }
      return false;
    }
    // 同一文档里可能同时挂着多份简历弹窗（残留的那份 + 当前这份，位置尺寸几乎一样），
    // querySelector 只拿第一个：沟通页会挑中看不见的那份 → 拖动落在别的简历上，
    // 页面看着不滚动、起点也错位。这里靠命中测试（浏览器自己判断谁在最上层）挑，
    // 拿不到的再退回按可见面积挑，保证不会挑不出东西。
    var bestOnTop = null, bestAny = null, cands = [];
    for (var s=0; s<scopes.length; s++) {
      var doc = scopes[s];
      var wraps = doc.querySelectorAll('.resume-detail-wrap, .resume-detail');
      for (var wi=0; wi<wraps.length; wi++) {
        var wrap = wraps[wi];
        var iframe = wrap.querySelector('iframe');
        if (!iframe) continue;
        var idoc = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
        if (!idoc) continue;
        var cv = idoc.querySelector('#resume canvas') || idoc.querySelector('#resume') || idoc.querySelector('canvas');
        if (!cv) continue;
        var cv2 = cv.tagName === 'CANVAS' ? cv : (cv.querySelector ? cv.querySelector('canvas') : null);
        if (!cv2 || cv2.width < 50 || cv2.height < 50) continue;
        var cr = cv2.getBoundingClientRect();
        // 渲染尺寸下限：太小的（含 display:none 残留弹窗 —— canvas 位图仍有尺寸但 rect 全 0）不算数
        if (cr.width < 100 || cr.height < 100) continue;
        var vo = frameOffset(cv2);
        var visX = Math.max(0, Math.min(vo.x + cr.width, window.innerWidth) - Math.max(vo.x, 0));
        var visY = Math.max(0, Math.min(vo.y + cr.height, window.innerHeight) - Math.max(vo.y, 0));
        var score = visX * visY;
        if (score <= 0) continue;
        // canvas 上取 3 个采样点：有一个点命中的是这份弹窗自己，说明它摆在最上层
        var onTop = false;
        var pts = [[vo.x + cr.width/2, vo.y + cr.height/2], [vo.x + cr.width*0.25, vo.y + cr.height*0.5], [vo.x + cr.width*0.75, vo.y + cr.height*0.5]];
        for (var pi=0; pi<pts.length && !onTop; pi++) {
          var h = topHit(pts[pi][0], pts[pi][1]);
          if (h && belongsTo(h, wrap, idoc)) onTop = true;
        }
        cands.push({ cls: String(wrap.className || '').slice(0,70), scope: s, y: Math.round(vo.y), h: Math.round(cr.height), sh: wrap.scrollHeight, ch: wrap.clientHeight, vis: Math.round(score), onTop: onTop });
        var cand = { score: score, doc: doc, iframe: iframe, idoc: idoc, cv2: cv2, cr: cr, scope: s };
        if (!bestAny || score > bestAny.score) bestAny = cand;
        if (onTop && (!bestOnTop || score > bestOnTop.score)) bestOnTop = cand;
      }
    }
    var best = bestOnTop || bestAny;
    if (best) {
      var doc = best.doc, iframe = best.iframe, idoc = best.idoc, cv2 = best.cv2, cr = best.cr, s = best.scope;
      // 拖动起点沿用 v1.11.1 的坐标基准（frameOffset(iframe) + canvas 在简历文档内的 rect），只对胜出者算一次
      var off = frameOffset(iframe);
      var sc = findScrollEl(iframe, doc);
      var outerMax = Math.max(0, sc.scrollHeight - sc.clientHeight);
      // iframe 内部滚动兜底：若外层容器不可滚（沟通页个别情况），简历可能改在 c-resume iframe 内部滚动
      var idocSH = 0, idocVH = 0, innerMax = 0;
      try {
        idocSH = (idoc.documentElement ? idoc.documentElement.scrollHeight : 0) || (idoc.body ? idoc.body.scrollHeight : 0);
        idocVH = (iframe.contentWindow && iframe.contentWindow.innerHeight) || (idoc.documentElement ? (idoc.documentElement.clientHeight || 0) : 0);
        if (idocSH > idocVH) innerMax = idocSH - idocVH;
      } catch(e) {}
      window.__resumeScrollEl = sc;
      window.__resumeIframe = iframe;
      window.__resumeOuterMax = outerMax;
      window.__resumeInnerMax = innerMax;
      var canvasMain = { x: Math.round(off.x + cr.x), y: Math.round(off.y + cr.y), w: Math.round(cr.width), h: Math.round(cr.height) };
      var scrollMax = Math.max(outerMax, innerMax);
      var scrollSel = (sc.className || sc.id || sc.tagName || '?');
      var diag = { outer: scrollSel, outerSH: sc.scrollHeight, outerCH: sc.clientHeight, innerSH: idocSH, innerVH: idocVH };
      return JSON.stringify({ canvasMain: canvasMain, scrollMax: scrollMax, scope: s, winH: window.innerHeight, scrollSel: scrollSel, diag: diag, cands: cands });
    }
    return JSON.stringify({ error: 'no-canvas-scope' });
  })()`;
  // 1.5) 轮询等待 canvas 回顶。先短轮询 ≤2s（新弹窗通常立即在顶）；若一直没回顶（卡死态）→ 重载 iframe 重建
  //      渲染状态（确定性回顶），再轮询 ≤8s。仍不归顶则报错走截图。
  const pollInfo = async (rounds, gapMs) => {
    let last = { info: null, canvasY: null };
    for (let i = 0; i < rounds; i++) {
      const pollResp = await sendCDP('Runtime.evaluate', { expression: infoJs, returnByValue: true }, sid);
      try { last.info = JSON.parse(pollResp.result?.result?.value); } catch { last.info = null; }
      if (last.info && last.info.canvasMain) {
        last.canvasY = last.info.canvasMain.y;
        if (last.canvasY < 120) break;
      }
      await sleep(gapMs);
    }
    return last;
  };
  // 候选弹窗实况（多份弹窗时用来确认挑中的是哪一份）
  const logCands = (i) => {
    if (!i) return;
    if (i.error) console.log(`[canvas-copy] 选弹窗失败： ${i.error}`);
    else if (i.cands) console.log(`[canvas-copy] 候选弹窗： ${JSON.stringify(i.cands)}`);
  };
  let { info, canvasY } = await pollInfo(4, 500);
  logCands(info);
  if (info && !info.error && canvasY !== null && canvasY >= 120) {
    console.log(`[canvas-copy] canvas 未回顶（y=${canvasY}），重载 c-resume iframe 重建渲染状态`);
    await sendCDP('Runtime.evaluate', { expression: reloadJs, returnByValue: true }, sid);
    await sleep(500);
    await sendCDP('Runtime.evaluate', { expression: resetJs, returnByValue: true }, sid);
    ({ info, canvasY } = await pollInfo(16, 500));
    logCands(info);
  }
  if (!info || info.error || canvasY === null || canvasY >= 120) {
    res.end(JSON.stringify({ error: `canvas 未归顶或找不到（y=${canvasY}）` }));
    return;
  }
  if (copyOverdue()) { await bailCopy('copy-timeout'); return; }
  const { canvasMain, scrollMax, scope } = info;
  if (!canvasMain || canvasMain.h < 100) { res.end(JSON.stringify({ error: 'canvas 不在简历弹窗内' })); return; }

  // 1.5) 复制链路探针：在「页面写剪贴板」这件事上挂钩子，Ctrl+C 之后读回来。
  //      拖拽复制失败时日志只有「剪贴板是空的」，看不出是页面压根没写、还是写了但被浏览器拒了
  //      （async Clipboard API 要求文档处于焦点，被切走时会抛 NotAllowedError）——这两种原因
  //      的修法完全不同，先让页面自己说出来。只读不改行为：原函数照常调用。
  const copyDiagJs = `(function(){
    function hook(w, name){
      if (!w || !w.document) return;
      try {
        // 顶层页面整轮不重载：挂过就只重置计数，别再叠一层监听器与包装链
        // （否则监听器数随候选人数线性涨，500 人一轮就是 500 层）
        var d = w.__copyDiag;
        if (d) {
          d.name = name; d.focus = w.document.hasFocus(); d.vis = w.document.visibilityState;
          d.wt = 0; d.wtLen = -1; d.wtErr = ''; d.cev = 0; d.cevLen = -1; d.ec = 0;
          return;
        }
        d = { name: name, focus: w.document.hasFocus(), vis: w.document.visibilityState, wt: 0, wtLen: -1, wtErr: '', cev: 0, cevLen: -1, ec: 0 };
        w.__copyDiag = d;
        var cb = w.navigator && w.navigator.clipboard;
        if (cb && cb.writeText) {
          var orig = cb.writeText.bind(cb);
          cb.writeText = function(t){ d.wt++; return orig(t).then(function(){ d.wtLen = (t||'').length; }).catch(function(e){ d.wtErr = String(e && e.name ? e.name : e).slice(0, 60); }); };
        }
        w.document.addEventListener('copy', function(ev){ d.cev++; try { d.cevLen = ev.clipboardData ? String(ev.clipboardData.getData('text/plain')||'').length : -1; } catch(e){} }, true);
        var oec = w.document.execCommand;
        w.document.execCommand = function(c){ if (c === 'copy') d.ec++; return oec.apply(this, arguments); };
      } catch(e) { try { w.__copyDiag = { name: name, hookErr: String(e).slice(0, 60) }; } catch(_){} }
    }
    hook(window, '外层');
    // 简历挂在哪个 iframe 里各页不同（推荐页 recommendFrame、搜索页 searchFrame），同源的都挂上；
    // 跨域的简历 iframe（c-resume OOPIF）拿不到 contentWindow，读不到就跳过
    try {
      var fs = document.querySelectorAll('iframe');
      for (var i=0;i<fs.length;i++) {
        var f = fs[i], n = f.name || f.id || ('iframe' + i), cw = null;
        try { cw = f.contentWindow; } catch(e) { cw = null; }
        if (cw) hook(cw, n);
      }
    } catch(e) {}
    return 'hooked';
  })()`;
  try { await sendCDP('Runtime.evaluate', { expression: copyDiagJs, returnByValue: true }, sid); } catch {}
  const readCopyDiag = async () => {
    const readJs = `(function(){
      var out = { top: window.__copyDiag || null, frames: [] };
      try {
        var fs = document.querySelectorAll('iframe');
        for (var i=0;i<fs.length;i++) {
          var cw = null;
          try { cw = fs[i].contentWindow; } catch(e) { cw = null; }
          var d = cw && cw.__copyDiag;
          if (d) out.frames.push(d);
        }
      } catch(e) { out.frameErr = String(e).slice(0, 60); }
      out.focusNow = document.hasFocus();
      return JSON.stringify(out);
    })()`;
    try {
      const r = await sendCDP('Runtime.evaluate', { expression: readJs, returnByValue: true }, sid);
      const v = r && r.result && r.result.value;
      if (!v) return { readErr: '页面未返回探针结果' };
      return JSON.parse(v);
    } catch (e) { return { readErr: `读探针失败:${String(e.message || e).slice(0, 50)}` }; }
  };

  // 2) 拖拽选中：从简历顶部文字区按住，拖到当前屏底部（不超出视口）
  const X0 = canvasMain.x + Math.round(canvasMain.w * 0.4);
  // 起点压到画布最上沿内侧：以前是 +60（想跳过头部留白抓首行），结果把姓名行和活跃度
  // （「刚刚活跃」）那一条留在了选区上方、复制不到。从最上面按住，选区自然从首行开始，
  // 姓名与活跃度一并进来（v1.15.0）
  const Y0 = canvasMain.y + 8;
  let Y1 = canvasMain.y + canvasMain.h - 30;          // 当前屏底部
  if (info.winH) Y1 = Math.min(Y1, info.winH - 40);   // 视口钳制
  if (Y1 <= Y0 + 40) Y1 = Y0 + 40;
  dragX = X0 + 30; dragY = Y1; // 记录按住位置，供超时收尾时松开
  await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0, y: Y0 }, sid);
  await sleep(100);
  await sendCDP('Input.dispatchMouseEvent', { type: 'mousePressed', x: X0, y: Y0, button: 'left', clickCount: 1, buttons: 1 }, sid);
  await sleep(80);
  const dragSteps = 12;
  for (let i = 1; i <= dragSteps; i++) {
    await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0, y: Y0 + Math.round((Y1 - Y0) * i / dragSteps), button: 'left', buttons: 1 }, sid);
    await sleep(20);
  }
  await sleep(100);

  // 3) 按住滚动容器到底（Boss 选中基于文档坐标，滚动后选区持续扩展）
  //    window.__resumeScrollEl 由 info 阶段缓存（各页面滚动容器不同，统一用它）
  const stepH = Math.max(300, Math.round(canvasMain.h * 0.9));
  let scrolled = 0;
  while (scrolled < scrollMax) {
    if (copyOverdue()) { await bailCopy('copy-timeout'); return; }
    scrolled = Math.min(scrolled + stepH, scrollMax);
    const scrollJs = `(function(){
      var sc = window.__resumeScrollEl;
      if (!sc) {
        function firstByName(doc,name){ var fs=doc.querySelectorAll('iframe'); for(var i=0;i<fs.length;i++){if(fs[i].name===name)return fs[i];} return null; }
        var rf = firstByName(document,'recommendFrame');
        var rd = (rf && rf.contentDocument) ? rf.contentDocument : document;
        sc = rd.querySelector('.resume-detail-wrap') || rd.querySelector('.resume-detail');
      }
      var t = ${scrolled}, out = '';
      if (sc) {
        var om = window.__resumeOuterMax || 0;
        if (om > 0) { sc.scrollTop = Math.min(t, om); out += 'o'; }
      }
      var f = window.__resumeIframe;
      var im = window.__resumeInnerMax || 0;
      if (f && im > 0) {
        try {
          var idoc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
          if (idoc && idoc.documentElement) { idoc.documentElement.scrollTop = Math.min(t, im); out += 'i'; }
        } catch(e) {}
      }
      return out || 'no';
    })()`;
    await sendCDP('Runtime.evaluate', { expression: scrollJs, returnByValue: true }, sid);
    await sleep(200);   // 等 Boss 平滑滚动 + 重绘（v1.4.5: 350→200，选区基于文档坐标，同步扩展）
    await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0 + 30, y: Y1, button: 'left', buttons: 1 }, sid);
    await sleep(70);
  }

  // 3.5) 选区延伸到内容最底部：滚到底后最后一行（页脚「…任何第三方平台…存储」）贴近画布底边，
  //      之前 Y1 留了 30px 余量，会把末字漏选，这里把选区终点压到画布底（视口内钳制）。
  let YB = Y1;
  const yBottom = Math.min(canvasMain.y + canvasMain.h - 2, (info.winH || 900) - 2);
  if (yBottom > Y1 + 10) {
    YB = yBottom;
    const extSteps = 8;
    for (let i = 1; i <= extSteps; i++) {
      await sendCDP('Input.dispatchMouseEvent', { type: 'mouseMoved', x: X0 + 30, y: Y1 + Math.round((YB - Y1) * i / extSteps), button: 'left', buttons: 1 }, sid);
      await sleep(20);
    }
    await sleep(150);
  }

  // 4) 松开 + 真实 Ctrl+C → 全文进入系统剪贴板
  if (copyOverdue()) { await bailCopy('copy-timeout'); return; }
  await sendCDP('Input.dispatchMouseEvent', { type: 'mouseReleased', x: X0 + 30, y: YB, button: 'left', clickCount: 1, buttons: 0 }, sid);
  await sleep(300);
  const CTRL = 2;
  await sendCDP('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 }, sid);
  await sendCDP('Input.dispatchKeyEvent', { type: 'keyDown', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL }, sid);
  await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'c', code: 'KeyC', windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67, modifiers: CTRL }, sid);
  await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, modifiers: 0 }, sid);
  // 等浏览器把 Ctrl+C 处理完再响应。这里只给一个起步的 200ms —— 页面把全文写进系统剪贴板
  // 是异步的、快慢不定，收尾由客户端轮询剪贴板（CLIPBOARD_WRITE_WAIT_MS）负责
  await sleep(200);
  const copyDiag = await readCopyDiag();
  res.end(JSON.stringify({ ok: true, canvasMain, scrollMax, scrolled, scope, winH: info.winH, yBottom: (info.winH || 900) - 2, scrollSel: info.scrollSel, diag: info.diag, copyDiag, elapsed: Date.now() - copyStart }));
}
