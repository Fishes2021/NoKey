# NoKey

把 iPhone 变成 Mac 的实时麦克风和通用快捷面板。手机一个 App，Mac 一个配套客户端；目标应用通过虚拟麦克风接收声音，继续使用自己的输入法或听写。NoKey 不负责语音识别，也不要求安装 Codex。

**当前开放开发源码，尚无正式安装包或 TestFlight 邀请。** 局域网版本已在开发设备使用；国内中继已有实现和本机 TURN 测试，尚未部署公网，真实跨网与长时间语音仍待验收。开源源码不代表正式版已经发布。

## 功能

- 实时手机麦克风，传入 Mac 虚拟音频设备；可联动已配置的听写快捷键。
- 向 Mac 当前输入框发送文字、执行通用组合键。
- 连续光标旋钮、六个快捷键和四向可自定义摇杆。
- Mac 菜单栏常驻面板，关闭窗口隐藏，主动退出结束服务并恢复音频设置。
- 配对确认、加密控制请求；可自部署信令及 TURN 中继，无默认公共服务器。

支持目标是 iPhone → Mac，目前验证的 Mac 构建为 Apple Silicon。Windows、Intel Mac 和公开多人服务尚未验收。

## 从源码构建

需要 macOS、Node 22.22 或更新的 22.x、npm、完整 Xcode；iPhone 构建还需要 CocoaPods。普通 Expo Go 无法运行本项目的原生音频模块。

```sh
git clone --recurse-submodules https://github.com/Fishes2021/NoKey.git
cd NoKey
npm ci
npm --prefix mobile ci
```

Mac 原生组件与开发客户端：

```sh
npm run desktop:output
npm run desktop:keyboard
npm run desktop:start
```

未安装虚拟驱动时会显示设备未就绪。构建开发安装包需要自己的稳定 Apple Development 签名证书；多个证书时用 `VOICEDECK_SIGN_IDENTITY` 指定：

```sh
# 首次安装：含虚拟麦克风驱动，安装器提示系统授权及重启
npm run desktop:package -- --with-driver
# 后续客户端更新：不更新驱动，不要求重启 Mac
npm run desktop:package
npm run desktop:package:test
```

输出路径见 `build/desktop/package-latest.json`。这些命令只构建及检查，不自动安装。开发包不是 Developer ID 签名、公证后的正式分发包。

iPhone 工程及未签名构建：

```sh
npm run mobile:ios:build -- --check-tools
npm run mobile:ios:build
```

结果见 `build/ios-build-latest.json`。安装真机或上传 TestFlight 需要配置自己的开发团队、应用标识及分发签名。不要复用其他人的 App Store 记录。仅生成工程可运行 `npm run mobile:ios:prepare`。

## 使用

1. 打开 Mac 客户端，在 iPhone 扫描限时二维码或输入完整配对文本，并在 Mac 确认。
2. 在 Mac 启用通用快捷键并按系统提示授予辅助功能权限。
3. 在目标输入法或应用选择“语音快捷键盘麦克风”。这是目前保留的设备名称；内部 `VoiceDeck` 标识用于兼容已有配置。
4. 按手机麦克风条开始/停止；听写联动需与自己的输入法快捷键一致。文字及快捷操作发往当前前台目标。
5. 长按快捷键或摇杆方向可配置。不要向不信任的设备提供配对二维码。

## 国内中继

服务器运行 Node 加密信令转发、coturn 媒体中继及 HTTPS 反向代理，不运行语音识别。部署准备工具生成独立配置和随机密钥，不自动启动服务。

见 [中继说明](relay/README.md)和[部署手册](relay/deploy/RUNBOOK.md)。目前没有公共中继地址；部署后还需检验蜂窝到 Mac、持续讲话、切网和 TURN-TLS。小范围登记与限流已实现，自助账号、收费、配额及运营监控未实现。

## 目录和检查

| 目录 | 内容 |
| --- | --- |
| mobile | Expo / React Native 手机端与原生采音模块 |
| desktop | Mac 客户端、音频和快捷键组件、安装器 |
| bridge | 配对、加密会话和控制接口；保留上游可选 Codex 代码 |
| relay | 国内自部署信令和 TURN 凭据服务 |
| vendor/BlackHole | 锁定提交的第三方驱动源码子模块 |
| web | 上游网页控制端，非当前 NoKey 手机端 |

```sh
npm run relay:test
node --test bridge/test/voice-sender.test.mjs bridge/test/ice-provider.test.mjs
node --test mobile/test/programmed-keys.test.mjs mobile/test/deck-interaction.test.mjs
```

这些测试不能代替真机长时间使用。更完整的原生检查见 [Mac 开发说明](desktop/README.md)；部分上游测试面向 Codex，不能作为当前通用面板的验收依据。

## 开源与致谢

基于 [Microdex](https://github.com/Kappaemme-git/microdex) 改造，保留其 MIT 版权及许可。虚拟麦克风使用 [BlackHole](https://github.com/ExistentialAudio/BlackHole) 的 GPLv3 源码，媒体使用 WebRTC；SonoBus 仅作为架构研究参考。

NoKey 新增代码及本仓库组合作品按 **GPL-3.0-only** 提供；上游文件继续适用各自许可。参见 [LICENSE](LICENSE)、[第三方声明](THIRD_PARTY_NOTICES.md)。开源许可允许商业使用；再分发仍须遵守源码和版权等相应义务。

[使用帮助](SUPPORT.md) · [隐私说明](PRIVACY.md) · [贡献说明](CONTRIBUTING.md) · [发布状态](docs/APP_STORE_RELEASE.md)
