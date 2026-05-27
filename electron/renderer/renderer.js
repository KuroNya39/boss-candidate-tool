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
const countInput = document.getElementById('count-input');
const extractAllCheck = document.getElementById('extract-all');
const skipExtract = document.getElementById('skip-extract');
const outputDirSpan = document.getElementById('output-dir');
const doneSummary = document.getElementById('done-summary');
const errorMessage = document.getElementById('error-message');

// API 配置 DOM
const apiUrlInput = document.getElementById('api-url');
const apiKeyInput = document.getElementById('api-key');
const apiModelInput = document.getElementById('api-model');
const btnSaveConfig = document.getElementById('btn-save-config');
const configStatus = document.getElementById('config-status');

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
    await window.electronAPI.setApiConfig(url, key, model);
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

  resetSteps();
  showState('state-running');
  await window.electronAPI.startExtraction({ count, skipExtract: skipExtract.checked, extractAll });
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
  const count = parseInt(countInput.value, 10);
  if (!count || count < 1) {
    showState('state-initial');
    return;
  }

  resetSteps();
  showState('state-running');
  await window.electronAPI.startExtraction(count);
});

// 打开目录
btnOpenDir.addEventListener('click', async () => {
  await window.electronAPI.openOutputDir();
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

  await loadApiConfig();
  setupListeners();
  showState('state-initial');
}

init();
