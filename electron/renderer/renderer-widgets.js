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

// ===== 右键菜单（输入框 + 正文）=====
// 此前输入框只能用快捷键复制粘贴。做成页面内浮层而不是系统原生菜单（Menu.popup）：原生菜单由
// 操作系统绘制，配色 / 圆角 / 动效都跟本应用对不上；浮层则直接复用下拉那一套（--z-context-menu /
// --shadow-dropdown / menu-in、menu-out / 悬停 5% 淡底 / 按下 10%），与「和其他类似的下拉保持一致」对得上。
// 不带图标；右侧标真实的快捷键组合（与 Google 右键菜单同款排布）——只标单字母会跟真按下去的键对不上。
// 动作全部走主进程的 webContents 编辑命令（preload 的 editAction）：页面里的 document.execCommand
// 对 paste 是禁用的（网页内容拿不到剪贴板读权限），cut/copy 又依赖用户手势，五个动作统一走一条路更稳。
//
// 两套菜单项：输入框给全套五项；正文（候选人姓名、输出目录、错误信息这些能选中的文字）只给
// 复制 / 全选 —— 剪切 / 粘贴 / 删除在只读文字上没有语义，摆一排灰项只是噪音。
const CONTEXT_MENU_ITEMS = [
  { action: 'cut', label: '剪切', key: 'Ctrl+X' },
  { action: 'copy', label: '复制', key: 'Ctrl+C' },
  { action: 'paste', label: '粘贴', key: 'Ctrl+V' },
  { action: 'delete', label: '删除', key: 'Del' },
  { action: 'selectAll', label: '全选', key: 'Ctrl+A' },
];
const CONTEXT_MENU_TEXT_ITEMS = [
  { action: 'copy', label: '复制', key: 'Ctrl+C' },
  { action: 'selectAll', label: '全选', key: 'Ctrl+A' },
];

// 能用右键菜单的控件：文本类 input 与 textarea。勾选框 / 单选框 / 文件选择这些没有文本编辑语义，
// 不弹菜单（原生右键在那几个上也没有这些项）
const CONTEXT_MENU_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number']);
function isTextEntry(el) {
  if (!el) return false;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return CONTEXT_MENU_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase());
}

// 落点是不是「能选中的正文」。交互控件（按钮 / 可点行 / 标签）都显式设了 user-select:none
// （base.css 的 button 规则 + 各处可点行），所以沿祖先链走一遍、遇到第一个 none 就说明点在了
// 控件里，不给菜单。逐个祖先查而不是只读落点自身的计算值：user-select 在 Chromium 里是继承的、
// 按规范却不是，自己走链最稳，不受实现差异影响。
// 控件本身（复选框 / 下拉 / 文件选择 / 禁用输入框）另外挡掉——它们没有「选中文字复制」的语义。
function isSelectableText(el) {
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return false;
  for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
    if (getComputedStyle(n).userSelect === 'none') return false;
  }
  return true;
}

let contextMenuEl = null;
// 右键点中的字段；null 表示落在正文上（没有字段可作用，编辑命令走文档选区）——
// 「是不是正文模式」全部由它判断，不再另设一个 mode 变量跟着同步
let contextMenuTarget = null;
let contextMenuSel = null;      // 输入框那一刻的选区，执行动作前还原（见 runContextMenuAction）
let contextMenuRange = null;    // 正文那一刻的选区（Range），同理
let contextMenuCloseTimer = null;

// 菜单是不是正开着（收起时只是 display:none 留在 DOM 里等下次重建）
function isContextMenuOpen() {
  return !!contextMenuEl && contextMenuEl.style.display !== 'none';
}

function buildContextMenu(target) {
  const items = target ? CONTEXT_MENU_ITEMS : CONTEXT_MENU_TEXT_ITEMS;
  const menu = document.createElement('div');
  menu.className = 'context-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-hidden', 'true');
  menu.style.display = 'none';
  items.forEach(({ action, label, key }) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'context-menu-item';
    item.dataset.action = action;
    item.setAttribute('role', 'menuitem');
    const labelEl = document.createElement('span');
    labelEl.textContent = label;
    const keyEl = document.createElement('span');
    keyEl.className = 'context-menu-key';
    keyEl.textContent = key;
    item.append(labelEl, keyEl);
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      runContextMenuAction(item.dataset.action);
    });
    menu.appendChild(item);
  });
  document.body.appendChild(menu);
  return menu;
}

