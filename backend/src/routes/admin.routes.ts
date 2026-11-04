/**
 * 管理台接口（/api/admin/*）
 *
 * 登录和退出不要求学员 ACCESS_TOKEN。
 * 其余接口只接受用户名密码换到的 httpOnly 会话。
 * 邀请码 / 微信登录态 / ACCESS_TOKEN 一律 403，不在这里升级成管理员。
 *
 * 健康检查只做本地廉价探测（SQLite SELECT 1、进程 uptime、TTS 内存状态），
 * 不调用 LLM / 在线 TTS。
 */

import { Router } from 'express';
import { config } from '../config/env';
import { getDb } from '../db/database';
import { SCHEMA_VERSION, currentUserVersion } from '../db/migrate';
import { requireAdmin } from '../middleware/auth';
import { badRequest, ErrorCode, sendOk } from '../middleware/error';
import { adminLoginLimiter, readLimiter, writeLimiter } from '../middleware/rateLimit';
import { getAdminStats, listUsers, setUserBanned, type AdminUserStatus } from '../services/admin.service';
import {
  clearAdminSessionCookie,
  issueAdminSession,
  readAdminCookie,
  revokeAdminSession,
  setAdminSessionCookie,
  verifyAdminCredentials,
} from '../services/admin-session.service';
import { localTtsStatus } from '../services/tts.service';

export const adminRouter = Router();

const USERNAME_MAX = 64;
const PASSWORD_MAX = 256;

/** POST /api/admin/login  { username, password } → Set-Cookie，正文不含口令与会话 token */
adminRouter.post('/login', adminLoginLimiter, (req, res) => {
  if (!config.security.adminEnabled) {
    res.status(503).json({
      code: ErrorCode.INTERNAL,
      data: null,
      message: '管理台未启用：请设置 ADMIN_PASSWORD 后重启',
    });
    return;
  }

  const body = req.body as { username?: unknown; password?: unknown } | null;
  const username = body !== null && typeof body === 'object' && typeof body.username === 'string'
    ? body.username.trim()
    : '';
  const password = body !== null && typeof body === 'object' && typeof body.password === 'string'
    ? body.password
    : '';
  const shaped = username.length > 0
    && username.length <= USERNAME_MAX
    && password.length > 0
    && password.length <= PASSWORD_MAX;
  if (!shaped || !verifyAdminCredentials(username, password)) {
    res.status(401).json({
      code: ErrorCode.UNAUTHORIZED,
      data: null,
      message: '用户名或密码错误',
    });
    return;
  }

  setAdminSessionCookie(req, res, issueAdminSession());
  sendOk(res, { username: config.security.adminUsername });
});

/** POST /api/admin/logout → 作废当前管理会话并清 cookie */
adminRouter.post('/logout', (req, res) => {
  revokeAdminSession(readAdminCookie(req));
  clearAdminSessionCookie(req, res);
  sendOk(res, {});
});

adminRouter.use(requireAdmin);

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parsePositiveInt(raw: unknown, fallback: number, name: string, max: number): number {
  if (raw === undefined || raw === '') return fallback;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    throw badRequest(`${name} 必须是正整数`);
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw badRequest(`${name} 超出范围`);
  }
  return value;
}

function parseStatusFilter(raw: unknown): '' | AdminUserStatus {
  if (raw === undefined || raw === '') return '';
  if (raw === 'active' || raw === 'banned') return raw;
  throw badRequest('status 只能是 active 或 banned');
}

function parseReason(body: unknown): string {
  if (body === undefined || body === null || body === '') return '';
  if (typeof body !== 'object') {
    throw badRequest('请求体格式非法');
  }
  const reason = (body as { reason?: unknown }).reason;
  if (reason === undefined || reason === null || reason === '') return '';
  if (typeof reason !== 'string') {
    throw badRequest('reason 必须是字符串');
  }
  const trimmed = reason.trim();
  if (trimmed.length > 200) {
    throw badRequest('封禁原因不能超过 200 字');
  }
  return trimmed;
}

function assertUserId(raw: string): string {
  const id = raw.trim();
  if (!USER_ID_RE.test(id)) {
    throw badRequest('用户 id 格式非法');
  }
  return id;
}

/** GET /api/admin/users?q=&status=&page=&page_size= */
adminRouter.get('/users', readLimiter, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  const page = parsePositiveInt(req.query.page, 1, 'page', 100_000);
  const pageSize = parsePositiveInt(req.query.page_size, 20, 'page_size', 100);
  const status = parseStatusFilter(req.query.status);
  sendOk(res, listUsers({ q, status, page, pageSize }));
});

/** POST /api/admin/users/:id/ban  { reason? } */
adminRouter.post('/users/:id/ban', writeLimiter, (req, res) => {
  const user = setUserBanned(assertUserId(req.params.id), true, parseReason(req.body));
  sendOk(res, { user });
});

/** POST /api/admin/users/:id/unban */
adminRouter.post('/users/:id/unban', writeLimiter, (req, res) => {
  const user = setUserBanned(assertUserId(req.params.id), false, '');
  sendOk(res, { user });
});

/** GET /api/admin/stats */
adminRouter.get('/stats', readLimiter, (_req, res) => {
  sendOk(res, getAdminStats());
});

/**
 * GET /api/admin/health
 * 比公开 /api/health 多：uptime、schema 版本、是否配置了 Key（布尔，不含密钥本身）。
 */
adminRouter.get('/health', readLimiter, (_req, res) => {
  let dbStatus: 'ok' | 'error' = 'ok';
  let userVersion: number | null = null;
  try {
    const db = getDb();
    db.prepare('SELECT 1 AS one').get();
    userVersion = currentUserVersion(db);
  } catch (err) {
    console.error('[admin/health] database check failed:', err);
    dbStatus = 'error';
  }

  const schemaOk = userVersion === SCHEMA_VERSION;
  const keyPresent = config.llm.apiKey !== '' && config.llm.apiKey !== 'not-needed';

  sendOk(res, {
    status: dbStatus === 'ok' && schemaOk ? 'ok' : 'degraded',
    db: dbStatus,
    llm: {
      provider: config.llm.provider,
      model: config.llm.model,
      /** 管理台不做真实 LLM 探测，避免健康检查打到付费接口 */
      probed: false,
      key_present: keyPresent,
    },
    tts: { mode: config.tts.engine, local: localTtsStatus() },
    uptime_seconds: Math.round(process.uptime()),
    schema: { version: SCHEMA_VERSION, user_version: userVersion },
    node: process.version,
  });
});
