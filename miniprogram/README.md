# SpeakMate 微信小程序端

> 与 H5 端共用同一个 SpeakMate 后端：场景、会话、词汇、学习画像全部同源，手机上随时开口练。

## 技术选型

| 项 | 选择 | 理由 |
|----|------|------|
| 框架 | **原生小程序 + TypeScript** | 未引入 Taro/uni-app：本项目只有微信一端需求，原生主包可控在 300KB 内，且调试链路最短 |
| 渲染 | WebView（`renderer: webview`） | 兼容性优先；Skyline 对 textarea / scroll-view 的行为差异尚未全量验证 |
| UI | 自写组件 + 设计令牌（app.wxss CSS 变量） | 不引 UI 库：主包省 100KB+，且只需要 6 个页面级别的样式 |
| 语音 | 微信同声传译插件（可选，默认关闭） | 官方免费 ASR+TTS；但插件要求真实 AppID，故默认交付纯文字版 |

## 目录结构

```text
miniprogram/
├── app.ts / app.json / app.wxss   # 入口、路由与 tabBar、全局设计令牌
├── config.ts                       # 运行时配置默认值（后端地址/令牌/TTS/流式）
├── types/                          # 由 scripts/sync-types.mjs 生成的契约（.d.ts，不参与编译）
├── utils/
│   ├── request.ts                  # wx.request 封装：{code,data,message} 解包 + 令牌 + 错误提示
│   ├── sse.ts                      # 双通道对话：分块流优先，失败自动降级 /api/chat/sync
│   ├── utf8.ts                     # UTF-8 流式解码（小程序无 TextDecoder，且分片会劈开多字节字符）
│   ├── storage.ts                  # 设置 / 当前会话 / 最近场景 的本地存取
│   └── format.ts                   # 时间、句子切分、分词（TTS 首句即播、长按选词）
├── services/api.ts                 # 后端 #1–#16 + #9b 全部端点
├── speech/
│   ├── adapter.ts                  # 语音接口（与 H5 端 SpeechAdapter 同构）
│   ├── textOnly.ts                 # 纯文字实现：零依赖
│   ├── wechatSi.ts                 # 微信同声传译实现（ASR+TTS）
│   └── index.ts                    # 引擎工厂
├── components/message-bubble/      # 消息气泡 + 纠错卡 + AI 建议词条
└── pages/
    ├── chat/            # 练习（tab）：消息流、流式渲染、按住说话、点词查词
    ├── words/           # 词汇本（tab）：倒序列表、左滑删除、复习模式
    ├── history/         # 历史（tab）：会话列表、继续聊、左滑删除
    ├── settings/        # 我的（tab）：后端地址、令牌、TTS、学习画像
    ├── scenes/          # 场景选择（子页，选中即建会话）
    └── session-detail/  # 会话回看（子页，只读）
```

## 快速开始

1. **启动后端**（默认 mock 模式，零配置）：

   ```bash
   cd backend && pnpm install && pnpm start   # http://localhost:3001
   ```

2. 复制本机覆盖（首次）：`copy config.example.ts config.local.ts`，按需改 `LOCAL_DEFAULT_BASE_URL`（该文件已 gitignore）。
3. **微信开发者工具** → 导入项目 → 目录选 `miniprogram/` → AppID 用本机 `project.private.config.json`（仓库内 `project.config.json` 为 `touristappid` 占位）。

4. **关闭域名校验**：详情 → 本地设置 → 勾选 **「不校验合法域名、web-view、TLS 版本以及 HTTPS 证书」**
   （否则 `http://localhost:3001` 会被拦截；真机预览同理）。

5. **填写后端地址**：「我的」页 → 后端地址填 `http://192.168.x.x:3001`（**不能用 localhost**，手机/模拟器里它指向自己）→ 保存 → 点「测试连接」。

6. 回「练习」页 → 选场景 → 开聊。

> **多用户（P2-5）**：普通用户无需任何操作——小程序通过 `wx.login()` 静默登录，
> 后端按 openid 自动建号，各人的会话、词汇本与学习画像互不可见。
> 后端启用了 `ACCESS_TOKEN` 时，需在「我的」页填写访问令牌（存本地 Storage，不进代码包）——
> 填了会以管理员身份访问（主人自己的历史数据）。

## 关键实现说明

### 双通道流式（utils/sse.ts）

小程序没有 `EventSource`，唯一能读增量响应的是 `wx.request({ enableChunked: true })` 的 `onChunkReceived`（基础库 ≥ 2.20.0）。但真机上分块可能被网关缓冲或丢帧，因此：

- 支持分块 → 走 SSE 流，逐字渲染；
- **首块 8 秒未到** 或 **流结束却没收到 done** → 自动改用 `POST /api/chat/sync` 一次性取全量；
- 兜底之所以安全：后端 `sendMessage` 对「最后一条 user 消息相同」做了幂等，重试不会插两条用户消息；
- 用户可在「我的」页手动关闭逐字流式。

### 点词查词

小程序无法自由选取文本，因此改为：**长按气泡 → 整句分词 → 点选 1 个或多个连续词 → 生成词条卡 → 一键入库**。
AI 主动建议的词条则直接以 chips 形式挂在消息下方，点一下即入库。

