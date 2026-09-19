// Inspect and launch the extracted package, without installing it or touching
// the normal user profile. All listeners are temporary loopback test endpoints.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, readdir, lstat, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
const root = fileURLToPath(new URL('../', import.meta.url));
const artifact = JSON.parse(await readFile(path.join(root, 'build/desktop/package-latest.json'), 'utf8'));
const withDriver = artifact.withDriver !== false;
assert(artifact.work.startsWith(path.join(root, 'build/package-')));
const check = await mkdtemp(path.join(artifact.work, 'check-'));
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout;
}
const expanded = path.join(check, 'expanded');
run('pkgutil', ['--expand-full', artifact.pkg, expanded]);
const payload = path.join(expanded, 'payload.pkg/Payload');
const bundle = path.join(payload, 'Applications/NoKey.app');
const appRoot = path.join(bundle, 'Contents/Resources/app');
const driver = path.join(payload, 'Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver');
for (const relative of ['desktop/assets/trayTemplate.png', 'desktop/assets/trayTemplate@2x.png', 'desktop/main.mjs', 'desktop/microphone-selection.mjs', 'desktop/voice-host.mjs', 'desktop/login-item.mjs', 'desktop/rtc/engine.js', 'desktop/rtc/receiver.js', 'bridge/server.mjs', 'bridge/lib/remote-relay.mjs', 'bridge/lib/remote-message-queue.mjs', 'bridge/lib/control-session.mjs', 'bridge/lib/pairing-confirmation.mjs']) {
  assert.deepEqual(await readFile(path.join(appRoot, relative)), await readFile(path.join(root, relative)), `stale packaged source: ${relative}`);
}

const licenses = path.join(bundle, 'Contents/Resources/Licenses');
const runtimeNotices = JSON.parse(await readFile(path.join(licenses, 'runtime-dependencies.json'), 'utf8'));
const rootManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
assert.deepEqual(runtimeNotices.map(item => item.name).sort(), Object.keys(rootManifest.dependencies).sort());
for (const item of runtimeNotices) {
  const dependency = path.join(root, 'node_modules', item.name);
  const pkg = JSON.parse(await readFile(path.join(dependency, 'package.json'), 'utf8'));
  assert.equal(item.version, pkg.version);
  assert.equal(item.declaredLicense, pkg.license || pkg.licenses.map(entry => entry.type).join(', '));
  assert.deepEqual(await readFile(path.join(licenses, item.licenseFile)), await readFile(path.join(dependency, 'LICENSE')));
}
assert.equal(await readFile(path.join(licenses, 'QRCode-NOTICE.txt'), 'utf8'),
  (await readFile(path.join(root, 'node_modules/qrcode-terminal/vendor/QRCode/index.js'), 'utf8')).split('var QR8bitByte')[0]);

const preinstall = path.join(expanded, 'payload.pkg/Scripts/preinstall');
assert.equal(await readFile(preinstall, 'utf8'), await readFile(path.join(root, 'desktop/installer/preinstall'), 'utf8'));
run('/bin/sh', [preinstall, 'test.pkg', '/', payload]);
for (const item of [bundle, ...(withDriver ? [driver] : [])]) run('codesign', ['--verify', '--deep', '--strict', item]);
if (artifact.release) {
  assert.match(run('pkgutil', ['--check-signature', artifact.pkg]), /Developer ID Installer:/);
  for (const item of [bundle, ...(withDriver ? [driver] : [])]) {
    run('codesign', ['--verify', '--deep', '--strict', '-R',
      '=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists', item]);
    const details = spawnSync('codesign', ['-d', '--verbose=4', item], { encoding: 'utf8' });
    assert.equal(details.status, 0, details.stderr);
    assert.match(details.stderr, /flags=.*runtime/);
    assert.match(details.stderr, /Timestamp=/);
  }
  const entitlements = spawnSync('codesign', ['-d', '--entitlements', ':-', bundle], { encoding: 'utf8' });
  assert.equal(entitlements.status, 0, entitlements.stderr);
  assert.match(entitlements.stdout, /com.apple.security.cs.allow-jit/);
  assert(!entitlements.stdout.includes('com.apple.security.get-task-allow'));
}

