# NoKey 月付／年付中继授权

局域网不需要授权。中继按一台 Mac 绑定、按自然月或自然年计时，不统计流量额度。一个激活码只能绑定一台 Mac；同一台 Mac 可配对多部手机。复制整套 Mac 私钥仍可能冒用身份，本版不做硬件指纹或账号系统；同设备身份只保留一个在线 Mac 连接。

## 用户操作

在 Mac 设置中保存中继 HTTPS 地址，填写激活码并点击“激活 / 续期”。首次更换连接地址按界面提示重新打开客户端；同地址续期无需更新 App。点击“检查授权”查看服务端返回的到期时间。iPhone 扫码配对，不输入付费激活码，不设置购买入口。

第一次兑换起算一个自然月或12个自然月；月底按目标月最后一天计算。提前续费从原到期日延长；已过期则从兑换时间起算。重复提交同一个码不会重复延长。同一张码不能用于另一台 Mac。手动停用的设备不能靠旧码恢复，需运营方处理。

## 服务部署（本轮未部署）

使用 Node 22.13+ 的内置 node:sqlite，无额外数据库进程。已有 prepare-deployment 工具参数增加 `"subscriptions": true`，`devices` 可以是空数组。生成的授权数据库位于 `/var/lib/nokey/subscriptions.sqlite`，systemd StateDirectory=nokey 创建可写目录。备份数据库时使用 SQLite 一致性备份或停止中继后复制，勿直接在写入中复制文件。

注意：devices 配置里的人工登记设备仍是无到期时间的试用白名单。付费设备不要写入该白名单，必须通过激活码登记。

生成工具会给 coturn 开启仅监听127.0.0.1的管理接口5766，并生成随机管理密码；密码仅在受限服务端配置中。不要将此端口对外放行。中继每5秒使用本机接口检查并关闭过期或停用的媒体会话，同时拒绝新的信令及TURN凭据。依赖coturn管理接口健康：检查超过15秒不成功则拒绝新付费TURN凭据。管理接口或中继进程故障期间，已有媒体连接不能保证按5秒截止；生产启用前必须验证服务恢复和告警，不把短期TURN凭据过期误当成已强制断开旧连接。

实际云端版本需运行到期断开验收；本地使用coturn4.18.0验证。新版本不修改现有生产服务，备案完成后再按生成配置部署并验收。

## 运营者签发（不做支付网关）

在服务器上以有数据库权限的账户执行；激活码只输出一次，数据库只存摘要。不要把输出放到公开日志或源码库。

```sh
node relay/scripts/subscription-admin.mjs /var/lib/nokey/subscriptions.sqlite issue 1
node relay/scripts/subscription-admin.mjs /var/lib/nokey/subscriptions.sqlite issue 12
node relay/scripts/subscription-admin.mjs /var/lib/nokey/subscriptions.sqlite status 设备ID
node relay/scripts/subscription-admin.mjs /var/lib/nokey/subscriptions.sqlite revoke 设备ID
```

收款确认后由运营者签发和交付激活码；本版不自动收款，不包含订单/退款/自动续费。不承诺任意流量可无限占用，原有服务器基础并发及速率限制仍有效，但不按流量收费。

## App Store

iPhone 保持免费配套客户端，授权在独立分发的 Mac 端办理。苹果3.1.1限制激活码解锁App功能，3.1.3(f)对满足条件的免费配套客户端有例外；能否适用以审核为准，不声称移动端不显示激活入口就必然免内购。提交时如实披露中继服务及提供可用审核环境，不隐藏功能或仅靠远程开关绕过审核。未来若需加入苹果内购，仍需要客户端更新。

https://developer.apple.com/app-store/review/guidelines/

## 检查

`node --test relay/test/subscriptions.test.mjs` 验证月末续期、重复兑换、设备绑定、存储恢复、停用、HTTP激活和已有连接到期退出。

`node relay/test/turn-expiry-check.mjs` 在本机临时启动coturn及测试客户端，验证有效会话保留和失效会话实际关闭；结束后退出清理，不创建后台服务。
