/**
 * 管理台会话（与学员 auth_sessions 分开）。
 *
 * 登录成功后只把随机 token 放进 httpOnly cookie，服务端存 sha256。
 * 明文 token 不进 JSON、不进日志。进程重启后会话失效，需要重新登录。
 * 有效期 8 小时，短于学员登录态的 30 天。
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config/env';

export const ADMIN_COOKIE_NAME = 'speakmate_admin';
export const ADMIN_SESSION_TTL_SECONDS = 8 * 60 * 60;

const sessions = new Map<string, number>();

function sha256(input: string): Buffer {
  return createHash('sha256').update(input, 'utf8').digest();
}

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

function pruneExpired(now: number): void {
  for (const [hash, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(hash);
  }
}

export function verifyAdminCredentials(username: string, password: string): boolean {
  if (!config.security.adminEnabled) return false;
  const userOk = safeEqual(username, config.security.adminUsername);
  const passOk = safeEqual(password, config.security.adminPassword);
  return userOk && passOk;
}

export function issueAdminSession(): string {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  pruneExpired(now);
  sessions.set(sha256(token).toString('hex'), now + ADMIN_SESSION_TTL_SECONDS * 1000);
  return token;
}

export function readAdminCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length === 0) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== ADMIN_COOKIE_NAME) continue;
    try {
      const value = decodeURIComponent(part.slice(eq + 1).trim());
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function adminSessionActive(token: string | null): boolean {
  if (token === null || token.length === 0) return false;
  const hash = sha256(token).toString('hex');
  const expiresAt = sessions.get(hash);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(hash);
    return false;
  }
  return true;
}

export function revokeAdminSession(token: string | null): void {
  if (token === null || token.length === 0) return;
  sessions.delete(sha256(token).toString('hex'));
}

function cookieSecure(): boolean {
  return process.env.NODE_ENV === 'production';
}

function writeCookie(res: Response, value: string, maxAge: number): void {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(value)}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (cookieSecure()) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function setAdminSessionCookie(res: Response, token: string): void {
  writeCookie(res, token, ADMIN_SESSION_TTL_SECONDS);
}

export function clearAdminSessionCookie(res: Response): void {
  writeCookie(res, '', 0);
}