// target 为 null = 落在正文上（只有文档选区，没有字段）
function openContextMenu(x, y, target) {
  // 每次右键都重建菜单：项数按落点定（正文只有复制/全选），重建比「记住上次是哪种、不同才重建」
  // 少一个状态变量，菜单也就两三个按钮，这点开销可以忽略。重建前清掉退场计时器，
  // 免得它到点去动已经换掉的节点
  if (contextMenuEl) {
    clearTimeout(contextMenuCloseTimer);
    contextMenuEl.remove();
  }
  const menu = buildContextMenu(target);
  contextMenuEl = menu;
  contextMenuTarget = target;
  contextMenuSel = null;
  contextMenuRange = null;
  if (target) {
    try {
      contextMenuSel = { start: target.selectionStart, end: target.selectionEnd, dir: target.selectionDirection };
    } catch { contextMenuSel = null; } // number 等读不到选区的类型
  } else {
    // 正文没有「字段」可还原，改捕获文档选区。点菜单项那一下会把它收掉，执行前放回去
    const s = window.getSelection();
    if (s && s.rangeCount > 0 && !s.isCollapsed) contextMenuRange = s.getRangeAt(0).cloneRange();
  }

  // 各项可用性按当前字段状态定（禁用项照常占位、只置灰，原生右键菜单也是这么做的）：
  // 密码框不给剪切 / 复制 / 删除（明文不外流，与浏览器一致）；只读框不给改内容的动作；
  // 没有选中文本时剪切 / 复制 / 删除无从下手。粘贴在密码框里是允许的（浏览器也允许）。
  // 正文模式只有复制 / 全选：没选中文字时复制灰着、全选照常可用（与 Chrome 一致，右键总有反应）。
  let enabled;
  if (!target) {
    // 正文模式没有字段可问，只按「有没有选中文字」定
    enabled = { copy: !!contextMenuRange, selectAll: true };
  } else {
    const isPassword = target.type === 'password';
    const readOnly = target.readOnly === true;
    // 上面刚捕获的选区就是答案，不再回头问一遍字段
    const hasSel = !!contextMenuSel && contextMenuSel.start !== contextMenuSel.end;
    enabled = {
      cut: !isPassword && !readOnly && hasSel,
      copy: !isPassword && hasSel,
      paste: !readOnly,
      delete: !readOnly && hasSel,
      selectAll: true,
    };
  }
  menu.querySelectorAll('.context-menu-item').forEach((item) => {
    item.disabled = enabled[item.dataset.action] !== true;
    item.classList.remove('is-active');
  });

  // 先摆到光标处再量尺寸，量完按需翻转（贴右 / 贴底时改从光标左上侧展开）。
  // 量之前先 visibility:hidden —— 同一个任务里设回可见不会多画一帧，但能避免「先按未翻转的
  // 位置画出来、下一帧才跳到翻转位」那一跳；入场动画也从这一刻正常起播
  menu.style.visibility = 'hidden';
  menu.style.display = 'flex';
  menu.style.left = '0px';
  menu.style.top = '0px';
  const rect = menu.getBoundingClientRect();
  const gap = 4;
  const flipX = x + rect.width + gap > window.innerWidth;
  const flipY = y + rect.height + gap > window.innerHeight;
  menu.style.left = `${flipX ? Math.max(gap, x - rect.width) : x}px`;
  menu.style.top = `${flipY ? Math.max(gap, y - rect.height) : y}px`;
  // 缩放轴心随展开方向（同下拉）：贴右 / 贴底时从光标那一侧起收
  menu.style.transformOrigin = `${flipY ? 'bottom' : 'top'} ${flipX ? 'right' : 'left'}`;
  menu.style.visibility = '';
  menu.setAttribute('aria-hidden', 'false');
}

