// Generate an isolated native project using the installed SDK template.
// No downloads, CocoaPods installation, signing or system changes.
import { cp, mkdir, mkdtemp, symlink, writeFile, readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
const mobile = fileURLToPath(new URL('../', import.meta.url));
const build = path.resolve(mobile, '../build');
await mkdir(build, { recursive: true });
const work = await mkdtemp(path.join(build, 'ios-'));
for (const name of ['app.json', 'package.json', 'package-lock.json', 'tsconfig.json', 'assets', 'app', 'components', 'constants', 'hooks', 'lib', 'modules', 'plugins']) {
  await cp(path.join(mobile, name), path.join(work, name), { recursive: true });
}
await symlink(path.join(mobile, 'node_modules'), path.join(work, 'node_modules'));
const result = spawnSync(process.execPath, [path.join(mobile, 'node_modules/expo/bin/cli'), 'prebuild', work,
  '--platform', 'ios', '--no-install', '--template', path.join(mobile, 'node_modules/expo/template.tgz'),
  '--skip-dependency-update', 'react,react-native'], {
  cwd: work, env: { ...process.env, CI: '1', EXPO_OFFLINE: '1', EXPO_NO_TELEMETRY: '1' }, encoding: 'utf8', timeout: 120000,
});
await writeFile(path.join(work, 'prebuild.log'), (result.stdout || '') + (result.stderr || ''));
if (result.error || result.status !== 0) throw result.error || new Error(`iOS generation failed: ${work}/prebuild.log\n${result.stderr}`);
const projects = (await readdir(path.join(work, 'ios'))).filter(name => name.endsWith('.xcodeproj'));
assert.equal(projects.length, 1);
const project = path.join(work, 'ios', projects[0]);
const pbx = await readFile(path.join(project, 'project.pbxproj'), 'utf8');
assert(pbx.includes('org.voicedeck.mobile'));
const podfile = await readFile(path.join(work, 'ios/Podfile'), 'utf8');
assert(podfile.includes('use_expo_modules!'));
const infoResult = spawnSync('plutil', ['-convert', 'json', '-o', '-', path.join(work, 'ios', path.basename(project, '.xcodeproj'), 'Info.plist')], { encoding: 'utf8' });
assert.equal(infoResult.status, 0, infoResult.stderr);
const info = JSON.parse(infoResult.stdout);
assert.equal(info.UIApplicationSceneManifest.UIApplicationSupportsMultipleScenes, false);
assert.equal(info.UIApplicationSceneManifest.UISceneConfigurations.UIWindowSceneSessionRoleApplication[0].UISceneDelegateClassName, '$(PRODUCT_MODULE_NAME).VoiceDeckSceneDelegate');
const delegate = await readFile(path.join(work, 'ios', path.basename(project, '.xcodeproj'), 'AppDelegate.swift'), 'utf8');
assert(delegate.includes('UIWindow(windowScene: windowScene)'));
assert(!delegate.includes('UIWindow(frame: UIScreen.main.bounds)'));
assert.equal(delegate.match(/startReactNative\(/g)?.length, 1);
assert.equal(info.CFBundleDisplayName, '语音快捷键盘');
assert.deepEqual(info.UIBackgroundModes, ['audio']);
assert(info.NSMicrophoneUsageDescription.includes('实时传送'));
assert(info.NSLocalNetworkUsageDescription.includes('Mac'));
assert(!info.NSFaceIDUsageDescription, 'No biometric authentication is used');
assert(!info.NSAppTransportSecurity.NSAllowsArbitraryLoads);
assert(info.CFBundleURLTypes.some(item => item.CFBundleURLSchemes.includes('voicedeck')));
const linking = spawnSync(process.execPath, [path.join(mobile, 'node_modules/expo/bin/autolinking'), 'resolve', '--platform', 'apple', '--project-root', work, '--json'], { cwd: work, encoding: 'utf8', timeout: 30000 });
assert.equal(linking.status, 0, linking.stderr);
await writeFile(path.join(work, 'autolinking.json'), linking.stdout);
assert(JSON.parse(linking.stdout).modules.some(module => module.modules?.includes('VoiceDeckAudioModule')));
await writeFile(path.join(build, 'ios-latest.json'), JSON.stringify({ work, project, status: 'generated-only; Pods and Xcode build pending' }, null, 2));
console.log(JSON.stringify({ work, project, status: 'Generated iOS project; not compiled or signed.' }));
