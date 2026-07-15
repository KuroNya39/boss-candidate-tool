// 岗位列表从 config/jd-descriptions/ 目录动态加载

// ===== DOM 引用 =====
const stateInitial = document.getElementById('state-initial');
const stateRunning = document.getElementById('state-running');
const stateDone = document.getElementById('state-done');
const stateError = document.getElementById('state-error');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');
const btnSkipExtract = document.getElementById('btn-skip-extract');
const btnRestart = document.getElementById('btn-restart');
const btnRetry = document.getElementById('btn-retry');
const btnOpenDir = document.getElementById('btn-open-dir');
const btnSelectDir = document.getElementById('btn-select-dir');
const btnClearHistory = document.getElementById('btn-clear-history');
const countInput = document.getElementById('count-input');
const extractAllCheck = document.getElementById('extract-all');
const extractAllSection = document.getElementById('extract-all-section');
const outputDirSpan = document.getElementById('output-dir');
const jobSelectSection = document.getElementById('job-select-section');
const jobDisplay = document.getElementById('job-display');
const jobPickerOverlay = document.getElementById('job-picker-overlay');
const jobPickerList = document.getElementById('job-picker-list');
const btnPickerCancel = document.getElementById('btn-picker-cancel');
const jobDialogOverlay = document.getElementById('job-dialog-overlay');
const dialogJobName = document.getElementById('dialog-job-name');
const dialogJobDesc = document.getElementById('dialog-job-desc');
const dialogJobHint = document.getElementById('dialog-job-hint');
const btnDialogSave = document.getElementById('btn-dialog-save');
const btnDialogCancel = document.getElementById('btn-dialog-cancel');
const recommendHint = document.getElementById('recommend-hint');
const chatHint = document.getElementById('chat-hint');
const doneSummary = document.getElementById('done-summary');
const errorMessage = document.getElementById('error-message');

// 岗位选择状态
let selectedJob = '';
let jobList = [];
let selectedSource = 'chat'; // 当前选中的提取来源

// 编辑岗位模式（非空时表示正在编辑已有岗位）
let editJobName = '';

// API 配置 DOM
const apiUrlInput = document.getElementById('api-url');
const apiKeyInput = document.getElementById('api-key');
const apiModelInput = document.getElementById('api-model');
const btnSaveConfig = document.getElementById('btn-save-config');
const configStatus = document.getElementById('config-status');
const apiConfigToggle = document.getElementById('api-config-toggle');
const apiConfigBody = document.getElementById('api-config-body');
const apiConfigArrow = document.getElementById('api-config-arrow');

// 邮件配置 DOM
const emailPrefixInput = document.getElementById('email-prefix');

// 批量打招呼 DOM
const greetSection = document.getElementById('greet-section');
const greetLevel = document.getElementById('greet-level');
const greetCount = document.getElementById('greet-count');
const btnStartGreet = document.getElementById('btn-start-greet');
const btnCancelGreet = document.getElementById('btn-cancel-greet');
const greetProgress = document.getElementById('greet-progress');
const greetProgressBar = document.getElementById('greet-progress-bar');
const greetProgressText = document.getElementById('greet-progress-text');
const greetResult = document.getElementById('greet-result');

// 自动打招呼 DOM
const autoGreetCheck = document.getElementById('auto-greet-check');
const autoGreetControls = document.getElementById('auto-greet-controls');
const autoGreetLevel = document.getElementById('auto-greet-level');
let autoGreetEnabled = false; // 本次分析是否自动打招呼

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

