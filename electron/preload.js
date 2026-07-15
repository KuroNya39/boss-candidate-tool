const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 请求-响应模式
  startExtraction: (opts) => ipcRenderer.invoke('start-extraction', opts),
  cancelExtraction: () => ipcRenderer.invoke('cancel-extraction'),
  skipExtraction: () => ipcRenderer.invoke('skip-extraction'),
  openOutputDir: () => ipcRenderer.invoke('open-output'),
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),

  // API 配置 + 邮件配置
  setApiConfig: (config) => ipcRenderer.invoke('set-api-config', config),
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  getApiConfigStatus: () => ipcRenderer.invoke('get-api-config-status'),

  // 输出目录选择
  selectOutputDir: () => ipcRenderer.invoke('select-output-dir'),

  // 清空历史归档数据
  clearHistory: () => ipcRenderer.invoke('clear-history'),

  // 推荐牛人页岗位列表
  getRecommendJobs: () => ipcRenderer.invoke('get-recommend-jobs'),
  getRecommendJobDesc: (jobName) => ipcRenderer.invoke('get-recommend-job-desc', jobName),
  addRecommendJob: (jobName, jobDesc) => ipcRenderer.invoke('add-recommend-job', jobName, jobDesc),
  updateRecommendJob: (jobName, jobDesc) => ipcRenderer.invoke('update-recommend-job', jobName, jobDesc),
  deleteRecommendJob: (jobName) => ipcRenderer.invoke('delete-recommend-job', jobName),

  // CDP/Chrome 状态
  getCdpStatus: () => ipcRenderer.invoke('get-cdp-status'),
  retryCdpConnection: () => ipcRenderer.invoke('retry-cdp-connection'),

  // 批量打招呼
  startGreeting: (level) => ipcRenderer.invoke('start-greeting', { level }),
  cancelGreeting: () => ipcRenderer.invoke('cancel-greeting'),
  getGreetCandidateCounts: () => ipcRenderer.invoke('get-greet-candidate-counts'),

  onProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('progress-update', handler);
    return () => ipcRenderer.removeListener('progress-update', handler);
  },
  onDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('extraction-done', handler);
    return () => ipcRenderer.removeListener('extraction-done', handler);
  },
  onError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('extraction-error', handler);
    return () => ipcRenderer.removeListener('extraction-error', handler);
  },

  // 批量打招呼事件
  onGreetProgress: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('greet-progress', handler);
    return () => ipcRenderer.removeListener('greet-progress', handler);
  },
  onGreetDone: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('greet-done', handler);
    return () => ipcRenderer.removeListener('greet-done', handler);
  },
  onGreetError: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('greet-error', handler);
    return () => ipcRenderer.removeListener('greet-error', handler);
  },
});
