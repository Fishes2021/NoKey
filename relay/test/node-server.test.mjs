import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startRelay } from '../src/node-server.mjs';
import { createE2EEKeyMaterial, sealE2EE, openE2EE } from '../../bridge/lib/e2ee.mjs';

const next = socket => once(socket, 'message').then(([raw]) => JSON.parse(raw.toString()));
test('standalone relay isolates devices, routes encrypted requests/events, authenticates TURN and clears disconnects', { timeout: 10000 }, async () => {
  const id = 'abcdefghijklmnopqrstuv', secret = '0123456789abcdef0123456789abcdef';
  const relay = await startRelay({ publicOrigin: 'https://relay.example.cn', port: 0,
    devices: { [id]: createHash('sha256').update(secret).digest('hex') },
    turn: { secret: 'server-only-signing-secret-0123456789', urls: ['turn:relay.example.cn:3478'] } });
  const base = `http://127.0.0.1:${relay.port}/v1/devices/${id}`;
  const wsbase = base.replace('http:', 'ws:');
  let mac, phone;
  try {
    assert.equal((await fetch(base + '/ice', { method: 'POST' })).status, 401);
    const ice = await (await fetch(base + '/ice', { method: 'POST', headers: { 'X-Microdex-Device-Secret': secret } })).json();
    assert.match(ice.iceServers[0].username, new RegExp(`:${id}$`));
    assert(!JSON.stringify(ice).includes('server-only'));
    assert.equal((await fetch(base + '/api/status')).status, 404);
    assert.equal((await fetch(base + '/api/e2ee', { method: 'POST', body: '{}' })).status, 503);
    const denied = new WebSocket(wsbase + '/connect');
    denied.on('error', () => {});
    const [, response] = await once(denied, 'unexpected-response');
    assert.equal(response.statusCode, 401);
    response.resume(); denied.terminate();
    mac = new WebSocket(wsbase + '/connect', { headers: { 'X-Microdex-Device-Secret': secret } });
    const connected = next(mac); await once(mac, 'open'); await connected;
    const material = createE2EEKeyMaterial();
    const envelope = sealE2EE(material, 'test', { private: 'voice-and-shortcuts' });
    const forwarded = next(mac);
    const request = fetch(base + '/api/e2ee', { method: 'POST', body: JSON.stringify({ envelope }) });
    const message = await forwarded;
    assert.equal(message.path, '/api/e2ee');
    assert(!message.body.includes('voice-and-shortcuts'));
    assert.equal(openE2EE(material, 'test', JSON.parse(message.body).envelope).private, 'voice-and-shortcuts');
    mac.send(JSON.stringify({ type: 'response', requestId: message.requestId, status: 200, body: message.body }));
    assert.deepEqual(await (await request).json(), { envelope });
    assert.equal(relay.stats().pending, 0);
    phone = new WebSocket(wsbase + '/events'); await once(phone, 'open');
    const auth = next(mac);
    phone.send(JSON.stringify({ type: 'e2ee-auth', envelope }));
    const challenge = await auth;
    assert.equal(challenge.type, 'phone-auth');
    const ready = next(phone);
    mac.send(JSON.stringify({ type: 'phone-auth-result', phoneId: challenge.phoneId, ok: true, e2ee: true }));
    assert.deepEqual(await ready, { type: 'ready', e2ee: true });
    const event = next(phone);
    mac.send(JSON.stringify({ type: 'phone-event', phoneId: challenge.phoneId, payload: { type: 'e2ee', envelope } }));
    assert.deepEqual(await event, { type: 'e2ee', envelope });
    const inFlight = next(mac);
    const pending = fetch(base + '/api/e2ee', { method: 'POST', body: JSON.stringify({ envelope }) });
    await inFlight;
    const phoneClosed = once(phone, 'close');
    mac.close();
    assert.equal((await pending).status, 503);
    await phoneClosed;
    assert.equal(relay.stats().pending, 0);
    const pairing = await (await fetch(base + '/pair?code=' + randomUUID())).text();
    assert(pairing.includes('voicedeck:///pair'));
  } finally {
    mac?.terminate(); phone?.terminate(); await relay.close(); await relay.close();
  }
  await assert.rejects(fetch(base + '/health'));
});