// ===== 输入框清除按钮 =====
function setupInputClears() {
  document.addEventListener('input', (e) => {
    const wrap = e.target.closest('.input-wrap');
    if (!wrap) return;
    const clear = wrap.querySelector('.input-clear');
    if (clear) {
      clear.classList.toggle('visible', e.target.value.length > 0);
    }
  });
  document.addEventListener('click', (e) => {
    const clear = e.target.closest('.input-clear');
    if (!clear) return;
    const targetId = clear.getAttribute('data-target');
    if (targetId) {
      const input = document.getElementById(targetId);
      if (input) {
        input.value = '';
        clear.classList.remove('visible');
        input.focus();
        // 触发 input 事件，让其他监听器感知变化
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
  });
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

// ===== 状态切换 =====
function showState(stateId) {
  [stateInitial, stateRunning, stateDone, stateError].forEach((el) => {
    el.classList.remove('active');
  });
  document.getElementById(stateId).classList.add('active');
}

// ===== 重置步骤卡片 =====
function resetSteps() {
  for (let i = 1; i <= 3; i++) {
    const s = stepCards[i];
    s.card.className = 'step-item waiting';
    s.bar.style.width = '0%';
    if (s.pct) s.pct.textContent = '';
    s.msg.textContent = '';
    s.status.textContent = '等待中';
  }
  // 重置跳过提取按钮
  btnSkipExtract.style.display = 'none';
  btnSkipExtract.disabled = false;
  btnSkipExtract.textContent = '⏭ 跳过提取简历';
}

// ===== 步骤更新处理 =====
function handleProgress(data) {
  const { step, status, progress, message } = data;
  const s = stepCards[step];
  if (!s) return;

  s.card.className = 'step-item';
  if (status === 'running') {
    s.card.classList.add('active');
    s.status.textContent = '进行中...';
  } else if (status === 'done') {
    s.card.classList.add('done');
    s.status.textContent = '✓ 已完成';
  } else if (status === 'idle') {
    s.card.classList.add('waiting');
    s.status.textContent = '';
  }

  if (progress !== null && progress !== undefined) {
    s.bar.style.width = Math.min(progress, 100) + '%';
    if (s.pct) s.pct.textContent = Math.round(progress) + '%';
  }

  if (message) {
    s.msg.textContent = message;
  }

  // 步骤1 运行时显示"跳过提取"按钮
  if (step === 1) {
    btnSkipExtract.style.display = status === 'running' ? '' : 'none';
  }
}

// ===== IPC 监听注册 =====
function setupListeners() {
  cleanupAll();
  registerCleanup(window.electronAPI.onProgress(handleProgress));

  registerCleanup(
    window.electronAPI.onDone(async (data) => {
      showState('state-done');
      let summary = '';
      if (data.excelPath) {
        const filename = data.excelPath.split(/[/\\]/).pop();
        summary += `导出文件: ${filename}\n`;
      }
      if (data.emailTo) {
        summary += `邮件已发送至: ${data.emailTo}\n`;
      }
      summary += `输出目录: ${data.outputDir}`;
      doneSummary.textContent = summary;

      // 检查评分数据，显示批量打招呼（沟通页不做打招呼）
      resetGreetUI();
      if (selectedSource !== 'chat') {
        try {
          const counts = await window.electronAPI.getGreetCandidateCounts();
          if (counts.available) {
            greetSection.style.display = '';
            updateGreetCount(counts);

            // 自动打招呼
            if (autoGreetEnabled) {
              const level = parseInt(autoGreetLevel.value, 10);
              greetLevel.value = String(level);
              updateGreetCount(counts);
              // 延迟片刻让 UI 渲染完成，再自动开始
              setTimeout(async () => {
                btnStartGreet.style.display = 'none';
                btnCancelGreet.style.display = 'none';
                greetResult.style.display = 'none';
                greetProgress.style.display = '';
                greetProgressBar.style.width = '0%';
                greetProgressText.textContent = '自动打招呼中...';
                await window.electronAPI.startGreeting(level);
                autoGreetEnabled = false;
              }, 500);
            }
          }
        } catch {}
      }
    })
  );

  registerCleanup(
    window.electronAPI.onError((data) => {
      showState('state-error');
      errorMessage.textContent = data.message || '未知错误';
    })
  );

  // 打招呼事件
  registerCleanup(
    window.electronAPI.onGreetProgress((data) => {
      // Fix: show "正在打招呼" instead of per-candidate status messages
      greetProgressText.textContent = '正在打招呼中...';
    })
  );

  registerCleanup(
    window.electronAPI.onGreetDone((data) => {
      greetProgress.style.display = 'none';
      btnCancelGreet.style.display = 'none';
      btnStartGreet.style.display = '';
      greetResult.style.display = '';
      greetResult.textContent =
        `✅ 成功打招呼 ${data.success} 人` +
        (data.already > 0 ? `，${data.already} 人已打过招呼` : '') +
        (data.notFound > 0 ? `，${data.notFound} 人不在当前列表中` : '') +
        (data.skipped > 0 ? `，${data.skipped} 人跳过` : '');
      autoGreetEnabled = false;
    })
  );

  registerCleanup(
    window.electronAPI.onGreetError((data) => {
      greetProgress.style.display = 'none';
      btnCancelGreet.style.display = 'none';
      btnStartGreet.style.display = '';
      greetResult.style.display = '';
      greetResult.className = 'greet-result greet-result-error';
      greetResult.textContent = '❌ 打招呼失败: ' + data.message;
      autoGreetEnabled = false;
    })
  );
}

// ===== API 配置 =====
async function loadApiConfig() {
  try {
    const config = await window.electronAPI.getApiConfig();
    if (config.url) apiUrlInput.value = config.url;
    if (config.key) apiKeyInput.value = config.key;
    if (config.model) apiModelInput.value = config.model;
    if (config.emailPrefix) emailPrefixInput.value = config.emailPrefix;
  } catch {}
  updateConfigStatus();
}

async function updateConfigStatus() {
  try {
    const status = await window.electronAPI.getApiConfigStatus();
    if (status.configured) {
      configStatus.textContent = '✓ 已配置';
      configStatus.className = 'config-status config-ok';
      btnStart.disabled = false;
      btnStart.style.opacity = '1';
    } else {
      configStatus.textContent = '未配置';
      configStatus.className = 'config-status config-missing';
      btnStart.disabled = true;
      btnStart.style.opacity = '0.5';
    }
  } catch {
    configStatus.textContent = '未配置';
    configStatus.className = 'config-status config-missing';
    btnStart.disabled = true;
    btnStart.style.opacity = '0.5';
  }
}

btnSaveConfig.addEventListener('click', async () => {
  const url = apiUrlInput.value.trim();
  const key = apiKeyInput.value.trim();
  const model = apiModelInput.value.trim();

  if (!url || !key || !model) {
    configStatus.textContent = '请填写完整配置';
    configStatus.className = 'config-status config-error';
    return;
  }

  try {
    // 简单校验 URL 格式
    new URL(url);
  } catch {
    configStatus.textContent = 'API 地址格式不正确';
    configStatus.className = 'config-status config-error';
    return;
  }

  try {
    await window.electronAPI.setApiConfig({
      url, key, model,
      emailPrefix: emailPrefixInput.value.trim(),
    });
    configStatus.textContent = '✓ 已保存';
    configStatus.className = 'config-status config-ok';
    updateConfigStatus();
  } catch (err) {
    configStatus.textContent = '保存失败: ' + err.message;
    configStatus.className = 'config-status config-error';
  }
});

// Collapsible API Config
apiConfigToggle.addEventListener('click', () => {
  const isHidden = apiConfigBody.style.display === 'none';
  apiConfigBody.style.display = isHidden ? 'flex' : 'none';
  apiConfigArrow.classList.toggle('expanded', isHidden);
});

// ===== 按钮事件 =====

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

  resetSteps();
  showState('state-running');
  autoGreetEnabled = autoGreetCheck.checked;
  const greetLevel2 = parseInt(autoGreetLevel.value, 10);
  await window.electronAPI.startExtraction({ count, extractAll, source: selectedSource, job: selectedJob, autoGreet: autoGreetEnabled, greetLevel: greetLevel2 });
});

// 取消
btnCancel.addEventListener('click', async () => {
  await window.electronAPI.cancelExtraction();
  resetSteps();
  syncAutoGreetUI();
  showState('state-initial');
});

// 跳过提取，直接评分
btnSkipExtract.addEventListener('click', async () => {
  if (!confirm('确定跳过剩余简历提取，用已提取的数据直接开始 AI 评分吗？')) return;
  btnSkipExtract.disabled = true;
  btnSkipExtract.textContent = '⏭ 正在跳过...';
  const msgEl = stepCards[1].msg;
  if (msgEl) msgEl.textContent = '正在停止提取，恢复已提取数据...';
  await window.electronAPI.skipExtraction();
});

// 重新开始（完成状态）
btnRestart.addEventListener('click', () => {
  resetSteps();
  autoGreetEnabled = false;
  syncAutoGreetUI();
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
  await window.electronAPI.startExtraction({ count, extractAll, source: selectedSource, job: selectedJob });
});

// 打开目录
btnOpenDir.addEventListener('click', async () => {
  await window.electronAPI.openOutputDir();
});

// Chrome 重连
document.getElementById('btn-retry-chrome').addEventListener('click', async () => {
  const btn = document.getElementById('btn-retry-chrome');
  btn.textContent = '重连中...';
  btn.disabled = true;
  await window.electronAPI.retryCdpConnection();
  await updateCdpStatus();
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

// 清空历史归档数据
btnClearHistory.addEventListener('click', async () => {
  if (!confirm('确定要删除所有历史归档数据吗？\n\n此操作将删除输出目录下所有 output-YYYYMMDD-HHMM 格式的历史文件夹，不可恢复。')) {
    return;
  }
  btnClearHistory.disabled = true;
  btnClearHistory.textContent = '清理中...';
  try {
    const result = await window.electronAPI.clearHistory();
    if (result.error) {
      alert('清理失败：' + result.error);
    } else {
      let msg = '';
      if (result.deleted > 0) {
        msg += `已删除 ${result.deleted} 个历史文件夹。\n`;
      }
      if (result.errors > 0) {
        msg += `${result.errors} 个删除失败（请查看终端日志）。\n`;
      }
      if (result.deleted === 0 && result.errors === 0) {
        msg = '没有找到历史归档数据。';
      }
      if (result.matchedDirs?.length) {
        msg += `\n匹配到的历史文件夹:\n${result.matchedDirs.join('\n')}`;
      }
      alert(msg.trim());
    }
  } catch (err) {
    alert('清理失败：' + err.message);
  } finally {
    btnClearHistory.disabled = false;
    btnClearHistory.textContent = '清空历史数据';
  }
});

// 岗位显示更新
function updateJobDisplay() {
  if (selectedJob) {
    jobDisplay.textContent = selectedJob;
    jobDisplay.className = 'job-display';
  } else {
    jobDisplay.textContent = '请选择岗位';
    jobDisplay.className = 'job-display placeholder';
  }
}

// 加载岗位列表
async function loadJobList() {
  try {
    jobList = await window.electronAPI.getRecommendJobs();
    // 如果已选岗位不在新列表中，清空选中
    if (selectedJob && !jobList.includes(selectedJob)) {
      selectedJob = '';
    }
    updateJobDisplay();
    renderJobPicker();
  } catch (err) {
    console.error('加载岗位列表失败:', err);
  }
}

// 渲染目标岗位弹窗列表
function renderJobPicker() {
  jobPickerList.innerHTML = '';

  // 顶部：添加新岗位
  const addItem = document.createElement('div');
  addItem.className = 'job-picker-item job-picker-add';
  const addName = document.createElement('span');
  addName.className = 'job-picker-item-name';
  addName.textContent = '+ 添加新岗位';
  addName.style.color = '#4CAF50';
  addName.style.fontWeight = '600';
  addItem.appendChild(addName);
  addItem.addEventListener('click', () => {
    hideJobPicker();
    setTimeout(showAddJobDialog, 150);
  });
  jobPickerList.appendChild(addItem);

  // 岗位列表
  if (jobList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item';
    empty.textContent = '暂无岗位';
    empty.style.color = '#999';
    empty.style.cursor = 'default';
    empty.style.justifyContent = 'center';
    jobPickerList.appendChild(empty);
    return;
  }
  jobList.forEach(job => {
    const item = document.createElement('div');
    item.className = 'job-picker-item';
    if (job === selectedJob) item.classList.add('selected');

    // 岗位名称（可点击切换）
    const nameSpan = document.createElement('span');
    nameSpan.className = 'job-picker-item-name';
    nameSpan.textContent = job;
    nameSpan.addEventListener('click', () => {
      selectedJob = job;
      updateJobDisplay();
      hideJobPicker();
    });
    item.appendChild(nameSpan);

    // 操作按钮组
    const actions = document.createElement('span');
    actions.className = 'job-picker-item-actions';

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn-picker-edit';
    btnEdit.textContent = '编辑';
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      showEditJobDialog(job);
    });
    actions.appendChild(btnEdit);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn-picker-delete';
    btnDelete.textContent = '删除';
    btnDelete.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteJob(job);
    });
    actions.appendChild(btnDelete);

    item.appendChild(actions);
    jobPickerList.appendChild(item);
  });
}

