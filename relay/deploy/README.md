# 国内小范围部署模板

这套模板供单台国内 Linux 主机部署信令和 TURN 使用，不会启动服务或修改系统。当前未指定服务器、域名或预算，模板中的 `.example`、示例 IP 和空密钥必须替换，不能直接作为已部署配置。运营者维护服务，普通手机/Mac 用户不需要安装 Nginx、Node 或 coturn。

## 组成与填写

1. 将产品源码和锁定依赖部署到目标机器，用 Node 22 与 `npm ci --omit=dev` 准备信令服务。不要把本机 `build/`、配对密钥或 Mac 用户配置复制为服务器源码。
2. 复制 `relay.example.json` 为服务器配置（仓库外），填写国内 HTTPS 域名及 `devices` 登记表。设备登记方式见 [中继说明](../README.md)。模板 `devices` 为空，不允许任何 Mac 连接。
3. 在目标服务器生成至少 32 字节随机 TURN 密钥，写入 JSON 的 `turn.secret` 和 coturn 的 `static-auth-secret`。两份配置仅允许服务账号读取，不发送给手机，也不提交代码库。模板故意留空，现有 Node 配置校验会拒绝启动。
4. 填写 `turnserver.example.conf` 的真实网卡地址、公网映射、TURN 域名与证书路径。证书需覆盖对应域名；证书签发和续期由部署者配置。本模板选择 IPv4 监听/转发，IPv6 公网接入需另行配置并验收。
5. Nginx 模板放入现有 `http {}` 上下文，填写信令域名和证书，部署前先运行 `nginx -t`。模板支持 HTTP 和 WebSocket 转发。它不会自动申请证书或设置服务自启。[Nginx 官方 WebSocket 说明](https://nginx.org/en/docs/http/websocket.html)

## 网络边界

| 端口 | 用途 | 开放范围 |
| --- | --- | --- |
| TCP 443 | HTTPS 信令及 WSS | 需要接入的公网客户端 |
| UDP/TCP 3478 | TURN 连接 | 公网客户端 |
| TCP 5349 | TURN over TLS | 公网客户端 |
| UDP 49160–49200 | TURN 中继 allocation | 按 coturn 配置在云安全组及系统防火墙放行 |
| TCP 8787 | Node 信令内部端口 | 仅回环，不直接开放公网 |

NAT 型云主机的公网端口映射必须与 relay 端口范围一致。TLS TURN 使用独立 5349 端口，不会自动复用 HTTPS 443；仅允许 443 的网络仍可能失败，这项不能提前宣称已覆盖。

coturn 配置使用 REST 临时凭据、allocation 配额、每会话与总带宽上限。参数含义依据 [coturn 官方配置示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)，本地参考版本为 4.18.0。总带宽上限可能在并发增加时限制传输，必须结合语音连续性实测调整。它不是月度费用上限；云流量账单、套餐额度与告警仍需在服务商处配置。

禁止访问内网的 peer 范围用于避免 TURN 被用作服务器内网转发入口，不是客户端 IP 黑名单。未开启 allow-loopback-peers；本机测试配置不能原样复制到公网。

## 启动与验收

完成具体部署授权后，可先以前台方式启动 Node：

```sh
VOICEDECK_RELAY_CONFIG=/etc/voicedeck/relay.json node relay/src/node-server.mjs
```

coturn 使用其配置文件启动，Nginx 使用通过语法检查的配置。长期运行的服务账号、自启、停止方式、日志保留、证书续期和预算告警需要随部署目标落实；本目录没有替用户开启 systemd 或任何长期任务。

验收顺序：HTTPS `/health` → Mac 认证上线 → 手机异网配对 → 强制 TURN 收到实时音频 → TURN-TLS → 切网/断网恢复 → 30 分钟连续语音与并发/限额检查。记录网络运营商、两端版本、连接路径和延迟。只看到 health 成功，不代表音频可达。

当前证据只覆盖既有本地协议及 coturn 环回测试，尚未在真实 Nginx/TLS/国内云主机使用这些模板。模板不是公网部署完成证明，也没有采购或运行成本承诺。
