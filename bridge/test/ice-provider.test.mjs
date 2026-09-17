import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createIceProvider } from '../../desktop/ice-provider.mjs';
import { validateIceConfig } from '../../mobile/lib/ice-config.mjs';

test('media credentials: authenticated operator origin, bounded response, cache refresh and no public fallback', async () => {
  await mkdir('build/desktop', { recursive: true });
  const stateDir = await mkdtemp('build/desktop/ice-check-');
  let now = Date.now(), calls = 0, bad = false;
  const payload = () => ({ iceServers: [{ urls: ['turn:relay.example.cn:3478?transport=udp', 'turns:relay.example.cn:5349?transport=tcp'],
    username: 'short-lived', credential: 'temporary-password' }], expiresAt: now + 3600000 });
  const provider = createIceProvider({ relayOrigin: 'https://relay.example.cn', stateDir, now: () => now,
    fetchImpl: async (url, options) => {
      calls++;
      assert.match(url, /^https:\/\/relay.example.cn\/v1\/devices\/[\w-]+\/ice$/);
      assert(options.headers['X-Microdex-Device-Secret'].length >= 32);
      assert.equal(options.redirect, 'error');
      return new Response(JSON.stringify(bad ? { iceServers: [], expiresAt: null } : payload()));
    } });
  try {
    const [first, second] = await Promise.all([provider(), provider()]);
    assert.deepEqual(first, second); assert.equal(calls, 1);
    await provider(); assert.equal(calls, 1);
    now += 56 * 60000;
    await provider(); assert.equal(calls, 2);
    for (const value of [null, { iceServers: [{}] }, { ...payload(), expiresAt: now },
      { ...payload(), iceServers: [{ urls: 'https://foreign.example' }] },
      { ...payload(), iceServers: [{ urls: 'turn:relay.example.cn' }] }])
      assert.throws(() => validateIceConfig(value, now));
    now += 56 * 60000; bad = true;
    await assert.rejects(provider(), /TURN/);
    await assert.rejects(provider(), /TURN/);
    assert.equal(calls, 4); // Invalid responses are never cached as usable credentials.
    assert.deepEqual(await createIceProvider({ stateDir })(), { iceServers: [], expiresAt: null });
    const oversized = createIceProvider({ relayOrigin: 'https://relay.example.cn', stateDir,
      fetchImpl: async () => new Response('x'.repeat(16385)) });
    await assert.rejects(oversized(), /过大/);
  } finally { await rm(stateDir, { recursive: true, force: true }); }
});
