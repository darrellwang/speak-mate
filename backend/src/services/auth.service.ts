/**
 * 认证服务（services/auth.service.ts）—— 多用户体系 P2-5
 *
 * 身份来源有三，统一收敛为「后端自签 token」：
 * - 微信小程序：wx.login() → code → auth.code2Session → openid；
 * - 邀请码：主人后台生成的一次性/长期邀请码；
 * - 静态 ACCESS_TOKEN：保留为管理员凭证（兼容既有部署）。
 *
 * 安全约定：
 * - **token 明文只在登录响应里返回一次**，服务端只存 sha256(token)；
 *   即使数据库被拖走也无法直接冒用（离线爆破需拿到原始 token）；
 * - **session_key 绝不下发前端**，只在服务端内存中用于校验，不落库；
 * - 昵称由服务端随机生成（不取微信昵称/头像，遵循"最小必要"原则）；
 * - 邀请码用 crypto.timingSafeEqual 恒定时间比对，避免时序侧信道。
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { User } from '../../../shared/types/models';
import { getDb } from '../db/database';
import { badRequest, ErrorCode, ApiError } from '../middleware/error';

/* ---------- 常量 ---------- */

/** 登录态有效期：30 天 */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 管理员账号 id（存量数据迁移的归属方，见 migration v3） */
export const ADMIN_USER_ID = 'admin';

/** 昵称随机词库：形容词 + 名词，组合出「开朗的小鲸鱼」这类友好展示名 */
const NICKNAME_ADJECTIVES = [
  '开朗', '安静', '勤奋', '好奇', '温柔', '勇敢', '专注', '轻松',
  '沉稳', '机灵', '耐心', '自信', '热情', '冷静', '乐观', '细腻',
] as const;

const NICKNAME_NOUNS = [
  '小鲸鱼', '海豚', '狐狸', '兔子', '猫头鹰', '企鹅', '松鼠', '小鹿',
  '海豹', '水獭', '刺猬', '浣熊', '企鹅', '柴犬', '灰雁', '夜鹭',
] as const;

/* ---------- 行类型 ---------- */

interface UserRow {
  id: string;
  openid: string | null;
  source: string;
  nickname: string;
  created_at: string;
  last_login_at: string;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    source: row.source === 'wechat' ? 'wechat' : 'invite',
    nickname: row.nickname,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
  };
}

/* ---------- 工具 ---------- */

/** 生成随机展示名（不采集用户任何真实身份信息） */
function randomNickname(): string {
  const adj = NICKNAME_ADJECTIVES[randomBytes(1)[0]! % NICKNAME_ADJECTIVES.length]!;
  const noun = NICKNAME_NOUNS[randomBytes(1)[0]! % NICKNAME_NOUNS.length]!;
  return `${adj}的${noun}`;
}

/** sha256 十六进制摘要 */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 恒定时间字符串比较（长度不等直接 false） */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ---------- 用户读写 ---------- */

/** 按 openid 查用户（不存在返回 undefined） */
export function findUserByOpenid(openid: string): User | undefined {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE openid = ?')
    .get(openid) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

/** 按 id 查用户 */
export function findUserById(id: string): User | undefined {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

/**
 * 按 openid 获取或创建用户（微信登录主路径）。
 *
 * 首次登录时随机生成昵称；后续登录保留原昵称，仅刷新 last_login_at。
 */
export function upsertWechatUser(openid: string): User {
  const db = getDb();
  const existing = findUserByOpenid(openid);
  const now = new Date().toISOString();
  if (existing) {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, existing.id);
    return { ...existing, last_login_at: now };
  }
  const id = randomUUID();
  const nickname = randomNickname();
  db.prepare(
    'INSERT INTO users (id, openid, source, nickname, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(id, openid, 'wechat', nickname, now, now);
  return { id, source: 'wechat', nickname, created_at: now, last_login_at: now };
}

/**
 * 按邀请码获取或创建用户（主人 / 邀请码登录路径）。
 *
 * 邀请码由部署方在 .env 中配置（逗号分隔），不在数据库中存储——
 * 它是"谁能进这个应用"的门禁，而非用户凭证。
 *
 * ⚠️ 每个邀请码对应**独立账号**（P2-5 数据隔离要求）：
 * 若所有邀请码都落到同一个账号，不同受邀者会共享会话与词汇本，隔离失效。
 * 这里用邀请码的 sha256 前 16 位派生稳定的 userId——
 * 同一个邀请码永远映射到同一个账号（重复登录不会产生新账号），
 * 不同邀请码则天然隔离。
 */
export function upsertInviteUser(inviteCode: string, allowedCodes: readonly string[]): User {
  const matched = allowedCodes.find((code) => safeEqual(code, inviteCode));
  if (matched === undefined) {
    throw new ApiError(401, ErrorCode.UNAUTHORIZED, '邀请码无效');
  }
  const db = getDb();
  const now = new Date().toISOString();

  // 由邀请码派生稳定 id：同一邀请码 → 同一账号；不同邀请码 → 不同账号
  const derivedId = `inv_${sha256(matched).slice(0, 16)}`;

  const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(derivedId) as
    | UserRow
    | undefined;
  if (existing) {
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, derivedId);
    return { ...rowToUser(existing), last_login_at: now };
  }

  const nickname = randomNickname();
  db.prepare(
    'INSERT INTO users (id, openid, source, nickname, created_at, last_login_at) VALUES (?, NULL, ?, ?, ?, ?)',
  ).run(derivedId, 'invite', nickname, now, now);
  return { id: derivedId, source: 'invite', nickname, created_at: now, last_login_at: now };
}

/* ---------- 登录态签发与校验 ---------- */

export interface AuthResult {
  /** 原始 token（仅此一次返回，之后不再可取） */
  token: string;
  user: User;
  /** 过期时间（ISO 8601） */
  expires_at: string;
}

/**
 * 签发登录态：生成 32 字节随机 token，服务端只存 sha256。
 *
 * 每次签发前清理该用户的过期会话，避免表无限膨胀。
 */
export function issueToken(userId: string): AuthResult {
  const db = getDb();
  const token = randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const issue = db.transaction((): void => {
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now.toISOString());
    db.prepare(
      'INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    ).run(tokenHash, userId, now.toISOString(), expiresAt.toISOString());
  });
  issue();

  const user = findUserById(userId);
  if (!user) {
    throw new ApiError(500, ErrorCode.INTERNAL, '用户不存在');
  }
  return { token, user, expires_at: expiresAt.toISOString() };
}

/**
 * 校验 token 并返回对应 userId。
 * token 无效 / 过期 / 用户已不存在 → 返回 null（调用方转 401）。
 */
export function resolveToken(token: string): string | null {
  const db = getDb();
  const row = db
    .prepare('SELECT user_id, expires_at FROM auth_sessions WHERE token_hash = ?')
    .get(sha256(token)) as { user_id: string; expires_at: string } | undefined;
  if (!row) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    // 过期会话顺手清理
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(token));
    return null;
  }
  return row.user_id;
}

