// 岗位列表从 config/jd-descriptions/ 目录动态加载

// ===== DOM 引用 =====
const stateInitial = document.getElementById('state-initial');
const stateRunning = document.getElementById('state-running');
const stateDone = document.getElementById('state-done');
const stateError = document.getElementById('state-error');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');
const btnRestart = document.getElementById('btn-restart');
const btnRetry = document.getElementById('btn-retry');
const btnOpenDir = document.getElementById('btn-open-dir');
const btnSelectDir = document.getElementById('btn-select-dir');
const countInput = document.getElementById('count-input');
const extractAllCheck = document.getElementById('extract-all');
const outputDirSpan = document.getElementById('output-dir');
const jobSelectSection = document.getElementById('job-select-section');
const jobSelect = document.getElementById('job-select');
const btnAddJob = document.getElementById('btn-add-job');
const jobDialogOverlay = document.getElementById('job-dialog-overlay');
const dialogJobName = document.getElementById('dialog-job-name');
const dialogJobDesc = document.getElementById('dialog-job-desc');
const btnDialogSave = document.getElementById('btn-dialog-save');
const btnDialogCancel = document.getElementById('btn-dialog-cancel');
const sourceRadios = document.querySelectorAll('input[name="source"]');
const doneSummary = document.getElementById('done-summary');
const errorMessage = document.getElementById('error-message');

// API 配置 DOM
const apiUrlInput = document.getElementById('api-url');
const apiKeyInput = document.getElementById('api-key');
const apiModelInput = document.getElementById('api-model');
const btnSaveConfig = document.getElementById('btn-save-config');
const configStatus = document.getElementById('config-status');

// 邮件配置 DOM
const emailPrefixInput = document.getElementById('email-prefix');

// ===== 步骤元素 =====
const stepCards = {
  1: {
    card: document.getElementById('step-1'),
    bar: document.getElementById('step-1-bar'),
    msg: document.getElementById('step-1-msg'),
    status: document.getElementById('step-1-status'),
  },
  2: {
    card: document.getElementById('step-2'),
    bar: document.getElementById('step-2-bar'),
    msg: document.getElementById('step-2-msg'),
    status: document.getElementById('step-2-status'),
  },
  3: {
    card: document.getElementById('step-3'),
    bar: document.getElementById('step-3-bar'),
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
    s.card.className = 'step-card';
    s.bar.style.width = '0%';
    s.msg.textContent = '';
    s.status.textContent = '等待中';
  }
}

// ===== 步骤更新处理 =====
function handleProgress(data) {
  const { step, status, progress, message } = data;
  const s = stepCards[step];
  if (!s) return;

  s.card.className = 'step-card';
  if (status === 'running') {
    s.card.classList.add('active');
    s.status.textContent = '进行中...';
  } else if (status === 'done') {
    s.card.classList.add('done');
    s.status.textContent = '✓ 已完成';
  } else if (status === 'idle') {
    s.status.textContent = '';
  }

  if (progress !== null && progress !== undefined) {
    s.bar.style.width = Math.min(progress, 100) + '%';
  }

  if (message) {
    s.msg.textContent = message;
  }
}

// ===== IPC 监听注册 =====
function setupListeners() {
  cleanupAll();
  registerCleanup(window.electronAPI.onProgress(handleProgress));

  registerCleanup(
    window.electronAPI.onDone((data) => {
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
    })
  );

  registerCleanup(
    window.electronAPI.onError((data) => {
      showState('state-error');
      errorMessage.textContent = data.message || '未知错误';
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
  const sourceRadios = document.querySelectorAll('input[name="source"]');
  const selectedSource = Array.from(sourceRadios).find(r => r.checked)?.value || 'chat';

  resetSteps();
  showState('state-running');
  await window.electronAPI.startExtraction({ count, extractAll, source: selectedSource, job: jobSelect.value });
});

// 取消
btnCancel.addEventListener('click', async () => {
  await window.electronAPI.cancelExtraction();
  resetSteps();
  showState('state-initial');
});

// 重新开始（完成状态）
btnRestart.addEventListener('click', () => {
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
  const sourceRadios = document.querySelectorAll('input[name="source"]');
  const selectedSource = Array.from(sourceRadios).find(r => r.checked)?.value || 'chat';

  resetSteps();
  showState('state-running');
  await window.electronAPI.startExtraction({ count, extractAll, source: selectedSource, job: jobSelect.value });
});

// 打开目录
btnOpenDir.addEventListener('click', async () => {
  await window.electronAPI.openOutputDir();
});

// 选择输出目录
btnSelectDir.addEventListener('click', async () => {
  const result = await window.electronAPI.selectOutputDir();
  if (result?.path) {
    outputDirSpan.textContent = result.path;
  }
});

// 填充岗位下拉框（从 config 目录动态加载）
async function populateJobSelect() {
  try {
    const jobs = await window.electronAPI.getRecommendJobs();
    // 清空现有选项（保留默认占位）
    jobSelect.innerHTML = '';
    const defaultOpt = document.createElement('option');
    defaultOpt.value = '';
    defaultOpt.textContent = '-- 请选择岗位 --';
    jobSelect.appendChild(defaultOpt);
    jobs.forEach(job => {
      const opt = document.createElement('option');
      opt.value = job;
      opt.textContent = job;
      jobSelect.appendChild(opt);
    });
  } catch (err) {
    console.error('加载岗位列表失败:', err);
  }
}

// 来源切换：显示/隐藏岗位选择
sourceRadios.forEach(radio => {
  radio.addEventListener('change', () => {
    jobSelectSection.style.display = radio.value === 'recommend' ? 'flex' : 'none';
  });
});

// 添加新岗位弹窗
function showAddJobDialog() {
  dialogJobName.value = '';
  dialogJobDesc.value = '';
  jobDialogOverlay.style.display = 'flex';
  dialogJobName.focus();
}

function hideAddJobDialog() {
  jobDialogOverlay.style.display = 'none';
}

btnAddJob.addEventListener('click', showAddJobDialog);
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
    await window.electronAPI.addRecommendJob(jobName, jobDesc);
    await populateJobSelect();
    jobSelect.value = jobName;
    hideAddJobDialog();
  } catch (err) {
    alert('添加失败: ' + err.message);
  }
});

// 提取全部 切换时禁用/启用数量输入
extractAllCheck.addEventListener('change', () => {
  countInput.disabled = extractAllCheck.checked;
  if (extractAllCheck.checked) countInput.value = '';
});

// 初始状态：默认提取全部，数量输入禁用
countInput.disabled = true;

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
  setupListeners();
  await populateJobSelect();
  showState('state-initial');
}

init();
