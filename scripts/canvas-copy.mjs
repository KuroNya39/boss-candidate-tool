// scripts/canvas-copy.mjs — 模拟复制提取简历正文（真实 Ctrl+C / 拖拽选中）
// Boss 的 canvas 简历 DOM 零文字，copy 处理器只认真人按键与系统剪贴板：
// 这里模拟「鼠标选中 → 真实 Ctrl+C」与整页拖拽，再从系统剪贴板读走全文。
// 失败一律返回 null，由调用方降级走截图 OCR——本模块不负责兜底。
import { execSync } from 'node:child_process';
import { proxyPost, cdpEval, ensureTabActive, sleep } from './cdp-base.mjs';

/**
 * 真实复制提取简历正文（v1.3.39）。
 * 背景：用户手动 Ctrl+C 能复制到完整简历原文（含教育、工作、项目、技能），
 * 证明页面有 copy 处理器会在复制时生成简历全文。此前用「合成 ClipboardEvent」触发不到
 * （copy=0），最可能是处理器校验了 event.isTrusted —— 合成事件不被信任，真实按键才被信任。
 * 方案：在简历文档（含外层页面）装 bubble 监听器，跑在页面处理器之后；再用 CDP
 * Input.dispatchKeyEvent 发送真实 Ctrl+A + Ctrl+C（浏览器视为真人操作），页面处理器生成全文写入
 * clipboardData，监听器读进 window.__resumeCopy，全程不碰系统剪贴板。
 * v1.3.40 实测：点击能把焦点带进跨域简历 iframe、copy 事件能触发，但文字为 0 ——
 * 点击把全选清掉了，处理器因无选中内容放弃生成。v1.3.41 改为「点击 → 重新全选 → Ctrl+A+C」。
 * @param {string} targetId 页面 target id
 * @param {{id:number}} ctx  简历 iframe 的 isolated world 执行上下文
 * @param {string} label 日志前缀（区分页面）
 * @returns {Promise<string|null>}
 */
// 页面 script/style 噪音特征：检测到即视为非简历文本（v1.3.36 防把 JS 代码误当简历文字）
export const COPY_JUNK_RE = 'APM\\.init|import\\.meta\\.url|System\\.import|__vite_is_modern_browser|vite-legacy|createElement\\(\\s*["\']script';
// 预编译一次，别在每次校验简历文本时重建正则（复制/重试路径每个候选人要校验多次）
const COPY_JUNK_RX = new RegExp(COPY_JUNK_RE, 'i');

// 模拟复制总开关（v1.4.4 新增）：界面「开启模拟复制」选项。
// 开启=DOM提取→模拟复制→截图OCR；关闭=DOM提取→截图OCR（不碰系统剪贴板）。
// 默认开启（向后兼容）；三个提取脚本 main() 都调用 parseArgs()，由 --enable-copy 参数统一设置。
let enableCopyFlag = true;
export function setEnableCopyFlag(v) {
  enableCopyFlag = !!v;
}

export function getEnableCopyFlag() { return enableCopyFlag; }

// ---- 系统剪贴板：一律「现起一个短命 PowerShell」 ----
// 别再改回常驻助手。2026-09-23 实测踩过：把读写剪贴板换成常驻的 STA 控制台进程后，复制成功率
// 从 ~99.9%（当天前 8 小时 900+ 次成功、失败个位数）掉到 1/6，日志报「Get-Clipboard : 所请求的
// 剪贴板操作失败」——剪贴板被别的进程握着，Boss 页面自己也就写不进去，于是每次都读到空。
// 机制：OLE 剪贴板调用会回调属主线程，而常驻助手正卡在 ReadLine 上、不泵消息，一旦吊死就一直
// 握着剪贴板不放；短命进程卡住会自己退出、锁随之释放，所以老写法能自愈。
// 代价：每次操作都要等 PowerShell 冷启动（本机约 0.3s，慢机器 1.5~2.5s），一次拖拽复制要 4 次。
// 宁可慢，也不能把复制功能弄坏。

