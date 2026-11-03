/**
 * 请求上下文取值辅助（middleware/context.ts）
 *
 * P2-5 多用户：路由层取用户标识的唯一入口是 `req.userId`，
 * 由 requireAuth 中间件写入（登录态 token → 真实 userId；静态令牌 → admin）。
 *
 * 这里做一次**显式兜底**：万一某个路由被单独挂载而绕过了 requireAuth，
 * 抛 401 而不是静默落到某个默认用户——静默兜底会造成跨用户数据泄漏，
 * 宁可显式失败。
 */

import type { Request } from 'express';
import { ApiError, ErrorCode } from './error';

/** 取当前请求的用户 id；缺失时抛 401（未授权） */
export function requireUserId(req: Request): string {
  const id = req.userId;
  if (typeof id !== 'string' || id === '') {
    throw new ApiError(401, ErrorCode.UNAUTHORIZED, '未授权：无法识别当前用户');
  }
  return id;
}
