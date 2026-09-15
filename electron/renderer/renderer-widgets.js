// renderer-widgets.js —— 由原 renderer.js 第 89–331 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 自定义下拉组件 =====
// 原生 <select> 弹层在 Electron 里有时打不开（drag 区域/合成器问题），
// 批量打招呼/自动打招呼改为自定义组件。通过 .value getter/setter 保持与原 <select> 读写兼容。
function initCustomSelect(container) {
  if (!container) return;
  const trigger = container.querySelector('.custom-select-trigger');
  const menu = container.querySelector('.custom-select-menu');
  const label = trigger.querySelector('.custom-select-label');
  const options = Array.from(container.querySelectorAll('.custom-select-option'));

  function sync() {
    const v = String(container.dataset.value);
    const opt = container.querySelector(`.custom-select-option[data-value="${v}"]`);
    if (opt) {
      label.textContent = opt.textContent;
      options.forEach(o => {
        const sel = o.dataset.value === v;
        o.classList.toggle('selected', sel);
        o.setAttribute('aria-selected', String(sel));
      });
    }
  }

  // 暴露 .value，兼容现有 greetLevel.value / autoGreetLevel.value 的读写
  Object.defineProperty(container, 'value', {
    get() { return container.dataset.value; },
    set(v) { container.dataset.value = String(v); sync(); },
  });

  // 展开/收起：入场由 CSS 的 menu-in 承担；收起补 menu-out 镜像退场（同 150ms），
  // 播完（forwards 停在透明）再隐藏 display，避免“出现有动效、收起瞬没”。
  // openState 是语义开关：退场动画进行中已算“收起”，此刻点触发条可即时取消退场重开
  let openState = false;
  let closeTimer = null;

  function openMenu() {
    openState = true;
    clearTimeout(closeTimer);
    menu.classList.remove('custom-select-menu--closing');
    // 窗口底部空间不足时向上展开（原生 select 会自动翻转，自定义组件需手动处理）
    const rect = container.getBoundingClientRect();
    // 每项约 36px（字号 14 × 行高 1.4 + 上下内距 8；那一档行高由 base.css 的 button 重置兜底，
    // 见 §3），12 是菜单容器自己的内距与项间隙余量。改 .custom-select-option 的内距或那档行高，
    // 这里的估值要跟着改——它只用来判「上面放不放得下」，估小了会在贴底时把菜单顶出窗口
    const menuH = options.length * 36 + 12;
    const openUp = rect.bottom + menuH + 8 > window.innerHeight;
    if (openUp) {
      menu.style.top = 'auto';
      menu.style.bottom = 'calc(100% + 4px)';
    } else {
      menu.style.top = 'calc(100% + 4px)';
      menu.style.bottom = 'auto';
    }
    // 缩放轴心随展开方向（向下=顶边、向上=底边）：入/退场都从触发条那一侧起收
    menu.style.transformOrigin = openUp ? 'bottom' : 'top';
    // 打开即把箭头转 180°（∨ → ^）提示“已展开”，收起时复位；
    // 不再跟随菜单上下方向——用户要的是“点开就翻转”的常规手感
    container.querySelector('.custom-select-arrow').style.transform = 'rotate(180deg)';
    menu.style.display = 'flex';
    trigger.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (!openState) return; // 已收起（含退场中）
    openState = false;
    container.querySelector('.custom-select-arrow').style.transform = '';
    trigger.setAttribute('aria-expanded', 'false');
    // 系统开了「减少动态效果」：全局动画已被压成 0.01ms，直接隐藏，别干等退场时长
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      menu.style.display = 'none';
      return;
    }
    menu.classList.add('custom-select-menu--closing');
    clearTimeout(closeTimer);
    // 退场时长直接读 CSS（menu-out = --dur-fast 150ms），改档位只需改 CSS
    const outMs = exitMsOf(menu, 170);
    closeTimer = setTimeout(() => {
      menu.classList.remove('custom-select-menu--closing');
      menu.style.display = 'none';
    }, outMs);
  }

  function setOpen(open) {
    if (open) openMenu();
    else closeMenu();
  }

  function selectValue(v) {
    container.dataset.value = String(v);
    sync();
    setOpen(false);
    trigger.focus();
    // 派发 change 事件，兼容既有监听（updateGreetCount 等）
    container.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    // 点开本组时先收起其它已展开的下拉：走各自的退场动效，而不是瞬没
    document.querySelectorAll('.custom-select-menu').forEach(m => {
      if (m === menu) return;
      if (typeof m._closeCustomSelect === 'function') m._closeCustomSelect();
      else m.style.display = 'none'; // 兜底：个别未注册实例直接隐藏
    });
    setOpen(!openState);
  });

  // 触发按钮键盘：↓/↑/Home/End 打开并定位；Escape 收起
  trigger.addEventListener('keydown', (e) => {
    const isOpen = openState;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!isOpen) {
        setOpen(true);
        const idx = (e.key === 'ArrowUp' || e.key === 'End') ? options.length - 1 : 0;
        options[idx].focus();
      }
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      setOpen(false);
      trigger.focus();
    }
  });

  // 选项：点击选择；方向键移动；Enter/Space 选择；Escape 收起并回焦点
  options.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      selectValue(opt.dataset.value);
    });
    opt.addEventListener('keydown', (e) => {
      const idx = options.indexOf(opt);
      if (e.key === 'ArrowDown') { e.preventDefault(); options[Math.min(idx + 1, options.length - 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[Math.max(idx - 1, 0)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); options[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectValue(opt.dataset.value); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.focus(); }
    });
  });

  // 点击其它位置收起
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) setOpen(false);
  });

  // 暴露给其它下拉实例：跨关本菜单时走退场动效（见上方 trigger click 的互关逻辑）
  menu._closeCustomSelect = closeMenu;

  sync();
}
initCustomSelect(greetLevel);
initCustomSelect(autoGreetLevel);

