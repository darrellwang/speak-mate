# SpeakMate（口语搭子）

> 面向中国 IT 从业者的 AI 英语口语陪练 H5 应用——把「开口说」变成每天 10 分钟的习惯，AI 搭子陪你把工作场景聊明白。

## 产品简介

SpeakMate 是一款移动端优先的单用户 Web 应用。你按住说话（或打字），AI 伙伴用英语陪练真实职场/生活场景，**每轮对话实时纠错**、顺手标记值得学的词，词汇本支持自测复习；跨会话学习画像让 AI 记住你的常错表达和已掌握词汇，越用越懂你。

### 核心功能

| 功能 | 说明 |
|------|------|
| 🎙️ 语音对话 | 按住说话 → 实时转写 → 发送；AI 回复流式逐字渲染 + 首句即播 TTS（可关、可调速） |
| 🧑‍💻 真实场景 | 10 个内置场景：每日站会、事故复盘、Code Review、1on1、闲聊寒暄……IT 职场 + 生活 + DevOps 面试 |
| ✅ 实时纠错 | 显式语法/用词错误必纠，每轮附纠错卡（❌原句 → ⚠️问题 → ✅正确 → 💡讲解）；无错不硬纠 |
| 📖 生词标记 | 点词即生成词条四要素（音标/释义/例句/上下文），一键入库；AI 也会主动建议词条 |
| 🔖 词汇本 | 倒序列表 + 来源场景 + 左滑删除；复习模式遮盖释义自测 + 三档掌握度 |
| 🧠 学习画像 | 常错表达 Top5 / 高频场景 / 已掌握词汇（AI 不再解释它们）每轮注入对话，跨会话记忆 |
| 🕘 历史会话 | 会话列表 + 只读回看 + 删除；新建会话可「延续上次话题」 |
| 🔒 数据本地 | SQLite 单文件存储；浏览器语音识别音频不出设备；API Key 只存后端 |

## 技术栈

| 端 | 技术 |
|----|------|
| 前端 | Vite 5 + React 18 + TypeScript + MUI 5 + Tailwind CSS（移动端优先，深色跟随系统） |
| 后端 | Node.js ≥ 18.17 + Express 4 + better-sqlite3（单进程，`tsx` 直跑 TS 零预编译） |
| LLM | 自研 OpenAI 兼容客户端（原生 fetch + SSE 流式），DeepSeek / 通义千问 / OpenAI / LMStudio / Ollama 本地模型一键切换 |
| 语音 | Web Speech API（浏览器 ASR + TTS，`SpeechAdapter` 接口抽象，可整体替换） |
| 共享契约 | `shared/` 纯类型 + 场景数据，前后端同一份源码引用 |

## 目录结构

