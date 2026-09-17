import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_RELAY_URL,
  deletePersistentRelayRoom,
  normalizeRelayOrigin,
  persistentRelayIdentity,
  relayDeviceUrl,
  relaySocketUrl,
  safeLocalApiPath,
} from '../lib/remote-relay.mjs';

test('the relay origin is stable, secure, and path-free', () => {
  assert.equal(normalizeRelayOrigin(`${DEFAULT_RELAY_URL}/`), DEFAULT_RELAY_URL);
  assert.throws(() => normalizeRelayOrigin('http://relay.example'));
  assert.throws(() => normalizeRelayOrigin('https://relay.example/unexpected'));
});

test('the Mac relay identity persists with owner-only permissions', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'microdex-relay-identity-'));
  const first = await persistentRelayIdentity(stateDir);
  const second = await persistentRelayIdentity(stateDir);
  assert.deepEqual(second, first);
  assert.match(first.deviceId, /^[A-Za-z0-9_-]{20,64}$/);
  assert.ok(first.deviceSecret.length >= 32);
  const identityPath = path.join(stateDir, 'relay-device.json');
  assert.equal((await stat(identityPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(identityPath, 'utf8'), /access-token/);
});

test('purging a Mac authenticates and deletes its durable relay room', async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'microdex-relay-delete-'));
  const identity = await persistentRelayIdentity(stateDir);
  let request = null;
  try {
    const removed = await deletePersistentRelayRoom({
      stateDir,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    assert.equal(removed, true);
    assert.equal(request.options.method, 'DELETE');
    assert.equal(request.options.headers['X-Microdex-Device-Secret'], identity.deviceSecret);
    assert.match(request.url, new RegExp(`/v1/devices/${identity.deviceId}/reset$`));
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('stable HTTP and WebSocket routes point to the same Mac room', () => {
  const deviceUrl = relayDeviceUrl(DEFAULT_RELAY_URL, 'abcdefghijklmnopqrstuv');
  assert.equal(
    deviceUrl,
    `${DEFAULT_RELAY_URL}/v1/devices/abcdefghijklmnopqrstuv`,
  );
  assert.equal(
    relaySocketUrl(deviceUrl),
    'wss://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv/connect',
  );
});

test('the Mac connector never forwards relay requests outside the local API', () => {
  assert.equal(safeLocalApiPath('/api/remote/state'), '/api/remote/state');
  assert.equal(safeLocalApiPath('/api/remote/send?queued=1'), '/api/remote/send?queued=1');
  assert.equal(safeLocalApiPath('/pair?code=secret'), null);
  assert.equal(safeLocalApiPath('https://evil.example/api/status'), null);
});

test('relay refusal retains its cause, schedules retry and stops cleanly', { timeout: 5000 }, async () => {
  const http = await import('node:http');
  const { once } = await import('node:events');
  const { WebSocket } = await import('ws');
  const { mkdir } = await import('node:fs/promises');
  const { createRemoteRelay } = await import('../lib/remote-relay.mjs');
  await mkdir('build/relay', { recursive: true });
  const stateDir = await mkdtemp('build/relay/refusal-');
  const server = http.createServer((_req, res) => { res.writeHead(401); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let attempts = 0;
  class LocalSocket extends WebSocket {
    constructor(url, options) {
      assert.equal(options.handshakeTimeout, 8000);
      attempts++;
      super(url.replace('wss://relay.example', `ws://127.0.0.1:${server.address().port}`), options);
    }
  }
  const connector = createRemoteRelay({ stateDir, relayOrigin: 'https://relay.example', WebSocketImpl: LocalSocket });
  try {
    connector.start();
    for (let n = 0; n < 150 && !(attempts >= 2 && connector.state().retryAt); n++) await new Promise(resolve => setTimeout(resolve, 20));
    const failed = connector.state();
    assert(attempts >= 2, 'automatically retried');
    assert.equal(failed.ready, false);
    assert.match(failed.error, /401/);
    assert(failed.retryAt > Date.now(), 'next retry time published');
    connector.close();
    assert.equal(connector.state().status, 'closed');
    assert.equal(connector.state().retryAt, null);
    assert.equal(connector.state().error, null);
  } finally {
    connector.close(); await new Promise(resolve => server.close(resolve));
    await rm(stateDir, { recursive: true, force: true });
  }
});
