// SPDX-License-Identifier: GPL-3.0-only
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build/desktop');
if (process.platform !== 'darwin') throw new Error('Requires macOS.');
await mkdir(build, { recursive: true });
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const flags = ['-Wall', '-Wextra', '-Werror', '-fobjc-arc', '-mmacosx-version-min=13.0',
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon'];
const check = path.join(build, 'keyboard-check');
run('xcrun', ['clang', ...flags, '-DVD_KEYBOARD_CHECK', '-g', '-fsanitize=address,undefined', 'desktop/keyboard-addon.m', '-o', check]);
console.log(run(check, []));
const headers = process.env.NODE_INCLUDE_DIR || path.resolve(path.dirname(process.execPath), '../include/node');
await access(path.join(headers, 'node_api.h'));
run('xcrun', ['clang', ...flags, '-O2', '-bundle', '-undefined', 'dynamic_lookup', '-I', headers,
  'desktop/keyboard-addon.m', '-o', path.join(build, 'keyboard.node')]);
console.log('Built keyboard binding; no permission request or keystroke injection.');
