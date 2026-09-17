import test from 'node:test';
import assert from 'node:assert/strict';
import { confirmPairingWithDeadline } from '../lib/pairing-confirmation.mjs';
import { responseTimeout } from '../../relay/src/index.js';

test('human pairing approval can take 20 seconds but times out at 45 seconds', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal, approve;
  const pending = confirmPairingWithDeadline(request => {
    signal = request.signal;
    assert.equal(request.keyId, 'phone');
    return new Promise(resolve => { approve = resolve; });
  }, 'phone');
  await Promise.resolve();
  t.mock.timers.tick(20000);
  assert.equal(signal.aborted, false);
  approve(true);
  assert.equal(await pending, true);
  const expired = confirmPairingWithDeadline(request => {
    signal = request.signal;
    return new Promise(resolve => { approve = resolve; });
  }, 'phone');
  await Promise.resolve();
  t.mock.timers.tick(45000);
  assert.equal(await expired, false);
  assert.equal(signal.aborted, true);
  approve(true); // A late click cannot change the already rejected result.
  assert.equal(responseTimeout('/api/e2ee/pair'), 55000);
  assert.equal(responseTimeout('/api/e2ee'), 15000);
});
