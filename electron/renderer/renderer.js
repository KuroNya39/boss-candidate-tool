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
const jobSearchInput = document.getElementById('job-search-input');
const btnPickerCancel = document.getElementById('btn-picker-cancel');
const jobDialogOverlay = document.getElementById('job-dialog-overlay');
const dialogJobName = document.getElementById('dialog-job-name');
const dialogJobDesc = document.getElementById('dialog-job-desc');
const dialogJobHint = document.getElementById('dialog-job-hint');
const btnDialogSave = document.getElementById('btn-dialog-save');
const btnDialogCancel = document.getElementById('btn-dialog-cancel');
const recommendHint = document.getElementById('recommend-hint');
const searchHint = document.getElementById('search-hint');
const chatHint = document.getElementById('chat-hint');
const doneSummary = document.getElementById('done-summary');
const errorMessage = document.getElementById('error-message');

// 把邮件服务器返回的英文报错翻译成大白话，方便非技术用户看懂下一步该做什么
function explainMailError(raw) {
  const text = String(raw || '');
  if (/526|Authentication failure|Invalid login|Login fail|credentials|auth/i.test(text)) {
    return '发件邮箱的 SMTP 密码不对，或账号已被邮箱服务器锁定。请找 IT 确认发件邮箱的正确密码，到「API 配置 → SMTP 密码」里更新后，重新导出一遍即可';
  }
  if (/ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|connect/i.test(text)) {
    return '连不上邮件服务器（可能是公司网络或端口问题），请检查网络后重试';
  }
  if (/quota|storage|size|附件/.test(text)) {
    return '邮件或附件过大被服务器拒绝，请压缩后重试';
  }
  return text;
}

// 岗位选择状态
let selectedJob = '';
let jobList = [];
let jobSearchQuery = ''; // 目标岗位搜索词（实时过滤岗位列表）
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
const smtpPassInput = document.getElementById('smtp-pass');

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
const searchGreetHint = document.getElementById('search-greet-hint');

// 自动打招呼 DOM
const autoGreetSection = document.getElementById('auto-greet-section');
const autoGreetCheck = document.getElementById('auto-greet-check');
const autoGreetControls = document.getElementById('auto-greet-controls');
const autoGreetLevel = document.getElementById('auto-greet-level');
let autoGreetEnabled = false; // 本次分析是否自动打招呼

// ===== 自定义下拉组件 =====
// 原生 <select> 弹层在 Electron 里有时打不开（drag 区域/合成器问题），
// 批量打招呼/自动打招呼改为自定义组件。通过 .value getter/setter 保持与原 <select> 读写兼容。
function initCustomSelect(container) {
  if (!container) return;
  const trigger = container.querySelector('.custom-select-trigger');
  const menu = container.querySelector('.custom-select-menu');
  const label = trigger.querySelector('.custom-select-label');
  const options = container.querySelectorAll('.custom-select-option');

  function sync() {
    const v = String(container.dataset.value);
    const opt = container.querySelector(`.custom-select-option[data-value="${v}"]`);
    if (opt) {
      label.textContent = opt.textContent;
      options.forEach(o => o.classList.toggle('selected', o.dataset.value === v));
    }
  }

  // 暴露 .value，兼容现有 greetLevel.value / autoGreetLevel.value 的读写
  Object.defineProperty(container, 'value', {
    get() { return container.dataset.value; },
    set(v) { container.dataset.value = String(v); sync(); },
  });

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = menu.style.display !== 'none';
    document.querySelectorAll('.custom-select-menu').forEach(m => { m.style.display = 'none'; });
    if (isOpen) return;
    // 窗口底部空间不足时向上展开（原生 select 会自动翻转，自定义组件需手动处理）
    const rect = container.getBoundingClientRect();
    const menuH = options.length * 36 + 12;
    if (rect.bottom + menuH + 8 > window.innerHeight) {
      menu.style.top = 'auto';
      menu.style.bottom = 'calc(100% + 4px)';
    } else {
      menu.style.top = 'calc(100% + 4px)';
      menu.style.bottom = 'auto';
    }
    menu.style.display = 'flex';
  });

  options.forEach(opt => opt.addEventListener('click', (e) => {
    e.stopPropagation();
    container.dataset.value = opt.dataset.value;
    sync();
    menu.style.display = 'none';
    // 派发 change 事件，兼容既有监听（updateGreetCount 等）
    container.dispatchEvent(new Event('change', { bubbles: true }));
  }));

  // 点击其它位置收起
  document.addEventListener('click', () => { menu.style.display = 'none'; });

  sync();
}
initCustomSelect(greetLevel);
initCustomSelect(autoGreetLevel);

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

