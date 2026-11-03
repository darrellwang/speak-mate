/**
 * 统一响应与错误处理（架构文档 §4.1、§2 middleware/error.ts）
 *
 * - 所有 REST 接口返回 { code, data, message }：code=0 成功，非 0 业务错误码；
 * - HTTP 状态码同时保持语义正确（200/400/404/500/502/504）；
 * - LLM 报错脱敏（P0-11）：未预期异常不向前端泄露内部细节（可能含路径/内部状态），
 *   API Key 只存于后端内存，绝不出现在任何响应或日志中。
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** 业务错误码表（架构 §4.1） */
export const ErrorCode = {
  /** 成功 */
  OK: 0,
  /** 参数校验失败 */
  BAD_REQUEST: 1001,
  /** 会话不存在 */
  SESSION_NOT_FOUND: 2001,
  /** 场景不存在 */
  SCENE_NOT_FOUND: 2002,
  /** 词汇不存在 */
  WORD_NOT_FOUND: 2003,
  /** 未授权：令牌无效 / 过期 / 邀请码错误 */
  UNAUTHORIZED: 4010,
  /** LLM 连接失败（本地模式附带 LMStudio 排查指引文案） */
  LLM_CONNECT: 3001,
  /** LLM 首字超时（15s） */
  LLM_TIMEOUT: 3002,
  /** LLM 输出解析失败（已降级纯文本） */
  LLM_PARSE: 3003,
  /** 内部错误 */
  INTERNAL: 5000,
} as const;

/** 业务错误：携带 HTTP 状态码 + 业务错误码 + 面向用户的中文文案 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/* ---------- 错误工厂 ---------- */

export const badRequest = (message: string): ApiError =>
  new ApiError(400, ErrorCode.BAD_REQUEST, message);

export const sessionNotFound = (): ApiError =>
  new ApiError(404, ErrorCode.SESSION_NOT_FOUND, '会话不存在');

export const sceneNotFound = (sceneId: string): ApiError =>
  new ApiError(404, ErrorCode.SCENE_NOT_FOUND, `场景不存在：${sceneId}`);

export const wordNotFound = (): ApiError =>
  new ApiError(404, ErrorCode.WORD_NOT_FOUND, '词条不存在');

export const llmConnectError = (message: string): ApiError =>
  new ApiError(502, ErrorCode.LLM_CONNECT, message);

export const llmTimeoutError = (message: string): ApiError =>
  new ApiError(504, ErrorCode.LLM_TIMEOUT, message);

export const llmParseError = (message: string): ApiError =>
  new ApiError(502, ErrorCode.LLM_PARSE, message);

export const internalError = (): ApiError =>
  new ApiError(500, ErrorCode.INTERNAL, '内部错误，请稍后重试');

/* ---------- 响应助手 ---------- */

/** 统一成功响应：{ code: 0, data, message: 'ok' } */
export function sendOk<T>(res: Response, data: T): void {
  res.json({ code: ErrorCode.OK, data, message: 'ok' });
}

/* ---------- 中间件 ---------- */

type AsyncRequestHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/** Express 4 的 async handler 包装：Promise 异常自动转 next(err) */
export const asyncHandler =
  (fn: AsyncRequestHandler): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** API 404（未匹配路由） */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    code: 404,
    data: null,
    message: `接口不存在：${req.method} ${req.originalUrl}`,
  });
}

/** 统一错误处理器（四参签名，Express 识别） */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (res.headersSent) {
    // SSE 已开始输出，无法再改写为 JSON 错误响应，直接关闭连接
    res.end();
    return;
  }
  if (err instanceof ApiError) {
    res.status(err.status).json({ code: err.code, data: null, message: err.message });
    return;
  }
  // 未预期错误：完整信息只进服务端日志；前端仅收到通用文案（脱敏，P0-11）
  console.error('[error] unhandled:', err);
  res.status(500).json({
    code: ErrorCode.INTERNAL,
    data: null,
    message: '内部错误，请稍后重试',
  });
}
