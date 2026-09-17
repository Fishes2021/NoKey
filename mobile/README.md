# NoKey iPhone 开发

Expo SDK 54 / React Native 0.81，使用 react-native-webrtc 与本地 Expo 音频模块。不能使用普通 Expo Go。根 README 提供依赖安装和原生构建命令。

六个快捷槽与四向摇杆可配置通用组合键，旋钮连续移动光标；单个麦克风条控制采音并联动配置的 Mac 听写快捷键。组合键发送给 Mac 当前前台应用，系统投递回执不代表目标应用已经执行。

`modules/voicedeck-audio` 随 App 编译，负责系统音频中断。`lib/phone-audio-capture.mjs` 管理权限和原生采音标识，`lib/voice-sender.mjs` 管理 WebRTC、停止、续期与恢复。停止或中断后迟到的回调不能复活旧采音。

在本目录运行 `npx tsc --noEmit` 检查类型。根目录运行 `npm run mobile:ios:prepare` 在 build/ios-* 生成独立工程；`npm run mobile:ios:build` 安装 Pods 并构建未签名 App。完整 Xcode / CocoaPods 必需，真机签名需自行配置团队及标识。生成工程链接本机依赖，不能当独立安装包复制使用。

Web 界面检查：`npx expo export --platform web --output-dir ../build/mobile-export`，然后在根目录运行 `npm run desktop:mobile:test`。这不覆盖 iPhone 原生采音、来电、锁屏或蓝牙中断。当前原生开发版已在设备使用，长时间和异网验收未完成。

上游技术标识 `VoiceDeck`、`microdex` 部分保留以兼容已有配对及配置，不表示需要安装额外软件或使用 Codex。
