# SpeakMate 多用户改造方案

> 状态：**✅ 已实施完成**（2026-10-31）
> 日期：2026-10-29
> 关联：PRD §6.4 / P2-5、ARCHITECTURE §9.9、CODE_REVIEW §4.3
>
> **实施说明（主人确认的取舍）**：
> - H5 端本次不做（主人明确忽略），H5 仍走原有静态令牌路径；
> - **不引入头像昵称**，昵称由服务端随机生成（"开朗的小鲸鱼"这类）；
> - 小程序端走 `wx.login` 静默登录为主路径，邀请码为辅。
>
> **落地时发现并修复的三个真实问题**（见 §11）：
> 1. 邀请码登录原本所有邀请码落同一个账号 → 隔离失效，改为按邀请码哈希派生独立账号；
> 2. `/api/auth/me`、`/api/auth/logout` 挂在 `requireAuth` 之前 → 拿不到 `req.userId`，
>    拆成 `authPublicRouter`（登录）与 `authRouter`（会话管理）两个挂载点；
> 3. mock provider 的模型名被 `.env` 的 `LLM_MODEL` 污染 → 测试断言失败，
>    改为 mock 强制使用预设模型名。

---

## 0. 一句话结论

**当前是单用户设计**（`DEFAULT_USER_ID = 'default'` 硬编码在 5 个路由文件），
**数据表已预留 `user_id`**，改造点集中在「登录态」这一层；
**微信隐私权限需要改的是公众平台后台的《用户隐私保护指引》，不是小程序代码里的权限声明**。

---

## 1. 现状盘点

### 1.1 已具备的条件（好消息）

| 项 | 位置 | 状态 |
|---|---|---|
| 四张表 `user_id` 字段 | `backend/src/db/schema.sql` | ✅ 已建，含索引与 `UNIQUE(user_id, word)` |
| service 层按 user_id 过滤 | `backend/src/services/*.ts` | ✅ 全部 `WHERE user_id = ?`，无需重构 |
| 迁移执行器 | `backend/src/db/migrate.ts` | ✅ 严格递增、幂等可重入，加 v3 迁移即可 |
| 隐私授权机制 | `miniprogram/utils/privacy.ts` | ✅ `wx.onNeedPrivacyAuthorization` 全套已就绪 |
| `__usePrivacyCheck__` | `miniprogram/app.json` | ✅ 已为 `true` |

**结论：service 层和隐私弹窗机制都不用动，改动集中在路由层 + 新增认证模块。**

### 1.2 缺口

| 项 | 位置 | 问题 |
|---|---|---|
| 硬编码 userId | `chat/sessions/words/profile/scenes.routes.ts` | 5 处全是 `DEFAULT_USER_ID` |
| 鉴权只认令牌不认人 | `backend/src/middleware/auth.ts` | 只做 Bearer 令牌比对，不解析出身份 |
| 小程序无登录态 | `miniprogram/` 全局 | 无 `wx.login` / `openid` / `getUserProfile` |
| 小程序令牌硬编码 | `miniprogram/config.ts` → `request.ts:54` | ⚠️ 注释说"从 Storage 读"，实际读的是编译期常量 |
| H5 令牌存 localStorage | `frontend/src/api/token.ts` | ✅ 这个是对的，无需改 |
| 无账号表 | — | 缺 `users` / `auth_sessions` |

> ⚠️ 附带发现：`miniprogram/utils/request.ts` 第 9 行注释声称"令牌只从 Storage 读（设置页录入），
> 绝不写进代码包"，但 `buildHeaders()` 第 54 行实际用的是 `import { ACCESS_TOKEN } from '../config'`
> 的编译期常量。**注释描述的是 H5 端做法，小程序端实际是随包硬编码**，可被反编译提取。
> 本次改造顺带修掉这个不一致。

---

## 2. 身份来源选型

三种来源，统一收敛到「后端自签 token」，前端只认 `Authorization: Bearer <token>`。

