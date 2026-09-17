// Build pinned upstream tools only inside build/. No system install or service start.
import { mkdir, access, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build/turn-deps');
await mkdir(build, { recursive: true });
const run = (command, args, cwd, env = process.env) => new Promise((resolve, reject) => {
  const logPath = path.join(build, `${path.basename(cwd)}-${command.replaceAll('/', '_')}.log`);
  const log = createWriteStream(logPath);
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  child.on('error', error => { log.end(); reject(error); });
  child.on('close', (code, signal) => { log.end(); code === 0 ? resolve() : reject(new Error(`${command} failed (${code}/${signal}); ${logPath}`)); });
});
const sources = [
  { name: 'libevent-2.1.13-stable', url: 'https://github.com/libevent/libevent/releases/download/release-2.1.13-stable/libevent-2.1.13-stable.tar.gz',
    sha: 'f7e9383b8c0baa81b687e5b5eecc01beefaf1b19b64151d95ed61647fe7a315c' },
  { name: 'coturn-4.18.0', url: 'https://codeload.github.com/coturn/coturn/tar.gz/refs/tags/4.18.0',
    sha: '28d55294ac596fbd129b293a85e7bb1c5dc4bd15b7fb55c500f355149e5f4e28' },
];
for (const source of sources) {
  const archive = path.join(build, `${source.name}.tar.gz`);
  try { await access(archive); }
  catch { await run('curl', ['-fsSL', '--max-time', '90', source.url, '-o', archive], build,
    { ...process.env, ALL_PROXY: process.env.ALL_PROXY || 'socks5h://127.0.0.1:7897' }); }
  if (createHash('sha256').update(await readFile(archive)).digest('hex') !== source.sha)
    throw new Error(`Upstream archive hash mismatch: ${archive}`);
  try { await access(path.join(build, source.name, 'configure')); }
  catch { await run('tar', ['-xzf', archive, '-C', build], build); }
}
const openssl = process.env.OPENSSL_PREFIX || '/opt/homebrew/opt/openssl@3';
const prefix = path.join(build, 'prefix');
const env = { ...process.env, PKG_CONFIG_PATH: `${prefix}/lib/pkgconfig:${openssl}/lib/pkgconfig` };
const eventDir = path.join(build, sources[0].name);
await run('./configure', [`--prefix=${prefix}`, '--disable-shared', '--enable-openssl', '--disable-samples', '--disable-libevent-regress'], eventDir, env);
await run('make', ['-j4'], eventDir, env);
await run('make', ['install'], eventDir, env);
const turnDir = path.join(build, sources[1].name);
await run('./configure', [`--prefix=${path.join(build, 'coturn-install')}`], turnDir, env);
await run('make', ['-j4'], turnDir, env);
console.log(`Built isolated coturn: ${path.join(turnDir, 'bin/turnserver')}`);
