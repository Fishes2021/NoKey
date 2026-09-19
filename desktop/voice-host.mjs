// SPDX-License-Identifier: GPL-3.0-only
import { BrowserWindow, ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { KEY_CODES, MODIFIER_FLAGS } from '../mobile/lib/keyboard-shortcuts.mjs';
import { DEFAULT_DICTATION, normalizeDictation } from './dictation-settings.mjs';
const require = createRequire(import.meta.url);
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });

// Create only after Electron app.whenReady(). The caller supplies authenticated
// device identity and operator-owned domestic ICE configuration.
export async function createVoiceHost({ microphone, keyboard, getDictationSettings = () => DEFAULT_DICTATION, iceServers = [], getIceConfig = async () => ({ iceServers, expiresAt: null }), show = true } = {}) {
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
  let lastStop;
  const trusted = event => !window.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame;
  const release = () => {
    const session = active;
    active = null; // Own cleanup exactly once, including renderer close and lost stop replies.
    let dictationStopped = false, dictationError = '';
    if (session?.dictationTarget && keyboard) {
      try {
        const state = JSON.parse(keyboard.snapshot());
        if (!state.trusted || state.target?.id !== session.dictationTarget) throw Error('输入目标或权限已变化，未发送结束快捷键');
        const shortcut = session.dictationSettings;
        const flags = shortcut.modifiers.reduce((value, name) => value | MODIFIER_FLAGS[name], 0);
        const result = JSON.parse(keyboard.press(session.dictationTarget, KEY_CODES[shortcut.key], flags, 1000));
        dictationStopped = result.posted === true && result.target?.id === session.dictationTarget && !result.targetChangedDuringPost;
        if (!dictationStopped) throw Error('听写结束按键结果未确认，请在 Mac 检查');
      } catch (error) { dictationError = error.message; }
    } else if (session?.dictationManaged) dictationError = '听写状态未确认，未自动切换或发送';
    output.clear(); output.close();
    recoveryWork = Promise.resolve();
    const result = { dictationStopped, dictationError, sendDelayMs: session?.dictationSettings?.sendDelayMs ?? 350 };
    if (session?.id) lastStop = { owner: session.owner, id: session.id, until: Date.now() + 30000, result };
    return result;
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
      const selected = microphone.snapshot().devices.some(device => device.selected && device.uid === 'VoiceDeckMicrophone_UID');
      session.inputReady = selected;
      if (!selected) session.inputError = '系统未选择 NoKey 虚拟麦克风，请在桌面端检查音源';
      if (selected && session.startDictation) {
        const start = session.startDictation; session.startDictation = null;
        try {
          const reply = start(session.dictationSettings);
          const result = JSON.parse(reply.body);
          session.dictationLinked = reply.status === 200 && result.posted === true && !result.targetChangedDuringPost;
          if (session.dictationLinked) session.dictationTarget = result.target?.id;
          if (!session.dictationLinked) session.dictationError = result.error || '听写启动未确认';
        } catch { session.dictationError = '听写目标已过期或授权失效，本次仅传音'; }
      }
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
    keyboardPosted({ owner, key, modifiers = [] }) {
      if (!active?.dictationTarget || active.owner !== owner) return;
      const shortcut = active.dictationSettings;
      if (key === shortcut.key && JSON.stringify(modifiers) === JSON.stringify(shortcut.modifiers)) {
        active.dictationTarget = null; active.dictationLinked = false;
        active.dictationError = '语音快捷键被另外操作，听写状态待确认';
      }
    },
    get activeOwner() { return active?.owner ?? null; },
    config: getIceConfig,
    async offer(owner, description, startDictation = null) {
      if (typeof owner !== 'string' || !owner) throw fail('需要认证身份', 401);
      if (active) throw fail('麦克风已被占用', 409);
      if (closed) throw fail('音频客户端已关闭', 503);
      const dictationSettings = normalizeDictation(getDictationSettings());
      const status = output.open();
      if (status) throw fail(`虚拟麦克风不可用 (${status})`, 503);
      const reservation = active = { owner, id: null, startDictation, dictationSettings, dictationManaged: Boolean(startDictation), dictationLinked: false };
      try {
        const config = await getIceConfig();
        if (active !== reservation) throw fail('会话已关闭', 409);
        const result = await request('offer', owner, { description, iceServers: config.iceServers });
        if (active !== reservation) throw fail('会话已关闭', 409);
        active.id = result.sessionId; return { ...result, dictationManaged: active.dictationManaged };
      } catch (error) { if (active === reservation) release(); throw error; }
    },
    async control(operation, owner, body) {
      if (!['status', 'gain', 'stop', 'restart'].includes(operation)) throw fail('无效操作');
      if (operation === 'stop' && lastStop?.owner === owner && lastStop.id === body?.sessionId && lastStop.until > Date.now()) return { stopped: true, ...lastStop.result, microphoneHeld: true };
      if (!active || active.owner !== owner || active.id !== body?.sessionId) throw fail('未授权会话', 404);
      if (operation === 'restart') {
        const reservation = active;
        const config = await getIceConfig();
        if (active !== reservation) throw fail('会话已关闭', 409);
        return request(operation, owner, { ...body, iceServers: config.iceServers });
      }
      const session = active;
      if (operation === 'stop') {
        const stopped = release();
        const result = await request(operation, owner, body).catch(error => {
          if (error.statusCode === 404) return { stopped: true }; // Receiver may have closed before the stop message arrived.
          throw error;
        });
        await recoveryWork;
        return { ...result, ...stopped, microphoneHeld: true, microphone: microphone?.snapshot() };
      }
      const result = await request(operation, owner, body);
      if (operation === 'status' && microphone) {
        const current = microphone.snapshot().devices.find(device => device.selected);
        return { ...result, dictationManaged: session.dictationManaged, dictationLinked: session.dictationLinked, dictationError: session.dictationError || '', inputSelected: Boolean(session.inputReady && current?.uid === 'VoiceDeckMicrophone_UID'),
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
