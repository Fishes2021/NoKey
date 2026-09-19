# NoKey 审核说明

草稿，随正式 Mac 安装包可下载且已公证后使用。请在 App Review 联系栏补齐真实电话、邮箱；无需提供个人账号或个人配对二维码。

## 中文

NoKey 是 iPhone 与 Mac 配合使用的麦克风和快捷面板，不是独立语音识别服务。无需注册 NoKey 账号。请使用一台 Apple Silicon Mac（macOS 13+）及同一局域网内的 iPhone 测试。

Mac 配套客户端下载：https://github.com/Fishes2021/NoKey/releases
请选择包含虚拟麦克风的完整安装包。首次安装需要 macOS 管理员授权和重启，以加载音频驱动。后续客户端更新无需重启。

1. 在 Mac 打开 NoKey，点击“配对手机”，在 iPhone 的 NoKey 中扫描该二维码；回到 Mac 确认新设备。
2. 在 Mac 启用快捷控制，并按系统提示授予 NoKey 辅助功能权限。点击文字编辑应用的空白输入框，在手机输入“Hello from NoKey”并发送，可验证文字输入。
3. 在 Mac 的录音应用中选择“语音快捷键盘麦克风”作为输入源。手机点击讲话后说话，Mac 应收到声音；再次点击停止，手机不再采音。
4. 如需测试听写联动，在 Mac 配置目标输入法/应用的听写快捷键，并在 NoKey Mac 设置中填入相同的单键或组合键。NoKey 不提供转写服务或转写账号。
5. 复制、粘贴、撤销和方向操作投递给 Mac 当前前台应用；发送键的效果取决于该应用快捷键设置。请保持预期输入框获得焦点。
6. 切换 iPhone 到后台或锁屏会停止讲话。Mac 关闭窗口仅隐藏到菜单栏，选择“退出 NoKey”才会退出并恢复原麦克风。

当前不提供默认公共中继，也不要求购买中继服务。局域网功能不需要激活码。高级设置中的自有中继连接不作为上述测试的前置条件。

配对码由审核人员自己的 Mac 现场生成，有时效且需要设备确认；无需联系开发者获取私人设备的验证码。

## English (paste into Review Notes)

NoKey is an iPhone microphone and shortcut companion for Mac. It is not a standalone speech recognition service. No NoKey account is required. Testing requires an Apple Silicon Mac running macOS 13 or later and an iPhone on the same reachable local network.

Mac companion download: https://github.com/Fishes2021/NoKey/releases
Use the full installer, which includes the virtual microphone. Initial driver installation requires administrator authorization and a Mac restart. Client-only updates do not require a restart.

1. Open NoKey on the Mac and choose the phone pairing action. Scan its QR code from NoKey on iPhone, then approve the new device on the Mac.
2. Enable shortcut control on the Mac and grant the requested Accessibility permission. Focus an empty text field in a text editor, enter "Hello from NoKey" on iPhone and send it to verify text input.
3. In a Mac audio recording application, select the input named "语音快捷键盘麦克风". Tap the microphone control in NoKey on iPhone and speak. Audio should reach the Mac. Tap again to stop capture.
4. To test dictation shortcut integration, configure a start/stop dictation key in the chosen Mac input application and set the same key or key combination in NoKey's Mac settings. Speech recognition is performed by that application, not by NoKey. No transcription account is supplied or required by NoKey.
5. Keyboard actions are sent to the current foreground Mac application. Keep the intended text field focused. The send action follows the target application's keyboard behavior.
6. Moving the iPhone app to the background or locking the phone stops capture. Closing the Mac window hides the app in the menu bar; choosing Quit NoKey exits it and restores the previous input device.

No default public relay service is provided. Local-network operation requires no activation code or subscription. Optional self-hosted relay settings are not required for the steps above. Pairing codes are generated on the reviewer's own Mac, are time-limited, and require local confirmation; no personal developer device or private pairing code is needed.

## 附件待补

真实双端操作视频：完整安装/配对、讲话/停止、文字发送。演示视频帮助解释配套设备要求，不替代可运行的 Mac 安装包。当前尚未录制，不在审核备注中声称已附。
