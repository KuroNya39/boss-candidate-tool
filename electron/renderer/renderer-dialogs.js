// renderer-dialogs.js —— 弹窗开关、焦点陷阱、弹窗互切与关闭动画。
// 渲染进程各脚本按 index.html 中的排列顺序加载，请勿调整加载顺序
//
// ===== 弹窗焦点管理 =====
// 焦点陷阱：弹窗打开时 Tab 只能在弹窗内循环
function trapFocus(overlay) {
  const handler = (e) => {
    if (e.key !== 'Tab') return;
    const focusables = Array.from(overlay.querySelectorAll('button, input, textarea, select, [tabindex]:not([tabindex="-1"])'))
      .filter((el) => !el.disabled && el.offsetParent !== null);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  document.addEventListener('keydown', handler);
  return () => document.removeEventListener('keydown', handler);
}

let activeDialogTrap = null;
let dialogPrevFocus = null;

function openDialog(overlay, firstFocusEl) {
  overlay.removeAttribute('inert');
  overlay.classList.remove('dialog-overlay--closing'); // 正在淡出时又被重新打开，则取消关闭
  // 弹窗互切入场（见 swapJobDialogs 与 overlays.css）：
  //  data-swap-over —— 交叉过渡：新弹窗以「透明遮罩 + 快速 box-in」浮到旧弹窗之上、与旧卡同屏对淡，
  //                    收尾帧由 swapJobDialogs 把它的 class 换成常驻态 swap-in
  //  data-swap-in   —— 瞬切兜底：遮罩瞬间接替（animation:none），只演快速面板入场
  //  一次性 data-swap-* 读后即摘；class 挂到下次关闭/收尾再摘（见 closeDialog / hideSwappedOutOverlay），
  //  避免中途摘掉让基础遮罩淡入在打开后补跑一帧。整屏打开（无 data-swap-*）则确保已摘、遮罩正常淡入
  if (overlay.hasAttribute('data-swap-over')) {
    overlay.removeAttribute('data-swap-over');
    overlay.classList.remove('dialog-overlay--swap-in');
    overlay.classList.add('dialog-overlay--swap-over');
  } else if (overlay.hasAttribute('data-swap-in')) {
    overlay.removeAttribute('data-swap-in');
    overlay.classList.remove('dialog-overlay--swap-over');
    overlay.classList.add('dialog-overlay--swap-in');
  } else {
    overlay.classList.remove('dialog-overlay--swap-in', 'dialog-overlay--swap-over');
  }
  dialogPrevFocus = document.activeElement;
  overlay.style.display = 'flex';
  if (activeDialogTrap) activeDialogTrap();
  activeDialogTrap = trapFocus(overlay);
  (firstFocusEl || overlay.querySelector('button, input, textarea, select')).focus();
}

function closeDialog(overlay, { animate = false } = {}) {
  if (activeDialogTrap) { activeDialogTrap(); activeDialogTrap = null; }
  // 摘掉互切时的一次性入场/退场标记（挂在遮罩未显示时最安全，下次整屏打开遮罩才能正常淡入）
  overlay.classList.remove('dialog-overlay--swap-in', 'dialog-overlay--swap-out', 'dialog-overlay--swap-over');
  // 系统开了「减少动态效果」时不做过渡，直接关闭，避免干等动画时长
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduceMotion) {
    // 先淡出再隐藏：与紧接着打开的弹窗淡入衔接成连续过渡，不会「啪」一下消失
    overlay.setAttribute('inert', '');
    overlay.classList.add('dialog-overlay--closing');
    // 淡出时长直接读 CSS（closing 的 overlay-out/box-out 均 = --dur-normal=250ms），改 CSS 档位只需改 CSS
    const exitMs = exitMsOf(overlay, 280);
    setTimeout(() => {
      // 淡出期间这个弹窗若被重新打开（closing 类被摘、动画被取消），就不再隐藏它
      if (!overlay.classList.contains('dialog-overlay--closing')) return;
      overlay.removeAttribute('inert');
      overlay.style.display = 'none';
      overlay.classList.remove('dialog-overlay--closing');
      // 已有其他弹窗开着（比如编辑弹窗）时不抢焦点
      const anotherOpen = [...document.querySelectorAll('.dialog-overlay')]
        .some((o) => o !== overlay && o.style.display === 'flex');
      if (!anotherOpen && dialogPrevFocus && typeof dialogPrevFocus.focus === 'function') dialogPrevFocus.focus();
    }, exitMs);
  } else {
    overlay.style.display = 'none';
    if (dialogPrevFocus && typeof dialogPrevFocus.focus === 'function') dialogPrevFocus.focus();
  }
}