// ===== 密码框的显示 / 隐藏（👁）=====
// 引用 index.html 顶部图标库里的 #icon-eye-on / #icon-eye-off，切换时大小位置不跳。
// 放在通用 widget 里（原先挂在 renderer-greet.js 的 init 内）是为了让「复位」能跨文件被调：
// 设置弹窗每次打开都把密码框复位成隐藏态（renderer-dialogs.js 的 openSettingsDialog），
// 上次点开看过的明文不该关了弹窗还留在屏幕上
const EYE_SVG = iconSvg('icon-eye-on', 16);
const EYE_OFF_SVG = iconSvg('icon-eye-off', 16);

// 单个密码框复位成隐藏（闭眼）。renderer-ipc.js 禁用一个密码框时也走它，
// 免得「灰框里晾着明文密码」
function setPasswordHidden(toggle) {
  const targetId = toggle.getAttribute('data-target');
  const input = targetId && document.getElementById(targetId);
  if (!input) return;
  input.type = 'password';
  toggle.innerHTML = EYE_OFF_SVG; // 隐藏 → 闭眼
  toggle.setAttribute('aria-pressed', 'false');
}

// 所有密码框一律复位（设置弹窗每次打开时调）
function resetPasswordToggles() {
  document.querySelectorAll('.input-toggle').forEach(setPasswordHidden);
}

document.addEventListener('click', (e) => {
  const toggle = e.target.closest('.input-toggle');
  if (!toggle) return;
  const targetId = toggle.getAttribute('data-target');
  const input = targetId && document.getElementById(targetId);
  if (!input) return;
  if (input.type === 'password') {
    input.type = 'text';
    toggle.innerHTML = EYE_SVG; // 明文 → 睁眼
    toggle.setAttribute('aria-pressed', 'true');
  } else {
    setPasswordHidden(toggle);
  }
});

// ===== 步骤元素 =====
const stepCards = {
  1: {
    card: document.getElementById('step-1'),
    bar: document.getElementById('step-1-bar'),
    pct: document.getElementById('step-1-pct'),
    msg: document.getElementById('step-1-msg'),
    status: document.getElementById('step-1-status'),
  },
  2: {
    card: document.getElementById('step-2'),
    bar: document.getElementById('step-2-bar'),
    pct: document.getElementById('step-2-pct'),
    msg: document.getElementById('step-2-msg'),
    status: document.getElementById('step-2-status'),
  },
  3: {
    card: document.getElementById('step-3'),
    bar: document.getElementById('step-3-bar'),
    pct: document.getElementById('step-3-pct'),
    msg: document.getElementById('step-3-msg'),
    status: document.getElementById('step-3-status'),
  },
};
// 各步骤当前状态（'idle' | 'running' | 'done'），用于判断「并行：步骤1 + 步骤2」指示文案
const stepStates = { 1: 'idle', 2: 'idle', 3: 'idle' };
// 步骤1 提取是否处于「暂停」状态（暂停/继续按钮的文案与步骤1 消息都看它）
let extractPaused = false;

