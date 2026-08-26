// 岗位列表从 config/jd-descriptions/ 目录动态加载

// ===== DOM 引用 =====
const stateInitial = document.getElementById('state-initial');
const stateRunning = document.getElementById('state-running');
const stateDone = document.getElementById('state-done');
const stateError = document.getElementById('state-error');
const btnStart = document.getElementById('btn-start');
const btnRescore = document.getElementById('btn-rescore'); // v1.4.8 直接用上次数据评分
const btnCancel = document.getElementById('btn-cancel');
const btnSkipExtract = document.getElementById('btn-skip-extract');
const btnRestart = document.getElementById('btn-restart');
const btnRetry = document.getElementById('btn-retry');
const btnOpenDir = document.getElementById('btn-open-dir');
const btnSelectDir = document.getElementById('btn-select-dir');
const btnHistory = document.getElementById('btn-history');
const historyOverlay = document.getElementById('history-overlay');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const btnHistoryClose = document.getElementById('btn-history-close');
const btnHistoryClearAll = document.getElementById('btn-history-clear-all');
const countInput = document.getElementById('count-input');
const extractAllCheck = document.getElementById('extract-all');
const extractAllSection = document.getElementById('extract-all-section');
const enableCopyCheck = document.getElementById('enable-copy');
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
  const options = Array.from(container.querySelectorAll('.custom-select-option'));

  function sync() {
    const v = String(container.dataset.value);
    const opt = container.querySelector(`.custom-select-option[data-value="${v}"]`);
    if (opt) {
      label.textContent = opt.textContent;
      options.forEach(o => {
        const sel = o.dataset.value === v;
        o.classList.toggle('selected', sel);
        o.setAttribute('aria-selected', String(sel));
      });
    }
  }

  // 暴露 .value，兼容现有 greetLevel.value / autoGreetLevel.value 的读写
  Object.defineProperty(container, 'value', {
    get() { return container.dataset.value; },
    set(v) { container.dataset.value = String(v); sync(); },
  });

  function setOpen(open) {
    const isOpen = menu.style.display !== 'none';
    if (open === isOpen) return;
    if (open) {
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
    }
    menu.style.display = open ? 'flex' : 'none';
    trigger.setAttribute('aria-expanded', String(open));
  }

  function selectValue(v) {
    container.dataset.value = String(v);
    sync();
    setOpen(false);
    trigger.focus();
    // 派发 change 事件，兼容既有监听（updateGreetCount 等）
    container.dispatchEvent(new Event('change', { bubbles: true }));
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    document.querySelectorAll('.custom-select-menu').forEach(m => { if (m !== menu) m.style.display = 'none'; });
    setOpen(menu.style.display === 'none');
  });

  // 触发按钮键盘：↓/↑/Home/End 打开并定位；Escape 收起
  trigger.addEventListener('keydown', (e) => {
    const isOpen = menu.style.display !== 'none';
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (!isOpen) {
        setOpen(true);
        const idx = (e.key === 'ArrowUp' || e.key === 'End') ? options.length - 1 : 0;
        options[idx].focus();
      }
    } else if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      setOpen(false);
      trigger.focus();
    }
  });

  // 选项：点击选择；方向键移动；Enter/Space 选择；Escape 收起并回焦点
  options.forEach(opt => {
    opt.addEventListener('click', (e) => {
      e.stopPropagation();
      selectValue(opt.dataset.value);
    });
    opt.addEventListener('keydown', (e) => {
      const idx = options.indexOf(opt);
      if (e.key === 'ArrowDown') { e.preventDefault(); options[Math.min(idx + 1, options.length - 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); options[Math.max(idx - 1, 0)].focus(); }
      else if (e.key === 'Home') { e.preventDefault(); options[0].focus(); }
      else if (e.key === 'End') { e.preventDefault(); options[options.length - 1].focus(); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectValue(opt.dataset.value); }
      else if (e.key === 'Escape') { e.preventDefault(); setOpen(false); trigger.focus(); }
    });
  });

  // 点击其它位置收起
  document.addEventListener('click', (e) => {
    if (!container.contains(e.target)) setOpen(false);
  });

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

// ===== Toast 通知 =====
function showToast(message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  if (type === 'error') el.setAttribute('role', 'alert');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-leaving');
    setTimeout(() => el.remove(), 250);
  }, duration);
}