// 互切收尾用的直接隐藏：旧弹窗此时已淡到透明，只是把它的遮罩撤掉、交给新弹窗接管。
// 不能走 closeDialog——那会拆掉正在为「新弹窗」服务的共享 activeDialogTrap，还会把焦点抢到已隐藏的旧弹窗里。
// inert 保留即可（display:none 后本就不在 Tab 序里），下次 openDialog 会先 removeAttribute('inert')
function hideSwappedOutOverlay(overlay) {
  overlay.classList.remove('dialog-overlay--swap-in', 'dialog-overlay--swap-out', 'dialog-overlay--swap-over');
  overlay.style.display = 'none';
}

// ===== 左上角菜单（「设置」「历史记录」的唯一入口）=====
// 面板出入场用 menu-in / menu-out（topbar.css），退场比入场短，与弹窗同一套「出快于入」。
let menuExitTimer = null;
// 语义上的「菜单开着」。不能拿 style.display 当开关：进 --closing 退场后 display 仍是 flex，
// 要等退场计时器跑完才变 none —— 那段窗口里点 ☰ 会被判成「已开着」而只重复关闭、不重开，
// 按 Esc 也会先被菜单吃掉一层。退场一开始就算收起（同 renderer-widgets.js 的 openState）：
// 此刻点 ☰ 能立刻取消退场重开，Esc 也能直接落到下面的弹窗上。
let menuOpen = false;

function openMenu() {
  if (!menuPanel) return;
  menuOpen = true;
  clearTimeout(menuExitTimer);
  menuPanel.classList.remove('menu-panel--closing');
  menuPanel.style.display = 'flex';
  btnMenu.setAttribute('aria-expanded', 'true');
  // 键盘打开的菜单要把焦点送进第一项（ARIA 菜单契约）；鼠标点击则不抢焦点。
  // 用 :focus-visible 判断输入方式：键盘激活 ⋮ 时为真，鼠标点击时为假
  if (btnMenu.matches(':focus-visible')) focusMenuItem(0);
}

// restoreFocus：从菜单项跳去弹窗时把焦点交还 ☰，
// 这样弹窗关闭后 closeDialog 记录的「打开前的焦点」正好是 ☰，键盘用户不会丢失落点
function closeMenu({ restoreFocus = false } = {}) {
  if (!menuOpen) return;
  menuOpen = false; // 先落状态：退场期间再点 ☰ 就是「重新打开」，不是「再关一次」
  btnMenu.setAttribute('aria-expanded', 'false');
  clearTimeout(menuExitTimer);
  const settle = () => {
    menuPanel.classList.remove('menu-panel--closing');
    menuPanel.style.display = 'none';
  };
  // 系统开了「减少动态效果」：全局动画已被压成 0.01ms，直接收起，别干等退场时长（同 closeDialog）
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    settle();
  } else {
    menuPanel.classList.add('menu-panel--closing');
    // 退场时长直接读 CSS（menu-out = --dur-fast 150ms），改 CSS 档位不必回来改数字
    menuExitTimer = setTimeout(settle, exitMsOf(menuPanel, 180));
  }
  if (restoreFocus) btnMenu.focus();
}

btnMenu.addEventListener('click', () => {
  if (menuOpen) closeMenu();
  else openMenu();
});