const uninstall = path.join(check, 'uninstaller');
run('pkgutil', ['--expand-full', path.join(bundle, 'Contents/Resources/VoiceDeck-Uninstall.pkg'), uninstall]);
for (const [name, source] of [['preinstall', 'installer/validate'], ['postinstall', 'uninstaller/postinstall']]) {
  assert.equal(await readFile(path.join(uninstall, 'uninstall-component.pkg/Scripts', name), 'utf8'),
    await readFile(path.join(root, 'desktop', source), 'utf8'));
}
assert((await readFile(path.join(uninstall, 'Distribution'), 'utf8')).includes('RequireRestart'));
assert((await readFile(path.join(uninstall, 'uninstall-component.pkg/PackageInfo'), 'utf8')).includes('org.voicedeck.desktop.uninstaller'));
const manifest = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8'));
assert.equal(manifest.main, 'desktop/launch.mjs');
const distribution = await readFile(path.join(expanded, 'Distribution'), 'utf8');
assert.equal(distribution.includes('RequireRestart'), withDriver);
if (!withDriver) assert(distribution.includes('onConclusion="None"'));
assert((await readFile(path.join(expanded, 'payload.pkg/PackageInfo'), 'utf8')).includes('org.voicedeck.desktop.installer'));
const paths = [];
async function walk(directory) {
  for (const name of await readdir(directory)) {
    const entry = path.join(directory, name), stat = await lstat(entry);
    paths.push(path.relative(payload, entry));
    if (stat.isSymbolicLink()) assert((await realpath(entry)).startsWith(bundle + path.sep), 'bundle symlink escapes payload');
    else if (stat.isDirectory()) await walk(entry);
  }
}
await walk(payload);
assert(!paths.some(name => /(?:^|\/)(?:agent_memory|\.env|bridge-token|node_modules\/electron|check-client\.cjs)(?:\/|$)/.test(name)));
assert.equal(paths.includes('Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver/Contents/MacOS/VoiceDeckMicrophone'), withDriver);
if (!withDriver) assert(!paths.some(name => name === 'Library' || name.startsWith('Library/')));
assert(paths.some(name => name.endsWith('/bridge/native/NoKey操作助手')));
const port = async () => {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value;
};
const bridgePort = await port(), debugPort = await port();
const stateDir = path.join(check, 'profile');
const child = spawn(path.join(bundle, 'Contents/MacOS/语音快捷键盘'), [
  `--user-data-dir=${stateDir}`, `--remote-debugging-port=${debugPort}`,
], { cwd: check, env: { ...process.env, MICRODEX_HOST: '127.0.0.1', MICRODEX_PORT: String(bridgePort) }, stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', socket;
child.stdout.on('data', data => { output += data; });
child.stderr.on('data', data => { output += data; });
const exited = once(child, 'exit');
const deadline = setTimeout(() => child.kill('SIGTERM'), 20000);
try {
  let page;
  for (let n = 0; n < 120; n++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Packaged client exited early: ' + output);
    try {
      const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
      page = pages.find(page => decodeURIComponent(page.url).endsWith('/app/desktop/rtc/engine.html'));
      if (page) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(page, 'packaged renderer did not load: ' + output);
  socket = new WebSocket(page.webSocketDebuggerUrl); await once(socket, 'open');
  let id = 0;
  const call = (method, params) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const receive = raw => {
      const message = JSON.parse(raw);
      if (message.id !== requestId) return;
      clearTimeout(timer); socket.off('close', closed); socket.off('message', receive);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    };
    const closed = () => { clearTimeout(timer); socket.off('message', receive); reject(new Error('Packaged debug channel closed')); };
    const timer = setTimeout(() => { socket.off('close', closed); socket.off('message', receive); reject(new Error('Packaged debug request timed out')); }, 5000);
    socket.once('close', closed); socket.on('message', receive); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    const view = await call('Runtime.evaluate', { expression: `document.getElementById('qr')?.hidden === false`, returnByValue: true });
    if (view.result.value) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(ready, 'packaged client did not publish its ready state: ' + output);
  const state = await call('Runtime.evaluate', { expression: `window.desktopClient.action('state')`, awaitPromise: true, returnByValue: true });
  assert(!state.exceptionDetails, JSON.stringify(state.exceptionDetails));
  assert.equal(state.result.value.uninstallAvailable, true);
  assert.equal(state.result.value.relayOrigin, '');
  assert.equal(state.result.value.remoteStatus, 'disabled');
  assert.equal(state.result.value.remoteRetryAt, null);
  assert.equal(state.result.value.connectionRestartRequired, false);
  const connectionForm = await call('Runtime.evaluate', { expression: `({ input: document.getElementById('relay-origin').type, save: !document.getElementById('connection-save').disabled })`, returnByValue: true });
  assert.deepEqual(connectionForm.result.value, { input: 'url', save: true });
  const uninstallButton = await call('Runtime.evaluate', { expression: `({ enabled: !document.getElementById('uninstall').disabled, text: document.getElementById('uninstall').textContent })`, returnByValue: true });
  assert.equal(uninstallButton.result.value.enabled, true);
  assert.match(uninstallButton.result.value.text, /卸载\s*NoKey/);
  assert.equal(state.result.value.shortcuts, false);
  assert.equal(state.result.value.keyboardEnabled, false);
  assert.equal(state.result.value.devices.length, 0);
  const health = await (await fetch(`http://127.0.0.1:${bridgePort}/health`)).json();
  assert.equal(health.name, 'voicedeck');
  const preflights = ['C', 'en_US.UTF-8'].map(locale => {
    const env = { ...process.env, LC_ALL: locale };
    const preflight = spawnSync('/bin/sh', [preinstall, 'test.pkg', '/', payload], { encoding: 'utf8', env });
    const processes = preflight.status === 1 ? [] : spawnSync('/bin/ps', ['-axo', 'comm='], { encoding: 'utf8', env }).stdout.split('\n').filter(line => line.includes('package-'));
    return { locale, status: preflight.status, error: preflight.stderr, processes };
  });
  for (const preflight of preflights) {
    assert.equal(preflight.status, 1, JSON.stringify(preflights));
    assert.match(preflight.error, /先退出/);
  }
  assert.equal(health.remoteAccess.ready, false);
  assert.match(await readFile(path.join(stateDir, 'bridge-token'), 'utf8'), /^[A-Za-z0-9_-]{43}$/);
  const screenshot = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(check, 'packaged-client.png'), Buffer.from(screenshot.data, 'base64'));
  await call('Runtime.evaluate', { expression: `document.getElementById('connection-title').scrollIntoView()` });
  const settings = await call('Page.captureScreenshot', { format: 'png' });
  await writeFile(path.join(check, 'packaged-settings.png'), Buffer.from(settings.data, 'base64'));
  socket.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: "document.getElementById('stop-service').click()" } }));
  const [code, signal] = await exited;
  assert.equal(code, 0, output); assert.equal(signal, null, output);
  await assert.rejects(fetch(`http://127.0.0.1:${bridgePort}/health`));
  run('/bin/sh', [preinstall, 'test.pkg', '/', payload]);
  await writeFile(path.join(check, 'result.json'), JSON.stringify({ ok: true, pkg: artifact.pkg, files: paths.length, screenshot: path.join(check, 'packaged-client.png') }, null, 2));
  console.log(`Extracted package passed: ${paths.length} paths, signatures, isolated packaged launch, renderer/native bindings, bridge and normal shutdown. ${check}`);
} finally {
  clearTimeout(deadline); socket?.close();
  if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited; }
  await rm(stateDir, { recursive: true, force: true });
}
