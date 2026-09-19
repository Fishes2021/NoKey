import test from 'node:test';
import assert from 'node:assert/strict';
import { ConnectionRoutes } from '../lib/connection-routes.mjs';
import { registerHooks } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { startBridge } from '../../bridge/server.mjs';
const hooks = registerHooks({ resolve(specifier, context, next) {
  const source = { 'expo-constants': 'export default {};', 'expo-crypto': 'export { randomBytes as getRandomBytesAsync } from "node:crypto";' }[specifier];
  return source ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context);
}});
const { bridgeRequest, configureBridgeRoutes, resetBridgeRoute, currentBridgeRoute } = await import('../lib/bridge.ts');
const { parsePairingUrl, claimPairingPayload } = await import('../lib/pairing.ts');

const local = 'http://192.168.10.20:3210', relay = 'https://relay.example.com/v1/devices/abcdefghijklmnopqrstuvwx';

test('route selection prefers LAN, stays sticky, discovers changed addresses, and cannot revive in background', async () => {
  let offline = false, probes = 0;
  const routes = new ConnectionRoutes([local, relay], async address => { probes++; if (offline && address === local) throw Error('offline'); });
  assert.equal(await routes.select(), local);
  const count = probes; assert.equal(await routes.select(), local); assert.equal(probes, count);
  offline = true; routes.reset(); assert.equal(await routes.select(), relay);
  let release;
  const discovery = new ConnectionRoutes([local], async address => { if (address === local) throw Error('old IP'); }, async () => ['http://new-mac.local:3210']);
  assert.equal(await discovery.select(), 'http://new-mac.local:3210');
  const pending = new ConnectionRoutes([local], () => new Promise(resolve => { release = resolve; }));
  const result = pending.select(); pending.reset(false); release();
  await assert.rejects(result); assert.equal(pending.selected, null);
  assert.equal(routes.lastSelected, relay); routes.reset(false); assert.equal(routes.lastSelected, relay, 'stop cleanup retains the last route');
});

test('one real Mac pairing works across paths, rejects impostors, and never replays an uncertain write', { timeout: 15000 }, async () => {
  const stateDir = await mkdtemp('build/route-check-');
  let approvals = 0;
  const bridge = await startBridge({ embedded: true, host: '127.0.0.1', port: 0, stateDir, accessToken: 'route-test-token', confirmPairing: async () => { approvals++; return true; } });
  const realFetch = globalThis.fetch;
  let blockLAN = false, blockRelay = false, writes = 0, loseWrite = false, impostor = false;
  const actual = `http://127.0.0.1:${bridge.port}`;
  globalThis.fetch = async (url, options) => {
    const remote = String(url).startsWith(relay);
    if ((remote && blockRelay) || (!remote && blockLAN)) throw new TypeError('unreachable');
    if (!remote && impostor) return Response.json({ envelope: {} });
    const path = String(url).slice(String(url).indexOf('/api/'));
    // Inject response loss after the real encrypted request has reached the Mac.
    const response = await realFetch(actual + path, options);
    if (loseWrite && path === '/api/e2ee') {
      // /api/connection is probed before we enable this flag.
      writes++; throw new TypeError('response lost');
    }
    return response;
  };
  try {
    const payload = parsePairingUrl(bridge.pairing().pairingUrl);
    payload.routes = [local, relay];
    const credentials = await claimPairingPayload(payload);
    assert.equal(approvals, 1); assert.equal((await bridge.listDevices()).length, 1);
    const { token, e2ee } = credentials;
    const setup = () => { configureBridgeRoutes(relay, token, e2ee, [local, relay]); resetBridgeRoute(e2ee, true); };
    setup();
    assert.ok((await bridgeRequest(relay, token, '/api/connection', {}, e2ee)).routes.length);
    assert.equal(currentBridgeRoute(e2ee), local);
    blockLAN = true; setup();
    await bridgeRequest(relay, token, '/api/connection', {}, e2ee);
    assert.equal(currentBridgeRoute(e2ee), relay);
    blockLAN = false; blockRelay = true; setup();
    await bridgeRequest(relay, token, '/api/connection', {}, e2ee);
    assert.equal(currentBridgeRoute(e2ee), local, 'relay failure cannot break LAN');
    blockRelay = false; impostor = true; setup();
    await bridgeRequest(relay, token, '/api/connection', {}, e2ee);
    assert.equal(currentBridgeRoute(e2ee), relay, 'wrong Mac cannot win by replying first');
    impostor = false; setup(); await bridgeRequest(relay, token, '/api/connection', {}, e2ee);
    const preferences = await bridgeRequest(relay, token, '/api/preferences/keys', {}, e2ee);
    const keys = Array(10).fill(null); keys[6] = { keycapId: 'NAV', label: '上', action: { type: 'shortcut', key: 'ArrowUp', modifiers: [] } };
    const saved = await bridgeRequest(relay, token, '/api/preferences/keys', { method: 'POST', body: { revision: preferences.revision, keys } }, e2ee);
    bridge.refreshPairing();
    const another = parsePairingUrl(bridge.pairing().pairingUrl); another.routes = [local, relay];
    const replacement = await claimPairingPayload(another);
    const restored = await bridgeRequest(local, replacement.token, '/api/preferences/keys', {}, replacement.e2ee);
    assert.deepEqual(restored, saved, 'new phone pairing restores the Mac-owned layout');
    loseWrite = true;
    await assert.rejects(bridgeRequest(relay, token, '/api/keyboard/press', { method: 'POST', body: {} }, e2ee));
    assert.equal(writes, 1, 'uncertain action not retried on either route');
    assert.equal(approvals, 2); assert.equal((await bridge.listDevices()).length, 2);
  } finally { globalThis.fetch = realFetch; await bridge.close(); await rm(stateDir, { recursive: true, force: true }); }
});
