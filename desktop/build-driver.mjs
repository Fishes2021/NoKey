// SPDX-License-Identifier: GPL-3.0-only
// Build locally only. This script never installs a driver or restarts system audio.
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const build = path.join(root, 'build/desktop');
const bundle = path.join(build, 'VoiceDeckMicrophone.driver');
const contents = path.join(bundle, 'Contents');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
assert.equal(process.platform, 'darwin', 'The driver build requires macOS.');
await mkdir(path.join(contents, 'MacOS'), { recursive: true });
await mkdir(path.join(contents, 'Resources'), { recursive: true });
const flags = ['-std=gnu11', '-O2', '-fblocks', '-mmacosx-version-min=13.0',
  '-framework', 'CoreAudio', '-framework', 'CoreFoundation', '-framework', 'Accelerate'];
const check = path.join(build, 'driver-check');
run('xcrun', ['clang', ...flags, 'desktop/audio/driver-check.c', '-o', check]);
console.log(run(check, []));
run('xcrun', ['clang', ...flags, '-bundle', 'desktop/audio/VoiceDeckDriver.c',
  '-o', path.join(contents, 'MacOS/VoiceDeckMicrophone')]);
const template = await readFile(path.join(root, 'vendor/BlackHole/BlackHole/BlackHole.plist'), 'utf8');
const plist = template.replace('${EXECUTABLE_NAME}', 'VoiceDeckMicrophone')
  .replace('$(PRODUCT_BUNDLE_IDENTIFIER)', 'org.voicedeck.microphone')
  .replace('${PRODUCT_NAME}', 'VoiceDeckMicrophone')
  .replace('$(MARKETING_VERSION)', '0.1.0')
  .replace('<string>596</string>', '<string>1</string>');
assert(!plist.includes('$'), 'Unresolved build variable in driver plist.');
await writeFile(path.join(contents, 'Info.plist'), plist);
await copyFile(path.join(root, 'vendor/BlackHole/LICENSE'), path.join(contents, 'Resources/BlackHole-LICENSE.txt'));
run('plutil', ['-lint', path.join(contents, 'Info.plist')]);
run('codesign', ['--force', '--sign', '-', bundle]);
run('codesign', ['--verify', '--strict', bundle]);
console.log(`Built development driver: ${bundle}`);
