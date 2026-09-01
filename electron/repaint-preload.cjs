const { contextBridge, ipcRenderer } = require('electron');

const MAX_REPAINT_DATA_URL_LENGTH = 40 * 1024 * 1024;

contextBridge.exposeInMainWorld('jackyDesktop', Object.freeze({
  isElectron: true,
  preferences: Object.freeze({ get: () => null }),
  repaintWindow: Object.freeze({
    getPayload: sessionId => ipcRenderer.invoke('jacky:repaint-window:get-payload', sessionId),
    complete: (sessionId, dataUrl) => {
      if (typeof dataUrl !== 'string' || dataUrl.length > MAX_REPAINT_DATA_URL_LENGTH) throw new Error('Repaint result too large');
      return ipcRenderer.invoke('jacky:repaint-window:complete', { sessionId, dataUrl });
    },
    cancel: sessionId => ipcRenderer.invoke('jacky:repaint-window:cancel', sessionId),
  }),
}));