// —— 读写剪贴板（每次现起一个短命 PowerShell；同步调用，没有 async 版本）——
// 本文件每次 execSync 调 powershell 都必须显式写 stdio:'pipe'：Windows 上不写它，子进程的 stderr
// 会直接被转写进本进程 stderr、被 app 收进日志面板（中文以 GBK 出来，看着就是一段乱码）；写了才被吞掉

// 读系统剪贴板。返回 { text, err }：
//   text 字符串 → 读到了（空串 = 剪贴板本来就是空的）
//   text null   → 根本没读到（命令超时 / 剪贴板被别的进程占着），err 是原因
// 这两种必须分开：空串是「页面没写」，null 是「整个剪贴板被锁住」——2026-09-23 那次复制全失败就是
// 后者（Get-Clipboard 报「所请求的剪贴板操作失败」），日志里只留一句「剪贴板是空的」会把人引偏。
// 所以这条命令不写 -ErrorAction SilentlyContinue：剪贴板打不开时要让它报错，才分得出来
function readClipboard() {
  try {
    const ps = [
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
      '$t = Get-Clipboard -Raw',
      'if($t){ [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$t)) }',
    ].join('; ');
    const out = execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: 'pipe' });
    const b64 = (out || '').trim();
    if (!b64) return { text: '', err: '' };
    return { text: Buffer.from(b64, 'base64').toString('utf8'), err: '' };
  } catch (e) {
    console.warn(`  ⚠ 读取系统剪贴板失败： ${e.message}`);
    return { text: null, err: briefErr(e.message) };
  }
}

