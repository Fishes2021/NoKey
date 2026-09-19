import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { openSubscriptions, addMonths } from '../src/subscriptions.mjs';
import { startRelay } from '../src/node-server.mjs';
import { subscriptionRequest } from '../../desktop/subscription-client.mjs';
const id = 'subscription_test_device_001', secret = 'subscription_test_secret_01234567890123456789';
const secretHash = createHash('sha256').update(secret).digest('hex');

test('calendar renewal, idempotency, binding, persistence and revocation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nokey-sub-')); const file = path.join(dir, 'subscriptions.sqlite');
  let now = Date.parse('2028-01-31T12:00:00Z'); let store = openSubscriptions(file, () => now);
  try {
    assert.equal(new Date(addMonths(now, 1)).toISOString(), '2028-02-29T12:00:00.000Z');
    const code = store.issue(1); const payload = { code, deviceId: id, secretHash };
    const first = store.redeem(payload); assert.equal(first.status, 'active');
    assert.deepEqual(store.redeem(payload), first);
    assert.throws(() => store.redeem({ ...payload, deviceId: id + '2' }));
    assert.throws(() => store.redeem({ ...payload, secretHash: '0'.repeat(64) }));
    assert.equal(store.authenticate(id, secret), true); assert.equal(store.authenticate(id, secret + 'x'), false);
    const year = store.redeem({ ...payload, code: store.issue(12) });
    assert.equal(new Date(year.expiresAt).toISOString(), '2029-02-28T12:00:00.000Z');
    assert(!(await readFile(file)).includes(Buffer.from(code)), 'no plaintext activation code in database');
    store.close(); store = openSubscriptions(file, () => now); assert.deepEqual(store.status(id), year);
    now = year.expiresAt; assert.equal(store.status(id).status, 'expired');
    store.revoke(id); assert.equal(store.status(id).status, 'revoked');
    assert.throws(() => store.redeem({ ...payload, code: store.issue(1) }));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});

test('real HTTP activation and Mac client: renew/status, forged identity rejection, expiry disconnect', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nokey-activation-'));
  const file = path.join(dir, 'subscriptions.sqlite'); const store = openSubscriptions(file);
  const relay = await startRelay({ publicOrigin: 'https://relay.example', subscriptions: { database: file }, port: 0 });
  const base = `http://127.0.0.1:${relay.port}`; let socket;
  const fetchImpl = (url, options) => fetch(url.replace('https://relay.example', base), options);
  try {
    const code = store.issue(1);
    const result = await subscriptionRequest({ origin: 'https://relay.example', stateDir: dir, code, fetchImpl });
    assert.equal(result.status, 'active');
    const identity = JSON.parse(await readFile(path.join(dir, 'relay-device.json')));
    const deviceBase = base + '/v1/devices/' + identity.deviceId;
    assert.equal((await fetch(deviceBase + '/subscription', { method: 'POST' })).status, 401);
    assert.deepEqual(await subscriptionRequest({ origin: 'https://relay.example', stateDir: dir, fetchImpl }), result);
    socket = new WebSocket(deviceBase.replace('http:', 'ws:') + '/connect', { headers: { 'X-Microdex-Device-Secret': identity.deviceSecret } });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    const db = new DatabaseSync(file); db.prepare('UPDATE devices SET expires_at=? WHERE id=?').run(Date.now() - 1, identity.deviceId); db.close();
    const response = await fetch(deviceBase + '/api/e2ee', { method: 'POST', body: '{}' });
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'RELAY_SUBSCRIPTION_REQUIRED');
    await closed; assert.equal(relay.stats().connectedMacs, 0);
    const renewed = await subscriptionRequest({ origin: 'https://relay.example', stateDir: dir, code: store.issue(12), fetchImpl });
    assert.equal(renewed.status, 'active');
  } finally { socket?.terminate(); await relay.close(); store.close(); await rm(dir, { recursive: true, force: true }); }
});
