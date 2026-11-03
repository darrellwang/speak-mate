# SpeakMate 管理台

最小管理台：用户列表、用量统计、系统健康、封禁 / 解封。没有邀请码生成、审计日志、内容审核，也不查看对话原文。

## 谁能登录

只接受 `backend/.env` 里的 `ACCESS_TOKEN`（`Authorization: Bearer <token>`）。

- 邀请码登录和微信登录换到的令牌可以继续用学员接口，访问 `/api/admin/*` 会得到 **403**。
- 没配置 `ACCESS_TOKEN` 时，学员接口仍是零配置放行，但管理接口一律 **403**。局域网模式不会把管理台公开。
- 令牌只放在请求头里。`?token=` 无效。
- 管理台页面把令牌存在 `sessionStorage`（`speakmate.admin.token`），与学员 H5 的 localStorage 分开。关掉标签页即退出。

生成令牌：

```bash
openssl rand -hex 32
```

写入 `backend/.env` 的 `ACCESS_TOKEN=`，不要提交 `.env`。

## 本地开发

开两个终端。

```bash
# 终端 1
cd backend
cp .env.example .env    # 填上 ACCESS_TOKEN
pnpm install
pnpm dev                # http://localhost:3001
```

```bash
# 终端 2
cd frontend/admin
pnpm install
pnpm dev                # http://localhost:5174/admin
```

浏览器打开 <http://localhost:5174/admin>，在登录页粘贴同一个 `ACCESS_TOKEN`。Vite 把 `/api` 代理到 3001。

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

全部要求管理员令牌。成功响应仍是 `{ code, data, message }`。

| 方法 | 路径 | 作用 |
|------|------|------|
| GET | `/api/admin/users?q=&status=&page=&page_size=` | 搜索（昵称 / id / openid）与分页。`status` 为 `active` 或 `banned`。`page_size` 最大 100 |
| POST | `/api/admin/users/:id/ban` | 封禁。正文 `{ "reason": "可选，最多 200 字" }` |
| POST | `/api/admin/users/:id/unban` | 解封 |
| GET | `/api/admin/stats` | 用户数（含来源与封禁）、会话 / 消息总量、近 7 天与近 24 小时活动 |
| GET | `/api/admin/health` | 数据库、schema 版本、进程 uptime、LLM 是否配置了 Key、TTS 内存状态。不调用 LLM |

封禁和解封都会删除该用户的 `auth_sessions`。被封禁的账号再登录会得到 401「账号已被停用」；如果旧令牌还没被删掉，`requireAuth` 同样返回 401。不能封禁 id 为 `admin` 的身份（那是 `ACCESS_TOKEN` 对应的存量数据归属方，不是学员行）。

数据库变更在迁移 v4：`users.status`（`active` / `banned`）、`banned_at`、`ban_reason`。启动时自动执行，老库会补列，已有用户默认为 `active`。
