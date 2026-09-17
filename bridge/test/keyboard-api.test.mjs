import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createKeyboardController } from '../lib/keyboard-api.mjs';
import { startBridge } from '../server.mjs';
import { sealE2EE, openE2EE } from '../lib/e2ee.mjs';

const decode = response => ({ status: response.status, ...JSON.parse(response.body) });
function keyboard() {
  const state = { trusted: true, target: { id: '123:1234567890000', name: 'Test editor', bundleId: 'test.editor' } };
  const calls = [];
  const native = {
    snapshot: () => JSON.stringify(state),
    press(targetId, keyCode, flags, remainingMs) {
      calls.push({ targetId, keyCode, flags, remainingMs });
      return JSON.stringify({ posted: true, confirmed: false, target: state.target });
    },
  };
  return { state, calls, native };
}
const context = (body = {}, operation = 'target', owner = 'paired-phone') => ({
  material: { keyId: owner }, payload: { path: '/api/keyboard/' + operation, method: 'POST', body },
});

test('shortcut execution is bounded by target leases, duplicate identity and authorization scope', () => {
  let now = 1000;
  const { native, state, calls } = keyboard();
  const service = createKeyboardController(native, { now: () => now });
  assert.equal(decode(service.handle(context())).target, null);
  service.setEnabled(true);
  const target = decode(service.handle(context()));
  const body = { leaseId: target.leaseId, operationId: randomUUID(), key: 'V', modifiers: ['command', 'shift'] };
  const sent = decode(service.handle(context(body, 'press')));
  assert.equal(sent.status, 200); assert.equal(sent.confirmed, false);
  assert.deepEqual(calls[0], { targetId: state.target.id, keyCode: 9, flags: (1 << 20) | (1 << 17), remainingMs: 3000 });
  assert.deepEqual(decode(service.handle(context(body, 'press'))), sent);
  assert.equal(decode(service.handle(context({ ...body, key: 'C' }, 'press'))).status, 409);
  assert.equal(decode(service.handle(context({ ...body, operationId: randomUUID() }, 'press', 'other-phone'))).status, 409);
  for (const change of [{ key: 'constructor' }, { key: 'osascript hello' }, { modifiers: ['command', 'command'] }, { modifiers: ['bad'] }])
    assert.equal(decode(service.handle(context({ ...body, operationId: randomUUID(), ...change }, 'press'))).status, 400);
  now += 3001;
  assert.equal(decode(service.handle(context({ ...body, operationId: randomUUID() }, 'press'))).status, 409);
  assert.deepEqual(decode(service.handle(context(body, 'press'))), sent);
  now += 30001; // Even after outcome eviction, an old lease cannot execute again.
  assert.equal(decode(service.handle(context(body, 'press'))).status, 409);
  const fresh = decode(service.handle(context()));
  state.target = { ...state.target, id: '124:1234567890001' };
  assert.equal(decode(service.handle(context({ ...body, leaseId: fresh.leaseId, operationId: randomUUID() }, 'press'))).status, 409);
  const current = decode(service.handle(context()));
  service.revoke('paired-phone');
  assert.equal(decode(service.handle(context({ ...body, leaseId: current.leaseId, operationId: randomUUID() }, 'press'))).status, 409);
  assert.equal(calls.length, 1);
});

test('slow native preparation, permission changes and uncertain results do not trigger retries', () => {
  let now = 0;
  const { native, state, calls } = keyboard();
  const service = createKeyboardController(native, { now: () => now }); service.setEnabled(true);
  const makeBody = () => ({ leaseId: decode(service.handle(context())).leaseId, operationId: randomUUID(), key: 'Enter', modifiers: [] });
  let body = makeBody();
  state.trusted = false;
  assert.equal(decode(service.handle(context(body, 'press'))).status, 403);
  state.trusted = true;
  body = makeBody();
  const original = native.snapshot;
  native.snapshot = () => { now += 3001; return original(); };
  assert.equal(decode(service.handle(context(body, 'press'))).status, 409);
  native.snapshot = original; body = makeBody();
  native.press = () => { calls.push('uncertain'); throw new Error('post result lost'); };
  assert.equal(decode(service.handle(context(body, 'press'))).posted, null);
  assert.equal(decode(service.handle(context(body, 'press'))).status, 500);
  assert.equal(calls.length, 1);
  service.setEnabled(false);
  assert.equal(decode(service.handle(context(body, 'press'))).status, 503);
});

