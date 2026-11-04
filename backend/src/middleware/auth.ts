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
 * 2. **静态 ACCESS_TOKEN**：学员侧主人身份，落 `ADMIN_USER_ID`，`req.isAdmin` 仍为 false；
 * 3. 都没有 → 401（ACCESS_TOKEN 未配置时则零配置放行，但 **不是** 管理员）。
 *
 * 管理台不走上面这条链。它只认用户名密码换到的 httpOnly 会话，
 * 由 `requireAdmin` 自己校验。邀请码 / 微信登录态 / ACCESS_TOKEN 一律不能打开管理台。
 * 封禁用户在登录态解析成功后直接 401，不再进入业务路由。
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
import { ErrorCode } from './error';
import { adminSessionActive, readAdminCookie } from '../services/admin-session.service';
import { ADMIN_USER_ID, isUserBanned, resolveToken } from '../services/auth.service';

/** 未授权（架构 §4.1 错误码表增补：4010 段为鉴权相关） */
export const UNAUTHORIZED_CODE = ErrorCode.UNAUTHORIZED;

/** 非管理员（邀请码 / 微信登录态 / 零配置放行都不能进 /api/admin） */
export const FORBIDDEN_CODE = ErrorCode.FORBIDDEN;

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

  // 登录态 token 优先：/api/auth/* 签发的 token 能解析出真实用户。
  // 这类令牌永远不是管理台凭证（即使 userId 碰巧叫 admin）。
  if (provided !== null) {
    const resolved = resolveToken(provided);
    if (resolved !== null) {
      if (isUserBanned(resolved)) {
        res.status(401).json({
          code: UNAUTHORIZED_CODE,
          data: null,
          message: '账号已被停用',
        });
        return;
      }
      req.userId = resolved;
      req.isAdmin = false;
      next();
      return;
    }
  }

  // 静态 ACCESS_TOKEN → 学员侧主人身份（存量数据归属方）。不能打开管理台。
  if (expected !== '' && provided !== null && safeCompare(provided, expected)) {
    req.userId = ADMIN_USER_ID;
    req.isAdmin = false;
    next();
    return;
  }

  // ACCESS_TOKEN 未配置 = 零配置放行模式（局域网/本机）。
  // 学员接口保持可用，但 isAdmin 明确为 false，避免管理接口裸奔。
  if (expected === '') {
    req.userId = ADMIN_USER_ID;
    req.isAdmin = false;
    next();
    return;
  }

  res.status(401).json({
    code: UNAUTHORIZED_CODE,
    data: null,
    message: '未授权：请提供有效的访问令牌',
  });
}

/**
 * 管理台守卫。挂在 /api/admin 的业务路由上，不依赖 requireAuth。
 *
 * 只放行 httpOnly 管理会话。邀请码 / 微信登录态和 ACCESS_TOKEN 返回 403，
 * 没有会话返回 401。零配置放行不会把管理接口变成匿名入口。
 */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (adminSessionActive(readAdminCookie(req))) {
    req.userId = ADMIN_USER_ID;
    req.isAdmin = true;
    next();
    return;
  }

  const provided = extractBearerToken(req);
  if (provided !== null) {
    const resolved = resolveToken(provided);
    const expected = config.security.accessToken;
    const learnerCredential = resolved !== null || (expected !== '' && safeCompare(provided, expected));
    if (learnerCredential) {
      res.status(403).json({
        code: FORBIDDEN_CODE,
        data: null,
        message: '需要管理员身份',
      });
      return;
    }
  }

  res.status(401).json({
    code: UNAUTHORIZED_CODE,
    data: null,
    message: '请先登录管理台',
  });
}
