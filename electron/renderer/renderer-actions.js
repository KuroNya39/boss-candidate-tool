// renderer-actions.js —— 由原 renderer.js 第 817–1008 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// ===== 按钮事件 =====

// 启动提取管道。主进程若已有任务运行中会返回 { error }，此时回到初始态并提示，
// 避免用户误以为已开始运行而卡在运行态（连点「开始」或取消后未完全收尾时触发）。
async function startPipeline(opts) {
  const res = await window.electronAPI.startExtraction(opts);
  if (res?.error) {
    showToast(res.error, 'warning', 4000);
    showState('state-initial');
    return false;
  }
  return true;
}

// 开始
btnStart.addEventListener('click', async () => {
  const extractAll = extractAllCheck.checked;
  const count = extractAll ? 0 : parseInt(countInput.value, 10);
  if (!extractAll && (!count || count < 1)) {
    countInput.focus();
    return;
  }

  // 获取选中的来源
  const activeToggle = document.querySelector('.toggle-btn.active');
  selectedSource = activeToggle ? activeToggle.dataset.source : 'chat';

  // 开始前的 Chrome 预检：没运行则自动启动 Chrome（连不上时由下方「Chrome 未连接」提示）；
  // 没装 Chrome 则提示。曾经的「边用边跑」模式已移除，Chrome 在跑就直接用当前窗口继续，不再询问重启。
  try {
    const st = await window.electronAPI.ensureChromeOpen();
    if (st && !st.ok) {
      await confirmDialog({
        title: '未找到 Chrome',
        message: st.message || '没有在常见位置找到 Chrome。请照常打开 Chrome，按 README 第 1 步开启远程调试后使用。',
        okText: '知道了',
        showCancel: false,
      });
      return;
    }
    if (st && st.launched) {
      // 软件刚自动拉起 Chrome，先触发一次重连；连不上就交给下方统一的
      // 「Chrome 未连接」提示（请检查连接状态、允许远程调试），不再单独弹「Chrome 已启动」。
      await window.electronAPI.retryCdpConnection();
    }

    // CDP 未连接（黄点连接中 / 红点出错）时先弹窗提醒，避免直接进运行页干等后才报错
    const cdp = await updateCdpStatus();
    if (cdp && cdp.state !== 'connected') {
      await confirmDialog({
        title: 'Chrome 未连接',
        message: '请检查软件连接状态，允许 Chrome 远程调试。',
        okText: '知道了',
        showCancel: false,
      });
      return;
    }
  } catch (e) {
    // 预检失败不阻塞，继续（Chrome 若真没开，主进程启动流程里也会兜底自动拉起）
  }

  // 目标岗位检查放在 Chrome 连接确认之后：先弹连接问题，连接正常再查岗位。
  // 推荐牛人页 / 搜索页必须先选岗位，AI 才知道按什么岗位要求评分。
  const sourceNeedsJob = selectedSource === 'recommend-attach' || selectedSource === 'search';
  if (sourceNeedsJob && !selectedJob) {
    const goPick = await confirmDialog({
      title: '请选择目标岗位',
      message: '选择已有岗位，或点击「+ 添加新岗位」新建岗位。',
      okText: '去选择岗位',
      cancelText: '取消',
    });
    if (goPick) showJobPicker();
    return;
  }

  resetSteps();
  showState('state-running');
  autoGreetEnabled = autoGreetCheck.checked;
  const greetLevel2 = parseInt(autoGreetLevel.value, 10);
  await startPipeline({ count, extractAll, source: selectedSource, job: selectedJob, autoGreet: autoGreetEnabled, greetLevel: greetLevel2, enableCopy: enableCopyCheck.checked });
});

// 取消
btnCancel.addEventListener('click', async () => {
  await window.electronAPI.cancelExtraction();
  resetSteps();
  syncAutoGreetUI();
  showState('state-initial');
  showToast('已保存进度，可在「历史记录」里继续提取', 'info', 5000);
});

// 跳过提取，直接评分
btnSkipExtract.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '跳过剩余提取？',
    message: '确定跳过剩余候选人提取，用已提取的数据直接开始 AI 评分吗？',
    okText: '跳过并评分',
  });
  if (!ok) return;
  setLoading(btnSkipExtract, true);
  btnSkipExtract.disabled = true;
  btnSkipExtract.innerHTML = SVG_SKIP + '正在跳过提取…';
  const msgEl = stepCards[1].msg;
  if (msgEl) msgEl.textContent = '正在停止提取，恢复已提取数据…';
  await window.electronAPI.skipExtraction();
});

// 暂停/继续 步骤1 提取
btnPauseExtract.addEventListener('click', async () => {
  if (extractPaused) {
    // 当前已暂停 → 点「继续」恢复提取
    const res = await window.electronAPI.resumeCurrentExtraction();
    if (!res?.ok) {
      showToast('提取进程已结束或不在提取中，无法继续', 'warning', 3000);
      return;
    }
    extractPaused = false;
    renderPauseButton();
    const msgEl = stepCards[1].msg;
    if (msgEl) msgEl.textContent = '提取中…';
    return;
  }
  // 当前在提取 → 点「暂停」
  const res = await window.electronAPI.pauseExtraction();
  if (!res?.ok) {
    showToast('当前没有可暂停的提取任务', 'warning', 3000);
    return;
  }
  extractPaused = true;
  renderPauseButton();
  const msgEl = stepCards[1].msg;
  if (msgEl) msgEl.textContent = '已暂停，点击「继续」恢复提取…';
});

// 重新开始（完成状态）
btnRestart.addEventListener('click', () => {
  resetSteps();
  autoGreetEnabled = false;
  syncAutoGreetUI();
  showState('state-initial');
});

// 返回主界面（错误状态）：不重试，回到初始页调整来源/岗位/设置后再开始
btnErrorBack.addEventListener('click', () => {
  resetSteps();
  showState('state-initial');
});

// 重试（错误状态）
btnRetry.addEventListener('click', async () => {
  const extractAll = extractAllCheck.checked;
  const count = extractAll ? 0 : parseInt(countInput.value, 10);
  if (!extractAll && (!count || count < 1)) {
    showState('state-initial');
    return;
  }

  // 获取选中的来源
  const activeToggle = document.querySelector('.toggle-btn.active');
  selectedSource = activeToggle ? activeToggle.dataset.source : 'chat';

  resetSteps();
  showState('state-running');
  await startPipeline({ count, extractAll, source: selectedSource, job: selectedJob, enableCopy: enableCopyCheck.checked });
});

// 打开目录
btnOpenDir.addEventListener('click', async () => {
  await window.electronAPI.openOutputDir();
});

// Chrome 重连
document.getElementById('btn-retry-chrome').addEventListener('click', async () => {
  const btn = document.getElementById('btn-retry-chrome');
  setLoading(btn, true);
  btn.textContent = '重试中…';
  btn.disabled = true;
  await window.electronAPI.retryCdpConnection();
  await updateCdpStatus();
  setLoading(btn, false);
  btn.textContent = '重试';
  btn.disabled = false;
});

// 选择输出目录
btnSelectDir.addEventListener('click', async () => {
  const result = await window.electronAPI.selectOutputDir();
  if (result?.path) {
    outputDirSpan.textContent = result.path;
  }
});