| 方案 | 身份来源 | 适用端 | 隐私声明 | 评价 |
|---|---|---|---|---|
| **A. 微信 openid 静默登录** | `wx.login()` → code → `code2Session` → openid | 小程序 | 需声明 openid | ✅ **推荐做小程序端** |
| **B. 邀请码 / 密码** | 用户自设凭证 | H5 + 小程序 | 无需声明 | ✅ 主人自己走这条路 |
| **C. 静态 ACCESS_TOKEN** | 保留现有 | H5 | 无需声明 | 兼容保留，落管理员账号 |

### 2.1 为什么 A 是小程序端的正解

- `wx.login()` **静默**，无弹窗、无用户点击，不打断体验
- 只拿 openid（应用级唯一标识），**不碰头像昵称**
- 少收一份数据 = 符合微信"最小必要"原则 = 审核更顺

### 2.2 为什么不引入 `wx.getUserProfile`

| 维度 | `wx.login`（openid） | `wx.getUserProfile`（头像昵称） |
|---|---|---|
| 触发方式 | 静默 | 必须 `button open-type="getUserProfile"` 主动点击 |
| 系统弹窗 | ❌ 无 | ✅ 有 |
| 隐私声明 | 声明 openid 一项 | 额外声明头像、昵称 |
| 审核门槛 | 低 | 高，易因"用途描述与场景不符"被驳回 |

SpeakMate 是学习工具，不显示头像昵称也能跑通。**不要引入。**

---

## 3. 微信隐私合规：到底要改什么

### 3.1 必须做（后台配置，不改代码）

**微信公众平台 → 设置 → 服务内容声明 →《小程序用户隐私保护指引》**

新增条目：

| 声明项 | 填写建议 |
|---|---|
| 收集的用户信息 | 用户账号信息 → 微信 OpenID |
| 用途说明 | "用于识别用户身份，实现多用户数据隔离（各自的对话记录、词汇本与学习画像互不干扰）" |
| 调用权限 | `wx.login` |

**⚠️ 这是硬前提。** 微信开放社区官方答疑确认：未提交隐私协议的小程序，`wx.login` 返回的 openid
**带 `temp-` 前缀**——那是临时值，不稳定，不能用于持久绑定用户数据。不先做这一步，方案 A 的数据隔离
从根上就跑偏。

提审时还需在小程序后台「用户隐私保护设置」勾选"采集用户隐私"。

### 3.2 必须做（小程序内文案）

`miniprogram/pages/privacy/privacy.wxml` 现有三条（麦克风录音 / 对话文本 / 后端配置）需补一条：

> **微信 OpenID**：用于识别你的账号，使你只能看到自己的对话记录、词汇本与学习画像。

同时 `pages/privacy/privacy.ts` 无需改逻辑，只补文案。

### 3.3 不需要动

| 项 | 原因 |
|---|---|
| `app.json` → `permission.scope.record` | 麦克风授权与多用户无关 |
| `app.json` → `__usePrivacyCheck__` | 已为 `true`，机制完整 |
| `miniprogram/utils/privacy.ts` | 现有 `onNeedPrivacyAuthorization` 流程可直接复用 |
| 麦克风运行时权限（`scope.record`） | speech 适配器已处理 |

### 3.4 额外合规项（多人后必须补）

- **数据删除通道**：PIPL 要求用户可要求删除其数据。建议设置页加「清除我的数据」→ 调
  `DELETE /api/me/data`，删该用户的 sessions/messages/vocabulary/profile。
- **用户可查阅**：设置页展示当前绑定账号（openid 后 8 位）。
- **隐私政策页需重新提审**：改动内容后需重新提交《用户隐私保护指引》审核。

---

## 4. 后端改造

### 4.1 新增表（migration v3）

```sql
-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,              -- uuid v4
  openid      TEXT UNIQUE,                   -- 微信 openid（可空：H5 邀请码用户）
  source      TEXT NOT NULL,                 -- wechat | invite
  nickname    TEXT NOT NULL DEFAULT '',      -- 展示名（不取微信昵称，用户自填）
  created_at  TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

-- 登录态表
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash  TEXT PRIMARY KEY,              -- sha256(token)，不存明文
  user_id     TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
```

