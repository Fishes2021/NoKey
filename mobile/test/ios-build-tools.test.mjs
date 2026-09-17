import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('native tool preflight rejects missing tools and never claims compilation', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'voicedeck-tools-'));
  const script = fileURLToPath(new URL('../scripts/build-ios.mjs', import.meta.url));
  const check = () => spawnSync(process.execPath, [script, '--check-tools'], {
    env: { ...process.env, PATH: directory }, encoding: 'utf8', timeout: 20000,
  });
  try {
    const missing = check();
    assert.equal(missing.status, 1);
    for (const name of ['Xcode', 'iPhoneOS SDK', 'CocoaPods']) assert(missing.stderr.includes(name));
    for (const name of ['xcodebuild', 'xcrun', 'pod']) {
      await writeFile(path.join(directory, name), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    const available = check();
    assert.equal(available.status, 0, available.stderr);
    assert(available.stdout.includes('尚未编译'));
    assert(!available.stdout.includes('compiled-unsigned'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
