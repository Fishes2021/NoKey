// Compile an unsigned iPhone app; never install tools, accept licenses or sign.
import { spawnSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const product = path.dirname(root.replace(/\/$/, ''));
assert((await stat(path.join(root, 'scripts/prepare-ios.mjs'))).isFile());
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 1 && args[0] === '--check-tools'), '仅支持 --check-tools');
const missing = [];
for (const [command, parameters, label] of [
  ['xcodebuild', ['-version'], '完整 Xcode（已选择并完成首次设置）'],
  ['xcrun', ['--sdk', 'iphoneos', '--show-sdk-path'], 'Xcode iPhoneOS SDK'],
  ['pod', ['--version'], 'CocoaPods'],
]) {
  const result = spawnSync(command, parameters, { encoding: 'utf8', timeout: 15000 });
  if (result.error || result.status !== 0) missing.push(label);
}
if (missing.length) {
  console.error('原生编译尚不能开始，缺少：' + missing.join('、') + '。未生成新工程或修改系统工具。');
  process.exit(1);
}
if (args[0] === '--check-tools') {
  console.log('Xcode、iPhoneOS SDK 与 CocoaPods 可调用；尚未编译。');
  process.exit(0);
}

function run(command, parameters, cwd, log, timeout) {
  const fd = openSync(log, 'w', 0o600);
  let result;
  try { result = spawnSync(command, parameters, { cwd, stdio: ['ignore', fd, fd], timeout,
    env: { ...process.env, CI: '1', COCOAPODS_DISABLE_STATS: 'true' } }); }
  finally { closeSync(fd); }
  if (result.error || result.status !== 0) throw new Error(`原生构建步骤失败，日志：${log}`);
}

console.log('从当前源码生成独立 iOS 工程…');
const prepared = spawnSync(process.execPath, [path.join(root, 'scripts/prepare-ios.mjs')], { cwd: product, stdio: 'inherit', timeout: 150000 });
assert.equal(prepared.status, 0, '工程生成失败，未继续编译');
const { work, project } = JSON.parse(await readFile(path.join(product, 'build/ios-latest.json'), 'utf8'));
assert(work.startsWith(path.join(product, 'build/ios-')));
assert(path.dirname(project) === path.join(work, 'ios'));
const scheme = path.basename(project, '.xcodeproj');
console.log('安装生成工程的 Pods（可能下载原生依赖，不安装系统工具）…');
run('pod', ['install'], path.join(work, 'ios'), path.join(work, 'pods-install.log'), 15 * 60 * 1000);
const workspace = path.join(work, 'ios', scheme + '.xcworkspace');
assert((await stat(workspace)).isDirectory());
console.log('编译 Release iPhone 应用，不签名、不安装到设备…');
run('xcodebuild', ['-workspace', workspace, '-scheme', scheme, '-configuration', 'Release',
  '-destination', 'generic/platform=iOS', '-derivedDataPath', path.join(work, 'DerivedData'),
  'CODE_SIGNING_ALLOWED=NO', 'IPHONEOS_DEPLOYMENT_TARGET=15.1', 'build'], work, path.join(work, 'native-build.log'), 30 * 60 * 1000);
const bundle = path.join(work, 'DerivedData/Build/Products/Release-iphoneos', scheme + '.app');
assert((await stat(path.join(bundle, scheme))).size > 0, '编译未产生应用可执行文件');
const result = { work, workspace, bundle, builtAt: new Date().toISOString(), status: 'compiled-unsigned; not installed or device-tested' };
await writeFile(path.join(work, 'native-build.json'), JSON.stringify(result, null, 2));
await writeFile(path.join(product, 'build/ios-build-latest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
