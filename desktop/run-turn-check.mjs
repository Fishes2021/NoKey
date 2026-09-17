// Bounded, loopback-only coturn + Chromium audio integration check.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, connect } from 'node:net';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { issueTurnCredentials } from '../relay/src/turn-credentials.mjs';
const transport = process.env.VOICEDECK_TURN_TRANSPORT || 'udp';
if (!['udp', 'tcp'].includes(transport)) throw new Error('TURN test transport must be udp or tcp');
const root = fileURLToPath(new URL('../', import.meta.url));
const binary = process.env.COTURN_BINARY || path.join(root, 'build/turn-deps/coturn-4.18.0/bin/turnserver');
await mkdir(path.join(root, 'build/desktop'), { recursive: true });
const directory = await mkdtemp(path.join(root, 'build/desktop/turn-check-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const secret = randomBytes(32).toString('hex');
const config = path.join(directory, 'turn.conf');
await writeFile(config, [
  'listening-ip=127.0.0.1', 'relay-ip=127.0.0.1', `listening-port=${port}`,
  'realm=voicedeck-test', 'fingerprint', 'use-auth-secret', `static-auth-secret=${secret}`,
  'no-cli', 'no-tls', 'no-dtls', 'no-multicast-peers', 'allow-loopback-peers',
  'denied-peer-ip=0.0.0.0-255.255.255.255', 'allowed-peer-ip=127.0.0.1',
  'user-quota=8', 'total-quota=16', 'relay-threads=1',
  `pidfile=${path.join(directory, 'turn.pid')}`, `log-file=${path.join(directory, 'turn.log')}`,
].join('\n') + '\n', { mode: 0o600 });
const turn = spawn(binary, ['-c', config], { stdio: ['ignore', 'pipe', 'pipe'] });
let turnError, log = '';
turn.on('error', error => { turnError = error; });
for (const stream of [turn.stdout, turn.stderr]) stream.on('data', chunk => { log = (log + chunk).slice(-12000); });
const turnDone = new Promise(resolve => turn.once('close', resolve));
let check;
const watchdog = setTimeout(() => { check?.kill('SIGTERM'); turn.kill('SIGTERM'); }, 35000);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (turnError) throw turnError;
    if (turn.exitCode !== null || turn.signalCode !== null) throw new Error('coturn exited before readiness');
    ready = await new Promise(resolve => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
    });
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  if (!ready) throw new Error('coturn did not become ready');
  const configs = Array.from({ length: 4 }, (_, index) => issueTurnCredentials({
    secret, deviceId: 'local_test_phone_1234567890', urls: [`turn:127.0.0.1:${port}?transport=${transport}`],
    now: Date.now() + (index === 0 ? -3590000 : index * 120000),
  }));
  // Accelerate TURN-server credential expiry only. Client expiry scheduling has
  // a separate mock-clock regression; don't let its 30-second guard stop this probe.
  const credentialExpiresAt = configs[0].expiresAt;
  configs[0].expiresAt = null;
  const rtcConfig = path.join(directory, 'rtc.json');
  await writeFile(rtcConfig, JSON.stringify({ configs, credentialExpiresAt, iceTransportPolicy: 'relay' }), { mode: 0o600 });
  check = spawn(process.execPath, [path.join(root, 'desktop/run-rtc-check.mjs')], {
    cwd: root, env: { ...process.env, VOICEDECK_RTC_CONFIG: rtcConfig }, stdio: 'inherit',
  });
  const [code, signal] = await once(check, 'close');
  if (code !== 0 || signal) throw new Error(`TURN audio check failed: ${code}/${signal}`);
  if (turn.exitCode !== null || turn.signalCode !== null) throw new Error('coturn exited during audio test');
} catch (error) {
  console.error(log); throw error;
} finally {
  clearTimeout(watchdog);
  check?.kill('SIGTERM');
  turn.kill('SIGTERM');
  let forced = false;
  const shutdown = setTimeout(() => { forced = true; turn.kill('SIGKILL'); }, 10000);
  await turnDone; clearTimeout(shutdown);
  await rm(directory, { recursive: true, force: true });
  if (forced) throw new Error('coturn failed to stop within 10 seconds');
}
