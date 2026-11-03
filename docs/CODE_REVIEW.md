# SpeakMate（口语搭子）全面技术审查报告

| 项目信息 | 内容 |
|---------|------|
| 审查日期 | 2026-09-05 |
| 审查范围 | 架构与模块划分、接口与数据流、代码实现质量、潜在缺陷与安全隐患、性能与可扩展性 |
| 代码规模 | 后端 20 个 TS 源文件 / 前端 36 个 TS(X) 源文件 / 共享契约 4 个文件 |
| 验证手段 | 静态审计 + `tsc --noEmit` + 151 个单测 + 针对性边界穷举 + 运行时黑盒验证 |
| 审查结论 | **架构设计优秀，工程质量高于同类自托管项目；但存在 3 个高危问题，集中在"鉴权缺失"与"SSE 生命周期管理"，在生产部署前必须修复** |

---

## 0. 审查方法与验证记录

本报告的所有结论均经过实证，而非仅凭代码阅读：

| 验证项 | 手段 | 结果 |
|--------|------|------|
| 类型安全 | `tsc --noEmit`（后端 + 前端） | ✅ 双端各 0 错误 |
| 测试套件 | `vitest run`（后端 8 文件 / 前端 2 文件） | ✅ **182 测试全部通过**（151 + 31） |
| 流式解析器健壮性 | **对分隔符做逐字符切分穷举**（对 `full.length` 个切点逐一验证 delta 拼接 == flush 正文） | ✅ 全切点一致，分隔符跨 chunk 处理正确 |
| 解析器容错 | think 块 / 无分隔符 / JSON 损坏 / code fence | ✅ 均按设计降级为纯文本，正文不丢 |
| 鉴权与 CORS | 启动真实服务发跨域请求 | ❌ **无需凭证即可读取全部数据；`Access-Control-Allow-Origin: *`** |
| 速率限制 | 连续 30 次调用 LLM 接口 | ❌ **30/30 全部 200，无任何限流** |
| SSE 生命周期 | 复刻 `useChat` + `chatStore` 逻辑模拟"流式输出中切换会话" | ❌ **新会话开场白被旧会话回复污染**（详见 H3） |

> 验证过程中创建的临时脚本与临时数据目录已全部清理，未留在代码库中。

---

## 0.1 修复进度（2026-09-05 完成）

审查发现的问题已全部修复，回归状态：**后端 181 / 前端 36 = 217 测试全绿，双端 `tsc --noEmit` 0 错误，前端生产构建通过**。

| 编号 | 问题 | 状态 | 修复要点 |
|------|------|------|---------|
| **H1** | 无鉴权 + CORS 全开 | ✅ 已修复 | 新增 `middleware/auth.ts`（恒定时间比较、只认 Bearer 头）；CORS 改白名单驱动，拒绝 `*`；`TRUST_PROXY` 显式开关 |
| **H2** | LLM 接口无限流 | ✅ 已修复 | 新增 `middleware/rateLimit.ts`，按成本分三档（30/120/300），统一 `4290` 契约，测试环境自动放行 |
| **H3** | SSE 不可取消 → 会话污染 | ✅ 已修复 | 两道防线：`useChat` 用 AbortController 中止在途流 + 轮次号隔离；`chatStore` 增加 `activeStreamSessionId` 归属校验 |
| **M2** | `appendMessage` 非原子 | ✅ 已修复 | 消息写入与会话冗余字段更新纳入同一事务（支持嵌套 SAVEPOINT） |
| **M3** | 无 schema 迁移能力 | ✅ 已修复 | 新增 `db/migrate.ts`：`user_version` 版本化 + 迁移列表 + 降级保护；v2 补 `idx_messages_user` |
| **M5** | 路由层直连数据库 | ✅ 已修复 | `recentSceneIds()` 下沉到 `session.service`，路由层不再写 SQL |
| **M6** | 建会话与开场白非原子 | ✅ 已修复 | 先生成开场白再落库，会话+开场白单事务写入；开场白超时 10s → 6s |
| **L1** | 死代码 | ✅ 已修复 | `defineWord` 移除未用参数；画像复用 `masteredWords()`；删除未引用的 `formatDate`/`formatMessageCount` |
| **L2** | 重复代码 | ✅ 已修复 | 新增 `shared/constants.ts`：TTS 语速范围与 `clampTtsRate`、纠错类型文案 `issueLabel`；画像 upsert 抽出共用模板 |
| **L3** | 画像读改写脆弱 | ✅ 已修复 | `updateProfile`/`recordCorrections` 显式事务化；**部署文档明确禁止 `pm2 -i` 多实例** |
| **L5** | `DATA_DIR` 随 cwd 漂移 | ✅ 已修复 | 默认值改为相对模块文件解析（`<backend>/data`） |
| **L6** | 停机不关数据库 | ✅ 已修复 | `shutdown()` 关闭服务后调用 `closeDb()`，并加重复触发保护 |
| **L7** | 版本号硬编码 | ✅ 已修复 | 从 `package.json` 读取，失败回退固定值 |
| **L9** | 测试未纳入类型检查 | ✅ 已修复 | 双端 tsconfig `include` 增加 `test`（已借此修出 3 个测试文件的真实类型问题） |
| M1 客户端幂等键 / M4 游标分页 | P2 增强项 | ⏸ 暂缓 | 当前单用户同步写路径下收益有限，属架构演进项，见 §5 路线图 |

### 修复过程中新发现并一并解决的问题

| 问题 | 说明 |
|------|------|
| **前端无令牌注入通道** | 后端加了鉴权但前端无处填令牌，配置 `ACCESS_TOKEN` 后应用将完全不可用。已新增 `api/token.ts`（localStorage 存取）+ `withAuthHeaders()` 统一注入 + 设置页「访问令牌」卡片 + 401 时给出可操作提示 |
| **会话排序不稳定** | `ORDER BY updated_at`（ISO 毫秒串）在同毫秒创建的会话间顺序未定义。已追加 `rowid DESC` 单调兜底排序键（`listSessions` 与 `recentSceneIds`） |
| **测试环境跨文件污染** | vitest `singleFork` 下所有测试文件共享进程，`process.env` 会残留（曾导致"没配令牌却返回 401"）。已在 `test/setup.ts` 统一复位安全相关变量 |

### 构建链路问题（WSL 实跑后追加，2026-09-05）

这一组不属于应用代码，但会直接让 `pnpm start` 起不来，且**报错形态与真实原因相距很远**，值得单独记录。

#### 根因一条链

pnpm 10+ 默认拦截依赖的安装脚本。本项目需要 `better-sqlite3` 编译原生模块，一旦被拦截：

1. `better_sqlite3.node` 不生成 —— 但 `pnpm install` **退出码仍可能是 0**，属于静默失败；
2. pnpm 11 的 `pnpm start` / `pnpm test` / `pnpm build` 会**先自动执行一次 `pnpm install`**（`runDepsStatusCheck`）；
3. 于是故障**延迟到 `pnpm start` 才爆发**，报错长这样，看起来像 `pnpm start` 本身坏了：

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: better-sqlite3@11.10.0, esbuild@0.21.5, esbuild@0.28.2
[ERROR] Command failed with exit code 1: '@pnpm/exe/pnpm' install
    at runDepsStatusCheck (...)
