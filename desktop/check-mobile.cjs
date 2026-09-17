// Real exported phone UI + embedded bridge, bounded and isolated; no native capture or Codex.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const build = path.resolve(__dirname, '../build');
app.setPath('userData', path.join(build, 'desktop/mobile-check-profile'));
app.on('window-all-closed', () => {});
let window, bridge, server, stateDir, finished = false;
const timeout = setTimeout(() => finish({ ok: false, error: 'Mobile UI check timed out' }), 25000);
async function finish(result) {
  if (finished) return;
  finished = true; clearTimeout(timeout);
  window?.destroy();
  await bridge?.close();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  if (stateDir) await fs.rm(stateDir, { recursive: true, force: true });
  console.log(JSON.stringify(result)); app.quit();
}
app.whenReady().then(async () => {
  const { startBridge } = await import('../bridge/server.mjs');
  const { sealE2EE } = await import('../bridge/lib/e2ee.mjs');
  stateDir = await fs.mkdtemp(path.join(build, 'desktop/mobile-identity-'));
  const accessToken = randomUUID();
  const keyCalls = [];
  let keyTarget = { id: 'test-front-app', name: '测试编辑器', bundleId: 'test.editor' };
  const keyboard = { snapshot: () => JSON.stringify({ trusted: true, target: keyTarget }),
    press: (target, key, flags) => { keyCalls.push({ target, key, flags }); return JSON.stringify({ posted: true, target: keyTarget }); } };
  bridge = await startBridge({ keyboard, embedded: true, port: 0, host: '127.0.0.1', stateDir, accessToken, confirmPairing: async () => true });
  bridge.setKeyboardEnabled(true);
  const base = `http://127.0.0.1:${bridge.port}`;
  const invitation = new URL(bridge.pairing().pairingUrl);
  const material = Object.fromEntries(new URLSearchParams(invitation.hash.slice(1)));
  const paired = await fetch(base + '/api/e2ee/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: sealE2EE(material, 'pair', { requestId: randomUUID(), issuedAt: Date.now(), code: invitation.searchParams.get('code') }) }) });
  assert.equal(paired.status, 200);
  const root = path.resolve(process.env.VOICEDECK_MOBILE_EXPORT || path.join(build, 'mobile-export'));
  server = http.createServer(async (req, res) => {
    try {
      const name = new URL(req.url, 'http://localhost').pathname;
      if (name === '/__test_blank') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html>'); return; }
      const file = path.resolve(root, '.' + decodeURIComponent(name === '/' ? '/index.html' : name));
      if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
      res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.svg': 'image/svg+xml' })[path.extname(file)] || 'application/octet-stream');
      res.end(await fs.readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const isolated = session.fromPartition('mobile-ui-' + randomUUID());
  isolated.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  let bridgeRequests = 0;
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    if (url.origin === base && url.pathname.startsWith('/api/')) bridgeRequests++;
    callback({ cancel: ['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && ![origin, base, base.replace('http:', 'ws:')].includes(url.origin) });
  });
  const openWindow = () => {
    window = new BrowserWindow({ show: false, width: 390, height: 844, useContentSize: true,
      webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const execute = window.webContents.executeJavaScript.bind(window.webContents);
    window.webContents.executeJavaScript = async (...args) => {
      const caller = new Error('UI call site').stack;
      try { return await execute(...args); } catch (error) { throw new Error(error.message + '\n' + caller); }
    };
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('render-process-gone', (_event, info) => finish({ ok: false, error: info.reason }));
  };
  const waitFor = async expression => {
    for (let i = 0; i < 120; i++) {
      if (await window.webContents.executeJavaScript(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('UI state not reached: ' + expression + '\n' + await window.webContents.executeJavaScript('document.body.innerText.slice(0, 1800)'));
  };
  const gainKey = `voicedeck.gain.${material.keyId}`;
  openWindow(); await window.loadURL(origin + '/__test_blank');
  const oldLayout = [{ keycapId: 'FAST', label: '旧布局', action: { type: 'command', commandId: 'composer.toggleFastMode' } }, null, null, null, null, null];
  const saved = { 'microdex.programmable.keys.v2': JSON.stringify(oldLayout), 'microdex.bridge.url': base, 'microdex.bridge.token': accessToken,
    'microdex.bridge.e2ee.v1': JSON.stringify(material), [gainKey]: '0.5' };
  await window.webContents.executeJavaScript(`Object.entries(${JSON.stringify(saved)}).forEach(([key, value]) => localStorage.setItem(key, value))`);
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Page.enable');
  const injected = await window.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: `
    const originalGetItem = Storage.prototype.getItem;
    window.restoreStorageRead = () => { Storage.prototype.getItem = originalGetItem; };
    Storage.prototype.getItem = function(key) { if (key === 'microdex.bridge.e2ee.v1') throw new Error('test storage unavailable'); return originalGetItem.call(this, key); };
  ` });
  await window.loadURL(origin);
  assert.equal(await window.webContents.executeJavaScript('typeof window.restoreStorageRead'), 'function', 'failure injection ran before application startup');
  await waitFor("document.body.innerText.includes('暂时无法读取配对信息')");
  assert.equal(bridgeRequests, 0, 'no request with partially loaded credentials');
  await window.webContents.executeJavaScript('window.restoreStorageRead(); void 0');
  assert.notEqual(await window.webContents.executeJavaScript("localStorage.getItem('microdex.bridge.e2ee.v1')"), null);
  await window.webContents.debugger.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
  window.webContents.debugger.detach();
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="重试读取配对信息"]').click()`);
  await waitFor("Boolean(document.querySelector('[aria-label=\"开始讲话\"]'))");
  assert(await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify('Mac 已连接')})`));
  assert(await window.webContents.executeJavaScript(`document.body.innerText.includes('填入到：') && document.body.innerText.includes('结果显示在 Mac')`));
  assert(await window.webContents.executeJavaScript(`!document.querySelector('[aria-label="Open Codex chat switcher"]') && !document.body.innerText.includes('Codex 任务')`));

  assert.equal(await window.webContents.executeJavaScript(`document.querySelectorAll('[aria-label="开始讲话"]').length`), 1);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="打开 NoKey 设置"]').click()`);
  await waitFor("document.body.innerText.includes('输入音量 50%')");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="增大音量"]').click()`);
  await waitFor(`localStorage.getItem(${JSON.stringify(gainKey)}) === '0.75' && document.body.innerText.includes('音量已保存')`);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Close settings"]').click()`);
  await waitFor("document.body.innerText.includes('按键目标：测试编辑器')");
  const keysKey = `voicedeck.keys.${material.keyId}`;
  const clickSelector = async selector => {
    const find = `document.querySelector(${JSON.stringify(selector)})`;
    await waitFor(`Boolean(${find})`);
    await window.webContents.executeJavaScript(`${find}.scrollIntoView({ block: 'nearest', inline: 'nearest' })`);
    await waitFor(`(() => { const e = ${find}; const r = e.getBoundingClientRect(); const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return r.width > 0 && r.height > 0 && (e === hit || e.contains(hit)); })()`);
    await window.webContents.executeJavaScript(`${find}.click()`);
  };
  const click = label => clickSelector(`[aria-label="${label}"]`);
  for (const label of ['开始讲话']) {
    await click(label);
    await waitFor("document.body.innerText.includes('实时手机麦克风目前仅支持 iPhone 安装版')");
    assert(!(await window.webContents.executeJavaScript('document.body.innerText')).includes('NOT NOW'));
  }

  await click('打开 NoKey 设置');
  await waitFor(`Array.from(document.querySelectorAll('[role="button"]')).some(e => e.textContent === 'Customize keys')`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === 'Customize keys').click()`);
  await waitFor(`Boolean(document.querySelector('[aria-label^="Change key 1,"]'))`);
  await clickSelector('[aria-label^="Change key 1,"]');
  await waitFor(`Boolean(document.querySelector('[aria-label="Mac 通用快捷键"]'))`);
  await click('Mac 通用快捷键');
  await click('修饰键 command');
  await click('主键 V');
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="快捷键显示名称"]').focus(); document.querySelector('[aria-label="快捷键显示名称"]').select()`);
  await window.webContents.insertText('粘贴');
  await new Promise(resolve => setTimeout(resolve, 350));
  await fs.writeFile(path.join(build, 'desktop/shortcut-editor-preview.png'), (await window.webContents.capturePage()).toPNG());
  await click('保存快捷键');
  await waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(keysKey)}) || '[]')[0]?.label === '粘贴'`);
  const assignment = await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem(${JSON.stringify(keysKey)}))[0]`);
  assert.deepEqual(assignment.action, { type: 'shortcut', key: 'V', modifiers: ['command'] });
  assert.equal(keyCalls.length, 0);
  await waitFor(`Boolean(document.querySelector('[aria-label="粘贴"]'))`);
  await clickSelector('[aria-label="粘贴"]');
  await waitFor("document.body.innerText.includes('按键已投递，应用执行结果未确认')");
  assert.deepEqual(keyCalls, [{ target: 'test-front-app', key: 9, flags: 1 << 20 }]);
  // These calls stop at a fake native binding; no keys reach this Mac's apps.
  keyTarget = { id: 'other-front-app', name: '另一应用', bundleId: 'test.other' };
  await waitFor("document.body.innerText.includes('另一应用')");
  bridge.setKeyboardEnabled(false);
  await waitFor("document.body.innerText.includes('等待 Mac 输入目标')");
  await clickSelector('[aria-label="粘贴"]');
  await waitFor("document.body.innerText.includes('未发送')");
  assert.equal(keyCalls.length, 1);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  await fs.writeFile(path.join(build, 'desktop/mobile-preview.png'), (await window.webContents.capturePage()).toPNG());
  window.destroy(); openWindow(); await window.loadURL(origin);
  await waitFor("Boolean(document.querySelector('[aria-label=\"打开 NoKey 设置\"]'))");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="打开 NoKey 设置"]').click()`);
  await waitFor("document.body.innerText.includes('输入音量 75%')");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Close settings"]').click()`);
  await waitFor(`Boolean(document.querySelector('[aria-label="粘贴"]'))`);
  assert.equal(keyCalls.length, 1);
  await window.webContents.executeJavaScript(`localStorage.setItem(${JSON.stringify(gainKey)}, 'NaN')`);
  await window.loadURL(origin);
  await waitFor("Boolean(document.querySelector('[aria-label=\"打开 NoKey 设置\"]'))");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="打开 NoKey 设置"]').click()`);
  await waitFor("document.body.innerText.includes('输入音量 100%')");
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Close settings"]').click()`);
  const otherInvitation = new URL(bridge.refreshPairing().pairingUrl);
  const otherMaterial = Object.fromEntries(new URLSearchParams(otherInvitation.hash.slice(1)));
  const otherPair = await fetch(base + '/api/e2ee/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope: sealE2EE(otherMaterial, 'pair', { requestId: randomUUID(), issuedAt: Date.now(), code: otherInvitation.searchParams.get('code') }) }) });
  assert.equal(otherPair.status, 200);
  await window.webContents.executeJavaScript(`localStorage.setItem('microdex.bridge.e2ee.v1', ${JSON.stringify(JSON.stringify(otherMaterial))})`);
  await window.loadURL(origin);
  await waitFor(`Boolean(document.querySelector('[aria-label="Esc"]'))`);
  assert.equal(await window.webContents.executeJavaScript(`localStorage.getItem(${JSON.stringify('voicedeck.keys.' + otherMaterial.keyId)})`), null);
  await window.webContents.executeJavaScript(`localStorage.setItem('microdex.bridge.e2ee.v1', ${JSON.stringify(JSON.stringify(material))})`);
  await window.loadURL(origin);
  await waitFor(`Boolean(document.querySelector('[aria-label="粘贴"]'))`);
  assert.equal(keyCalls.length, 1);
  await click('打开 NoKey 设置');
  await waitFor(`Array.from(document.querySelectorAll('[role="button"]')).some(e => e.textContent === 'Customize keys')`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === 'Customize keys').click()`);
  await click('恢复默认快捷键');
  await waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(keysKey)}) || '[]')[0]?.action?.key === 'Escape'`);
  assert.equal(await window.webContents.executeJavaScript(`JSON.parse(localStorage.getItem(${JSON.stringify(keysKey)})).length`), 10);
  await click('Close key manager');
  bridge.setKeyboardEnabled(true);
  await waitFor("document.body.innerText.includes('另一应用')");
  await click('发送');
  await waitFor("document.body.innerText.includes('按键已投递')");
  assert.equal(keyCalls.at(-1).key, 36);
  await click('切换应用，长按切换窗口');
  await waitFor("document.body.innerText.includes('按键已投递')");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(keyCalls.at(-1).key, 48);
  assert.equal(keyCalls.at(-1).flags, 1 << 20);
  const layout = await window.webContents.executeJavaScript(`(() => {
    const mic = document.querySelector('[aria-label="开始讲话"]');
    const r = mic.getBoundingClientRect();
    return { microphones: document.querySelectorAll('[aria-label="开始讲话"]').length, width: r.width, height: r.height,
      buttons: ['全选', '复制', '撤销', '切换应用，长按切换窗口', '发送'].map(label => {
        const r = document.querySelector('[aria-label="' + label + '"]').getBoundingClientRect(); return {label,width:r.width,height:r.height};
      }) };
  })()`);
  assert.equal(layout.microphones, 1); assert(layout.height >= 64 && layout.width > 300);
  assert(layout.buttons.every(button => button.width >= 44 && button.height >= 44));
  await fs.writeFile(path.join(build, 'desktop/generic-deck-layout.json'), JSON.stringify(layout, null, 2));
  await fs.writeFile(path.join(build, 'desktop/generic-deck-preview.png'), (await window.webContents.capturePage()).toPNG());
  // Exercise real gesture handlers against the fake native bridge, never the user's apps.
  const joystickPoint = async () => window.webContents.executeJavaScript(`(() => {
    const r = document.querySelector('[aria-label="四向自定义摇杆"]').getBoundingClientRect();
    return { x: Math.round(r.x + r.width * 0.87), y: Math.round(r.y + r.height / 2) };
  })()`);
  let point = await joystickPoint();
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  await new Promise(resolve => setTimeout(resolve, 650));
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  await waitFor(`Boolean(document.querySelector('[aria-label="配置摇杆右"]'))`);
  await click('配置摇杆右');
  await click('主键 F'); await click('修饰键 command');
  await click('保存快捷键');
  await waitFor(`JSON.parse(localStorage.getItem(${JSON.stringify(keysKey)}) || '[]')[7]?.action?.key === 'F'`);
  await waitFor(`!document.querySelector('[aria-label="保存快捷键"]')`);
  await new Promise(resolve => setTimeout(resolve, 350));
  const beforeJoystick = keyCalls.length;
  point = await joystickPoint();
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  for (let i = 0; i < 30 && keyCalls.length === beforeJoystick; i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(keyCalls.length, beforeJoystick + 1);
  assert.equal(keyCalls.at(-1).key, 3); assert.equal(keyCalls.at(-1).flags, 1 << 20);
  await fs.writeFile(path.join(build, 'desktop/joystick-preview.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('microdex.ai-data-consent.v1')"), null);
  assert(!(await window.webContents.executeJavaScript('document.body.innerText')).includes('AI data processing'));
  await click('打开 NoKey 设置');
  await window.webContents.executeJavaScript(`window.savedRemoveItem = Storage.prototype.removeItem; Storage.prototype.removeItem = function() { throw new Error('simulated storage failure'); }; void 0;`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === 'Forget this Mac and consent').click()`);
  await waitFor("document.body.innerText.includes('保存的配对数据未能清除')");
  await waitFor("document.body.innerText.includes('连接你的 Mac') && !document.querySelector('[aria-label=\"开始讲话\"]')");
  assert.notEqual(await window.webContents.executeJavaScript("localStorage.getItem('microdex.bridge.token')"), null, 'failed cleanup must not claim persisted credentials removed');
  await window.webContents.executeJavaScript(`Storage.prototype.removeItem = window.savedRemoveItem; delete window.savedRemoveItem;`);
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === 'Forget this Mac and consent').click()`);
  await waitFor("localStorage.getItem('microdex.bridge.token') === null && localStorage.getItem('microdex.bridge.e2ee.v1') === null");
  assert(await window.webContents.executeJavaScript("document.body.innerText.includes('扫描配对二维码')"));
  assert(!(await window.webContents.executeJavaScript("document.body.innerText")).includes('npx microdex'));
  await waitFor("!document.querySelector('[aria-label=\"Close settings\"]')");
  await fs.writeFile(path.join(build, 'desktop/pairing-guide-preview.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`Array.from(document.querySelectorAll('[role="button"]')).find(e => e.textContent === '扫描配对二维码').click()`);
  await waitFor("document.body.innerText.includes('请在 iPhone 安装版')");
  assert(!(await window.webContents.executeJavaScript("document.body.innerText")).includes('NOT NOW'));
  const beforeCorruptRead = bridgeRequests;
  await window.webContents.executeJavaScript(`localStorage.setItem('microdex.bridge.url', ${JSON.stringify(base)}); localStorage.setItem('microdex.bridge.token', 'test-retained-token'); localStorage.setItem('microdex.bridge.e2ee.v1', 'malformed');`);
  await window.loadURL(origin);
  await waitFor("document.body.innerText.includes('暂时无法读取配对信息')");
  assert.equal(bridgeRequests, beforeCorruptRead);
  assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('microdex.bridge.e2ee.v1')"), 'malformed');
  await fs.writeFile(path.join(build, 'desktop/pairing-read-error.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="改为重新配对"]').click()`);
  await waitFor("document.body.innerText.includes('扫描配对二维码')");
  assert.equal(bridgeRequests, beforeCorruptRead);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="手动输入配对信息"]').click()`);
  await waitFor(`Boolean(document.querySelector('[aria-label="限时配对信息"]'))`);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="限时配对信息"]').focus()`);
  await window.webContents.insertText('invalid pairing');
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="使用配对信息连接"]').click()`);
  await waitFor("document.body.innerText.includes('配对信息无效')");
  assert.equal(bridgeRequests, beforeCorruptRead);
  const manualUrl = new URL(bridge.refreshPairing().pairingUrl);
  // The fixture listens only on loopback; retain the real invitation secrets.
  manualUrl.host = new URL(base).host;
  const manualInvitation = manualUrl.toString();
  const manualMaterial = Object.fromEntries(new URLSearchParams(new URL(manualInvitation).hash.slice(1)));
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="限时配对信息"]').focus(); document.querySelector('[aria-label="限时配对信息"]').select()`);
  await window.webContents.insertText(manualInvitation);
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="使用配对信息连接"]').click()`);
  await waitFor("document.body.innerText.includes('确认要连接的 Mac')");
  assert(await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(require('node:os').hostname())})`));
  assert.equal(bridgeRequests, beforeCorruptRead, 'confirmation precedes network pairing');
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="取消此次配对"]').click()`);
  await waitFor("!document.body.innerText.includes('确认要连接的 Mac')");
  assert.equal(bridgeRequests, beforeCorruptRead, 'cancel makes no pairing request');
  await new Promise(resolve => setTimeout(resolve, 350));
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="使用配对信息连接"]').click()`);
  await waitFor("document.body.innerText.includes('确认要连接的 Mac')");
  await new Promise(resolve => setTimeout(resolve, 350));
  await fs.writeFile(path.join(build, 'desktop/pairing-confirmation.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="确认连接此 Mac"]').click()`);
  await waitFor(`(() => { try { return JSON.parse(localStorage.getItem('microdex.bridge.e2ee.v1') || '{}').keyId === ${JSON.stringify(manualMaterial.keyId)} && document.body.innerText.includes('填入到：'); } catch { return false; } })()`);
  assert((await bridge.listDevices()).some(device => device.keyId === manualMaterial.keyId));
  assert.equal(await window.webContents.executeJavaScript("localStorage.getItem('microdex.ai-data-consent.v1')"), null);
  await finish({ ok: true, message: 'Phone UI: real E2EE bridge connection, volume, shortcut editing/per-device save, authenticated key delivery, target refresh, disabled rejection, window reopening, pairing isolation and restoring defaults passed (native key binding simulated).' });
}).catch(error => finish({ ok: false, error: error.stack }));
