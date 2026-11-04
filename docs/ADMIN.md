# SpeakMate 管理台

最小管理台：用户列表、用量统计、系统健康、封禁 / 解封。没有邀请码生成、审计日志、内容审核，也不查看对话原文。

## 谁能登录

管理台使用用户名和密码，不接受粘贴 `ACCESS_TOKEN`。

- 默认用户名是 `admin`（可用 `ADMIN_USERNAME` 覆盖）。
- 密码来自 `backend/.env` 的 `ADMIN_PASSWORD`。不要把生产密码写进仓库。
- 登录成功后，服务端把随机会话放进 **httpOnly** cookie（`speakmate_admin`，`SameSite=Lax`，路径 `/api/admin`，8 小时）。页面不保存密码，也不把会话 token 放进 `localStorage` / `sessionStorage`。
- 邀请码登录、微信登录换到的令牌，以及 `ACCESS_TOKEN`，可以继续按原规则用学员接口；访问 `/api/admin/*` 会得到 **403**。
- 没设置 `ADMIN_PASSWORD` 时，学员接口仍按 `ACCESS_TOKEN` 的规则工作（留空则零配置放行），但管理接口一律 **401**，登录接口 **503**。局域网模式不会把管理台公开。
- `?token=` 仍然无效。

本地开发例外：`pnpm dev` 会设置 `NODE_ENV=development`。这时如果没写 `ADMIN_PASSWORD`，管理台回退到仅供本机的口令 `speakmate-local-dev-only`（用户名仍是 `admin`）。`NODE_ENV=production` 和没设置 `NODE_ENV` 的 `pnpm start` **不会**使用这个口令。生产部署必须自己设置 `ADMIN_PASSWORD`，并设置 `NODE_ENV=production`（这样 cookie 才会带 `Secure`）。

生成生产密码：

```bash
openssl rand -base64 24
```

写入 `backend/.env` 的 `ADMIN_PASSWORD=`，不要提交 `.env`。

## 本地开发

开两个终端。

```bash
# 终端 1
cd backend
cp .env.example .env    # 生产或 pnpm start 时填上 ADMIN_PASSWORD；pnpm dev 可用文档中的本地默认口令
pnpm install
pnpm dev                # http://localhost:3001
```

```bash
# 终端 2
cd frontend/admin
pnpm install
pnpm dev                # http://localhost:5174/admin
```

浏览器打开 <http://localhost:5174/admin>，用用户名 `admin` 和密码登录。`pnpm dev` 且未设置 `ADMIN_PASSWORD` 时，密码是 `speakmate-local-dev-only`。Vite 把 `/api` 代理到 3001，cookie 跟着同源请求走。

## 生产

```bash
cd frontend && pnpm install && pnpm build
cd admin && pnpm install && pnpm build
cd ../../backend && pnpm start
```

- 学员端：<http://localhost:3001>
- 管理台：<http://localhost:3001/admin>

后端发现 `frontend/admin/dist` 后把它挂到 `/admin`，并避开学员端的 SPA 回退。没构建管理台时，这个路径不会出现。

## 接口

除登录和退出外，全部要求管理会话 cookie。成功响应仍是 `{ code, data, message }`。

| 方法 | 路径 | 作用 |
|------|------|------|
| POST | `/api/admin/login` | 正文 `{ "username", "password" }`。成功时 `Set-Cookie`，正文只有用户名 |
| POST | `/api/admin/logout` | 作废当前管理会话并清除 cookie |
| GET | `/api/admin/users?q=&status=&page=&page_size=` | 搜索（昵称 / id / openid）与分页。`status` 为 `active` 或 `banned`。`page_size` 最大 100 |
| POST | `/api/admin/users/:id/ban` | 封禁。正文 `{ "reason": "可选，最多 200 字" }` |
| POST | `/api/admin/users/:id/unban` | 解封 |
| GET | `/api/admin/stats` | 用户数（含来源与封禁）、会话 / 消息总量、近 7 天与近 24 小时活动 |
| GET | `/api/admin/health` | 数据库、schema 版本、进程 uptime、LLM 是否配置了 Key、TTS 内存状态。不调用 LLM |

封禁和解封都会删除该用户的 `auth_sessions`。被封禁的账号再登录会得到 401「账号已被停用」；如果旧令牌还没被删掉，`requireAuth` 同样返回 401。不能封禁 id 为 `admin` 的身份（那是存量数据的归属账号，不是学员行，也不是管理台会话本身）。

数据库变更在迁移 v4：`users.status`（`active` / `banned`）、`banned_at`、`ban_reason`。启动时自动执行，老库会补列，已有用户默认为 `active`。
