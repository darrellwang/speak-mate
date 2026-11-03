/**
 * Express 组装：中间件 → 路由挂载 → 统一错误处理（架构文档 §2 app.ts）。
 *
 * 中间件顺序：helmet（安全头）→ cors（白名单 / 同源）→ json 解析 → morgan（访问日志）
 * → /api 鉴权守卫 → /api 路由（各路由内部按成本挂载限流器）
 * → frontend/admin/dist 挂在 /admin → frontend/dist 静态托管（生产同源）→ 404 → 错误处理。
 *
 * 安全相关（审查报告 H1 / H2）：
 * - CORS 由 config.security.corsOrigins 驱动：留空 = 同源部署，不发送任何 CORS 头；
 *   配置白名单后才对指定来源放行。绝不允许 '*'（config/env.ts 已拦截该配置）。
 * - requireAuth 挂载在 /api 之前：配置了 ACCESS_TOKEN 即生效，未配置时零开销放行。
 * - 速率限制按接口成本分档，详见 middleware/rateLimit.ts。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/env';
import { requireAuth } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error';
import { adminRouter } from './routes/admin.routes';
import { authPublicRouter, authRouter, meRouter } from './routes/auth.routes';
import { chatRouter } from './routes/chat.routes';
import { diagPublicRouter, diagRouter } from './routes/diag.routes';
import { profileRouter } from './routes/profile.routes';
import { pronounceRouter } from './routes/pronounce.routes';
import { scenesRouter } from './routes/scenes.routes';
import { sessionsRouter } from './routes/sessions.routes';
import { systemRouter } from './routes/system.routes';
import { ttsRouter } from './routes/tts.routes';
import { wordsRouter } from './routes/words.routes';

const currentDir = path.dirname(fileURLToPath(import.meta.url));

export function createApp(): Express {
  const app = express();
  app.disable('x-powered-by');
  // Nginx 部署时按真实客户端 IP 做限流判定（需显式开启，默认关闭以免信任伪造的 XFF 头）
  if (process.env.TRUST_PROXY === 'true') {
    app.set('trust proxy', 1);
  }

  app.use(helmet());

  // CORS：留空 = 同源部署（不发送任何 CORS 响应头）；配置了白名单才对指定来源放行
  const corsOrigins = config.security.corsOrigins;
  app.use(
    cors(
      corsOrigins.length > 0
        ? { origin: [...corsOrigins], credentials: true }
        : { origin: false },
    ),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'tiny' : 'dev'));

  // ---- 登录接口（P2-5）：**必须在 requireAuth 之前挂载**——
  // 登录接口本身就是入口（凭 code / 邀请码换取登录态），不能被守卫拦住。
  // 仅这两个 POST 属于公开路由；/api/auth/me 与 /api/auth/logout 需要鉴权，
  // 挂在守卫之后（见下方 authRouter）。
  app.use('/api/auth', authPublicRouter);

  // ---- 诊断探针（无需鉴权）：用于区分"网络不通"与"令牌没带" ----
  app.use('/api/diag', diagPublicRouter);

  // ---- 访问控制：令牌未配置时中间件直接放行（局域网模式零配置，见 middleware/auth.ts） ----
  app.use('/api', requireAuth);

  // ---- API 路由（§4.2 全部 16 个接口；限流器在各 router 内按成本挂载） ----
  app.use('/api', systemRouter); //        #1  GET /api/health   #2  GET /api/config
  app.use('/api/auth', authRouter); //     #18 GET /api/auth/me  POST /api/auth/logout
  app.use('/api/me', meRouter); //        #19 DELETE /api/me/data（PIPL 删除权）
  app.use('/api/diag', diagRouter); //    诊断上报（语音链路轨迹，见 routes/diag.routes.ts）
  app.use('/api/pronounce', pronounceRouter); // #23 POST 发音评估（WSL OpenPronounce 转发）
  app.use('/api/scenes', scenesRouter); // #3  GET /api/scenes
  app.use('/api/sessions', sessionsRouter); // #4-#8 会话 CRUD + 消息分页
  app.use('/api/chat', chatRouter); //     #9  POST /api/chat（SSE）
  app.use('/api/words', wordsRouter); //   #10-#14 词条生成 + 词汇本 CRUD
  app.use('/api/profile', profileRouter); // #15-#16 画像读写
  app.use('/api/tts', ttsRouter); //       #17 GET /api/tts（Edge TTS mp3 流）
  app.use('/api/admin', adminRouter); //   管理台：用户 / 统计 / 健康 / 封禁

  // ---- 生产模式：管理台静态资源（frontend/admin/dist），挂在 /admin ----
  // 必须先于学员 H5 的 SPA 回退，否则 /admin 会被学员 index.html 吃掉。
  const adminDist = path.resolve(currentDir, '../../frontend/admin/dist');
  if (existsSync(adminDist)) {
    app.use('/admin', (_req, res, next) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      next();
    });
    app.use(
      '/admin',
      express.static(adminDist, {
        index: 'index.html',
        setHeaders(res, filePath) {
          if (filePath.endsWith(`${path.sep}index.html`)) {
            res.setHeader('Cache-Control', 'no-cache');
          }
        },
      }),
    );
    app.get(/^\/admin(?:\/.*)?$/, (_req, res) => {
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(adminDist, 'index.html'));
    });
  }

  // ---- 生产模式：托管学员 H5（frontend/dist），前后端同源 ----
  const frontendDist = path.resolve(currentDir, '../../frontend/dist');
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    // SPA 路由回退：非 /api、非 /admin 路径回 index.html（前端 Router 接管）
    app.get(/^\/(?!api\/|admin(?:\/|$)).*$/, (_req, res) => {
      res.sendFile(path.join(frontendDist, 'index.html'));
    });
  }

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
