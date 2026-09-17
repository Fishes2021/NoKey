import assert from 'node:assert/strict';
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'build/desktop'), { recursive: true });
const work = await mkdtemp(path.join(root, 'build/desktop/uninstall-'));
const volume = path.join(work, 'volume'), scripts = path.join(work, 'scripts');
await mkdir(volume); await mkdir(scripts);
await copyFile(path.join(root, 'desktop/installer/validate'), path.join(scripts, 'preinstall'));
await copyFile(path.join(root, 'desktop/uninstaller/postinstall'), path.join(scripts, 'postinstall'));
const app = path.join(volume, 'Applications/语音快捷键盘.app');
const driver = path.join(volume, 'Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver');
const own = async (bundle, identifier) => {
  await mkdir(path.join(bundle, 'Contents'), { recursive: true });
  await writeFile(path.join(bundle, 'Contents/Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string></dict></plist>`);
};
const run = () => spawnSync('/bin/sh', [path.join(scripts, 'postinstall'), 'test.pkg', '/', volume], { encoding: 'utf8' });
try {
  const other = path.join(volume, 'Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver');
  const personal = path.join(volume, 'Users/test/Library/Application Support/VoiceDeck/bridge-token');
  await mkdir(other, { recursive: true }); await mkdir(path.dirname(personal), { recursive: true });
  await writeFile(path.join(other, 'keep'), 'other software'); await writeFile(personal, 'test identity');
  await own(app, 'org.voicedeck.desktop'); await own(driver, 'another.vendor');
  assert.equal(run().status, 1);
  await access(app); await access(driver); // Validate both BEFORE deleting either.
  await rm(driver, { recursive: true }); await symlink(other, driver);
  assert.equal(run().status, 1);
  await access(app);
  await rm(driver); await own(driver, 'org.voicedeck.microphone');
  const removed = run(); assert.equal(removed.status, 0, removed.stderr);
  await assert.rejects(access(app)); await assert.rejects(access(driver));
  assert.equal(await readFile(path.join(other, 'keep'), 'utf8'), 'other software');
  assert.equal(await readFile(personal, 'utf8'), 'test identity');
  assert.equal(run().status, 0, 'repeat uninstall is harmless');
  console.log('Uninstall passed in isolated volume: own components removed, conflicts/symlinks rejected before deletion, other driver and personal data retained.');
} finally { await rm(work, { recursive: true, force: true }); }
