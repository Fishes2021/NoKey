import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, access, rm, rename } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const volume = await mkdtemp(path.resolve('build/name-migration-'));
const old = path.join(volume, 'Applications/语音快捷键盘.app');
const current = path.join(volume, 'Applications/NoKey.app');
const run = () => spawnSync('/bin/sh', ['desktop/installer/preinstall', 'test.pkg', '/', volume], { encoding: 'utf8' });
try {
  await mkdir(path.join(old, 'Contents'), { recursive: true });
  await writeFile(path.join(old, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>org.voicedeck.desktop</string></dict></plist>');
  let result = run(); assert.equal(result.status, 0, result.stderr);
  await access(current); await assert.rejects(access(old));
  assert.equal(run().status, 0);
  await rename(current, old); await mkdir(current);
  assert.equal(run().status, 1); await access(old);
  console.log('Name migration: moves own old bundle, repeat safe, refuses conflicting destination.');
} finally { await rm(volume, { recursive: true, force: true }); }