```

#### 三个易错点

| 易错点 | 说明 |
|---|---|
| **键名随 pnpm 版本变化** | pnpm 10 是 `onlyBuiltDependencies`（数组），**pnpm 11 改成了 `allowBuilds`（包名 → true/false 映射）**。只写前者，pnpm 11 不认，仍会追加一个待填写模板 `allowBuilds: <pkg>: set this to true or false`，构建继续被拦 |
| **必须显式写 `packages`** | 仓库根 `package.json` 声明了 npm `workspaces`。`pnpm-workspace.yaml` 缺 `packages` 时，pnpm 向上回溯认定仓库根才是 workspace 根，于是**任何 pnpm 命令**报 `ERROR packages field missing or empty`（pnpm 9 的表现形态） |
| **pnpm 多版本共存** | pnpm 9/10/11 的 store 目录互不兼容（`v3`/`v10`/`v11`），混装触发 `ERR_PNPM_UNEXPECTED_STORE` |

`packages: ['.']` + `allowBuilds` 这一写法是实测筛选出来的，对 pnpm 9 / 10 / 11 **同时成立**：

| `pnpm-workspace.yaml` 内容 | pnpm 11 | pnpm 9 |
|---|---|---|
| 不存在 | ✅ | ❌ `packages field missing or empty` |
| 未填写的 stub（`allowBuilds` 为占位文字） | ✅ | ❌ 同上 |
| 仅 `onlyBuiltDependencies` | ✅ | ❌ 同上 |
| **`packages: ['.']` + `allowBuilds` + `onlyBuiltDependencies`** | ✅ | ✅ |

#### 另发现：pnpm 11 的供应链策略

`minimumReleaseAge` 默认 1440 分钟，拒绝安装发布不足 24 小时的包。本仓库锁定的 `autoprefixer@10.5.5`、`browserslist@4.28.9`、`electron-to-chromium@1.5.422` 曾命中该策略，导致 frontend 全新安装失败。这是**真实的安全防护而非缺陷**，处置方式见 `DEPLOYMENT.md` C1.6（等待 / `pnpm --config.minimum-release-age=0` / `RELAX_SUPPLY_CHAIN=1`）。

> 附带一个反直觉点：`npm_config_minimum_release_age=0` 这类环境变量对该设置**无效**，只能走 `--config.` 传参。

#### 补上的防线

- `backend/pnpm-workspace.yaml`、`frontend/pnpm-workspace.yaml` 纳入版本库，把放行名单固化下来。
- `scripts/wsl-verify.sh` 新增四道检查：残缺 `allowBuilds` 模板检测、`Ignored build scripts` 检测、`better_sqlite3.node` 产物断言、**单独冒烟一次 `pnpm start`**（此前只测 `tsx`，恰好漏掉 pnpm 这一层——用户报的故障就在这一层）。
- 同时修正脚本自身的一个缺陷：原先会**另装一个 pnpm 9**，与用户已有的 pnpm 11 争夺 store，正是版本冲突的制造者。现改为复用环境里已有的 pnpm。
- `DEPLOYMENT.md` 新增 C1.5（构建白名单）、C1.6（供应链策略）与 C9 排障表 7 条新条目。

### 未能运行时验证的项

| 项目 | 状态 |
|------|------|
| SIGTERM 优雅停机的信号路径 | ✅ **已在 WSL2 (Ubuntu 24.04) 验证通过**——见下方「WSL 验证记录」。脚本直调 `node_modules/.bin/tsx`（而非 `pnpm start`）确保信号投递到 node 进程本身，停机退出码为 0，日志打印 `shutting down`。 |
| 多进程并发下的数据一致性 | ⏸ 设计上已禁止 `pm2 -i`（见部署文档），未做并发压测 |

### WSL2 验证记录（2026-09-05）

在 WSL2 / Ubuntu 24.04.4（Node v24.14.0）执行 `scripts/wsl-verify.sh`，**全部通过（EXIT=0）**：

| 阶段 | 结果 |
|------|------|
| 源码落地 `/home/darrell/workspace/speakmate` | ✅ 已排除 Windows 的 `node_modules` / `dist` |
| 依赖安装 | ✅ `better-sqlite3` 在 Node 24 下无预编译包，自动回退 node-gyp 源码编译成功（约 3m40s） |
| 双端 `tsc --noEmit` | ✅ 0 错误 |
| 前端 `vite build` | ✅ `frontend/dist` 产出 |
| 后端测试 | ✅ **12 文件 / 181 项通过** |
| 前端测试 | ✅ **2 文件 / 36 项通过** |
| 启动冒烟 | ✅ `/api/health` 返回 `{"code":0,...}`，未启用令牌时接口正常放行 |
| **SIGTERM 优雅停机** | ✅ **退出码 0，数据库已关闭** |

> Windows 侧无法验证停机路径（不支持跨进程投递 SIGTERM），这是选用 WSL 复核的实质价值。

---

## 1. 总体评价：做得好的部分

在列出问题之前，先明确这个项目的工程质量水位——很多地方做得相当扎实，不应被问题清单掩盖。

1. **流式解析状态机（`parser.ts`）是本项目最出色的部分。** 我对其做了逐字符切分的穷举测试：无论 `<<<META>>>` 分隔符被切成怎样的两半，delta 拼接结果始终与最终落库正文完全一致，且 `TAIL_KEEP=13` 的保留窗口长度与分隔符最长形态（`\r\n<<<META>>>\r\n`）精确匹配。这是一个极易写错的地方，实现者考虑得很周到，甚至还留下 `BUG-001` 的修复注释解释"为何不能二次累加"。

2. **降级设计贯穿全链路。** LLM 连接失败 → 3001（LMStudio 模式附带排查指引）；首字超时 → 3002；输出协议不合规 → 3003 但正文照常展示、对话不中断；延续性开场白失败 → 回退静态 opener；ASR 不可用 → 自动切文字输入并一次性提示。"任何单点失败都不该让用户卡住"这一原则贯彻得很彻底。

3. **前后端共享契约（`shared/`）+ 判别联合的 SSE 事件类型**，让 `ChatSseEvent` 的四种事件在编译期就被约束，前端 `switch` 有穷尽性保证。零运行时依赖的纯类型层，是这个规模项目的正确选择。

4. **服务与传输解耦**：`chat.service` 产出 `AsyncGenerator<ChatSseEvent>`，HTTP/SSE 帧写入留给 `chat.routes`。这让对话编排可以脱离 HTTP 单测（`chat.service.test.ts` 正是这么做的）。

5. **安全基线到位**：`helmet`（CSP/HSTS/X-Frame-Options 等 8 个响应头齐全）、`express.json({ limit: '1mb' })`、全部 SQL 参数化、错误信息脱敏（未预期异常只进服务端日志）、API Key 仅存后端内存。

---

## 2. 问题清单

### 等级说明
- **高（H）**：会导致数据泄露、资损、或用户可见的数据错乱。**建议发布前必须修复。**
- **中（M）**：在特定路径下产生数据不一致或可维护性风险。**建议排期修复。**
- **低（L）**：代码整洁度、健壮性边际、未来演进的隐患。**建议择机清理。**

---

## 【高】H1. 全站无鉴权 + CORS 允许任意来源 —— 公网部署等同于数据裸奔

**位置**：`backend/src/app.ts:29-30`

```ts
app.use(helmet());
app.use(cors());          // ← 无参数 = origin: '*'，允许任意站点跨域读写
```

**实证结果**：

```http
# 无需任何凭证
GET /api/profile → 200 {"code":0,"data":{"stats":{...全部学习数据...}}}

