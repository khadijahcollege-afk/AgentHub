const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentHubDesktop', Object.freeze({
  controlWindow: (action) => {
    if (['minimize', 'toggle-maximize', 'close'].includes(action)) {
      ipcRenderer.send('agenthub:window-control', action);
    }
  },
  getWindowState: () => ipcRenderer.invoke('agenthub:window-state'),
  setBackdrop: (mode) => {
    if (['mica', 'acrylic', 'none', 'auto'].includes(mode)) {
      ipcRenderer.send('agenthub:set-backdrop', mode);
    }
  },
  onTrayEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agenthub:tray-event', listener);
    return () => ipcRenderer.removeListener('agenthub:tray-event', listener);
  },
  onWindowState: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('agenthub:window-state-changed', listener);
    return () => ipcRenderer.removeListener('agenthub:window-state-changed', listener);
  },
}));
