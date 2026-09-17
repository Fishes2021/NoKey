// Generate a private, standalone upload directory. Never contacts or starts a server.
import { randomBytes } from 'node:crypto';
import { isIPv4 } from 'node:net';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { issueTurnCredentials } from '../src/turn-credentials.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));

export async function prepareDeployment(spec, destination) {
  const { domain, publicIp, privateIp = publicIp, devices } = spec;
  if (typeof domain !== 'string' || domain.length > 253 || !domain.includes('.') ||
      !domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !isIPv4(publicIp) || !isIPv4(privateIp)) throw new Error('需要纯小写域名、公网 IPv4 和网卡 IPv4');
  if (!Array.isArray(devices) || !devices.length || devices.length > 100 || devices.some(device =>
      !/^[A-Za-z0-9_-]{20,64}$/.test(device.deviceId || '') || !/^[a-f0-9]{64}$/.test(device.secretHash || '') ||
      Object.keys(device).some(key => !['deviceId', 'secretHash'].includes(key))) ||
      new Set(devices.map(device => device.deviceId)).size !== devices.length)
    throw new Error('需要至少一台 Mac 登记信息，仅接受 deviceId 和 secretHash，不能上传原始密钥');
  const secret = randomBytes(32).toString('hex');
  const turn = { secret, urls: [`turn:${domain}:3478?transport=udp`, `turn:${domain}:3478?transport=tcp`, `turns:${domain}:5349?transport=tcp`], ttlSeconds: 3600 };
  issueTurnCredentials({ ...turn, deviceId: devices[0].deviceId });
  // Exclusive directory creation prevents accidental secret rotation or overwrites.
  await mkdir(destination, { mode: 0o700 });
  await mkdir(path.join(destination, 'config'), { mode: 0o700 });
  for (const relative of ['package.json', 'package-lock.json', 'LICENSE', 'relay/src/node-server.mjs',
    'relay/src/index.js', 'relay/src/turn-credentials.mjs', 'bridge/lib/remote-relay.mjs', 'mobile/lib/ice-config.mjs']) {
    const target = path.join(destination, 'app', relative);
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(path.join(root, relative), target);
  }
  const save = (name, content) => writeFile(path.join(destination, name), content, { mode: 0o600, flag: 'wx' });
  await save('config/relay.json', JSON.stringify({ publicOrigin: `https://${domain}`, host: '127.0.0.1', port: 8787,
    devices: Object.fromEntries(devices.map(device => [device.deviceId, device.secretHash])), turn }, null, 2) + '\n');
  let coturn = await readFile(path.join(root, 'relay/deploy/turnserver.example.conf'), 'utf8');
  coturn = coturn.replaceAll('turn.example', domain).replaceAll('10.0.0.2', privateIp).replaceAll('203.0.113.10', publicIp)
    .replace('static-auth-secret=\n', `static-auth-secret=${secret}\n`)
    .replaceAll('/etc/voicedeck/tls/turn-fullchain.pem', `/etc/letsencrypt/live/${domain}/fullchain.pem`)
    .replaceAll('/etc/voicedeck/tls/turn-key.pem', `/etc/letsencrypt/live/${domain}/privkey.pem`);
  if (publicIp === privateIp) coturn = coturn.replace(/^external-ip=.*\n/m, '');
  await save('config/turnserver.conf', coturn);
  const nginx = (await readFile(path.join(root, 'relay/deploy/nginx.example.conf'), 'utf8')).replaceAll('relay.example', domain)
    .replaceAll('/etc/voicedeck/tls/relay-fullchain.pem', `/etc/letsencrypt/live/${domain}/fullchain.pem`)
    .replaceAll('/etc/voicedeck/tls/relay-key.pem', `/etc/letsencrypt/live/${domain}/privkey.pem`);
  await save('config/nginx.conf', nginx);
  await save('config/nokey-relay.service', `[Unit]
Description=NoKey 国内连接中继
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User=nokey
Group=nokey
WorkingDirectory=/opt/nokey/app
Environment=VOICEDECK_RELAY_CONFIG=/etc/nokey/relay.json
ExecStart=/usr/bin/node relay/src/node-server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
UMask=0077
[Install]
WantedBy=multi-user.target
`);
  await copyFile(path.join(root, 'relay/deploy/RUNBOOK.md'), path.join(destination, '部署说明.md'));
  return { directory: path.resolve(destination), origin: `https://${domain}`, devices: devices.length };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , input, output] = process.argv;
  if (!input || !output || process.argv.length !== 4) throw new Error('用法：node relay/scripts/prepare-deployment.mjs 部署参数.json 新输出目录');
  console.log(JSON.stringify(await prepareDeployment(JSON.parse(await readFile(input, 'utf8')), output)));
}
