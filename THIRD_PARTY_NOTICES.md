# 第三方来源与许可

NoKey 新增代码、修改及组合作品按 GPL-3.0-only 发布，完整条款见根目录 LICENSE。继承的第三方文件保留原作者、版权及许可证；本声明不会将其独立许可撤销或改写。

| 来源 | 用途 | 许可及保留位置 |
| --- | --- | --- |
| [Kappaemme-git/microdex](https://github.com/Kappaemme-git/microdex) / Francesco Mistero | 手机面板、桥接、配对及原有网页/中继代码的基础 | MIT，原文完整保留于 LICENSES/Microdex-MIT.txt |
| [ExistentialAudio/BlackHole](https://github.com/ExistentialAudio/BlackHole) | 虚拟音频驱动源码 | GPLv3，vendor/BlackHole/LICENSE；固定提交 ffcb74433fbcf8c8ca5c736677c1a4864384dc09 |
| [maxxspotter/codex-micro-app](https://github.com/maxxspotter/codex-micro-app) 与 Marcel Pociot | 上游保留的可选原生协议模拟 | MIT，bridge/native-shim/LICENSE.txt 和 THIRD_PARTY_LICENSE.txt |
| Electron / Chromium | Mac 窗口、WebRTC 接收运行时 | 随依赖附带的 LICENSE / LICENSES.chromium.html，二进制分发必须保留 |
| Expo / React Native / react-native-webrtc | 手机运行时、原生模块与媒体传输 | 依赖包各自许可证，版本锁定于 mobile/package-lock.json |
| coturn / libevent | 自部署及本机中继测试 | 上游许可证随源码/软件包保留；本仓库包含构建和部署脚本，不分发其官方安装器 |

npm 依赖的精确版本、来源和完整性值见各 package-lock.json，安装后可查看包内 LICENSE。二进制发布时还需要收集随包的完整传递依赖及字体许可，本次源码发布不附带这些第三方二进制。

BlackHole 官方二进制及品牌有独立限制。本项目从公开源码编译自己的虚拟设备，不分发官方安装器，不使用其图标作为 NoKey 图标。NoKey 图标源在 desktop/assets/build-icons.swift。

SonoBus 为研究参考，没有作为当前产品运行组件整合。Codex、ChatGPT、OpenAI、Codex Micro、Work Louder 等名称属于各自权利人；项目独立开发，不代表与其存在合作或背书。上游相关代码与图形标识仅保留原技术用途，不授予商标权。
