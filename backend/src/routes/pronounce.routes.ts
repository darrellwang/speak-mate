/**
 * 发音评估接口（routes/pronounce.routes.ts）
 *
 * POST /api/pronounce?text=<参考句>&lang=en
 *   body: 原始音频二进制（wav/mp3，≤20MB）
 *   返回: {score, transcribe, differences{errors[], phoneme_error_rate...}, elapsed_ms}
 *
 * 架构（与 Ollama 同款“本机子服务”模式）：
 *   小程序 → Node(3001) → WSL 里的 OpenPronounce 服务(8600)
 *
 * ⚠️ 设计要点：
 * - 音频走**原始二进制 body**（非 multipart）——express.raw 直接拿 Buffer，
 *   转发用原生 fetch（Node 18+），全程零新增 npm 依赖；
 * - 参考文本放 query（UTF-8 编码），与评测服务的契约一致；
 * - 评测服务地址可配置（.env 的 PRONOUNCE_URL，默认 localhost:8600），
 *   未启动时返回明确提示而不是笼统 500；
 * - 挂在 requireAuth 之后（多用户鉴权），限流用 write 档（本地 CPU 计算，10/min 足够家用）。
 */

import express, { Router } from 'express';
import { asyncHandler, badRequest, sendOk } from '../middleware/error';
import { writeLimiter } from '../middleware/rateLimit';
import { requireUserId } from '../middleware/context';

export const pronounceRouter = Router();

/** 评测服务地址（WSL 里的 OpenPronounce server），可被 .env 的 PRONOUNCE_URL 覆盖 */
const PRONOUNCE_BASE = (process.env.PRONOUNCE_URL ?? 'http://localhost:8600').replace(/\/+$/, '');

/** 音频大小上限（与评测服务一致） */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

/** 请求转发超时：首次请求含模型加载（~10s），给 60s 余量 */
const FORWARD_TIMEOUT_MS = 60_000;

/** 音频 body 解析：多种音频 MIME + 通用二进制，都按 Buffer 接收 */
const audioBodyParser = express.raw({
  type: [
    'audio/wav',
    'audio/x-wav',
    'audio/mpeg',
    'audio/mp3',
    'audio/aac',
    'audio/mp4',
    'audio/webm',
    'application/octet-stream',
  ],
  limit: '25mb', // 略高于业务上限，业务侧再精确校验
});

// ⚠️ async handler 必须 asyncHandler 包装（Express 4 不捕获 async 异常），
// 否则 throw 变成 unhandled rejection → 请求挂起超时。
pronounceRouter.post(
  '/',
  writeLimiter,
  audioBodyParser,
  asyncHandler(async (req, res) => {
    // requireAuth 已解析用户；评测结果不落库（实时反馈用），但鉴权与限流仍然生效
    requireUserId(req);

  const text = String(req.query.text ?? '').trim();
  const lang = String(req.query.lang ?? 'en').trim() || 'en';
  if (text === '') {
    throw badRequest('text（参考句）不能为空');
  }
  if (text.length > 2000) {
    throw badRequest('text 过长（上限 2000 字符）');
  }

  const audio = req.body as unknown;
  if (!Buffer.isBuffer(audio) || (audio as Buffer).length === 0) {
    throw badRequest('音频 body 缺失（应为 wav/mp3 二进制）');
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    throw badRequest(`音频过大（上限 20MB，当前 ${(audio.length / 1024 / 1024).toFixed(1)}MB）`);
  }

  const url = `${PRONOUNCE_BASE}/pronounce?text=${encodeURIComponent(text)}&lang=${encodeURIComponent(lang)}`;
  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(audio.length),
      },
      body: audio,
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw badRequest(
      `发音评测服务不可达（${detail}）。评测服务跑在 WSL 里，启动方式见 docs/DEPLOYMENT.md「发音评测服务」一节`,
    );
  }

  if (!upstream.ok) {
    const reason = await upstream.text().catch(() => '');
    throw badRequest(`评测服务返回异常（HTTP ${upstream.status}）：${reason.slice(0, 200)}`);
  }

  const payload = (await upstream.json()) as { code: number; data: unknown };
  if (payload.code !== 0) {
    throw badRequest('评测失败，请重试');
  }
  sendOk(res, payload.data);
  }),
);