> token 明文只在登录响应返回一次，服务端只存 hash —— 即使库被拖走也无法直接冒用。

### 4.2 认证中间件改造

`backend/src/middleware/auth.ts` 增加 `resolveUser` 逻辑：

```
Authorization: Bearer <token>
  ├─ 命中 auth_sessions 且未过期 → req.userId = 对应 user_id
  ├─ 等于 ACCESS_TOKEN → req.userId = 'admin'（兼容旧行为）
  └─ 否则 401
```

同时 `ACCESS_TOKEN` 语义升级：**它从"一把万能钥匙"变成"管理员凭证"**，不再是全站门禁。
`ACCESS_TOKEN` 为空时，多用户模式不可用（必须配），要给出明确启动报错。

### 4.3 路由层改造（5 个文件）

统一改为从 `req` 取：

```ts
// 改造前
sessionService.listSessions(DEFAULT_USER_ID, limit, offset)
// 改造后
sessionService.listSessions(req.userId!, limit, offset)
```

涉及：`chat.routes.ts`、`sessions.routes.ts`、`words.routes.ts`、`profile.routes.ts`、`scenes.routes.ts`

### 4.4 新增接口

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/wechat-login` | 入参 `{ code }`，后端调 `code2Session` 换 openid，返回自签 token |
| POST | `/api/auth/invite-login` | 入参 `{ code }`（邀请码），返回自签 token |
| GET | `/api/auth/me` | 返回当前用户信息（id、nickname、创建时间） |
| DELETE | `/api/me/data` | 清除当前用户全部数据（PIPL 删除权） |

`/api/auth/*` 必须**在 `requireAuth` 之前**挂载（登录接口本身无需鉴权）。

### 4.5 后端需要微信配置

```env
# backend/.env
WECHAT_APP_ID=wxXXXXXXXXXXXXXXXX
WECHAT_APP_SECRET=xxx
```

`code2Session` 调用 `https://api.weixin.qq.com/sns/jscode2session`，
**注意 `session_key` 绝不下发前端**（只用来签发自己的 token）。

---

## 5. 小程序改造

### 5.1 新增 `miniprogram/utils/auth.ts`

```ts
// 静默登录：wx.login → 后端换 token → 存 Storage
export async function ensureLogin(): Promise<string> {
  // 1. 有有效 token 直接用
  // 2. 否则 wx.login() 拿 code → POST /api/auth/wechat-login → 存 token
}
```

### 5.2 改造 `miniprogram/utils/request.ts`

- 令牌来源从 `config.ts` 常量改为 Storage 读取
- 首次请求前 `await ensureLogin()`
- 401 时自动重新登录并重试一次（静默续期）
- ⚠️ 顺带修复注释与实现不一致的问题

### 5.3 令牌与 baseUrl 的 UI 暴露

小程序端**不能像 H5 那样"设置页自由填"**——baseUrl 与域名白名单强相关。
建议：
- baseUrl 保留在 `config.ts`（或增加"测试环境"页），但**令牌从 Storage 读**
- 令牌本身由 `/api/auth/wechat-login` 下发，用户无需手输

### 5.4 微信域名白名单

`wx.request` 目标域名必须在小程序后台配置（request 合法域名）。当前后端地址若是
自有域名，需 HTTPS + 已备案 + 加入白名单。小程序**只支持 HTTPS**，
这是比隐私协议更容易卡住上线的点。

---

## 6. H5 端改造

- `frontend/src/api/token.ts` 的 localStorage 机制**保持不变**
- 改为登录时调 `/api/auth/invite-login` 拿 token，替换掉"手填 ACCESS_TOKEN"
- 设置页「访问令牌」卡片改为「登录」卡片（邀请码输入框）

---

## 7. 存量数据迁移

现有 `user_id = 'default'` 的数据（主人自己的历史记录）需要归属。

**推荐方案：把 `default` 重命名为管理员账号**

```sql
-- migration v3 中执行
UPDATE sessions   SET user_id = 'admin' WHERE user_id = 'default';
UPDATE messages   SET user_id = 'admin' WHERE user_id = 'default';
UPDATE vocabulary SET user_id = 'admin' WHERE user_id = 'default';
UPDATE user_profile SET user_id = 'admin' WHERE user_id = 'default';
```

主人的历史数据自动落到管理员账号，微信用户各自独立。

---

## 8. 实施顺序

| 阶段 | 内容 | 依赖 |
|---|---|---|
| **P0** | 微信后台声明隐私指引 + 加 `wx.login` 权限 | 无（**必须最先做**） |
| **P1** | 后端：migration v3 + `users`/`auth_sessions` + 认证中间件 | 无 |
| **P2** | 后端：5 个路由层改读 `req.userId` + 4 个新接口 | P1 |
| **P3** | 小程序：`utils/auth.ts` + `request.ts` 改造 | P1 + P0 |
| **P4** | H5：登录页 + 邀请码机制 | P1 |
| **P5** | 隐私文案更新 + 数据删除通道 + 重新提审 | P3 |
| **P6** | 端到端联调 + 真机测试 | 全部 |

---

## 9. 风险清单

| 风险 | 等级 | 应对 |
|---|---|---|
| 忘记在后台声明隐私协议 → openid 带 `temp-` 前缀 | 🔴 高 | P0 排最前；加启动自检，检测到 temp- 前缀直接告警 |
| `wx.request` 域名白名单未配 | 🔴 高 | 上线前用开发者工具"不校验域名"测通，再正式配置 |
| AppSecret 泄漏 | 🟡 中 | 只存后端 `.env`，不进包体，不写日志 |
| LLM 额度被多人刷爆 | 🟡 中 | 现有按 IP 限流在多用户下会误伤同 IP 用户 → **需改为按 userId 限流** |
| 存量数据归属错误 | 🟡 中 | migration v3 统一重命名为 `admin`，执行前先备份 `data/` |
| `session_key` 下发前端 | 🟢 低 | 只在后端内存使用，永不返回 |

> ⚠️ 限流那条要特别说：现有 `rateLimit.ts` 是 `express-rate-limit` 默认按 IP。
> 多人场景下同一 WiFi 下的用户会共享同一个 IP 配额，可能互相误伤；
> 反之若改成按 userId，纯刷接口的防护就弱了。**建议双轨：IP 限流 + userId 限流叠加。**

---

## 10. 待主人确认

1. **H5 端是否也要支持多用户？** 还是仅小程序多人、H5 只作主人自己的管理端？
2. **H5 用邀请码还是账号密码？** 邀请码最省事；密码要加注册流程。
3. **是否需要昵称/头像？** 建议不要（见 §2.2）。
4. **是否现在就动手？** 还是先只做 P0 隐私声明，把微信后台那块先落地。

---

## 11. 实施结果（2026-10-31 完工）

### 11.1 新增文件

| 文件 | 职责 |
|---|---|
| `backend/src/services/auth.service.ts` | openid 换取、token 签发/校验/注销、邀请码用户、随机昵称、数据删除 |
| `backend/src/services/ollama.client.ts` | Ollama 原生 `/api/chat` 客户端（think:false 生效） |
| `backend/src/routes/auth.routes.ts` | 公开登录路由 + 受保护会话路由 + `/api/me/data` |
| `backend/src/middleware/context.ts` | `requireUserId(req)` 统一取值，缺失时抛 401（不静默兜底） |
| `backend/src/types/express.d.ts` | `req.userId` 类型声明 |
| `miniprogram/utils/auth.ts` | 静默登录（wx.login）、单飞锁、token 存取、401 重登 |
| `backend/test/api.multiuser.test.ts` | 11 个多用户隔离测试 |

### 11.2 改动文件

| 文件 | 改动 |
|---|---|
| `backend/src/db/migrate.ts` | 新增 migration v3：`users` / `auth_sessions` 表 + 存量数据重命名为 `admin` |
| `backend/src/middleware/auth.ts` | 从"验令牌"升级为"解析出 req.userId"，支持三种凭证 |
| `backend/src/config/env.ts` | 新增 `ollama` provider、`WECHAT_APP_ID/SECRET`、`INVITE_CODES`；mock 强制用预设模型名 |
| `backend/src/app.ts` | 拆分登录路由与受保护路由的挂载点 |
| `backend/src/routes/{chat,sessions,words,profile,scenes}.routes.ts` | `DEFAULT_USER_ID` → `requireUserId(req)` |
| `backend/src/services/llm.service.ts` | 工厂接入 `OllamaNativeClient` |
| `miniprogram/utils/request.ts` | 令牌来源改为 Storage；401 自动重登重试一次；修复注释与实现不一致 |
| `miniprogram/utils/sse.ts` | 流式请求前先确保登录 |
| `miniprogram/utils/storage.ts` | 新增管理员令牌存取 |
| `miniprogram/config.ts` | **移除明文 `ACCESS_TOKEN`**（原硬编码在包体内，可被反编译） |
| `miniprogram/speech/wechatSi.ts` | TTS 下载带登录态令牌 |
| `miniprogram/pages/settings/*` | 新增当前账号、访问令牌录入、清除我的数据 |
| `miniprogram/pages/privacy/privacy.wxml` | 补 openid 条目 + 删除权 |

### 11.3 验证结果

- **类型检查**：前后端均通过
- **测试**：14 个文件 / **200 个用例全部通过**（原 189 + 新增 11）
- **迁移**：实测 `user_version` 2 → 3，13 个会话 + 21 条消息从 `default` 重命名为 `admin`
- **端到端**：真实 Ollama 对话跑通，首字 0.11s、完整响应 2.6s、纠错正常识别
  （"I very like" → "I really like"、"deploy" → "deployed"）

### 11.4 后台配置完成情况（2026-11-01）

| # | 项 | 状态 |
|---|---|---|
| 1 | 微信《用户隐私保护指引》声明 openID + 勾选 `wx.login` | ✅ **主人已完成并通过审核** |
| 2 | 后端地址加入 request 合法域名 | ✅ **主人已完成（原本就在）** |
| 3 | `WECHAT_APP_ID` | ✅ 写入本机 backend/.env（与小程序 AppID 一致；勿提交真实值） |
| 3 | `WECHAT_APP_SECRET` | ⏳ **需主人手动填**：公众平台 → 开发管理 → 开发设置 → AppSecret → 重置 |
| 4 | `INVITE_CODES` | ✅ 已生成 3 个强随机邀请码并写入 `.env` |
| — | 重启后端 | ⏳ **需管理员权限**，已备好 `scripts/restart-service.cmd` |

**邀请码（每个码对应一个独立账号，隔离生效）**：

| 用途 | 邀请码 | 派生账号 id |
|---|---|---|
| 主人本人 | `<invite-code-owner>` | `inv_<hash>` |
| 受邀用户 A | `<invite-code-a>` | `inv_<hash>` |
| 受邀用户 B | `<invite-code-b>` | `inv_<hash>` |

**实测验证**：三个码 → 三个不同账号；同一码重复登录 → 同一账号；无效码 → 401。

### 11.5 ⚠️ 后端重启的权限约束

后端由 **NSSM 注册为 Windows 服务**（服务名 `SpeakMate`，`StartMode: Auto`），
以 SYSTEM 身份运行，当前 WorkBuddy 会话**非管理员**，因此无法停止/启动它：

- `Restart-Service` → `Cannot open 'SpeakMate' service`（需管理员）
- `Stop-Process` → 拒绝访问（SYSTEM 进程）
- `sc.exe` → 被沙箱程序黑名单拦截

**解决**：已生成 `scripts/restart-service.cmd`，右键「以管理员身份运行」即可。
脚本会自动检查管理员权限、检查 AppSecret 是否配置、重启服务并打印健康检查结果。

> 现有进程 PID 31948 是 **2026-10-28 22:35** 启动的旧代码，需重启才会加载新逻辑。
> 佐证：旧代码的 `/api/tts` 不受鉴权保护（返回 200），新代码受保护（返回 401）。
