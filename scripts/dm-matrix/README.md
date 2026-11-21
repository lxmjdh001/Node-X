# Node X 的 mautrix 私信连接器

连接器把已自建的 `mautrix-twitter` 与 Matrix 中的私信同步到 Node X 收件箱。每个 X 账号运行一个连接器进程，共用一个 Node X 工作空间。浏览器登录和这个配对流程各自由对应服务管理。

## 准备 Matrix 与 mautrix

1. 按上游说明部署 Matrix homeserver 和 `mautrix-twitter`，并在桥接中登录该 X 账号。使用包含代理修复 #241 的版本，给 `network.proxy` 配置 Node X 同一账号窗口绑定的 SOCKS5。当前上游的代理配置按桥接实例生效。不同账号需要不同 SOCKS5 时，请分别配置独立桥接实例。 [上游部署说明](https://docs.mau.fi/bridges/go/twitter/index.html) · [代理修复](https://github.com/mautrix/twitter/pull/241)
2. 使用一个专门的 Matrix 用户登录单个 X 账号，加入该账号的桥接私信房间。连接器只同步指定桥接机器人写入且归属于配置 X 用户编号的房间。新建桥接时可启用 `bridge.split_portals: true`，使群聊使用带账号归属的独立房间。已有桥接请阅读上游关于变更此设置的说明。
3. 在桥接配置中启用 `matrix.message_status_events: true`。Node X 在桥接确认后才标记「已发送」。Matrix 自身收到消息只表示已受理。
4. 此连接器读写 Matrix 侧的普通私有房间，并在日志中提示跳过 Matrix 端到端加密房间。X Chat 侧的加密由 `mautrix-twitter` 处理。现阶段同步近期文本和后续新增文本。附件、撤回和编辑需要后续支持。

## 绑定 Node X

在 Node X「私信工作室」中选择账号并生成配对码。在运行连接器的主机上创建仅当前用户可读写的 JSON 配置文件，如 `~/.config/nodex/x-account.json`。保存前用 `umask 077` 或 `chmod 600` 设置权限。以下均为示意值。

```json
{
  "nodeXUrl": "https://nodex.example.com",
  "matrixUrl": "https://matrix.example.com",
  "matrixAccessToken": "该专用 Matrix 用户的 access token",
  "bridgeBotId": "@twitterbot:matrix.example.com",
  "xUserId": "123456789",
  "pairTicket": "工作台刚生成的一次性配对码"
}
```

- `xUserId` 使用 X 的数字用户编号，对应 mautrix 登录 ID。
- 可选的 `roomIds` 数组限制同步范围，值为 Matrix 房间 ID。
- 可选的 `matrixSelfPuppetId` 为该 X 账号在 Matrix 的映射用户 ID。若桥接将从 X 网页发出的本账号消息归到此用户，填入后它们将显示在发出侧。
- 两个服务地址只包含协议、主机和端口。远程地址使用 HTTPS，本机测试可用 HTTP。

使用 Node.js 22 或更新版本运行。

```sh
node scripts/dm-matrix/connector.mjs "$HOME/.config/nodex/x-account.json"
```

配对成功后可以从配置文件删除已用的一次性码。连接器会在配置文件旁保存一个权限为 600 的 `.state.json`，内含 Node X 连接凭据、Matrix 同步游标及发送确认状态。保留它可以断点续传。停止连接器请用 Ctrl+C 或发送 SIGTERM。若进程遭强制结束并留下 `.state.json.lock`，确认上次进程已经退出后再移除锁文件。撤销账号连接可在 Node X 工作台执行。

有连续历史需求时，请查看 Matrix 同步结果。首次运行读取每个房间最近的文本事件。后续使用游标读取增量。若 Matrix 返回的时间线存在间隔，连接器会记录提示并同步已返回的近期消息。发送时若 X 桥接未给出有效确认，Node X 会显示「结果待确认」，需要人工查看 X 会话。

本地验证运行 `node --test scripts/dm-matrix/connector.test.mjs`。测试使用临时目录与本机模拟服务。