// ===== Toast 通知 =====
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 250);
  }, duration);
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
  btnSkipExtract.textContent = '⏭ 跳过提取候选人';
  // 重置步骤指示器
  const stepInd = document.getElementById('step-indicator');
  if (stepInd) stepInd.textContent = '等待开始';
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
      stepInd.textContent = '步骤 ' + step + '/3';
    } else if (status === 'idle') {
      stepInd.textContent = '步骤 ' + step + '/3';
    }
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
      if (data.emailError) {
        summary += `⚠ 邮件发送失败：${explainMailError(data.emailError)}\n`;
      }
      summary += `输出目录: ${data.outputDir}`;
      doneSummary.textContent = summary;

      // 检查评分数据，显示批量打招呼（沟通页/搜索页不做打招呼：搜索页打招呼需畅聊卡）
      resetGreetUI();
      if (selectedSource === 'search') {
        // 搜索页：不提供自动打招呼，提示查看 Excel 结果手动打招呼
        if (searchGreetHint) searchGreetHint.style.display = '';
      } else if (selectedSource !== 'chat') {
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
                await window.electronAPI.startGreeting(level, selectedSource);
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
      greetResult.className = 'greet-result'; // 重置，避免上一次失败的红色样式残留
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
    if (config.smtpPass) smtpPassInput.value = config.smtpPass;
  } catch {}
  updateConfigStatus();
}

async function updateConfigStatus() {
  try {
    const status = await window.electronAPI.getApiConfigStatus();
    if (status.configured) {
      configStatus.textContent = '✓ 已配置';
      configStatus.className = 'config-badge config-ok';
      btnStart.disabled = false;
      btnStart.style.opacity = '1';
    } else {
      configStatus.textContent = '未配置';
      configStatus.className = 'config-badge config-missing';
      btnStart.disabled = true;
      btnStart.style.opacity = '0.5';
    }
  } catch {
    configStatus.textContent = '未配置';
    configStatus.className = 'config-badge config-missing';
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
    configStatus.className = 'config-badge config-error';
    return;
  }

  try {
    // 简单校验 URL 格式
    new URL(url);
  } catch {
    configStatus.textContent = 'API 地址格式不正确';
    configStatus.className = 'config-badge config-error';
    return;
  }

  try {
    await window.electronAPI.setApiConfig({
      url, key, model,
      emailPrefix: emailPrefixInput.value.trim(),
      smtpPass: smtpPassInput.value.trim(),
    });
    configStatus.textContent = '✓ 已保存';
    configStatus.className = 'config-badge config-ok';
    // 延迟更新状态检测，让"✓ 已保存"可见一段时间
    setTimeout(updateConfigStatus, 1500);
  } catch (err) {
    configStatus.textContent = '保存失败: ' + err.message;
    configStatus.className = 'config-badge config-error';
  }
});

