# NoKey 国内中继部署与验收

这是待服务器目标确定后的操作手册。生成目录不代表部署成功；本工具不购买资源、不登录服务器、不启动后台任务。此目录 config 含 TURN 密钥，不能上传 GitHub 或发给测试者。

## 服务组成

一台 Linux 主机：Nginx 提供 HTTPS/WSS，Node 22 提供端到端加密指令转发，coturn 提供实时 WebRTC 音频中继。无需数据库、Redis、网盘或对象存储。沿用成熟 coturn，不自建音频转发协议。

手机和 Mac 都向服务器发起出站连接，不要求管理路由器。音频直连可用时优先直连，失败时使用 TURN；服务器不做语音识别。

## 准备目标后

1. 取得服务器公网 IPv4、实际网卡 IPv4、域名及 SSH 登录方式。腾讯云要求中国内地轻量服务器托管的网站/APP按适用情况完成备案后开通域名访问，购买时同时安排域名实名与备案：[腾讯云说明](https://cloud.tencent.com/document/product/1207/45756)。不假设有服务器就能开放 HTTPS。优先使用 Ubuntu 24.04 LTS 系统镜像，部署前确认该镜像可选。
2. DNS A 记录指向公网 IP，申请覆盖该域名的受信任 TLS 证书。不得用关闭验证或自签名信任绕过。
3. 在 Mac 从状态目录 relay-device.json 读取 deviceId，计算 deviceSecret 的 SHA-256 摘要作为 secretHash；只把这两个值写入部署参数，不传原始设备密钥。生成器拒绝包含 deviceSecret 的登记记录。
4. 以参数文件调用 prepare-deployment.mjs。输出目录必须不存在；包含 app 运行代码、锁文件、config 和此说明。每次生成有新的 TURN 密钥，不要用重新生成来代替普通代码升级。

参数结构：

```json
{"domain":"relay.your-domain.cn","publicIp":"你的公网IPv4","privateIp":"网卡IPv4","devices":[{"deviceId":"Mac设备ID","secretHash":"64位SHA256摘要"}]}
```

## 部署步骤（具体机器授权后执行）

- 安装 Node 22、Nginx、coturn，确认 `node --version` 及 `/usr/bin/node` 路径。
- 建立专用系统账号 nokey，部署 app 到 `/opt/nokey/app`，运行 `npm ci --omit=dev --ignore-scripts`；不复制本机 node_modules、Electron、配对记录或 build。
- relay.json 放 `/etc/nokey/relay.json`，属主 nokey，权限600；/etc/nokey权限700。
- coturn 配置放 `/etc/turnserver.conf`，仅服务账号可读；证书路径与实际一致，按发行版服务账号配置最小读取权限，不能把私钥设为全局可读。证书续期后需要按部署平台配置安全的重载流程。
- nginx.conf 放入 Nginx http 上下文的站点配置。先 `nginx -t`，再应用；默认不记录含配对码的访问日志。
- 云防火墙与主机防火墙放行 TCP443、UDP/TCP3478、TCP5349、UDP49160–49200。8787只监听回环。SSH限制管理员来源。
- 先前台启动验证，验收后再启用长期服务。systemd 描述为“NoKey 国内连接中继”，用途是保持 Mac/手机连接，持续到管理员停止；只读服务器配置、访问网络、不访问 Mac 文件。停止 `systemctl stop nokey-relay`；取消自启 `systemctl disable nokey-relay`。coturn/Nginx的启动和停止按发行版服务管理，首次启用需明确授权。
- 正式运行要设置云流量告警、日志轮转、证书续期。coturn带宽配额不是费用封顶。初期只登记自己和少量同事的Mac；不开放匿名注册。

## 验收必须分层记录

1. 公网 HTTPS health、WSS，证书有效。
2. Mac填入国内服务地址并重开，登记设备上线；手机重新扫描该服务配对二维码（已有局域网地址不能凭空成为公网地址）。
3. 关闭 iPhone Wi-Fi，用蜂窝网络：文字填入、发送、旋钮、四向自定义快捷操作均成功。
4. 强制 relay 模式在测试工具中验证音频确实经过 coturn，分别验证 UDP 与 TCP/TLS；不能拿直连成功代替中继成功。
5. 30分钟连续语音；长于凭据有效期的会话验证续期；记录声音中断和尾字，不把自动测试加速时间当成长时间实测。
6. Wi-Fi/蜂窝切换、Mac短断网、服务重启：不重复发送文字或按键，明确显示恢复状态；无法恢复时停止采音并可手动重新开始。
7. 结束和退出恢复Mac原麦克风；拒绝未登记Mac、撤销的手机及过期配对。

目前 TURN-TLS 使用5349，不能承诺仅开放443的受限网络可用。若目标网络需要，另评估独立IP的TURN443或经过验证的443分流，不预先增加复杂度。

回退：停止信令和TURN，恢复上一版 app/config；Mac清空服务地址后重开并按局域网二维码重新配对。正常代码更新保留服务器TURN密钥与设备登记。任何密钥轮换都会影响已有会话，必须单独安排。