// ===== Toast 通知 =====
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  // 每条 toast 自带 live region 角色（容器不再是 live region，见 index.html 该容器注释）：
  // 错误用 alert（插话式，立即播报），其余用 status（排队播报，不打断用户）
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  // 先插入空节点、下一帧再填字。读屏只在「已经存在于无障碍树里的 live region 内容发生变化」时
  // 播报；带着文字一次性插入的新节点（role=status 尤其）NVDA/JAWS 经常整条漏掉 ——
  // 这正是 WAI 推荐「先插入空 region、后一帧再塞文本」的原因。alert 两种写法都念，但统一走这条更稳
  container.appendChild(el);
  requestAnimationFrame(() => { el.textContent = message; });
  setTimeout(() => {
    el.classList.add('toast-leaving');
    // 移除时机与 toast-out(--dur-normal=250ms) 一致，硬编码需与它同步
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ===== 遮罩空白处关闭弹窗（设置 / 历史记录 / 目标岗位 / 添加编辑岗位 / 确认弹窗共用）=====
// 光判 click 的 e.target === overlay 是不够的：在弹窗里按下鼠标、拖到弹窗外再松开
// （最典型的是在很长的输入框里按住拖动看后面的内容），浏览器会把 click 派发到「按下点与
// 松开点的共同祖先」——正是遮罩本身，target 恰好等于 overlay，弹窗就被当「点了空白」关掉，
// 用户刚填的内容还没保存就没了。松手落到窗口外时同理（click 也可能整个不派发，或派发给遮罩）。
// 所以「点了空白」要按下、松开、click 三个点都落在遮罩上才算，任一环节在弹窗内就不关。
// 返回值是解绑函数，给按次挂载监听的弹窗（确认弹窗）在关闭时摘干净。
function bindBackdropDismiss(overlay, dismiss) {
  let downOnBackdrop = false;
  let upOnBackdrop = false;
  const onDown = (e) => {
    downOnBackdrop = e.target === overlay;
    upOnBackdrop = false; // 松手前先作废：万一本轮没有 pointerup 派发（松手落在窗口外），也不会沿用上一轮的旧值
  };
  const onUp = (e) => { upOnBackdrop = e.target === overlay; };
  const onClick = (e) => {
    const backdrop = downOnBackdrop && upOnBackdrop && e.target === overlay;
    downOnBackdrop = false;
    upOnBackdrop = false;
    if (backdrop) dismiss();
  };
  overlay.addEventListener('pointerdown', onDown);
  overlay.addEventListener('pointerup', onUp);
  overlay.addEventListener('click', onClick);
  return () => {
    overlay.removeEventListener('pointerdown', onDown);
    overlay.removeEventListener('pointerup', onUp);
    overlay.removeEventListener('click', onClick);
  };
}

// ===== 通用确认弹窗（替代原生 confirm/alert）=====
// 返回 Promise<boolean>。danger 时确定按钮变红色；showCancel:false 时只保留确定按钮。
// swapTo（可选，目前只有「请选择目标岗位」在用）：形如 { overlay, open }，
// 点「确定」后本弹窗不整屏淡出，而是与那个弹窗做交叉过渡（见 renderer-dialogs.js 的 swapDialogs）——
// 两个弹窗同屏对淡、遮罩一路撑住，中间不留「只剩空遮罩」的帧。
// 原来的写法是「确定 → 本弹窗啪地消失 → 目标弹窗的遮罩从透明淡入」，中间那一帧就是用户看到的「闪一下」。
function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false, showCancel = true, swapTo = null }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    if (!overlay || !titleEl || !messageEl || !okBtn || !cancelBtn) { resolve(false); return; }

    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okText;
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? '' : 'none';

    // 危险操作弹窗（删除/清空）：红色按钮放左侧、取消放右侧；
    // 普通弹窗保持 取消左·确定右。按 danger 实时调整 DOM 顺序，弹窗关闭后下次打开仍按需归位。
    const actionsEl = okBtn.parentElement;
    if (actionsEl && showCancel) {
      const wantOkFirst = danger; // danger 时确定（红）按钮应排在取消前面，视觉上就在左边
      const isOkFirst = actionsEl.firstElementChild === okBtn;
      if (wantOkFirst !== isOkFirst) {
        actionsEl.insertBefore(wantOkFirst ? okBtn : cancelBtn, wantOkFirst ? cancelBtn : okBtn);
      }
    }

    // 记录弹窗前的焦点，关闭后还原
    const prevFocus = document.activeElement;
    // 本弹窗不走 openDialog，开/关只借 showOverlay/hideOverlay 这一对——
    // inert 与 --closing 由它们负责（互切退场留下的 inert 就是我方的坑，见 renderer-dialogs.js）
    showOverlay(overlay);
    okBtn.focus();

    const done = (val) => {
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      unbindBackdrop();
      document.removeEventListener('keydown', onKey);
      // 点「确定」且调用方指定了 swapTo：本弹窗不在这里消失，交给 swapDialogs 交叉过渡，
      // 由它的收尾帧负责隐藏本弹窗 —— 中途不摘遮罩，是为了让遮罩一路撑住明暗
      if (val === true && swapTo) {
        swapDialogs(overlay, swapTo.overlay, swapTo.open);
        resolve(true);
        return;
      }
      hideOverlay(overlay);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onKey = (e) => {
      if (e.key === 'Escape') { done(false); return; }
      if (e.key === 'Enter' && e.target === okBtn) { done(true); return; }
      // 焦点陷阱：Tab 循环在弹窗内
      if (e.key === 'Tab') {
        const focusables = [okBtn, ...(showCancel ? [cancelBtn] : [])].filter((b) => b.style.display !== 'none');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    const unbindBackdrop = bindBackdropDismiss(overlay, () => done(false));
    document.addEventListener('keydown', onKey);
  });
}

// ===== 按钮加载态（spinner + aria-busy + 禁用）=====
// 加载中把按钮挂成真正的 disabled（置灰、鼠标键盘都点不动），结束后恢复成加载前的状态——
// 这样能跟其它「按条件禁用」的逻辑叠加：加载完不会把一个本就该禁用的按钮错误放开。
// 按钮文字保持不变，转圈由 config.css 的 .is-loading::before 提供，勿在加载时改文案
function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  if (loading) {
    btn.setAttribute('aria-busy', 'true');
    btn.dataset.prevDisabled = String(btn.disabled); // 记住进入加载前是否已禁用，结束时还原
    btn.disabled = true;
  } else {
    btn.removeAttribute('aria-busy');
    if (btn.dataset.prevDisabled !== undefined) {
      btn.disabled = btn.dataset.prevDisabled === 'true';
      delete btn.dataset.prevDisabled;
    }
  }
}

