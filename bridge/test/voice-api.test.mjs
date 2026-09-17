import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { E2EEClientRegistry } from '../lib/e2ee-client-registry.mjs';
import { createE2EEKeyMaterial, sealE2EE, openE2EE } from '../lib/e2ee.mjs';
import { handleVoiceRequest } from '../lib/voice-api.mjs';

test('voice signaling uses authenticated identity, encrypted replies, replay protection and input limits', async () => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'voicedeck-api-'));
  const registry = new E2EEClientRegistry({ stateDir });
  const material = createE2EEKeyMaterial();
  let calls = 0;
  const audioId = randomUUID();
  const host = {
    config(owner) { assert.equal(owner, material.keyId); return { iceServers: [], expiresAt: null }; },
    offer(owner, description) {
      calls++;
      assert.equal(owner, material.keyId);
      assert.deepEqual(description, { type: 'offer', sdp: 'private-offer' });
      return { sessionId: audioId, description: { type: 'answer', sdp: 'private-answer' } };
    },
    control(operation, owner, body) {
      calls++;
      assert.equal(owner, material.keyId);
      assert(['stop', 'restart', 'gain'].includes(operation)); assert.equal(body.sessionId, audioId);
      if (operation === 'restart') { assert.deepEqual(body.description, { type: 'offer', sdp: 'renewed' }); assert.equal(body.iceServers, undefined); }
      return operation === 'gain' ? { sessionId: audioId, gain: body.gain } : { stopped: true };
    },
  };
  try {
    await registry.addClient(material);
    const session = await registry.createSession(sealE2EE(material, 'session', {
      requestId: randomUUID(), issuedAt: Date.now(), token: 'test-token',
    }), token => token === 'test-token');
    const envelope = {
      ...sealE2EE(material, `request:${session.sessionId}`, {
        requestId: randomUUID(), issuedAt: Date.now(), method: 'POST', path: '/api/voice/offer',
        body: { owner: 'forged-owner', iceServers: [{ urls: 'stun:untrusted.example' }],
          description: { type: 'offer', sdp: 'private-offer' } },
      }), sessionId: session.sessionId,
    };
    const context = await registry.openSessionMessage(envelope, 'request');
    const result = await handleVoiceRequest(context, host);
    assert.equal(result.status, 200);
    const sealed = registry.sealResponse(context, result);
    assert(!JSON.stringify(sealed).includes('private-answer'));
    const decoded = openE2EE(material, `response:${session.sessionId}:${context.requestId}`, sealed);
    assert.equal(JSON.parse(decoded.body).sessionId, audioId);
    await assert.rejects(registry.openSessionMessage(envelope, 'request'), /already used/);
    const withPayload = payload => ({ ...context, payload: { ...context.payload, ...payload } });
    assert.equal((await handleVoiceRequest(withPayload({ path: '/api/voice/stop', body: { sessionId: audioId } }), host)).status, 200);
    const config = await handleVoiceRequest(withPayload({ path: '/api/voice/config', body: { iceServers: ['forged'] } }), host);
    assert.deepEqual(JSON.parse(config.body), { iceServers: [], expiresAt: null });
    assert.equal((await handleVoiceRequest(withPayload({ path: '/api/voice/restart', body: { sessionId: audioId, description: { type: 'offer', sdp: 'renewed' }, iceServers: ['forged'] } }), host)).status, 200);
    for (const gain of [0, 0.5, 4]) {
      const result = await handleVoiceRequest(withPayload({ path: '/api/voice/gain', body: { sessionId: audioId, gain } }), host);
      assert.equal(result.status, 200);
      assert.deepEqual(JSON.parse(result.body), { sessionId: audioId, gain });
    }
    const prior = calls;
    for (const payload of [
      { method: 'GET' }, { path: '/api/voice/restart', body: { description: { type: 'offer', sdp: 'renewed' } } }, { path: '/api/voice/offer?owner=other' },
      { body: { description: { type: 'offer', sdp: 'x'.repeat(24001) } } },
      ...[Infinity, NaN, -1, 4.1, '1'].map(gain => ({ path: '/api/voice/gain', body: { sessionId: audioId, gain } })),
      { path: '/api/voice/stop', body: { sessionId: 'invalid' } },
    ]) assert((await handleVoiceRequest(withPayload(payload), host)).status >= 400);
    assert.equal(calls, prior);
    assert.equal((await handleVoiceRequest({ ...context, material: null }, host)).status, 401);
    assert.equal((await handleVoiceRequest(context, null)).status, 503);
    assert.equal(await handleVoiceRequest(withPayload({ path: '/api/remote/state' }), host), null);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
