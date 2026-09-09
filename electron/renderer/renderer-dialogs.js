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
    // 淡出时长直接读 CSS（closing 的 overlay-out/box-out 均 = --dur-normal=250ms），改 CSS 档位只需同步这里
    let exitMs = 280;
    const durStr = (getComputedStyle(overlay).animationDuration || '').trim();
    if (durStr) {
      const n = parseFloat(durStr);
      if (Number.isFinite(n) && n > 0) {
        exitMs = (durStr.endsWith('ms') ? n : n * 1000) + 30; // +30ms 缓冲，等动画播完再隐藏
      }
    }
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

// 全局 Escape：关闭当前打开的弹窗
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (jobDialogOverlay.style.display === 'flex') closeJobDialogAll();
  else if (jobPickerOverlay.style.display === 'flex') hideJobPicker();
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
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const source = btn.dataset.source;
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
    // 自动打招呼只用于推荐牛人页，不用于沟通页和搜索页（搜索页打招呼需畅聊卡）
    autoGreetSection.style.display = isChat || isSearch ? 'none' : '';
    if (isChat || isSearch) autoGreetCheck.checked = false;
    syncCountArrows(); // 上方可能已把 countInput 重新启用，步进箭头跟着启用
  });
});

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
  // 挂类前读会拿到入场 box-in(--dur-dialog .4s) 的时长，交接就比实际晚 ~180ms。+30ms 缓冲兜住尾帧
  let outMs = 280;
  const durStr = box ? (getComputedStyle(box).animationDuration || '').trim() : '';
  if (durStr) {
    const n = parseFloat(durStr);
    if (Number.isFinite(n) && n > 0) outMs = (durStr.endsWith('ms') ? n : n * 1000) + 30;
  }
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
  try {
    if (editJobName) {
      // 编辑模式：名称变了先重命名岗位文件（保留描述内容），再按需更新描述。
      // 选中中的岗位同步到新名，否则 loadJobList 会因旧名不在列表而清空选中
      if (jobName !== editJobName) {
        await window.electronAPI.renameRecommendJob(editJobName, jobName);
        if (selectedJob === editJobName) selectedJob = jobName;
      }
      await window.electronAPI.updateRecommendJob(jobName, jobDesc);
    } else {
      // 添加模式：创建新岗位
      await window.electronAPI.addRecommendJob(jobName, jobDesc);
      selectedJob = jobName;
    }
    await loadJobList();
    hideAddJobDialog();
  } catch (err) {
    showToast((editJobName ? '编辑' : '添加') + '失败：' + err.message, 'error');
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