// --- 键盘漫游 ---
// 面板标了 role="menu"、菜单项标了 role="menuitem"，就必须兑现这套角色的键盘契约：
// 方向键在项间移动。不兑现的话读屏会把「菜单」念给用户听，用户按方向键却没反应 —— 比不标角色更糟。
// 菜单项固定两项（设置 / 历史记录），打开后不再增删 —— 一次性取好。
// 方向键按住会以约 30 次/秒连发，每次事件重查 DOM 是白费的
const menuItems = Array.from(menuPanel.querySelectorAll('.menu-item'));
function focusMenuItem(index) {
  if (!menuItems.length) return;
  menuItems[((index % menuItems.length) + menuItems.length) % menuItems.length].focus(); // 取模 + 加长度：首尾相接、负数也正确
}
menuPanel.addEventListener('keydown', (e) => {
  const cur = menuItems.indexOf(document.activeElement);
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusMenuItem(cur + 1); break;
    case 'ArrowUp': e.preventDefault(); focusMenuItem(cur - 1); break;
    case 'Home': e.preventDefault(); focusMenuItem(0); break;
    case 'End': e.preventDefault(); focusMenuItem(menuItems.length - 1); break;
    default: break;
  }
});
// 焦点一旦离开面板就收起（Tab 走开、点到别处、切换窗口都算）。
// Tab 因此不用特殊处理：焦点自然落到面板之后的下一个控件，菜单顺手关掉。
// relatedTarget 仍在面板内（两项之间移动）时不关，否则方向键漫游会被自己打断
menuPanel.addEventListener('focusout', (e) => {
  if (e.relatedTarget instanceof Node && menuPanel.contains(e.relatedTarget)) return;
  closeMenu();
});

// 点菜单外收起。用 pointerdown 捕获阶段：比 click 早一步，点别处时菜单不会「晚半拍才消失」。
// .menu-wrap 内部（按钮本身 + 两个菜单项）不关 —— 否则点「设置」时菜单先被关掉、
// 随后的 click 落到面板外，菜单项反而点不中
document.addEventListener('pointerdown', (e) => {
  if (!menuOpen) return;
  if (e.target instanceof Node && btnMenu.parentElement.contains(e.target)) return;
  closeMenu();
}, true);

// 窗口尺寸变化时面板可能戳到窗口外，直接收起（与指示条 repinSourcePill 同为 resize 善后）。
// 连同把焦点还给 ☰：不还的话焦点还留在面板里，收成 display:none 后直接掉到 body。
// 焦点本来就不在面板里时（比如指针悬停触发的收起），menuOpen 早已被 focusout 处理掉，这里不会再跑
window.addEventListener('resize', () => closeMenu({ restoreFocus: true }));

// ===== 设置弹窗 =====
function openSettingsDialog() {
  openDialog(settingsOverlay, apiUrlInput);
}
function closeSettingsDialog() {
  closeDialog(settingsOverlay, { animate: true });
}
btnOpenSettings.addEventListener('click', () => {
  closeMenu({ restoreFocus: true });
  openSettingsDialog();
});
btnSettingsClose.addEventListener('click', closeSettingsDialog);
settingsOverlay.addEventListener('click', (e) => {
  if (e.target === settingsOverlay) closeSettingsDialog();
});

// 全局 Escape：关闭当前打开的弹窗（菜单 → 各弹窗，一次只关一层）
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  // 通用确认弹窗（删除/清空等）自带 Esc 处理，且它总是叠在别的弹窗之上。
  // 这里必须让路：全局链注册得更早、会先跑，不放行就会一次 Esc 把确认框和它底下的
  // 弹窗（如历史记录）一起关掉 —— 用户只想取消确认框，结果连历史记录也没了
  if (confirmOverlay && confirmOverlay.style.display === 'flex') return;
  if (menuOpen) closeMenu({ restoreFocus: true });
  else if (jobDialogOverlay.style.display === 'flex') closeJobDialogAll();
  else if (jobPickerOverlay.style.display === 'flex') hideJobPicker();
  else if (settingsOverlay.style.display === 'flex') closeSettingsDialog();
  else if (historyOverlay.style.display === 'flex') closeHistoryDrawer();
});

// 显示/隐藏目标岗位弹窗
function showJobPicker() {
  jobSearchClear.classList.toggle('show', !!jobSearchInput.value);
  renderJobPicker();
  openDialog(jobPickerOverlay, jobSearchInput);
}

function hideJobPicker() {
  closeDialog(jobPickerOverlay, { animate: true });
}

// 目标岗位弹窗事件
jobDisplay.addEventListener('click', showJobPicker);
btnPickerCancel.addEventListener('click', hideJobPicker);
jobPickerOverlay.addEventListener('click', (e) => {
  if (e.target === jobPickerOverlay) hideJobPicker();
});
// 岗位搜索：输入实时过滤列表
jobSearchInput.addEventListener('input', () => {
  jobSearchQuery = jobSearchInput.value;
  jobSearchClear.classList.toggle('show', !!jobSearchInput.value);
  renderJobPicker();
});
// 一键清空搜索框
jobSearchClear.addEventListener('click', () => {
  jobSearchInput.value = '';
  jobSearchQuery = '';
  jobSearchClear.classList.remove('show');
  renderJobPicker();
  jobSearchInput.focus();
});

