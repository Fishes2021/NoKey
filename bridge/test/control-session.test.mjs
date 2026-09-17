import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createControlSession } from '../lib/control-session.mjs';
import { startBridge } from '../server.mjs';
import { sealE2EE, openE2EE } from '../lib/e2ee.mjs';

test('one control owner spans audio, idle expiry and pending/revoked operations', async () => {
  let now = 0, voice = null, calls = 0;
  const control = createControlSession({ now: () => now, voiceOwner: () => voice });
  const action = () => ++calls;
  assert.equal(await control.run('phone-a', action), 1);
  assert.equal((await control.run('phone-b', action)).status, 409);
  now = 9999;
  assert.equal((await control.run('phone-b', action)).status, 409);
  voice = 'phone-a'; now = 10001;
  assert.equal((await control.run('phone-b', action)).status, 409);
  voice = null;
  assert.equal(await control.run('phone-b', action), 2);
  let resolve;
  const pending = control.run('phone-b', () => new Promise(done => { resolve = done; }));
  now = 99999;
  assert.equal((await control.run('phone-a', action)).status, 409);
  control.revoke('phone-b');
  assert.equal((await control.run('phone-b', action)).status, 409);
  assert.equal((await control.run('phone-a', action)).status, 409);
  resolve('completed'); await pending;
  assert.equal(await control.run('phone-a', action), 3);
  control.revoke('unrelated');
  assert.equal((await control.run('phone-b', action)).status, 409);
  await assert.rejects(control.run('', action), /配对身份/);
  assert.equal(calls, 3);
});

test('two real paired identities cannot control voice, keys or Codex concurrently', async () => {
  await mkdir('build/desktop', { recursive: true });
  const stateDir = await mkdtemp('build/desktop/control-session-');
  const accessToken = randomUUID();
  let posts = 0;
  const target = { id: 'test-editor', name: '测试编辑器', bundleId: 'test.editor' };
  const bridge = await startBridge({ embedded: true, host: '127.0.0.1', port: 0, stateDir, accessToken,
    confirmPairing: async () => true,
    keyboard: { snapshot: () => JSON.stringify({ trusted: true, target }),
      press: () => { posts++; return JSON.stringify({ posted: true, target }); } } });
  const base = `http://127.0.0.1:${bridge.port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const pair = async () => {
    const invite = new URL(bridge.refreshPairing().pairingUrl);
    const material = Object.fromEntries(new URLSearchParams(invite.hash.slice(1)));
    const pairId = randomUUID();
    const paired = await post('/api/e2ee/pair', { envelope: sealE2EE(material, 'pair', {
      requestId: pairId, issuedAt: Date.now(), code: invite.searchParams.get('code'),
    }) });
    assert.equal(paired.status, 200);
    const requestId = randomUUID();
    const opened = await (await post('/api/e2ee/session', { envelope: sealE2EE(material, 'session', {
      requestId, issuedAt: Date.now(), token: accessToken,
    }) })).json();
    const { sessionId } = openE2EE(material, `session-response:${requestId}`, opened.envelope);
    return { material, async request(path, body = {}, method = 'POST') {
      const requestId = randomUUID();
      const response = await post('/api/e2ee', { envelope: { ...sealE2EE(material, `request:${sessionId}`, {
        requestId, issuedAt: Date.now(), method, path, body,
      }), sessionId } });
      const payload = await response.json();
      if (!payload.envelope) return { status: response.status, body: payload };
      const decrypted = openE2EE(material, `response:${sessionId}:${requestId}`, payload.envelope);
      return { status: decrypted.status, body: JSON.parse(decrypted.body) };
    } };
  };
  try {
    bridge.setKeyboardEnabled(true);
    const a = await pair(), b = await pair();
    assert.equal((await a.request('/api/keyboard/target')).status, 200);
    for (const path of ['/api/voice/config', '/api/voice/offer', '/api/keyboard/target', '/api/keyboard/press',
      '/api/remote/approval', '/api/remote/send', '/api/programmable/action', '/api/encoder/action']) {
      const refused = await b.request(path);
      assert.equal(refused.status, 409, path);
      assert.equal(refused.body.code, 'CONTROL_BUSY');
    }
    assert.equal((await b.request('/api/status', {}, 'GET')).status, 200);
    assert.equal(posts, 0);
    await bridge.revokeDevice(a.material.keyId);
    const lease = await b.request('/api/keyboard/target');
    assert.equal(lease.status, 200);
    const sent = await b.request('/api/keyboard/press', { leaseId: lease.body.leaseId, operationId: randomUUID(), key: 'Enter', modifiers: [] });
    assert.equal(sent.body.posted, true);
    assert.equal(posts, 1);
    assert.equal((await a.request('/api/keyboard/target')).status, 409);
  } finally { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('deferred actions cannot renew an expired owner or steal a newer owner', async () => {
  let now = 0, calls = 0;
  const control = createControlSession({ now: () => now });
  const send = () => ++calls;
  await control.run('phone-a', () => null);
  const ticket = control.ticket('phone-a');
  assert.equal(await control.run('phone-a', send, { existing: ticket }), 1);
  now = 10001;
  assert.equal((await control.run('phone-a', send, { existing: ticket })).status, 409);
  assert.equal(calls, 1);
  await control.run('phone-b', () => null);
  assert.equal((await control.run('phone-a', send, { existing: ticket })).status, 409);
  assert.equal(calls, 1);
  let finish;
  const pending = control.run('phone-b', () => new Promise(resolve => { finish = resolve; }), { existing: control.ticket('phone-b') });
  now = 90000;
  assert.equal((await control.run('phone-a', send)).status, 409);
  finish(); await pending;
  control.revoke('phone-b');
  await control.run('phone-a', () => null);
  assert.equal((await control.run('phone-a', send, { existing: ticket })).status, 409, 'same phone new session cannot revive an old ticket');
  assert.equal(calls, 1);
});
