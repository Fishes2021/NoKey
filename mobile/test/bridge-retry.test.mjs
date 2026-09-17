import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { createE2EEKeyMaterial, openE2EE, sealE2EE } from '../../bridge/lib/e2ee.mjs';

// Replace only native Expo adapters; exercise the actual request/encryption code.
const hooks = registerHooks({
  resolve(specifier, context, next) {
    const source = {
      'expo-constants': 'export default {};',
      'expo-crypto': 'export { randomBytes as getRandomBytesAsync } from "node:crypto";',
    }[specifier];
    return source ? { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true } : next(specifier, context);
  },
});
const { bridgeRequest, resetEncryptedBridgeSession } = await import('../lib/bridge.ts');
hooks.deregister();

test('expired action responses never replay writes; reads renew once and repeated expiry stops', async () => {
  const material = createE2EEKeyMaterial();
  const url = 'http://127.0.0.1:1'; // fetch is replaced below; no external or Mac actions.
  const originalFetch = globalThis.fetch;
  let sessions, requests, alwaysExpire;
  globalThis.fetch = async (target, options) => {
    const { envelope } = JSON.parse(options.body);
    if (target.endsWith('/session')) {
      const payload = openE2EE(material, 'session', envelope);
      sessions++;
      return Response.json({ envelope: sealE2EE(material, `session-response:${payload.requestId}`, {
        sessionId: `test_session_number_${sessions}`, expiresAt: Date.now() + 1800000,
      }) });
    }
    const payload = openE2EE(material, `request:${envelope.sessionId}`, envelope);
    requests++;
    // Models an action accepted by the Mac, then expiry before sealing its receipt.
    if (requests === 1 || alwaysExpire) return Response.json({ code: 'E2EE_SESSION_EXPIRED' }, { status: 409 });
    return Response.json({ envelope: sealE2EE(material, `response:${envelope.sessionId}:${payload.requestId}`, {
      status: 200, body: JSON.stringify({ ok: true }),
    }) });
  };
  try {
    for (const path of ['/api/remote/send', '/api/remote/approval', '/api/remote/fork', '/api/actions/fast', '/api/keyboard/press', '/api/voice/offer']) {
      resetEncryptedBridgeSession(url, material); sessions = requests = 0;
      await assert.rejects(bridgeRequest(url, 'token', path, { method: 'POST', body: {} }, material), /操作结果未确认/);
      assert.equal(requests, 1, path); assert.equal(sessions, 1, path);
    }
    resetEncryptedBridgeSession(url, material); sessions = requests = 0;
    assert.deepEqual(await bridgeRequest(url, 'token', '/api/status', {}, material), { ok: true });
    assert.equal(requests, 2); assert.equal(sessions, 2);
    resetEncryptedBridgeSession(url, material); sessions = requests = 0; alwaysExpire = true;
    await assert.rejects(bridgeRequest(url, 'token', '/api/status', {}, material));
    assert.equal(requests, 2); assert.equal(sessions, 2);
  } finally {
    globalThis.fetch = originalFetch;
    resetEncryptedBridgeSession(url, material);
  }
});
