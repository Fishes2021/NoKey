import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  claimPairingPayload,
  buildPairingHttpUrl,
  buildPairingUrl,
  normalizeBridgeUrl,
  parsePairingUrl,
} from '../lib/pairing.ts';

const controllerSource = await readFile(
  new URL('../app/index.tsx', import.meta.url),
  'utf8',
);
const bridgeSource = await readFile(
  new URL('../../bridge/server.mjs', import.meta.url),
  'utf8',
);
const bridgeClientSource = await readFile(
  new URL('../lib/bridge.ts', import.meta.url),
  'utf8',
);
const layoutSource = await readFile(
  new URL('../app/_layout.tsx', import.meta.url),
  'utf8',
);
const fontsSource = await readFile(
  new URL('../lib/fonts.ts', import.meta.url),
  'utf8',
);

test('pairing URLs round-trip without changing credentials', () => {
  const credentials = {
    bridgeUrl: 'http://192.168.1.17:3210',
    token: 'PRIVATE-CODE',
  };
  assert.deepEqual(parsePairingUrl(buildPairingUrl(credentials)), credentials);
  assert.deepEqual(parsePairingUrl(buildPairingHttpUrl(credentials)), credentials);

  const encryptedCredentials = {
    ...credentials,
    e2ee: {
      keyId: 'encrypted_client_123456',
      key: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    },
  };
  assert.deepEqual(parsePairingUrl(buildPairingUrl(encryptedCredentials)), encryptedCredentials);
  assert.deepEqual(parsePairingUrl(buildPairingHttpUrl(encryptedCredentials)), encryptedCredentials);
});

test('one-time pairing QR codes are parsed without exposing a persistent token', () => {
  const encryptedKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  assert.deepEqual(
    parsePairingUrl(
      `https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv/pair?code=E2EE-CODE#e2ee=1&keyId=encrypted_client_123456&key=${encryptedKey}`,
    ),
    {
      bridgeUrl:
        'https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv',
      code: 'E2EE-CODE',
      e2ee: { keyId: 'encrypted_client_123456', key: encryptedKey },
    },
  );
  assert.deepEqual(
    parsePairingUrl(
      'https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv/pair?code=STABLE-CODE',
    ),
    {
      bridgeUrl:
        'https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv',
      code: 'STABLE-CODE',
    },
  );
  assert.deepEqual(
    parsePairingUrl('https://fresh-microdex.trycloudflare.com/pair?code=REMOTE-CODE'),
    {
      bridgeUrl: 'https://fresh-microdex.trycloudflare.com',
      code: 'REMOTE-CODE',
    },
  );
  assert.deepEqual(
    parsePairingUrl('http://192.168.1.17:3210/pair?code=ONE-TIME-CODE'),
    {
      bridgeUrl: 'http://192.168.1.17:3210',
      code: 'ONE-TIME-CODE',
    },
  );
  assert.deepEqual(
    parsePairingUrl(
      'microdex://pair?url=http%3A%2F%2F192.168.1.17%3A3210&code=ONE-TIME-CODE',
    ),
    {
      bridgeUrl: 'http://192.168.1.17:3210',
      code: 'ONE-TIME-CODE',
    },
  );
});

test('bridge addresses are normalized and unsafe URL shapes are rejected', () => {
  assert.equal(normalizeBridgeUrl(' http://192.168.1.17:3210/ '), 'http://192.168.1.17:3210');
  assert.equal(
    normalizeBridgeUrl('https://fresh-microdex.trycloudflare.com/'),
    'https://fresh-microdex.trycloudflare.com',
  );
  assert.equal(
    normalizeBridgeUrl(
      'https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv/',
    ),
    'https://microdex-relay.microdex-cli.workers.dev/v1/devices/abcdefghijklmnopqrstuv',
  );
  assert.throws(() => normalizeBridgeUrl('ftp://192.168.1.17/file'));
  assert.throws(() => normalizeBridgeUrl('http://user:pass@192.168.1.17:3210'));
  assert.throws(() => normalizeBridgeUrl('http://public-bridge.example.com'));
  assert.throws(() => normalizeBridgeUrl('https://public-bridge.example.com/unexpected'));
  assert.throws(() => normalizeBridgeUrl('https://relay.example/v1/devices/short'));
});

test('foreign and incomplete QR codes are rejected', () => {
  assert.throws(() => parsePairingUrl('https://example.com'));
  assert.throws(() => parsePairingUrl('microdex://pair?url=http://192.168.1.17:3210'));
  assert.throws(() => parsePairingUrl('http://192.168.1.17:3210/pair'));
  assert.throws(() => parsePairingUrl(
    'https://relay.example/v1/devices/abcdefghijklmnopqrstuv/pair?code=CODE#e2ee=1&keyId=missing_key_123456',
  ));
});