// ===== 通用确认弹窗（替代原生 confirm/alert）=====
// 返回 Promise<boolean>。danger 时确定按钮变红色；showCancel:false 时只保留确定按钮。
function confirmDialog({ title, message, okText = '确定', cancelText = '取消', danger = false, showCancel = true }) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('confirm-overlay');
    const titleEl = document.getElementById('confirm-title');
    const messageEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    if (!overlay || !titleEl || !messageEl || !okBtn || !cancelBtn) { resolve(false); return; }

    titleEl.textContent = title;
    messageEl.textContent = message;
    okBtn.textContent = okText;
    okBtn.className = 'btn ' + (danger ? 'btn--danger' : 'btn--primary');
    cancelBtn.textContent = cancelText;
    cancelBtn.style.display = showCancel ? '' : 'none';

    // 记录弹窗前的焦点，关闭后还原
    const prevFocus = document.activeElement;
    overlay.style.display = 'flex';
    okBtn.focus();

    const done = (val) => {
      overlay.style.display = 'none';
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      overlay.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      if (prevFocus && typeof prevFocus.focus === 'function') prevFocus.focus();
      resolve(val);
    };
    const onOk = () => done(true);
    const onCancel = () => done(false);
    const onBackdrop = (e) => { if (e.target === overlay) done(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { done(false); return; }
      if (e.key === 'Enter' && e.target === okBtn) { done(true); return; }
      // 焦点陷阱：Tab 循环在弹窗内
      if (e.key === 'Tab') {
        const focusables = [okBtn, ...(showCancel ? [cancelBtn] : [])].filter((b) => b.style.display !== 'none');
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}

// ===== 按钮加载态（spinner + aria-busy + 禁用）=====
function setLoading(btn, loading) {
  if (!btn) return;
  btn.classList.toggle('is-loading', loading);
  if (loading) btn.setAttribute('aria-busy', 'true');
  else btn.removeAttribute('aria-busy');
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
let firstStateShown = false;
function showState(stateId) {
  [stateInitial, stateRunning, stateDone, stateError].forEach((el) => {
    el.classList.remove('active');
  });
  const panel = document.getElementById(stateId);
  panel.classList.add('active');
  // v1.4.8: 回到初始界面时刷新「直接用上次数据评分」按钮的可用状态
  if (stateId === 'state-initial') updateRescoreButton();
  // 状态切换后把焦点移入新面板标题（初始加载跳过，避免页面打开即有焦点环）
  if (firstStateShown) {
    const heading = panel.querySelector('.card-title, .result-title');
    if (heading) heading.focus();
  }
  firstStateShown = true;
}

// v1.4.8: 检查是否还有上次提取的数据，决定「直接用上次数据评分」按钮是否可点
async function updateRescoreButton() {
  try {
    const has = await window.electronAPI.hasScorableData();
    btnRescore.disabled = !has;
  } catch {
    btnRescore.disabled = true;
  }
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
  // 重置跳过提取按钮
  setLoading(btnSkipExtract, false);
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
    s.card.dataset.state = 'running';
    s.status.textContent = '进行中...';
  } else if (status === 'done') {
    s.card.dataset.state = 'done';
    s.status.textContent = '✓ 已完成';
  } else if (status === 'idle') {
    s.card.dataset.state = 'waiting';
    s.status.textContent = '';
  }

  if (progress !== null && progress !== undefined) {
    const p = Math.round(Math.min(progress, 100));
    s.bar.style.width = p + '%';
    if (s.bar.setAttribute) s.bar.setAttribute('aria-valuenow', String(p));
    if (s.pct) s.pct.textContent = p + '%';
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
    handleProgress({ step: 1, status: 'running', message: info.done > 0 ? `已有 ${info.done} 名候选人，正在继续提取剩余...` : '正在继续提取...' });
  }
}

// ===== 完成页结果可视化 =====

// 档位分布条的元信息（顺序从高分到低分）。颜色用 CSS 类控制，避免内联色值。
const TIER_BAR_META = [
  { tier: 5, label: '五星', className: 'tier-bar-fill--5' },
  { tier: 4, label: '四星', className: 'tier-bar-fill--4' },
  { tier: 3, label: '三星', className: 'tier-bar-fill--3' },
  { tier: 2, label: '二星', className: 'tier-bar-fill--2' },
  { tier: 1, label: '一星', className: 'tier-bar-fill--1' },
];

function renderTierBars(tiers, total) {
  const container = document.getElementById('tier-bars');
  if (!container) return;
  container.innerHTML = '';
  for (const meta of TIER_BAR_META) {
    const count = tiers[meta.tier] || 0;
    const pct = total > 0 ? Math.round((count / total) * 100) : 0;
    const row = document.createElement('div');
    row.className = 'tier-bar';
    const label = document.createElement('span');
    label.className = 'tier-bar-label';
    label.textContent = meta.label;
    const track = document.createElement('span');
    track.className = 'tier-bar-track';
    const fill = document.createElement('span');
    fill.className = `tier-bar-fill ${meta.className}`;
    fill.style.width = pct + '%';
    track.appendChild(fill);
    const countEl = document.createElement('span');
    countEl.className = 'tier-bar-count';
    countEl.textContent = `${count} 人 · ${pct}%`;
    row.append(label, track, countEl);
    container.appendChild(row);
  }
}

function renderResultsList(candidates) {
  const listEl = document.getElementById('results-list');
  const countEl = document.getElementById('results-count');
  if (!listEl) return;
  listEl.innerHTML = '';
  if (countEl) countEl.textContent = `共 ${candidates.length} 人`;

  for (const c of candidates) {
    const item = document.createElement('div');
    item.className = 'result-item';
    item.setAttribute('role', 'listitem');

    const head = document.createElement('button');
    head.type = 'button';
    head.className = 'result-item-head';
    head.setAttribute('aria-expanded', 'false');

    const nameEl = document.createElement('span');
    nameEl.className = 'result-item-name';
    nameEl.textContent = c.name;

    const scoreEl = document.createElement('span');
    scoreEl.className = 'result-item-score';
    scoreEl.textContent = c.score + ' 分';

    const tierEl = document.createElement('span');
    tierEl.className = `result-item-tier tier--${c.tier}`;
    tierEl.textContent = '★'.repeat(c.tier) + '☆'.repeat(5 - c.tier);
    tierEl.setAttribute('aria-label', `${c.tier} 星`);

    const arrowEl = document.createElement('span');
    arrowEl.className = 'result-item-arrow';
    arrowEl.setAttribute('aria-hidden', 'true');
    arrowEl.textContent = '▸';

    head.append(nameEl, scoreEl, tierEl, arrowEl);

    const body = document.createElement('div');
    body.className = 'result-item-body';
    body.style.display = 'none';

    const metaEl = document.createElement('div');
    metaEl.className = 'result-item-meta';
    if (c.position) {
      const chip = document.createElement('span');
      chip.className = 'meta-chip';
      chip.textContent = c.position;
      metaEl.appendChild(chip);
    }
    const levelChip = document.createElement('span');
    levelChip.className = `meta-chip ${c.passed ? 'meta-chip--pass' : 'meta-chip--fail'}`;
    levelChip.textContent = c.level;
    metaEl.appendChild(levelChip);
    const passChip = document.createElement('span');
    passChip.className = 'meta-chip';
    passChip.textContent = c.passed ? '通过' : '未通过';
    metaEl.appendChild(passChip);

    const commentEl = document.createElement('div');
    commentEl.className = 'result-item-comment';
    commentEl.textContent = c.comment || '（无评语）';
    commentEl.style.whiteSpace = 'pre-line';

    body.append(metaEl, commentEl);

    head.addEventListener('click', () => {
      const expanded = head.getAttribute('aria-expanded') === 'true';
      head.setAttribute('aria-expanded', String(!expanded));
      body.style.display = expanded ? 'none' : '';
      arrowEl.textContent = expanded ? '▸' : '▾';
    });

    item.append(head, body);
    listEl.appendChild(item);
  }
}

async function loadScoringResults() {
  const resultsVisual = document.getElementById('results-visual');
  if (!resultsVisual) return;
  try {
    const data = await window.electronAPI.getScoringResults();
    if (!data || !data.available || data.total < 1) {
      resultsVisual.style.display = 'none';
      return;
    }
    document.getElementById('stat-extracted').textContent = data.total;
    document.getElementById('stat-passed').textContent = data.passed;
    document.getElementById('stat-avg').textContent = data.avgScore;
    document.getElementById('stat-rate').textContent = data.passRate + '%';
    renderTierBars(data.tiers, data.total);
    renderResultsList(data.candidates);
    resultsVisual.style.display = '';
  } catch {
    resultsVisual.style.display = 'none';
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
      const mailDetails = document.getElementById('mail-error-details');
      const mailDetail = document.getElementById('mail-error-detail');
      if (data.emailError) {
        if (mailDetails && mailDetail) {
          mailDetails.style.display = '';
          // 展开显示服务器返回的报错原文；折叠条标题「邮件发送失败的原因」已在 HTML 里写死
          mailDetail.textContent = data.emailError;
        }
      } else if (mailDetails) {
        mailDetails.style.display = 'none';
      }
      summary += `输出目录: ${data.outputDir}`;
      doneSummary.textContent = summary;

      // 完成页结果可视化：统计条 + 档位分布 + 候选人列表
      loadScoringResults();

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
                if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', '0');
                greetProgressText.textContent = '自动打招呼中...';
                const res = await window.electronAPI.startGreeting(level, selectedSource);
                autoGreetEnabled = false;
                // 已有任务运行中：主进程拒绝，恢复打招呼面板而不是停在假进度
                if (res?.error) {
                  showToast(res.error, 'warning', 4000);
                  greetProgress.style.display = 'none';
                  greetResult.style.display = 'none';
                  btnStartGreet.style.display = '';
                  btnCancelGreet.style.display = 'none';
                }
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
      const cur = data.current || 0;
      const total = data.total || 0;
      const pct = total > 0 ? Math.min(Math.round((cur / total) * 100), 100) : 0;
      greetProgressBar.style.width = pct + '%';
      if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', String(pct));
      greetProgressText.textContent = total > 0 ? `正在打招呼 ${cur}/${total}` : '正在打招呼中...';
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

// 配置缺失时指出具体缺哪一项（未配置 → 「未配置：缺 API 地址（或 Key / 模型）」）
function missingConfigFields() {
  const missing = [];
  if (!apiUrlInput.value.trim()) missing.push('API 地址');
  if (!apiKeyInput.value.trim()) missing.push('API Key');
  if (!apiModelInput.value.trim()) missing.push('模型名称');
  return missing;
}

async function updateConfigStatus() {
  const hint = document.getElementById('btn-start-hint');
  const setMissing = (msg) => {
    configStatus.textContent = msg || '未配置：缺 ' + missingConfigFields().join('、');
    configStatus.className = 'config-badge config-missing';
    btnStart.disabled = true;
    if (hint) {
      hint.textContent = '请先展开上方「API 配置」填写 ' + missingConfigFields().join('、') + ' 并保存';
    }
  };
  try {
    const status = await window.electronAPI.getApiConfigStatus();
    if (status.configured) {
      configStatus.textContent = '✓ 已配置';
      configStatus.className = 'config-badge config-ok';
      btnStart.disabled = false;
      if (hint) hint.textContent = '';
    } else {
      setMissing('未配置');
    }
  } catch {
    setMissing('未配置');
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

  // 邮箱可选，但填了就必须是完整地址（含 @），不自动补域名
  const emailVal = emailPrefixInput.value.trim();
  if (emailVal && !emailVal.includes('@')) {
    configStatus.textContent = '邮箱请填完整地址（含 @），如 hr@example.com';
    configStatus.className = 'config-badge config-error';
    return;
  }

  try {
    await window.electronAPI.setApiConfig({
      url, key, model,
      emailPrefix: emailVal,
      smtpPass: smtpPassInput.value.trim(),
    });
    configStatus.textContent = '✓ 已保存';
    configStatus.className = 'config-badge config-ok';
    showToast('配置已保存', 'success', 3000);
    // 延迟更新状态检测，让"✓ 已保存"可见一段时间
    setTimeout(updateConfigStatus, 1500);
  } catch (err) {
    configStatus.textContent = '保存失败: ' + err.message;
    configStatus.className = 'config-badge config-error';
  }
});

// Collapsible API Config
apiConfigToggle.addEventListener('click', () => {
  const expanded = apiConfigBody.classList.toggle('expanded');
  apiConfigArrow.classList.toggle('expanded');
  apiConfigToggle.setAttribute('aria-expanded', String(expanded));
});

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

  // 开始前的「边用边跑」预检：确保 Chrome 处于边用边跑模式，否则自动重启
  try {
    const bs = await window.electronAPI.checkBossMode();
    if (bs && !bs.chromePath) {
      await confirmDialog({
        title: '未找到 Chrome',
        message: '没有在常见位置找到 Chrome。请照常打开 Chrome，按 README 第 1 步开启远程调试后使用。',
        okText: '知道了',
        showCancel: false,
      });
      return;
    }
    if (bs && bs.running && !bs.bossMode) {
      // Chrome 在跑但没开边用边跑 → 询问是否重启
      const ok = await confirmDialog({
        title: '重启 Chrome 进入「边用边跑」模式？',
        message: '要用「边用边跑」模式运行（推荐），需要重启 Chrome（会关闭当前标签页）。重启后请重新打开 Boss 直聘页面。是否继续？\n\n如果选「取消」，本次将按普通方式运行，运行期间请不要最小化 Chrome 窗口。',
        okText: '重启 Chrome',
        cancelText: '按普通方式运行',
      });
      if (ok) {
        const res = await window.electronAPI.launchBossModeChrome({ forceClose: true });
        if (res?.ok) {
          await window.electronAPI.retryCdpConnection();
          await updateCdpStatus();
          await confirmDialog({
            title: 'Chrome 已重启',
            message: 'Chrome 已用「边用边跑」模式重启。请确认 Boss 直聘页面已打开，然后再次点击「开始提取分析」。',
            okText: '知道了',
            showCancel: false,
          });
          return;
        }
        showToast(res?.message || '重启 Chrome 失败，请重试。', 'error', 5000);
        return;
      }
      // 用户选择普通方式，继续（运行期间不要最小化窗口）
    } else if (bs && !bs.running) {
      // Chrome 未启动 → 用边用边跑模式直接启动
      const res = await window.electronAPI.launchBossModeChrome({ forceClose: false });
      if (res?.ok) {
        await window.electronAPI.retryCdpConnection();
        await updateCdpStatus();
        await confirmDialog({
          title: 'Chrome 已启动',
          message: 'Chrome 已用「边用边跑」模式启动。请打开 Boss 直聘页面，然后再次点击「开始提取分析」。',
          okText: '知道了',
          showCancel: false,
        });
        return;
      }
      showToast(res?.message || '启动 Chrome 失败，请重试。', 'error', 5000);
      return;
    }
  } catch (e) {
    // 预检失败不阻塞，按普通方式继续
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
  btnSkipExtract.textContent = '⏭ 正在跳过提取...';
  const msgEl = stepCards[1].msg;
  if (msgEl) msgEl.textContent = '正在停止提取，恢复已提取数据...';
  await window.electronAPI.skipExtraction();
});

// v1.4.8: 直接用上次数据评分（跳过提取）——换好模型后重新评分，不用重新提取
btnRescore.addEventListener('click', async () => {
  resetSteps();
  showState('state-running');
  autoGreetEnabled = autoGreetCheck.checked;
  const greetLevel2 = parseInt(autoGreetLevel.value, 10);
  await startPipeline({
    count: 0,
    extractAll: true,
    source: selectedSource,
    job: selectedJob,
    autoGreet: autoGreetEnabled,
    greetLevel: greetLevel2,
    enableCopy: enableCopyCheck.checked,
    skipExtract: true, // 关键：跳过步骤1提取，直接用已有数据评分
  });
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
  btn.textContent = '重新连接中...';
  btn.disabled = true;
  await window.electronAPI.retryCdpConnection();
  await updateCdpStatus();
  setLoading(btn, false);
  btn.textContent = '重新连接 Chrome';
  btn.disabled = false;
});

// 选择输出目录
btnSelectDir.addEventListener('click', async () => {
  const result = await window.electronAPI.selectOutputDir();
  if (result?.path) {
    outputDirSpan.textContent = result.path;
  }
});

// ===== 历史记录抽屉 =====

const HISTORY_SOURCE_LABELS = {
  'recommend-attach': '推荐牛人页',
  recommend: '推荐牛人页',
  search: '搜索页',
  chat: '沟通页',
};

function historySourceLabel(meta) {
  const s = meta && meta.source;
  return (s && HISTORY_SOURCE_LABELS[s]) || '未知来源';
}

function openHistoryDrawer() {
  loadHistory();
  openDialog(historyOverlay, btnHistoryClose);
}

function closeHistoryDrawer() {
  closeDialog(historyOverlay);
}

async function loadHistory() {
  historyList.innerHTML = '';
  historyList.style.display = '';
  historyEmpty.style.display = 'none';
  let data;
  try {
    data = await window.electronAPI.listHistory();
  } catch (err) {
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = '读取历史记录失败：' + err.message;
    return;
  }
  if (data?.error) {
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = data.error;
    return;
  }
  const items = data?.list || [];
  if (items.length === 0) {
    // 空态时隐藏列表容器，空态文字才能在整个中间区域垂直居中（否则被空的列表占一半高度）
    historyList.style.display = 'none';
    historyEmpty.style.display = '';
    historyEmpty.textContent = '暂无历史记录。跑完一批数据后，这里会按时间列出各批次。';
    return;
  }
  for (const item of items) {
    historyList.appendChild(renderHistoryItem(item));
  }
}

function renderHistoryItem(item) {
  const row = document.createElement('div');
  row.className = 'history-item';
  row.setAttribute('role', 'listitem');

  const meta = item.meta || {};
  const sourceLabel = historySourceLabel(meta);

  // 摘要行：时间 + 来源/状态标签 + 人数
  const summary = document.createElement('div');
  summary.className = 'history-item-summary';

  const titleEl = document.createElement('div');
  titleEl.className = 'history-item-title';
  const timeEl = document.createElement('span');
  timeEl.className = 'history-item-time';
  timeEl.textContent = item.time || '时间未知';
  const chipWrap = document.createElement('span');
  chipWrap.className = 'history-item-chips';

  const srcChip = document.createElement('span');
  srcChip.className = 'meta-chip';
  srcChip.textContent = sourceLabel;
  chipWrap.appendChild(srcChip);

  if (item.isCurrent) {
    const curChip = document.createElement('span');
    curChip.className = 'meta-chip meta-chip--pass';
    if (item.hasProgress) {
      curChip.textContent = '未完成·可继续';
    } else if (item.hasScored || item.hasExcel) {
      curChip.textContent = '已完成';
    } else {
      curChip.textContent = '提取中';
    }
    chipWrap.appendChild(curChip);
  } else if (item.hasProgress) {
    const progChip = document.createElement('span');
    progChip.className = 'meta-chip meta-chip--pass';
    progChip.textContent = '提取未完成';
    chipWrap.appendChild(progChip);
  } else if (item.hasScored) {
    const doneChip = document.createElement('span');
    doneChip.className = 'meta-chip';
    doneChip.textContent = '已完成';
    chipWrap.appendChild(doneChip);
  }
  if (item.hasExcel) {
    const xlsChip = document.createElement('span');
    xlsChip.className = 'meta-chip';
    xlsChip.textContent = '含 Excel';
    chipWrap.appendChild(xlsChip);
  }
  titleEl.append(timeEl, chipWrap);

  const countEl = document.createElement('div');
  countEl.className = 'history-item-count';
  countEl.textContent = `${item.candidateCount} 人`;

  summary.append(titleEl, countEl);

  // 操作行
  const actions = document.createElement('div');
  actions.className = 'history-item-actions';

  const makeBtn = (text, variant, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${variant}`;
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  };

  // 继续提取：该批次还有未完成的提取进度
  if (item.hasProgress) {
    actions.appendChild(makeBtn('继续提取', 'btn--primary', async () => {
      const res = await window.electronAPI.resumeExtraction(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); return; }
      closeHistoryDrawer();
      resetSteps();
      showState('state-running');
      // 立即按已有进度显示「提取到哪了」，而不是停在「等待开始」；数据直接来自历史列表项，无需再读文件
      initResumeStep({ done: item.candidateCount, hasCandidates: item.hasCandidates });
    }));
  }

  // 用该份数据重新评分：该批次有提取数据（换模型后重评）
  if (item.hasCandidates) {
    actions.appendChild(makeBtn('用该份数据重新评分', 'btn--secondary', async () => {
      const res = await window.electronAPI.rescoreFromHistory(item.path);
      if (res?.error) { showToast(res.error, 'warning', 4000); return; }
      closeHistoryDrawer();
      resetSteps();
      showState('state-running');
    }));
  }

  actions.appendChild(makeBtn('打开目录', 'btn--ghost', async () => {
    await window.electronAPI.openHistory(item.path);
  }));
  // 当前输出目录不能删除（软件正在用的目录），不显示删除按钮
  if (!item.isCurrent) {
    actions.appendChild(makeBtn('删除', 'btn--ghost btn--link-danger', async () => {
      const ok = await confirmDialog({
        title: '删除该批次？',
        message: `将删除「${item.name}」这一批历史数据（不含已导出的 Excel 文件），删除后不可恢复。`,
        okText: '删除',
        danger: true,
      });
      if (!ok) return;
      const res = await window.electronAPI.deleteHistory(item.path);
      if (res?.error) {
        showToast('删除失败：' + res.error, 'error');
      } else {
        showToast('已删除', 'success', 2000);
        loadHistory();
      }
    }));
  }

  row.append(summary, actions);
  return row;
}

btnHistory.addEventListener('click', openHistoryDrawer);
btnHistoryClose.addEventListener('click', closeHistoryDrawer);
// 点击遮罩空白处关闭
historyOverlay.addEventListener('click', (e) => {
  if (e.target === historyOverlay) closeHistoryDrawer();
});

// 清空全部历史（抽屉底部）
btnHistoryClearAll.addEventListener('click', async () => {
  const ok = await confirmDialog({
    title: '清空全部历史？',
    message: '将删除本地保存的全部历史批次（不含已导出的 Excel 文件），删除后不可恢复。',
    okText: '清空',
    danger: true,
  });
  if (!ok) return;
  setLoading(btnHistoryClearAll, true);
  try {
    const result = await window.electronAPI.clearHistory();
    if (result.error) {
      showToast('清理失败：' + result.error, 'error');
    } else {
      let parts = [];
      if (result.deleted > 0) parts.push('已删除 ' + result.deleted + ' 个历史批次');
      if (result.errors > 0) parts.push(result.errors + ' 个删除失败');
      if (result.deleted === 0 && result.errors === 0) parts.push('没有找到历史归档数据');
      showToast(parts.join('，'), result.errors > 0 ? 'error' : 'info', 4000);
    }
  } catch (err) {
    showToast('清理失败：' + err.message, 'error');
  } finally {
    setLoading(btnHistoryClearAll, false);
    loadHistory();
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
  addItem.setAttribute('role', 'listitem');
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'job-picker-item-name';
  addBtn.textContent = '+ 添加新岗位';
  addBtn.addEventListener('click', () => {
    hideJobPicker();
    showAddJobDialog();
  });
  addItem.appendChild(addBtn);
  jobPickerList.appendChild(addItem);

  // 岗位列表（按搜索词实时过滤；jobList 保持不变，只过滤副本）
  if (jobList.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item empty-state';
    empty.textContent = '暂无岗位';
    jobPickerList.appendChild(empty);
    return;
  }
  const query = jobSearchQuery.trim().toLowerCase();
  const filtered = query ? jobList.filter(job => job.toLowerCase().includes(query)) : jobList;
  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'job-picker-item empty-state';
    empty.textContent = '未找到匹配的岗位';
    jobPickerList.appendChild(empty);
    return;
  }
  filtered.forEach(job => {
    const item = document.createElement('div');
    item.className = 'job-picker-item';
    item.setAttribute('role', 'listitem');
    if (job === selectedJob) item.classList.add('selected');

    // 岗位名称（可点击/键盘切换）
    const nameBtn = document.createElement('button');
    nameBtn.type = 'button';
    nameBtn.className = 'job-picker-item-name';
    nameBtn.textContent = job;
    nameBtn.addEventListener('click', () => {
      selectedJob = job;
      updateJobDisplay();
      hideJobPicker();
    });
    item.appendChild(nameBtn);

    // 操作按钮组
    const actions = document.createElement('span');
    actions.className = 'job-picker-item-actions';

    const btnEdit = document.createElement('button');
    btnEdit.className = 'btn btn--sm btn--secondary';
    btnEdit.textContent = '编辑';
    btnEdit.addEventListener('click', (e) => {
      e.stopPropagation();
      // 编辑弹窗层级高于「目标岗位」弹窗，关闭后立即打开即可，无需等待
      hideJobPicker();
      showEditJobDialog(job);
    });
    actions.appendChild(btnEdit);

    const btnDelete = document.createElement('button');
    btnDelete.className = 'btn btn--sm btn--danger';
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
  // 系统开了「减少动态效果」时不做过渡，直接关闭，避免干等 250ms
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (animate && !reduceMotion) {
    // 先淡出再隐藏：与紧接着打开的弹窗淡入衔接成连续过渡，不会「啪」一下消失
    overlay.setAttribute('inert', '');
    overlay.classList.add('dialog-overlay--closing');
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
    }, 260);
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
  dialogJobName.classList.remove('input-readonly');
  dialogJobDesc.value = '';
  dialogJobHint.style.display = '';
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
  dialogJobHint.style.display = 'none';
  dialogJobDesc.value = desc;
  document.getElementById('job-dialog-title').textContent = '编辑岗位描述';
  openDialog(jobDialogOverlay, dialogJobDesc);
}

function hideAddJobDialog() {
  closeDialog(jobDialogOverlay, { animate: true });
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
    showToast('删除失败: ' + err.message, 'error');
  }
}

btnDialogCancel.addEventListener('click', hideAddJobDialog);
jobDialogOverlay.addEventListener('click', (e) => {
  if (e.target === jobDialogOverlay) hideAddJobDialog();
});

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
  if (greetProgressBar.setAttribute) greetProgressBar.setAttribute('aria-valuenow', '0');
  greetProgressText.textContent = '正在打招呼中...';
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

  // 密码框显示/隐藏切换（👁 点击切换，睁眼/闭眼 SVG 图标）
  const EYE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 11 8 11 8a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 1 12s4 8 11 8a9.74 9.74 0 0 0 5.39-1.61"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';
  document.addEventListener('click', (e) => {
    const toggle = e.target.closest('.input-toggle');
    if (!toggle) return;
    const targetId = toggle.getAttribute('data-target');
    const input = targetId && document.getElementById(targetId);
    if (input && input.type === 'password') {
      input.type = 'text';
      toggle.innerHTML = EYE_SVG; // 明文 → 睁眼
      toggle.title = '点击隐藏';
      toggle.setAttribute('aria-pressed', 'true');
    } else if (input) {
      input.type = 'password';
      toggle.innerHTML = EYE_OFF_SVG; // 隐藏 → 闭眼
      toggle.title = '点击显示';
      toggle.setAttribute('aria-pressed', 'false');
    }
  });

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
