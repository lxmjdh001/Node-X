# Node X

在本机管理自己的 X 账号、SOCKS5 代理和独立浏览器环境。工作台还支持创建 AI 草稿，以及在账号完成 X OAuth 授权后发布短帖。

## 本地运行

需要 Node.js 22.13 或更新版本。当前项目在 Node.js 22 上验证。

```sh
npm ci
npm run browser:install
npm run dev
```

打开 [http://127.0.0.1:4173](http://127.0.0.1:4173)。首次运行需先配置下方的登录码生成页，AI 和 X API 密钥可按需添加。已构建的版本可用 `npm run build && npm start` 启动。

## 登录和设备登记

工作台需要登录码。开发环境的生成页是 `http://127.0.0.1:4174/operator`。部署环境可经 HTTPS 公开生成页，生产地址是 `https://xai.chuhai7.com/operator`，入口检查 Mac Chrome。

首次在 Mac Chrome 登记后，管理员可签发按天或自然月计时的授权码。授权从首次成功登录开始，到期前可重复登录，注销或重新登录不会重置期限。一天为 24 小时；自然月按北京时间推进，目标月份没有同日时到该月月末的同一时刻。选择「记住登录」会在此浏览器保留会话至授权到期，并保存最多 8 条登录码后四位和登录时间记录。

在已登记的 Mac Chrome 输入管理员密码后进入后台，后台登录有效期为 8 小时，可主动退出。列表显示签发时间、首次登录、到期时间、备注和状态。管理员可查看可用的原码、续期或停用。续期沿用原登录码和客户空间。使用中的码从原到期时间顺延，已到期的码从确认续期时开始计时。未激活和已停用的码不能续期。停用会使该码已有的会话失效。

新码默认进入独立客户空间。客户空间可管理自己的账号、代理配置、浏览器配置与草稿；共享浏览器、代理检测、AI 模型和 X 发布仍在主空间执行。选择「现有主空间」签发的码能访问主空间资料，只应提供给已获相应权限的人。

设备私钥由 Chrome 保存，页面无法导出。服务端用哈希校验授权码，对后台需要再次显示的原码加密保存。列表显示后四位，后台登录后可查看完整码。部署配置和维护方式见 [deploy/README.md](deploy/README.md)。

## 第一版流程

1. **账号**。新增本地记录，可填写 X 用户名和备注。账号记录可独立于外部授权使用。
2. **代理**。新增 SOCKS5 地址和端口，按需填写用户名、密码。点“检测”可查代理出口 IP 与检查耗时。检测使用代理访问固定的 HTTPS IP 查询服务。
3. **浏览器环境**。为账号创建环境，选定代理并配置语言、时区和视口。启动后在本机打开一个独立的 Chromium 窗口，可以手动登录或操作 X。关闭后保留该环境的 Cookie 和网页存储。浏览器展示真实内核版本。更换账号需要新建环境。删除环境会同时删除本地浏览器数据。
4. **内容**。可手工写草稿，也可配置兼容 OpenAI Chat Completions 的模型生成草稿。确认正文和目标账号后可以立即发布或安排时间。到点时 Node 服务需要在线。发布成功后保存帖子 ID。对于结果待确认的记录，先去 X 核对。
5. **授权**。从账号页通过 X OAuth 为现有账号授权发文。浏览器环境用于人工管理，OAuth 用于独立的官方 API 发布。X 的[自动化规则](https://help.x.com/en/rules-and-policies/x-automation)要求自动化使用 API。

## 批量导入账号和环境

在「账号管理」或「浏览器环境」点「批量导入」。每行填写一个 X 用户名和一个 SOCKS5 代理，预览后确认。支持 UTF-8 CSV，每次最多 100 条记录、192 KiB。一次提交创建账号、代理绑定和独立环境。校验失败时整批不会写入。

- **Node X 模板**：在导入窗口下载，填写 `username`、`proxy_host` 和 `proxy_port`。其余列可按需填写。用户名可以带 `@`。代理认证的用户名和密码需要一起填写。
- **Camoufox Profile Manager**：在 Profiles 导出 Excel，新增名为 `X username` 的列，填入每行对应的 X 用户名，再仅将配置表保存为 UTF-8 CSV。导入时选择「Camoufox Profile Manager」。读取环境名称、备注、SOCKS5 代理、语言、时区和窗口尺寸。代理类型必须为 `socks5`，代理地址填写 `host:port` 或 `[IPv6]:port`。导出文件中的代理密码为明文，请妥善保管。详见 [Camoufox 的导出文档](https://github.com/polyackiy/camoufox-profile-manager/blob/main/docs/excel.md)。

按用户名匹配现有账号，已有环境的行会跳过；已有账号但没有环境时会补齐绑定。源文件里重复的用户名需要先修正。完全相同的代理配置会复用，每个账号仍有独立的浏览器数据目录。导入只迁移配置，环境由 Node X 的 Chromium 打开，可手动登录或为发布功能做 X OAuth 授权。环境页显示已安装的实际内核版本，缺失时可执行 `npm run browser:install`。

## 直连 Camoufox Profile Manager

Node X 可以通过 Camoufox Profile Manager 0.7.0 的本机 REST API 创建、关联和打开环境。请先在本机运行 Manager，在其「设置」安装匹配的浏览器，再在 Node X 的 `.env` 填写：

```sh
CAMOUFOX_PORT=8001
CAMOUFOX_API_KEY=
```

端口要与 Manager 的 `CPM_PORT` 相同。如果 Manager 设置了 `CPM_API_KEY`，Node X 的 `CAMOUFOX_API_KEY` 填相同值。Manager 仅需绑定 `127.0.0.1`。如果默认 8000 已被其他服务占用，可以为 Manager 另选空闲端口。重启 Node X 后，在「浏览器环境 → Camoufox 批量管理」查看连接与内核状态。

- **批量创建**使用已绑定 SOCKS5 的 Node X 环境，每次最多 20 个。创建后自动与账号关联，复用已有关联。Camoufox 使用单独的环境目录；Node X 的现有 Chromium 会话仍保留在它自己的环境里。
- **关联现有**从 Manager 读取已绑定 SOCKS5 的环境，选一个关联到 Node X 账号。窗口、Cookie 和浏览器数据由 Manager 原地管理。解除关联只移除 Node X 的映射。
- **批量打开**每次最多 5 个窗口。Node X 在启动前核对 SOCKS5 绑定和 Manager 安装状态。窗口在运行 Manager 的机器上打开，首次在窗口内手动登录，关闭后会话由 Manager 保留。

当前最低支持 Camoufox/Firefox **158**，以 Manager 已安装内核的实际报告为准。0.7.0 官方支持的浏览器为 `158.0.1-beta.41`。如果未安装或版本过低，请在 Manager 内安装或更新后刷新 Node X。新建环境会传入 SOCKS5 和窗口尺寸；语言和时区按 Manager 本身的设置。详见 [Manager API](https://github.com/polyackiy/camoufox-profile-manager/blob/v0.7.0/docs/api.md) 和 [0.7.0 发布说明](https://github.com/polyackiy/camoufox-profile-manager/releases/tag/v0.7.0)。

## AI 和 X 配置

复制 `.env.example` 为 `.env`，保存后重启服务。浏览器环境与草稿编辑不依赖这些配置。

| 功能 | 配置 |
| --- | --- |
| AI 草稿 | `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。默认基础地址为 `https://api.openai.com/v1` |
| X 发文 | 在 [X Developer Console](https://console.x.com/) 创建启用 OAuth 2.0 和读写权限的应用，填写 `X_CLIENT_ID`。保密客户端同时填写 `X_CLIENT_SECRET` |
| X 回调 | 控制台与本地的 `X_REDIRECT_URI` 须完全一致，默认 `http://127.0.0.1:4173/api/x/callback`。授权时请使用相同的本机地址打开工作台 |

应用使用 OAuth 2.0 PKCE 和用户授权，申请 `tweet.read`、`tweet.write`、`users.read`、`offline.access`。账号表已填用户名时会核对实际授权账号。X API 调用按[官方规则计费](https://docs.x.com/x-api/getting-started/pricing)。

## 项目结构

| 目录或文件 | 职责 |
| --- | --- |
| `src/` | React + TypeScript 管理台，Vite 构建 |
| `server/index.ts` | Express 入口，提供页面和本机 API |
| `server/workspace.ts` | 账号、代理和浏览器环境管理 |
| `server/imports.ts`、`server/import-csv.ts` | CSV 预览、配置迁移和原子导入 |
| `server/browser.ts` | 代理检测和 Chromium 生命周期 |
| `server/camoufox-client.ts`、`server/camoufox-routes.ts` | 本机 Manager API、持久关联、分批创建与窗口控制 |
| `server/store.ts` | Node.js SQLite、表结构和凭据加密 |
| `server/content.ts` | 调模型、X OAuth 和发布接口 |
| `server/editor.ts`、`server/publisher.ts` | 草稿 API、持久化发布队列和故障处理 |
| `data/` | SQLite、加密密钥和独立浏览器目录。已排除在 Git 之外 |

复用 [Playwright](https://github.com/microsoft/playwright) 启动真实 Chromium，[Proxy Chain](https://github.com/apify/proxy-chain) 将浏览器的本机代理请求转给支持认证的 SOCKS5 上游，[socks-proxy-agent](https://github.com/TooTallNate/proxy-agents) 做代理检测，[Vercel AI SDK](https://github.com/vercel/ai) 连接模型，[node-twitter-api-v2](https://github.com/PLhery/node-twitter-api-v2) 负责 X 授权和发文，[twitter-text](https://github.com/twitter/twitter-text) 计算 X 短帖加权长度。

当前是本机单人、单服务进程版本。默认只监听 `127.0.0.1`，同一个数据目录应由一个服务进程使用。备份时先停止服务，再将整个 `data/` 一起备份，密钥与数据库均需保留。浏览器目录本身含会话信息，应和数据库一并妥善保管。

部署到常驻服务器时，再加入管理台鉴权与 HTTPS，将队列执行和浏览器进程拆成独立服务，并配置持久卷与备份。第一版使用真实 Chromium 和固定的环境配置，不改写硬件指纹。