test('the phone supports QR pairing and automatic network reconnection', () => {
  assert.match(controllerSource, /CameraView/);
  assert.match(controllerSource, /parsePairingUrl/);
  assert.match(controllerSource, /claimPairingPayload/);
  assert.match(
    controllerSource,
    /setSettingsVisible\(false\);[\s\S]*setTimeout\(\(\) => setScannerVisible\(true\)/,
  );
  assert.match(controllerSource, /Network\.useNetworkState\(\)/);
  assert.match(controllerSource, /AppState\.addEventListener/);
  assert.match(controllerSource, /reconnectAttempt/);
  assert.match(bridgeClientSource, /\$\{basePath\}\/api\/remote\/events/);
  assert.match(bridgeClientSource, /payload\.code === 'MAC_OFFLINE'/);
  assert.match(bridgeClientSource, /type: 'e2ee-auth'/);
  assert.match(controllerSource, /STORAGE_E2EE/);
});

test('the controller gates use on pairing and offers target confirmation', () => {
  assert.match(controllerSource, /!status \? \(/);
  assert.match(controllerSource, /确认要连接的 Mac/);
  assert.match(controllerSource, /if \(!accepted \|\| controller\.signal\.aborted\) return false/);
  assert.match(controllerSource, /deleteStoredValue\(STORAGE_TOKEN\)/);
  assert.doesNotMatch(controllerSource, /npx microdex-cli@latest setup/);
});

test('the desktop bridge displays a Microdex pairing QR', () => {
  assert.match(bridgeSource, /pathname === '\/pair'/);
  assert.match(bridgeSource, /printQr\(pairingUrl, qrcode\)/);
  assert.match(bridgeSource, /pairingUrl\.searchParams\.set\('code', pairingSession\.code\)/);
  assert.match(bridgeSource, /transport: remoteTunnelState\.transport/);
  assert.match(bridgeSource, /pairingUrl\.hash = new URLSearchParams/);
  assert.doesNotMatch(bridgeSource, /pairingHttpUrl\.searchParams\.set\('token'/);
});

test('the browser pairing deep link resolves to an existing Expo Router screen', async () => {
  const target = bridgeSource.match(/const deepLink = new URL\('([^']+)'\)/)?.[1];
  assert.ok(target, 'the bridge must expose an app deep link');

  const parsed = new URL(target);
  const routeName = (
    parsed.pathname.replace(/^\/+|\/+$/g, '') ||
    parsed.hostname ||
    'index'
  ).toLowerCase();
  const routeUrl = new URL(`../app/${routeName}.tsx`, import.meta.url);

  await assert.doesNotReject(
    access(routeUrl),
    `${target} currently opens Expo Router route /${routeName}, but that screen does not exist`,
  );
});

test('a recognized QR closes the scanner before the network claim can fail', () => {
  const start = controllerSource.indexOf('const claimPairingCode');
  const end = controllerSource.indexOf('const presentPairingScanner', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const handler = controllerSource.slice(start, end);
  const parsed = handler.indexOf('parsePairingUrl(value)');
  const scannerClosed = handler.indexOf('setScannerVisible(false)');
  const networkClaim = handler.indexOf('claimPairingPayload(payload, controller.signal)');

  assert.ok(parsed >= 0 && scannerClosed > parsed);
  assert.ok(
    scannerClosed < networkClaim,
    'the camera remains open after a valid scan and repeatedly scans the same unreachable QR',
  );
});

test('pairing names survive both invitation forms without becoming credentials', () => {
  const http = new URL('http://127.0.0.1:8787/pair?code=once');
  http.hash = new URLSearchParams({ deviceName: '  我的 Mac\n  ' }).toString();
  assert.equal(parsePairingUrl(http.href).deviceName, '我的 Mac');
  const deep = new URL('voicedeck:///pair?url=http%3A%2F%2F127.0.0.1%3A8787&code=once');
  deep.searchParams.set('deviceName', 'x'.repeat(100));
  assert.equal(parsePairingUrl(deep.href).deviceName.length, 80);
  assert.equal(parsePairingUrl(http.href).token, undefined);
  assert.equal(parsePairingUrl(http.href).code, 'once');
});


test('phone waits for human approval and aborts after its outer deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let resolve, signal;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal;
    return new Promise((yes, no) => {
      resolve = yes;
      signal.addEventListener('abort', () => no(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    });
  });
  const payload = { bridgeUrl: 'http://127.0.0.1:8787', code: 'once' };
  const pending = claimPairingPayload(payload);
  t.mock.timers.tick(20000);
  assert.equal(signal.aborted, false);
  resolve({ ok: true, json: async () => ({ token: 'test-token' }) });
  assert.equal((await pending).token, 'test-token');
  const expired = claimPairingPayload(payload);
  const rejected = assert.rejects(expired, /授权超时/);
  t.mock.timers.tick(60000);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('cancelled pairing rejects even a late response from a transport ignoring abort', async t => {
  const controller = new AbortController();
  let respond;
  t.mock.method(globalThis, 'fetch', () => new Promise(resolve => { respond = resolve; }));
  const pending = claimPairingPayload({ bridgeUrl: 'http://127.0.0.1:8787', code: 'once' }, controller.signal);
  const rejected = assert.rejects(pending, /配对已取消/);
  controller.abort();
  respond({ ok: true, json: async () => ({ token: 'late-token' }) });
  await rejected;
  await assert.rejects(claimPairingPayload({ bridgeUrl: 'http://127.0.0.1:8787', token: 'old' }, controller.signal), /配对已取消/);
});