// Collapsible API Config
apiConfigToggle.addEventListener('click', () => {
  apiConfigBody.classList.toggle('expanded');
  apiConfigArrow.classList.toggle('expanded');
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

  // 开始前的「边用边跑」预检：确保 Chrome 处于边用边跑模式，否则自动重启
  try {
    const bs = await window.electronAPI.checkBossMode();
    if (bs && !bs.chromePath) {
      alert('没有在常见位置找到 Chrome。请照常打开 Chrome，按 README 第 1 步开启远程调试后使用。');
      return;
    }
    if (bs && bs.running && !bs.bossMode) {
      // Chrome 在跑但没开边用边跑 → 询问是否重启
      const ok = confirm('要用「边用边跑」模式运行（推荐），需要重启 Chrome（会关闭当前标签页，重启后自动恢复）。是否继续？\n\n如果选「取消」，本次将按普通方式运行，运行期间请不要最小化 Chrome 窗口。');
      if (ok) {
        const res = await window.electronAPI.launchBossModeChrome({ forceClose: true });
        if (res?.ok) {
          await window.electronAPI.retryCdpConnection();
          await updateCdpStatus();
          alert('Chrome 已用「边用边跑」模式重启。请确认 Boss 直聘页面已打开，然后再次点击「开始提取分析」。');
          return;
        }
        alert(res?.message || '重启 Chrome 失败，请重试。');
        return;
      }
      // 用户选择普通方式，继续（运行期间不要最小化窗口）
    } else if (bs && !bs.running) {
      // Chrome 未启动 → 用边用边跑模式直接启动
      const res = await window.electronAPI.launchBossModeChrome({ forceClose: false });
      if (res?.ok) {
        await window.electronAPI.retryCdpConnection();
        await updateCdpStatus();
        alert('Chrome 已用「边用边跑」模式启动。请打开 Boss 直聘页面，然后再次点击「开始提取分析」。');
        return;
      }
      alert(res?.message || '启动 Chrome 失败，请重试。');
      return;
    }
  } catch (e) {
    // 预检失败不阻塞，按普通方式继续
  }

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
  if (!confirm('确定跳过剩余候选人提取，用已提取的数据直接开始 AI 评分吗？')) return;
  btnSkipExtract.disabled = true;
  btnSkipExtract.textContent = '⏭ 正在跳过提取...';
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
      showToast('清理失败：' + result.error, 'error');
    } else {
      let parts = [];
      if (result.deleted > 0) parts.push('已删除 ' + result.deleted + ' 个历史文件夹');
      if (result.errors > 0) parts.push(result.errors + ' 个删除失败');
      if (result.deleted === 0 && result.errors === 0) parts.push('没有找到历史归档数据');
      showToast(parts.join('，'), result.errors > 0 ? 'error' : 'info', 4000);
    }
  } catch (err) {
    showToast('清理失败：' + err.message, 'error');
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
  addName.style.color = '#2563eb';
  addName.style.fontWeight = '600';
  addItem.appendChild(addName);
  addItem.addEventListener('click', () => {
    hideJobPicker();
    setTimeout(showAddJobDialog, 150);
  });
  jobPickerList.appendChild(addItem);

  // 岗位列表（按搜索词实时过滤；jobList 保持不变，只过滤副本）
  if (jobList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item';
    empty.textContent = '暂无岗位';
    empty.style.color = '#94a3b8';
    empty.style.cursor = 'default';
    empty.style.justifyContent = 'center';
    jobPickerList.appendChild(empty);
    return;
  }
  const query = jobSearchQuery.trim().toLowerCase();
  const filtered = query ? jobList.filter(job => job.toLowerCase().includes(query)) : jobList;
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item';
    empty.textContent = '未找到匹配的岗位';
    empty.style.color = '#94a3b8';
    empty.style.cursor = 'default';
    empty.style.justifyContent = 'center';
    jobPickerList.appendChild(empty);
    return;
  }
  filtered.forEach(job => {
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
// 岗位搜索：输入实时过滤列表
jobSearchInput.addEventListener('input', () => {
  jobSearchQuery = jobSearchInput.value;
  renderJobPicker();
});
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
    recommendHint.style.display = isAttach ? '' : 'none';
    searchHint.style.display = isSearch ? '' : 'none';
    chatHint.style.display = isChat ? '' : 'none';
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
  dialogJobName.style.background = '#f1f5f9';
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
    showToast('删除失败: ' + err.message, 'error');
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
    showToast((editJobName ? '编辑' : '添加') + '失败: ' + err.message, 'error');
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
  await window.electronAPI.startGreeting(level, selectedSource);
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
  if (searchGreetHint) searchGreetHint.style.display = 'none';
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
    const isSearch = selectedSource === 'search';
    const isChat = selectedSource === 'chat';
    const showJobSelector = isAttach || isSearch;
    jobSelectSection.style.display = showJobSelector ? 'flex' : 'none';
    recommendHint.style.display = isAttach ? '' : 'none';
    searchHint.style.display = isSearch ? '' : 'none';
    chatHint.style.display = isChat ? '' : 'none';
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
