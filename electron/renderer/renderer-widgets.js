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

  function setOpen(open) {
    const isOpen = menu.style.display !== 'none';
    if (open === isOpen) return;
    const arrow = container.querySelector('.custom-select-arrow');
    if (open) {
      // 窗口底部空间不足时向上展开（原生 select 会自动翻转，自定义组件需手动处理）
      const rect = container.getBoundingClientRect();
      const menuH = options.length * 36 + 12;
      const openUp = rect.bottom + menuH + 8 > window.innerHeight;
      if (openUp) {
        menu.style.top = 'auto';
        menu.style.bottom = 'calc(100% + 4px)';
      } else {
        menu.style.top = 'calc(100% + 4px)';
        menu.style.bottom = 'auto';
      }
      // 箭头随展开方向翻转：朝上展开时转 180° 成 ^
      arrow.style.transform = openUp ? 'rotate(180deg)' : '';
    } else {
      arrow.style.transform = '';
    }
    menu.style.display = open ? 'flex' : 'none';
    trigger.setAttribute('aria-expanded', String(open));
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
    document.querySelectorAll('.custom-select-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
    setOpen(menu.style.display === 'none');
  });

  // 触发按钮键盘：↓/↑/Home/End 打开并定位；Escape 收起
  trigger.addEventListener('keydown', (e) => {
    const isOpen = menu.style.display !== 'none';
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

  sync();
}
initCustomSelect(greetLevel);
initCustomSelect(autoGreetLevel);

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
  if (type === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-leaving');
    // 移除时机与 toast-out(--dur-normal=250ms) 一致，硬编码需与它同步
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ===== 通用确认弹窗（替代原生 confirm/alert）=====
// 返回 Promise<boolean>。danger 时确定按钮变红色；showCancel:false 时只保留确定按钮。
function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false, showCancel = true }) {
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
    overlay.style.display = 'flex';
    okBtn.focus();

    const done = (val) => {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
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
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ===== 按钮加载态（spinner + aria-busy + 禁用）=====
function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  if (loading) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
}

// ===== 清理函数 =====
let cleanupFns = [];

function registerCleanup(fn) {
  cleanupFns.push(fn);
}

function cleanupAll() {
  cleanupFns.forEach((fn) => fn());
  cleanupFns = [];
}