// ===== 浮层退场时长 =====
// 读元素当前 CSS 动画时长，换算成「等它播完再收尾」的毫秒数（+30ms 兜住尾帧）。
// 弹窗淡出、下拉收起、菜单收起共用同一套「出快于入」的时序，档位只在 CSS 里定义一次：
// 改 CSS 档位后这里自动跟着变，不必回来同步任何数字。fallback 是读不到时长时的兜底。
function exitMsOf(el, fallback) {
  if (!el) return fallback;
  const durStr = (getComputedStyle(el).animationDuration || '').trim();
  const n = parseFloat(durStr);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return (durStr.endsWith('ms') ? n : n * 1000) + 30;
}

// ===== 滚动条：鼠标进框才出现 =====
// 颜色/粗细那些在 base.css（:hover::-webkit-scrollbar-thumb 几条），这里只管「让它重画一次」：
// 容器 :hover 变化时 Chromium 不会去重画**它自己那条**滚动条——滚动条绘在独立图层里，悬停失效
// 传不过去。样式算出来是对的（matches(':hover') 为真），屏幕上却还是旧的，条就时有时无
// （用户报的「一会儿出现一会儿消失」）。表单控件的滚动条画在元素自己的绘制里，没这毛病——
// 岗位描述 textarea 天然就对，别在它身上白费劲。
// 办法：进/出框时把 overflow 关掉再装回，滚动条被拆掉重建，遂按当前样式重画。
// 放 rAF 里是因为鼠标刚离开的那一刻 :hover 还没更新完，同步重画会又画成悬停态（条不消失）。
document.querySelectorAll('.job-picker-list, .results-list, .settings-body').forEach((box) => {
  let queued = false;
  const repaint = () => {
    queued = false;
    box.style.overflowY = 'hidden';
    void box.offsetHeight; // 逼一次同步布局，滚动条才真的被拆掉
    box.style.overflowY = ''; // 这三个盒子都没有内联 overflow，还原成 CSS 里的 auto
    void box.offsetHeight;
  };
  const queue = () => {
    if (queued) return; // 同一帧里进了又出，重画一次就够——重画时读的是当时的状态
    queued = true;
    requestAnimationFrame(repaint);
  };
  box.addEventListener('pointerenter', queue);
  box.addEventListener('pointerleave', queue);
});

// ===== 清理函数 =====
let cleanupFns = [];

function registerCleanup(fn) {
  cleanupFns.push(fn);
}

function cleanupAll() {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
}