```text
english-tutor/
├── README.md                 # 本文件
├── DEPLOYMENT.md              # 部署指南（局域网自托管 / 云服务器两方案）
├── docs/
│   ├── PRD.md                 # 产品需求文档
│   ├── ARCHITECTURE.md        # 系统架构设计（API 契约 / 数据结构 / 时序图）
│   └── *.mermaid              # 时序图 / 类图源文件
├── shared/                    # 前后端共享契约（纯类型 + 场景数据，零运行时依赖）
│   ├── scenes.json            # 10 个内置场景（唯一事实源）
│   └── types/                 # models.ts / api.ts / chat.ts
├── backend/                   # Express 后端（REST + SSE，SQLite）
│   ├── .env.example           # 环境变量模板（LLM 配置说明见下文）
│   ├── data/                  # SQLite 数据文件（运行时自动创建，gitignore）
│   └── src/
│       ├── index.ts           # 启动入口（可选 HTTPS，见 DEPLOYMENT.md）
│       ├── app.ts             # Express 组装（生产模式托管 frontend/dist 与 /admin）
│       ├── config/env.ts      # 环境变量加载 + LLM provider 预设
│       ├── db/                # SQLite 初始化 + schema
│       ├── middleware/        # 统一错误处理（{code,data,message}）
│       ├── routes/            # /api/* 全部 16 个接口（含 POST /api/chat SSE）
│       └── services/          # LLM 客户端 / 提示词 / 流式解析 / 会话 / 词汇 / 画像
├── frontend/                 # React SPA（Vite + MUI + Tailwind）
│   ├── admin/                # 管理台（独立 Vite 应用，生产路径 /admin）
│   └── src/
│       ├── api/               # fetch 封装 / SSE 消费器 / REST 端点函数
│       ├── speech/            # SpeechAdapter 接口 + WebSpeechAdapter 实现
│       ├── stores/            # zustand（chat / session / settings）
│       ├── hooks/             # useChat（SSE 循环）/ useSpeech（ASR+TTS 队列）/ useScenes
│       ├── components/        # chat / words / layout 组件
│       └── pages/             # 对话 / 场景 / 词汇本 / 历史 / 设置
├── miniprogram/              # 微信小程序（原生 + TypeScript）
│   ├── utils/                # request 封装 / 双通道 SSE / UTF-8 流式解码 / Storage
│   ├── services/api.ts       # 与 H5 端一一对应的端点函数
│   ├── speech/               # 同构 SpeechAdapter（默认纯文字，可选微信同声传译插件）
│   └── pages/                # 练习 / 词汇 / 历史 / 我的 + 场景选择、会话回看
└── scripts/sync-types.mjs    # shared/types → miniprogram/types/*.d.ts 契约同步
```

> 三个端（H5 / 小程序 / 后端）共用同一份 `shared/` 契约，接口语义不会分叉。

## 快速启动

环境要求：**Node.js ≥ 18.17**（内置 fetch / crypto.randomUUID），包管理器推荐 pnpm ≥ 8（npm 亦可）。

### 1. 启动后端（默认 mock 模式，零配置）

```bash
cd backend
pnpm install
pnpm start        # 生产跑法：tsx src/index.ts；开发热重载用 pnpm dev
```

看到 `backend is running at http://localhost:3001` 与 `mock 模式` 提示即成功。验证：

```bash
curl http://localhost:3001/api/health
# {"code":0,"data":{"status":"ok","db":"ok","llm":{"provider":"mock","model":"mock-english-coach"}},"message":"ok"}
```

### 2. 启动前端

```bash
cd frontend
pnpm install
pnpm dev         # http://localhost:5173（/api 已代理到 3001）
```

浏览器打开 <http://localhost:5173>，选场景 → 开聊。**mock 模式下无需任何 LLM Key**：AI 回复为内置模拟数据（含模拟纠错与词条建议），完整走通 SSE 流式渲染、纠错卡片、词条入库等全链路。

### 3. 生产模式（可选）

```bash
cd frontend && pnpm install && pnpm build          # 产出 frontend/dist
cd admin && pnpm install && pnpm build             # 产出 frontend/admin/dist
cd ../../backend && pnpm start                     # Express 托管两个 dist，同源单端口
# 学员端 http://localhost:3001
# 管理台 http://localhost:3001/admin
```

管理台用用户名和密码登录（默认用户名 `admin`，密码为 `ADMIN_PASSWORD`）。`pnpm dev` 未设置密码时使用文档中的本地默认口令。邀请码和 `ACCESS_TOKEN` 不能进入管理台。说明见 [docs/ADMIN.md](docs/ADMIN.md)。

## LLM 配置（backend/.env）

复制模板并修改，**改 `LLM_PROVIDER` 一个键即可切换**，前端零改动：

```bash
cd backend
cp .env.example .env
```

| 配置 | `LLM_PROVIDER` | `LLM_MODEL`（默认） | `LLM_API_KEY` | 说明 |
|------|----------------|---------------------|---------------|------|
| 零配置联调 | `mock` | `mock-english-coach` | 无需 | 内置模拟数据，全链路可跑 |
| DeepSeek | `deepseek` | `deepseek-chat` | 必填 | OpenAI 兼容端点 |
| 通义千问 | `qwen` | `qwen-plus` | 必填 | 阿里云百炼兼容模式 |
| OpenAI | `openai` | `gpt-4o-mini` | 必填 | — |
| LMStudio 本地 | `lmstudio` | 以本地加载模型名为准 | 任意占位 | 默认 `http://localhost:1234/v1`，数据不出内网 |
| Ollama 本地 | `ollama` | 以 `ollama list` 输出为准 | 任意占位 | 走**原生** `/api/chat` 端点（`think:false` 可关思考），默认 `http://localhost:11434` |

