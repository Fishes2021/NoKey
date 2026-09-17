// Bounded client check: no system driver installation, microphone capture or Codex startup.
const { app } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../build/desktop/client-check-profile');
app.setPath('userData', root);
app.on('window-all-closed', () => {}); // Keep test runner alive between client launches.
let client, finished = false;
const watchdog = setTimeout(() => finish({ ok: false, error: 'Client test timeout' }), 20000);
async function finish(result) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  await client?.close();
  console.log(JSON.stringify(result));
  app.quit();
}
app.whenReady().then(async () => {
  const { startDesktop } = await import('./main.mjs');
  const stateDir = await fs.mkdtemp(path.join(root, 'identity-'));
  try {
    await fs.writeFile(path.join(stateDir, 'connection.json'), JSON.stringify({ futureSetting: 'retain' }));
    client = await startDesktop({ stateDir, show: false, host: '127.0.0.1', port: 0,
      confirmPairing: async () => true });
    const wc = client.window.webContents;
    const state = await wc.executeJavaScript("window.desktopClient.action('state')");
    assert.equal(state.relayConfigured, false);
    assert.equal(state.pairingText, client.bridge.pairing().pairingUrl);
    assert.equal(state.deviceName, require('node:os').hostname());
    assert.equal(await wc.executeJavaScript("document.getElementById('device-name').textContent"), '本机名称：' + state.deviceName);
    assert.equal(await wc.executeJavaScript("document.getElementById('pairing-text').value"), state.pairingText);
    wc.send('desktop:state', { ...state, expiresAt: 0 });
    assert(await wc.executeJavaScript("document.getElementById('pairing-copy').disabled && document.getElementById('pairing-text').value === ''"));
    wc.send('desktop:state', state);

    assert.equal(state.shortcuts, false);
    wc.send('desktop:state', { ...state, relayConfigured: true, remoteStatus: 'offline', remoteReady: false, remoteError: 'Unexpected server response: 401', remoteRetryAt: Date.now() + 10000 });
    assert(await wc.executeJavaScript("document.getElementById('network').textContent.includes('自动重试')"));
    assert(await wc.executeJavaScript("!document.getElementById('network-diagnostics').hidden && document.getElementById('network-error').textContent.includes('401')"));
    wc.send('desktop:state', state);
    assert(await wc.executeJavaScript("document.getElementById('network-diagnostics').hidden"));

    assert.equal(state.uninstallAvailable, false);
    assert.equal(await wc.executeJavaScript("document.getElementById('stop-service').textContent"), '退出 NoKey');
    assert.equal(state.loginItem.available, false);
    wc.send('desktop:state', { ...state, loginItem: { available: true, status: 'requires-approval' } });
    assert(await wc.executeJavaScript("document.getElementById('login-enable').disabled && !document.getElementById('login-disable').disabled && document.getElementById('login-status').textContent.includes('等待系统允许')"));
    wc.send('desktop:state', state);

    assert(await wc.executeJavaScript("document.getElementById('login-enable').disabled && document.getElementById('login-disable').disabled"));
    await assert.rejects(wc.executeJavaScript("window.desktopClient.action('login-enable')"), /应用程序目录/);

    assert(await wc.executeJavaScript("document.getElementById('uninstall').disabled"));
    await assert.rejects(wc.executeJavaScript("window.desktopClient.action('uninstall')"), /一体化安装包/);
    assert.equal(state.keyboardEnabled, false);
    for (const invalid of ['http://relay.example', 'https://relay.example/path', 'https://user:pass@relay.example', 'https://relay.example?q=1', 42]) {
      await assert.rejects(wc.executeJavaScript("window.desktopClient.action('connection-save', " + JSON.stringify(invalid) + ")"), /地址/);
    }
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'connection.json'), 'utf8')), { futureSetting: 'retain' });
    await wc.executeJavaScript(`document.getElementById('relay-origin').value = 'https://RELAY.example/'; document.getElementById('relay-origin').dispatchEvent(new Event('input')); document.getElementById('connection-form').requestSubmit()`);
    let saved;
    for (let n = 0; n < 100; n++) {
      saved = await wc.executeJavaScript("window.desktopClient.action('state')");
      if (saved.relayOrigin === 'https://relay.example') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(saved.relayOrigin, 'https://relay.example');
    assert.equal(saved.connectionRestartRequired, true);
    assert.equal(saved.relayConfigured, false); // Saving does not connect to external services.
    assert.equal((await fs.stat(path.join(stateDir, 'connection.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'connection.json'), 'utf8')), { futureSetting: 'retain', relayOrigin: 'https://relay.example' });
    assert(await wc.executeJavaScript("document.getElementById('connection-status').textContent.includes('设置已保存')"));
    const cleared = await wc.executeJavaScript("window.desktopClient.action('connection-save', '')");
    assert.equal(cleared.connectionRestartRequired, false);
    assert.equal(cleared.relayOrigin, '');
    const configPath = path.join(stateDir, 'connection.json');
    await fs.rename(configPath, configPath + '.backup');
    await fs.mkdir(configPath);
    await assert.rejects(wc.executeJavaScript("window.desktopClient.action('connection-save', 'https://failure.example')"));
    assert.equal((await wc.executeJavaScript("window.desktopClient.action('state')")).relayOrigin, '');
    assert(!(await fs.readdir(stateDir)).some(name => name.endsWith('.tmp')));
    await fs.rmdir(configPath);
    await fs.rename(configPath + '.backup', configPath);
    wc.send('voice:request', { id: 'view-check', operation: 'status', owner: 'test', body: { sessionId: 'missing' } });
    for (let n = 0; n < 100; n++) {
      if (await wc.executeJavaScript("document.getElementById('audio-error').textContent.includes('会话不存在')")) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert(await wc.executeJavaScript("document.getElementById('audio-error').textContent.includes('会话不存在')"));
    assert.equal(await wc.executeJavaScript("document.getElementById('state').textContent"), '等待手机开始讲话');
    assert.equal(await wc.executeJavaScript("document.querySelector('meter')"), null);
    wc.send('voice:request', { id: 'view-reset', operation: 'revoke', owner: 'test', body: {} });
    const nativeOutput = require('../build/desktop/voice-output.node');
    assert.equal(state.deviceStatus, nativeOutput.probe());
    const beforeDeviceCheck = client.bridge.pairing().pairingUrl;
    await wc.executeJavaScript("document.getElementById('device-check').click()");
    // Same IPC queue; rendering completes before inspecting the button result.
    const checked = await wc.executeJavaScript("window.desktopClient.action('state')");
    assert.equal(checked.deviceReady, checked.deviceStatus === 0);
    assert.equal(client.bridge.pairing().pairingUrl, beforeDeviceCheck);
    assert.equal(await wc.executeJavaScript("document.getElementById('device-install-help').hidden"), checked.deviceReady);
    assert.equal(await wc.executeJavaScript("document.getElementById('device-select-help').hidden"), !checked.deviceReady);
    assert(await wc.executeJavaScript("document.getElementById('device-code').textContent.includes('VoiceDeckMicrophone_UID')"));
    const keyboardOn = await wc.executeJavaScript("window.desktopClient.action('keyboard')");
    assert.equal(keyboardOn.keyboardEnabled, true);
    assert.equal(keyboardOn.shortcuts, false); // Generic keyboard does not start Codex.
    const keyboardOff = await wc.executeJavaScript("window.desktopClient.action('keyboard')");
    assert.equal(keyboardOff.keyboardEnabled, false);
    await wc.executeJavaScript("window.desktopClient.action('keyboard-check')");
    assert(await wc.executeJavaScript("document.getElementById('keyboard-permission').textContent.includes('辅助功能')"));

    assert(state.qr.startsWith('data:image/svg+xml;base64,'));
    assert.equal((await fs.stat(path.join(stateDir, 'bridge-token'))).mode & 0o777, 0o600);
    const { sealE2EE } = await import('../bridge/lib/e2ee.mjs');
    const url = new URL(client.bridge.pairing().pairingUrl);
    const material = Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
    await fetch(`http://127.0.0.1:${client.bridge.port}/api/e2ee/pair`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ envelope: sealE2EE(material, 'pair', {
        requestId: require('node:crypto').randomUUID(), issuedAt: Date.now(), code: url.searchParams.get('code'),
      }) }) });
    // The renderer action awaits the same device list read used by the local UI.
    const deviceState = await wc.executeJavaScript("window.desktopClient.action('state')");
    assert.equal(deviceState.devices.length, 1);
    await wc.executeJavaScript("document.querySelector('#devices button').click()");
    const revoked = await wc.executeJavaScript("window.desktopClient.action('revoke', " + JSON.stringify(material.keyId) + ")");
    assert.deepEqual(revoked.devices, []);
    const old = client.bridge.pairing().pairingUrl;
    await wc.executeJavaScript("document.getElementById('refresh').click()");
    // Wait for actual IPC completion, then inspect the rendered state.
    await wc.executeJavaScript("window.desktopClient.action('state')");
    assert.notEqual(client.bridge.pairing().pairingUrl, old);
    const view = await wc.executeJavaScript("({ network: document.getElementById('network').textContent, qr: document.getElementById('qr').hidden, error: document.getElementById('error').textContent })");
    assert(view.network.includes('局域网'));
    assert.equal(view.qr, false);
    assert.equal(view.error, '');
    await assert.rejects(wc.executeJavaScript("window.desktopClient.action('arbitrary-command')"), /无效操作/);
    await fs.writeFile(path.resolve(__dirname, '../build/desktop/client-preview.png'), (await wc.capturePage()).toPNG());
    await wc.executeJavaScript("document.getElementById('audio-title').scrollIntoView()");
    await fs.writeFile(path.resolve(__dirname, '../build/desktop/audio-guide-preview.png'), (await wc.capturePage()).toPNG());
    const port = client.bridge.port;
    await client.close();
    await client.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/health`));
    const savedToken = await fs.readFile(path.join(stateDir, 'bridge-token'), 'utf8');
    client = await startDesktop({ stateDir, show: false, host: '127.0.0.1', port: 0, confirmPairing: async () => true });
    assert.equal(await fs.readFile(path.join(stateDir, 'bridge-token'), 'utf8'), savedToken);
    const nextPort = client.bridge.port;
    client.window.close();
    assert.equal(client.window.isDestroyed(), false, 'close must hide the audio owner window');
    assert.equal(client.window.isVisible(), false);
    assert.equal((await fetch(`http://127.0.0.1:${nextPort}/health`)).status, 200);
    await client.window.webContents.executeJavaScript("document.getElementById('settings-toggle').click()");
    assert.equal(await client.window.webContents.executeJavaScript("document.getElementById('settings').hidden"), false);
    await client.close();
    await assert.rejects(fetch(`http://127.0.0.1:${nextPort}/health`));
    for (const broken of ['{broken json', JSON.stringify({ relayOrigin: 'http://invalid.example', retain: 1 })]) {
      await fs.writeFile(configPath, broken);
      client = await startDesktop({ stateDir, show: false, host: '127.0.0.1', port: 0 });
      const recovery = client.window.webContents;
      const initial = await recovery.executeJavaScript("window.desktopClient.action('state')");
      assert.equal(initial.configError, true);
      assert.equal(initial.relayConfigured, false);
      assert(await recovery.executeJavaScript("document.getElementById('connection-config-error').textContent.includes('备份失败则不覆盖')"));
      assert.equal(await fs.readFile(configPath, 'utf8'), broken, 'startup never rewrites failed configuration');
      const fixed = await recovery.executeJavaScript("window.desktopClient.action('connection-save', '')");
      assert.equal(fixed.configError, false);
      assert.match(fixed.configBackup, /^connection-backup-[a-f0-9]+\.json$/);
      assert.equal(await fs.readFile(path.join(stateDir, fixed.configBackup), 'utf8'), broken);
      assert.equal((await fs.stat(path.join(stateDir, fixed.configBackup))).mode & 0o777, 0o600);
      if (broken.includes('retain')) assert.equal(JSON.parse(await fs.readFile(configPath, 'utf8')).retain, 1);
      await client.close();
    }
    await fs.rm(configPath); await fs.mkdir(configPath);
    client = await startDesktop({ stateDir, show: false, host: '127.0.0.1', port: 0 });
    await assert.rejects(client.window.webContents.executeJavaScript("window.desktopClient.action('connection-save', '')"));
    assert((await fs.stat(configPath)).isDirectory(), 'failed backup must not replace original path');
    assert.equal((await client.window.webContents.executeJavaScript("window.desktopClient.action('state')")).configError, true);
    assert(!(await fs.readdir(stateDir)).some(name => name.endsWith('.tmp')));
    await client.close();
    await finish({ ok: true, message: 'Mac client passed: rendered pairing, refresh IPC, identity permissions, action limits and normal shutdown.' });
  } finally { await fs.rm(stateDir, { recursive: true, force: true }); }
}).catch(error => finish({ ok: false, error: error.stack }));
