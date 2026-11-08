const { contextBridge, ipcRenderer } = require('electron');
const methods = new Set(['bootstrap', 'resolve', 'cancelPreload', 'metadata', 'search', 'radio', 'playlist', 'artist', 'download', 'deleteDownload', 'cancelDownload', 'retryDownload', 'checkUpdates', 'updateState', 'installUpdate']);
contextBridge.exposeInMainWorld('SpotitubeDesktop', {
  invoke: (method, args = {}) => {
    if (!methods.has(method)) return Promise.reject(new Error('Unsupported operation.'));
    return ipcRenderer.invoke('spotitube', method, args);
  },
  onDownloads: listener => {
    const handler = (_event, jobs) => listener(jobs);
    ipcRenderer.on('downloads', handler);
    return () => ipcRenderer.removeListener('downloads', handler);
  },
  onUpdate: listener => {
    const handler = (_event, state) => listener(state);
    ipcRenderer.on('desktop-update', handler);
    return () => ipcRenderer.removeListener('desktop-update', handler);
  },
});
