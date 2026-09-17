# Mock Server · 带界面的动态挡板服务

> 语言 / Language： [中文](README.md) ｜ [English](README.en.md)

同一份配置能挂多个服务的接口；**同一个接口可以按请求内容返回不同结果**。
这是它和「一份写死的返回」类 mock 平台的核心差别：这里「一个接口 = 一串带条件的规则，命中哪条返哪条」。

零依赖（只用 Node 内置模块），单进程，改规则不用重启。

![控制台总览](docs/shot-console.png)

<p align="center"><sub>控制台总览：左（接口列表）· 中（规则编排 + 试打）· 右（实时请求日志）｜<a href="docs/shot-share.png">分享链接弹窗</a>｜<a href="docs/shot-help.png">网页版操作手册</a></sub></p>

---

## 快速开始 <!-- sec:quickstart -->

**本机联调（开发自测）**——不需要 `npm install`，Node ≥ 16 即可：

```bash
git clone https://github.com/LeeJiEunm/mock-server.git
cd mock-server && node server.js     # 管理界面 http://127.0.0.1:18080/
```

**服务器部署（测试 / 项目人员长期使用）**——一键脚本自动探测 node、生成 systemd 单元、开机自启：

```bash
./deploy.sh <user>@<HOST_IP>          # 默认 /opt/mock-server + 端口 18080
```

> 仓库：<https://github.com/LeeJiEunm/mock-server> ｜ 作者：LeeJiEunm ｜ 问题反馈：<https://github.com/LeeJiEunm/mock-server/issues>

---

**文档入口**

| 文档 | 读者 |
| --- | --- |
| [docs/操作手册.md](docs/操作手册.md) | 测试 / 联调同事：任务速查（部署模式、分享链接、用户管理、FAQ） |
| 控制台顶栏 ❓ 图标（[`public/help.html`](public/help.html)） | 所有人：网页版图文上手指南，只读分享视图里也能打开 |
| 本 README | 部署者 / 维护者：规则语法全集、部署形态、管理接口 |

---

## 一、接入背景 <!-- sec:background -->

本服务是一套**零依赖的 Node 挡板（mock）**，用于**联调 / 测试阶段替换上游真实接口**。

它的定位是一个通用的、可配置的接口模拟器：

- 按请求里的字段（如 `code`）**动态返回不同响应**（成功 / 各种错误码）；
- 可模拟**服务异常（500）、超时（延迟）、业务失败（自定义状态码）** 等分支，覆盖正向与反向用例；
- 配合「试打」功能，不连真实上游就能验证规则是否命中。