// 设置卡输入框不再提供一键清空 ×（只留密码眼睛），相关通用接线已删除。
// 岗位搜索框的清除按钮自带单独逻辑（上方 jobSearchClear）。
// Source toggle (card-style buttons)
// 选中浅蓝底由滑动指示条（.toggle-pill）承载：切换时指示条滑到新档，点当前档直接忽略
const sourceGroup = document.getElementById('source-toggle-group');
const sourcePill = sourceGroup ? sourceGroup.querySelector('.toggle-pill') : null;

// 指示条贴到目标按钮：用 offsetWidth/offsetLeft（布局几何，不受 :active 缩放变换影响），
// 与按钮同以 toggle-group 为 offsetParent，任何内边距/宽度下都对齐
function slideSourcePill(btn) {
  if (!sourcePill || !btn) return;
  sourcePill.style.width = `${btn.offsetWidth}px`;
  sourcePill.style.transform = `translateX(${btn.offsetLeft}px)`;
}

// 切到某个来源：高亮该档 + 同步 selectedSource + 按来源铺开/收起下方控件，
// 三件事一次做完。原先「点分段按钮」和 renderer-greet.js 的 init 里各写了一份（逐行重复），
// 抽成一处，来源增删只改这里。
// 指示条一律交给 slideSourcePill 走 CSS 过渡：点击切档、拖动跨格都同一条滑行动画，
// 快慢只由 .toggle-pill 的 transition 决定
function selectSource(source, btn) {
  document.querySelectorAll('.toggle-btn').forEach((b) => b.classList.toggle('active', b === btn));
  selectedSource = source;
  const isAttach = source === 'recommend-attach';
  const isSearch = source === 'search';
  const isChat = source === 'chat';
  const showJobSelector = isAttach || isSearch;
  jobSelectSection.style.display = showJobSelector ? 'flex' : 'none';
  runGridMain.classList.toggle('has-job', showJobSelector);
  extractAllSection.style.display = isChat ? '' : 'none';
  if (!isChat && extractAllCheck.checked) {
    extractAllCheck.checked = false;
    countInput.disabled = false;
  }
  if (isAttach) updateJobDisplay();
  // 自动打招呼只用于推荐牛人页，不用于沟通页和搜索页（搜索页打招呼需畅聊卡）。
  // 切走只藏整块、不动勾选：勾选是用户偏好，切走再切回应原样保留（不再置 false——
  // 程序置 false 不触发 change 事件、等级下拉没跟着收，回来就是「没勾但下拉还在」的错位）
  autoGreetSection.style.display = isChat || isSearch ? 'none' : '';
  syncCountArrows(); // 上方可能已把 countInput 重新启用，步进箭头跟着启用
  if (btn) slideSourcePill(btn); // 指示条滑到新选中的档
}

// 拖动收尾时浏览器会补发一次 click（指到起手那一格），用它吞掉。
// 消费点在下面组上的 click 处理里 —— 唯一入口，标记不会漏消费
let suppressSourceClick = false;

// ===== 来源分段：按住鼠标左右拖动选择 =====
// 单纯点击仍走上面的 click 分支；只有位移越过阈值才算拖动。
// 拖动期间指示条不跟手（不做 1:1 追指针），而是「跨一格、跳一格」：
// 指针从 A 格滑进 B 格，指示条才带着 .toggle-pill 的 CSS 过渡（--transition-normal）滑过去，
// 然后停住等指针继续推 —— 这一格一顿的节奏就是用户要的「拖动时有停顿感」。
// 跟手 1:1 太顺，三档之间反而没有分界感。
const SOURCE_DRAG_THRESHOLD = 4; // px：小于它视为手抖，仍按点击处理
let sourceDrag = null;           // { pointerId, startX, lastBtn, moved, base, w }

// 三个来源按钮加载后不再增删：一次取好，起手时再量一次组几何即可
const sourceBtns = Array.from(sourceGroup.querySelectorAll('.toggle-btn'));

