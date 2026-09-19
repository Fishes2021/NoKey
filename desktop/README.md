# NoKey Mac 开发

Electron 44.4.1 承担菜单栏客户端和 WebRTC 接收，原生 N-API 组件负责虚拟设备输出及系统按键。安装包自带运行时，普通用户不需要 Node、SonoBus 或单独的 BlackHole 安装器。当前构建验证范围为 Apple Silicon。

## 构建

根 README 提供完整开发入口。原生组件命令均在仓库根运行：

- `npm run desktop:driver`：从锁定的 BlackHole 子模块构建自己的虚拟设备，并运行实际驱动 PCM 环回检查，不安装到系统。
- `npm run desktop:output`：构建音频输出绑定，以 AddressSanitizer / UndefinedBehaviorSanitizer 检查缓冲逻辑。默认寻找 Node 相邻 include/node，可通过 `NODE_INCLUDE_DIR` 指定。
- `npm run desktop:keyboard`：构建按键绑定，检查修饰键释放，不向真实应用投递测试按键。
- `npm run desktop:start`：打开开发客户端；会创建本地身份，不自动安装驱动或启用登录项。
- `npm run desktop:package -- --with-driver`：首次完整开发包；需要自己的稳定签名身份，安装时需系统授权并提示重启。
- `npm run desktop:package`：客户端更新包，不更新驱动，不要求重启 Mac。

`VOICEDECK_SIGN_IDENTITY` 可选择签名证书；构建器只有找到唯一 Apple Development 身份时才自动选用。不支持用每次变化的临时签名替代客户端稳定身份。最终路径见 build/desktop/package-latest.json。

## 运行行为

启动时切换到虚拟麦克风，停止讲话不切换音源；窗口关闭只隐藏，音频接收继续，从菜单栏主动退出才结束服务并恢复原麦克风。通用快捷控制需用户开启并授予辅助功能权限。程序不依赖 Codex。

身份、配对及设置保存在 `~/Library/Application Support/VoiceDeck/`，使用受限文件权限。旧技术标识和“语音快捷键盘麦克风”设备名暂保留，应用安装名为 NoKey.app。首次配对需要 Mac 确认，撤销配对后相应身份不再有操作权限。

音频接口仅输出到本产品虚拟设备，不回退到扬声器；设备缺失会报错。缓冲过期会丢弃，停止会清空。听写快捷键按目标输入法配置，向系统投递不等于目标应用已经处理。

## 中继

默认局域网。Mac 的连接服务设置可填写自己的 HTTPS 中继地址，配置保存后按界面提示重开；切换服务可能需要重新配对。Node 服务签发 coturn 短期凭据，通过加密接口交给手机，长期共享密钥只在服务端。

当前没有公共服务，部署见 ../relay/deploy/RUNBOOK.md。不能用单纯配置域名或本机回环成功证明公网已通。

## 有针对性的验证

```sh
npm run desktop:rtc:test
npm run desktop:client:test
npm run desktop:package:test
npm run desktop:install:test
npm run desktop:uninstall:test
```

RTC 检查使用真实 WebRTC 测试音与输出替身，不采集本机麦克风。客户端检查使用独立配置及回环端口。安装/卸载检查使用隔离目录，不替代实际系统安装验收。

强制中继检查：先 `npm run desktop:turn:build`，再 `npm run desktop:turn:test`；TCP 可用 `VOICEDECK_TURN_TRANSPORT=tcp npm run desktop:turn:test`。构建器校验下载源码哈希，需要 pkg-config / OpenSSL，可用 `OPENSSL_PREFIX` 指定。coturn 仅在测试期间监听回环，结束后停止；已有程序可用 `COTURN_BINARY` 指定。本机 UDP / TCP 三轮音频检查已通过，公网 TURN-TLS、运营商跨网和持续弱网仍待验证。

Web 界面集成需先在 mobile 导出 build/mobile-export，再运行 `npm run desktop:mobile:test`，使用按键替身，不能替代真机触屏和系统输入测试。