挡板能力是通用的（按模块 + 接口路径匹配，规则可配），既可替换一个上游服务里的某个接口，也能接管整条链路。本项目自带 `demo` 模块作为示例，其余模块可通过对界面录入或从老 mock 平台导入得到（见[第十一章](#十一从老-mock-平台导入)）。

> ⚠️ 本服务仅限内网测试网段使用。脚本模式下会直接执行 JS，请勿暴露到公网。

---

## 二、特性 <!-- sec:features -->

- **零依赖**：只用 Node 内置模块（`crypto.randomUUID()` 等），不 `npm install`，一个目录即可带走。
- **动态规则**：每个接口由「多条带条件的规则 + 兜底返回」组成，命中即停。
- **管理界面**：左（接口列表）/ 中（规则编排）/ 右（实时日志）三栏，改完保存立即生效。
- **多种取值与操作符**：请求体 / URL 参数 / 请求头 / 原始文本；支持数组通配 `a[*].b`、正则、集合、数值比较等。
- **脚本生成响应**：可按请求里的数组逐项生成不同返回。
- **代理透传**：接口可配置回源真实服务，适合「大部分真实、个别挡板」的联调。
- **主题切换**：自动 / 暗 / 浅三套，纯 CSS 变量，不刷新页面。
- **多部署形态**：本地（mac / win）直接 `node server.js`；服务器支持 systemd / plain / Docker。

---

## 三、上手前必读（约束） <!-- sec:must-know -->

这几条是「不读就会踩坑」的保命项，建议部署前先过一遍：

1. **⚠️ 仅限内网测试网段**。脚本模式直接执行 JS，请只在测试网段开放，不要暴露到公网。
2. **⚠️ `config.json` 是唯一数据源**。界面上的改动会立即写回文件；直接改文件则需要在界面上点「重新读取配置」。配置最外层是 `groups` + `apis` 两个数组：`apis[].groupId` 指向 `groups[].id`，留空或指向已删除分组会落到「未分组」。分组只影响界面归类，不参与请求路由。
3. **⚠️ 规则是按顺序命中即停**。把宽的规则放上面会吃掉后面所有规则。
4. **⚠️ 响应结构要贴合真实接口**。被测客户端对返回字段有硬要求，字段缺了会 NPE。设计挡板响应时，务必对照真实接口的字段与类型，确保必填字段齐全、类型一致。
5. 挡板路径不能以 `/_admin` 开头，那是管理接口的保留前缀。
6. **静态资源只走「根路径 / `styles/` / `scripts/` / 带 `.css .js .json .ico .png .svg` 等后缀」这几类**，其余路径一律当挡板接口处理。所以挡板接口路径**不要带静态后缀**（`/demo/query.json` 会被当成静态文件）。
7. 日志在内存里，重启即清空，默认保留 200 条（`config.json` 的 `logSize` 可调）。
8. 浏览器自动请求的 `favicon.ico`、`/.well-known/*` **不会进请求日志**，日志里只剩真实业务调用。
9. **同一路径可以按 HTTP 方法分开配接口**。接口的 `method` 填 `ALL` 或留空 = 匹配所有方法；填 `GET` / `POST` 等只匹配对应请求。同路径同方法仍旧是先定义优先。

---

## 四、本地部署（开发机 / 联调用） <!-- sec:local-deploy -->

本地部署就是在本机（macOS 或 Windows）直接跑起服务，用浏览器打开管理界面配规则、把被测系统的上游地址指到本机即可。不需要 `npm install`。

### 4.1 macOS <!-- sec:local-mac -->

```bash
# 1) 确认本机有 Node（建议 >= 16）
node -v

# 2) 进入工程目录，直接启动
cd mock-server
node server.js
```

启动后：

- 管理界面：http://127.0.0.1:18080/
- 挡板入口：http://127.0.0.1:18080/{模块}/{接口路径}

> 目录里没有 `config.json` 时，服务会自动从 `config.example.json` 复制一份示例配置——
> 所以 clone 下来直接 `node server.js` 就能跑，不需要手动准备配置文件。
> `config.json` 是**运行数据**（界面改的规则都在里面），已加入 `.gitignore`，不会被提交。

> macOS 上常把上游地址配成 `http://127.0.0.1:18080/demo`；注意地址结尾不要带 `/`。

### 4.2 Windows <!-- sec:local-win -->

Windows 上需要先装 Node，再用 PowerShell 或 CMD 启动：

1. 到 https://nodejs.org 下载安装 Node（LTS，建议 >= 16），安装后打开「命令提示符」或 PowerShell 验证：

   ```powershell
   node -v
   ```

2. 进入工程目录启动：

   ```powershell
   cd mock-server
   node server.js
   ```

3. 浏览器打开：

   - 管理界面：http://127.0.0.1:18080/
   - 挡板入口：http://127.0.0.1:18080/{模块}/{接口路径}

> 若被测系统和挡板不在同一台机器，把地址里的 `127.0.0.1` 换成挡板所在机器的**局域网 IP**（如 `http://192.168.x.x:18080/demo`），并确认防火墙放行 18080 端口。

### 4.3 本地常用操作 <!-- sec:local-common -->

```bash
# 改端口（环境变量优先于 config.json 的 server.port，再优先于默认值 18080）
PORT=18081 node server.js

# 免密 + 只读分享端口（本地复现「分享链接走独立端口」的部署形态）
READONLY_PORT=18081 node server.js     # 分享链接指向 http://<host>:18081/?share=...（去掉 ?share= 也只读）
```

> `READONLY_PORT` 只在**免密部署**下改写分享链接的主机端口（账密部署的链接仍走主端口，靠登录保护兜底）；必须与主端口不同。免密又不配它 → 界面「生成分享链接」返回 403。
>
> 改过 `deploy.sh` 后可跑 `tools/verify-deploy.sh` 本地自检（假 ssh 沙盘，不需要真实服务器）。

**控制台登录保护**（只保护 Web 管理界面；直接调用 mock 接口如 `/demo/...` 完全不受影响）。

**方式一：部署时用环境变量指定管理员（最常用）**

```bash
MOCK_ADMIN_USER=zhangsan MOCK_ADMIN_PASS=secret node server.js
```

- 不写 `MOCK_ADMIN_USER` 时用户名默认 `admin`，即 `MOCK_ADMIN_PASS=secret node server.js` → 用 `admin / secret` 登录。
- 两个都不设 = 不启用登录，面板任何人可访问。
- 启动时会打印当前生效的登录配置，不用猜：
  ```
  控制台登录 : 已启用（账号 zhangsan，来源 MOCK_ADMIN_USER / MOCK_ADMIN_PASS）
  ```
- 忘了密码：改环境变量重启即可；`MOCK_ADMIN_USER` 换成新用户名，旧账号就失效了。

**方式二：多个账号写进 `config.json`（团队各自一个）**

密码以 scrypt + 随机 salt 哈希存储，不落明文，用自带脚本增删改：

```bash
node tools/add-user.js zhangsan secret     # 新增用户 / 改密码
node tools/add-user.js --list              # 查看现有账号
node tools/add-user.js --remove zhangsan   # 删除用户
```

等价于手改配置（哈希用 `node tools/gen-pass.js 你的密码` 生成，格式为 `scrypt:<salt>:<derived>`，每用户随机 salt）：

```json
{ "users": [
  { "username": "zhangsan", "passwordHash": "scrypt:<saltB64>:<derivedB64>" },
  { "username": "lisi",     "passwordHash": "scrypt:<saltB64>:<derivedB64>" }
] }
```

> 老配置里的 `sha256:<hex>` 仍兼容（迁移期），但新密码一律走 scrypt + 随机 salt，避免离线撞库。

改完自动重载，不用重启服务。

**两者关系**：环境变量与 `users` 同时生效（先校验环境变量，未命中再查 `users`），可以各登各的。空 `users` + 空环境变量 = 不启用登录。

**面板行为**：登录成功后拿到 24 小时有效的 token，存在浏览器本地；登录失败只清密码、保留用户名；未登录时不会打后台轮询接口，所以不会出现「输到一半输入框被清空 / 光标跳回用户名」。

> 此登录是**控制台访问**凭据，与「服务器部署」章节的 **SSH 部署密码**（`deploy.sh`）互不相干。

端口取值优先级：`PORT` 环境变量 > `config.json` 的 `server.port` > `18080`。

### 4.4 界面语言（部署期默认语言） <!-- sec:local-lang -->

控制台界面支持**中文 / 英文**两套文案，且**登录页也带语言切换**——登录卡片底部有「中文 / English」两个按钮，未登录时就能选，选完登录后的控制台文案也跟着变。

**部署期指定默认语言**（可选，不指定则默认中文）：

```bash
# 部署时让控制台默认显示英文（中文用 zh-CN）
MOCK_DEFAULT_LANG=en MOCK_ADMIN_PASS=secret node server.js
```

- 取值：`zh-CN` 或 `en`（`en` / `english` / `zh` / `zh-CN` 等别名都会归一化）。
- 优先级：`MOCK_DEFAULT_LANG` 环境变量 > `config.json` 的 `defaultLang` 字段 > 不指定（中文）。
- 服务启动时会打印当前生效的默认语言：
  ```
  默认语言 : en（来源 MOCK_DEFAULT_LANG）
  ```
- **「部署默认值」与「用户显式选择」的关系**（关键）：部署默认值只在「用户自己还没点过语言切换」时生效，而且**不写入浏览器本地存储**。也就是说，改了 `MOCK_DEFAULT_LANG` 重启后，所有还没手动选过语言的用户会立刻看到新默认语言；但一旦某用户自己点过「中文 / English」，那个选择就被记住（存 `localStorage`），之后不再被部署默认值覆盖——直到他清掉浏览器存储。这样既能统一初始语言，又不会把用户的偏好固化成部署配置。
- 用户登录前后都能在顶栏点 🌐 按钮切语言，登录页与控制台的语言选择会互相同步。

---

## 五、服务器部署（测试机 / 长期联调环境） <!-- sec:server-deploy -->

服务器部署面向一台常开的测试机（Linux，通常是 CentOS 7 / Ubuntu）。三种方式任选：

- **一键脚本 `deploy.sh`**（推荐）：自动探测 node 路径、生成 systemd 单元、开机自启。
- **systemd 手工部署**：适合想自己掌控 service 文件的场景。
- **Docker 部署**：宿主机不需要装 node，node 在容器里。

### 5.1 前置条件 <!-- sec:server-prereq -->

| 项 | 说明 |
| --- | --- |
| Node 版本 | **>= 16**。本服务只用 Node 内置模块，实测 Node 14 也能完整跑。 |
| glibc 注意 | CentOS 7 的 glibc 是 2.17，**装不了 Node 18+**（会报 `GLIBC_2.28 not found`）。CentOS 7 请用 16.x 的 tar 包方式安装，不要碰 yum 的 18+。 |
| SSH 登录 | 脚本用 SSH 连接复用（ControlMaster），单次部署只在第一次连接时输一次密码、后续自动复用，**无需事先配置免密登录**。想让以后多次部署都免输密码，可自行选配 `ssh-copy-id`（可选，非必须）。 |

CentOS 7 安装 Node 16（不污染系统自带软件）：

```bash
cd /tmp
curl -LO https://npmmirror.com/mirrors/node/v16.20.2/node-v16.20.2-linux-x64.tar.xz
mkdir -p /usr/local/nodejs
tar -xf node-v16.20.2-linux-x64.tar.xz -C /usr/local/nodejs --strip-components=1
ln -sf /usr/local/nodejs/bin/node /usr/local/bin/node
ln -sf /usr/local/nodejs/bin/npm  /usr/local/bin/npm
node -v        # 期望 v16.20.2
```

SSH 登录（可选）：脚本已用 SSH 连接复用处理密码（见上方前置条件表），**无需手动配免密**。若希望以后每次部署都不再输密码，可自行选配（非必须）：

```bash
ssh-copy-id <user>@<HOST_IP>
```

### 5.2 一键部署（deploy.sh） <!-- sec:server-onclick -->

在**本机**（存放交付包的目录）执行，脚本会自动 ssh 到目标机：

```bash
cd mock-server
./deploy.sh <user>@<HOST_IP>
```

参数说明：

| 参数 | 含义 | 默认值 |
| --- | --- | --- |
| `-p, --port` | 监听端口 | 18080 |
| `-r, --readonly-port` | 只读隔离端口（分享链接专用；**免密部署必配**） | 不启用 |
| `-d, --dir` | 远端安装目录 | /opt/mock-server |
| `-m, --mode` | 安装方式 systemd / plain / docker | 自动判断（优先 systemd） |
| `-f, --force` | 连 config.json 一起覆盖（默认保留远端已有配置） | 不加则保留 |

示例：

```bash
./deploy.sh root@<HOST_IP>                       # 默认 /opt/mock-server + 18080
./deploy.sh root@<HOST_IP> -p 9090               # 换主端口
./deploy.sh root@<HOST_IP> -d /data/mock-server  # 换安装目录
./deploy.sh root@<HOST_IP> -r 18081              # 免密 + 只读端口 18081（示例端口，按需换）
./deploy.sh root@<HOST_IP> -m docker -p 7773     # 走容器（宿主机不需要 node）
```

**推荐：给测试同学用的免密部署（只读端口 18081）**

```bash
cd mock-server
./deploy.sh root@<HOST_IP> -r 18081
```

- 不给 `MOCK_ADMIN_PASS` = 免密：主端口面板谁都能打开、谁都能改规则 —— 适合内网联调，**别放到公网**。
- `-r 18081` 时脚本会自动：写 `Environment=READONLY_PORT=18081` 进 systemd 单元（plain 模式写进启动命令、docker 模式生成 compose 叠加文件）、占用检查覆盖两个端口、防火墙同时放行 `18080` 与 `18081`。
- 只读端口 `18081` 上：`/login` 被禁、任何非 GET 写操作一律 403；**除 `/_admin/auth` 外的管理接口都要求带有效分享链接**——不带令牌直接访问 `/_admin/config`、`/_admin/share`、`/_admin/logs` 等一律 403（服务端拦截，不是只在前端画个提示页），页面上才会显示「需要有效的分享链接」。
- 生成分享链接后，URL 形如 `http://<HOST_IP>:18081/?share=shr-xxxx` —— 对方把 `?share=...` 删掉也只是这个只读页面，改不动任何东西。
- 安全边界：这个隔离**只保护分享链接**。`18080` 主端口无保护，建议用防火墙把主端口收紧到自己/内网网段，只对测试同学放行 `18081`。

> `-r` 与 `-p` 不能相同（相同则 server.js 会静默不启用只读监听）；脚本会在部署前直接报错拦住。端口被占也会在部署前退出（含只读端口），不会部署出一个「界面正常但分享链接打不开」的半成品。

部署时就开启控制台登录（可选，详见 4.3；**在脚本前面加环境变量**即可）：

```bash
# 指定管理员用户名 + 密码
MOCK_ADMIN_USER=zhangsan MOCK_ADMIN_PASS=secret ./deploy.sh root@<HOST_IP>

# 只给密码：用户名默认 admin
MOCK_ADMIN_PASS=secret ./deploy.sh root@<HOST_IP>

# 多个账号：先把用户写进本地 config.json，再用 -f 一起带过去
node tools/add-user.js zhangsan secret
./deploy.sh root@<HOST_IP> -f

# 同时指定部署期默认语言（en / zh-CN，详见 4.4）
MOCK_DEFAULT_LANG=en MOCK_ADMIN_PASS=secret ./deploy.sh root@<HOST_IP>
```

脚本会把这两个变量写进远端的 systemd 单元（plain / docker 模式写进启动命令），部署收尾还会回显一行 `控制台登录 已开启，账号 zhangsan`；想改账号或密码，改环境变量后重跑 `./deploy.sh` 即可。远端配置文件在 `<安装目录>/config.json`，`tools/add-user.js`、`tools/gen-pass.js` 也会一并上传，所以登录后在远端直接跑 `node tools/add-user.js 用户名 密码` 也能加人。

> 开启了登录后，`/_admin/health` 未登录访问会返回 **401**：这是正常的（服务活着、只是要登面板），脚本的健康检查已按「200 或 401 都算就绪」处理。

脚本自动完成的 7 步：

| # | 步骤 | 做什么 |
| --- | --- | --- |
| 1 | 探测环境 | 找出远端 node 绝对路径与版本，以及有没有 systemd / docker |
| 2 | 停旧实例 | 升级重部署时先停掉在跑的旧版，避免端口被自己占用 |
| 3 | 查端口 | 端口被别的进程占了直接报错退出，不会静默顶掉别人 |
| 4 | 上传文件 | `server.js` + `public/` + `tools/`（用户管理脚本）+ `config.example.json`；`config.json` 默认保留远端那份（那是你配好的规则）；本地若还没有 `config.json`，脚本会改传 `config.example.json` |
| 5 | 安装启动 | 按真实路径生成 systemd 单元并 `enable --now` |
| 6 | 健康检查 | 打 `/_admin/health`；**200 或 401 都算就绪**（401 说明开了登录保护），不通过打印排查命令 |
| 7 | 放行端口 | 有 firewalld 则放行；给了 `-r` 会连只读端口一起放行，没有 firewalld 就跳过 |

> node 绝对路径是**探测出来的**（`command -v node`），安装目录与端口都是命令行参数，端口最终写进 systemd 单元的 `Environment=PORT=`（只读端口写 `Environment=READONLY_PORT=`），都不写死。

**部署后设置维护者信息（邮箱 + 仓库地址）**

控制台顶栏的「联系维护者」（✉）与「GitHub」（仓库图标）都读远端 `config.json` 的 `meta`；仓库里邮箱保持占位值，**真实邮箱只在目标机上设一次**（避免随 git 提交出去）。仓库地址是公开信息，工程内已带真值。

一条命令同时设邮箱和仓库地址（把 `<安装目录>`、邮箱替换成自己的）：

```bash
ssh <user>@<HOST_IP> 'bash -s' <<'REMOTE'
cd /opt/mock-server            # 换成自己的安装目录
node - <<'JS'
const fs = require('fs');
const p = 'config.json';
const c = JSON.parse(fs.readFileSync(p, 'utf8'));
c.meta = Object.assign({ contactLabel: '维护者' }, c.meta, {
  contactEmail: 'you@example.com',                          // 真实联系邮箱
  repoUrl: 'https://github.com/LeeJiEunm/mock-server',      // 顶栏 GitHub 按钮打开的地址
  repoLabel: 'mock-server',
});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('meta =', c.meta);
JS
REMOTE
```

- 写完即生效（服务监听了配置文件变更）；没生效就在面板点一次「重新读取配置」。
- `meta.repoUrl` 只接受 `http(s)://`；留空则点 GitHub 按钮只弹提示、不跳转。
- 这些值只能通过 `config.json` 设置（面板上是展示用，不能编辑）。
- 重跑 `./deploy.sh` **不会覆盖远端 `config.json`**（默认保留远端那份），所以设过就一直有效；只有加 `-f` 才会用本地那份覆盖。

### 5.3 systemd 手工部署 <!-- sec:server-systemd -->

不用脚本时，照 `mock-server.service` 模板填 4 个占位符后传到目标机：

```bash
# 1) 上传文件（本地没有 config.json 时传 config.example.json，服务首次启动会自动复制它）
ssh <user>@<HOST_IP> 'mkdir -p /opt/mock-server'
scp -r server.js config.example.json public <user>@<HOST_IP>:/opt/mock-server/

# 2) 查 node 绝对路径（要写进 service 文件，不能照抄 /usr/bin/node）
ssh <user>@<HOST_IP> 'command -v node'

# 3) 把 mock-server.service 里的 {{NODE_BIN}} {{REMOTE_DIR}} {{PORT}} {{RUN_USER}}
#    替换成实际值，存到 /etc/systemd/system/mock-server.service
#    （要开只读分享端口就在 [Service] 段加一行 Environment=READONLY_PORT=18081）

# 4) 启动
ssh <user>@<HOST_IP> 'sudo systemctl daemon-reload && sudo systemctl enable --now mock-server'
```

### 5.4 Docker 部署 <!-- sec:server-docker -->

宿主机只需装好 docker + compose，不需要 node：

```bash
# 宿主机上执行。config.json 是卷挂载目标，必须先存在，否则 docker 会把目录挂到该位置：
#   cp config.example.json config.json
MOCK_PORT=18080 docker compose up -d --build
```

- `MOCK_PORT` 决定宿主机端口（容器内固定 18080）；`config.json` 通过卷挂到宿主机，界面保存的规则能落到宿主机文件。
- 容器 `restart: unless-stopped`，宿主机重启后自动拉起。
- **要只读端口就别手改 compose**：用 `./deploy.sh <user>@<HOST_IP> -m docker -r <宿主机只读端口>`——脚本会在远端生成 `docker-compose.readonly.yml` 叠加文件，把 `<宿主机只读端口>` 映射到**容器内的 18081**，并给容器注入 `READONLY_PORT=18081`，再以 `-f docker-compose.yml -f docker-compose.readonly.yml` 启动。容器内只读端口必须与容器内主端口（18080）不同，所以容器里固定用 18081，宿主机暴露哪个端口由 `-r` 决定。

### 5.5 开机自启与日常运维 <!-- sec:server-ops -->

| 场景 | 命令（本机执行，目标机为 `<user>@<HOST_IP>`） |
| --- | --- |
| 看服务状态 | `ssh <user>@<HOST_IP> 'systemctl status mock-server'` |
| 重启服务 | `ssh <user>@<HOST_IP> 'systemctl restart mock-server'` |
| 看日志 | `ssh <user>@<HOST_IP> 'journalctl -u mock-server -n 50 --no-pager'` |
| 确认开机自启 | `ssh <user>@<HOST_IP> 'systemctl is-enabled mock-server'` |
| 取回配置 | `scp <user>@<HOST_IP>:/opt/mock-server/config.json ./config.json` |
| 换端口重部署 | `./deploy.sh root@<HOST_IP> -p 18081` |

- 服务器重启 → 服务自动起来（已 `enable`）。
- 进程意外挂掉 → `Restart=always` 3 秒后自动拉起。
- 连续启动失败 5 次 → 停止重试（避免配置写错时刷爆日志）。
- **界面上故意没有「重启服务」按钮**：改规则不用重启（保存即生效），只有改了 `server.js` 才需要重启。

健康检查：

```bash
curl -s http://<HOST_IP>:18080/_admin/health
# {"ok":true,"port":18080,"apis":2,"groups":1,"rules":6}
```

### 5.6 更新已有部署（升级到新版本） <!-- sec:server-upgrade -->

`deploy.sh` 是**幂等**的：对同一台机器、同一套参数再跑一次就是升级。参数（`-p` 主端口、`-d` 安装目录）要与首次部署一致，只读端口按需带上。

```bash
# 1) 本机仓库目录里重跑（-p / -d 必须与首次部署一致，否则会装出第二套服务）
cd mock-server
./deploy.sh <user>@<HOST_IP> -p <主端口> -d <安装目录> -r <只读端口>

# 2) 校验
ssh <user>@<HOST_IP> 'curl -s http://127.0.0.1:<主端口>/_admin/health'   # 免密部署返回 JSON
ssh <user>@<HOST_IP> 'systemctl cat mock-server | grep -E "WorkingDirectory|Environment|ExecStart"'
```

**升级不需要备份 `config.json`** —— 脚本默认保留远端那份（见下）。只有你**主动**加 `-f` 才该先备份（`cp config.json config.json.bak.$(date +%F)`）。

- 脚本按顺序：停旧实例 → 校验端口（含只读端口）→ 上传 `server.js` / `public/` / `tools/` → 重写 systemd 单元 → 重启 → 健康检查 → 放行端口。
- **远端 `config.json` 默认保留，一个字节都不动**（接口 / 规则 / `users` / `meta.contactEmail` / `shareTokens` 全在里面，它是唯一数据源）。会更新的是代码与前端（`server.js`、`public/`、`README.md`、`tools/add-user.js`+`gen-pass.js`）和 systemd 单元（必须重写，否则新参数不生效）；全程无删除。
- **要主动覆盖才加 `-f`**；加了 `-f` 会用本地那份**整体替换**，那就必须先备份。
- 前端（`public/`）更新后，浏览器要 `Cmd+Shift+R` 强刷一次；服务端不用管。
- 只想改参数（换端口 / 开只读端口）也是重跑 `deploy.sh`，不用手工编辑 systemd 单元。

---

## 六、接进被测系统 <!-- sec:wire-sut -->

以「把被测系统的某个上游接口指向挡板」为例，改被测服务的配置（字段名以被测系统为准，这里只是示意）：

```properties
upstream.service.demo.enabled=true
upstream.service.demo.url=http://<挡板地址>/demo     # 结尾不要带 /
upstream.service.demo.token=mock                    # 挡板不校验，随便填
```

代码里拼出来的是 `url + "/sample"`，最终请求打到
`http://<挡板地址>/demo/sample`，正好对上「模块 `demo` + 接口 `sample`」。

**联调完记得把地址改回真实上游。**

其它服务同理：模块名换成自己的，接口名填实际路径（可以是多段，如 `demo/query`）。

地址不用自己拼，界面上有三处能直接拿到：

| 位置 | 给的是什么 |
| --- | --- |
| 左侧栏顶部 | **服务根地址**，点「复制」拿走 |
| 接口卡片的地址条 | 当前接口的**完整调用地址**，右侧「复制」一键复制 |
| 左侧栏接口条目上悬停 | 弹出的提示就是该接口的完整调用地址 |

地址里的 host 取的是**你打开界面用的地址**，所以从 `http://<HOST_IP>:18080/` 进去，复制出来的就是 `<HOST_IP>`，不会错成 127.0.0.1。

---

## 七、规则模型 <!-- sec:rule-model -->

```
请求 → 找到接口（模块 + 接口路径精确匹配）
     → 接口开了代理？ → 直接透传真实服务，结束
     → 按顺序逐条试规则：全部条件满足（或任一满足）= 命中 → 立即返回该规则的响应
     → 都没命中 → 用「兜底响应」
```

一个接口的规则从上到下试，**命中即停**。所以：

- 具体规则放上面，宽泛的放下面；
- 最后一条常设成「无条件 · 恒命中」，当作默认返回；
- 「兜底响应」是规则全不命中时的最后一道，和规则列表分开配。

界面上的 `R1 / R2 / R3` 徽标就是匹配顺序，日志里显示的是同一种徽标——一次请求走的哪条规则，两边一对就出来了。

---

## 八、条件怎么配 <!-- sec:conditions -->

一条条件 = **取值来源 + 路径 + 操作符 + 比较值**。界面上是四个下拉/输入框，不用写代码。

### 取值来源

| 来源 | 说明 | 路径示例 |
| --- | --- | --- |
| 请求体 | JSON 请求体，按字段取值 | `code`、`items[*].code`、`data.list[0].code` |
| URL 参数 | `?a=1&b=2` 里的参数 | `method` |
| 请求头 | 请求头，字段名小写 | `x-mock-case`、`content-type` |
| 原始文本 | 不解析，直接拿整个请求体做文本比较 | （不用填路径） |

路径支持：

- `a.b.c` —— 逐层取；
- `a[0].b` —— 数组下标；
- `a[*].b` —— **数组通配，任一元素命中即算命中**（最适合 `items[*].code` 这种场景）。

### 操作符

| 分组 | 操作符 | 说明 |
| --- | --- | --- |
| 等值 | `=` `≠` | 两边都能转数字时按数值比，否则按字符串比 |
| 文本 | 包含 / 不包含 / 前缀 / 后缀 / 正则匹配 | 正则用 `new RegExp(值)` |
| 集合 | 属于 / 不属于 | 值填 `A,B,C`，逗号分隔 |
| 数值 | `>` `≥` `<` `≤` | 按数字比较 |
| 存在性 | 存在 / 不存在 / 为空 / 非空 | 不需要填比较值 |

多条条件之间的关系由「**全部满足 / 任一满足**」决定。

### 返回响应

| 项 | 说明 |
| --- | --- |
| HTTP 状态 | 任意状态码，测试异常分支时用（500 / 502 / 404…） |
| 延迟 | 毫秒，测超时、加载中、重试用。**单个请求最多挂起 30 秒**，填更大按 30 秒算（`MOCK_MAX_DELAY_MS` 可调） |
| Content-Type | 默认 `application/json;charset=UTF-8` |
| 返回方式 | **静态文本** 或 **脚本生成** |

> 延迟与故障注入的 `timeout` 都要占住连接。同时挂住的请求超过 50 个时，多出来的直接返回
> **503**（不排队，消息里写明原因），免得挂满文件描述符把管理界面一起拖死；上限可用
> `MOCK_MAX_HELD_REQUESTS` 调整。

> 请求日志里存的是 body 的**副本**，单条最多留 **100KB**：超出后正文只保留前 100KB 并在末尾
> 标注原文大小，日志条目上也会带 `reqBodyTruncated` / `respBodyTruncated`（`{kept, total}`），
> 抽屉里会显式提示「你看到的是半份」。**回给调用方的响应体始终是完整的** —— 截断只作用于日志，
> 代理透传不受影响。上限用 `MOCK_LOG_BODY_LIMIT` 调（单位字节，填 0 关闭截断）。

**静态文本**支持变量替换：

| 变量 | 含义 |
| --- | --- |
| `{{body.字段}}` | 取请求体字段（支持 `{{body.data.list[0].code}}`） |
| `{{query.参数}}` | 取 URL 参数 |
| `{{header.名字}}` | 取请求头 |
| `{{vars.名字}}` | 取接口级配置里的变量（见下） |
| `{{now}}` `{{ts}}` `{{uuid}}` `{{random}}` | 当前时间 / 时间戳 / UUID / 随机数 |

**脚本生成**适合「按请求里的数组，逐项生成不同返回」这类场景。可访问
`ctx.body` / `ctx.query` / `ctx.headers` / `ctx.vars` 和 `helpers`，`return` 一个对象或字符串：

```js
// ctx.body：请求体；ctx.vars：本接口配置变量
const code = ctx.body.code || 'default';
return {
  code: 0,
  message: 'ok',
  data: {
    requestCode: code,
    echo: ctx.body
  }
};
```

脚本抛错时返回 500，错误信息直接写在响应里，方便定位。

脚本在 vm 沙箱里同步执行：默认 1 秒超时、64KB 长度上限（`MOCK_SCRIPT_TIMEOUT_MS` / `MOCK_SCRIPT_MAX_LEN` 可调），死循环或超大脚本会直接返回 500，不再卡住整个服务。

### 接口级变量

接口配置里的 `vars` 是给规则复用的数据，典型用法是放一张「键 → 值」的表，再在脚本里按请求内容查表。界面暂不提供 vars 编辑器，直接改 `config.json` 即可。

### 代理透传

接口上可以开代理并填真实服务地址，开之后该接口的请求**全部原样转发**，不再走规则。适合「大部分接口要真实返回，个别接口要挡板」的联调场景。

**回源路径怎么拼**：

```
代理地址填：  http://<真实服务根地址>        ← 真实服务的根地址
接口配：      模块 demo  +   接口路径 query
上游收到：    http://<真实服务根地址>/query
                                       ^^^^^
                                       只有「接口路径」，模块名不带去上游
```

模块名只用于挡板自己的入口匹配（`/{模块}/{接口}`），上游一般没有这一段。上游确实需要带模块时，把模块写进代理地址即可：`http://host/demo`。

---

## 九、管理面板使用 <!-- sec:console -->

左侧是接口列表（按分组归拢），中间是规则编排，右侧是实时日志，三栏一条线：

1. **建分组** → 左侧「+ 分组」，填个名字（如「示例接口」）。分组只影响左侧列表的归类，**不影响调用路径**。
2. **新增接口** → 「+ 接口」，填名称、模块、接口路径，下方的「调用地址」会实时预览，直接复制给被测系统。
3. **配规则** → 「+ 新增规则」，条件用下拉框拼；改完保存即生效。
4. **调顺序** → 每条规则右侧的 ↑ ↓；规则是**按顺序命中即停**，宽泛的规则放上面会吃掉后面所有规则。
5. **试打一枪** → 中间的输入框填请求体/参数/请求头，点「发送」，**不经过网络**，直接按当前规则判定；右侧会列出每条规则命中还是跳过、原因是什么，命中那条高亮，并给出会返回的内容。试打同样会记一条带「试打」标签的日志方便对照。
6. **看日志** → 右侧每 3 秒自动刷新，点任意一条展开请求体与返回体；点它的规则徽标，中间列表会滚动到对应规则并高亮。

左侧分组的折叠状态、以及主题选择都会记在浏览器本地，刷新后保持原样。

### 分组维护

| 动作 | 位置 |
| --- | --- |
| 新建分组 | 左侧栏「+ 分组」 |
| 重命名 / 删除分组 | 分组标题右侧的 ✎ / ✕（删除分组不会删组内接口，接口会落到「未分组」） |
| 折叠 / 展开分组 | 分组标题左侧的 ▾ / ▸ |
| 把接口挪到别的分组 | 打开该接口的「编辑接口」，改「所属分组」 |

「未分组」是兜底用的伪分组：`groupId` 为空、或指向一个已经被删掉的分组，都会落到这里，它本身不能改名或删除。

### 主题

顶栏右上角的 **自动 / 暗 / 浅** 三选一，纯 CSS 变量切换，不刷新页面：

- **暗**（默认）：暖黑工业风，长时间盯着不刺眼；
- **浅**：暖白底 + 白卡片，投屏、截图进文档更清楚；
- **自动**：跟随操作系统的深浅色设置。

顶栏另外三个动作：**重新读取配置**（手改了 `config.json` 后用）、**导出**、**导入**（备份/迁移配置）。

### 只读分享链接（给同事看规则）

顶栏 **分享图标** → 「生成分享链接」。每条链接左侧是**复制图标**（悬停显示"复制链接"，点击即复制），右侧可随时**撤销**：

- 对方打开链接只能查看规则，**改不了配置**（服务端同步兜底拦截写请求）；
- 链接被撤销后，对方打开会看到「分享链接已失效」提示页，不会降级为可编辑视图；
- 部署时配置 `READONLY_PORT`（只读隔离端口）后，分享链接走独立端口——**对方把 URL 上的 `?share=` 去掉，不只是只读，连配置都拿不到**（该端口除 `/_admin/auth` 外都要求带令牌，由服务端拦截）。免密部署必须配置它才允许生成分享链接（否则界面上点「生成」返回 403）。
- 一键部署直接带上它即可：`./deploy.sh <user>@<HOST_IP> -r 18081`（详见 5.2）。链接形如 `http://<HOST_IP>:18081/?share=shr-xxxx`；只读端口上 `/login` 被禁、写操作一律 403。
- 只读身份（分享链接或只读端口）能看的只有规则本身：`/_admin/config` 会剥掉 `users`、`shareTokens`，令牌清单 `/_admin/share` 只对可编辑身份开放——拿到一条分享链接不等于拿到全部链接和别人账号的哈希。

![分享链接弹窗](docs/shot-share.png)

### 登录与用户管理

| 事项 | 说明 |
| --- | --- |
| 开启登录 | 部署时设 `MOCK_ADMIN_PASS`（用户名默认 `admin`，`MOCK_ADMIN_USER` 可改） |
| 部署管理员 | 环境变量账号，可增删改普通用户 |
| 普通用户 | 存 `config.json` 的 `users`（SHA-256 哈希，无明文）；登录后点头像 → Users 管理 |
| 免密部署 | 不设 `MOCK_ADMIN_PASS` 且 `users` 为空时面板开放，无登录 |
| 调用挡板接口 | **不受登录影响**，被测系统无需任何凭据 |

### 界面帮助（❓ 图标）

顶栏分享图标旁的 **❓** 会在新标签页打开网页版操作手册（`public/help.html`）：面向测试 / 联调同事的图文上手指南——快速上手、界面导览、配规则、试打、日志、分享链接、FAQ，单文件零依赖，只读分享视图下同样可见。

---

## 十、管理接口（脚本化调用） <!-- sec:admin-api -->

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/_admin/health` | 健康检查（接口数、分组数、规则数、运行时长） |
| GET | `/_admin/auth` | 认证状态（是否需要登录、是否只读分享、分享令牌是否失效） |
| POST | `/_admin/login` | 登录（body：`{username, password}`，返回会话 token） |
| GET | `/_admin/config` | 读全量配置（含 `groups`；**不下发 `users` / `shareTokens`**，只读身份也拿不到） |
| POST | `/_admin/config` | 保存全量配置（body 就是配置 JSON；`users` / `shareTokens` 由服务端保留，body 里没有也不会丢） |
| POST | `/_admin/reload` | 从磁盘重新读取 `config.json` |
| GET / POST / DELETE | `/_admin/share` | 只读分享链接：列出 / 生成 / 撤销（`?token=`；**列出仅限可编辑身份**，只读分享令牌与只读端口调它返回 403） |
| GET / POST / DELETE | `/_admin/users` | 登录用户管理（仅部署管理员） |
| GET | `/_admin/logs?limit=50` | 最近请求日志 |
| POST | `/_admin/logs/clear` | 清空日志 |
| POST | `/_admin/test` | 试打一枪（body：`{apiId, raw, body, query, headers}`，会记一条带「试打」标签的日志） |

> 除 `health` / `auth` / `login` 外，其余接口均需 `Authorization: Bearer <token>`（登录会话或分享令牌）。登录只保护 Web 管理界面与这些管理接口；直接调用 mock 接口（如 `/demo/...`）完全不受影响。

---

## 十一、从老 mock 平台导入 <!-- sec:import-legacy -->

若团队此前在用另一套「一份写死的返回」类 mock 平台（如 `http://<LEGACY_MOCK_HOST>:8084/mock/mock.html`），上面的接口可直接搬过来，不用手动重新录：

```bash
node tools/import-legacy.js --dry-run                              # 先看会导入什么，不写文件
node tools/import-legacy.js                                        # 真导入（默认源见脚本常量）
node tools/import-legacy.js --from http://<LEGACY_MOCK_HOST>:8084/mock/admin/list
node tools/import-legacy.js --from /tmp/mocklist.json              # 也支持本地 JSON 文件
node tools/import-legacy.js --prune                                # 顺带清掉"老平台上已删除"的接口
```

**老记录 → 本挡板的对应关系**

| 老平台字段 | 落到哪里 |
| --- | --- |
| `module` + `path` | `apis[].module` + `apis[].path`（拼出的完整路径与老平台完全一致） |
| 第一段 `module` | 一个**分组**（老平台的"模块"就是分组维度） |
| `enableProxy` + `proxyUrl` | `proxy.enable` + `proxy.url` |
| `response` | **兜底返回**（`defaultResponse.body`） |

两点设计说明：

1. **老响应体放「兜底返回」而不是"一条恒命中的规则"**。兜底返回本来就是"没有规则命中时返回什么"，语义正好对应老平台那份写死的响应；代理开着时它不参与，代理一关立刻生效，再往上加规则就能把它升级成动态挡板。
2. **`enableProxy=true` 但地址是占位符（`xxx`、`test`）的，一律关掉代理**。这类开着代理只会把请求打飞，改为直接返回记录的响应，导入时会列出来提醒。

**幂等**：接口 id 由路径推导（`legacy-xxx` 这种），重复执行是"更新"而不是"再来一份"，过渡期可以隔几天再同步一次。

导入完成后，正在跑的服务点界面上的「重新读取配置」即可，不用重启。

---

## 十二、维护者信息（联系方式） <!-- sec:maintainer -->

| 项目 | 值 |
| --- | --- |
| 仓库 | <https://github.com/LeeJiEunm/mock-server> |
| 作者 | LeeJiEunm |
| 问题反馈 | <https://github.com/LeeJiEunm/mock-server/issues> |

控制台顶栏有两个对外入口，取值全部来自 `config.json` 顶层的 `meta` 字段，**不写死在代码里**：

| 顶栏按钮 | 取自 | 说明 |
| --- | --- | --- |
| 联系维护者（✉） | `meta.contactEmail` / `meta.contactLabel` | 弹窗展示邮箱，可一键复制 |
| GitHub（仓库图标） | `meta.repoUrl` / `meta.repoLabel` | 点击在新标签页打开仓库；**没配则弹「仓库地址待配置」提示，不会跳转** |

```json
{
  "meta": {
    "contactEmail": "maintainer@example.com",
    "contactLabel": "维护者",
    "repoUrl": "https://github.com/LeeJiEunm/mock-server",
    "repoLabel": "mock-server"
  }
}
```

- 改这一处即可，不必改动任何源码；保存后控制台自动读取（或点面板里的「重新读取」/重启服务）。
- 仓库地址只接受 `http(s)://`（配置是外部可编辑的，避免 `javascript:` 之类的值被 `window.open` 执行）。
- **真实邮箱部署时再填**，不要在仓库里改（否则会随 git 提交出去）；仓库地址是公开信息，工程内直接带真值：
  直接改远端 `<安装目录>/config.json` 的 `meta.*`，命令见 5.2 末的「部署后设置维护者信息」。
- 他人克隆本项目后同理，只需改自己那份 `config.json`。

---

## 十三、目录结构 <!-- sec:dir-layout -->

```
mock-server/
├── server.js              # 服务本体（零依赖）
├── config.example.json    # 示例配置（**入库**）：首次启动没有 config.json 时自动复制它
├── config.json            # 接口与规则配置（唯一数据源；运行数据，**不入库**）
├── public/
│   ├── index.html         # 控制台页面（CSS/JS 全用相对路径）
│   ├── help.html          # 网页版操作手册（顶栏 ❓ 打开；单文件自带样式，无依赖）
│   ├── help/              # 手册内嵌截图（shot-console / shot-share；.en.png 为英文版）
│   ├── styles/
│   │   ├── tokens.css     # 设计令牌：颜色、字阶、间距、主题（暗/浅）
│   │   ├── base.css       # 重置、排版、焦点、氛围层、动效降级
│   │   └── components.css # 组件与布局
│   ├── scripts/           # 控制台逻辑（原生 JS，无框架、无构建；按功能拆成多个文件，
│   │   │                  # 由 index.html 按序加载、共享同一全局作用域，顺序不可随意调整）
│   │   ├── i18n.js        # 中英文案与多语言渲染
│   │   ├── state.js       # 全局状态、常量、本地偏好读写
│   │   ├── core.js        # 小工具、示例配置与接口模板、配置读写
│   │   ├── theme.js       # 主题与侧栏折叠
│   │   ├── auth.js        # 登录态、只读分享、分享链接、用户菜单
│   │   ├── api-list.js    # 顶栏统计、左侧接口列表与定位
│   │   ├── groups.js      # 通用弹窗与分组维护
│   │   ├── workspace.js   # 工作区与只读详情
│   │   ├── try-logs.js    # 试打一枪、变更记录、请求日志
│   │   ├── drawer.js      # 接口 / 规则抽屉
│   │   └── app.js         # 渲染总入口、事件绑定、批量选择、启动
│   └── sample-config.json # 仅供"离线预览"用的示例配置，服务端运行时不读它
├── docs/
│   ├── 操作手册.md         # 任务导向速查手册（面向测试 / 联调同事）
│   └── shot-*.png         # README 与手册用的界面截图（shot-*.en.png 为英文版）
├── tools/                 # 辅助脚本，不参与部署（server.js 在远端独立运行，不 require 它们）
│   ├── lib/config.js      # 工具共用：定位配置文件 + 缺 config.json 时从示例生成
│   ├── lib/cdp.js         # 工具共用：起无头 Chrome / 连调试端口 / 截图 / 采集页面 JS 报错
│   ├── lib/sandbox.js     # 工具共用：在临时目录搭一份隔离副本跑自检（不碰仓库里的 config.json）
│   ├── import-legacy.js   # 从老 mock 平台导入接口（幂等，可重复跑）
│   ├── add-user.js        # 增删改控制台登录用户（写 config.json 的 users）
│   ├── gen-pass.js        # 生成密码的 scrypt 哈希（每用户随机 salt，格式 scrypt:<salt>:<derived>）
│   ├── verify-ui.js       # 真浏览器自检：试打反馈 / 主题 / 字阶 / 对比度 / 窄屏输入框
│   ├── verify-login.js    # 真浏览器自检：登录文案 / 输入不被清空 / 登录边界（mock 免登录）
│   ├── verify-docs.js     # 中英文档对齐自检：两份 README 的章节标记必须一致
│   ├── verify-server-basics.js # 服务端基础自检：缺/坏 config.json 的启动行为、静态目录穿越守卫
│   ├── verify-auth-security.js # 鉴权自检：登录边界 / 只读分享令牌 / 会话
│   ├── verify-mock-limits.js   # 限额自检：请求体大小、规则条数等上限真的生效
│   ├── verify-console-boot.js  # 真浏览器自检：脚本装配 + 启动零报错 + 跨文件调用 + 交互与切语言
│   └── verify-deploy.sh  # 部署脚本本地沙盘自检：假 ssh，断言只读端口等参数真的落到远端配置
├── package.json           # 工程元数据（name=mock-server / 仓库地址 / 作者 / npm start）
├── .gitignore             # 忽略日志、备份、临时文件、config.json（运行数据不入库，见文件头说明）
├── Dockerfile
├── docker-compose.yml
├── mock-server.service    # systemd 单元模板（deploy.sh 会按实际路径生成正式那份）
├── deploy.sh              # 一键部署：端口/目录/只读端口可指定，node 路径自动探测
├── README.md
└── README.en.md           # 英文版说明
```

> **仓库内所有环境相关信息均为脱敏占位值**：主机地址一律 `<HOST_IP>`，端口只在示例里用默认的 `18080` / `18081`，联系邮箱用 `maintainer@example.com`。
> `tools/` 里含 `REPLACE_WITH_YOUR_SHARE_TOKEN` 的探针脚本是**公开版本**，运行前先换成自己的分享令牌与地址（真实令牌、内网 IP、个人邮箱都不入库）。

---

## 十四、排版与配色（设计取向） <!-- sec:typography -->

界面走「**工业实用**」方向：等宽数字、发丝边框、高密度信息、单一琥珀强调色。

- 字阶 6 档（`--text-xs` 12px → `--text-xl` 32px），相邻档差 ≥ 1.17，保证肉眼分得开。
- 字重补中间档（`--fw-normal` 400 / `--fw-medium` 500 / `--fw-bold` 700），高密度界面靠字重 + 字号拉层级。
- 对比度按最坏的底实测（`--color-faint` 对 `surface-3` ≥ 4.5:1）。
- 组件层不出现硬编码色值，全部走 `var(--color-*)`，切主题不会花。

这些不是靠眼睛看，都有断言守着（见 `tools/verify-ui.js`）。

登录这块同理，单独一个真实浏览器自检（**先起一个开了登录的服务**再跑）：

```bash
MOCK_ADMIN_USER=admin MOCK_ADMIN_PASS=admin123 PORT=18080 node server.js   # 另开一个终端
node tools/verify-login.js http://127.0.0.1:18080/ admin admin123
```

它断言 30 项：中英文登录文案（防止界面直接显示 `login.username` 这种原始 key）、输入过程中不被清空 / 焦点不被抢走、密码错的中文提示与「只清密码保留用户名」、登录后能进控制台、以及 mock 接口免登录照样 200。

这些自检可以一次跑完（各自搭沙盘、不碰仓库里的 `config.json`，也不用事先起服务）：

```bash
npm run verify:all      # docs → auth → limits → basics → console
```

其中 `verify:console` 是**拆前端脚本后新增**的：它断言 `index.html` 的脚本清单与磁盘文件完全一致（拆完最容易漏加/多加一个文件）、启动过程零 JS 错误、分布在各个拆出文件里的渲染函数跨文件都调得到、以及点接口 / 开抽屉 / 切语言的行为没变。这几处服务端自检完全看不见，只有真浏览器能守住。

---

> **文档对齐**：本文件与 `README.en.md` 的章节标记由 `tools/verify-docs.js` 守护，修改任一份后请运行它确认两份结构一致。