// 指针当前落在第几格。三档等宽，按「首格左边缘 + 格宽」均分取整即可；
// 比逐个 hit-test 稳——指针压在格与格的交界上时不会忽左忽右。
// base / w 由 pointerdown 量好传进来（拖动中组不会移动或改宽，不必每次 pointermove 重读布局）
function sourceBtnAt(clientX, base, w) {
  if (!sourceBtns.length) return null;
  const i = Math.floor((clientX - base) / w);
  return sourceBtns[Math.min(sourceBtns.length - 1, Math.max(0, i))];
}

// 点一下换来源 —— 唯一入口，委托在组上，不给每个按钮各挂一个 click。
// 原因：拖拽起手时组会 setPointerCapture，而指针捕获会把随后的兼容鼠标事件（含 click）
// 一并重定向到捕获元素。capture 一旦落在组上，按钮上的 click 根本不会发生，
// 「点一下换来源」就整个失效了（只剩拖动还能用）。委托到组上则两条路径都能收到。
sourceGroup.addEventListener('click', (e) => {
  if (suppressSourceClick) { suppressSourceClick = false; return; } // 拖动后补发的那一次：吞掉
  const first = sourceBtns[0];
  const btn = (e.target instanceof Element ? e.target.closest('.toggle-btn') : null)
    // e.target 是组本身（被捕获重定向过来）时按坐标认格：三档等宽，见 sourceBtnAt。
    // 点击很稀疏，几何现量现用，不像拖动那样缓存
    || (first ? sourceBtnAt(e.clientX, sourceGroup.getBoundingClientRect().left + first.offsetLeft, first.offsetWidth || 1) : null);
  if (!btn || btn.classList.contains('active')) return; // 已在此档：不重复切换
  selectSource(btn.dataset.source, btn);
});

sourceGroup.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'mouse' && e.button !== 0) return; // 只响应鼠标左键
  if (!e.target.closest('.toggle-btn') || !sourcePill) return;
  suppressSourceClick = false;
  const firstBtn = sourceBtns[0];
  sourceDrag = {
    pointerId: e.pointerId,
    startX: e.clientX,
    // 起手时指着哪一格（一般就是当前选中那格）。拖动中只在「换格」时才动指示条
    lastBtn: sourceGroup.querySelector('.toggle-btn.active'),
    moved: false,
    // 拖动期间组不会移动或改宽：几何在起手时量一次，pointermove 直接算，不重读布局
    base: sourceGroup.getBoundingClientRect().left + firstBtn.offsetLeft,
    w: firstBtn.offsetWidth || 1,
  };
  // 捕获指针：拖出组外（甚至拖到窗口外）也不断线
  try { sourceGroup.setPointerCapture(e.pointerId); } catch {}
});

sourceGroup.addEventListener('pointermove', (e) => {
  if (!sourceDrag || e.pointerId !== sourceDrag.pointerId) return;
  if (!sourceDrag.moved) {
    if (Math.abs(e.clientX - sourceDrag.startX) < SOURCE_DRAG_THRESHOLD) return; // 还没过阈值，先当手抖
    sourceDrag.moved = true;
    document.body.classList.add('is-dragging-source'); // 整窗换成抓握光标（见 config.css）
  }
  const hovered = sourceBtnAt(e.clientX, sourceDrag.base, sourceDrag.w);
  if (!hovered || hovered === sourceDrag.lastBtn) return; // 还在同一格：指示条原地不动，等跨格
  sourceDrag.lastBtn = hovered;
  // 交给 selectSource 把指示条滑到这一格（走 .toggle-pill 的 CSS 过渡，不是瞬移），
  // 下方岗位/数量行同步换掉 —— 滑到哪一格就选到哪一格，不用等松手
  selectSource(hovered.dataset.source, hovered);
});

function endSourceDrag(e) {
  if (!sourceDrag || e.pointerId !== sourceDrag.pointerId) return;
  const wasDrag = sourceDrag.moved;
  sourceDrag = null;
  document.body.classList.remove('is-dragging-source'); // 光标还原
  try { sourceGroup.releasePointerCapture(e.pointerId); } catch {}
  if (!wasDrag) return; // 没进入拖动，随后那次 click 正常生效
  suppressSourceClick = true; // 吞掉浏览器随后补发的 click
}
sourceGroup.addEventListener('pointerup', endSourceDrag);
sourceGroup.addEventListener('pointercancel', endSourceDrag);