function closeContextMenu() {
  if (!isContextMenuOpen()) return;
  const menu = contextMenuEl;
  contextMenuTarget = null;
  contextMenuSel = null;
  contextMenuRange = null;
  menu.setAttribute('aria-hidden', 'true');
  menu.querySelectorAll('.context-menu-item').forEach((i) => i.classList.remove('is-active'));
  // 系统开了「减少动态效果」：全局动画已被压成 0.01ms，直接隐藏，别干等退场时长
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    menu.style.display = 'none';
    return;
  }
  menu.classList.add('context-menu--closing');
  clearTimeout(contextMenuCloseTimer);
  // 退场时长直接读 CSS（menu-out = --dur-fast 150ms），改档位只需改 CSS
  contextMenuCloseTimer = setTimeout(() => {
    menu.classList.remove('context-menu--closing');
    menu.style.display = 'none';
  }, exitMsOf(menu, 170));
}

async function runContextMenuAction(action) {
  const target = contextMenuTarget;
  const sel = contextMenuSel;
  const range = contextMenuRange;
  closeContextMenu();
  if (!target) {
    // 正文没有焦点目标，编辑命令直接作用在文档选区上。点菜单项那一下把选区收掉了，先放回去
    if (range) {
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
    }
    await window.electronAPI.editAction(action);
    return;
  }
  // 焦点交还字段再执行：编辑命令作用在「当前聚焦元素」上，而刚才点菜单项把焦点挪到了按钮上。
  // 顺带还原选区 —— 失焦期间 Chromium 不画高亮，选中范围本身也未必原样留着
  target.focus();
  if (sel && sel.start !== null && sel.start !== undefined) {
    try { target.setSelectionRange(sel.start, sel.end, sel.dir || undefined); } catch {}
  }
  await window.electronAPI.editAction(action);
}

// 键盘导航：焦点始终留在输入框里（菜单自己不吃焦点），所以导航键挂在 document 上。
// 这也是「动作能作用到正确字段」的前提 —— 焦点一旦跑进菜单，编辑命令就打偏了
function moveContextMenuActive(step) {
  if (!isContextMenuOpen()) return;
  const items = Array.from(contextMenuEl.querySelectorAll('.context-menu-item:not(:disabled)'));
  if (!items.length) return;
  const cur = items.findIndex((i) => i.classList.contains('is-active'));
  const next = cur < 0 ? (step > 0 ? 0 : items.length - 1) : (cur + step + items.length) % items.length;
  items.forEach((i) => i.classList.remove('is-active'));
  items[next].classList.add('is-active');
}

document.addEventListener('contextmenu', (e) => {
  const el = e.target;
  if (isTextEntry(el)) {
    if (el.disabled) { closeContextMenu(); return; } // 禁用框不给菜单（改不动也复制不了）
    e.preventDefault(); // 挡掉系统原生菜单
    openContextMenu(e.clientX, e.clientY, el);
    return;
  }
  // 正文 / 空白处：只要不是交互控件就给菜单。与 Chrome 一致 —— 右键总有反应，
  // 不然「这儿右键有菜单」这件事只能靠猜（用户不会先选中文字再右键）
  if (el && el.nodeType === 1 && isSelectableText(el)) {
    e.preventDefault();
    openContextMenu(e.clientX, e.clientY, null);
    return;
  }
  closeContextMenu();
});

// 键盘：捕获阶段处理，赶在输入框自己的按键处理之前
document.addEventListener('keydown', (e) => {
  if (!isContextMenuOpen()) return;
  if (e.key === 'Escape') { e.preventDefault(); closeContextMenu(); return; }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    moveContextMenuActive(e.key === 'ArrowDown' ? 1 : -1);
    return;
  }
  if (e.key === 'Enter' || e.key === ' ') {
    const active = contextMenuEl.querySelector('.context-menu-item.is-active');
    if (active) { e.preventDefault(); runContextMenuAction(active.dataset.action); }
    return;
  }
  // 其它按键：按 Chrome 的做法直接收起，但**不拦按键**——Ctrl+C 这类快捷键照常生效
  closeContextMenu();
}, true);

// 点在别处（含别的输入框：那次 contextmenu 会自己重开菜单）/ 窗口尺寸变化 / 页面滚动，都收起
document.addEventListener('mousedown', (e) => {
  if (contextMenuEl && contextMenuEl.contains(e.target)) return;
  closeContextMenu();
});
window.addEventListener('resize', closeContextMenu);
window.addEventListener('blur', closeContextMenu);
document.addEventListener('scroll', closeContextMenu, true);

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

