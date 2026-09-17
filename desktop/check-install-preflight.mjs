import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, symlink, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
await mkdir(path.join(root, 'build/desktop'), { recursive: true });
const fixture = await mkdtemp(path.join(root, 'build/desktop/install-preflight-'));
const script = path.join(root, 'desktop/installer/validate');
const check = () => spawnSync('/bin/sh', [script, 'test.pkg', '/', fixture], { encoding: 'utf8' });
const app = path.join(fixture, 'Applications/语音快捷键盘.app');
const driver = path.join(fixture, 'Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver');
const plist = id => `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`;
try {
  assert.equal(check().status, 0, 'empty destination');
  for (const [bundle, id] of [[app, 'org.voicedeck.desktop'], [driver, 'org.voicedeck.microphone']]) {
    await mkdir(path.join(bundle, 'Contents'), { recursive: true });
    await writeFile(path.join(bundle, 'Contents/Info.plist'), plist(id));
  }
  const sentinel = path.join(fixture, 'keep-personal-data');
  await writeFile(sentinel, 'unchanged');
  assert.equal(check().status, 0, 'own existing bundles');
  for (const bundle of [app, driver]) {
    const info = path.join(bundle, 'Contents/Info.plist'), original = await readFile(info);
    await writeFile(info, plist('another.vendor'));
    assert.equal(check().status, 1, 'different vendor must not be overwritten');
    assert.match(check().stderr, /其他软件/);
    await writeFile(info, 'invalid plist');
    assert.equal(check().status, 1, 'unreadable bundle identity');
    assert.match(check().stderr, /无法识别/);
    await writeFile(info, original);
    await rm(info); await symlink(sentinel, info);
    assert.equal(check().status, 1, 'symlinked metadata');
    await rm(info); await writeFile(info, original);
  }
  await rm(app, { recursive: true }); await symlink('nonexistent', app);
  assert.equal(check().status, 1, 'dangling destination link');
  await rm(app);
  const hal = path.dirname(driver);
  await rm(hal, { recursive: true }); await symlink(path.join(fixture, 'elsewhere'), hal);
  assert.equal(check().status, 1, 'symlinked parent');
  assert.equal(await readFile(sentinel, 'utf8'), 'unchanged');
  assert.equal(spawnSync('/bin/sh', [script, 'test.pkg', '/', 'relative'], { encoding: 'utf8' }).status, 1);
  console.log('Installer preflight passed: empty/own destinations, vendor conflicts, symlink parents/metadata and no data changes.');
} finally { await rm(fixture, { recursive: true, force: true }); }