// 把指示条贴到当前选中的档（找 active 再 slide）。首帧与 resize 共用——
// 首帧加载时无上一次样式可比，transition 不会开场滑动；resize 改变 flex 均分宽度，需重量贴合
function repinSourcePill() {
  slideSourcePill(sourceGroup ? sourceGroup.querySelector('.toggle-btn.active') : null);
}
repinSourcePill();
window.addEventListener('resize', repinSourcePill);

// 添加/编辑岗位弹窗
function showAddJobDialog() {
  editJobName = '';
  dialogJobName.value = '';
  dialogJobName.readOnly = false;
  dialogJobName.classList.remove('input-readonly');
  dialogJobDesc.value = '';
  document.getElementById('job-dialog-title').textContent = '添加新岗位';
  openDialog(jobDialogOverlay, dialogJobName);
}

async function showEditJobDialog(jobName) {
  editJobName = jobName;
  // 岗位描述是本地文件读取（很快，几毫秒），先读好再弹窗，弹出来就是填好的，
  // 不会出现「先弹个空框、内容再突然塞进去」的突兀感
  let desc = '';
  try {
    desc = (await window.electronAPI.getRecommendJobDesc(jobName)) || '';
  } catch {
    desc = '';
  }
  // 读取的这几毫秒里如果用户切走了（点了别的岗位编辑 / 关了弹窗），就不再打开旧岗位的弹窗
  if (editJobName !== jobName) return;
  // v1.10.2：岗位名称与描述一样可改（改名 = 重命名岗位文件，见保存分支）；名称框不再只读
  dialogJobName.value = jobName;
  dialogJobName.readOnly = false;
  dialogJobName.classList.remove('input-readonly');
  dialogJobDesc.value = desc;
  document.getElementById('job-dialog-title').textContent = '编辑岗位';
  openDialog(jobDialogOverlay, dialogJobDesc);
}

// 弹窗互切（目标岗位 ⇄ 添加/编辑岗位）：
// 交叉过渡——同一帧让「旧卡淡出(swap-out)」与「新卡淡入(swap-over)」同时开播，两卡同屏对淡；
// 遮罩由旧弹窗从头到尾撑住（旧弹窗 swap-out 时遮罩 animation:none 留在原地），新弹窗以透明遮罩
// 叠在其上（不叠暗、不另起遮罩淡入）。全程没有任何「只剩空遮罩」的帧 → 不再闪。
// 两段都走 --dur-normal(250ms)，收尾帧(≈280ms)旧弹窗已淡尽，直接隐藏并把遮罩交接给新弹窗。
function swapJobDialogs(openFn) {
  const fromOpen = jobPickerOverlay.style.display === 'flex' ? jobPickerOverlay : jobDialogOverlay;
  const toOpen = fromOpen === jobPickerOverlay ? jobDialogOverlay : jobPickerOverlay;
  // 以下情况不演交叉过渡，同帧瞬切兜底（display 切换与后续打开在同一个 JS 任务内完成，浏览器只画一帧）：
  //  - 旧弹窗本身还在互切退场中（避免嵌套互切）
  //  - 旧面板还在入场（box-in 未播完）：此刻硬插 box-out 会从 opacity 中途翻转，那一下就是「闪」
  //  - 系统开了「减少动态效果」
  const box = fromOpen.querySelector('.dialog-box');
  const stillEntering = !!box && typeof box.getAnimations === 'function' &&
    box.getAnimations().some((a) => a.animationName === 'box-in' && a.playState === 'running');
  if (
    fromOpen.classList.contains('dialog-overlay--swap-out') ||
    matchMedia('(prefers-reduced-motion: reduce)').matches ||
    stillEntering
  ) {
    closeDialog(fromOpen, { animate: false });
    toOpen.setAttribute('data-swap-in', '');
    openFn();
    return;
  }
  // 交叉过渡开播：旧弹窗 inert + 旧卡挂 box-out（遮罩不动）；新弹窗打上 data-swap-over，
  // 由 openFn→openDialog 读成「透明遮罩 + 快速 box-in」浮到旧弹窗之上 —— 同一帧两卡对淡
  fromOpen.setAttribute('inert', '');
  fromOpen.classList.add('dialog-overlay--swap-out');
  toOpen.setAttribute('data-swap-over', '');
  openFn();
  // 退场时长：等 swap-out 挂上后再读 getComputedStyle，此刻面板走的才是 box-out(--dur-normal .25s)。
  // 挂类前读会拿到入场 box-in(--dur-dialog .4s) 的时长，交接就比实际晚 ~180ms
  const outMs = exitMsOf(box, 280);
  setTimeout(() => {
    // 收尾帧：旧弹窗已淡尽 → 直接隐藏它（遮罩交给新弹窗），新弹窗从「透明浮层」转成常驻态 swap-in。
    // 两处 DOM 改动同一帧生效，遮罩同色、无跳变。
    // 互切途中新弹窗若被手动关掉（Esc/点遮罩，display 已非 flex）→ 撤掉旧弹窗退场标记，互切取消、旧弹窗复原
    if (toOpen.style.display !== 'flex') {
      fromOpen.classList.remove('dialog-overlay--swap-out');
      fromOpen.removeAttribute('inert');
      return;
    }
    // 旧弹窗已被手动整屏淡出（closing）→ 不再动它，只把新弹窗转成常驻态（closeDialog 已摘掉旧弹窗的 swap-out）
    if (fromOpen.style.display !== 'flex' || fromOpen.classList.contains('dialog-overlay--closing')) {
      toOpen.classList.remove('dialog-overlay--swap-over');
      toOpen.classList.add('dialog-overlay--swap-in');
      return;
    }
    hideSwappedOutOverlay(fromOpen);
    toOpen.classList.remove('dialog-overlay--swap-over');
    toOpen.classList.add('dialog-overlay--swap-in');
  }, outMs);
}