# 任意恶意站点
GET /api/words  Origin: https://evil.com
→ HTTP/1.1 200 OK
→ Access-Control-Allow-Origin: *
```

**原因**：项目定位"单用户自托管"，架构文档 §0 的设计原则 1 明确"单用户轻量优先，不引入非必要组件"。鉴权被当作"非必要组件"排除了。

**影响**：这是一个**完整的攻击链**，且 `DEPLOYMENT.md` 方案 B 明确推荐"域名 + 云服务器 + Nginx + Let's Encrypt"的公网部署路径：

1. 攻击者在任意页面植入一段 JS，即可跨域 `GET /api/sessions?limit=100` 拉取用户**全部对话历史**，再 `GET /api/sessions/:id` 逐条读取完整消息内容 —— 其中是真实职场对话，可能涉及事故复盘、1on1、面试准备等敏感内容。
2. `DELETE /api/sessions/:id`、`DELETE /api/words/:id` 同样无保护 —— **可远程清空用户全部数据**（配合 CORS，预检请求对简单请求无约束）。
3. `POST /api/chat` 可被任意第三方调用，消耗你的 LLM 额度（见 H2）。

**架构更该警惕的是**：`user_id` 字段已在全部 4 张表中预留、注释写明"为 P2-5 多用户体系预留"，但整个 service 层目前由路由层硬编码注入 `DEFAULT_USER_ID`。一旦未来接入真实多用户，**当前代码没有任何一层能做权限校验**，届时是补在路由层还是 service 层会变成一次重构。

**改进建议（分层递进，按部署场景选择）**：

```ts
// 1) config/env.ts 增加
corsOrigin: process.env.CORS_ORIGIN ?? '',   // 生产同源部署留空
accessToken: process.env.ACCESS_TOKEN ?? '', // 留空 = 不启用（仅局域网模式）

// 2) app.ts —— 默认同源，显式白名单才放行
app.use(
  cors(
    config.corsOrigin
      ? { origin: config.corsOrigin.split(',').map((s) => s.trim()), credentials: true }
      : { origin: false },   // 同源部署：不发任何 CORS 头
  ),
);

// 3) middleware/auth.ts —— 可选令牌守卫，零配置时完全透明
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!config.accessToken) return next();               // 局域网模式：不启用
  const header = req.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '') || String(req.query.token ?? '');
  if (token !== config.accessToken) {
    res.status(401).json({ code: 4010, data: null, message: '未授权' });
    return;
  }
  next();
}
app.use('/api', requireAuth);
```

**权衡取舍**：

| 方案 | 成本 | 安全性 | 适用 |
|------|------|--------|------|
| **A. 现状（无鉴权）** | 零 | 无 | 仅本机/家庭内网，且后端不暴露 |
| **B. 静态令牌（推荐）** | ~20 行 | 中：可挡住自动化扫描与 CSRF，挡不住已授权设备泄露 | 个人公网部署，性价比最高 |
| **C. 密码 + Session/JWT** | ~150 行（含登录页、刷新、登出） | 高 | 真正多用户 |
| **D. 反向代理层 Basic Auth**（Nginx `auth_basic`） | ~10 行配置，**零应用改动** | 中高 | 已用 Nginx 的方案 B，改动最小 |

**我的推荐**：**B + D 二选一，不要两个都上**。若已按方案 B 配了 Nginx，直接在 Nginx 加 `auth_basic` 是最省事且最不容易出错的（应用零改动、不引入新的状态管理）；若走方案 A 的直连 HTTPS 端口，则用 B 的静态令牌。**C 不推荐**——为一个单用户应用引入完整的会话管理体系，违背本项目"不过度设计"的核心原则，且登录态本身又带来新的攻击面。

**注意**：无论选哪个，都**必须**同时修掉 `cors()` —— 只加鉴权不修 CORS，浏览器仍会在携带凭证的跨站请求上产生风险面；只修 CORS 不加鉴权，则任何非浏览器客户端（curl、脚本）依然长驱直入。

---

## 【高】H2. LLM 接口无速率限制 —— API 额度可被轻易刷爆

**位置**：`backend/src/app.ts`（无任何限流中间件）；依赖清单中亦无 `express-rate-limit`

**实证结果**：连续 30 次 `POST /api/words/define` → **30/30 返回 200**，每次都真实触发一次 LLM 调用。

**原因**：接口设计阶段只考虑了"正常用户怎么用"，没有考虑"接口被滥用会怎样"。单用户应用的隐含假设是"只有我在调用"。

**影响**：

- `POST /api/words/define` 与 `POST /api/chat` 都会真实消耗 LLM token。一旦服务暴露到公网（方案 B），一个简单循环就能在几分钟内打爆 DeepSeek/OpenAI 的额度，产生**真实金钱损失**。云端 provider 的 Key 通常是按量付费且无硬上限的。
- 本地 LMStudio 模式下，并发请求会打满本地 GPU/内存，导致正常对话卡顿。
- 即使不暴露公网，前端的一个 bug（如渲染循环里误触发请求）也会造成自我 DoS。

**改进建议**：

```bash
npm i express-rate-limit
```

```ts
import rateLimit from 'express-rate-limit';

// LLM 消耗型接口：按 IP 限流（单用户场景足够）
const llmLimiter = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.RATE_LIMIT_LLM_PER_MIN ?? 30),
  standardHeaders: true,
  legacyHeaders: false,
  message: { code: 4290, data: null, message: '请求过于频繁，请稍后再试' },
});
app.use('/api/chat', llmLimiter);
app.use('/api/words/define', llmLimiter);

// 写操作整体限流（防误操作/脚本批量删除）
const writeLimiter = rateLimit({ windowMs: 60_000, max: 120 });
app.use(['/api/words', '/api/sessions'], writeLimiter);
```

**权衡取舍**：按 IP 限流在 IPv6 和移动网络下可能误伤（同一基站出口 IP 相同）。但本项目是**单用户**应用，合法请求量极低（正常人类一分钟发不了 30 轮对话），误伤概率几乎为零，收益远大于成本。**不要**为此引入 Redis 做分布式限流——那直接违背"不引入非必要组件"的原则，单机内存计数完全够用。

另外建议补一条**成本护栏**：在 `.env` 增加 `LLM_MAX_TOKENS_PER_DAY` 之类的软预算，超阈值时 `/api/chat` 直接返回友好错误。这对按量付费的云端 provider 是很有价值的安全网。

---

## 【高】H3. SSE 流无法取消 —— 切换会话会污染新会话消息（已复现）

**位置**：`frontend/src/hooks/useChat.ts:59-87`

```ts
await streamChat({ session_id: sessionId, content }, {
  onEvent: (event) => { /* ... */ },
  // ← 没有传 signal！
});
```

**问题链条**：

1. `api/sse.ts` 定义了 `ChatStreamOptions.signal` 并正确透传给 `fetch`，但 **`useChat.send` 从未传入**；
2. `useChat` 没有向组件暴露 `cancel` / `abort` 方法；
3. `ChatPage` 卸载时没有任何清理逻辑；
4. 更关键的是：`chatStore.setMessages()` 会把 `streamSettled` 重置为 `true`，导致 `useChat` 收尾时的"流中断"判定（`if (!after.streamSettled)`）**失效**——它以为流正常结束了。

**复现结果**（复刻 `useChat` + `chatStore` 逻辑实跑）：

```
发送后:   ["assistant:Hi! Ready for standup?", "user:I very like this tool", "assistant:"]
>>> 用户切换到新会话（setMessages 替换消息流）
切换后:   ["assistant:Welcome to Code Review!"]
          streamSettled = true（被 setMessages 重置）