// 显示/隐藏目标岗位弹窗
function showJobPicker() {
  renderJobPicker();
  jobPickerOverlay.style.display = 'flex';
}

function hideJobPicker() {
  jobPickerOverlay.style.display = 'none';
}

// 目标岗位弹窗事件
jobDisplay.addEventListener('click', showJobPicker);
btnPickerCancel.addEventListener('click', hideJobPicker);
jobPickerOverlay.addEventListener('click', (e) => {
  if (e.target === jobPickerOverlay) hideJobPicker();
});
// Source toggle (card-style buttons)
document.querySelectorAll('.toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const source = btn.dataset.source;
    selectedSource = source;
    const isAttach = source === 'recommend-attach';
    const isChat = source === 'chat';
    jobSelectSection.style.display = isAttach ? 'flex' : 'none';
    recommendHint.style.display = isAttach ? '' : 'none';
    chatHint.style.display = isChat ? '' : 'none';
    extractAllSection.style.display = isChat ? '' : 'none';
    if (!isChat && extractAllCheck.checked) {
      extractAllCheck.checked = false;
      countInput.disabled = false;
    }
    if (isAttach) updateJobDisplay();
  });
});

// 添加/编辑岗位弹窗
function showAddJobDialog() {
  editJobName = '';
  dialogJobName.value = '';
  dialogJobName.readOnly = false;
  dialogJobName.style.background = '';
  dialogJobDesc.value = '';
  dialogJobHint.style.display = '';
  document.querySelector('#job-dialog-overlay .dialog-title').textContent = '添加新岗位';
  jobDialogOverlay.style.display = 'flex';
  dialogJobName.focus();
}