// 从添加/编辑弹窗回到「目标岗位」列表（取消 / 保存后）：同一帧内互切，不闪不动
function hideAddJobDialog() {
  editJobName = '';
  swapJobDialogs(showJobPicker);
}

// 添加/编辑岗位弹窗点遮罩空白 / 按 Esc：直接关闭所有弹窗回到主界面，不退回「目标岗位」列表。
// 与「取消」按钮（返回目标岗位列表继续挑）语义区分——点空白 = 我不要这个弹窗了，全关掉。
function closeJobDialogAll() {
  editJobName = '';
  closeDialog(jobDialogOverlay, { animate: true });
}

// 删除岗位
async function deleteJob(jobName) {
  const ok = await confirmDialog({
    title: '删除岗位？',
    message: `确定要删除岗位「${jobName}」吗？`,
    okText: '删除',
    danger: true,
  });
  if (!ok) return;
  try {
    await window.electronAPI.deleteRecommendJob(jobName);
    if (selectedJob === jobName) selectedJob = '';
    await loadJobList();
  } catch (err) {
    showToast('删除失败：' + err.message, 'error');
  }
}

btnDialogCancel.addEventListener('click', hideAddJobDialog);
// 岗位描述文本域：右下角自定义拖拽手柄，替代原生 resize 手柄
const dialogResizeHandle = document.getElementById('dialog-resize-handle');
let isDialogResizing = false;
jobDialogOverlay.addEventListener('click', (e) => {
  // 点遮罩空白 = 直接关掉所有弹窗回主界面（不退回目标岗位列表，见 closeJobDialogAll）
  if (e.target === jobDialogOverlay && !isDialogResizing) closeJobDialogAll();
});
if (dialogResizeHandle) {
  dialogResizeHandle.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 只响应鼠标左键
    isDialogResizing = true;
    e.preventDefault();
    e.stopPropagation(); // 不让事件冒泡到遮罩，避免误关弹窗
    const startY = e.clientY;
    const startH = dialogJobDesc.offsetHeight;
    const maxH = Math.round(window.innerHeight * 0.6);
    // 捕获指针：拖拽全程事件都锁在手柄上，鼠标移出文本域也不会断、不会误触遮罩关闭
    try { dialogResizeHandle.setPointerCapture(e.pointerId); } catch {}
    const onMove = (ev) => {
      const next = startH + (ev.clientY - startY);
      dialogJobDesc.style.height = Math.max(64, Math.min(next, maxH)) + 'px';
    };
    const onUp = () => {
      isDialogResizing = false;
      dialogResizeHandle.removeEventListener('pointermove', onMove);
      dialogResizeHandle.removeEventListener('pointerup', onUp);
      dialogResizeHandle.removeEventListener('pointercancel', onUp);
      try { dialogResizeHandle.releasePointerCapture(e.pointerId); } catch {}
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    dialogResizeHandle.addEventListener('pointermove', onMove);
    dialogResizeHandle.addEventListener('pointerup', onUp);
    dialogResizeHandle.addEventListener('pointercancel', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'ns-resize';
  });
}

