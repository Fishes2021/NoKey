// SPDX-License-Identifier: GPL-3.0-only
// Build only. Never installs, notarizes, publishes or restarts audio services.
import { cp, mkdir, mkdtemp, readFile, writeFile, rename, readdir, rm, open } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert(args.every(arg => ['--with-driver', '--release'].includes(arg)) && new Set(args).size === args.length, '仅支持 --with-driver 和 --release');
const release = args.includes('--release');
const withDriver = args.includes('--with-driver');
assert.equal(process.platform, 'darwin');
const name = 'NoKey', version = '0.1.0', identifier = 'org.voicedeck.desktop';
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
}
const identityList = run('security', ['find-identity', '-v']);
const certificateType = release ? 'Developer ID Application' : 'Apple Development';
const identities = [...identityList.matchAll(new RegExp(`([A-F0-9]{40}) "${certificateType}:[^"]+"`, 'g'))].map(match => match[1]);
const signingIdentity = process.env.VOICEDECK_SIGN_IDENTITY || (identities.length === 1 ? identities[0] : null);
assert(identities.includes(signingIdentity), `需要有效的 ${certificateType} 身份；多个身份时设置 VOICEDECK_SIGN_IDENTITY`);
const installerIdentities = [...identityList.matchAll(/([A-F0-9]{40}) "Developer ID Installer:[^"]+"/g)].map(match => match[1]);
const installerIdentity = process.env.VOICEDECK_INSTALLER_IDENTITY || (installerIdentities.length === 1 ? installerIdentities[0] : null);
if (release) assert(installerIdentities.includes(installerIdentity), '需要有效的 Developer ID Installer 身份');
const installerSigning = release ? ['--sign', installerIdentity, '--timestamp'] : [];
for (const script of [...(withDriver ? ['build-driver.mjs'] : []), 'build-output.mjs', 'build-keyboard.mjs']) console.log(run(process.execPath, ['desktop/' + script]));
const work = await mkdtemp(path.join(root, 'build/package-'));
const payload = path.join(work, 'payload');
const bundle = path.join(payload, 'Applications', name + '.app');
const resources = path.join(bundle, 'Contents/Resources');
const application = path.join(resources, 'app');
const copy = async (from, to) => {
  await mkdir(path.dirname(to), { recursive: true });
  await cp(from, to, { recursive: true, verbatimSymlinks: true });
};
await copy(path.join(root, 'node_modules/electron/dist/Electron.app'), bundle);
await rm(path.join(resources, 'default_app.asar'));
await mkdir(application);
const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await writeFile(path.join(application, 'package.json'), JSON.stringify({
  name: 'voicedeck', productName: 'NoKey', version, private: true, type: 'module', main: 'desktop/launch.mjs',
  license: 'GPL-3.0-only', dependencies: manifest.dependencies,
}, null, 2));
for (const relative of ['bridge/lib', 'bridge/server.mjs', 'bridge/hooks',
  'desktop/assets/trayTemplate.png', 'desktop/assets/trayTemplate@2x.png', 'desktop/main.mjs', 'desktop/dictation-settings.mjs', 'desktop/subscription-client.mjs', 'desktop/microphone-selection.mjs', 'desktop/login-item.mjs', 'desktop/launch.mjs', 'desktop/voice-host.mjs', 'desktop/ice-provider.mjs',
  'mobile/lib/keyboard-shortcuts.mjs', 'mobile/lib/ice-config.mjs',
  'build/desktop/keyboard.node', 'build/desktop/voice-output.node']) {
  await copy(path.join(root, relative), path.join(application, relative));
}
for (const file of ['engine.html', 'engine.js', 'engine.css', 'receiver.js', 'pcm-worklet.js', 'preload.cjs'])
  await copy(path.join(root, 'desktop/rtc', file), path.join(application, 'desktop/rtc', file));
const runtimeNotices = [];
for (const dependency of Object.keys(manifest.dependencies)) {
  const source = path.join(root, 'node_modules', dependency);
  const pkg = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
  // ponytail: current production dependencies have no required transitive deps;
  // fail on a new dependency tree instead of silently producing an incomplete app.
  assert.equal(Object.keys(pkg.dependencies || {}).length, 0, `${dependency}: add required transitive packages to packaging`);
  await copy(source, path.join(application, 'node_modules', dependency));
  const licenseFile = dependency.replaceAll('/', '-') + '-LICENSE.txt';
  const declaredLicense = pkg.license || pkg.licenses?.map(entry => entry.type).join(', ');
  assert(typeof declaredLicense === 'string' && declaredLicense.length > 0, `${dependency}: license declaration missing`);
  await copy(path.join(source, 'LICENSE'), path.join(resources, 'Licenses', licenseFile));
  runtimeNotices.push({ name: pkg.name, version: pkg.version, declaredLicense, licenseFile });
}
await mkdir(path.join(application, 'bridge/native'));
const companion = path.join(application, 'bridge/native', name + '操作助手');
run('xcrun', ['swiftc', '-O', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`,
  '-framework', 'AppKit', '-framework', 'ApplicationServices', '-framework', 'Carbon',
  'bridge/native/MicrodexDesktop.swift', '-o', companion]);
for (const [source, target] of [['LICENSE', 'NoKey-GPL-3.0.txt'], ['LICENSES/Microdex-MIT.txt', 'Microdex-LICENSE.txt'], ['THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_NOTICES.md'], ['vendor/BlackHole/LICENSE', 'GPL-3.0.txt'],
  ['node_modules/electron/dist/LICENSE', 'Electron-LICENSE.txt'],
  ['node_modules/electron/dist/LICENSES.chromium.html', 'Chromium-LICENSES.html']])
  await copy(path.join(root, source), path.join(resources, 'Licenses', target));

// qrcode-terminal embeds a separately attributed MIT QRCode implementation.
const qrNotice = (await readFile(path.join(root, 'node_modules/qrcode-terminal/vendor/QRCode/index.js'), 'utf8')).split('var QR8bitByte')[0];
assert(qrNotice.includes('Kazuhiko Arase') && qrNotice.includes('MIT license'));
await writeFile(path.join(resources, 'Licenses/QRCode-NOTICE.txt'), qrNotice);
await writeFile(path.join(resources, 'Licenses/runtime-dependencies.json'), JSON.stringify(runtimeNotices, null, 2));
await writeFile(path.join(resources, 'Licenses/说明.txt'), `语音快捷键盘开发包开源声明
Microdex-LICENSE.txt：上游 Microdex 代码的 MIT 声明。
GPL-3.0.txt：BlackHole 及本产品驱动集成所用 GPL-3.0 文本。
Electron-LICENSE.txt、Chromium-LICENSES.html：桌面运行时及其组成部分声明。
runtime-dependencies.json：本包 Node 运行依赖的实际版本、声明及对应原文文件。
QRCode-NOTICE.txt：qrcode-terminal 内嵌 QRCode 实现的独立作者和 MIT 声明。
这些文件只说明本开发包随附的上述组件，不代表手机依赖、全部素材或公开分发审查已经完成。
`);

function setPlist(file, key, value) {
  run('plutil', ['-replace', key, '-string', value, file]);
}
const info = path.join(bundle, 'Contents/Info.plist');
for (const key of ['CFBundleName', 'CFBundleDisplayName']) setPlist(info, key, name);
setPlist(info, 'CFBundleExecutable', '语音快捷键盘');
setPlist(info, 'CFBundleName', 'NoKey');
setPlist(info, 'CFBundleDisplayName', 'NoKey');
setPlist(info, 'CFBundleIconFile', 'NoKey.icns');
await copy(path.join(root, 'desktop/assets/NoKey.icns'), path.join(resources, 'NoKey.icns'));
for (const locale of ['zh_CN', 'en']) {
  const directory = path.join(resources, locale + '.lproj');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'InfoPlist.strings'), '"CFBundleName" = "NoKey"; "CFBundleDisplayName" = "NoKey";\n');
}
setPlist(info, 'CFBundleIdentifier', identifier);
setPlist(info, 'CFBundleShortVersionString', version);
setPlist(info, 'CFBundleVersion', '1');
setPlist(info, 'LSApplicationCategoryType', 'public.app-category.utilities');
run('/usr/libexec/PlistBuddy', ['-c', 'Delete :ElectronAsarIntegrity', info]);
for (const key of ['NSAudioCaptureUsageDescription', 'NSMicrophoneUsageDescription', 'NSCameraUsageDescription',
  'NSBluetoothAlwaysUsageDescription', 'NSBluetoothPeripheralUsageDescription'])
  run('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, info]);
run('/usr/libexec/PlistBuddy', ['-c', 'Add :NSLocalNetworkUsageDescription string 用于与已配对手机连接并接收实时语音和快捷操作。', info]);
await rename(path.join(bundle, 'Contents/MacOS/Electron'), path.join(bundle, 'Contents/MacOS', '语音快捷键盘'));
const frameworks = path.join(bundle, 'Contents/Frameworks');
for (const entry of await readdir(frameworks)) {
  if (!entry.startsWith('Electron Helper') || !entry.endsWith('.app')) continue;
  const oldName = entry.slice(0, -4), helperName = oldName.replace('Electron', 'NoKey');
  const helper = path.join(frameworks, entry), plist = path.join(helper, 'Contents/Info.plist');
  for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) setPlist(plist, key, helperName);
  const helperId = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist]).replace('com.github.Electron', identifier);
  setPlist(plist, 'CFBundleIdentifier', helperId);
  await rename(path.join(helper, 'Contents/MacOS', oldName), path.join(helper, 'Contents/MacOS', helperName));
  await rename(helper, path.join(frameworks, helperName + '.app'));
}
// Bundle a system-authorized uninstall workflow inside the one visible app.
const uninstallScripts = path.join(work, 'uninstall-scripts');
await mkdir(uninstallScripts);
await copy(path.join(root, 'desktop/installer/validate'), path.join(uninstallScripts, 'preinstall'));
await copy(path.join(root, 'desktop/uninstaller/postinstall'), path.join(uninstallScripts, 'postinstall'));
run('pkgbuild', ['--nopayload', '--scripts', uninstallScripts, '--identifier', identifier + '.uninstaller',
  '--version', version, '--install-location', '/', path.join(work, 'uninstall-component.pkg')]);
const uninstallResources = path.join(work, 'uninstall-resources');
await mkdir(uninstallResources);
await writeFile(path.join(uninstallResources, 'welcome.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<h1>卸载 NoKey</h1><p>此向导会移除语音快捷键盘客户端及 VoiceDeckMicrophone 虚拟麦克风。</p>
<p>不会移除单独安装的 BlackHole、Codex、UU 或其他音频设备。个人配对配置保留，重新安装后可继续使用。</p>
<p>如系统或录音应用使用本产品麦克风，请先改选可用输入设备。请退出语音快捷键盘，保存工作；卸载完成后需重启 Mac。</p>
<p>系统可能把最后一步显示为“安装”：此包只执行卸载，不安装另一个客户端。继续即授权移除上述两个组件。</p></body></html>`);
const uninstallDistribution = path.join(work, 'Uninstall.xml');
await writeFile(uninstallDistribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2"><title>卸载 NoKey${release ? '' : '（开发版）'}</title>
<options customize="never" require-scripts="true"/><domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
<welcome file="welcome.html" mime-type="text/html"/><choices-outline><line choice="uninstall"/></choices-outline>
<choice id="uninstall" visible="false"><pkg-ref id="${identifier}.uninstaller"/></choice>
<pkg-ref id="${identifier}.uninstaller" version="${version}" onConclusion="RequireRestart">uninstall-component.pkg</pkg-ref>
</installer-gui-script>`);
run('productbuild', [...installerSigning, '--distribution', uninstallDistribution, '--resources', uninstallResources, '--package-path', work,
  path.join(resources, 'VoiceDeck-Uninstall.pkg')]);
// Developer ID signing must proceed inside out, including native Node modules.
const entitlements = path.join(work, 'electron-entitlements.plist');
if (release) await writeFile(entitlements, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>');
const machOMagic = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca']);
async function signDistribution(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await signDistribution(file);
    else if (entry.isFile()) {
      const handle = await open(file, 'r'), magic = Buffer.alloc(4);
      try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
      if (machOMagic.has(magic.toString('hex')))
        run('codesign', ['--force', '--timestamp', '--options', 'runtime', '--sign', signingIdentity, file]);
    }
  }
  if (/\.(app|framework|bundle|xpc|driver)$/.test(directory)) {
    const jit = directory.endsWith('.app') ? ['--entitlements', entitlements] : [];
    run('codesign', ['--force', '--timestamp', '--options', 'runtime', ...jit, '--sign', signingIdentity, directory]);
  }
}
console.log(`Signing ${release ? 'Developer ID distribution' : 'development'} bundle…`);
if (release) await signDistribution(bundle);
else run('codesign', ['--force', '--deep', '--sign', signingIdentity, bundle]);
run('codesign', ['--verify', '--deep', '--strict', bundle]);
const driverRelative = 'Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver';
if (withDriver) {
  await copy(path.join(root, 'build/desktop/VoiceDeckMicrophone.driver'), path.join(payload, driverRelative));
  if (release) await signDistribution(path.join(payload, driverRelative));
}
const components = path.join(work, 'components.plist');
run('pkgbuild', ['--analyze', '--root', payload, components]);
const analyzed = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', components]));
function configure(entries) {
  for (const entry of entries) {
    entry.BundleIsRelocatable = false; entry.BundleIsVersionChecked = true;
    entry.BundleHasStrictIdentifier = true; entry.BundleOverwriteAction = 'upgrade';
    if (entry.ChildBundles) configure(entry.ChildBundles);
  }
}
configure(analyzed);
await writeFile(components, JSON.stringify(analyzed));
run('plutil', ['-convert', 'xml1', components]);
run('pkgbuild', ['--root', payload, '--component-plist', components, '--scripts', path.join(root, 'desktop/installer'), '--ownership', 'recommended',
  '--identifier', identifier + '.installer', '--version', version, '--install-location', '/', path.join(work, 'payload.pkg')]);
const distribution = path.join(work, 'Distribution.xml');
await writeFile(distribution, `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>NoKey ${version}（${withDriver ? '完整安装' : '客户端更新'}）</title>
  <options customize="never" require-scripts="true" hostArchitectures="${process.arch === 'arm64' ? 'arm64' : 'x86_64'}"/>
  <domains enable_anywhere="false" enable_currentUserHome="false" enable_localSystem="true"/>
  <volume-check><allowed-os-versions><os-version min="13.0"/></allowed-os-versions></volume-check>
  <welcome file="welcome.html" mime-type="text/html"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" visible="false"><pkg-ref id="${identifier}.installer"/></choice>
  <pkg-ref id="${identifier}.installer" version="${version}" onConclusion="${withDriver ? 'RequireRestart' : 'None'}">payload.pkg</pkg-ref>
</installer-gui-script>`);
const installerResources = path.join(work, 'installer-resources');
await mkdir(installerResources);
await writeFile(path.join(installerResources, 'welcome.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<h1>NoKey</h1><p>安装一个 Mac 客户端和配套虚拟麦克风，接收已配对 iPhone 的语音与快捷操作。</p>
<p>安装位置：/Applications/NoKey.app 和 /Library/Audio/Plug-Ins/HAL/VoiceDeckMicrophone.driver。</p>
<p>完成后需重新启动 Mac，让系统加载虚拟麦克风。请先保存正在进行的工作。安装器不会建立登录项或更改默认麦克风。</p>
<p>${release ? 'NoKey 使用 Developer ID 签名。请从项目官方发布页下载，查看版本和校验信息。' : '这是尚未完成 Developer ID 签名、公证与真机验收的开发包，不是公开发布版。'}</p></body></html>`);
if (!withDriver) await writeFile(path.join(installerResources, 'welcome.html'), `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body>
<h1>NoKey客户端更新</h1><p>仅更新 /Applications/NoKey.app，保留配对和现有虚拟麦克风。</p>
<p>退出客户端后安装，完成后重新打开即可，无需重启 Mac。本包不包含驱动，首次安装请使用完整安装包。</p>
<p>不建立登录项，不更改默认音源。${release ? '使用 Developer ID 分发签名。' : '这是本地签名开发包。'}</p></body></html>`);
const pkg = path.join(work, `${release ? 'NoKey' : 'VoiceDeck'}-${version}-${process.arch}-${withDriver ? 'full' : 'client-update'}${release ? '' : '-dev'}.pkg`);
run('productbuild', [...installerSigning, '--distribution', distribution, '--resources', installerResources, '--package-path', work, pkg]);
await writeFile(path.join(root, 'build/desktop/package-latest.json'), JSON.stringify({ work, bundle, pkg, withDriver, release, signingIdentity, installerIdentity: release ? installerIdentity : null, arch: process.arch, version }, null, 2));
console.log(JSON.stringify({ bundle, pkg, status: release ? 'Developer ID signed; not yet notarized or installed' : 'development-only; not installed, Developer ID signed or notarized' }));
