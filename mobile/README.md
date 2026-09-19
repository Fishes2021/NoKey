# 语音快捷键盘 iPhone 客户端（开发中）

基于 Microdex 的 Expo 54 / React Native 0.81 面板，保留六个快捷槽；MIC 键已改为手机实时麦克风的一键开始/停止，不再调用 Mac 听写。界面其余部分仍在做产品适配。

实时音频使用 react-native-webrtc 124.0.8 与 Expo 54 对应的 config plugin 13.0.0。必须使用原生开发构建或安装包，Expo Go 不包含此原生模块。App 标识暂定 site.fishcloud.nokey，配对 scheme 为 voicedeck；旧 microdex 配对链接仍可由扫描器解析。上游作者的 Expo 在线更新、项目 ID 和发布者配置已移除。

在本目录执行：

```sh
npm ci
npx tsc --noEmit
npx expo export --platform ios --output-dir ../build/mobile-ios
npx expo prebuild --platform ios --no-install
```

原生工程由 app.json 生成在 ios/，不手动编辑生成物。麦克风权限说明、后台 audio 与配对 scheme 已核对实际生成的 Info.plist。完整 iOS 编译、签名和真机运行还需要 Xcode / CocoaPods 与开发者签名配置；当前只有 JS 打包与工程生成通过，不是可安装 IPA。

lib/voice-sender.mjs 为发送生命周期实现，hooks/use-phone-microphone.ts 连接原生采音和原有 E2EE 请求。等待权限或 offer 时也可停止；迟到的流会被释放，迟到的 answer 会通知 Mac 结束会话。该发送逻辑也被桌面的真实 WebRTC 回归检查调用。

当前加密语音接口包含 config、offer、restart、status、gain、stop，仅使用配对身份。Mac 统一入口已接入处理器，国内 ICE 配置、续期和收音回执已有实现；手机支持输入音量保存及实际接收峰值提示。仍需原生编译、系统虚拟设备、国内公网和真机后台联调，不能把连接状态或浏览器检查当作整机验收。

## 系统音频中断

`modules/voicedeck-audio/` 是随 iPhone App 编译的本地 Expo 模块，不是用户需要另外安装的软件。它复用已有 JitsiWebRTC 124 音频引擎的 `RTCAudioSession.useManualAudio/isAudioEnabled`，在系统中断开始、音频服务失效/重置或当前音频设备断开时，先从原生侧关闭音频并使本次采音标识失效，再向 JavaScript 发出事件。中断结束不会自动重新启用；锁屏或 App 进入后台本身也不会调用停止。

`lib/phone-audio-capture.mjs` 负责权限等待和原生标识的配合，成功取得的流交给 VoiceSender 释放。VoiceSender 在停止、撤销、连接失败和中断路径统一调用原生停止，再清理采音轨道和 Mac 会话。迟到的权限结果、原生事件或停止请求不能复活旧采音或停止新采音。缺少原生模块的旧安装包会明确报错，不降级为没有中断保护的采音。

