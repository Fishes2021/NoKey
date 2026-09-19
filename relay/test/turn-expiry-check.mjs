// Bounded real coturn check, loopback only; no persistent service or microphone access.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { issueTurnCredentials } from '../src/turn-credentials.mjs';
import { turnCommand, closeExpiredTurnSessions } from '../src/turn-admin.mjs';
const root = process.cwd();
async function freePort() { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
const port = await freePort(), admin = { port: await freePort(), password: randomBytes(32).toString('base64url') };
const directory = await mkdtemp(path.join(root, 'build/turn-expiry-'));
const secret = randomBytes(32).toString('hex');
const config = path.join(directory, 'turn.conf');
await writeFile(config, ['listening-ip=127.0.0.1', 'relay-ip=127.0.0.1', `listening-port=${port}`, 'realm=nokey-test', 'use-auth-secret', `static-auth-secret=${secret}`, 'cli', 'cli-ip=127.0.0.1', `cli-port=${admin.port}`, `cli-password=${admin.password}`, 'no-tls', 'no-dtls', 'allow-loopback-peers', 'no-multicast-peers', 'relay-threads=1', `pidfile=${directory}/turn.pid`, `log-file=${directory}/turn.log`].join('\n'), { mode: 0o600 });
const binary = path.join(root, 'build/turn-deps/coturn-4.18.0/bin');
const turn = spawn(path.join(binary, 'turnserver'), ['-c', config], { stdio: 'ignore' }); const done = once(turn, 'exit'); let client, clientDone;
try {
  let ready = false;
  for (let i = 0; i < 20; i++) { try { await turnCommand(admin, 'ps'); ready = true; break; } catch { await delay(200); } }
  assert(ready, 'coturn admin ready');
  const credentials = issueTurnCredentials({ secret, urls: [`turn:127.0.0.1:${port}?transport=tcp`], deviceId: 'subscription_test_device_001' }).iceServers[0];
  client = spawn(path.join(binary, 'turnutils_uclient'), ['-t', '-y', '-c', '-n', '1000', '-p', String(port), '-u', credentials.username, '-w', credentials.credential, '127.0.0.1'], { stdio: 'ignore' }); clientDone = once(client, 'exit');
  let active;
  for (let i = 0; i < 30; i++) { active = await turnCommand(admin, 'ps'); if (active.includes(`user <${credentials.username}>`)) break; await delay(200); }
  assert(active.includes(`user <${credentials.username}>`), 'real authenticated allocation exists');
  await closeExpiredTurnSessions(admin, () => true);
  assert((await turnCommand(admin, 'ps')).includes(`user <${credentials.username}>`), 'valid subscription retained');
  await closeExpiredTurnSessions(admin, () => false);
  let after;
  for (let i = 0; i < 30; i++) { after = await turnCommand(admin, 'ps'); if (!after.includes(`user <${credentials.username}>`)) break; await delay(100); }
  assert(!after.includes(`user <${credentials.username}>`), 'expired allocations forcibly closed');
  console.log('Real coturn: valid allocation retained; expired subscription allocation closed.');
} finally { client?.kill('SIGTERM'); turn.kill('SIGTERM'); if (clientDone) await clientDone; await done; await rm(directory, { recursive: true, force: true }); }
