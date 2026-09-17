// A bounded development check, not a background service. No microphone or speaker use.
const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const directory = path.resolve(__dirname, '../build/desktop/rtc-check-profile');
fs.mkdirSync(directory, { recursive: true });
app.setPath('userData', directory);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
let window, finished = false;
function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  console.log(JSON.stringify(result));
  process.exitCode = result.ok ? 0 : 1;
  window?.destroy();
  app.quit(); // Normal Electron teardown; do not force process.exit.
}
const watchdog = setTimeout(() => finish({ ok: false, error: 'Audio check timed out' }), 20000);
app.whenReady().then(async () => {
  const configuration = process.env.VOICEDECK_RTC_CONFIG ? JSON.parse(fs.readFileSync(process.env.VOICEDECK_RTC_CONFIG, 'utf8')) : {};
  ipcMain.handle('voice-check-config', () => configuration);
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'rtc/check-preload.cjs'), sandbox: true,
    contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', (_e, details) => finish({ ok: false, error: details.reason }));
  ipcMain.on('voice-check-result', async (event, result) => {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return;
    let host;
    try {
      if (result.ok) {
        const { createVoiceHost } = await import('./voice-host.mjs');
        host = await createVoiceHost({ show: false });
        if (host.activeOwner !== null) throw new Error('Idle audio host must not own control');
        const native = require('../build/desktop/voice-output.node');
        if (native.probe() !== 0) {
          let rejected = false;
          try { await host.offer('test-only', { type: 'offer', sdp: '' }); }
          catch (error) { rejected = error.statusCode === 503; }
          if (!rejected) throw new Error('Missing device must reject output without fallback');
          if (host.activeOwner !== null) throw new Error('Failed offer must not retain control ownership');
        }
        host.close();
      }
      finish(result);
    } catch (error) { host?.close(); finish({ ok: false, error: error.stack }); }
  });
  await window.loadFile(path.join(__dirname, 'rtc/check.html'));
}).catch(error => finish({ ok: false, error: error.stack }));
