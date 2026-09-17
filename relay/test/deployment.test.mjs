import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { prepareDeployment } from '../scripts/prepare-deployment.mjs';
import { startRelay } from '../src/node-server.mjs';
test('deployment generation is private, complete, consistent and never overwrites keys', async () => {
  const parent = await mkdtemp(path.resolve('build/deploy-test-'));
  const output = path.join(parent, 'release');
  const spec = { domain: 'relay.example.cn', publicIp: '203.0.113.10', privateIp: '10.0.0.2',
    devices: [{ deviceId: 'test_deployment_mac_1234', secretHash: 'a'.repeat(64) }] };
  try {
    await assert.rejects(prepareDeployment({ ...spec, domain: 'x.cn\nmalicious=1' }, output));
    await assert.rejects(prepareDeployment({ ...spec, devices: [{ ...spec.devices[0], deviceSecret: 'do-not-upload' }] }, output));
    const result = await prepareDeployment(spec, output);
    const config = JSON.parse(await readFile(path.join(output, 'config/relay.json')));
    assert.equal((await stat(path.join(output, 'config/relay.json'))).mode & 0o777, 0o600);
    assert(!JSON.stringify(result).includes(config.turn.secret));
    const turn = await readFile(path.join(output, 'config/turnserver.conf'), 'utf8');
    assert(turn.includes(`static-auth-secret=${config.turn.secret}\n`));
    assert(turn.includes('external-ip=203.0.113.10/10.0.0.2'));
    assert(turn.includes('denied-peer-ip=169.254.0.0-169.254.255.255'));
    const runtime = await import(path.join(output, 'app/relay/src/node-server.mjs'));
    const server = await runtime.startRelay({ ...config, port: 0 });
    try { assert.equal((await fetch(`http://127.0.0.1:${server.port}/health`)).status, 200); }
    finally { await server.close(); }
    await assert.rejects(prepareDeployment(spec, output));
    assert.equal(JSON.parse(await readFile(path.join(output, 'config/relay.json'))).turn.secret, config.turn.secret);
  } finally { await rm(parent, { recursive: true, force: true }); }
});
