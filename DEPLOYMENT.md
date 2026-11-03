# SpeakMate 部署指南

> 面向个人自部署的两种方案：**A. 局域网自托管**（电脑 + 手机同 WiFi，LLM 可用本地 LMStudio，数据零上云）与 **B. 云服务器**（域名 + VPS，云端 LLM）。两者共用同一套代码与构建流程，区别只在证书、进程管理与 LLM 接入。
>
> 前置阅读：[README.md](README.md)（快速启动）· [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §11（部署方案概要）

## 0. 部署形态总览与通用准备

**形态**：单 Node 进程（Express）+ 单 SQLite 文件。生产模式下 Express 直接托管 `frontend/dist` 静态文件，前后端同源，**一个端口（默认 3001）即是全部**——无需独立前端服务器，无 CORS。

| | 方案A 局域网自托管 | 方案B 云服务器 | 方案C WSL2 |
|---|---|---|---|
| 适用 | 家庭/办公室 WiFi，数据不出内网 | 有域名，随时随地访问 | Windows 上想要 Linux 运行时（与生产环境一致） |
| LLM | 本地 LMStudio（或云 Key） | 云端 provider（DeepSeek / 通义 / OpenAI） | 本地 LMStudio（走宿主机 IP）或云 Key |
| HTTPS | mkcert 自签证书（后端内置 HTTPS 支持） | Let's Encrypt（certbot） | mkcert（证书在 Windows 生成，WSL 引用） |
| 反代 | 无（直连后端 HTTPS 端口） | Nginx | 无，但**局域网访问需配 Windows 端口转发** |
| 进程管理 | 手动 / 计划任务 | pm2 | systemd（WSL2 可开启）或 nohup |

**为什么语音功能必须 HTTPS**：Web Speech API 的麦克风权限属于「安全上下文（Secure Context）」能力。`localhost` 与 `https://` 是安全上下文，而手机访问 `http://192.168.x.x:3001` **不是**——应用会自动降级为文字输入模式。因此方案A 的核心步骤就是给局域网访问配一张手机浏览器能接受的证书。

### 通用构建步骤（两方案相同）

环境要求：Node.js ≥ 18.17（推荐 20 LTS）、pnpm ≥ 8。

```bash
# 1. 获取代码（git clone 或直接复制项目目录）
cd english-tutor

# 2. 构建前端产物（frontend/dist）
cd frontend
pnpm install
pnpm build

# 3. 安装后端依赖
cd ../backend
pnpm install

# 4. 配置环境变量（LLM 见下文各方案；模板含全部注释）
cp .env.example .env

# 5. 启动（先做一次 HTTP 冒烟）
pnpm start
# 验证：curl http://localhost:3001/api/health → {"code":0,...}
```

---

## 方案A 局域网自托管（Windows / WSL + LMStudio）

拓扑：`手机 --(HTTPS:3443)--> Node 后端 --(HTTP:1234)--> LMStudio（仅监听本机）`

### A1. LMStudio 准备（可选，用云端 Key 可跳过）

1. 打开 LMStudio，加载模型（如 `qwen3.6-35b-a3b`，以本机实际加载为准）；
2. 进入 **Developer / Local Server** → **Start Server**（默认端口 `1234`）；
3. 验证端点与**模型标识名**（写入 `.env` 的 `LLM_MODEL` 用）：
   ```bash
   curl http://localhost:1234/v1/models
   ```

### A2. 后端 `.env` 配置（LMStudio 示例）

```env
LLM_PROVIDER=lmstudio
LLM_BASE_URL=http://localhost:1234/v1
LLM_MODEL=qwen3.6-35b-a3b
LLM_API_KEY=lm-studio
```

> LMStudio 只监听本机 127.0.0.1，局域网设备无法直连——LLM 请求全部由后端代理（架构 P0-11），这正是设计意图。若用云端 provider，改 `LLM_PROVIDER/LLM_API_KEY` 即可（见 README「LLM 配置」表）。

### A3. mkcert 生成局域网证书

**第 1 步：查出电脑的局域网 IP**

```powershell
# Windows（PowerShell / CMD）
ipconfig        # 记下「无线局域网适配器 WLAN」下的 IPv4 地址，如 192.168.1.100
```

```bash
# WSL / Linux
hostname -I     # 第一个地址通常是局域网 IP
```

> 以下命令中的 `192.168.1.100` 请替换为你的实际 IP。路由器若开启 DHCP 动态分配，建议同时在路由器为电脑绑定静态 IP，避免换 IP 后证书失效。

**第 2 步：安装 mkcert 并生成证书**

```powershell
# Windows（管理员 PowerShell，二选一的安装方式）
choco install mkcert          # Chocolatey
# scoop install mkcert        # 或 Scoop
mkcert -install               # 把本地根 CA 装入 Windows 证书库（本机浏览器信任）
```

```bash
# WSL / Linux
sudo apt update && sudo apt install -y mkcert libnss3-tools
mkcert -install
```

**第 3 步：签发证书（含局域网 IP + localhost，目录为 backend/certs）**

```bash
cd english-tutor/backend
mkdir certs
mkcert -cert-file certs/speakmate-cert.pem -key-file certs/speakmate-key.pem 192.168.1.100 localhost 127.0.0.1
```

> 证书必须覆盖**手机实际访问的 IP**：换 IP 后需重新签发。`backend/certs/` 已被 `.gitignore` 排除（若未排除请自行加入，私钥不入库）。

### A4. 启用后端 HTTPS

在 `backend/.env` 追加（后端已内置支持，见 `src/index.ts`）：

```env
HTTPS_KEY_FILE=./certs/speakmate-key.pem
HTTPS_CERT_FILE=./certs/speakmate-cert.pem
HTTPS_PORT=3443
```

启动后日志会多出两行：

```text
[SpeakMate] backend is running at http://localhost:3001
[SpeakMate] https is running at https://<本机IP>:3443
  手机（同局域网）请访问上述 HTTPS 地址——麦克风语音识别需要安全上下文
```

> HTTP(3001) 与 HTTPS(3443) 并存：本机调试/脚本走 HTTP，手机走 HTTPS。证书文件缺失时后端会打警告并跳过 HTTPS，不会启动失败。

### A5. 防火墙放行（手机可达）

```powershell
# Windows（管理员 PowerShell）：放行 3443
netsh advfirewall firewall add rule name="SpeakMate HTTPS" dir=in action=allow protocol=TCP localport=3443
```

```bash
# Linux 原生 / 部分云主机
sudo ufw allow 3443/tcp
```

**WSL2 用户特别注意**：WSL2 是虚拟网络，手机默认访问不到。三选一：
1. **最简单**：直接在 Windows 侧安装 Node 跑后端（本文档全部命令通用）；
2. Windows 端口转发（管理员 PowerShell，`<WSL_IP>` 用 `hostname -I` 查）：
   ```powershell
   netsh interface portproxy add v4tov4 listenport=3443 listenaddress=0.0.0.0 connectport=3443 connectaddress=<WSL_IP>
   netsh advfirewall firewall add rule name="SpeakMate HTTPS" dir=in action=allow protocol=TCP localport=3443
   ```
3. Windows 11 22H2+ 可在 `%UserProfile%\.wslconfig` 启用 `networkingMode=mirrored`（`wsl --shutdown` 后生效），WSL 端口直接对外。

### A6. 手机访问与验证清单

手机连接**同一 WiFi**，浏览器打开 `https://192.168.1.100:3443`：

- [ ] 首次访问会出现「证书不受信任」警告——点「高级 → 继续访问」即可正常使用（自签证书的预期行为）；
- [ ] 想消除警告（可选）：把 mkcert 根 CA（`mkcert -CAROOT` 命令可查路径，文件为 `rootCA.pem`）传到手机安装——Android：设置 → 安全 → 加密与凭据 → 安装证书 → CA 证书；iOS：下载描述文件后在「设置 → 通用 → 关于本机 → 证书信任设置」中启用；
- [ ] 设置页「LLM 服务」显示 `LMStudio（本地）` 与正确模型名；
- [ ] 对话页按住说话弹出麦克风授权，语音转写正常（安全上下文生效的标志）；
- [ ] `curl -k https://localhost:3443/api/health` 返回 `{"code":0,...}`。

### A7. 日常启动

```bash
cd english-tutor/backend
pnpm start       # 前端 dist 已构建，手机直接访问 https://<IP>:3443
```

---

## 方案B 云服务器（pm2 + Nginx + Let's Encrypt）

拓扑：`手机 --(HTTPS:443)--> Nginx --(HTTP)--> Node(127.0.0.1:3001) --> 云端 LLM`

### B1. 服务器准备（Ubuntu 22.04+ 示例）

```bash
# Node.js 20 LTS（NodeSource）
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v        # v20.x

# pnpm（corepack，Node 自带）
sudo corepack enable
corepack prepare pnpm@latest --activate
pnpm -v

# Nginx + certbot
sudo apt install -y nginx certbot python3-certbot-nginx
```

DNS：为域名（如 `speakmate.example.com`）添加 A 记录指向服务器公网 IP。

### B2. 部署代码与构建

```bash
sudo mkdir -p /opt/speakmate && sudo chown -R $USER:$USER /opt/speakmate
cd /opt/speakmate
git clone <你的仓库地址> .          # 或用 scp/rsync 上传项目目录

cd frontend
pnpm install
pnpm build                          # 产出 dist/

cd ../backend
pnpm install
```

### B3. 配置 `.env`（云端 LLM）

```bash
cd /opt/speakmate/backend
cp .env.example .env
nano .env
```

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxx
LLM_MODEL=deepseek-chat
```

```bash
chmod 600 .env      # Key 仅属主可读（P0-11：绝不入库、绝不出现在日志/响应）
```

### B4. pm2 进程管理

```bash
sudo npm install -g pm2
cd /opt/speakmate/backend

pm2 start pnpm --name speakmate -- start      # 等价于 pnpm start（tsx src/index.ts）
pm2 save                                       # 保存进程列表
pm2 startup                                    # 按提示复制执行输出的 sudo 命令（开机自启）

# 验证
curl http://127.0.0.1:3001/api/health          # {"code":0,...}
pm2 logs speakmate --lines 50                  # 看启动横幅（LLM provider / data dir）
```

常用命令：`pm2 status` / `pm2 restart speakmate` / `pm2 logs speakmate` / `pm2 delete speakmate`。
> 备选：若不想装 pm2，也可写 systemd unit（`ExecStart=/usr/bin/env pnpm start`，`WorkingDirectory=/opt/speakmate/backend`）——二选一即可，本文以 pm2 为准。

### B5. Nginx 反向代理（SSE 关键配置）

```bash
sudo nano /etc/nginx/sites-available/speakmate
```

```nginx
server {
    listen 80;
    server_name speakmate.example.com;

    # 统一反代到 Node（Node 同源托管前端 dist 与 /api）
    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # ---- SSE 流式对话（POST /api/chat）必需：关闭代理缓冲，否则逐字渲染变整段憋出 ----
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # 请求体上限（后端 express.json 限 1mb，此处留余量）
    client_max_body_size 2m;
}
```

```bash
sudo ln -s /etc/nginx/sites-available/speakmate /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

> 后端 `/api/chat` 响应头已自带 `X-Accel-Buffering: no`（Nginx 感知），上方的 `proxy_buffering off` 是双保险。
>
> 可选优化（静态文件由 Nginx 直供，`/api` 才走 Node）：把 `location /` 拆成
> `location /api/ { …同上 proxy 配置… }` 与 `location / { root /opt/speakmate/frontend/dist; try_files $uri /index.html; }`。首次部署不建议，保持最简形态排障更容易。

### B6. Let's Encrypt 证书（certbot）

```bash
sudo certbot --nginx -d speakmate.example.com
# 交互中选择重定向 HTTP → HTTPS（推荐）。certbot 自动改写 nginx 配置并加载证书。
```

自动续期由 systemd 定时器完成，验证：

```bash
sudo systemctl list-timers | grep certbot
sudo certbot renew --dry-run
```

### B7. 防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'      # 80 + 443
sudo ufw enable
```

### B8. 上线验证清单

- [ ] `https://speakmate.example.com` 打开正常，地址栏为锁形图标；
- [ ] 设置页「LLM 服务」显示所选 provider 与模型；
- [ ] 对话页发一条消息，回复**逐字流式**出现（若整段一次性出现 → 检查 B5 的 `proxy_buffering off`）；
- [ ] 手机浏览器麦克风授权正常（HTTPS 安全上下文）；
- [ ] 已配置 `ACCESS_TOKEN` 并在前端「设置 → 访问令牌」录入（公网部署必做，见下节）；
- [ ] `pm2 restart speakmate` 后页面仍可访问（进程守护生效）；
- [ ] 服务器重启后自动恢复（`pm2 startup` 生效）。

---

## 方案C 在 WSL2 中运行（Linux 运行时）

**什么时候选它**：你在 Windows 上开发，但希望运行环境与线上 Linux 一致（原生模块、文件锁、信号处理、systemd 行为都对齐），或方案A 的 Windows 直连方式遇到了环境差异问题。

**最重要的三条结论（先记住，能省两小时）**：

1. **代码必须放在 Linux 原生文件系统**（如 `~/workspace`），**不要**放 `/mnt/d/...`——跨文件系统 IO 慢一个数量级，且 SQLite 在 Windows 文件系统上的锁行为不可靠。
2. **局域网设备（手机）无法直接访问 WSL 的服务**——WSL2 在 Hyper-V NAT 之后，有自己的内网 IP。必须在 Windows 上做 `netsh portproxy` 端口转发。
3. **WSL 里的 `localhost` 不是 Windows 的 `localhost`**——要访问 Windows 上跑的 LMStudio，得用宿主机 IP。

### C1. 环境准备（只需一次）

在 WSL 的 bash 里执行：

```bash
# 1) 确认发行版与版本
cat /etc/os-release | head -2

# 2) Node.js 20 LTS（推荐 nvm，便于多版本切换）
curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
exec $SHELL
nvm install 20
node -v          # 需 >= 18.17

# 3) pnpm（Node 20 自带 corepack）
corepack enable
corepack prepare pnpm@latest --activate
pnpm -v

# 4) 原生模块构建工具（better-sqlite3 无预编译包时需要）
sudo apt update && sudo apt install -y build-essential python3 git curl
```

> **pnpm 只装一个版本，不要混装。** pnpm 9 / 10 / 11 的 store 目录互不兼容（分别是 `v3` / `v10` / `v11`）。同一项目被两个版本的 pnpm 装过后，再切回另一个就会报 `ERR_PNPM_UNEXPECTED_STORE`。装之前先 `which -a pnpm` 看一眼；如果环境里已经有了，**不要**为了对齐文档再去装一个旧版本。

> **在脚本里调 pnpm 容易"找不到"**：官方安装脚本把 pnpm 放在 `~/.local/share/pnpm/bin`，并把 PATH 写进 `~/.bashrc`。而 `wsl.exe bash script.sh` 这类**非交互 shell 不加载 `~/.bashrc`**，于是出现"终端里有 pnpm、脚本里 `command not found`"。脚本里用 `bash -lc 'command -v pnpm'` 解析最贴近用户真实环境。

> 若 `apt` 很慢，先换国内镜像源。另注意：**Node 24 目前没有 `better-sqlite3` 的预编译包**，会回退到 node-gyp 源码编译（约 3–5 分钟）。日志里出现 `No prebuilt binaries found` 是正常提示，不是错误。

### C1.5 pnpm 构建白名单（pnpm 10+ 必读）

从 pnpm 10 起，依赖的安装脚本**默认被拦截**，`better-sqlite3` 的原生模块不会编译——装完看起来一切正常，跑起来才报 `Could not locate the bindings file`。

本仓库已在 `backend/` 与 `frontend/` 各放了一份 `pnpm-workspace.yaml` 声明放行名单，正常情况下**无需额外操作**：

```yaml
packages:
  - '.'

allowBuilds:
  better-sqlite3: true
  esbuild: true

onlyBuiltDependencies:      # pnpm 10 及更早的键名，保留兼容
  - better-sqlite3
  - esbuild
```

三个字段各有讲究，缺一个都会出事：

| 字段 | 缺了会怎样 |
|---|---|
| `packages` | 仓库根 `package.json` 声明了 npm `workspaces`，pnpm 会向上回溯、认定仓库根才是 workspace 根，于是在 `backend/` 下**任何 pnpm 命令都失败**，报 `ERROR packages field missing or empty`（pnpm 9） |
| `allowBuilds` | **pnpm 11 的键名**（值必须是显式 `true`/`false`，不是数组）。缺失时 pnpm 会生成一个待填写模板 `allowBuilds: <pkg>: set this to true or false`，构建继续被拦截 |
| `onlyBuiltDependencies` | pnpm 10 及更早的键名（数组）。只写它而漏掉 `allowBuilds`，pnpm 11 仍会追加待填写模板 |

> **⚠️ pnpm 11 的 `pnpm start` 会先自动跑一次 `pnpm install`**（内部的 `runDepsStatusCheck`）。所以构建被拦截时，报错不会出现在 install 阶段，而是延迟到你执行 `pnpm start` 时才爆发，形态是：
>
> ```
> [ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: better-sqlite3@11.10.0, esbuild@0.21.5, esbuild@0.28.2
> [ERROR] Command failed with exit code 1: '@pnpm/exe/pnpm' install
> ```
>
> 看起来像 `pnpm start` 坏了，其实病根在依赖构建被拦截。**`packages field missing or empty` 则是 pnpm 9 遇到同样残缺配置时的报错形态**——同一个根因，不同 pnpm 版本表现不同。

**如果已经中招**（目录下出现了内容为 `allowBuilds: ... set this to true or false` 的 `pnpm-workspace.yaml`）：

```bash
cd ~/workspace/speakmate/backend
rm -f pnpm-workspace.yaml     # 先删掉这个半成品模板
pnpm install                  # 重装；若从 git 取的码，先 git checkout 恢复仓库里的正确版本
find node_modules/.pnpm -name better_sqlite3.node   # 确认原生模块已编译
```

不想改文件的应急办法：`pnpm approve-builds --all`（一次性放行所有待批准的依赖）。

### C1.6 pnpm 11 的供应链策略（发布不足 24 小时的包会被拒绝）

pnpm 11 内置供应链防护：**默认拒绝安装发布不足 24 小时的包**（`minimumReleaseAge` 默认 1440 分钟）。命中时长这样：

```
✗ Lockfile failed supply-chain policy check (263 entries)
[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] 3 lockfile entries failed verification:
  autoprefixer@10.5.5 was published at 2026-09-04T13:49:43.000Z, within the minimumReleaseAge cutoff ...
  browserslist@4.28.9 was published at 2026-09-04T13:36:01.000Z, ...
  electron-to-chromium@1.5.422 was published at 2026-09-04T06:07:39.000Z, ...
```

**这是防护，不是 bug**——它拦的是"刚发布即被投毒"的包。三选一即可：

| 方式 | 命令 | 适用 |
|---|---|---|
| 等版本满 24 小时 | 什么都不做，稍后重试 | 推荐，锁文件完全不用动 |
| 本次放宽 | `pnpm --config.minimum-release-age=0 install` | 赶时间，且确认这些版本可信 |
| 跑一键验证时放宽 | `RELAX_SUPPLY_CHAIN=1 bash wsl-verify.sh` | 验证脚本内置了该开关 |

> ⚠️ **两个坑**：
> 1. **环境变量对该设置无效**——`npm_config_minimum_release_age=0` 实测不起作用，必须用 `--config.minimum-release-age=0` 传参。
> 2. pnpm 11 的 `pnpm start` / `pnpm test` / `pnpm build` 会**先自动执行一次 `pnpm install`**（内部的 `runDepsStatusCheck`）。所以这个策略不只拦 `pnpm install`，它会让 `pnpm start` 等命令连带失败，且报错看起来像命令本身坏了。

### C2. 获取代码到 `~/workspace`

```bash
mkdir -p ~/workspace && cd ~/workspace
```

**方式一：从 git 克隆（推荐，干净）**

```bash
git clone <你的仓库地址> speakmate
cd speakmate
```

**方式二：从 Windows 源码目录复制（离线，最快）**

```bash
# Windows 的 D:\Work\SpeakMate 在 WSL 里是 /mnt/d/Work/SpeakMate
tar -C /mnt/d/Work/SpeakMate \
    --exclude='node_modules' --exclude='dist' \
    --exclude='.git' --exclude='backend/data' --exclude='.data-test' \
    -cf - . | tar -C ~/workspace/speakmate -xf -
```

> **必须排除 `node_modules` 与 `dist`**：Windows 下编译的 `better-sqlite3` 原生模块（`.node`）在 Linux 上加载不了，直接拷过去会崩。

### C3. 一键验证

仓库自带验证脚本，把「装依赖 → 类型检查 → 构建 → 全量测试 → 启动冒烟」串成一条命令：

```bash
cd ~/workspace
# 从 Windows 源码复制（默认 /mnt/d/Work/SpeakMate）
bash /mnt/d/Work/SpeakMate/scripts/wsl-verify.sh

# 或指定路径 / 从 git 克隆
LOCAL_SRC=/mnt/d/Work/SpeakMate bash /mnt/d/Work/SpeakMate/scripts/wsl-verify.sh
REPO_URL=https://github.com/<you>/speakmate.git bash /mnt/d/Work/SpeakMate/scripts/wsl-verify.sh
```

脚本会输出每一阶段的结果，任一环节失败即中断并打印原因。

等价于手动执行：

```bash
cd ~/workspace/speakmate

pnpm --dir backend install
pnpm --dir frontend install

pnpm --dir backend typecheck      # tsc --noEmit
pnpm --dir frontend typecheck

pnpm --dir frontend build         # 产出 frontend/dist

pnpm --dir backend test           # 后端 181 项
pnpm --dir frontend test          # 前端 36 项
```

> **首次安装可能要等 3–5 分钟**：`better-sqlite3` 是原生模块，官方只为部分 Node 版本提供预编译包。
> 若你的 Node 较新（实测 Node 24 就没有对应预编译包），pnpm 会自动回退 `node-gyp` 源码编译，
> 日志里会出现 `No prebuilt binaries found ... gyp info ...`，这是**正常**的，等它编完即可。
> 想跳过编译可改装 Node 20 LTS（有预编译包，安装通常 10 秒内完成）。

> **另一个高频坑**：`npm install -g pnpm` 会把 pnpm 装到 node 的 bin 目录（如 nvm 的
> `~/.nvm/versions/node/vX/bin`）。不少环境只在 `/usr/local/bin` 放了 `node`、`npm` 两个软链，
> 而**真正的 bin 目录并不在 PATH 上**，于是出现「装上了却 `pnpm: command not found`」。
> `wsl-verify.sh` 会自动按 `node` 的真实路径把该目录补进 PATH；手动部署时若遇到，
> 执行 `export PATH="$(dirname "$(readlink -f "$(command -v node)")"):$PATH"` 即可。

> **额外收获**：脚本最后会发 `SIGTERM` 给后端并校验退出码为 0。**Windows 不支持跨进程投递 SIGTERM，优雅停机（`shutdown()` → `closeDb()`）只能在 Linux 上这样验证**——这是选 WSL 的实质价值之一。

### C3.5 从 Windows 侧调用 WSL 命令的注意事项

写自动化脚本（CI、一键部署）时很容易踩这个坑：

```bash
# ❌ 不可靠：多语句内联写法下，变量赋值不生效
wsl.exe bash -lc 'FOO=bar; echo "[$FOO]"'        # 输出 []，不是 bar
wsl.exe bash -lc 'PATH="/usr/bin:/bin"; echo $PATH'   # 输出的仍是原 PATH

# ✅ 可靠：把逻辑写进 .sh 文件再交给 WSL 执行
wsl.exe bash /mnt/d/path/to/script.sh
```

症状是**分号「丢失」后，`VAR=x; cmd` 被当成 `VAR=x cmd` 处理**——后者是「仅对该命令生效的前缀赋值」，而命令行里的 `$VAR` 在赋值生效前就已被展开，于是拿到空值。

结论：需要在 WSL 里跑多步逻辑（尤其涉及变量赋值、PATH 调整）时，**一律写成脚本文件执行**，不要内联。

---

### C4. 从 Windows 浏览器访问

WSL2 默认开启 `localhostForwarding`，**Windows 侧直接访问 `http://localhost:3001` 即可**，无需任何配置。

```bash
# WSL 里启动
cd ~/workspace/speakmate/backend
cp .env.example .env
pnpm start
```

Windows 浏览器打开 `http://localhost:3001` → 出现应用界面即成功。

若访问不通，检查 `C:\Users\<你>\.wslconfig`：

```ini
[wsl2]
localhostForwarding=true
```

改完后在 PowerShell 执行 `wsl --shutdown` 再重开 WSL 生效。

### C5. 让手机 / 局域网访问（端口转发）

WSL2 位于 Hyper-V NAT 之后，**局域网设备访问 `http://<WindowsIP>:3001` 到不了 WSL**。需要用 Windows 的 `netsh portproxy` 把 Windows 端口转到 WSL IP。

**第 1 步：查 WSL 的 IP**

```bash
# WSL 里执行
ip -4 addr show eth0 | grep -oP '(?<=inet\s)\d+(\.\d+){3}'
```

或在 Windows PowerShell：

```powershell
wsl hostname -I
```

**第 2 步：在 Windows 管理员 PowerShell 里建转发规则**

```powershell
# 把 $WSL_IP 换成上一步查到的地址
$WSL_IP = '172.20.128.5'

# HTTP 端口
netsh interface portproxy add v4tov4 listenport=3001 listenaddress=0.0.0.0 connectport=3001 connectaddress=$WSL_IP
# HTTPS 端口（手机麦克风需要，见 C7）
netsh interface portproxy add v4tov4 listenport=3443 listenaddress=0.0.0.0 connectport=3443 connectaddress=$WSL_IP

# 放行防火墙
New-NetFirewallRule -DisplayName 'SpeakMate WSL 3001' -Direction Inbound -LocalPort 3001 -Protocol TCP -Action Allow
New-NetFirewallRule -DisplayName 'SpeakMate WSL 3443' -Direction Inbound -LocalPort 3443 -Protocol TCP -Action Allow

# 查看 / 删除
netsh interface portproxy show all
# netsh interface portproxy delete v4tov4 listenport=3001 listenaddress=0.0.0.0
```

**第 3 步：手机访问 `http://<WindowsIP>:3001`**（WindowsIP 用 `ipconfig` 查 IPv4 地址）。

> ⚠️ **WSL 重启后 IP 会变**，转发规则会失效。建议把上面的命令存成 `.ps1`，每次 WSL 重启后重跑一次；或在 WSL 内配置静态 IP / 用 `.wslconfig` 固定网段。

### C6. 在 WSL 里访问 Windows 上的 LMStudio

WSL 的 `localhost:1234` 指向 WSL 自己，**不是** Windows 上的 LMStudio。

```bash
# 方法1：DNS 服务器地址就是宿主机 IP（WSL2 特性）
grep nameserver /etc/resolv.conf

# 方法2：默认网关即宿主机
ip route show default | awk '{print $3}'
```

假设得到 `172.20.128.1`，则 `.env` 配：

```env
LLM_PROVIDER=lmstudio
LLM_BASE_URL=http://172.20.128.1:1234/v1
LLM_MODEL=qwen3.6-35b-a3b      # 以 LMStudio 实际加载的模型名为准
LLM_API_KEY=lm-studio
```

同时 LMStudio 需要开启局域网监听（默认只监听 `127.0.0.1`，WSL 连不上）：
**LMStudio → Developer / Local Server → 打开 "Serve on Local Network"**（或 `0.0.0.0` 监听）。

验证连通性：

```bash
curl http://172.20.128.1:1234/v1/models
```

### C7. HTTPS 证书（手机麦克风）

推荐**在 Windows 上用 mkcert 生成**（证书管理、安装根证书、拷到手机都在 Windows 侧更方便），然后让 WSL 通过 `/mnt` 路径引用：

```bash
# WSL 的 backend/.env
HTTPS_KEY_FILE=/mnt/c/Users/<你>/certs/speakmate-key.pem
HTTPS_CERT_FILE=/mnt/c/Users/<你>/certs/speakmate-cert.pem
HTTPS_PORT=3443
```

生成命令见方案A 的「A3. mkcert 生成局域网证书」。手机访问 `https://<WindowsIP>:3443`（需先按 C5 配好 3443 的转发）。

> 也可以直接在 WSL 里装 mkcert（`brew install mkcert` 或下载二进制），但把根证书装到 Windows 与手机的步骤一样少不了，通常不如在 Windows 侧做省事。

### C8. 常驻运行

**方式一：systemd（推荐，需 WSL2 开启 systemd）**

```bash
sudo tee /etc/wsl.conf > /dev/null <<'EOF'
[boot]
systemd=true
EOF
```

在 Windows PowerShell 执行 `wsl --shutdown` 后重开，确认 `systemctl --version` 可用，然后：

```bash
sudo tee /etc/systemd/system/speakmate.service > /dev/null <<'EOF'
[Unit]
Description=SpeakMate backend
After=network.target

[Service]
Type=simple
User=darrell
WorkingDirectory=/home/darrell/workspace/speakmate/backend
ExecStart=/home/darrell/.nvm/versions/node/v20.18.0/bin/node ./node_modules/.bin/tsx src/index.ts
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now speakmate
sudo systemctl status speakmate
journalctl -u speakmate -f
```

> `ExecStart` 里的 node 路径用 `which node` 查到的绝对路径，写成 `pnpm` 在 systemd 下常因 PATH 找不到。

**方式二：nohup / tmux（不想折腾 systemd 时）**

```bash
cd ~/workspace/speakmate/backend
nohup pnpm start > ~/speakmate.log 2>&1 &
# 或
tmux new -s speakmate 'pnpm start'      # Ctrl+B D 脱离，tmux a -t speakmate 回来
```

> 若用 systemd/nohup 常驻，请确认 `.env` 中的 `DATA_DIR` 指向稳定路径（默认即 `<backend>/data`）。

### C9. WSL 排障速查

| 现象 | 原因与处置 |
|------|-----------|
| `better-sqlite3` 报 `invalid ELF header` / `cannot open shared object` | 带了 Windows 编译的 `node_modules` 过来。删除 `node_modules` 重装，或复制时排除掉 |
| 后端起来了，Windows `localhost:3001` 打不开 | 检查 `.wslconfig` 的 `localhostForwarding`；或确认服务监听 `0.0.0.0` 而非 `127.0.0.1`（本项目默认监听所有网卡） |
| Windows 能访问，手机访问不了 | WSL2 在 NAT 后面，必须配 C5 的 `netsh portproxy` 转发 + 防火墙放行 |
| 手机能访问，但语音按钮无效 | 非安全上下文，需 HTTPS（C7）；`http://` 永远拿不到麦克风权限 |
| WSL 里连不上 LMStudio | 用了 `localhost`；改用宿主机 IP（C6），且 LMStudio 要开启局域网监听 |
| WSL 重启后转发失效 | WSL IP 变了；重跑 C5 的 `netsh` 命令（建议存成脚本） |
| 安装依赖极慢 / 测试超时 | 确认项目不在 `/mnt` 下；把代码挪到 `~/workspace` |
| WSL 吃内存过高 | 在 `C:\Users\<你>\.wslconfig` 设 `[wsl2] memory=4GB`，然后 `wsl --shutdown` |
| **任何 `pnpm` 命令都报 `ERROR packages field missing or empty`** | `backend/`（或 `frontend/`）下的 `pnpm-workspace.yaml` 缺 `packages` 字段——pnpm 自动生成的 `allowBuilds` 模板就是这样。按 **C1.5** 删除该文件并重装（pnpm 9 的表现形态） |
| **`pnpm start` 报 `ERR_PNPM_IGNORED_BUILDS` / `Command failed with exit code 1: '@pnpm/exe/pnpm' install`** | pnpm 11 会在 `pnpm start` 前自动跑 install；构建脚本被拦截导致 install 失败。在 `pnpm-workspace.yaml` 补 `allowBuilds: {better-sqlite3: true, esbuild: true}`（pnpm 11 的键名，不是 `onlyBuiltDependencies`），或 `pnpm approve-builds --all`。详见 **C1.5** |
| `ERR_PNPM_UNEXPECTED_STORE` | 项目被两个不同大版本的 pnpm 装过（store `v3`/`v10`/`v11` 不兼容）。`which -a pnpm` 找出多余版本，统一用其中一个后 `rm -rf node_modules && pnpm install` |
| `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` / `Lockfile failed supply-chain policy check` | pnpm 11 拒绝发布不足 24 小时的包。等版本满 24h 即可；赶时间用 `pnpm --config.minimum-release-age=0 install`（环境变量无效）。详见 **C1.6** |
| 安装成功但报 `Could not locate the bindings file` | 同上：`better-sqlite3` 原生模块没编译。确认 `find node_modules/.pnpm -name better_sqlite3.node` 能找到产物 |
| `pnpm` 装上了却 `command not found` | 两种成因：① `npm -g` 的 bin 目录不在 PATH 上，执行 `export PATH="$(dirname "$(readlink -f "$(command -v node)")"):$PATH"`；② **非交互 shell 不加载 `~/.bashrc`**，导致找不到 `~/.local/share/pnpm/bin` 下的 pnpm，脚本里改用 `bash -lc 'command -v pnpm'` 解析 |
| 脚本卡住十几分钟像死机 | 多半是 `corepack prepare pnpm@latest` 在联网下载。给它加 `timeout`，或先手动装好 pnpm 再跑脚本 |
| `corepack` / `node` 报 `required file not found` | WSL 继承了 Windows 的 PATH（`appendWindowsPath`），命中了 `/mnt/c/...` 下的程序。执行 `export PATH="$(echo "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"` |

---

## 安全加固（公网部署必读）

本项目默认形态是**单机自托管、零鉴权**（局域网/本机）。一旦暴露到公网，必须按下表加固。

### 1. 访问令牌（`ACCESS_TOKEN`）

未配置时 `/api/*` 完全开放，任何人都能读写你的会话、词汇本与画像。

```bash
# 生成一个高强度随机令牌
openssl rand -hex 32
```

```env
# backend/.env
ACCESS_TOKEN=<上一步生成的随机串>
```

- 后端只接受 `Authorization: Bearer <token>` 请求头，**刻意不接受 URL 参数**
  （`?token=...` 会进入访问日志、浏览器历史与 Referer）；
- 前端入口：设置页「访问令牌」卡片，令牌仅保存在本机 localStorage，
  **不会**写入 Vite 环境变量（否则会被内联进打包产物，等同于公开）；
- 配置后未带令牌的请求返回 `401 {"code":4010}`。

### 2. CORS 白名单（`CORS_ORIGIN`）

```env
# 留空 = 同源部署（推荐）：不返回任何 CORS 头，最严格
CORS_ORIGIN=https://speakmate.example.com
```

- 必须是**精确 origin**（含 scheme、含端口，不含路径）；多个用逗号分隔；
- `'*'` 会被 config/env.ts 拒绝并回落到同源策略——那等价于对全网开放读写；
- 只配白名单而不配 `ACCESS_TOKEN` 意义有限：任何站点都能直接调你的接口。

### 3. 反代后的真实客户端 IP（`TRUST_PROXY`）

Nginx 已转发 `X-Forwarded-For` 时设为 `true`，速率限制才能按真实客户端计数：

```env
TRUST_PROXY=true
```

**仅在确实部署在反代之后才开启**。直接暴露时开启会让客户端伪造该头绕过限流。

### 4. 速率限制

默认已启用，按成本分三档（每 IP / 每分钟）：

| 档位 | 默认值 | 覆盖接口 | 环境变量 |
|------|-------|---------|---------|
| LLM 消耗型 | 30 | `POST /api/chat`、`POST /api/words/define` | `RATE_LIMIT_LLM_PER_MIN` |
| 写操作 | 120 | 会话/词条/画像的增改删 | `RATE_LIMIT_WRITE_PER_MIN` |
| 读操作 | 300 | 各 GET 接口 | `RATE_LIMIT_READ_PER_MIN` |

命中上限返回 `429 {"code":4290}` 并回传 `RateLimit-*` 标准头。
单用户正常使用远低于默认值（人一分钟发不了 30 轮对话），误伤概率极低。

### 5. 进程数限制（⚠️ 重要）

**不要用 `pm2 start -i max` / `-i 0` 起多实例。** 后端为单进程设计：

- 速率限制计数在**进程内存**中，多实例会让实际额度翻倍；
- 画像与会话的「读 → 合并 → 写」依赖 Node 单线程下的同步 SQLite 访问
  （better-sqlite3 的同步 API），多进程并发会丢更新。

需要扩容时先引入外部缓存与异步驱动，属架构变更，不在本文档范围内。

### 6. 其他

- `.env` 权限 `chmod 600`，且**绝不入库**（`.gitignore` 已忽略）；
- 日志不打印 `LLM_API_KEY`、令牌等敏感信息（后端已保证）；
- 定期备份 `backend/data/speakmate.db`（见下节）。

---

## 多用户部署（P2-5）

后端已支持多用户：每个用户有独立的会话、词汇本与学习画像，互不可见。

### 1. 微信小程序静默登录（主路径）

小程序端走 `wx.login()` → 后端换 openid → 签发登录态 token，**用户零操作**。

**后端 `.env` 配置**：

```env
# 小程序 AppID（project.config.json 里那个）
WECHAT_APP_ID=wxXXXXXXXXXXXXXXXX
# AppSecret：小程序后台 → 开发管理 → 开发设置 → AppSecret 重置获取
# ⚠️ 只放后端 .env，绝不下发前端、绝不写日志
WECHAT_APP_SECRET=xxxxxxxx
```

**微信公众平台配置（⚠️ 必做，否则功能不可用）**：

| 位置 | 操作 |
|---|---|
| 设置 → 服务内容声明 →《用户隐私保护指引》 | 新增「用户账号信息 → 微信 OpenID」，用途写"用于识别用户身份，实现多用户数据隔离"，并勾选 `wx.login` 权限 |
| 开发 → 开发管理 → 服务器域名 | 把后端地址加入 **request 合法域名**（小程序只支持 HTTPS，域名须已备案） |
| 提审页面 → 用户隐私保护设置 | 勾选"采集用户隐私" |

> **为什么必须先做这一步**：未提交隐私协议的小程序，`wx.login` 返回的 openid 会带
> `temp-` 前缀——那是临时值、不稳定，不能用于持久绑定用户数据。
> 后端检测到该前缀会直接报错并给出提示，而不是静默用临时标识建账号。

### 2. 邀请码登录（主人 / 受邀用户）

```env
# 逗号分隔，每个邀请码对应一个独立账号
INVITE_CODES=code-for-alice,code-for-bob
```

每个邀请码会派生一个稳定的用户 id：**同一邀请码永远登录到同一账号**（数据可追溯），
不同邀请码之间数据完全隔离。

### 3. 身份优先级

| 凭证 | 身份 | 说明 |
|---|---|---|
| 登录态 token（`/api/auth/*` 签发） | 对应用户 | 普通用户路径，30 天有效期 |
| 静态 `ACCESS_TOKEN` | `admin` | 主人 / 管理员凭证 |
| 微信 openid | 对应用户 | 首次登录自动建号，昵称随机生成 |

小程序端设置页可填入 `ACCESS_TOKEN` 以管理员身份访问（填了会优先于微信登录）。

### 4. 存量数据归属

migration v3 已把历史 `user_id='default'` 的数据统一重命名为 `admin`，
即主人的历史记录自动归到管理员账号。升级后无需手工处理。

### 5. 速率限制注意事项

现有速率限制按 **IP** 计数（见上文第 4 节）。多人共用同一 WiFi 时会共享配额，
可能互相误伤；若需按用户隔离，可调整 `rateLimit.ts` 的 `keyGenerator` 改为
`req.userId ?? req.ip`。

---

## 本地 LLM 接入：Ollama

后端已内置 Ollama provider（`LLM_PROVIDER=ollama`）。

```env
LLM_PROVIDER=ollama
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=qwen3.6:35b
LLM_API_KEY=ollama
```

**关键实现说明**：后端走 Ollama **原生端点** `/api/chat`（由 `LLM_BASE_URL` 的 `/v1`
后缀推导），**不走** `/v1` 兼容层。原因是：

| 端点 | 关闭思考 | 实测首字延迟（qwen3.6:35b + 真实对话 prompt） |
|---|---|---|
| `/v1/chat/completions` | ❌ `think:false` 与 `chat_template_kwargs` **均不生效** | 10.55s → 逼近 15s 超时阈值，表现为「LLM 响应超时」 |
| `/api/chat`（原生） | ✅ `think:false` 生效 | **0.11s**，思考长度 0 |

若强行用 `/v1`，思考过程会挤占 `max_tokens` 配额，正文被截断
（现象：`finish_reason="length"` 且 `content` 为空）。

模型名必须与 `ollama list` 输出完全一致（区分 `:latest` 与具体 tag）。

---

## 数据备份与迁移

全部业务数据在一个 SQLite 文件（外加 WAL 伴生文件）：

```bash
# 推荐：在线热备（不中断服务）
sqlite3 /opt/speakmate/backend/data/speakmate.db ".backup '/tmp/speakmate-backup.db'"

# 或：停服后直接复制
pm2 stop speakmate
cp backend/data/speakmate.db /safe/place/
pm2 start speakmate
```

换机迁移：新机器装好 Node/pnpm → 复制整个项目目录（不含 `node_modules`）→ `pnpm install`（backend、frontend）→ 把 `speakmate.db` 放回 `backend/data/` → 启动。

---

## 常见问题排查

| 现象 | 原因与处置 |
|------|-----------|
| 手机上语音按钮点了没反应 / 自动切文字模式 | 非安全上下文：确认访问的是 `https://`（方案A）或已配证书（方案B）；`http://局域网IP` 永远拿不到麦克风 |
| 证书警告 | 自签证书预期行为：点「高级 → 继续」；或把 mkcert 根 CA 装到手机（见 A6） |
| 云端对话整段一次性出现、无逐字效果 | Nginx 代理缓冲未关：确认 `proxy_buffering off;` 与 `proxy_set_header Connection '';` |
| 对话报错 3001（LLM 连接失败） | 云端：Key/额度/端点；LMStudio：服务没启动（`curl http://localhost:1234/v1/models`）或 `LLM_MODEL` 与实际模型名不一致 |
| 对话报错 3002（首字超时） | 本地模型冷启动慢属正常，重试即可；频繁出现换更快模型或切云端 |
| `better-sqlite3` 安装/启动失败 | Node 大版本与预编译二进制不匹配：`pnpm rebuild better-sqlite3`；仍失败则确认有编译工具链（Windows 需 VS Build Tools，Linux 需 `build-essential`） |
| pm2 里看不清日志 | `pm2 logs speakmate --lines 100`，或 `cat ~/.pm2/logs/speakmate-out.log` |
| 改了 `.env` 不生效 | 环境变量在启动时加载：`pm2 restart speakmate`（或本地重启后端） |

---

*本文档为 T8 交付物，与 `backend/.env.example`（配置项全集）、`README.md`（快速启动）配套维护；后端 HTTPS 能力对应 `backend/src/index.ts` 与 `backend/src/config/env.ts`。*

---

## 发音评测服务（本地，WSL）

训练页跟读后的**音素级发音评分**由本地 OpenPronounce 服务提供（开源，MIT，
数据不出设备）。架构与 Ollama 同款「本机子服务」模式：

```
小程序跟读 → 录音(mp3) → Node 后端 /api/pronounce (3001)
                            → WSL OpenPronounce 服务 (8600)
                              → wav2vec2 音素模型（CPU，评估 <1s）
```

### 启动

```bash
# WSL 里执行（模型已缓存在 ~/.cache/huggingface/hub，首次加载 ~10s）
wsl bash /mnt/d/Work/SpeakMate/pron-server/start.sh
```

健康检查（Windows 侧，WSL2 localhost 自动转发）：

```bash
curl http://localhost:8600/health
```

### 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PRONOUNCE_URL` | `http://localhost:8600` | Node 后端转发目标（backend/.env） |

### 依赖（已部署，备忘）

- WSL venv `~/envs/pron`：openpronounce 0.3.0 + torch 2.15（CPU）
- espeak-ng 用户级安装（`~/.local/espeak`，免 sudo，start.sh 里带全套环境变量）
- 模型 2.4GB：`~/.cache/huggingface/hub/models--facebook--wav2vec2-*`（离线缓存，
  `HF_HUB_OFFLINE=1`，不再联网）

### 常见问题

| 现象 | 处理 |
|---|---|
| 训练页显示"发音评测服务不可达" | WSL 里跑上面的 start.sh |
| 首次评测 ~10s | 正常（模型加载），之后 <1s |
| 评分总是偏低 | 参考文本与跟读句一致即可；环境噪音大也会扣分 |

---

## 本地 TTS 引擎（Kokoro-82M，离线）

AI **朗读**（把文字念出来）的语音合成，默认走**本地模型**，不依赖外网、不产生任何
第三方调用；发音**评测**（给跟读打分）另见上一节的 OpenPronounce。

```
小程序 → Node 后端 /api/tts (3001)
           → Worker 线程：Kokoro-82M（ONNX Runtime，CPU 推理，24kHz PCM）
           → ffmpeg 管道转 mp3 → 返回给小程序播放
```

### 为什么用 Kokoro

- 82M 参数，q8 量化后模型仅 **89MB**，28 个英文音色（美/英 × 男女），
  音质接近在线 Edge TTS，Apache-2.0 许可；
- **纯 CPU ONNX 推理**，不挑显卡——本机是 AMD AI Max 395（APU，无 NVIDIA 卡），
  Zen5 CPU 跑 82M 模型绰绰有余（实测约 **1.8× 实时**，3 秒句子 1.7 秒出音频）；
- 有 Node 原生绑定（`kokoro-js`），可直接跑在现有 Express 进程里，
  不必像 OpenPronounce 那样另起一个子服务。

### 首次部署：下载模型

模型权重不入 git（`.gitignore` 已忽略 `backend/models/`），换机器时用脚本拉取：

```bash
node backend/scripts/fetch-kokoro-model.mjs
```

脚本会用系统 `curl`（显式带 `-x $HTTPS_PROXY`）从 HF 镜像下载 **32 个文件**
（模型 89MB + 28 个音色各 0.5MB），已存在的自动跳过，可重复执行。

> ⚠️ **为什么不用 transformers.js 自己下载**：它的 Node 版用原生 `fetch`(undici)，
> 而 undici **不读 `HTTP_PROXY`/`HTTPS_PROXY` 环境变量**；直连 huggingface.co
> 既会超时，又可能撞上 DNS 污染（实测被解析到 Facebook 的 IP）。
> 因此后端一律走「本地文件 + `env.allowRemoteModels=false`」，**运行期零联网**。

### 配置（backend/.env）

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `TTS_ENGINE` | `auto` | `local` 只用本地；`edge` 只用在线 Edge TTS；`auto` 本地优先、失败自动回退 |
| `TTS_MODEL_DIR` | `backend/models` | 模型根目录，其下需有 `onnx-community/Kokoro-82M-v1.0-ONNX/` |
| `FFMPEG_PATH` | `ffmpeg` | 用于把 PCM 转 mp3；**NSSM 以 LocalSystem 运行，PATH 里没有 ffmpeg，必须写绝对路径** |

### 音色映射

对外音色 id 沿用 Edge TTS 命名（`en-US-JennyNeural` 等），**小程序端零改动**，
后端在 `services/tts.service.ts` 的 `KOKORO_VOICE_MAP` 里翻译成本地音色名：

| 对外 id | 本地音色 | 定位 |
|---|---|---|
| `en-US-JennyNeural` | `af_heart` | 美式女 · 评级 A |
| `en-US-GuyNeural` | `am_michael` | 美式男 · 评级 C+ |
| `en-US-AriaNeural` | `af_bella` | 美式女 · 评级 A- |
| `en-US-ChristopherNeural` | `am_fenrir` | 美式男 · 评级 C+ |
| `en-GB-SoniaNeural` | `bf_emma` | 英式女 · 评级 B- |
| `en-GB-RyanNeural` | `bm_george` | 英式男 · 评级 C |

### 关键设计：推理放在 Worker 线程

onnxruntime-node 的 CPU 推理是**同步 native 调用**，会阻塞所在线程的事件循环。
若直接放在 Express 主线程，单句合成 1.5-2s 期间，聊天页的 SSE 流式推送、鉴权、
限流会全部停摆。因此推理放在 `backend/workers/tts.worker.mjs`（独立线程），
主线程只收发消息——实测并发合成时 `/api/health` 响应仍是 **3-6ms**。

### 验证

```bash
# 1. 引擎状态（local.status 应为 ready）
curl -H "Authorization: Bearer $ACCESS_TOKEN" http://localhost:3001/api/health

# 2. 合成一句话（响应头 X-TTS-Engine: kokoro 即为本地引擎）
curl -D- -H "Authorization: Bearer $ACCESS_TOKEN" \
  "http://localhost:3001/api/tts?text=Hello&voice=en-US-JennyNeural" -o out.mp3

# 3. 冒烟测试（模型加载 + 三音色合成计时）
node backend/scripts/test-kokoro.mjs
```

### 常见问题

| 现象 | 原因与处理 |
|---|---|
| `X-TTS-Engine: edge` | 本地引擎失败已自动回退在线方案；看服务日志的 `[tts] 本地引擎失败` 行 |
| health 里 `tts.local.status = error` | 模型目录不对或文件缺失，重跑 `fetch-kokoro-model.mjs` |
| `ffmpeg 转码失败` | `FFMPEG_PATH` 没写绝对路径（NSSM/LocalSystem 的 PATH 里没有 ffmpeg） |
| 合成明显变慢 | 确认走的是 `kokoro` 而非回退的 `edge`；本地 CPU 被打满时（并发评测）会变慢 |
| 想切回纯在线 | `.env` 设 `TTS_ENGINE=edge`，重启后端即可 |