// execSync 报错是多行（命令 + PowerShell 的报错），只留最后一行有用的
function briefErr(m) {
  const ls = String(m || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return ls.length ? ls[ls.length - 1].slice(0, 60) : '未知错误';
}

// 写系统剪贴板；text 为空 = 清空剪贴板（拖拽复制前清场也走这里，不再单写一条清空命令）。
// 内容用 base64 走 stdin（input）传，不拼进命令行：
// 拼命令行有两个坑——① 内容一长（用户复制过长文档）就超 Windows 命令行长度上限，spawn 直接
// ENAMETOOLONG，还原悄悄失败；② 还得处理引号转义。走 stdin 这些都不存在，命令串是固定常量。
// 空内容也不能直接交给 `Set-Clipboard -Value`：空串会被当成 null 抛 ArgumentNullException
// （「值不能为 null」），而「原本的剪贴板就是空的」是最常见的一种情况——不判空就每位候选人报一次错
const PS_CLIPBOARD_CLEAR = 'Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()';
function setOsClipboard(text) {
  try {
    const b64 = Buffer.from(text, 'utf8').toString('base64');
    const ps = [
      '$b64 = [Console]::In.ReadToEnd()',
      '$t = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b64))',
      `if ($t) { Set-Clipboard -Value $t } else { ${PS_CLIPBOARD_CLEAR} }`,
    ].join('; ');
    execSync(`powershell -NoProfile -Command "${ps}"`, { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: 'pipe', input: b64 });
  } catch (e) {
    console.warn(`  ⚠ 写系统剪贴板失败： ${e.message}`);
  }
}

// 保存原剪贴板，结束后恢复（尽量不打扰用户正在复制的文字）。
// 保存的内容由调用方持有（saveOsClipboard 返回它、restoreOsClipboard 收回去），
// 不放模块级变量：这样谁存的谁还，即使将来两条复制路径嵌套也不会把别人的内容还错。
// 返回 null = 没读到（恢复时跳过：把「没读到」当空串写回去，等于顺手清空用户的剪贴板）
function saveOsClipboard() {
  return readClipboard().text;
}
function restoreOsClipboard(saved) {
  if (saved === null || saved === undefined) return;
  setOsClipboard(saved);
}

// 读并清空两处 copy 捕获（iframe 内 + 外层页面），返回 { text, evCtx, evOuter }
async function readCopyHooks(targetId, ctx) {
  let text = '', evCtx = '', evOuter = '';
  try {
    const r = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var t = window.__resumeCopy || '';
      var inf = (window.__resumeCopyInfo || []).join(',');
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      return JSON.stringify({ t: t, inf: inf });
    })()`);
    if (r && r.value) {
      const o = JSON.parse(r.value);
      text = o.t; evCtx = o.inf;
    }
  } catch {}
  try {
    const r2 = await cdpEval(targetId, `(function(){
      var t = window.__resumeCopyOuter || '';
      var inf = (window.__resumeCopyOuterInfo || []).join(',');
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      return JSON.stringify({ t: t, inf: inf });
    })()`);
    if (r2) {
      const o = JSON.parse(r2);
      if (o.t && o.t.length > text.length) text = o.t;
      evOuter = o.inf || '';
    }
  } catch {}
  return { text, evCtx, evOuter };
}

export async function tryExtractResumeTextByTrustedCopy(targetId, ctx, label = 'DOM') {
  if (!ctx || !ctx.id) return null;
  if (!enableCopyFlag) { console.log(`  ${label}🔍 模拟复制已关闭（界面设置），跳过复制直接截图`); return null; } // v1.4.4
  await ensureTabActive(targetId); // v1.8.3：真实 Ctrl+C 前把被切走的标签页拉回前台（后台复制 60s 超时/只复制几十字）

  // v1.3.42: Boss 新版简历用 wasm-resume-container 渲染成 canvas（<div id=resume><canvas id=resume></canvas></div>），
  // DOM 零文字，且复制处理器不会为自动化复制生成文本（实测 iframe事件[BODY:0]、剪贴板不变）。
  // 只要是 WASM canvas 简历就立即放弃复制、直接交给截图 OCR，省 ~10s/人；旧版 canvas / HTML 简历仍走复制尝试。
  try {
    const wasm = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var b = document.body;
      if (b && /wasm-resume-container|zhipin-boss\\/wasm|wasm-resume/i.test(b.innerHTML || '')) return true;
      var c = document.getElementById('resume');
      if (c && c.tagName === 'CANVAS') return true;
      if (document.querySelector('#resume canvas')) return true;
      return false;
    })()`);
    if (wasm && wasm.value === true) {
      // v1.3.43: WASM canvas 简历复制走系统剪贴板，改为模拟「手动拖拽滚动选中 + Ctrl+C」再从系统剪贴板读取
      const copied = await tryExtractCanvasResumeByDragCopy(targetId, label);
      if (copied) return copied;
      console.log(`  ${label}🔍 复制提取（真实）： 简历为 WASM canvas 渲染（拖拽复制也未命中），放弃复制直接截图`);
      return null;
    }
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取（真实）： WASM 探测失败 ${e.message}`);
  }

  // 0) 结构诊断：iframe 里到底有没有可选文字 / 隐藏文字层 / 纯 canvas。
  //    决定「复制处理器是因为选中为空放弃」还是「处理器在别处」。
  try {
    const diag = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      var out = {};
      try {
        var body = document.body;
        out.bodyText = (body && body.textContent || '').replace(/\\s+/g,' ').trim().length;
        var resume = document.getElementById('resume');
        out.resumeText = resume ? (resume.textContent||'').replace(/\\s+/g,' ').trim().length : -1;
        out.resumeHtml = resume ? resume.innerHTML.length : -1;
        var cvs = document.querySelector('canvas');
        out.canvas = cvs ? cvs.width+'x'+cvs.height : 'none';
        var layers = [];
        var els = document.querySelectorAll('*');
        for (var i=0;i<els.length && layers.length<6;i++){
          var el = els[i];
          if (el.children.length) continue;
          var t = (el.textContent||'').trim();
          if (t.length > 8 && /[一-龥A-Za-z]/.test(t)) {
            var st = getComputedStyle(el);
            layers.push({tag:el.tagName, cls:String(el.className||'').slice(0,30), len:t.length, disp:st.display, pos:st.position});
          }
        }
        out.layers = layers;
        try {
          var sel = window.getSelection();
          var r = document.createRange();
          if (resume && (resume.textContent||'').trim().length > 0) { r.selectNodeContents(resume); sel.removeAllRanges(); sel.addRange(r); out.selResume = sel.toString().length; }
          sel.removeAllRanges();
          if (body) { r.selectNodeContents(body); sel.addRange(r); out.selBody = sel.toString().length; }
        } catch(e) { out.selErr = e.message; }
      } catch(e) { out.err = e.message; }
      return JSON.stringify(out);
    })()`);
    if (diag && diag.value) console.log(`  ${label}🔍 复制提取结构诊断（iframe）： ${diag.value}`);
  } catch {}
  // 外层弹窗结构：简历正文会不会就藏在弹窗容器里
  try {
    const od = await cdpEval(targetId, `(function(){
      var d = document.querySelector('.dialog-wrap.active');
      if (!d) return 'no-dialog';
      var t = (d.textContent||'').replace(/\\s+/g,' ').trim();
      return JSON.stringify({ len: t.length, hasResumeMark: /工作经历|教育经历|项目经验|期望职位|技能|自我评价/.test(t), preview: t.slice(0,80) });
    })()`);
    if (od) console.log(`  ${label}🔍 复制提取结构诊断（外层）： ${od}`);
  } catch {}

  // 1) 装监听（iframe 内 + 外层页面），记录每次 copy 事件的目标与文字长度
  try {
    await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      if (window.__resumeCopyHook) document.removeEventListener('copy', window.__resumeCopyHook, false);
      window.__resumeCopyHook = function(e){
        try {
          var tag = (e.target && e.target.tagName) || '?';
          var t = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
          window.__resumeCopyInfo.push(tag + ':' + (t ? t.length : 0));
          if (t.length > window.__resumeCopy.length) window.__resumeCopy = t;
        } catch (err) {}
      };
      document.addEventListener('copy', window.__resumeCopyHook, false);
      return true;
    })()`);
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取（真实）： 装监听失败 ${e.message}`);
    return null;
  }
  try {
    await cdpEval(targetId, `(function(){
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      if (window.__resumeCopyOuterHook) document.removeEventListener('copy', window.__resumeCopyOuterHook, false);
      window.__resumeCopyOuterHook = function(e){
        try {
          var t = e.clipboardData ? (e.clipboardData.getData('text/plain') || '') : '';
          window.__resumeCopyOuterInfo.push(((e.target && e.target.tagName) || '?') + ':' + (t ? t.length : 0));
          if (t.length > window.__resumeCopyOuter.length) window.__resumeCopyOuter = t;
        } catch (err) {}
      };
      document.addEventListener('copy', window.__resumeCopyOuterHook, false);
      return true;
    })()`);
  } catch {}

  const savedClipboard = saveOsClipboard();
  setOsClipboard('__BCT_COPY_SENTINEL__');

  const picks = []; // 各尝试的捕获结果

  // ===== 尝试 A：点 iframe → iframe 内智能全选 → Ctrl+A+C（v1.3.41 方案，改选 #resume） =====
  let resA = { tag: 'A：点iframe+选resume+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    const clickSel = '.boss-popup__content .resume-detail-wrap iframe, .dialog-wrap.active .resume-detail-wrap iframe, .boss-popup__content .resume-detail-wrap, .dialog-wrap.active .resume-detail-wrap';
    await proxyPost(`/clickAt?target=${targetId}`, clickSel);
    await sleep(200);
    const f = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? document.activeElement.tagName : 'none');
    })()`);
    resA.focus = (f && f.value) ? f.value : '';
    const s = await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      try {
        window.focus();
        var sel = window.getSelection();
        var resume = document.getElementById('resume');
        var body = document.body;
        sel.removeAllRanges();
        var r = document.createRange();
        if (resume && (resume.textContent||'').trim().length > 0) r.selectNodeContents(resume);
        else if (body) r.selectNodeContents(body);
        sel.addRange(r);
        return sel.toString().length;
      } catch(e) { return -1; }
    })()`);
    resA.sel = (s && typeof s.value === 'number') ? s.value : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取A： ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resA.evCtx = r.evCtx; resA.evOuter = r.evOuter; resA.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取A： 按键失败 ${e.message}`);
  }
  picks.push(resA);

  // ===== 尝试 B：真实点击外层弹窗空白区（焦点留在外层页面），全选外层 → Ctrl+A+C =====
  // 假设：copy 处理器注册在外层弹窗文档。手动复制时焦点在外层页面；
  // 事件不跨文档冒泡，之前一直把焦点给 iframe，外层处理器从未被触发。
  let resB = { tag: 'B：点外层+全选+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    // 在外层页面弹窗左上角放一个临时透明元素，真实点击它把焦点交给外层页面（避免点到 iframe/按钮）
    await cdpEval(targetId, `(function(){
      var d = document.querySelector('.dialog-wrap.active');
      if (!d) return 'no-dialog';
      var r = d.getBoundingClientRect();
      var old = document.getElementById('__bct_outer_click__');
      if (old) old.remove();
      var btn = document.createElement('div');
      btn.id = '__bct_outer_click__';
      btn.style.cssText = 'position:fixed;left:' + (r.left + 12) + 'px;top:' + (r.top + 12) + 'px;width:24px;height:24px;z-index:999999;';
      document.body.appendChild(btn);
      return 'ok';
    })()`);
    await proxyPost(`/clickAt?target=${targetId}`, '#__bct_outer_click__');
    await sleep(200);
    await cdpEval(targetId, `(function(){ var e = document.getElementById('__bct_outer_click__'); if (e) e.remove(); return true; })()`);
    const b = await cdpEval(targetId, `(function(){
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? (document.activeElement.tagName + '.' + String(document.activeElement.className||'').slice(0,20)) : 'none');
    })()`);
    resB.focus = b || '';
    const s = await cdpEval(targetId, `(function(){
      var sel = window.getSelection();
      if (sel && document.body) { sel.removeAllRanges(); sel.selectAllChildren(document.body); return sel.toString().length; }
      return -1;
    })()`);
    resB.sel = typeof s === 'number' ? s : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取B： ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resB.evCtx = r.evCtx; resB.evOuter = r.evOuter; resB.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取B： 按键失败 ${e.message}`);
  }
  picks.push(resB);

  // ===== 尝试 C：仅 window.focus() 外层 + 全选外层 → Ctrl+A+C（对照：不点也看外层处理器是否触发） =====
  let resC = { tag: 'C：外层focus+全选+CtrlAC', focus: '', sel: -1, evCtx: '', evOuter: '', text: '' };
  try {
    const b = await cdpEval(targetId, `(function(){
      window.focus();
      try { document.body.setAttribute('tabindex','-1'); document.body.focus(); } catch(e) {}
      return (document.hasFocus ? document.hasFocus() : '?') + '|' + (document.activeElement ? (document.activeElement.tagName + '.' + String(document.activeElement.className||'').slice(0,20)) : 'none');
    })()`);
    resC.focus = b || '';
    const s = await cdpEval(targetId, `(function(){
      var sel = window.getSelection();
      if (sel && document.body) { sel.removeAllRanges(); sel.selectAllChildren(document.body); return sel.toString().length; }
      return -1;
    })()`);
    resC.sel = typeof s === 'number' ? s : -1;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取C： ${e.message}`);
  }
  try {
    await proxyPost(`/keyseq?target=${targetId}`, JSON.stringify({ keys: 'ctrl+a+c' }));
    await sleep(600);
    const r = await readCopyHooks(targetId, ctx);
    resC.evCtx = r.evCtx; resC.evOuter = r.evOuter; resC.text = r.text;
  } catch (e) {
    console.warn(`  ${label}🔍 复制提取C： 按键失败 ${e.message}`);
  }
  picks.push(resC);

  // 2) 系统剪贴板兜底：哨兵还在 = 都没写入；变了 = 某次尝试真的生成了全文
  const osClip = readClipboard().text;
  const osHit = !!osClip && osClip !== '__BCT_COPY_SENTINEL__';
  restoreOsClipboard(savedClipboard);
  await cleanupTrustedCopy(targetId, ctx);

  for (const p of picks) {
    console.log(`  ${label}🔍 复制提取（真实）诊断 ${p.tag}： 焦点=${p.focus} 选中=${p.sel} iframe事件[${p.evCtx || ''}] 外层事件[${p.evOuter || ''}] 捕获=${p.text ? p.text.length : 0}字 剪贴板=${osHit ? osClip.length : '未变'}`);
  }

  // 3) 取最长有效文本（页面监听优先，剪贴板兜底）
  let best = null;
  for (const p of picks) {
    const t = (p.text || '').replace(/\s+/g, ' ').trim();
    if (t.length >= DOM_MIN_TEXT_LEN && !COPY_JUNK_RX.test(t)) {
      if (!best || t.length > best.length) best = t;
    }
  }
  if (osHit && (!best || osClip.length > best.length)) {
    const t = osClip.replace(/\s+/g, ' ').trim();
    if (t.length >= DOM_MIN_TEXT_LEN && !COPY_JUNK_RX.test(t)) best = t;
  }
  if (best) {
    console.log(`  ✓ 真实复制提取简历文本（${label}, ${best.length} 字）`);
    return best;
  }
  return null;
}

// ---- v1.3.43: WASM canvas 简历「拖拽滚动复制」----
// Boss 新版简历是 canvas 绘制（DOM 零文字），复制走 navigator.clipboard.writeText（直接写系统剪贴板），
// 页面内截获 copy 事件永远读到 0 字（历史 iframe事件[BODY:0]）。等价用户手动操作的正确做法：
//   清空系统剪贴板 → 真实鼠标按住拖选 → 滚动简历容器到最底（选中扩展） → 真实 Ctrl+C → powershell 读剪贴板全文。
export async function tryExtractCanvasResumeByDragCopy(targetId, label = 'DOM') {
  if (!enableCopyFlag) { console.log(`  ${label}🔍 模拟复制已关闭（界面设置），跳过复制直接截图`); return null; }

  // v1.8.3：真实鼠标拖选+Ctrl+C 需要页面在前台（后台页会被冻结/降速，复制要么干等不返回、要么只复制出几十个字）。
  // 复制开始时若已被切走就先拉回前台；若真拉回过，稍等渲染器解除冻结再发指令。
  if (await ensureTabActive(targetId)) await sleep(500);

  // 这条路径会先清空系统剪贴板、再写入简历全文，而它自己从不还原 —— 改前的结果是
  // 用户的剪贴板被永久顶掉（README 里「占用几秒」的说法对不上）。现在起止都包住：
  // 成功、拿不到文本、超时、抛异常，一律把原内容还回去。
  const savedClipboard = saveOsClipboard();
  try {
    return await runCanvasDragCopy(targetId, label);
  } finally {
    restoreOsClipboard(savedClipboard);
  }
}

// 上一条的实体：单次复制尝试与那次重试的全部逻辑，语句原样保留（只搬出外层，
// 好让剪贴板的 save/restore 用 try/finally 收口 —— 函数里 return 分支多，逐个手动还原迟早漏一个）
// 把 /canvas-copy 带回来的「页面复制链路探针」压成一行日志：Ctrl+C 之后剪贴板却为空时，
// 一眼看出是页面没写（写API=0/copy事件=0）还是写了但被浏览器拒了（写API=1(NotAllowedError)）。
// 焦点字段同因：async Clipboard API 要求文档有焦点，被切走时写会直接抛错。
function fmtCopyDiag(d) {
  if (!d) return '页面无探针';
  const one = (x) => {
    if (!x) return '';
    const name = x.name || '?';
    if (x.hookErr) return `${name}{挂钩失败:${x.hookErr}}`;
    const parts = [`焦点=${x.focus ? '有' : '无'}`, `写API=${x.wt}`];
    if (x.wtLen >= 0) parts.push(`成功${x.wtLen}字`);
    if (x.wtErr) parts.push(`抛错:${x.wtErr}`);
    parts.push(`copy事件=${x.cev}`);
    if (x.cevLen >= 0) parts.push(`选中${x.cevLen}字`);
    if (x.ec) parts.push(`execCommand=${x.ec}`);
    return `${name}{${parts.join(' ')}}`;
  };
  const out = [one(d.top), ...(d.frames || []).map(one)].filter(Boolean);
  if (d.frameErr) out.push(`iframe探针异常:${d.frameErr}`);
  if (d.readErr) out.push(d.readErr);
  if (d.focusNow === false) out.push('结束时页面已失焦');
  return out.join(' ') || '页面无记录';
}

async function runCanvasDragCopy(targetId, label) {
  // 单次 /canvas-copy 限时：正常复制端点最坏 ~15s（重载 iframe + 滚动 + Ctrl+C）。
  // 复制进行中若标签页被切走，页面冻结会让端点的 CDP 操作卡住。处理方式不是「干等满额超时、
  // 放弃后再重开一个」——那样两个拖拽复制会在同一页上打架；而是设一个「唤醒点」：
  // 请求跑了 KICK_AFTER_MS 还没回来，就查一次可见性，真被切走就用浏览器级的 Target.activateTarget
  // 把 Boss 页切回前台（浏览器级指令，页面冻结也能生效），让同一个请求把复制跑完。
  // 实测被切走的场景 6~8 秒内自愈，不再干等 30s/60s。
  const COPY_ATTEMPT_TIMEOUT = 20000; // 单次请求安全上限
  const KICK_AFTER_MS = 6000;         // 超过此时长没返回 → 查一次是否被切走，是就切回
  const CLIPBOARD_WRITE_WAIT_MS = 2000; // Ctrl+C 之后等页面把全文写进剪贴板的上限（见下）

  const goodText = (text) => text.length >= DOM_MIN_TEXT_LEN && !COPY_JUNK_RX.test(text);

  // 单次复制尝试：清剪贴板 → 端点拖拽滚动 Ctrl+C → 读系统剪贴板。
  // 返回 { text } 成功；{ timeout } 客户端等满超时；{ errCode, elapsed } 服务器明确报错；
  // { empty } 服务器说成功但剪贴板为空/文本不可用。外层据此决定要不要重试。
  const attempt = async () => {
    setOsClipboard('');
    // 清空是同步语义（命令返回即已生效），不需要长等；120ms 只是让剪贴板服务的写入落到系统里
    // （原 250ms 是纯保险，占的也是用户剪贴板被清空的时间）
    await sleep(120);

    // —— 自愈唤醒点：请求没按时回来，多半是标签页被切走了，把 Boss 页切回前台让它自己跑完 ——
    // 直接用 ensureTabActive（本文件抽的「可见则不动、被切走才激活」守卫），不再手写一遍
    const kickTimer = setTimeout(async () => {
      if (await ensureTabActive(targetId)) console.log(`  ${label}🔍 canvas复制： 复制进行中标签页被切换，已自动切回 Boss 页继续…`);
    }, KICK_AFTER_MS);

    let r = null;
    let timedOut = false;
    try {
      r = await proxyPost(`/canvas-copy?target=${targetId}`, '{}', COPY_ATTEMPT_TIMEOUT);
    } catch {
      timedOut = true;
    }
    clearTimeout(kickTimer); // 请求已返回，唤醒点作废

    if (timedOut) return { timeout: true };
    if (!r || r.error || !r.ok) {
      const errMsg = (r && (r.error || 'unknown')) || '无响应';
      const elapsedTxt = r && r.elapsed ? ` (${(r.elapsed / 1000).toFixed(1)}s)` : '';
      console.log(`  ${label}🔍 canvas复制： 拖拽复制失败 ${errMsg}${elapsedTxt}`);
      return { errCode: r && r.error, elapsed: r && r.elapsed };
    }
    // 端点返回 = Ctrl+C 已发完，但「页面把全文写进系统剪贴板」是异步的：Boss 的复制处理器收到
    // Ctrl+C 后还要跑自己的流程，简历 canvas 重时能拖到几百毫秒。剪贴板已在前一步清空，所以读到空
    // 只说明「还没写完」，不等于失败 —— 短轮询等它出现（最多 CLIPBOARD_WRITE_WAIT_MS）。
    // 注意每读一次都要现起一个 PowerShell（本机约 0.3s，慢机器 1.5~2.5s），这个预算实际只够读一两次，
    // 这是「别再改回常驻助手」换来的代价（见本文件剪贴板那段注释）：宁可慢，也不能把复制弄坏
    const waitUntil = Date.now() + CLIPBOARD_WRITE_WAIT_MS;
    let text = '', readErr = '';
    for (;;) {
      await sleep(60);
      const clip = readClipboard();
      readErr = clip.err;
      text = (clip.text || '').replace(/^﻿/, '').replace(/\r\n/g, '\n').trim();
      if (text.length > 0 || Date.now() >= waitUntil) break;
    }
    if (goodText(text)) {
      const diag = r.diag ? `，容器SH/CH=${r.diag.outerSH}/${r.diag.outerCH}, iframe内=${r.diag.innerSH}/${r.diag.innerVH}` : '';
      const el = r.elapsed ? `，用时 ${(r.elapsed / 1000).toFixed(1)}s` : '';
      console.log(`  ✓ 复制提取（canvas拖拽滚动）： ${text.length} 字（滚动 ${r.scrollMax}px，容器 ${r.scrollSel || '?'}${diag}${el}）`);
      return { text };
    }
    if (text.length > 0) console.log(`  ${label}🔍 canvas复制： 剪贴板 ${text.length} 字不可用`);
    else {
      // 剪贴板为空 = 页面压根没写；读的时候报错 = 剪贴板被别的进程锁着（页面同样写不进去）。
      // 再叠上页面探针，失败原因就写清楚了
      const locked = readErr ? `，读剪贴板报错「${readErr}」` : '';
      console.log(`  ${label}🔍 canvas复制： 剪贴板是空的（滚动 ${r.scrollMax}px${locked}，${fmtCopyDiag(r.copyDiag)}）`);
    }
    return { empty: true };
  };

  // 第 1 次尝试：途中被切走会自动切回，通常这一步就够了
  const a1 = await attempt();
  if (a1 && a1.text) return a1.text;

  // 客户端等满超时（页面卡住）或服务器撞上复制硬上限：重试大概率复现，且客户端超时后再开一次
  // 会和服务器可能还在跑的拖拽在同一页面打架——直接放弃复制走截图，别叠第二份复制的时钟。
  if (a1 && (a1.timeout || a1.errCode === 'copy-timeout')) {
    console.log(`  ${label}🔍 canvas复制： ${a1.timeout ? '等满超时（页面卡住）' : `复制超时（${(a1.elapsed / 1000).toFixed(1)}s）`}，不再重试，放弃复制直接走截图`);
    return null;
  }

  // 其余失败（剪贴板为空/文本不可用/个别服务器瞬时错误）：多半是渲染没缓过来，切回前台再试一次
  console.log(`  ${label}🔍 canvas复制： 第 1 次未成功，切回 Boss 标签页重试…`);
  await ensureTabActive(targetId);
  await sleep(400); // 只走失败重试路径：给渲染器/iframe 一点缓过来的时间，原 800ms 属过保险
  const a2 = await attempt();
  if (a2 && a2.text) return a2.text;

  console.log(`  ${label}🔍 canvas复制： 重试后仍拿不到有效文本，放弃走截图`);
  return null;
}

async function cleanupTrustedCopy(targetId, ctx) {
  try {
    await proxyPost(`/eval-context?target=${targetId}&context=${ctx.id}`, `(function(){
      if (window.__resumeCopyHook) { document.removeEventListener('copy', window.__resumeCopyHook, false); window.__resumeCopyHook = null; }
      window.__resumeCopy = '';
      window.__resumeCopyInfo = [];
      return true;
    })()`);
  } catch {}
  try {
    await cdpEval(targetId, `(function(){
      if (window.__resumeCopyOuterHook) { document.removeEventListener('copy', window.__resumeCopyOuterHook, false); window.__resumeCopyOuterHook = null; }
      window.__resumeCopyOuter = '';
      window.__resumeCopyOuterInfo = [];
      return true;
    })()`);
  } catch {}
}

/**
 * 尝试直接从 DOM 提取简历文本，跳过截图+OCR 流程
 * v1.3.15: 文本过短（<DOM_MIN_TEXT_LEN）视为抓到弹窗壳而非简历正文，返回 null 降级走截图 OCR
 * v1.3.30: Chrome 151+ 移除了 Runtime.getExecutionContexts，/frames 的 executionContexts 为空，
 *          改用 Page.createIsolatedWorld 拿 iframe 执行上下文；内容可能加载慢，轮询等待正文出现。
 */
// DOM 提取文本最短阈值：低于此值视为抓到弹窗壳（头部固定文案等）而非简历正文
export const DOM_MIN_TEXT_LEN = 200;