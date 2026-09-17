const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceCheck', { configuration: () => ipcRenderer.invoke('voice-check-config'), done: result => ipcRenderer.send('voice-check-result', result) });
