// renderer-greet.js —— 由原 renderer.js 第 1620–1786 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 批量打招呼 =====

// 等级选择变化时更新人数
greetLevel.addEventListener('change', async () => {
  try {
    const counts = await window.electronAPI.getGreetCandidateCounts();
    if (counts.available) updateGreetCount(counts);
  } catch {}
});

// 开始打招呼
btnStartGreet.addEventListener('click', async () => {
  const level = parseInt(greetLevel.value, 10);
  btnStartGreet.style.display = 'none';
  btnCancelGreet.style.display = '';
  greetResult.style.display = 'none';
  greetProgress.style.display = '';
  greetProgressBar.style.width = '0%';
  if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', '0');
  greetProgressText.textContent = '正在打招呼';
  const res = await window.electronAPI.startGreeting(level, selectedSource);
  // 已有任务运行中：主进程拒绝，恢复打招呼面板，避免卡在「正在打招呼」的假进度
  if (res?.error) {
    showToast(res.error, 'warning', 4000);
    greetProgress.style.display = 'none';
    greetResult.style.display = 'none';
    btnStartGreet.style.display = '';
    btnCancelGreet.style.display = 'none';
  }
});

// 取消打招呼
btnCancelGreet.addEventListener('click', async () => {
  await window.electronAPI.cancelGreeting();
  greetProgressText.textContent = '已取消';
  btnCancelGreet.style.display = 'none';
  btnStartGreet.style.display = '';
});

// ===== CDP/Chrome 状态 =====
// 传入 prefetched 可复用刚取到的状态，避免连续多次 IPC 拉取；返回本次渲染的状态
async function updateCdpStatus(prefetched) {
  try {
    const status = prefetched || (await window.electronAPI.getCdpStatus());
    const dot = document.getElementById('chrome-status-dot');
    const text = document.getElementById('chrome-status-text');
    const retryBtn = document.getElementById('btn-retry-chrome');

    dot.className = 'status-dot';
    text.textContent = '';
    retryBtn.style.display = 'none';

    if (status.state === 'connected') {
      dot.classList.add('dot-green');
      text.textContent = 'CDP 代理已就绪';
    } else if (status.state === 'initializing' || status.state === 'connecting') {
      dot.classList.add('dot-yellow');
      text.textContent = status.message || '正在准备…';
    } else if (status.state === 'error') {
      dot.classList.add('dot-red');
      text.textContent = status.message || 'Chrome 连接失败';
      retryBtn.style.display = '';
    }
    return status;
  } catch {}
}

// ===== 批量打招呼辅助函数 =====
function updateGreetCount(counts) {
  const level = parseInt(greetLevel.value, 10);
  const n = counts.counts[level] || 0;
  greetCount.textContent = `可打招呼 ${n} 人`;
  btnStartGreet.disabled = n === 0;
}

function resetGreetUI() {
  greetSection.style.display = 'none';
  greetProgress.style.display = 'none';
  greetResult.style.display = 'none';
  greetResult.className = 'greet-result';
  greetResult.textContent = '';
  greetCount.textContent = '';
  btnStartGreet.style.display = '';
  btnStartGreet.disabled = false;
  btnCancelGreet.style.display = 'none';
}

// 同步自动打招呼 UI（回到初始状态时调用）
function syncAutoGreetUI() {
  autoGreetCheck.checked = false;
  autoGreetControls.style.display = 'none';
}

// ===== 初始化 =====
async function init() {
  try {
    const dir = await window.electronAPI.getOutputDir();
    outputDirSpan.textContent = dir;
  } catch {
    outputDirSpan.textContent = 'output/';
  }

  // 显示版本号
  try {
    const version = await window.electronAPI.getAppVersion();
    const verEl = document.getElementById('app-version');
    if (verEl && version) verEl.textContent = `v${version}`;
  } catch {}

  // 密码框显示/隐藏切换（👁 点击切换，睁眼/闭眼图标）
  // 引用 index.html 顶部图标库里的 #icon-eye-on / #icon-eye-off，切换时大小位置不跳
  const EYE_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-eye-on"/></svg>';
  const EYE_OFF_SVG = '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-eye-off"/></svg>';
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.input-toggle');
    if (!toggle) return;
    const targetId = toggle.getAttribute('data-target');
    const input = targetId && document.getElementById(targetId);
    if (input && input.type === 'password') {
      input.type = 'text';
      toggle.innerHTML = EYE_SVG; // 明文 → 睁眼
      toggle.setAttribute('aria-pressed', 'true');
    } else if (input) {
      input.type = 'password';
      toggle.innerHTML = EYE_OFF_SVG; // 隐藏 → 闭眼
      toggle.setAttribute('aria-pressed', 'false');
    }
  });

  await loadApiConfig();
  await updateCdpStatus();
  // 轮询 CDP 状态（未连接时持续刷新，用户勾选 Chrome 远程调试后自动变绿）
  setInterval(async () => {
    try {
      const s = await updateCdpStatus();
      // 如果是 error 状态且内容是 Chrome 未开远程调试，自动重试检测
      if (s && s.state === 'error' && s.message.includes('未开启远程调试')) {
        const retried = await window.electronAPI.retryCdpConnection();
        await updateCdpStatus(retried);
      }
    } catch {}
  }, 3000);
  setupListeners();
  // Set default source from active toggle
  const activeToggle = document.querySelector('.toggle-btn.active');
  if (activeToggle) {
    selectedSource = activeToggle.dataset.source;
    const isAttach = selectedSource === 'recommend-attach';
    const isSearch = selectedSource === 'search';
    const isChat = selectedSource === 'chat';
    const showJobSelector = isAttach || isSearch;
    jobSelectSection.style.display = showJobSelector ? 'flex' : 'none';
    runGridMain.classList.toggle('has-job', showJobSelector);
    extractAllSection.style.display = isChat ? '' : 'none';
    if (!isChat && extractAllCheck.checked) {
      extractAllCheck.checked = false;
      countInput.disabled = false;
    }
    // 自动打招呼只用于推荐牛人页，不用于沟通页和搜索页（搜索页打招呼需畅聊卡）
    autoGreetSection.style.display = isChat || isSearch ? 'none' : '';
    if (isChat || isSearch) autoGreetCheck.checked = false;
  }
  await loadJobList();
  showState('state-initial');
}

init();