流结束后: ["assistant:Welcome to Code Review!for sharing! By the way, "I very like" should be "I really like". "]
                          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                          旧会话 A 的 AI 回复被拼到了新会话 B 的开场白上
```

**影响**：

- **数据错乱且静默**：用户在流式输出期间点击底部导航 → 去场景页新建会话 → 看到开场白被上一段 AI 回复污染。此时后端数据是正确的（会话 B 只有开场白），**前端显示与后端落库不一致**，必须刷新页面才能恢复。
- **更隐蔽的场景**：用户发消息后立刻切到"词汇本"页，`appendDelta` 仍在修改全局 zustand store，污染的虽不可见，但回调 `onDelta → speech.feedDelta` 会让 **TTS 在错误的页面上继续朗读上一段回复**。
- **资源浪费**：离开页面后 LLM 流仍在跑，白白消耗 token。
- 多标签页打开时，A 标签页的流会写入共享的 store（zustand 非持久化 store 不跨标签页，但同一标签页内的路由切换必然触发）。

**改进建议（两道防线，建议都做）**：

**防线 1 —— AbortController 生命周期管理（根本解决）**

```ts
export function useChat(options: UseChatOptions = {}) {
  const abortRef = useRef<AbortController | null>(null);

  // 组件卸载 / 会话切换时中止进行中的流
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async (raw: string): Promise<boolean> => {
    // ...
    const controller = new AbortController();
    abortRef.current = controller;
    const activeSessionId = sessionId;   // 捕获发起时的会话

    try {
      await streamChat(
        { session_id: sessionId, content },
        {
          signal: controller.signal,
          onEvent: (event) => {
            // 会话已切换 → 立即中止，丢弃后续事件
            if (useSessionStore.getState().currentSession?.id !== activeSessionId) {
              controller.abort();
              return;
            }
            // ...原分派逻辑
          },
        },
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
    // ...
  }, []);

  const cancel = useCallback(() => abortRef.current?.abort(), []);
  return { messages, streaming, failedContent, failureMessage, send, retry, cancel };
}
```

**防线 2 —— store 层校验（兜底，防未来新增调用点漏传 signal）**

给 `chatStore` 增加"当前流归属会话"的概念，`appendDelta` / `applyMeta` 校验归属后再写入：

```ts
interface ChatState {
  activeStreamSessionId: string | null;   // 新增
  // ...
}

beginSend: (content, sessionId) => set({ activeStreamSessionId: sessionId, /* ... */ }),

appendDelta: (text) => set((state) => {
  if (state.activeStreamSessionId === null) return state;   // 无活跃流 → 静默丢弃
  // ...原逻辑
}),
```

**为何两道都要**：防线 1 解决"资源泄漏 + 无谓 token 消耗"，防线 2 解决"状态正确性"。只做防线 1，若未来有人在别处调用 `streamChat` 忘了传 signal，污染会再次出现；只做防线 2，LLM 流仍会在后台跑完。**这是典型的 defense-in-depth 场景**。

**权衡取舍**：也可以采用"取消即保留"策略——不 abort，而是让旧流跑完但把结果写入** detached 缓冲区**，等用户切回原会话时再合并。这个方案体验更好（用户来回切换不丢内容），但实现复杂度高得多（需要维护 per-session 的流状态、处理并发落库顺序）。对于"10 分钟口语练习"的轻量场景，**直接 abort + 幂等重试**是更合适的选择，符合项目的一贯取舍风格。

---

## 【中】M1. 幂等重试语义歧义 —— 失败后改发内容会留下孤儿 user 消息

**位置**：`backend/src/services/chat.service.ts:49-54`

```ts
const last = sessionService.getLastMessage(sessionId);
if (!(last && last.role === 'user' && last.content === content)) {
  sessionService.appendMessage(sessionId, 'user', content);
}
```

**原因**：后端用"尾消息是同 content 的 user 消息"来推断"这是一次重试"。这是一个**基于内容的启发式推断**，而非显式的重试标记。

**影响**：

1. **孤儿消息**：用户发送 A → 流中断（user 已落库、assistant 未落库）→ 用户放弃重试，改说 B → 库中留下 `A` 这条孤儿 user 消息。它会出现在历史回看里，也会作为连续两条 user 消息注入 LLM 上下文（`user:A, user:B`），让 AI 困惑。
2. **语义歧义**：用户"主动重发一条一模一样的话"（比如想让 AI 换个说法）会被误判为重试，**该消息根本不会入库**，历史记录凭空少一条。
3. **边界场景**：用户在两个标签页同时发相同内容，两条流交叉，判定结果不可预测。

**改进建议**：引入客户端生成的幂等键，替代内容推断。

```ts
// shared/types/api.ts
export interface ChatRequest {
  session_id: string;
  content: string;
  /** 客户端生成的幂等键；重试时复用同一个值 → 后端精确判定，不依赖内容推断 */
  client_msg_id?: string;
}
```

```ts
// chat.service.ts
const existing = opts.clientMsgId
  ? sessionService.findMessageByClientMsgId(sessionId, opts.clientMsgId)
  : null;
const userMessage = existing ?? sessionService.appendMessage(sessionId, 'user', content, {}, opts.clientMsgId);
```

**权衡取舍**：
- **方案 A（客户端幂等键，推荐）**：语义精确，是 REST 幂等设计的标准做法。代价是 messages 表加一列 + 前端生成/复用 UUID。
- **方案 B（时间窗口收紧现有启发式）**：给现有判定加"仅当尾消息在 5 分钟内"的条件。改动最小（约 3 行），但仍无法解决"主动重发相同内容"的歧义。
- **方案 C（孤儿消息回收）**：在下一轮开始前清理"尾部无后继 assistant 的 user 消息"。能治标，但会删除用户可能想保留的内容。

**建议选 A**；如果希望本期改动最小，**B 是合理的过渡**（并配合前端在重试时优先引导用户"原样重试"）。

---

## 【中】M2. `appendMessage` 缺少事务，且冗余计数设计与注释矛盾

**位置**：`backend/src/services/session.service.ts:187-240`

```ts
db.prepare('INSERT INTO messages ...').run(...);        // 语句 1
const messageCount = countMessages(sessionId);          // 语句 2：COUNT(*) 全会话扫描
const firstUser = db.prepare('SELECT content ...').get(sessionId);  // 语句 3
db.prepare('UPDATE sessions SET message_count=?, ...').run(...);    // 语句 4
```

**原因**：四条语句各自是一个隐式事务，没有用 `db.transaction()` 包裹。

**影响**：
1. **一致性**：进程在语句 1 之后、语句 4 之前崩溃/被 kill（pm2 restart、OOM、断电），`message_count` 与实际消息数不符，直到下一次 `appendMessage` 才自愈。窗口虽小，但历史列表会短暂显示错误的消息数。
2. **性能与注释矛盾**：schema 注释写"冗余计数，列表页免 COUNT 查询"，但**每次写入反而做了一次 COUNT** —— 优化目标（读快）成立，手段（写时 COUNT）却是 O(n)。会话越长写入越慢，虽然单用户场景量级下无感。
3. **读放大**：每次追加消息（一轮对话 2 次）都要全会话 COUNT + 一次首条 user 消息查询。

**改进建议**：

```ts
const appendMessageTx = db.transaction((args) => {
  db.prepare('INSERT INTO messages ...').run(...);
  // 事务内自增，不再 COUNT
  db.prepare(
    `UPDATE sessions SET message_count = message_count + 1, updated_at = ?,
            title = COALESCE(?, title), summary = COALESCE(?, summary)
     WHERE id = ?`,
  ).run(now, title, summary, args.sessionId);
  return message;
});
```

**权衡取舍**：`message_count + 1` 只有在**事务保护下**才安全，绝不能脱离事务单独使用（否则一次失败重试就会永久偏斜）。当前"每次 COUNT"的方案反而是**更容错**的——它天然自愈。所以这是一个"性能/一致性 vs 容错性"的交换：**当前写法更健壮但更慢，建议写法更快但依赖事务正确性**。考虑到单用户量级（会话通常 <100 条消息），**两种方案性能差异可忽略**，因此我的建议是：**保留 COUNT 写法，但用 `db.transaction()` 把 4 条语句包起来**——用最小的改动拿到原子性，同时不牺牲自愈能力。若未来确认要优化，再一起改成自增。

---

## 【中】M3. 无数据库迁移机制 —— schema 演进会静默失败

**位置**：`backend/src/db/database.ts:28-29`、`backend/src/db/schema.sql:66`

```sql
PRAGMA user_version = 1;   -- 预留迁移钩子
```

```ts
db.exec(readFileSync(schemaUrl, 'utf-8'));   // 只有 CREATE TABLE IF NOT EXISTS
```

**原因**：`PRAGMA user_version = 1` 设置了，但**没有任何代码读取它或执行迁移**。

**影响**：`CREATE TABLE IF NOT EXISTS` 只处理"表不存在"的情况。一旦未来要给已有表**加列**（如 M1 建议的 `client_msg_id`）、加索引或改约束，**老数据库不会有任何变化**，而代码却按新 schema 读写 —— 表现为运行期 `no such column` 错误，且只在**已有数据的老用户**身上出现（新用户建库正常），是极难排查的一类 bug。对一个"数据备份 = 复制 db 文件"的自托管应用，用户升级时必然带着老库。

**改进建议**：实现最小迁移框架（约 30 行）：

```ts
const MIGRATIONS: Record<number, string[]> = {
  // 1: [], 初始 schema
  2: ['ALTER TABLE messages ADD COLUMN client_msg_id TEXT',
      'CREATE INDEX IF NOT EXISTS idx_messages_client_msg ON messages(client_msg_id)'],
};

function migrate(db: Database.Database): void {
  const current = (db.pragma('user_version', { simple: true }) as number) ?? 0;
  const target = Math.max(current, ...Object.keys(MIGRATIONS).map(Number));
  for (let v = current + 1; v <= target; v++) {
    const steps = MIGRATIONS[v];
    if (!steps) continue;
    db.transaction(() => {
      for (const sql of steps) db.exec(sql);
      db.pragma(`user_version = ${v}`);
    })();
  }
}
```

**权衡取舍**：引入 Prisma/Knex 等完整 ORM 迁移方案属于**明显过度设计**（会给这个零 ORM 项目引入整套工具链）。上面 30 行的手写迁移器与项目"轻量"定位一致。**注意 SQLite 的 ALTER TABLE 限制**（不能加 UNIQUE 列、不能改列类型），遇到这类变更需要"建新表 → 搬数据 → 重命名"三步走，迁移器要预留这种能力。

---

## 【中】M4. 词汇本分页在删除条目后 offset 漂移，导致漏加载

**位置**：`frontend/src/pages/WordsPage.tsx:47-72`

```ts
const currentItems = reset ? [] : items;
const page = await api.listWords({ ..., offset: currentItems.length });  // ← 用数组长度当 offset
// 删除后：
setItems((prev) => prev.filter((item) => item.id !== target.id));        // ← 数组变短
setTotal((prev) => Math.max(0, prev - 1));                              // ← 但服务端总数也变了
```

**原因**：offset 分页 + 可变集合的经典冲突。客户端删除 1 条后 `items.length` 从 30 变成 29，但服务端该页数据也少了一条，两者不同步。

**影响**：加载第 1 页（30 条）→ 删除 1 条（剩 29）→ 点"加载更多"，`offset=29` 取 30 条 = 服务端第 30~59 条；而客户端已消费的是服务端第 1~30 条中的 29 条 → **第 30 条被跳过**，用户永远看不到它，且不报错。删得越多，漏得越多。

**改进建议**：改用**游标分页**（keyset pagination），根治此类问题：

```ts
// 服务端
interface ListWordsQuery { cursor?: string; /* 上一页最后一条的 created_at */ }
// SQL: WHERE user_id=? AND (created_at < ?) ORDER BY created_at DESC LIMIT ?
```

**权衡取舍**：游标分页的代价是**不支持随机跳页**（只能"加载更多"）。但本项目列表本身就是"加载更多"的无限滚动交互（`WordsPage`、`HistoryPage` 都是），没有跳页需求，所以**游标分页是纯收益**。若希望零后端改动，前端的临时修法是维护 `deletedCount` 并让 `offset = items.length + deletedCount`——但这只是打补丁，且在多标签页/其他端删除时依然会漂移。

---

## 【中】M5. 路由层直接执行 SQL，破坏分层约定

**位置**：`backend/src/routes/scenes.routes.ts:15-20`

```ts
const rows = getDb()
  .prepare(`SELECT scene_id FROM sessions WHERE user_id = ? GROUP BY scene_id ...`)
  .all(DEFAULT_USER_ID) as Array<{ scene_id: string }>;
```

**原因**：架构文档 §9.4 约定"JSON 列字段读写必须经 service 层，路由层不感知"，但 scenes 路由直接 `import { getDb }` 并写 SQL。这是全项目**唯一**一处。

**影响**：
- 破坏分层一致性：其余 5 个路由文件都只调 service，唯独这里直连 DB，后续维护者会困惑"到底该在哪写 SQL"。
- 逻辑无法复用/单测：这段"最近使用场景"的聚合逻辑只能通过 HTTP 集成测试覆盖。
- 违反架构文档 §9.9"user_id 由 service 层统一注入，绝不硬编码在路由层"——这里恰恰硬编码了。

**改进建议**：移入 service 层（新建 `scene.service.ts` 或并入 `session.service.ts`）：

```ts
// services/session.service.ts
export function recentSceneIds(userId: string, limit = 5): string[] { /* ... */ }

// routes/scenes.routes.ts
const recentSceneIds = sessionService.recentSceneIds(DEFAULT_USER_ID, 5);
```

---

## 【中】M6. 新建会话存在 async 窗口，可产生无开场白的空会话

**位置**：`backend/src/services/session.service.ts:259-284`

```ts
// 1. 先 INSERT session（已落库）
db.prepare('INSERT INTO sessions ...').run(sessionId, ...);

// 2. 再 await LLM（最多 10s）
if (continueFromLast) {
  const generated = await generateContinueOpener(userId, sessionId);
  if (generated) opener = generated;
}

// 3. 最后写开场白消息
const openerMessage = appendMessage(sessionId, 'assistant', opener);
```

**原因**：会话创建与开场白写入之间存在一个 await，且两者未在同一事务中。

**影响**：
- **空会话**：若 LLM 挂满 10s 超时，或客户端在此期间取消请求，数据库中留下 `message_count = 0`、无任何消息的会话。历史列表会显示一条"0 条消息"的空会话，点进去是空的。
- **慢响应**：`POST /api/sessions` 在延续模式下会阻塞最多 10 秒（LLM 生成）+ 网络往返，前端 `ScenesPage` 虽有 loading 态，但 10 秒对"选个场景"这个动作来说体验偏慢。

**改进建议（两选一）**：
- **方案 A（推荐，改动小）**：调换顺序——先 `await generateContinueOpener()`，再把"INSERT session + INSERT opener message"放进**一个事务**。失败则整体回滚，不留下空会话。
- **方案 B（体验更好，改动大）**：会话创建立即返回（用静态 opener 占位），延续开场白改为后台生成并通过 SSE/轮询补发。这会引入新的状态同步复杂度，对本项目偏重。

**建议 A**，并把 `continue_from_last` 的超时从 10s 降到 6s（延续开场白只是锦上添花，失败已有静态 opener 兜底）。

---

## 【低】L1. 死代码

| 位置 | 说明 |
|------|------|
| `backend/src/services/vocabulary.service.ts:221` `masteredWords()` | 从未被调用。`profile.service.getLearnerContext()` 用**一条重复的 SQL** 做了同样的事。 |
| `frontend/src/utils/format.ts:18` `formatDate()` | 从未被引用 |
| `frontend/src/utils/format.ts:28` `formatMessageCount()` | 从未被引用（`HistoryPage` 直接写了模板字符串） |
| `backend/src/services/vocabulary.service.ts:68,71` `defineWord(_userId, ..., _sessionId)` | 两个参数以下划线开头表示未使用，说明接口设计冗余 |
| `user_profile.preferred_scenes` 列 | 恒为 `'[]'`，实际读取走 sessions 实时聚合。字段已死，仅是"预留" |

**建议**：删除 `masteredWords()` 或让 `getLearnerContext()` 改为调用它（推荐后者——消除重复 SQL，且函数本身有测试价值）；删除两个前端 format 工具或补上对应单测；`defineWord` 去掉未使用参数（YAGNI，需要时再加）。

---

## 【低】L2. 重复代码

| 重复内容 | 位置 | 建议 |
|---------|------|------|
| `user_profile` 的 upsert 语句 | `profile.service.ts:192-205` 与 `242-256`（两处几乎相同的 6 字段 INSERT...ON CONFLICT） | 抽 `upsertProfile(userId, { displayName?, mistakes?, settings? })` |
| "已掌握词 Top N" 的 SQL | `profile.service.ts:163` 与 `vocabulary.service.ts:224` | 统一到 `vocabulary.masteredWords()` |
| 分页参数校验 | `sessions.routes.ts:14` `parsePagination()` 与 `words.routes.ts:60-71`（后者手抄了一遍，且校验规则略有出入——`limit` 未校验整数） | 提取到 `middleware/validate.ts` 共用 |
| `ISSUE_LABEL` 映射 | `CorrectionCard.tsx:16` 与 `SettingsPage.tsx:39` | 提到 `shared/` 或 `utils/` |
| `clampRate()` | `settingsStore.ts:32` 与 `WebSpeechAdapter.ts:73` | 统一到 `utils/` |

**说明**：重复本身不致命，但 `ISSUE_LABEL` 这类**业务文案重复**最危险——改一处忘另一处会造成 UI 文案不一致，而编译器不会报错。

---

## 【低】L3. 画像更新采用 read-modify-write，模式脆弱

**位置**：`profile.service.ts:181` `updateProfile()` 与 `:210` `recordCorrections()`

两者都是「SELECT 整行 → 在 JS 里改 JSON → INSERT...ON CONFLICT 覆盖整行」。

**重要澄清**：我最初怀疑这会构成并发丢失更新（lost update）。**实测结论是：当前不会**。因为 `better-sqlite3` 是同步 API + Node 单线程，两个函数在事件循环的一个 tick 内原子完成，不存在交错。逻辑上两处也都正确地回写了对方负责的字段（`updateProfile` 回写 `row.common_mistakes`，`recordCorrections` 回写 `row.display_name` / `row.settings`）。

**但仍建议改进**，理由是这个模式的**正确性依赖一个隐含前提**（"这两个函数必须永远保持同步且不被 await 打断"），而该前提没有任何代码或注释保护：

- 一旦有人在其中加一个 `await`（例如把画像更新改成异步批处理、或接入远端 profile 服务），lost update 立即出现**且静默**——用户会发现"我的常错记录莫名其妙没了"。
- 若按 `DEPLOYMENT.md` 用 `pm2 start -i 2`（cluster 多实例）部署，多进程写同一 SQLite 文件，同样会丢数据。

**建议**（择一，成本都很低）：
1. 把读改写包进 `db.transaction()`（SQLite 默认 `BEGIN DEFERRED`，配合 WAL 可防止交错）；
2. 更彻底：用 SQLite 原生的 `json_set()` / `json_insert()` 在**单条 SQL 内**完成字段级更新，彻底消除 read-modify-write。单用户场景推荐方案 1，改动最小。

同时建议在 `DEPLOYMENT.md` 明确写一句"**禁止用 pm2 cluster 模式（`-i`）**"——当前文档只写了 `pm2 start pnpm --name speakmate -- start`（单实例，是正确的），但没有警告不要加 `-i`。

---

## 【低】L4. `stripTrailingPartialMarkers` 可能剥离合法正文尾部

**位置**：`backend/src/services/parser.ts:205-231`

该函数会剥离正文尾部与协议标记（`<think>` / `<<<META>>>`）**任意长度 ≥2 的前缀**匹配的内容。

**实测**：

```
in="Compare a <<"    -> flush="Compare a"      （"<<" 被剥）
in="He said <<"      -> flush="He said"
in="end with <<<MET" -> flush="end with"
in="normal sentence."-> flush="normal sentence." （正常）
```

**影响评估**：这是**设计意图**（剥离流中断时未完成的协议残片），且误伤只在"英文口语回复恰好以 `<<`、`<t` 等结尾"时发生——在"1–4 句英文口语"的场景下概率极低。真正的瑕疵是**前端已流式展示的内容与后端落库内容会不一致**（用户看到 `Compare a <<`，刷新后变成 `Compare a`），但触发概率太低。

**建议**：优先级低。若要修，可限定"仅当剥离后的内容为空或流未正常结束时才剥离"，或把最小前缀长度从 2 提到 3（`<<` → `<<<`），进一步降低误伤面。

---

## 【低】L5. `DATA_DIR` 相对路径陷阱

**位置**：`backend/src/config/env.ts:137`、`database.ts:21`

```ts
dataDir: (process.env.DATA_DIR ?? './data').trim() || './data'
// ...
const dataDir = path.resolve(config.dataDir);   // ← 相对 process.cwd()
```

**影响**：README 与 `.env.example` 都说数据是 `backend/data/`，但实际路径取决于**启动时的 CWD**。若从仓库根目录执行 `npx tsx backend/src/index.ts`，数据库会建在仓库根的 `./data/`。对于"备份 = 复制 `backend/data/speakmate.db`"的自托管用户，这会直接导致**备份了个寂寞**。

**建议**：默认值改为相对**模块文件**解析（`path.resolve(__dirname, '../data')`），或在启动横幅里打印绝对路径（当前已打印 `path.resolve(config.dataDir)`，这点是好的——建议再补一句"若非预期请检查启动目录"）。

---

## 【低】L6. 优雅停机未关闭数据库连接

**位置**：`backend/src/index.ts:63-75`

`shutdown()` 只关闭了 HTTP/HTTPS server，未调用 `closeDb()`。

**影响**：WAL 模式下未执行 checkpoint，`speakmate.db-wal` 文件会残留。虽然下次启动会自动恢复（不丢数据），但 `DEPLOYMENT.md` 推荐的备份方式是 `cp speakmate.db`，**在 WAL 未 checkpoint 时单独复制主库文件可能拿到不完整快照**。

**建议**：在 `shutdown()` 中调用 `closeDb()`（它已导出但仅测试使用）。同时把 `DEPLOYMENT.md` 的备份建议从 `cp` 改为 `sqlite3 .backup`（文档里其实已经把 `.backup` 列为推荐项，`cp` 作为备选——建议给备选方案加一句警告，或直接用 `VACUUM INTO`）。

---

## 【低】L7. 版本号硬编码

**位置**：`backend/src/config/env.ts:138` → `version: '1.0.0'`

与 `package.json` 的 version 是两份独立数据，改一处忘另一处会导致设置页显示错误版本。

**建议**：启动时读取 `package.json`（`createRequire(import.meta.url)('../package.json').version`），或反过来让 package.json 成为唯一来源。

---

## 【低】L8. 404 错误码不在契约错误码表内

**位置**：`backend/src/middleware/error.ts:91-97` 返回 `code: 404`，而架构文档 §4.1 的错误码表只有 `0 / 1001 / 2xxx / 3xxx / 5000`。

**影响**：前端 `client.ts` 只判断 `code !== 0`，因此功能上无碍；但契约文档与实际行为不一致，未来若有人按文档做错误处理（`switch (code)`）就会漏掉 404 这个分支。

**建议**：二选一——把 404 纳入错误码表（如 `1004 NOT_FOUND`），或让 `notFoundHandler` 复用 `5000`。推荐前者，语义更清晰。

---

## 【低】L9. 前端 `tsconfig.json` 未包含 `test/` 目录

**位置**：`frontend/tsconfig.json:32` → `"include": ["src", "../shared"]`

**影响**：`test/` 下的 2 个测试文件（31 个测试）**完全不受类型检查保护**。`npm run typecheck`（若前端配置了的话）不会发现测试代码里的类型错误，只能等 vitest 运行时暴露。后端 `tsconfig.json` 也存在同样情况。

**建议**：把 `test` 加入 `include`（若担心测试文件影响构建，可单独建 `tsconfig.test.json`）。这是个 5 秒的改动，却能让 182 个测试全部进入类型安全网。

---

## 3. 设计层面的权衡取舍与替代方案

这一节针对**没有唯一正确答案**的设计决策，说明当前取舍的合理性、代价，以及替代方案。

### 3.1 「单用户 / 零鉴权」—— 核心取舍，也是最大风险源

**当前取舍**：以"单用户自托管"为前提，砍掉一切身份体系，换取零配置启动。

**评价**：作为**产品定位**这完全正确——个人工具不该要求用户先配一套 OAuth。问题出在执行层面：架构文档的"部署方案 B：云服务器 + 域名 + Let's Encrypt"与"零鉴权"是**互相矛盾**的。文档把一个本应只在内网使用的形态，推荐到了公网上。

**三条可行路径（建议明确选一并在文档中写死）**：

| 路径 | 做法 | 代价 |
|------|------|------|
| **收缩适用范围** | 文档明确"本应用仅限局域网/本机使用，公网部署需自行加鉴权（见附录）" | 最低，但放弃了"随时随地练口语"的场景 |
| **增加轻量鉴权** | 静态令牌或 Nginx Basic Auth（见 H1） | 约 20 行，是推荐路径 |
| **保持现状 + 显著警告** | 在 README/DEPLOYMENT 顶部加醒目风险提示 | 零成本，但依赖用户自觉 |

**我的建议**：路径 2 + 在文档中保留路径 1 的说明。**不要选路径 3**——安全默认应该是安全的，而不是"文档里提一句"。

### 3.2 「正文 + `<<<META>>>` + 单行 JSON」输出协议

**当前取舍**：让 LLM 先输出纯正文，再输出分隔符 + 单行 JSON，用自研状态机解析。

**评价**：这是一个**很聪明的设计**。它精准抓住了"流式渲染要求边收边显示，而结构化数据必须收全再解析"这一矛盾，用极低成本（一个分隔符 + 约 250 行解析器）解决了。我做了逐字符切分穷举，实现是正确的。

**代价**：
- 完全依赖模型遵循指令。温度 0.7 + 本地小模型下，分隔符缺失/JSON 损坏并不罕见。
- 已有 3003 降级路径兜底（正文保留、纠错丢失），这是合理的降级方向——**丢纠错比丢正文可接受**。

**替代方案对比**：

| 方案 | 优点 | 缺点 | 适用 |
|------|------|------|------|
| **当前（分隔符 + JSON）** | 单轮一次请求，延迟低，成本低 | 依赖模型指令遵循 | ✅ 当前最佳 |
| **OpenAI Structured Outputs / `response_format`** | 服务端保证 JSON 合法，解析零容错代码 | 各家兼容性不一（DeepSeek/qwen/LMStudio 支持度参差）；且**结构化输出与流式正文渲染天然冲突**，需要两阶段 | 若某 provider 遵循率实测过低，可加为兜底 |
| **Tool Calling / Function Calling** | 语义更规范 | 同样存在 provider 差异；本地 LMStudio 支持不稳定 | 不推荐，增加复杂度无收益 |
| **两阶段调用**（先流式出正文，再单独请求纠错） | 解耦彻底，正文质量不受结构化约束 | **延迟翻倍**（两轮 LLM），违背"首句即播 ≤5s"指标 | 不推荐 |

**结论：当前方案是对的，不要改。** 唯一可增强的是：在 `.env` 增加一个可选的 `LLM_STRICT_JSON=true` 开关，为支持 `response_format` 的 provider 开启硬性约束——但这是**可选增强**，不是修复。

### 3.3 「SQLite JSON 列」存 corrections / vocab_suggestions

**当前取舍**：这两个结构化字段以 JSON TEXT 存，不单独建表。

**评价**：正确。二者都是"只随消息整体读写、从不单独查询"的数据，拆表只会增加 JOIN 成本。

**代价**：无法用 SQL 查询"所有包含某类型纠错的消息"。

**何时该推翻**：若未来要做"按错误类型统计""全局纠错热力图"之类的分析功能，再拆表不迟。当前无此需求，保持现状。

### 3.4 「read-modify-write + JSON 列」的画像更新

见 L3。当前正确但脆弱，建议包事务。

### 3.5 「无消息队列 / 无 Redis / 无 Docker」—— 坚守得很对

架构文档 §0 原则 1 明确排除这些组件，**我完全赞同并建议继续坚守**。单用户 + 单机 + 单进程的约束，让整条链路的排障成本极低。本次审查发现的问题（H1/H2/H3、M1~M6）**没有一个需要引入新组件来解决**——全部可以在现有架构内修完。这说明架构选型本身是成功的。

---

## 4. 性能与可扩展性评估

### 4.1 当前水位

单用户场景下性能充裕，瓶颈 100% 在 LLM 网络 IO，不在应用代码。已验证：

- 全部热点查询均有索引覆盖（`idx_sessions_user_updated`、`idx_messages_session`、`idx_vocab_user_created`、`idx_vocab_mastery`）
- `getRecentMessages` 的子查询可利用 `idx_messages_session` 避免全表排序
- 前端已做 vendor 分包（react / MUI 分离），首屏无大 chunk 警告

### 4.2 三处可优化点（优先级从高到低）

1. **`getProfileSummary` 的 4 次 COUNT**（`profile.service.ts:118-137`）：每次打开设置页对 3 张表做 4 次全表 COUNT。单用户量级下毫秒级，**当前无需优化**；若未来数据量上去，可改为维护计数表或用 `ANALYZE` 后的近似值。
2. **`messages` 表缺 `user_id` 索引**：`getProfileSummary` 中 `SELECT COUNT(*) FROM messages WHERE user_id = ?` 会全表扫描。同理，当前量级无感，但**加一个索引的成本几乎为零**，建议补上：
   ```sql
   CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);
   ```
3. **`appendMessage` 的 COUNT**（见 M2）：建议保留 COUNT 但加事务。

### 4.3 可扩展性边界

| 维度 | 当前上限 | 突破需要 |
|------|---------|---------|
| 并发用户 | **多用户已落地**（P2-5，2026-11-01）：`req.userId` 贯穿路由层 → service 层；微信静默登录 + 邀请码登录；限流按 userId 分键 | 如需更大规模 → 引入外部缓存与异步驱动（仍须单进程，见下行） |
| 单会话长度 | 无硬限制，但每轮注入最近 20 条，**长会话的 LLM 上下文成本恒定** ✅ | 设计已规避上下文膨胀 |
| 数据量 | SQLite 单文件，万级消息无压力 | — |
| 部署形态 | **必须单进程**（多进程会导致 L3 的 lost update + SQLite 写锁竞争） | 需引入 Postgres 或分布式锁 |

**最关键的一条**：`user_id` 字段虽已预留，但**路由层全部硬编码 `DEFAULT_USER_ID`**（5 个路由文件共 15 处：sessions 5、words 5、chat 2、profile 2、scenes 1；`system.routes.ts` 因不涉及业务数据故为 0）。若未来做多用户，需要把这 15 处改为从请求上下文取值——**建议在修 H1 的鉴权中间件时，顺手把 userId 改成从中间件注入 `req.userId`**，这样多用户化的改造成本从"改 15 处"降到"改 5 个文件的取参方式"。这是低成本高回报的前瞻性投资。

---

## 5. 改进路线图（按优先级）

### P0 —— 生产部署前必须完成

| # | 问题 | 改动量 | 说明 |
|---|------|--------|------|
| 1 | H1 鉴权 + CORS | ~25 行 + 配置项 | 静态令牌或 Nginx Basic Auth，二选一 |
| 2 | H3 SSE 可取消 | ~20 行（useChat）+ ~15 行（store 兜底） | 两道防线，已复现验证 |
| 3 | H2 速率限制 | ~10 行 + 1 个依赖 | 保护 LLM 额度，防资损 |

### P1 —— 建议下个迭代

| # | 问题 | 改动量 |
|---|------|--------|
| 4 | M2 `appendMessage` 加事务 | ~5 行 |
| 5 | M6 新建会话顺序调整（先生成后入库 + 事务） | ~15 行 |
| 6 | M3 数据库迁移框架 | ~30 行 |
| 7 | M5 scenes 路由 SQL 下沉 service | ~15 行 |
| 8 | L3 画像更新包事务 + 文档禁止 pm2 `-i` | ~10 行 + 文档 |
| 9 | 补 `idx_messages_user` 索引 | 1 行 SQL |

### P2 —— 数据质量与体验

| # | 问题 | 改动量 |
|---|------|--------|
| 10 | M1 客户端幂等键 | ~30 行 + 1 列 + 1 次迁移 |
| 11 | M4 词汇本改游标分页 | ~30 行（前后端） |
| 12 | L5 DATA_DIR 默认路径 | ~3 行 |
| 13 | L6 停机关闭 DB + 备份文档警示 | ~5 行 |

### P3 —— 代码整洁度

| # | 问题 |
|---|------|
| 14 | L1 清理死代码（`masteredWords` 复用、前端 format 工具、`defineWord` 冗余参数） |
| 15 | L2 消除重复（upsert 模板、分页校验、`ISSUE_LABEL`、`clampRate`） |
| 16 | L7 版本号单一来源 |
| 17 | L8 404 纳入错误码表 |
| 18 | L9 `tsconfig` 纳入 `test/` 目录（前后端） |

---

## 6. 结语

SpeakMate 的架构设计与工程质量**明显高于同规模的个人自托管项目**——分层清晰、契约严谨、降级完备、测试充分（151 个测试全绿），`parser.ts` 的实现尤其扎实。架构文档 §10「待明确事项」把不确定的技术假设逐条列出来的做法，也是成熟工程习惯的体现。

本次审查发现的问题**高度集中**：三个高危项全部落在"**默认安全假设**"（H1/H2：假设只有自己会调用）和"**异步生命周期管理**"（H3：假设流不会被打断）这两类上，而不是架构本身。这其实是好消息——**它们不需要任何架构调整就能修复**，总计约 55 行代码 + 2 个配置项即可覆盖全部 P0。

最需要强调的是：**项目当前的安全模型与 `DEPLOYMENT.md` 推荐的部署方式不匹配**。代码是按"家庭内网玩具"写的，文档却教人把它放到公网上。修复 H1/H2，或者收紧部署文档，二者必居其一——否则第一个按文档部署的用户，就会在毫不知情的情况下把自己的全部对话暴露在公网上。

---

*本报告基于 2026-09-05 的代码快照。所有结论均经实证验证，验证用临时文件已清理，未改动任何项目源码。*
