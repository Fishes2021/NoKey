// SPDX-License-Identifier: GPL-3.0-only
import { BrowserWindow, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Create only after Electron app.whenReady(). The caller supplies authenticated
// device identity and operator-owned domestic ICE configuration.
export async function createVoiceHost({ microphone, keyboard, iceServers = [], getIceConfig = async () => ({ iceServers, expiresAt: null }), show = true } = {}) {
  const output = require('../build/desktop/voice-output.node');
  const window = new BrowserWindow({ show, title: 'NoKey', width: 560, height: 360,
    webPreferences: { preload: fileURLToPath(new URL('./rtc/preload.cjs', import.meta.url)),
      sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      partition: `voice-${randomUUID()}` } });
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  let active = null, closed = false, recoveryWork = Promise.resolve();
  const pending = new Map();
  const trusted = event => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const release = () => {
    // Only close a dictation toggle that this voice owner successfully opened,
    // and only while the same foreground target still owns the keyboard.
    if (active?.dictationTarget && keyboard) {
      try {
        const state = JSON.parse(keyboard.snapshot());
        if (state.trusted && state.target?.id === active.dictationTarget)
          keyboard.press(active.dictationTarget, 61, 0, 1000);
      } catch { /* Recovery remains visible; never replay an uncertain key. */ }
    }
    active = null; output.clear(); output.close();
    recoveryWork = microphone ? microphone.restore().catch(() => {}) : Promise.resolve();
  };
  const reply = (event, message) => {
    if (!trusted(event)) return;
    const request = pending.get(message?.id);
    if (!request) return;
    clearTimeout(request.timer); pending.delete(message.id);
    message.error ? request.reject(fail(message.error, message.statusCode)) : request.resolve(message.result);
  };
  const pcm = (event, message) => {
    if (!trusted(event) || !active?.id || active.id !== message?.sessionId) return;
    if (!(message.samples instanceof Float32Array) || message.samples.length !== 960 ||
        !Number.isFinite(message.gain) || message.gain < 0 || message.gain > 4) { dispose(); return; }
    if (output.push(message.samples, message.gain)) { dispose(); return; }
    if (microphone && !active.inputStarted) {
      const session = active;
      session.inputStarted = true;
      session.inputReady = false;
      session.inputRequest = microphone.acquire().then(() => {
        if (active === session) session.inputReady = true;
      }).catch(error => { if (active === session) session.inputError = error.message; });
    }
  };
  const clear = (event, id) => { if (trusted(event) && active?.id === id) output.clear(); };
  const ended = (event, id) => { if (trusted(event) && active?.id === id) release(); };
  const dispose = () => {
    if (closed) return recoveryWork;
    closed = true; release();
    ipcMain.removeListener('voice:reply', reply); ipcMain.removeListener('voice:pcm', pcm); ipcMain.removeListener('voice:clear', clear);
    ipcMain.removeListener('voice:closed', ended);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(fail('音频客户端已关闭', 503)); }
    pending.clear();
    if (!window.isDestroyed()) window.destroy();
    return recoveryWork;
  };
  ipcMain.on('voice:reply', reply); ipcMain.on('voice:pcm', pcm); ipcMain.on('voice:clear', clear);
  ipcMain.on('voice:closed', ended);
  window.on('closed', dispose);
  window.webContents.on('render-process-gone', dispose);
  const request = (operation, owner, body) => new Promise((resolve, reject) => {
    if (closed) return reject(fail('音频客户端已关闭', 503));
    const id = randomUUID();
    const timer = setTimeout(dispose, 12000);
    pending.set(id, { resolve, reject, timer });
    window.webContents.send('voice:request', { id, operation, owner, body });
  });
  try { await window.loadFile(fileURLToPath(new URL('./rtc/engine.html', import.meta.url))); }
  catch (error) { dispose(); throw error; }
  return {
    window,
    keyboardPosted({ owner, key, target, uncertain }) {
      if (key !== 'RightOption' || !active || active.owner !== owner) return;
      if (uncertain) { active.dictationTarget = null; return; }
      active.dictationTarget = active.dictationTarget ? null : target.id;
    },
    get activeOwner() { return active?.owner ?? null; },
    config: getIceConfig,
    async offer(owner, description) {
      if (typeof owner !== 'string' || !owner) throw fail('需要认证身份', 401);
      if (active) throw fail('麦克风已被占用', 409);
      if (closed) throw fail('音频客户端已关闭', 503);
      const status = output.open();
      if (status) throw fail(`虚拟麦克风不可用 (${status})`, 503);
      const reservation = active = { owner, id: null };
      try {
        const config = await getIceConfig();
        if (active !== reservation) throw fail('会话已关闭', 409);
        const result = await request('offer', owner, { description, iceServers: config.iceServers });
        if (active !== reservation) throw fail('会话已关闭', 409);
        active.id = result.sessionId; return result;
      } catch (error) { if (active === reservation) release(); throw error; }
    },
    async control(operation, owner, body) {
      if (!['status', 'gain', 'stop', 'restart'].includes(operation)) throw fail('无效操作');
      if (!active || active.owner !== owner || active.id !== body?.sessionId) throw fail('未授权会话', 404);
      if (operation === 'restart') {
        const reservation = active;
        const config = await getIceConfig();
        if (active !== reservation) throw fail('会话已关闭', 409);
        return request(operation, owner, { ...body, iceServers: config.iceServers });
      }
      const session = active;
      if (operation === 'stop') {
        release();
        const result = await request(operation, owner, body);
        await recoveryWork;
        return { ...result, microphone: microphone?.snapshot() };
      }
      const result = await request(operation, owner, body);
      if (operation === 'status' && microphone) {
        const current = microphone.snapshot().devices.find(device => device.selected);
        return { ...result, inputSelected: Boolean(session.inputReady && current?.uid === 'VoiceDeckMicrophone_UID'),
          inputError: session.inputError || (session.inputReady && current?.uid !== 'VoiceDeckMicrophone_UID' ? '系统麦克风已被切换，听写输入可能已变化' : '') };
      }
      return result;
    },
    revoke(owner) {
      if (active?.owner !== owner) return;
      release();
      void request('revoke', owner, {}).catch(dispose);
    },
    close: dispose,
  };
}
