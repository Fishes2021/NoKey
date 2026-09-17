import test from 'node:test';
import assert from 'node:assert/strict';
import { issueTurnCredentials } from '../src/turn-credentials.mjs';

test('coturn REST credentials use expiring usernames and the interoperable HMAC-SHA1 signature', () => {
  const options = { secret: '0123456789abcdef0123456789abcdef', deviceId: 'abcdefghijklmnopqrstuv',
    urls: ['turn:relay.example.cn:3478?transport=udp'], now: 1800000000000 };
  const result = issueTurnCredentials(options);
  assert.equal(result.expiresAt, 1800003600000);
  assert.equal(result.iceServers[0].username, '1800003600:abcdefghijklmnopqrstuv');
  // Independently calculated with Python hashlib/hmac per coturn's documented protocol.
  assert.equal(result.iceServers[0].credential, '9/lCgBI40+S8Sy/jnkTil4E86K8=');
  assert(!JSON.stringify(result).includes(options.secret));
  for (const bad of [{ secret: 'short' }, { deviceId: '../other' }, { ttlSeconds: 86400 },
    { ttlSeconds: 0 }, { urls: ['https://other.example'] }, { urls: ['stun:relay.example.cn'] }])
    assert.throws(() => issueTurnCredentials({ ...options, ...bad }));
});
