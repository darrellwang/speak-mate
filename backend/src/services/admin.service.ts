/**
 * 管理台只读统计与封禁（services/admin.service.ts）
 *
 * 不返回对话正文。封禁 / 解封在同一事务里改 users 状态并清空 auth_sessions，
 * 使已签发的登录态立即失效。
 */

import { ADMIN_USER_ID } from '../config/env';
import { getDb } from '../db/database';
import { badRequest, userNotFound } from '../middleware/error';
import { revokeTokens } from './auth.service';

export type AdminUserStatus = 'active' | 'banned';

export interface AdminUser {
  id: string;
  openid: string | null;
  source: string;
  nickname: string;
  status: AdminUserStatus;
  banned_at: string | null;
  ban_reason: string;
  created_at: string;
  last_login_at: string;
  session_count: number;
  message_count: number;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminStats {
  users: {
    total: number;
    active: number;
    banned: number;
    by_source: { wechat: number; invite: number };
  };
  sessions: { total: number };
  messages: { total: number };
  recent: {
    new_users_7d: number;
    logins_7d: number;
    sessions_7d: number;
    messages_24h: number;
  };
  generated_at: string;
}

interface UserListRow {
  id: string;
  openid: string | null;
  source: string;
  nickname: string;
  status: string;
  banned_at: string | null;
  ban_reason: string | null;
  created_at: string;
  last_login_at: string;
  session_count: number;
  message_count: number;
}

const USER_SELECT = `
  SELECT
    u.id, u.openid, u.source, u.nickname, u.status, u.banned_at, u.ban_reason,
    u.created_at, u.last_login_at,
    (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS session_count,
    (SELECT COUNT(*) FROM messages m WHERE m.user_id = u.id) AS message_count
  FROM users u
`;

function rowToAdminUser(row: UserListRow): AdminUser {
  return {
    id: row.id,
    openid: row.openid,
    source: row.source,
    nickname: row.nickname,
    status: row.status === 'banned' ? 'banned' : 'active',
    banned_at: row.banned_at,
    ban_reason: row.ban_reason ?? '',
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    session_count: row.session_count,
    message_count: row.message_count,
  };
}

function countOf(sql: string, ...params: unknown[]): number {
  const row = getDb().prepare(sql).get(...params) as { c: number };
  return row.c;
}

/** LIKE 通配符转义（配合 ESCAPE '\\'） */
function escapeLike(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function listUsers(input: {
  q: string;
  status: '' | AdminUserStatus;
  page: number;
  pageSize: number;
}): AdminUserList {
  const where: string[] = [];
  const params: unknown[] = [];

  const q = input.q.trim();
  if (q !== '') {
    const like = `%${escapeLike(q)}%`;
    where.push(
      `(u.nickname LIKE ? ESCAPE '\\' OR u.id LIKE ? ESCAPE '\\' OR IFNULL(u.openid, '') LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }
  if (input.status !== '') {
    where.push('u.status = ?');
    params.push(input.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const total = countOf(`SELECT COUNT(*) AS c FROM users u ${whereSql}`, ...params);
  const offset = (input.page - 1) * input.pageSize;
  const rows = getDb()
    .prepare(
      `${USER_SELECT} ${whereSql} ORDER BY u.created_at DESC, u.id ASC LIMIT ? OFFSET ?`,
    )
    .all(...params, input.pageSize, offset) as UserListRow[];

  return {
    items: rows.map(rowToAdminUser),
    total,
    page: input.page,
    page_size: input.pageSize,
  };
}

function requireExistingUser(id: string): void {
  const row = getDb().prepare('SELECT id FROM users WHERE id = ?').get(id) as
    | { id: string }
    | undefined;
  if (!row) {
    throw userNotFound();
  }
}

/**
 * 封禁或解封。两种操作都会删除该用户的全部 auth_sessions。
 * 解封后用户需要重新登录。
 */
export function setUserBanned(id: string, banned: boolean, reason: string): AdminUser {
  if (id === ADMIN_USER_ID) {
    throw badRequest('不能封禁管理员身份');
  }
  requireExistingUser(id);

  const db = getDb();
  const now = new Date().toISOString();
  const apply = db.transaction((): void => {
    if (banned) {
      db.prepare(
        `UPDATE users SET status = 'banned', banned_at = ?, ban_reason = ? WHERE id = ?`,
      ).run(now, reason, id);
    } else {
      db.prepare(
        `UPDATE users SET status = 'active', banned_at = NULL, ban_reason = '' WHERE id = ?`,
      ).run(id);
    }
    revokeTokens(id);
  });
  apply();

  const row = db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserListRow | undefined;
  if (!row) {
    throw userNotFound();
  }
  return rowToAdminUser(row);
}

function isoAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

export function getAdminStats(): AdminStats {
  const day = 24 * 60 * 60 * 1000;
  const since7d = isoAgo(7 * day);
  const since24h = isoAgo(day);

  const bySource = { wechat: 0, invite: 0 };
  const sourceRows = getDb()
    .prepare(`SELECT source, COUNT(*) AS c FROM users GROUP BY source`)
    .all() as { source: string; c: number }[];
  for (const row of sourceRows) {
    if (row.source === 'wechat' || row.source === 'invite') {
      bySource[row.source] = row.c;
    }
  }

  const total = countOf('SELECT COUNT(*) AS c FROM users');
  const banned = countOf(`SELECT COUNT(*) AS c FROM users WHERE status = 'banned'`);

  return {
    users: {
      total,
      active: total - banned,
      banned,
      by_source: bySource,
    },
    sessions: { total: countOf('SELECT COUNT(*) AS c FROM sessions') },
    messages: { total: countOf('SELECT COUNT(*) AS c FROM messages') },
    recent: {
      new_users_7d: countOf('SELECT COUNT(*) AS c FROM users WHERE created_at >= ?', since7d),
      logins_7d: countOf('SELECT COUNT(*) AS c FROM users WHERE last_login_at >= ?', since7d),
      sessions_7d: countOf('SELECT COUNT(*) AS c FROM sessions WHERE created_at >= ?', since7d),
      messages_24h: countOf('SELECT COUNT(*) AS c FROM messages WHERE created_at >= ?', since24h),
    },
    generated_at: new Date().toISOString(),
  };
}