async function showEditJobDialog(jobName) {
  editJobName = jobName;
  dialogJobName.value = jobName;
  dialogJobName.readOnly = true;
  dialogJobName.style.background = '#f5f5f5';
  dialogJobHint.style.display = 'none';
  document.querySelector('#job-dialog-overlay .dialog-title').textContent = '编辑岗位描述';
  try {
    const desc = await window.electronAPI.getRecommendJobDesc(jobName);
    dialogJobDesc.value = desc || '';
  } catch {
    dialogJobDesc.value = '';
  }
  jobDialogOverlay.style.display = 'flex';
  dialogJobDesc.focus();
}

function hideAddJobDialog() {
  jobDialogOverlay.style.display = 'none';
  editJobName = '';
}

// 删除岗位
async function deleteJob(jobName) {
  if (!confirm(`确定要删除岗位「${jobName}」吗？`)) return;
  try {
    await window.electronAPI.deleteRecommendJob(jobName);
    if (selectedJob === jobName) selectedJob = '';
    await loadJobList();
  } catch (err) {
    alert('删除失败: ' + err.message);
  }
}

btnDialogCancel.addEventListener('click', hideAddJobDialog);
jobDialogOverlay.addEventListener('click', (e) => {
  if (e.target === jobDialogOverlay) hideAddJobDialog();
});