/** 注销当前用户的全部登录态（改密码 / 换设备 / 察觉异常时用） */
export function revokeTokens(userId: string): void {
  getDb().prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
}

/* ---------- 微信 code2Session ---------- */

interface Code2SessionResult {
  openid: string;
  session_key: string;
  unionid?: string;
}

/**
 * 用 wx.login 拿到的 code 换 openid。
 *
 * ⚠️ session_key 仅在服务端内存中流转，**绝不返回给前端、绝不落库**。
 *
 * 微信对未声明隐私协议的小程序会返回带 `temp-` 前缀的 openid——
 * 那是临时值，不稳定，不能用于持久绑定用户数据。这里显式拦截并给出可执行的提示。
 */
export async function exchangeCodeForOpenid(
  code: string,
  appId: string,
  appSecret: string,
): Promise<{ openid: string }> {
  const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
  url.searchParams.set('appid', appId);
  url.searchParams.set('secret', appSecret);
  url.searchParams.set('js_code', code);
  url.searchParams.set('grant_type', 'authorization_code');

  let res: Response;
  try {
    res = await fetch(url.toString(), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(502, ErrorCode.LLM_CONNECT, `微信登录服务连接失败：${detail}`);
  }

  const payload = (await res.json().catch(() => ({}))) as Partial<Code2SessionResult> & {
    errcode?: number;
    errmsg?: string;
  };

  if (payload.errcode !== undefined && payload.errcode !== 0) {
    throw new ApiError(401, ErrorCode.UNAUTHORIZED, `微信登录失败（${payload.errcode}）：${payload.errmsg ?? '未知错误'}`);
  }
  const openid = payload.openid;
  if (typeof openid !== 'string' || openid === '') {
    throw new ApiError(502, ErrorCode.LLM_CONNECT, '微信登录未返回 openid');
  }
  if (openid.startsWith('temp-')) {
    // 隐私协议未声明：拿到的 openid 是临时的，不能用于绑定用户
    throw new ApiError(
      500,
      ErrorCode.INTERNAL,
      '微信未返回稳定 openid：请在微信公众平台《用户隐私保护指引》中声明「用户账号信息 / OpenID」并勾选 wx.login 权限后重新提交审核',
    );
  }
  return { openid };
}

/* ---------- 数据删除（PIPL 删除权） ---------- */

/**
 * 清除指定用户的全部业务数据。
 *
 * 涉及四张表：messages（随 sessions 级联删除）、sessions、vocabulary、user_profile。
 * user_profile 为单行 upsert 结构，删除后下次访问会自动重建空画像。
 * **不动 users 与 auth_sessions**：账号本身保留，仅清空其业务数据
 * （完全注销账号属于另一条流程，暂不在此实现）。
 */
export function deleteUserData(userId: string): { sessions: number; words: number } {
  const db = getDb();
  const sessionCount = (
    db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(userId) as { c: number }
  ).c;
  const wordCount = (
    db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE user_id = ?').get(userId) as { c: number }
  ).c;

  const purge = db.transaction((): void => {
    // messages 由 FK ON DELETE CASCADE 随 sessions 删除
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM vocabulary WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_profile WHERE user_id = ?').run(userId);
  });
  purge();

  return { sessions: sessionCount, words: wordCount };
}

/* ---------- 参数校验 ---------- */

/**
 * 校验微信登录 code 的基本格式。
 *
 * 只做**宽松**的字符集与长度检查，不去匹配微信的精确格式：
 * 微信官方 code 是 32 位小写字母数字，但历史版本存在过其他长度，
 * 写死正则会导致「格式明明合法却被拒」的难查问题。
 *
 * 真正的有效性交给微信服务器判定（code2Session 会返回 40029 等错误），
 * 这里只挡掉明显不是 code 的输入（比如空串、超长字符串、前端传错了字段）。
 */
export function assertWechatCodeFormat(code: string): void {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(code)) {
    throw badRequest('code 格式非法');
  }
}
