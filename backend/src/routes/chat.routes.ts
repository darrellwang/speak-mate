/**
 * POST /api/chat（#9，SSE 流式对话，架构文档 §4.3）
 *
 * - 浏览器 EventSource 只支持 GET，前端以 fetch POST + ReadableStream 消费；
 * - 响应头：text/event-stream + no-cache + X-Accel-Buffering: no（防反代缓冲）；
 * - 开流前的业务错误（参数校验 1001 / 会话不存在 2001）走统一 JSON 错误响应；
 * - 开流后的错误一律以 SSE error 事件发送，随后关闭流；
 * - 客户端断开（req close）→ AbortController 中止 LLM 请求；
 * - SSE 不走 {code,data,message} 包裹，用原生 event/data 帧（§9.1）。
 *
 * 另有非流式等价接口 `POST /api/chat/sync`（#9b，见文件下半部分），
 * 供不支持分块传输的客户端（微信小程序低版本基础库等）使用：
 * 与 SSE 共用 chatService.sendMessage 事件流，仅传输层不同。
 */

import type { Request } from 'express';
import { Router } from 'express';
import type { Correction, VocabSuggestion } from '../../../shared/types/chat';
import { requireUserId } from '../middleware/context';
import {
  ApiError,
  asyncHandler,
  badRequest,
  ErrorCode,
  internalError,
  sendOk,
} from '../middleware/error';
import { llmLimiter } from '../middleware/rateLimit';
import * as chatService from '../services/chat.service';
import * as sessionService from '../services/session.service';

export const chatRouter = Router();

/** SSE 与 sync 共用的前置校验：返回 {sessionId, content}（失败抛 1001/2001） */
function parseChatBody(body: unknown): { sessionId: string; content: string } {
  const raw = (body ?? {}) as { session_id?: unknown; content?: unknown };
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id.trim() : '';
  const content = typeof raw.content === 'string' ? raw.content : '';
  if (!sessionId) {
    throw badRequest('session_id 不能为空');
  }
  if (!content.trim()) {
    throw badRequest('content 不能为空');
  }
  if (content.length > 2000) {
    throw badRequest('content 长度不能超过 2000 字符');
  }
  return { sessionId, content };
}

/** 业务错误码 → HTTP 状态码（SSE 路径无状态码概念，sync 路径需还原语义） */
function statusOfCode(code: number): number {
  switch (code) {
    case ErrorCode.LLM_CONNECT:
    case ErrorCode.LLM_PARSE:
      return 502;
    case ErrorCode.LLM_TIMEOUT:
      return 504;
    case ErrorCode.BAD_REQUEST:
      return 400;
    case ErrorCode.SESSION_NOT_FOUND:
      return 404;
    default:
      return 500;
  }
}

chatRouter.post(
  '/',
  llmLimiter, // 真实消耗 LLM token，限流最严格（见 middleware/rateLimit.ts）
  asyncHandler(async (req: Request, res) => {
    const body = (req.body ?? {}) as { session_id?: unknown; content?: unknown };
    const sessionId = typeof body.session_id === 'string' ? body.session_id.trim() : '';
    const content = typeof body.content === 'string' ? body.content : '';
    if (!sessionId) {
      throw badRequest('session_id 不能为空');
    }
    if (!content.trim()) {
      throw badRequest('content 不能为空');
    }
    if (content.length > 2000) {
      throw badRequest('content 长度不能超过 2000 字符');
    }

    // 开流前校验会话（404 走统一 JSON 错误响应，而非 SSE）
    const userId = requireUserId(req);
    sessionService.mustGetSession(userId, sessionId);

    // ---- SSE 开流 ----
    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders();
    }

    const controller = new AbortController();
    // 注：Node 15+ 中 req 的 'close' 在请求体消费完即触发（不代表客户端断开），
    // 必须监听 res 的 'close' 并以 writableEnded 区分「正常完成」与「客户端中途断开」
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    const writeEvent = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      for await (const evt of chatService.sendMessage(userId, sessionId, content, {
        signal: controller.signal,
      })) {
        if (res.writableEnded || controller.signal.aborted) {
          break;
        }
        writeEvent(evt.event, evt.data);
      }
    } catch (err) {
      // sendMessage 内部已捕获业务错误；此处仅兜底非预期异常
      console.error('[chat] route-level error:', err);
      if (!res.writableEnded) {
        writeEvent('error', { code: 5000, message: '服务内部错误，请稍后重试' });
      }
    } finally {
      res.end();
    }
  }),
);

/**
 * POST /api/chat/sync（#9b，非流式对话，SSE 的等价降级通道）
 *
 * 存在理由：微信小程序 `wx.request` 的分块接收（enableChunked）要求基础库 ≥ 2.20.0，
 * 且真机分块到达时机受网关缓冲影响。与其让低版本/弱网用户拿不到回复，
 * 不如在服务端把同一套 sendMessage 事件流聚合成一次性 JSON。
 *
 * 语义与 SSE 严格对齐：
 * - delta* → content（按序拼接，与流式结果逐字一致）；
 * - meta   → corrections / vocabulary_suggestions；
 * - done   → message_id（先落库再发事件，done 到达时数据可查，此处同理）；
 * - error  → 3003（协议降级）保留正文并置 degraded=true；其余错误码转统一 JSON 错误响应；
 * - 流提前关闭且无 done（进程重启/网络中断）→ 有正文按降级处理，无正文返回 500。
 */
chatRouter.post(
  '/sync',
  llmLimiter,
  asyncHandler(async (req: Request, res) => {
    const { sessionId, content } = parseChatBody(req.body);
    // 开流前校验会话（404 走统一 JSON 错误响应）
    const userId = requireUserId(req);
    sessionService.mustGetSession(userId, sessionId);

    // 客户端中途断开（用户退出页面）→ 中止 LLM 请求，避免白烧 token
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) {
        controller.abort();
      }
    });

    let reply = '';
    let corrections: Correction[] = [];
    let suggestions: VocabSuggestion[] = [];
    let messageId = '';
    let degraded = false;
    let failure: { code: number; message: string } | null = null;

    for await (const evt of chatService.sendMessage(userId, sessionId, content, {
      signal: controller.signal,
    })) {
      switch (evt.event) {
        case 'delta':
          reply += evt.data.text;
          break;
        case 'meta':
          corrections = evt.data.corrections;
          suggestions = evt.data.vocabulary_suggestions;
          break;
        case 'done':
          messageId = evt.data.message_id;
          break;
        case 'error':
          if (evt.data.code === ErrorCode.LLM_PARSE) {
            degraded = true; // 正文照常可用，仅缺纠错/词条
          } else {
            failure = evt.data;
          }
          break;
        default:
          break;
      }
    }

    if (failure !== null) {
      throw new ApiError(statusOfCode(failure.code), failure.code, failure.message);
    }
    if (messageId === '') {
      if (reply === '') {
        throw internalError();
      }
      // 有正文但没收到 done：流被意外截断，按降级交付（正文已落库？未落库 → 明确标记）
      degraded = true;
    }

    sendOk(res, {
      message_id: messageId,
      session_id: sessionId,
      content: reply,
      corrections,
      vocabulary_suggestions: suggestions,
      degraded,
    });
  }),
);