dialogJobName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dialogJobDesc.focus();
});

btnDialogSave.addEventListener('click', async () => {
  const jobName = dialogJobName.value.trim();
  const jobDesc = dialogJobDesc.value.trim();
  if (!jobName) {
    dialogJobName.focus();
    return;
  }
  // 保存要走三次 IPC（重命名 / 写描述 / 重载列表），慢盘上看得出来；期间转圈 + 禁点，
  // 防止连点保存写出两份（§8 loading = 转圈 + 真禁用，文字不变）。finally 保证异常路径也还原
  // 保存要跑三次 await（重命名 / 写描述 / 重载列表），期间用户可能按 Esc 或点遮罩把弹窗关掉
  // （closeJobDialogAll 会把 editJobName 清空）。这些 await 回来时必须先确认弹窗还在：
  // 否则 hideAddJobDialog 会顺着互切把刚被关掉的「目标岗位」列表又弹回来，报错文案也会因为
  // editJobName 已经被清空而把「编辑失败」说成「添加失败」。起手把模式记在局部变量里
  const editing = editJobName;
  const stillOpen = () => jobDialogOverlay.style.display === 'flex';
  setLoading(btnDialogSave, true);
  try {
    if (editing) {
      // 编辑模式：名称变了先重命名岗位文件（保留描述内容），再按需更新描述。
      // 选中中的岗位同步到新名，否则 loadJobList 会因旧名不在列表而清空选中
      if (jobName !== editing) {
        await window.electronAPI.renameRecommendJob(editing, jobName);
        if (selectedJob === editing) selectedJob = jobName;
      }
      await window.electronAPI.updateRecommendJob(jobName, jobDesc);
    } else {
      // 添加模式：创建新岗位
      await window.electronAPI.addRecommendJob(jobName, jobDesc);
      selectedJob = jobName;
    }
    await loadJobList();
    if (stillOpen()) hideAddJobDialog();
  } catch (err) {
    showToast((editing ? '编辑' : '添加') + '失败：' + err.message, 'error');
  } finally {
    setLoading(btnDialogSave, false);
  }
});

// 自动打招呼 checkbox 切换显示等级下拉
autoGreetCheck.addEventListener('change', () => {
  autoGreetControls.style.display = autoGreetCheck.checked ? '' : 'none';
});

// 提取全部 切换时禁用/启用数量输入
extractAllCheck.addEventListener('change', () => {
  countInput.disabled = extractAllCheck.checked;
  if (extractAllCheck.checked) countInput.value = '';
  syncCountArrows();
});

// 步进箭头：单击 +1 / −1（原生 spin 已在 config.css 隐藏，改由右侧两枚 sprite 图标调节）。
// 范围 1–999；手动步进即表示要按数量提取，若还勾着「提取全部」会一并取消勾选
countInc.addEventListener('click', () => stepCount(1));
countDec.addEventListener('click', () => stepCount(-1));
function stepCount(delta) {
  if (countInput.disabled) return;
  const cur = parseInt(countInput.value, 10);
  const base = Number.isFinite(cur) ? cur : 0;
  const next = Math.min(999, Math.max(1, base + delta));
  countInput.value = String(next);
  if (extractAllCheck.checked) {
    extractAllCheck.checked = false;
    countInput.disabled = false;
  }
  syncCountArrows();
}

// 手动输入上限：HTML 的 max=999 只拦原生微调、不拦直接输入，这里在输入时即时收住——
// 数字框里敲超过 999 的值会立刻变回 999，敲 0 或负数会变回 1（范围 1–999，与步进箭头一致）
countInput.addEventListener('input', () => {
  if (countInput.value === '') return;
  const v = Number(countInput.value);
  if (!Number.isFinite(v)) return;
  const clamped = Math.min(999, Math.max(1, v));
  if (clamped !== v) countInput.value = String(clamped);
});

// 输入框被禁用（勾了「提取全部」/ 来源不支持数量）时，步进箭头与组合框整体一起禁用
function syncCountArrows() {
  const disabled = countInput.disabled;
  if (countInc) countInc.disabled = disabled;
  if (countDec) countDec.disabled = disabled;
  const field = countInput.closest('.count-field');
  if (field) field.classList.toggle('count-field--disabled', disabled);
}

// 初始状态：默认提取全部，数量输入禁用
countInput.disabled = true;
syncCountArrows();

