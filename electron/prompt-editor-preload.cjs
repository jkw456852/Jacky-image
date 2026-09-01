const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('jackyDesktop', Object.freeze({
  isElectron: true,
  preferences: Object.freeze({ get: () => null }),
  promptEditorWindow: Object.freeze({
    getPayload: sessionId => ipcRenderer.invoke('jacky:prompt-editor-window:get-payload', sessionId),
    close: sessionId => ipcRenderer.invoke('jacky:prompt-editor-window:close', sessionId),
  }),
}));
