// renderer-progress.js —— 由原 renderer.js 第 332–474 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 状态切换 =====
let firstStateShown = false;
function showState(stateId) {
  [stateInitial, stateRunning, stateDone, stateError].forEach((el) => {
    el.classList.remove('active');
  });
  const panel = document.getElementById(stateId);
  panel.classList.add('active');
  // 状态切换后把焦点移入新面板标题（初始加载跳过，避免页面打开即有焦点环）
  if (firstStateShown) {
    const heading = panel.querySelector('.card-title, .result-title');
    if (heading) heading.focus();
  }
  firstStateShown = true;
}

// 按 extractPaused 渲染「暂停/继续」按钮：文案、图标、琥珀色状态一并对齐
function renderPauseButton() {
  btnPauseExtract.innerHTML = extractPaused ? SVG_PLAY + '继续' : SVG_PAUSE + '暂停';
  btnPauseExtract.classList.toggle('btn--paused', extractPaused);
}

// 复位「暂停/继续」按钮（停止时或步骤1 结束/空闲时调用）
function resetPauseButton() {
  extractPaused = false;
  renderPauseButton();
  btnPauseExtract.style.display = 'none';
}

// ===== 重置步骤卡片 =====
function resetSteps() {
  for (let i = 1; i <= 3; i++) {
    const s = stepCards[i];
    s.card.className = 'step-item';
    s.card.dataset.state = 'waiting';
    s.bar.style.width = '0%';
    if (s.bar.setAttribute) s.bar.setAttribute('aria-valuenow', '0');
    if (s.pct) s.pct.textContent = '';
    s.msg.textContent = '';
    s.status.textContent = '等待中';
  }
  // 复位跳过提取按钮（清除可能的加载态并隐藏；默认文案在 index.html，无需重写）
  setLoading(btnSkipExtract, false);
  btnSkipExtract.style.display = 'none';
  // 重置暂停/继续按钮
  resetPauseButton();
  // 重置步骤指示器
  const stepInd = document.getElementById('step-indicator');
  if (stepInd) stepInd.textContent = '等待开始';
}

// ===== 步骤更新处理 =====
function handleProgress(data) {
  const { step, status, progress, message } = data;
  const s = stepCards[step];
  if (!s) return;

  // 步骤2 还没满 N 人、评分没真正开始时（消息带「等待」，进度 0/0），视觉按 waiting 灰显：
  // ② 不点亮不转，和步骤3 一样；等评分真正开始（消息变「x/y 人」）才切 running 蓝色动效。
  // 同一份 effStatus 同时驱动卡片视觉与下方 stepStates 记账，避免两者不一致。
  const waitingForCandidates = status === 'running' && step === 2 && !!message && message.includes('等待');
  const effStatus = waitingForCandidates ? 'waiting' : status;

  s.card.className = 'step-item';
  // effStatus → [卡片 data-state, 状态文字]。表外值（idle/取消/空闲）与 waiting 同款灰显、不留文字
  const STEP_VISUAL = {
    running: ['running', '进行中…'],
    done: ['done', '✓ 已完成'],
    waiting: ['waiting', '等待中'],
  };
  const [cardState, statusText] = STEP_VISUAL[effStatus] || ['waiting', ''];
  s.card.dataset.state = cardState;
  s.status.textContent = statusText;

  if (progress !== null && progress !== undefined) {
    const p = Math.round(Math.min(progress, 100));
    s.bar.style.width = p + '%';
    if (s.bar.setAttribute) s.bar.setAttribute('aria-valuenow', String(p));
    if (s.pct) s.pct.textContent = p + '%';
  }

  if (message) {
    s.msg.textContent = message;
  }

  // 步骤1 运行时显示"跳过提取"与"暂停"按钮
  if (step === 1) {
    const isRunning = status === 'running';
    btnSkipExtract.style.display = isRunning ? '' : 'none';
    if (isRunning) {
      btnPauseExtract.style.display = '';
    } else {
      resetPauseButton(); // 步骤1 结束/空闲时隐藏并复位暂停按钮
    }
  }

  // 记录各步骤状态，供「并行：步骤1 + 步骤2」指示文案判断。
  // effStatus 已把「步骤2 等待候选人」折算成 waiting（不算 running，不触发「并行」）
  stepStates[step] = effStatus;

  // 更新全局进度指示器
  const stepInd = document.getElementById('step-indicator');
  if (stepInd) {
    if (status === 'done') {
      if (step < 3) {
        stepInd.textContent = '等待下一步';
      } else {
        stepInd.textContent = '全部完成';
      }
    } else if (status === 'running') {
      // v1.5.12 并行：只有步骤2 真正开始评分（running）时才显示「并行」；
      // 步骤2 还停在等待（waiting）时仍按进行中的步骤1 显示「步骤 1/3」
      if (stepStates[1] === 'running' && stepStates[2] === 'running') {
        stepInd.textContent = '并行：步骤1 + 步骤2';
      } else if (stepStates[1] === 'running') {
        stepInd.textContent = '步骤 1/3';
      } else if (stepStates[2] === 'running') {
        stepInd.textContent = '步骤 2/3';
      } else {
        stepInd.textContent = '步骤 ' + step + '/3';
      }
    } else if (status === 'idle') {
      stepInd.textContent = '步骤 ' + step + '/3';
    }
  }
}

// 继续提取时，按已有进度复用 handleProgress 初始化步骤1的显示，避免一进来就看到「等待开始」
function initResumeStep(info) {
  if (!info) return;
  if (info.hasCandidates) {
    // 提取已完成，接着从步骤2（AI 评分）继续；handleProgress 的 done 指示器是「等待下一步」，这里覆写成「步骤 2/3」
    handleProgress({ step: 1, status: 'done', progress: 100, message: '候选人信息提取完成' });
    const stepInd = document.getElementById('step-indicator');
    if (stepInd) stepInd.textContent = '步骤 2/3';
  } else {
    // 提取到一半，继续提取剩余（handleProgress 会同步处理跳过按钮与「步骤 1/3」指示器）
    handleProgress({ step: 1, status: 'running', message: info.done > 0 ? `已有 ${info.done} 名候选人，正在继续提取剩余…` : '正在继续提取…' });
  }
}

