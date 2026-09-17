import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startRelay } from '../src/node-server.mjs';

test('interactive polling and dial traffic survive old limits, then remain bounded', { timeout: 15000 }, async () => {
  const id = 'interactive_test_mac_1234', secret = 'test-device-secret-01234567890123456789';
  const relay = await startRelay({ publicOrigin: 'https://relay.example.cn', port: 0,
    devices: { [id]: createHash('sha256').update(secret).digest('hex') } });
  const base = `http://127.0.0.1:${relay.port}/v1/devices/${id}`;
  const mac = new WebSocket(base.replace('http:', 'ws:') + '/connect', { headers: { 'X-Microdex-Device-Secret': secret } });
  mac.on('message', data => {
    const message = JSON.parse(data);
    if (message.type === 'request') mac.send(JSON.stringify({ type: 'response', requestId: message.requestId, status: 200, body: '{"envelope":"opaque-test-reply"}' }));
  });
  try {
    await once(mac, 'open');
    // Accelerate one minute: 14 dial steps/sec plus polling => ~1000 requests.
    // Payload is opaque to the relay; real crypto is covered by connector-integration.
    for (let i = 0; i < 1799; i++) {
      const response = await fetch(base + '/api/e2ee', { method: 'POST', body: '{"envelope":"opaque-test"}' });
      assert.equal(response.status, 200, `request ${i}`); await response.text();
    }
    assert.equal((await fetch(base + '/api/e2ee', { method: 'POST', body: '{}' })).status, 429);
    assert.equal(relay.stats().pending, 0);
    assert.equal(mac.readyState, WebSocket.OPEN, 'Mac replies must not hit a smaller hidden WS budget');
  } finally { mac.terminate(); await relay.close(); }
});
