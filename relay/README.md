# 国内自部署中继（开发版）

`src/node-server.mjs` 使用 Node HTTP 和已安装的 ws，实现与产品 Mac 连接器兼容的加密信令转发。它可在国内服务器运行，不需要 Cloudflare。`src/index.js` 保留上游 Cloudflare 实现及复用的路由/配对页函数；两者不是同时部署的必要组件。

当前入口 `npm run relay:start`。通过 `VOICEDECK_RELAY_CONFIG` 指向服务器上的 JSON 配置文件；运行命令只用于明确启动前台服务，Ctrl-C 停止，不会创建开机自启。服务器需要 Node 22 和产品依赖（可用 `npm ci --omit=dev` 安装，不需要 Electron）。

配置字段：

- `publicOrigin`：用户访问的国内 HTTPS origin，例如 `https://relay.example.cn`，不含路径。
- `host` / `port`：默认 `127.0.0.1:8787`。部署时由同机 HTTPS 反向代理转入，代理须支持 WebSocket Upgrade；不要把回环 HTTP 端口直接当公网安全连接。
- `devices`：设备 ID 到 SHA-256(secret) 十六进制摘要的对象。小范围开发试用由运营方登记；最多100台。这是当前试用方式，公开发布前仍需做用户自助登记/额度管理。
- `turn`：`{secret, urls, ttlSeconds?}`。secret 为服务端与 coturn 共享的随机密钥，至少32字节，不能交给客户端；urls 为国内 coturn 的 `turn:` / `turns:` 地址列表，默认凭据有效期3600秒。

Mac 首次创建的设备身份位于其状态目录 `relay-device.json`。登记时只提交 deviceId 与 deviceSecret 的 SHA-256 摘要；服务器不需要获得 Mac 原始 secret。配置文件只读载入，移除/变更已登记设备后重新启动服务使之生效。客户端撤销手机配对仍由 Mac 自己处理。

服务路由：

| 路由 | 用途 |
| --- | --- |
| GET `/health` | 无敏感信息的就绪探测 |
| WS `/v1/devices/{id}/connect` | Mac 以设备 secret 认证并保持连接 |
| WS `/v1/devices/{id}/events` | 手机向 Mac 提交加密认证，接收定向加密事件 |
| POST `/v1/devices/{id}/api/e2ee[/pair\|/session]` | 不解密的客户端请求/回复转发 |
| POST `/v1/devices/{id}/ice` | 设备认证后签发 coturn 临时凭据 |
| GET `/v1/devices/{id}/pair?code=…` | 跳转手机 App；加密密钥保留在 URL fragment |

仅接受加密手机接口，不提供上游明文控制兼容。Mac 密钥摘要与TURN签发密钥均留在服务器配置，手机认证/媒体内容密钥留在端点。TURN负责传输WebRTC密文，不做ASR。

内置限制：单设备每分钟1800次请求、每来源地址6000次、单设备32/全局128个待答请求、16个手机连接、HTTP正文64KiB、WebSocket消息400KB、写缓冲1MB、Mac WebSocket每分钟3600条、手机认证消息每分钟60条，手机认证10秒/请求答复15秒超时（配对等待55秒）。反向代理后的所有流量默认共享一个来源预算；不盲目信任可伪造的X-Forwarded-For。公开扩量前需在可信代理层补充真实来源限流。

`startRelay()` 返回只读 `stats()` 聚合计数（请求、转发字节、拒绝、签发、待答、在线Mac），没有暴露公开指标端点。真实费用监测、预算告警、coturn allocation/带宽配额与运营界面尚需接入，不能把代码限流等同于成本控制已完成。

测试：`npm run relay:test`。新增用例启动回环 HTTP/WebSocket 服务，验证加密转发、Mac身份拒绝、事件定向、断线清理、真实Mac连接器互通，以及Mac获取TURN凭据后通过加密接口返回手机。测试环境把假定HTTPS origin映射到回环传输，没有改变生产TLS验证。上游Cloudflare源码用例仍保留，不能拿它们证明Node服务的reset/过期清理；Node版本尚未实现房间reset接口。

本机coturn真实Allocation与强制relay媒体音频已通过三轮测试，命令见 desktop/README.md。尚未验证/交付：公网HTTPS/TURN-TLS部署、真实长时间语音、运营商跨网、服务自助登记、正式运维与预算告警。部署、开通付费资源或后台常驻需对具体目标另行授权；本次开发测试没有进行这些操作。

国内单机部署的 Node JSON、Nginx 和 coturn 配置模板及逐项填写说明见 [deploy/README.md](deploy/README.md)。模板不包含真实凭据，不自动安装/启动服务；Nginx/TLS和公网仍待在实际部署目标验证。


## 当前发布门槛（2026-09-17 更新）

用户已将国内异网中继恢复为发布前必做项。服务器、域名尚未购买，不能把本地测试写成真实跨网可用。

部署工具：`node relay/scripts/prepare-deployment.mjs 参数.json 新目录`，字段见 [部署手册](deploy/RUNBOOK.md)。生成独立运行源码、固定依赖清单、随机TURN共享密钥、Nginx配置和“NoKey 国内连接中继”systemd文件；不安装/启动后台服务，不修改既有目录。不上传原始Mac设备密钥，不开启匿名登记。

语音发送端短暂断网800ms后尝试ICE restart，复用现有会话及仍有效TURN凭据；主动停止取消恢复，原10秒无音频确认停止采音边界保留。此行为已有回归检查，但iPhone蜂窝切换仍需服务器就绪后真机验证。中继拒绝请求不会自动重发用户按键。