test('real encrypted bridge carries shortcuts without Codex; replay/new session/revocation preserve one execution', async () => {
  await mkdir('build/desktop', { recursive: true });
  const stateDir = await mkdtemp('build/desktop/keyboard-api-');
  const { native, calls } = keyboard();
  const token = randomUUID();
  const bridge = await startBridge({ embedded: true, host: '127.0.0.1', port: 0, stateDir,
    keyboard: native, accessToken: token, confirmPairing: async () => true });
  const base = `http://127.0.0.1:${bridge.port}`;
  const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const invite = new URL(bridge.pairing().pairingUrl);
    const material = Object.fromEntries(new URLSearchParams(invite.hash.slice(1)));
    const pairId = randomUUID();
    const pairing = await (await post('/api/e2ee/pair', { envelope: sealE2EE(material, 'pair', {
      requestId: pairId, issuedAt: Date.now(), code: invite.searchParams.get('code'),
    }) })).json();
    assert.equal(openE2EE(material, `pair-response:${pairId}`, pairing.envelope).token, token);
    const session = async () => {
      const id = randomUUID();
      const response = await (await post('/api/e2ee/session', { envelope: sealE2EE(material, 'session', {
        requestId: id, issuedAt: Date.now(), token,
      }) })).json();
      return openE2EE(material, `session-response:${id}`, response.envelope).sessionId;
    };
    let sessionId = await session();
    const request = async (operation, body = {}) => {
      const requestId = randomUUID();
      const envelope = { ...sealE2EE(material, `request:${sessionId}`, {
        requestId, issuedAt: Date.now(), method: 'POST', path: '/api/keyboard/' + operation, body,
      }), sessionId };
      const response = await (await post('/api/e2ee', { envelope })).json();
      return { envelope, decoded: decode(openE2EE(material, `response:${sessionId}:${requestId}`, response.envelope)) };
    };
    assert.equal((await request('target')).decoded.enabled, false);
    bridge.setKeyboardEnabled(true);
    const target = (await request('target')).decoded;
    const body = { leaseId: target.leaseId, operationId: randomUUID(), key: 'Escape', modifiers: [] };
    const first = await request('press', body); assert.equal(first.decoded.status, 200);
    assert.equal((await post('/api/e2ee', { envelope: first.envelope })).status, 401);
    sessionId = await session();
    assert.equal((await request('press', body)).decoded.posted, true); assert.equal(calls.length, 1);
    const textTarget = (await request('target')).decoded;
    const textBody = { leaseId: textTarget.leaseId, operationId: randomUUID(), text: '中文😀 from phone' };
    assert.equal((await request('text', textBody)).decoded.posted, true);
    assert.equal((await request('text', textBody)).decoded.posted, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].keyCode, textBody.text);
    await bridge.revokeDevice(material.keyId);
    assert.equal((await post('/api/e2ee', { envelope: first.envelope })).status, 409);
    assert.equal((await post('/api/keyboard/press', body)).status, 401);
    assert.equal(calls.length, 2);
  } finally { await bridge.close(); await rm(stateDir, { recursive: true, force: true }); }
});

test('text shares target leases and idempotency, rejects controls and stale targets', () => {
  const { native, state, calls } = keyboard();
  const service = createKeyboardController(native); service.setEnabled(true);
  const body = { leaseId: decode(service.handle(context())).leaseId, operationId: randomUUID(), text: ' 中文😀 ' };
  assert.equal(decode(service.handle(context(body, 'text'))).status, 200);
  assert.equal(calls[0].keyCode, body.text); assert.equal(calls[0].flags, 0);
  assert.equal(decode(service.handle(context(body, 'text'))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(decode(service.handle(context({ ...body, text: 'changed' }, 'text'))).status, 409);
  for (const text of ['', 'x'.repeat(2001), '\u0000', '\u001b'])
    assert.equal(decode(service.handle(context({ ...body, operationId: randomUUID(), text }, 'text'))).status, 400);
  state.target = { ...state.target, id: 'other' };
  assert.equal(decode(service.handle(context({ ...body, operationId: randomUUID() }, 'text'))).status, 409);
  assert.equal(calls.length, 1);
});
