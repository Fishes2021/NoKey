const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('voiceEngine', {
  onRequest: callback => ipcRenderer.on('voice:request', (_event, request) => callback(request)),
  reply: result => ipcRenderer.send('voice:reply', result),
  pcm: (samples, gain, sessionId) => ipcRenderer.send('voice:pcm', { samples, gain, sessionId }),
  clear: sessionId => ipcRenderer.send('voice:clear', sessionId),
  closed: sessionId => ipcRenderer.send('voice:closed', sessionId),
});
contextBridge.exposeInMainWorld('desktopClient', {
  action: (action, keyId) => ipcRenderer.invoke('desktop:action', action, keyId),
  onState: callback => ipcRenderer.on('desktop:state', (_event, state) => callback(state)),
});
