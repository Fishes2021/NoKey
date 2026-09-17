import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { CodexAppServer } from '../lib/codex-app-server.mjs';
import { startBridge } from '../server.mjs';
import { sealE2EE, openE2EE } from '../lib/e2ee.mjs';
import { setVoiceHost } from '../lib/voice-api.mjs';

test('embedded bridge: independent microphone, local pairing consent, encrypted requests and shutdown', { timeout: 15000 }, async () => {
  await mkdir('build/desktop', { recursive: true });
  const stateDir = await mkdtemp('build/desktop/embedded-check-');
  let allowed = false, confirmations = 0, invalidate = false;
  const bridge = await startBridge({ embedded: true, port: 0, host: '127.0.0.1', stateDir,
    accessToken: 'local-test-token', confirmPairing: async () => { confirmations++; if (invalidate) bridge.refreshPairing(); return allowed; } });
  const base = `http://127.0.0.1:${bridge.port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-microdex-token': 'local-test-token' }, body: JSON.stringify(body) });
  const get = route => fetch(base + route, { headers: { 'x-microdex-token': 'local-test-token' } }).then(r => r.json());
  const claim = async () => {
    const url = new URL(bridge.pairing().pairingUrl);
    const material = Object.fromEntries(new URLSearchParams(url.hash.slice(1)));
    const requestId = randomUUID();
    const response = await post('/api/e2ee/pair', { envelope: sealE2EE(material, 'pair', {
      requestId, issuedAt: Date.now(), code: url.searchParams.get('code'),
    }) });
    const body = await response.json();
    return { material, result: openE2EE(material, `pair-response:${requestId}`, body.envelope) };
  };
  try {
    assert.equal((await fetch(base + '/api/status', { headers: { 'x-microdex-token': 'local-test-token' } })).status, 401);
    assert.equal((await post('/api/pair/claim', {})).status, 426);
    assert.equal((await claim()).result.code, 'PAIRING_REJECTED');
    allowed = true;
    invalidate = true;
    assert.equal((await claim()).result.code, 'PAIRING_REJECTED');
    invalidate = false;
    const { material, result } = await claim();
    assert.equal(result.token, 'local-test-token');
    assert.equal(confirmations, 3);
    assert.equal((await claim()).result.code, 'PAIRING_REJECTED');
    assert.equal(confirmations, 3);
    const id = randomUUID();
    const sessionResponse = await (await post('/api/e2ee/session', { envelope: sealE2EE(material, 'session', {
      requestId: id, issuedAt: Date.now(), token: result.token,
    }) })).json();
    const { sessionId } = openE2EE(material, `session-response:${id}`, sessionResponse.envelope);
    setVoiceHost({ offer(owner) { assert.equal(owner, material.keyId); return { sessionId: 'test-audio' }; } });
    const requestId = randomUUID();
    const envelope = { ...sealE2EE(material, `request:${sessionId}`, {
      requestId, issuedAt: Date.now(), method: 'POST', path: '/api/voice/offer',
      body: { owner: 'spoofed', description: { type: 'offer', sdp: 'test' } },
    }), sessionId };
    const response = await (await post('/api/e2ee', { envelope })).json();
    const decoded = openE2EE(material, `response:${sessionId}:${requestId}`, response.envelope);
    assert.equal(decoded.status, 200);
    assert.equal(JSON.parse(decoded.body).sessionId, 'test-audio');
    assert.equal((await post('/api/e2ee', { envelope })).status, 401);
    assert.equal((await bridge.listDevices()).length, 1);
    assert(!JSON.stringify(await bridge.listDevices()).includes(material.key));
    await bridge.revokeDevice(material.keyId);
    assert.deepEqual(await bridge.listDevices(), []);
    assert.equal((await post('/api/e2ee', { envelope })).status, 409);
    assert.equal((await post('/api/e2ee/session', { envelope: sealE2EE(material, 'session', {
      requestId: randomUUID(), issuedAt: Date.now(), token: result.token,
    }) })).status, 401);
  } finally {
    setVoiceHost(null);
    await bridge.close();
    await bridge.close();
    await rm(stateDir, { recursive: true, force: true });
  }
  await assert.rejects(fetch(base + '/health'));
});

test('lazy Codex can close before use without starting a server', async () => {
  const codex = new CodexAppServer({ lazy: true });
  codex.close();
  codex.close();
  await assert.rejects(codex.ready(), /closed/);
});
