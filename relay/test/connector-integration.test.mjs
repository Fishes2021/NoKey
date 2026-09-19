import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { createIceProvider } from '../../desktop/ice-provider.mjs';
import { startRelay } from '../src/node-server.mjs';
import { createRemoteRelay, persistentRelayIdentity } from '../../bridge/lib/remote-relay.mjs';
import { attachRemoteEvents } from '../../bridge/lib/remote-events.mjs';
import { E2EEClientRegistry } from '../../bridge/lib/e2ee-client-registry.mjs';
import { createE2EEKeyMaterial, sealE2EE, openE2EE } from '../../bridge/lib/e2ee.mjs';
import { createControlSession } from '../../bridge/lib/control-session.mjs';
import { createKeyboardController } from '../../bridge/lib/keyboard-api.mjs';
import { handleVoiceRequest } from '../../bridge/lib/voice-api.mjs';

test('production Mac connector and encrypted voice/keyboard APIs interoperate with the standalone relay', { timeout: 10000 }, async () => {
  await mkdir('build/relay', { recursive: true });
  const stateDir = await mkdtemp('build/relay/connector-');
  const identity = await persistentRelayIdentity(stateDir);
  const clients = new E2EEClientRegistry({ stateDir });
  const material = createE2EEKeyMaterial(); await clients.addClient(material);
  const relay = await startRelay({ publicOrigin: 'https://relay.example.cn', port: 0,
    devices: { [identity.deviceId]: createHash('sha256').update(identity.deviceSecret).digest('hex') },
    turn: { secret: 'test-server-secret-01234567890123456789', urls: ['turn:relay.example.cn:3478'] } });
  const local = http.createServer((_req, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"online":false}'); });
  const events = attachRemoteEvents({ server: local, codex: { state: async () => ({ online: false }), subscribe: () => () => {} }, authenticate: token => token === 'local-only' });
  local.listen(0, '127.0.0.1'); await once(local, 'listening');
  // Only the test remaps the configured HTTPS/WSS origin to a real loopback transport.
  // Production normalization and TLS checks remain enabled and unchanged.
  class LocalSocket extends WebSocket {
    constructor(url, options) { super(url.replace('wss://relay.example.cn', `ws://127.0.0.1:${relay.port}`), options); }
  }
  const ice = createIceProvider({ relayOrigin: 'https://relay.example.cn', stateDir,
    fetchImpl: (url, options) => fetch(url.replace('https://relay.example.cn', `http://127.0.0.1:${relay.port}`), options) });
  const control = createControlSession();
  let offers = 0, presses = 0;
  const target = { id: 'relay-test-editor', name: '测试编辑器', bundleId: 'test.editor' };
  const keyboard = createKeyboardController({ snapshot: () => JSON.stringify({ trusted: true, target }),
    press: () => { presses++; return JSON.stringify({ posted: true, target }); } });
  keyboard.setEnabled(true);
  const connector = createRemoteRelay({ port: local.address().port, stateDir, accessToken: 'paired-token', localToken: 'local-only',
    relayOrigin: 'https://relay.example.cn', WebSocketImpl: LocalSocket,
    authenticate: token => token === 'paired-token', e2eeClients: clients,
    probeEncryptedPairing: envelope => {
      const payload = openE2EE(material, 'pair-probe', envelope);
      return { envelope: sealE2EE(material, `pair-probe-response:${payload.requestId}`, { ok: true }) };
    },
    handleAuthenticatedRequest: context => { clients.assertActive(context); return control.run(context.material.keyId, () => keyboard.handle(context) || handleVoiceRequest(context, { config: ice, offer(owner) {
      assert.equal(owner, material.keyId); offers++; return { sessionId: randomUUID() };
    } })); } });
  const ready = new Promise(resolve => connector.subscribe(state => { if (state.ready) resolve(); }));
  connector.start();
  const base = `http://127.0.0.1:${relay.port}/v1/devices/${identity.deviceId}`;
  const post = (route, envelope) => fetch(base + route, { method: 'POST', body: JSON.stringify({ envelope }) });
  try {
    await ready;
    const probeId = randomUUID();
    const probe = await (await post('/api/e2ee/pair-probe', sealE2EE(material, 'pair-probe', { requestId: probeId }))).json();
    assert.equal(openE2EE(material, `pair-probe-response:${probeId}`, probe.envelope).ok, true);
    const requestId = randomUUID();
    const sessionReply = await (await post('/api/e2ee/session', sealE2EE(material, 'session', {
      requestId, issuedAt: Date.now(), token: 'paired-token',
    }))).json();
    const { sessionId } = openE2EE(material, `session-response:${requestId}`, sessionReply.envelope);
    const configId = randomUUID();
    const configuration = await (await post('/api/e2ee', { ...sealE2EE(material, `request:${sessionId}`, {
      requestId: configId, issuedAt: Date.now(), method: 'POST', path: '/api/voice/config', body: {},
    }), sessionId })).json();
    const configReply = openE2EE(material, `response:${sessionId}:${configId}`, configuration.envelope);
    assert.equal(configReply.status, 200);
    assert(JSON.parse(configReply.body).iceServers[0].username.endsWith(':' + identity.deviceId));
    assert.equal(relay.stats().iceIssued, 1);
    const voiceId = randomUUID();
    const voice = { ...sealE2EE(material, `request:${sessionId}`, {
      requestId: voiceId, issuedAt: Date.now(), method: 'POST', path: '/api/voice/offer',
      body: { owner: 'forged', description: { type: 'offer', sdp: 'encrypted-offer' } },
    }), sessionId };
    const answer = await (await post('/api/e2ee', voice)).json();
    const opened = openE2EE(material, `response:${sessionId}:${voiceId}`, answer.envelope);
    assert.equal(opened.status, 200); assert.equal(offers, 1);
    assert.equal((await post('/api/e2ee', voice)).status, 401);
    const keyRequest = async (path, body = {}) => {
      const requestId = randomUUID();
      const reply = await (await post('/api/e2ee', { ...sealE2EE(material, `request:${sessionId}`, {
        requestId, issuedAt: Date.now(), method: 'POST', path, body,
      }), sessionId })).json();
      return openE2EE(material, `response:${sessionId}:${requestId}`, reply.envelope);
    };
    const leased = await keyRequest('/api/keyboard/target');
    assert.equal(leased.status, 200);
    const command = { leaseId: JSON.parse(leased.body).leaseId, operationId: randomUUID(), key: 'Enter', modifiers: [] };
    const delivered = await keyRequest('/api/keyboard/press', command);
    assert.equal(delivered.status, 200);
    assert.deepEqual(await keyRequest('/api/keyboard/press', command), delivered);
    assert.equal(presses, 1);
    const second = createE2EEKeyMaterial(); await clients.addClient(second);
    const secondId = randomUUID();
    const secondSession = await (await post('/api/e2ee/session', sealE2EE(second, 'session', {
      requestId: secondId, issuedAt: Date.now(), token: 'paired-token',
    }))).json();
    const secondSessionId = openE2EE(second, `session-response:${secondId}`, secondSession.envelope).sessionId;
    const attemptId = randomUUID();
    const attempt = await (await post('/api/e2ee', { ...sealE2EE(second, `request:${secondSessionId}`, {
      requestId: attemptId, issuedAt: Date.now(), method: 'POST', path: '/api/keyboard/target', body: {},
    }), sessionId: secondSessionId })).json();
    const denied = openE2EE(second, `response:${secondSessionId}:${attemptId}`, attempt.envelope);
    assert.equal(denied.status, 409);
    assert.equal(JSON.parse(denied.body).code, 'CONTROL_BUSY');
    assert.equal(presses, 1);
    await clients.removeClient(material.keyId);
    assert.equal((await post('/api/e2ee', voice)).status, 409);
    assert.equal(relay.stats().pending, 0);
  } finally {
    connector.close(); events.close();
    await relay.close();
    await new Promise(resolve => { local.close(resolve); local.closeAllConnections(); });
    await rm(stateDir, { recursive: true, force: true });
  }
});
