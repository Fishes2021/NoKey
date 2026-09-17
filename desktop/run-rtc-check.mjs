import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const child = spawn(require('electron'), [fileURLToPath(new URL(process.argv[2] || './check-rtc.cjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'] });
let output = '', errors = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { errors += chunk; });
const timer = setTimeout(() => child.kill('SIGTERM'), 30000);
child.on('error', error => { clearTimeout(timer); throw error; });
child.on('close', (code, signal) => {
  clearTimeout(timer);
  assert.equal(signal, null, `Electron terminated: ${signal}\n${errors}`);
  assert.equal(code, 0, `Electron exit ${code}\n${errors}`);
  const result = output.trim().split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)).at(-1);
  assert(result?.ok, `${JSON.stringify(result)}\n${errors}`);
  console.log(result.message || `${result.relay ? "TURN relay" : "WebRTC"} audio passed: ${result.rounds} sessions, ${result.blocks} PCM blocks, normal process exit.`);
});