示例（DeepSeek）：

```env
LLM_PROVIDER=deepseek
LLM_API_KEY=sk-xxxxxxxxxxxxxxxx
LLM_MODEL=deepseek-chat
```

其他可用变量：`LLM_BASE_URL`（覆盖 provider 预设端点）、`LLM_ENABLE_THINKING`（qwen/lmstudio 默认关思考块）、`PORT`、`APP_NAME`、`DATA_DIR`、HTTPS 相关键（手机麦克风必需，见 DEPLOYMENT.md 方案A）。完整说明见 [`backend/.env.example`](backend/.env.example) 注释。

> 安全提示：`.env` 已在 `.gitignore` 中；API Key 只存后端，前端任何网络请求均不携带。

## 移动端访问

- **本机调试**：Chrome DevTools 设备模拟即可覆盖 90% 场景。
- **手机真机（同一 WiFi）**：
  ```bash
  cd frontend && pnpm dev -- --host     # 暴露到局域网
  # 手机浏览器访问 http://<电脑局域网IP>:5173
  ```
  注意：`http://` 局域网地址**无法授权麦克风**（Web Speech API 要求安全上下文），此时会自动降级文字输入模式；语音功能需按 [DEPLOYMENT.md 方案A](DEPLOYMENT.md) 配置 HTTPS（mkcert 自签证书，约 10 分钟）。
- **局域网生产部署 / 云服务器部署**：见 [DEPLOYMENT.md](DEPLOYMENT.md)。

## 微信小程序端

同一套后端，微信里打开即用。功能与 H5 端对齐：场景对话、实时纠错、点词查词、词汇本复习、历史回看、学习画像。

```bash
cd backend && pnpm start                      # 1) 起后端
# 2) 微信开发者工具导入 miniprogram/ 目录
# 3) 详情 → 本地设置 → 勾选「不校验合法域名」
# 4) 「我的」页填写后端地址（http://192.168.x.x:3001）→ 测试连接
```

小程序端与 H5 端的三处差异（都是运行时限制导致的，不是功能裁剪）：

| 能力 | H5 端 | 小程序端 |
|------|-------|---------|
| AI 流式回复 | `fetch` + `ReadableStream` 消费 SSE | `wx.request` 分块接收，**超时/断流自动降级**为非流式 `POST /api/chat/sync` |
| 语音（ASR/TTS） | Web Speech API | 默认纯文字；可选微信同声传译插件（见 [启用步骤](miniprogram/README.md#启用语音微信同声传译插件)） |
| 点词查词 | 鼠标划选 | 长按气泡 → 整句分词 → 点选 |

后端为此新增了 `#9b POST /api/chat/sync`（复用同一套 `chatService.sendMessage` 事件流，仅聚合为一次性 JSON），H5 端不受影响。

完整说明见 [miniprogram/README.md](miniprogram/README.md)。

## 文档索引

| 文档 | 内容 |
|------|------|
| [docs/PRD.md](docs/PRD.md) | 产品需求（用户故事 / 指标 / 边界） |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构设计（API 契约 / 数据结构 / LLM 输出协议 / 任务拆分） |
| [DEPLOYMENT.md](DEPLOYMENT.md) | 部署指南（局域网自托管 HTTPS / 云服务器 pm2+Nginx+certbot） |
| [miniprogram/README.md](miniprogram/README.md) | 微信小程序端（目录 / 启动 / 语音启用 / 发布检查清单） |
| [docs/ADMIN.md](docs/ADMIN.md) | 管理台（用户 / 统计 / 系统 / 封禁，用户名密码登录） |
