// renderer-dialogs.js —— 由原 renderer.js 第 1352–1619 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
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
  dialogPrevFocus = document.activeElement;
  overlay.style.display = 'flex';
  if (activeDialogTrap) activeDialogTrap();
  activeDialogTrap = trapFocus(overlay);
  (firstFocusEl || overlay.querySelector('button, input, textarea, select')).focus();
}

function closeDialog(overlay, { animate = false } = {}) {
  if (activeDialogTrap) { activeDialogTrap(); activeDialogTrap = null; }
  // 系统开了「减少动态效果」时不做过渡，直接关闭，避免干等动画时长
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduceMotion) {
    // 先淡出再隐藏：与紧接着打开的弹窗淡入衔接成连续过渡，不会「啪」一下消失
    overlay.setAttribute('inert', '');
    overlay.classList.add('dialog-overlay--closing');
    // 淡出时长直接读 CSS（.dialog-overlay--closing 的 overlay-out = --dur-dialog），改 CSS 档位不必再同步 JS
    let exitMs = 350;
    const durStr = (getComputedStyle(overlay).animationDuration || '').trim();
    if (durStr) {
      const n = parseFloat(durStr);
      if (Number.isFinite(n) && n > 0) {
        exitMs = (durStr.endsWith('ms') ? n : n * 1000) + 30; // +30ms 缓冲，等动画播完再隐藏
      }
    }
    setTimeout(() => {
      // 淡出期间这个弹窗若被重新打开（class 被移除），就不再隐藏它
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

// 全局 Escape：关闭当前打开的弹窗
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (jobDialogOverlay.style.display === 'flex') hideAddJobDialog();
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
  dialogJobName.value = jobName;
  dialogJobName.readOnly = true;
  dialogJobName.classList.add('input-readonly');
  dialogJobDesc.value = desc;
  document.getElementById('job-dialog-title').textContent = '编辑岗位描述';
  openDialog(jobDialogOverlay, dialogJobDesc);
}

function hideAddJobDialog() {
  closeDialog(jobDialogOverlay, { animate: true });
  // 取消/关闭「添加/编辑岗位」弹窗后，回到打开它的「目标岗位」列表弹窗
  showJobPicker();
  editJobName = '';
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
  // 拖拽调整文本域大小时不触发「点击遮罩关闭」
  if (e.target === jobDialogOverlay && !isDialogResizing) hideAddJobDialog();
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
      // 编辑模式：更新岗位描述
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
});

// 初始状态：默认提取全部，数量输入禁用
countInput.disabled = true;

