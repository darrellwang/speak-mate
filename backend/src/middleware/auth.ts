/**
 * 访问控制中间件（审查报告 H1：全站无鉴权 → 公网部署等同于数据裸奔）
 *
 * 设计要点：
 * - **零配置透明**：`ACCESS_TOKEN` 为空时中间件完全放行，保持项目"单用户零配置启动"的体验；
 * - **可选启用**：配置 `ACCESS_TOKEN` 后，`/api/*` 全部要求 `Authorization: Bearer <token>`；
 * - **仅认 Header，不接受 query 参数**：避免令牌出现在 URL 中被 morgan 访问日志记录
 *   （日志脱敏是架构 §4.1 的既有约定），也避免被浏览器历史/Referer 泄露；
 * - **恒定时间比较**：用 `timingSafeEqual` 逐字节比对，避免时序侧信道；
 * - **不区分"令牌错误"与"未提供"**：统一返回 401 + 通用文案，不泄露任何线索。
 *
 * ── 多用户模式（P2-5）──
 * 令牌有三种，优先级从高到低：
 * 1. **登录态 token**（/api/auth/* 签发）：解析出真实 userId，写入 `req.userId`；
 * 2. **静态 ACCESS_TOKEN**：视为管理员，落 `ADMIN_USER_ID`（存量数据归属方）；
 * 3. 都没有 → 401。
 *
 * `req.userId` 是路由层取用户标识的唯一来源——路由层不再硬编码 DEFAULT_USER_ID
 * （修正 ARCHITECTURE §9.9 与实现长期不一致的问题）。
 *
 * 前端配合：H5 端 api/token.ts 从 localStorage 读取登录态 token；
 * 小程序端 utils/auth.ts 走 wx.login 静默登录后存 Storage，
 * api/client.ts 与 api/sse.ts 经 withAuthHeaders() 统一附加 Authorization 头。
 */
import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/env';
import { ADMIN_USER_ID, resolveToken } from '../services/auth.service';

/** 未授权（架构 §4.1 错误码表增补：4010 段为鉴权相关） */
export const UNAUTHORIZED_CODE = 4010;

/** 恒定时间字符串比较（长度不等时先返回 false，再逐字节比对） */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** 从 Authorization 头提取 Bearer 令牌（缺失/格式不符返回 null） */
function extractBearerToken(req: Request): string | null {
  const raw = req.get('authorization');
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  const matched = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return matched === null ? null : matched[1]!.trim();
}

/**
 * API 守卫：`config.security.accessToken` 为空时直接放行（局域网/本机部署模式）。
 * 挂载位置必须在 /api 路由之前。
 *
 * 多用户模式下会尝试解析登录态 token 并写入 `req.userId`。
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = config.security.accessToken;
  const provided = extractBearerToken(req);

  // 登录态 token 优先：/api/auth/* 签发的 token 能解析出真实用户
  if (provided !== null) {
    const resolved = resolveToken(provided);
    if (resolved !== null) {
      req.userId = resolved;
      next();
      return;
    }
  }

  // 静态 ACCESS_TOKEN → 管理员（存量数据归属方）
  if (expected !== '' && provided !== null && safeCompare(provided, expected)) {
    req.userId = ADMIN_USER_ID;
    next();
    return;
  }

  // ACCESS_TOKEN 未配置 = 零配置放行模式（局域网/本机）
  if (expected === '') {
    // 未配置任何凭证时，仍给出管理员身份：保持"单用户零配置启动"体验
    req.userId = ADMIN_USER_ID;
    next();
    return;
  }

  res.status(401).json({
    code: UNAUTHORIZED_CODE,
    data: null,
    message: '未授权：请提供有效的访问令牌',
  });
}
