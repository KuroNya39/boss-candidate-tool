// renderer-dom.js —— 由原 renderer.js 第 1–88 行按顺序拆分；加载顺序即文件排列顺序，请勿调整
//
// 岗位列表从 config/jd-descriptions/ 目录动态加载

// ===== DOM 引用 =====
const stateInitial = document.getElementById('state-initial');
const stateRunning = document.getElementById('state-running');
const stateDone = document.getElementById('state-done');
const stateError = document.getElementById('state-error');
const btnStart = document.getElementById('btn-start');
const btnCancel = document.getElementById('btn-cancel');
const btnSkipExtract = document.getElementById('btn-skip-extract');
const btnPauseExtract = document.getElementById('btn-pause-extract');
// 暂停/继续 统一引用 sprite 里的 Material 图标（path 数据只在 index.html 维护一份；跳过的图标是静态 HTML，无需 JS 重建）
const SVG_PAUSE = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-pause"/></svg>';
const SVG_PLAY = '<svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-play"/></svg>';
const SVG_CHEVRON_RIGHT = '<svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><use href="#icon-chevron-right"/></svg>';
const btnRestart = document.getElementById('btn-restart');
const btnRetry = document.getElementById('btn-retry');
const btnErrorBack = document.getElementById('btn-error-back');
const btnRetryChrome = document.getElementById('btn-retry-chrome'); // 顶栏 Chrome 重连按钮
const btnOpenDir = document.getElementById('btn-open-dir');
const btnSelectDir = document.getElementById('btn-select-dir');
const btnHistory = document.getElementById('btn-history');
const historyOverlay = document.getElementById('history-overlay');
const historyDrawer = document.getElementById('history-drawer');
const historyList = document.getElementById('history-list');
const historyEmpty = document.getElementById('history-empty');
const btnHistoryClearAll = document.getElementById('btn-history-clear-all');
const countInput = document.getElementById('count-input');
const countInc = document.getElementById('count-inc'); // 提取数量自绘步进箭头（原生 spin 已隐藏）
const countDec = document.getElementById('count-dec');
const extractAllCheck = document.getElementById('extract-all');
const extractAllSection = document.getElementById('extract-all-section');
const enableCopyCheck = document.getElementById('enable-copy');
const outputDirSpan = document.getElementById('output-dir');
const runGridMain = document.getElementById('run-grid-main');
const jobSelectSection = document.getElementById('job-select-section');
const jobDisplay = document.getElementById('job-display');
const jobPickerOverlay = document.getElementById('job-picker-overlay');
const jobPickerList = document.getElementById('job-picker-list');
const jobSearchInput = document.getElementById('job-search-input');
const jobSearchClear = document.getElementById('job-search-clear');
const btnPickerCancel = document.getElementById('btn-picker-cancel');
const jobDialogOverlay = document.getElementById('job-dialog-overlay');
const dialogJobName = document.getElementById('dialog-job-name');
const dialogJobDesc = document.getElementById('dialog-job-desc');
const btnDialogSave = document.getElementById('btn-dialog-save');
const btnDialogCancel = document.getElementById('btn-dialog-cancel');
const doneSummary = document.getElementById('done-summary');
const errorMessage = document.getElementById('error-message');

// 岗位选择状态
let selectedJob = '';
let jobList = [];
let jobSearchQuery = ''; // 目标岗位搜索词（实时过滤岗位列表）
let selectedSource = 'chat'; // 当前选中的提取来源
// 打招呼只在推荐牛人页的名单上点按钮；recommend 系来源统一归 recommend
// （搜索/沟通页不显示打招呼面板，不会走到这）。放最先加载的 dom，供 greet/ipc 共用
function greetSource() {
  return selectedSource === 'search' ? 'search' : 'recommend';
}

// 编辑岗位模式（非空时表示正在编辑已有岗位）
let editJobName = '';

// API 配置 DOM
const apiUrlInput = document.getElementById('api-url');
const apiKeyInput = document.getElementById('api-key');
const apiModelInput = document.getElementById('api-model');
const btnSaveConfig = document.getElementById('btn-save-config');
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

// 自动打招呼 DOM
const autoGreetSection = document.getElementById('auto-greet-section');
const autoGreetCheck = document.getElementById('auto-greet-check');
const autoGreetControls = document.getElementById('auto-greet-controls');
const autoGreetLevel = document.getElementById('auto-greet-level');
let autoGreetEnabled = false; // 本次分析是否自动打招呼

// 打招呼「重试」共享状态（renderer-greet.js / renderer-ipc.js 读写）。
// 上一轮有可重试失败（点过没成，多为太频繁/风控）时非空 = {level}，
// 主按钮随之变「重试」；全成功/换等级/回首页都置回 null（按钮回「开始打招呼」）。
// 只记 level 不记 source：重试时来源恒由 greetSource() 实时算（打招呼只在推荐牛人页，
// search/chat 到不了这），先存下来也没人读，属冗余状态
let greetRetry = null;
// 最近一次打招呼用的 {level}：跑完有失败时按它回填 greetRetry（重试沿用同档口径）
let lastGreetRun = null;
// 当前等级可打招呼人数：决定「开始打招呼」是否禁用（重试态固定可用）
let greetTargetCount = 0;

