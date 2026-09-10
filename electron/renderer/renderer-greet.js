// renderer-greet.js —— 由原 renderer.js 第 1620–1786 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 批量打招呼 =====
// 打招呼只在推荐牛人页的名单上点按钮，来源统一归 recommend——判定函数 greetSource()
// 定义在 renderer-dom.js（最先加载的共享文件），这里直接用，别重复定义

// 等级选择变化时更新人数。手动换等级 = 想按新档整批打，放弃当前「重试」名单
greetLevel.addEventListener('change', async () => {
  clearGreetRetry();
  try {
    const counts = await window.electronAPI.getGreetCandidateCounts();
    if (counts.available) updateGreetCount(counts);
  } catch {}
});

// 开始打招呼。greetRetry 非空 = 主按钮当前是「重试」：只补上次失败名单里的人，
// 档位沿用失败那轮（重试脚本只看名单，不再按等级过滤）；否则普通整批。
// 启动前把本轮档位记进 lastGreetRun（只记 level，source 用现算的 greetSource()），
// 跑完有失败时界面据此把按钮变「重试」
btnStartGreet.addEventListener('click', async () => {
  const isRetry = !!greetRetry;
  const level = isRetry ? greetRetry.level : parseInt(greetLevel.value, 10);
  const source = greetSource();
  lastGreetRun = { level }; // 只记档位；source 重试时由 greetSource() 现算，无需存档（见 renderer-dom.js 状态注释）
  btnStartGreet.style.display = 'none';
  btnCancelGreet.style.display = '';
  greetResult.style.display = 'none';
  greetProgress.style.display = '';
  greetProgressBar.style.width = '0%';
  if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', '0');
  greetProgressText.textContent = isRetry ? '正在重试失败的人…' : '正在打招呼…';
  const res = await window.electronAPI.startGreeting({ level, source, retry: isRetry });
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
    const retryBtn = btnRetryChrome; // 顶栏重连按钮句柄已在 renderer-dom.js 统一提升

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
// 统一主按钮：有可重试失败（greetRetry 非空）→ 文字「重试」且可用（不带人数，用户口径）；
// 否则「开始打招呼」，按该档可打人数决定禁用
function updateGreetButton() {
  if (greetRetry) {
    btnStartGreet.textContent = '重试';
    btnStartGreet.disabled = false;
  } else {
    btnStartGreet.textContent = '开始打招呼';
    btnStartGreet.disabled = greetTargetCount === 0;
  }
}

function updateGreetCount(counts) {
  const level = parseInt(greetLevel.value, 10);
  greetTargetCount = counts.counts[level] || 0;
  greetCount.textContent = `可打招呼 ${greetTargetCount} 人`;
  updateGreetButton();
}

// 清掉「重试」态（换等级 / 回首页 / 新一批 / 出错时调用），按钮回「开始打招呼」
function clearGreetRetry() {
  greetRetry = null;
  updateGreetButton();
}

function resetGreetUI() {
  greetSection.style.display = 'none';
  greetProgress.style.display = 'none';
  greetResult.style.display = 'none';
  greetResult.className = 'greet-result';
  greetResult.textContent = '';
  greetCount.textContent = '';
  greetRetry = null; // 新一批/回首页：作废旧的重试名单
  lastGreetRun = null;
  btnStartGreet.style.display = '';
  btnCancelGreet.style.display = 'none';
  updateGreetButton(); // 文字回「开始打招呼」（默认文案在 index.html，状态切换时由 JS 写回）
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
  // 按当前选中的来源铺一遍界面（HTML 里默认选中的是「推荐牛人页」）。
  // 这段原本与 renderer-dialogs.js 的点击切换逐行重复，现统一走 selectSource()——
  // 本文件在 dialogs 之后加载，运行时函数已存在
  const activeToggle = document.querySelector('.toggle-btn.active');
  if (activeToggle) selectSource(activeToggle.dataset.source, activeToggle);
  await loadJobList();
  showState('state-initial');
}

init();