dialogJobName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') dialogJobDesc.focus();
  if (e.key === 'Escape') hideAddJobDialog();
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
    alert((editJobName ? '编辑' : '添加') + '失败: ' + err.message);
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
  greetProgressText.textContent = '正在打招呼中...';
  await window.electronAPI.startGreeting(level);
});

// 取消打招呼
btnCancelGreet.addEventListener('click', async () => {
  await window.electronAPI.cancelGreeting();
  greetProgressText.textContent = '已取消';
  btnCancelGreet.style.display = 'none';
  btnStartGreet.style.display = '';
});

// ===== CDP/Chrome 状态 =====
async function updateCdpStatus() {
  try {
    const status = await window.electronAPI.getCdpStatus();
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
      text.textContent = status.message || '正在准备...';
    } else if (status.state === 'error') {
      dot.classList.add('dot-red');
      text.textContent = status.message || 'Chrome 连接失败';
      retryBtn.style.display = '';
    }
  } catch {}
}

// ===== 批量打招呼辅助函数 =====
function updateGreetCount(counts) {
  const level = parseInt(greetLevel.value, 10);
  const n = counts.counts[level] || 0;
  greetCount.textContent = `（可打招呼 ${n} 人）`;
  btnStartGreet.disabled = n === 0;
  btnStartGreet.style.opacity = n === 0 ? '0.5' : '1';
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
  btnStartGreet.style.opacity = '1';
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

  setupInputClears();
  await loadApiConfig();
  await updateCdpStatus();
  // 轮询 CDP 状态（未连接时持续刷新，用户勾选 Chrome 远程调试后自动变绿）
  setInterval(async () => {
    try {
      const s = await window.electronAPI.getCdpStatus();
      await updateCdpStatus();
      // 如果是 error 状态且内容是 Chrome 未开远程调试，自动重试检测
      if (s.state === 'error' && s.message.includes('chrome://inspect')) {
        await window.electronAPI.retryCdpConnection();
        await updateCdpStatus();
      }
    } catch {}
  }, 3000);
  setupListeners();
  // Set default source from active toggle
  const activeToggle = document.querySelector('.toggle-btn.active');
  if (activeToggle) {
    selectedSource = activeToggle.dataset.source;
    const isAttach = selectedSource === 'recommend-attach';
    const isChat = selectedSource === 'chat';
    jobSelectSection.style.display = isAttach ? 'flex' : 'none';
    recommendHint.style.display = isAttach ? '' : 'none';
    chatHint.style.display = isChat ? '' : 'none';
    extractAllSection.style.display = isChat ? '' : 'none';
    if (!isChat && extractAllCheck.checked) {
      extractAllCheck.checked = false;
      countInput.disabled = false;
    }
  }
  await loadJobList();
  showState('state-initial');
}

init();