### TTS 首句即播

流式文本进入 `ttsBuffer`，一旦出现句末标点就切出完整句子送播，不等整段生成结束。
纯文字引擎下 `ttsSupported=false`，播报入口自动隐藏。

### 契约同步

`miniprogram/types/*.d.ts` 由 `shared/types/*.ts` 生成，**不要手改**：

```bash
node scripts/sync-types.mjs      # 改完 shared/types 后必须重跑
```

用 `.d.ts` 而非 `.ts` 是刻意的：微信开发者工具会编译项目内所有 `.ts` 并产出同名 `.js`，
而契约是纯类型（零运行时），编译产物纯属垃圾。

### 类型检查（可选）

```bash
cd miniprogram
pnpm install                     # 只装 typescript + miniprogram-api-typings
pnpm typecheck
```

本目录刻意**未加入**仓库根 npm workspaces：它没有运行时依赖，不该被根 `pnpm install` 拖进来。
（目录内的 `pnpm-workspace.yaml` 只是为了让 pnpm 认这里自成工作区——否则它会向上回溯到仓库根，
要求根提供 `packages` 字段并报错。）

## 语音（微信同声传译插件）

语音能力依赖微信官方「同声传译」插件，已接入（`speech/wechatSi.ts` + `app.json` 插件声明 + `speech/index.ts` 引擎分支）。

**后台授权是前置条件**（否则 `requirePlugin('WechatSI')` 编译期报「插件未授权」）：

1. 登录微信公众平台 → 小程序 → **设置 → 第三方设置 → 插件管理 → 添加插件**；
2. 若搜索框搜不到，改去 **微信服务市场**（fuwu.weixin.qq.com）搜「同声传译」添加；
3. 最稳做法是直接粘贴插件 AppID `wx069ba97219f66d99` 定位；
4. 添加后回开发者工具重新编译，再到「我的」页把语音引擎切到 `wechat-si`。

> 若想退回纯文字版（例如换测试号开发）：删除 `app.json` 的 `plugins` 声明、删掉 `speech/wechatSi.ts`、
> 并把 `speech/index.ts` 恢复为 `return textOnlyAdapter`。

## 隐私协议（已内置）

微信自 2023-09 起对涉及用户隐私的接口强制要求用户同意《隐私保护指引》。本工程已按官方规范落地：

- `app.json` 已启用 `__usePrivacyCheck__`，并声明录音相关 `requiredPrivateInfos`；
- `utils/privacy.ts` 封装 `wx.getPrivacySetting` / `wx.requirePrivacyAuthorize` / `wx.onNeedPrivacyAuthorization`；
- 麦克风权限**延迟到用户第一次「按住说话」时才申请**（符合「有可见用途才申请权限」的审核要求），
  未同意时会弹自定义授权弹窗，用户点「同意」放行、点「拒绝」仅提示不录音；
- `pages/privacy/privacy` 提供隐私说明页，可随时从「我的」页进入查看。

> ⚠️ 正式发布前仍需在**小程序后台 → 设置 → 服务内容声明 → 用户隐私保护指引**里，勾选与
> `requiredPrivateInfos` 一致的采集项（麦克风），否则微信审核会驳回。

## 发布前检查清单

- [ ] **服务器域名白名单**：小程序后台 → 开发 → 开发管理 → 服务器域名 → request 合法域名加入后端 HTTPS 地址
- [ ] **域名已备案 + 有效证书**：小程序强制 HTTPS，自签证书不可用
- [ ] **`ACCESS_TOKEN`**：公网部署务必在后端配置；小程序端由「我的 → 访问令牌」填写（普通用户用微信登录，无需填写）
- [ ] **隐私协议**：用到麦克风（`scope.record`）需在小程序后台配置《用户隐私保护指引》并声明采集范围
- [ ] **隐私协议（多用户必需）**：《用户隐私保护指引》需额外声明「用户账号信息 → 微信 OpenID」并勾选 `wx.login` 权限——**不声明会导致 openid 带 `temp-` 前缀（临时值），数据隔离失效**
- [ ] **后端微信配置**：`WECHAT_APP_ID` / `WECHAT_APP_SECRET` 已配置（小程序静默登录必需）
- [ ] **用户隐私接口**：如使用 `wx.getSetting` / 录音，需在 app.json 的 `__usePrivacyCheck__` 或后台完成合规声明
- [ ] **包体**：主包 2MB 上限（当前远低于此）；如后续加大量图片资源，改用 CDN 或分包
- [ ] **基础库**：`onChunkReceived` 需 ≥ 2.20.0（更低版本自动走 sync 通道，功能不缺失）

## 已知边界

- 回看页（session-detail）一次最多拉 200 条消息，超长会话不做二次分页；
- 词汇本左滑删除为自实现（非官方 `movable`），仅支持「左滑露出删除键」一种手势；
- 未实现深色模式：tabBar 配色由 app.json 静态决定，动态切换会导致内容区与 tabBar 割裂；
- 流式渲染在低端机上可能受限于 setData 频率，可在「我的」页关闭逐字流式。