原生接口依据：[Jitsi WebRTC M124 RTCAudioSession](https://github.com/jitsi/webrtc/blob/M124/sdk/objc/components/audio/RTCAudioSession.h)、[Apple 音频中断文档](https://developer.apple.com/documentation/avfaudio/handling-audio-interruptions)、[Expo 本地模块](https://docs.expo.dev/modules/get-started/)。源码没有复制进 node_modules，Expo autolinking 从 modules/ 注册，重新生成 iOS 工程后需安装 Pods 并重新编译 App。

开发检查：在产品根运行 `node --test bridge/test/phone-audio-capture.test.mjs bridge/test/voice-sender.test.mjs`，原生系统绑定以替身注入，其余为生产采音代码；覆盖权限等待中中断、事件延迟、停止顺序和不自动恢复。`npm run desktop:rtc:test` 补充真实 WebRTC 中断后的轨道释放与 Mac 停止。Expo 模块发现/注册生成及 Swift/Ruby 语法检查已通过，但目前没有完整 Xcode，**Swift 语法解析不等于 iOS 类型检查、链接或真机中断通过**。真实来电、锁屏持续讲话、音频服务重置和蓝牙断开仍是原生构建后的验收项。


## 统一快捷面板（开发中）

设置 → Customize keys → 选择一个槽 → Mac 通用快捷键，可配置组合键与显示名称；同一面板的麦克风仍走独立实时音频通道。配置按配对身份保存，支持恢复默认。Mac 客户端须先启用通用快捷键并由用户完成辅助功能授权。手机显示当前前台应用，过期或断线时不补发；系统投递回执不代表目标应用已完成操作。

手机界面及加密集成检查使用 `desktop:mobile:test`，构建和局限见 `../desktop/README.md`。iOS JS 导出不是原生 App 编译或真机验收。


## iOS 原生工程准备

在产品根目录运行 `npm run mobile:ios:prepare`。脚本使用已安装 Expo SDK 54 的本地模板，在 `build/ios-*/` 独立目录生成 iOS 工程和本次手机源码副本；复用本机 node_modules，不下载模板、不安装 CocoaPods、不申请签名、不覆盖 mobile/ios。最新位置见产品 `build/ios-latest.json`。

生成后自动检查产品标识、中文名称、麦克风和本地网络用途、后台 audio、URL scheme、ATS 无全局放开及本地 VoiceDeckAudioModule 自动链接。SecureStore 不启用生物识别，不声明未使用的 Face ID 权限。prebuild.log 与 autolinking.json 留在产物目录。

这是待编译工程，不能安装到 iPhone。开发机仍需完整 Xcode、对应 iOS SDK 和 CocoaPods；在生成工程的 ios 目录完成 Pods 安装后打开生成的 xcworkspace，再配置开发团队和真机签名。node_modules 链接指向当前工作区，移动产物到其他机器时需重新从源码安装锁定依赖并生成。不要把工程生成成功等同于 Swift 类型检查、链接或后台音频真机验收。

本次配置核对依据：[Expo SDK 54 文档](https://docs.expo.dev/versions/v54.0.0/) 及项目已安装的 Expo CLI/配置插件源码。


## 首次配对与 Codex 同意范围

首次配对页使用中文三步流程：安装 Mac 配套客户端、扫描客户端二维码并在 Mac 确认、选择虚拟麦克风后开始讲话。离线页和设置页不再提供上游 npx 安装命令或要求用户另装 Node/自动后台桥接。

配对、恢复连接、手机麦克风和通用快捷键独立于 Codex 数据处理同意。该同意只门控 Codex 操作及任务实时订阅；撤销时不删除配对或断开纯音频连接。说明页区分手机音频到 Mac 虚拟麦克风与主动提交 Codex 的内容，不能声称手机不采音。

`desktop:mobile:test` 默认检查最新 `build/mobile-export`，覆盖未保存 Codex 同意时的真实加密连接和通用按键、Codex 操作仍弹同意框、清理配对及中文首次页面。浏览器不支持原生扫码，点击会显示 iPhone 安装版提示，不误弹 Codex 同意。


启动时配对信息无法读取或加密材料损坏，会显示重试与重新配对入口，原记录保留。完整读取和校验前不发布部分凭据、不发起连接；损坏材料不再被自动删除后降级使用旧令牌。界面回归覆盖读取故障、恢复后重试成功、损坏数据保留和重新配对入口；iPhone Keychain 实机行为仍需原生构建验证。


无法扫码时，可在首次连接页或已连接后的设置页展开“手动输入配对信息”，输入 Mac 提供的完整限时文本。此入口要求一次性 code 与加密材料，复用二维码的认领和 Mac 确认；无效输入不联网，成功后清空输入。它是二维码内容的文本入口，不是另行实现的短数字配对码。

会话失效时，仅 GET 查询自动更新会话并重试一次。所有 POST 操作（包括发送、批准、分叉、按键和语音信令）均不自动重发，因为错误可能发生在 Mac 已执行但尚未返回回执时。界面提示结果未确认，由用户检查目标状态后决定下一次操作。回归命令：`node --test mobile/test/bridge-retry.test.mjs`（从产品根目录运行，Node 22.15+）。

审批按钮与快捷槽中的批准/拒绝均携带页面快照的 `approval: {requestId, threadId}`。Mac 在实际回应前核对该请求仍存在且属于当前选中任务；旧客户端省略身份时返回 409，不回退批准其他任务。回归：`node --experimental-test-module-mocks --test bridge/repro/approval-identity.test.mjs bridge/repro/programmed-actions.behavior.test.mjs`。


## 原生编译入口

产品根目录执行 `npm run mobile:ios:build -- --check-tools` 只读检查完整 Xcode、iPhoneOS SDK 和 CocoaPods。缺少工具返回非零退出码，不生成新工程、不安装工具、不接受 Apple 许可或更改 xcode-select。

工具准备好后执行 `npm run mobile:ios:build`：从当前源码重新生成独立工程，执行 `pod install`，再以 Release、generic iOS、`CODE_SIGNING_ALLOWED=NO` 编译。Pods可能下载原生依赖，不启动模拟器或安装App。日志放在本次 `build/ios-*/pods-install.log` 和 `native-build.log`，失败保留日志，不写成功指针；只有编译退出成功且应用可执行文件存在，才写 `native-build.json` 与 `build/ios-build-latest.json`。

产物是未签名的iPhone `.app`，不能直接安装到手机，也不是App Store归档；签名、IPA导出和真机验证仍需后续完成。当前机器缺完整Xcode/SDK/CocoaPods，仅检查了预检分支，不能据此声称Pods解析或Swift编译通过。预检回归：`node --test mobile/test/ios-build-tools.test.mjs`，使用临时工具替身，不会安装任何工具。

编译流程采用 [Apple xcodebuild 的工作区与scheme构建方式](https://developer.apple.com/library/archive/technotes/tn2339/_index.html)；原生依赖使用 [CocoaPods 的 pod install 流程](https://guides.cocoapods.org/using/pod-install-vs-update.html)，不主动执行pod update。

手机快速停止后重新开始时，旧停止回执只能更新其自身会话代次，不能覆盖新会话状态。`node --test mobile/test/microphone-stop-race.test.mjs` 在实际hook代码上模拟回执成功/失败及重新开始组合；它不进行原生采音，也不替代iPhone真机测试。

收音状态与超时：手机通过 Mac 返回的最近音频到达状态和新增帧数确认收音；连续 10 秒无法确认新音频即停止采音。正常的静音音频帧仍会保持会话。配套 Mac 版本必须提供 `receiving` 状态字段；旧开发包会显示待确认并超时停止，请同步更新两端。本地模拟与 WebRTC 检查不代替 iPhone 真机后台/锁屏验收。


## App Store 符号检查与上传

上传必须使用 `sh scripts/upload-store.sh 归档.xcarchive UploadOptions.plist 输出目录`。入口检查应用及嵌入框架的二进制 UUID 与 dSYM 对应，并要求 `uploadSymbols=true`；缺失即停止，不带警告继续上传。

React Native 0.81.5 的三个预编译框架符号独立发布在 [官方 Maven 制品目录](https://repo.maven.apache.org/maven2/com/facebook/react/react-native-artifacts/0.81.5/)：`reactnative-core-dSYM-release`、`reactnative-dependencies-dSYM-release`、`hermes-framework-dSYM-release`（完整文件名均带 `react-native-artifacts-0.81.5-` 前缀及 `.tar.gz` 后缀）。下载后核对同目录 `.sha256`；只解压前两者 `ios-arm64` 和 Hermes `iphoneos`。执行 `python3 scripts/prepare-store-symbols.py 归档.xcarchive --source 解压目录`，仅复制 UUID 匹配的符号，不用不同版本符号顶替、不从已剥离的二进制伪造空符号。升级 RN 后需要重新取得该版本匹配制品。

符号放在归档的 `dSYMs` 中，不打入手机应用。保留每次发布归档，方便还原对应版本崩溃。
