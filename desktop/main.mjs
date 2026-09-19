// SPDX-License-Identifier: GPL-3.0-only
import { app, dialog, ipcMain, systemPreferences, shell, clipboard, Tray, Menu, nativeImage, screen } from 'electron';
import { mkdir, readFile, writeFile, chmod, copyFile, mkdtemp, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readLoginItem, setLoginItem } from './login-item.mjs';
import { createIceProvider } from './ice-provider.mjs';
import { createMicrophoneSelection } from './microphone-selection.mjs';
import { createVoiceHost } from './voice-host.mjs';
import { startBridge } from '../bridge/server.mjs';
import { setVoiceHost } from '../bridge/lib/voice-api.mjs';
import { DEFAULT_DICTATION, normalizeDictation } from './dictation-settings.mjs';
import { subscriptionRequest } from './subscription-client.mjs';
import { normalizeRelayOrigin } from '../bridge/lib/remote-relay.mjs';
const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode');
const correction = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel');

function qrImage(value) {
  const qr = new QRCode(-1, correction.M);
  qr.addData(value); qr.make();
  const count = qr.getModuleCount();
  let squares = '';
  for (let row = 0; row < count; row++) for (let col = 0; col < count; col++) {
    if (qr.isDark(row, col)) squares += `M${col + 4} ${row + 4}h1v1h-1z`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${count + 8} ${count + 8}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="${squares}" fill="black"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Caller owns app lifecycle. Tests use a loopback port and an isolated state directory.
export async function startDesktop({ stateDir = app.getPath('userData'), show = true,
  host = '0.0.0.0', port = 3210, confirmPairing } = {}) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const tokenPath = path.join(stateDir, 'bridge-token');
  let token;
  try { token = await readFile(tokenPath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    token = randomBytes(32).toString('base64url');
    await writeFile(tokenPath, token, { mode: 0o600, flag: 'wx' });
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('客户端身份文件损坏，请恢复备份');
  await chmod(tokenPath, 0o600);
  let config = {}, configError = false, configBackup = '', relayOrigin;
  const configPath = path.join(stateDir, 'connection.json');
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('连接配置格式无效');
    config = parsed;
    relayOrigin = config.relayOrigin ? normalizeRelayOrigin(config.relayOrigin) : undefined;
    config.relayOrigin = relayOrigin || '';
  } catch (error) { if (error.code !== 'ENOENT') configError = true; }
  let savingConnection = false, subscriptionBusy = false, subscription = null;
  const keyboardPreferencePath = path.join(stateDir, 'keyboard-enabled.json');
  let keyboardEnabled = false;
  try { keyboardEnabled = JSON.parse(await readFile(keyboardPreferencePath, 'utf8')) === true; }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('快捷控制设置读取失败，请检查客户端设置文件'); }
  const output = require('../build/desktop/voice-output.node');
  const keyboard = require('../build/desktop/keyboard.node');
  const dictationPath = path.join(stateDir, 'dictation.json');
  let dictation = normalizeDictation(DEFAULT_DICTATION), dictationError = '', savingDictation = false;
  try { dictation = normalizeDictation(JSON.parse(await readFile(dictationPath, 'utf8'))); }
  catch (error) { if (error.code !== 'ENOENT') dictationError = '语音快捷键配置无法读取，请重新保存设置'; }
  const microphone = await createMicrophoneSelection(output, stateDir);
  const voice = await createVoiceHost({ microphone, keyboard, show, getDictationSettings: () => { if (dictationError) throw new Error(dictationError); return dictation; }, getIceConfig: createIceProvider({ relayOrigin, stateDir }) });
  const window = voice.window;
  window.setSize(430, 560);
  window.setMinimumSize(390, 480);
  let tray;
  let stateTimer;
  let bridge, closing, shortcuts = false, devices = [];
  let savingKeyboard = false;
  const snapshot = details => {
    const deviceStatus = output.probe();
    return ({
    subscription, dictation, dictationError,
    microphone: microphone.snapshot(),
    deviceName: os.hostname(),
    qr: qrImage(details.pairingUrl), pairingText: details.pairingUrl, expiresAt: details.expiresAt,
    remoteStatus: details.remoteAccess.status, remoteError: details.remoteAccess.error, remoteRetryAt: details.remoteAccess.retryAt,
    remoteReady: details.remoteAccess.ready, relayConfigured: Boolean(relayOrigin),
    uninstallAvailable: app.isPackaged,
    loginItem: readLoginItem(app),
    configError, configBackup,
    relayOrigin: typeof config.relayOrigin === 'string' ? config.relayOrigin : '', connectionRestartRequired: !configError && (config.relayOrigin || '') !== (relayOrigin || ''),
    deviceReady: deviceStatus === 0, deviceStatus, shortcuts, devices, keyboardEnabled,
    keyboardTrusted: JSON.parse(keyboard.snapshot()).trusted,
  });
  };
  const publish = details => {
    if (!window.isDestroyed()) window.webContents.send('desktop:state', snapshot(details));
  };
  const updateDevices = async () => {
    if (!bridge) return;
    devices = await bridge.listDevices();
    publish(bridge.pairing());
  };
  const trusted = event => !window.isDestroyed() && event.sender === window.webContents &&
    event.senderFrame === window.webContents.mainFrame;
  const close = () => closing ??= Promise.resolve().then(async () => {
    clearInterval(stateTimer);
    keyboard.advertise?.(0);
    tray?.destroy();
    ipcMain.removeHandler('desktop:action');
    setVoiceHost(null);
    await voice.close();
    await bridge?.close();
    await microphone.restore().catch(() => {});
    const pending = microphone.snapshot();
    if (pending.recovery) await dialog.showMessageBox({ type: 'warning', title: '原麦克风尚未恢复',
      message: pending.message || '请重新连接原麦克风，或下次打开客户端选择恢复设备。',
      buttons: ['仍然退出，下次恢复'] });
  });
  try {
    setVoiceHost(voice);
    bridge = await startBridge({ embedded: true, stateDir, host, port, accessToken: token,
      remoteAccess: Boolean(relayOrigin), relayOrigin, keyboard, onKeyboardPosted: voice.keyboardPosted, voiceOwner: () => voice.activeOwner,
      onDeviceRevoked: keyId => voice.revoke(keyId),
      onDevicesChanged: () => { void updateDevices().catch(error => {
        if (!window.isDestroyed()) dialog.showErrorBox('设备列表读取失败', error.message);
      }); },
      confirmPairing: confirmPairing ?? (async ({ signal }) => {
        if (window.isDestroyed()) return false;
        const { response } = await dialog.showMessageBox(window, {
          signal, type: 'question', title: '允许手机配对', message: '允许刚刚扫码的手机连接这台 Mac？',
          detail: '请在 45 秒内选择。配对后，该手机可以发送麦克风声音，并使用你启用的快捷控制。',
          buttons: ['拒绝', '允许配对'], defaultId: 0, cancelId: 0,
        });
        return response === 1 && !window.isDestroyed();
      }), onPairingChanged: publish });
    bridge.setKeyboardEnabled(keyboardEnabled);
    keyboard.advertise?.(bridge.port);
    if (window.isDestroyed()) throw new Error('客户端窗口已关闭');
    ipcMain.handle('desktop:action', async (event, action, keyId) => {
      if (!trusted(event)) throw new Error('未授权窗口');
      if (action === 'stop-service') { await close(); app.quit(); return null; }
      else if (action === 'revoke') { await bridge.revokeDevice(keyId); await updateDevices(); }
      else if (action === 'microphone-restore') { await microphone.restore(); }
      else if (action === 'microphone-select') { await microphone.chooseRecovery(keyId); }
      else if (action === 'refresh') bridge.refreshPairing();
      else if (action === 'pairing-copy') {
        const details = bridge.pairing();
        if (details.expiresAt <= Date.now()) throw new Error('配对信息已过期，请刷新二维码');
        clipboard.writeText(details.pairingUrl);
      }
      else if (action === 'login-enable') setLoginItem(app, true);
      else if (action === 'login-disable') setLoginItem(app, false);
      else if (action === 'keyboard') {
        if (savingKeyboard) throw new Error('正在保存快捷控制设置，请稍候');
        savingKeyboard = true;
        const temporary = `${keyboardPreferencePath}.tmp`;
        try {
          const next = !keyboardEnabled;
          await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
          await rename(temporary, keyboardPreferencePath);
          keyboardEnabled = next; bridge.setKeyboardEnabled(next);
        } finally { savingKeyboard = false; await rm(temporary, { force: true }); }
      }
      else if (action === 'dictation-save') {
        if (savingDictation) throw new Error('正在保存语音快捷键');
        const next = normalizeDictation(keyId);
        savingDictation = true;
        const temporary = `${dictationPath}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600 });
          await rename(temporary, dictationPath);
          dictation = next; dictationError = '';
        } finally { savingDictation = false; await rm(temporary, { force: true }); }
      }
      else if (action === 'keyboard-permission') {
        // Open the actual setting; repeated AX prompt dialogs do not repair a stale grant.
        await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
      }
      else if (action === 'subscription-activate' || action === 'subscription-check') {
        if (subscriptionBusy) throw new Error('正在检查中继授权，请稍候');
        if (!config.relayOrigin) throw new Error('请先填写并保存服务地址；局域网不需要激活');
        subscriptionBusy = true;
        try { subscription = await subscriptionRequest({ origin: config.relayOrigin, stateDir,
          ...(action === 'subscription-activate' ? { code: keyId } : {}) }); }
        finally { subscriptionBusy = false; }
      }
      else if (action === 'connection-save') {
        if (savingConnection) throw new Error('正在保存连接设置，请稍候');
        if (typeof keyId !== 'string' || keyId.length > 2048) throw new Error('服务地址格式无效');
        let origin = '';
        try { if (keyId.trim()) origin = normalizeRelayOrigin(keyId); }
        catch { throw new Error('请输入 HTTPS 服务根地址，不含账号、路径、查询参数或片段'); }
        savingConnection = true;
        const temporary = path.join(stateDir, `connection-${randomBytes(8).toString('hex')}.tmp`);
        try {
          const next = { ...config, relayOrigin: origin };
          await writeFile(temporary, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
          if (configError && !configBackup) {
            const name = `connection-backup-${randomBytes(8).toString('hex')}.json`;
            await writeFile(path.join(stateDir, name), await readFile(configPath), { mode: 0o600, flag: 'wx' });
            configBackup = name;
          }
          await rename(temporary, configPath);
          config = next; configError = false; subscription = null;
        } finally { savingConnection = false; await rm(temporary, { force: true }); }
      }
      else if (action === 'uninstall') {
        if (!app.isPackaged) throw new Error('请使用一体化安装包中的卸载入口');
        const { response } = await dialog.showMessageBox(window, {
          type: 'question', title: '卸载 NoKey', message: '打开系统卸载向导？',
          detail: '将移除本客户端和本产品虚拟麦克风，保留个人配对配置及其他软件。请先为系统或录音应用选择其他麦克风。将关闭本产品登录启动；打开向导后本客户端将退出，卸载完成需重启；若取消卸载，可重新打开客户端。',
          buttons: ['取消', '打开卸载向导'], defaultId: 0, cancelId: 0,
        });
        if (response === 1) {
          if (readLoginItem(app).available) setLoginItem(app, false);
          const directory = await mkdtemp(path.join(app.getPath('temp'), 'voicedeck-uninstall-'));
          try {
            const target = path.join(directory, '卸载语音快捷键盘.pkg');
            await copyFile(path.join(process.resourcesPath, 'VoiceDeck-Uninstall.pkg'), target);
            const error = await shell.openPath(target);
            if (error) throw new Error(error);
          } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
          await close(); app.quit(); return null;
        }
      }
      else if (!['state', 'keyboard-check', 'device-check', 'login-check'].includes(action)) throw new Error('无效操作');
      return snapshot(bridge.pairing());
    });
    window.on('close', event => {
      if (!closing) { event.preventDefault(); window.hide(); }
    });
    window.on('closed', () => void close());
    // The existing renderer owns audio; hiding this window keeps that same receiver alive.
    if (show) {
      const icon = nativeImage.createFromPath(fileURLToPath(new URL('./assets/trayTemplate.png', import.meta.url)));
      icon.setTemplateImage(true);
      tray = new Tray(icon);
      tray.setToolTip('NoKey · 语音与快捷操作');
      tray.on('click', () => {
        if (window.isVisible()) { window.hide(); return; }
        const bounds = tray.getBounds();
        const area = screen.getDisplayMatching(bounds).workArea;
        const [width, height] = window.getSize();
        window.setPosition(Math.max(area.x, Math.min(bounds.x + bounds.width / 2 - width / 2, area.x + area.width - width)) | 0,
          Math.min(bounds.y + bounds.height + 4, area.y + area.height - height));
        window.show(); window.focus();
      });
      tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate([
        { label: '打开 NoKey', click: () => { window.show(); window.focus(); } },
        { label: '退出 NoKey', click: () => app.quit() },
      ])));
    }
    await microphone.acquire().catch(() => {});
    await updateDevices();
    let lastMicrophone = JSON.stringify(microphone.snapshot());
    stateTimer = setInterval(() => {
      const next = JSON.stringify(microphone.snapshot());
      if (next !== lastMicrophone && bridge && !window.isDestroyed()) {
        lastMicrophone = next; publish(bridge.pairing());
      }
    }, 2000);
    return { window, bridge, close };
  } catch (error) { await close(); throw error; }
}
