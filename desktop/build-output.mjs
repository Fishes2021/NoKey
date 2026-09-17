// SPDX-License-Identifier: GPL-3.0-only
import { mkdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build/desktop');
if (process.platform !== 'darwin') throw new Error('Requires macOS.');
await mkdir(build, { recursive: true });
function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}
const flags = ['-std=gnu11', '-Wall', '-Wextra', '-Werror', '-mmacosx-version-min=13.0',
  '-framework', 'AudioToolbox', '-framework', 'CoreAudio', '-framework', 'CoreFoundation'];
const source = 'desktop/audio/voice-output.c';
const check = path.join(build, 'voice-output-check');
run('xcrun', ['clang', ...flags, '-g', '-fsanitize=address,undefined', '-DVD_OUTPUT_CHECK', source, '-o', check]);
console.log(run(check, []));
run('xcrun', ['clang', ...flags, '-O2', '-dynamiclib', source,
  '-install_name', '@rpath/libVoiceDeckOutput.dylib', '-o', path.join(build, 'libVoiceDeckOutput.dylib')]);
console.log('Built Mac PCM output library (no driver installation or audio playback).');
const headers = process.env.NODE_INCLUDE_DIR || path.resolve(path.dirname(process.execPath), '../include/node');
await access(path.join(headers, 'node_api.h'));
run('xcrun', ['clang', ...flags, '-O2', '-bundle', '-undefined', 'dynamic_lookup',
  '-I', headers, source, 'desktop/audio/output-addon.c', '-o', path.join(build, 'voice-output.node')]);
console.log('Built N-API audio output binding.');
