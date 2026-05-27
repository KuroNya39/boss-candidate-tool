const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 请求-响应模式
  startExtraction: (opts) => ipcRenderer.invoke('start-extraction', opts),
  cancelExtraction: () => ipcRenderer.invoke('cancel-extraction'),
  openOutputDir: () => ipcRenderer.invoke('open-output'),
  getOutputDir: () => ipcRenderer.invoke('get-output-dir'),

  // API 配置
  setApiConfig: (url, key, model) => ipcRenderer.invoke('set-api-config', { url, key, model }),
  getApiConfig: () => ipcRenderer.invoke('get-api-config'),
  getApiConfigStatus: () => ipcRenderer.invoke('get-api-config-status'),

  // 主进程主动推送（监听）
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
});
