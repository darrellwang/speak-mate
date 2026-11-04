/**
 * 管理台鉴权与封禁闸门。
 *
 * 与 api.auth.test.ts 同一套路：先写 process.env，再动态 import app。
 * 邀请码换到的登录态必须被挡在 /api/admin 之外；封禁后 requireAuth 返回 401。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

const ADMIN_TOKEN = 'admin-token-for-console';
const ADMIN_PASSWORD = 'test-admin-password-not-production';
const INVITE_CODE = 'invite-code-for-admin-tests';

process.env.ACCESS_TOKEN = ADMIN_TOKEN;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
process.env.INVITE_CODES = INVITE_CODE;

const { createApp } = await import('../src/app');
const { FORBIDDEN_CODE, UNAUTHORIZED_CODE } = await import('../src/middleware/auth');
const { getDb } = await import('../src/db/database');

let server: TestServer;
let adminCookie = '';

function cookiePair(res: request.Response): string {
  const header = res.headers['set-cookie'];
  const lines = Array.isArray(header) ? header : [];
  const line = lines.find((item) => item.startsWith('speakmate_admin='));
  if (line === undefined) {
    throw new Error(`缺少管理台会话 cookie：${JSON.stringify(header)}`);
  }
  return line.split(';')[0] ?? '';
}

beforeAll(async () => {
  server = await startTestServer(createApp());
  const login = await request(server.baseUrl)
    .post('/api/admin/login')
    .send({ username: 'admin', password: ADMIN_PASSWORD });
  expect(login.status).toBe(200);
  adminCookie = cookiePair(login);
});

afterAll(async () => {
  await server.close();
});

interface LoginPayload {
  token: string;
  user: { id: string; nickname: string };
}

async function loginInvite(): Promise<LoginPayload> {
  const res = await request(server.baseUrl)
    .post('/api/auth/invite-login')
    .send({ code: INVITE_CODE })
    .expect(200);
  return res.body.data as LoginPayload;
}

describe('管理台登录', () => {
  it('正确的用户名和密码签发 httpOnly 会话，且不能拿这枚 cookie 绕过学员接口', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.username).toBe('admin');
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_TOKEN);

    const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('\n') : '';
    expect(setCookie).toMatch(/speakmate_admin=[^;]+/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\/api\/admin/);
    expect(setCookie).not.toMatch(/Secure/i);
    expect(setCookie).not.toContain(ADMIN_PASSWORD);

    const cookie = cookiePair(res);
    const users = await request(server.baseUrl).get('/api/admin/users').set('Cookie', cookie);
    expect(users.status).toBe(200);
    expect(users.body.code).toBe(0);

    const learner = await request(server.baseUrl).get('/api/sessions').set('Cookie', cookie);
    expect(learner.status).toBe(401);
    expect(learner.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('错误密码与错误用户名都返回 401，文案相同，且不签发会话', async () => {
    const badPass = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'wrong-password' });
    expect(badPass.status).toBe(401);
    expect(badPass.body.code).toBe(UNAUTHORIZED_CODE);
    expect(badPass.body.message).toBe('用户名或密码错误');
    expect(badPass.headers['set-cookie']).toBeUndefined();

    const badUser = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'root', password: ADMIN_PASSWORD });
    expect(badUser.status).toBe(401);
    expect(badUser.body.message).toBe(badPass.body.message);
    expect(badUser.headers['set-cookie']).toBeUndefined();
  });

  it('退出后同一会话不能再访问管理接口', async () => {
    const login = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD })
      .expect(200);
    const cookie = cookiePair(login);
    const out = await request(server.baseUrl).post('/api/admin/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    const cleared = Array.isArray(out.headers['set-cookie']) ? out.headers['set-cookie'].join('\n') : '';
    expect(cleared).toMatch(/Max-Age=0/i);

    const again = await request(server.baseUrl).get('/api/admin/health').set('Cookie', cookie);
    expect(again.status).toBe(401);
    expect(again.body.code).toBe(UNAUTHORIZED_CODE);
  });
});

describe('管理台鉴权', () => {
  it('无会话 → 401', async () => {
    const res = await request(server.baseUrl).get('/api/admin/users');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('邀请码登录态可以访问学员接口，但不能访问管理台', async () => {
    const { token } = await loginInvite();
    const me = await request(server.baseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);

    const adminRes = await request(server.baseUrl)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${token}`);
    expect(adminRes.status).toBe(403);
    expect(adminRes.body.code).toBe(FORBIDDEN_CODE);
    expect(adminRes.body.message).toContain('管理员');
  });

  it('ACCESS_TOKEN 不能打开管理台', async () => {
    const res = await request(server.baseUrl)
      .get('/api/admin/users')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(FORBIDDEN_CODE);
    expect(res.body.message).toContain('管理员');
  });

  it('登录会话可列出用户，响应不含访问令牌与管理员密码', async () => {
    const res = await request(server.baseUrl).get('/api/admin/users').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
    expect(Array.isArray(res.body.data.items)).toBe(true);
    expect(res.body.data.page).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(ADMIN_PASSWORD);
    expect(JSON.stringify(res.body)).not.toContain(INVITE_CODE);
  });

  it('统计与健康检查返回约定字段，且不探测外部 LLM', async () => {
    const stats = await request(server.baseUrl)
      .get('/api/admin/stats')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(stats.body.data.users.total).toBeGreaterThanOrEqual(1);
    expect(stats.body.data.users.by_source).toMatchObject({ wechat: expect.any(Number), invite: expect.any(Number) });
    expect(stats.body.data.sessions.total).toEqual(expect.any(Number));
    expect(stats.body.data.messages.total).toEqual(expect.any(Number));
    expect(stats.body.data.recent.messages_24h).toEqual(expect.any(Number));

    const health = await request(server.baseUrl)
      .get('/api/admin/health')
      .set('Cookie', adminCookie)
      .expect(200);
    expect(health.body.data.status).toBe('ok');
    expect(health.body.data.db).toBe('ok');
    expect(health.body.data.llm.probed).toBe(false);
    expect(health.body.data.schema.version).toBe(health.body.data.schema.user_version);
    expect(health.body.data.uptime_seconds).toEqual(expect.any(Number));
    expect(health.body.data.tts.mode).toBeTruthy();
    expect(JSON.stringify(health.body)).not.toContain(ADMIN_TOKEN);
  });
});

describe('封禁闸门', () => {
  it('仅把 status 改为 banned（会话仍在）时，requireAuth 返回 401', async () => {
    const { token, user } = await loginInvite();
    getDb()
      .prepare(`UPDATE users SET status = 'banned', banned_at = ?, ban_reason = ? WHERE id = ?`)
      .run(new Date().toISOString(), '手工封禁', user.id);

    const blocked = await request(server.baseUrl)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(blocked.status).toBe(401);
    expect(blocked.body.code).toBe(UNAUTHORIZED_CODE);
    expect(blocked.body.message).toBe('账号已被停用');

    await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/unban`)
      .set('Cookie', adminCookie)
      .expect(200);
  });

  it('封禁清空 auth_sessions，旧令牌与再次邀请登录都被拒绝，解封后恢复', async () => {
    const { token, user } = await loginInvite();
    await request(server.baseUrl)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const banned = await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/ban`)
      .set('Cookie', adminCookie)
      .send({ reason: '滥用邀请码' })
      .expect(200);
    expect(banned.body.data.user.status).toBe('banned');
    expect(banned.body.data.user.ban_reason).toBe('滥用邀请码');
    expect(banned.body.data.user.banned_at).toBeTruthy();

    const sessions = getDb()
      .prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?')
      .get(user.id) as { c: number };
    expect(sessions.c).toBe(0);

    const oldToken = await request(server.baseUrl)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${token}`);
    expect(oldToken.status).toBe(401);

    const relogin = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE });
    expect(relogin.status).toBe(401);
    expect(relogin.body.code).toBe(UNAUTHORIZED_CODE);
    expect(relogin.body.message).toBe('账号已被停用');

    const unbanned = await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/unban`)
      .set('Cookie', adminCookie)
      .expect(200);
    expect(unbanned.body.data.user.status).toBe('active');
    expect(unbanned.body.data.user.ban_reason).toBe('');
    expect(unbanned.body.data.user.banned_at).toBeNull();

    const again = await loginInvite();
    await request(server.baseUrl)
      .get('/api/sessions')
      .set('Authorization', `Bearer ${again.token}`)
      .expect(200);

    const stillNotAdmin = await request(server.baseUrl)
      .get('/api/admin/stats')
      .set('Authorization', `Bearer ${again.token}`);
    expect(stillNotAdmin.status).toBe(403);
    expect(stillNotAdmin.body.code).toBe(FORBIDDEN_CODE);
  });

  it('解封同样清空登录态', async () => {
    const { token, user } = await loginInvite();
    await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/ban`)
      .set('Cookie', adminCookie)
      .send({ reason: '短暂封禁' })
      .expect(200);
    await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/unban`)
      .set('Cookie', adminCookie)
      .expect(200);

    const { token: fresh } = await loginInvite();
    await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/unban`)
      .set('Cookie', adminCookie)
      .expect(200);

    const sessions = getDb()
      .prepare('SELECT COUNT(*) AS c FROM auth_sessions WHERE user_id = ?')
      .get(user.id) as { c: number };
    expect(sessions.c).toBe(0);
    const blocked = await request(server.baseUrl)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${fresh}`);
    expect(blocked.status).toBe(401);
    expect(token).not.toBe(fresh);
  });

  it('不存在的用户 → 404；不能封禁 admin；原因过长 → 400', async () => {
    const missing = await request(server.baseUrl)
      .post('/api/admin/users/no-such-user/ban')
      .set('Cookie', adminCookie)
      .send({ reason: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe(2004);

    const adminBan = await request(server.baseUrl)
      .post('/api/admin/users/admin/ban')
      .set('Cookie', adminCookie)
      .send({});
    expect(adminBan.status).toBe(400);
    expect(adminBan.body.code).toBe(1001);

    const { user } = await loginInvite();
    const longReason = await request(server.baseUrl)
      .post(`/api/admin/users/${user.id}/ban`)
      .set('Cookie', adminCookie)
      .send({ reason: '长'.repeat(201) });
    expect(longReason.status).toBe(400);
  });

  it('用户列表支持搜索与分页，且不返回对话正文', async () => {
    const now = new Date().toISOString();
    const db = getDb();
    const insertUser = db.prepare(
      `INSERT INTO users (id, openid, source, nickname, created_at, last_login_at, status, ban_reason)
       VALUES (?, NULL, 'invite', ?, ?, ?, 'active', '')`,
    );
    insertUser.run('usr_search_alpha', '搜索专用阿尔法', now, now);
    insertUser.run('usr_search_beta', '搜索专用贝塔', now, now);
    db.prepare(
      `INSERT INTO sessions (id, user_id, scene_id, title, created_at, updated_at)
       VALUES ('sess-search-alpha', 'usr_search_alpha', 'daily-standup', 'hidden', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO messages (id, session_id, user_id, role, content, created_at)
       VALUES ('msg-secret', 'sess-search-alpha', 'usr_search_alpha', 'user', '这是不该出现在管理台的原文', ?)`,
    ).run(now);

    const found = await request(server.baseUrl)
      .get('/api/admin/users')
      .query({ q: '阿尔法', page: 1, page_size: 10 })
      .set('Cookie', adminCookie)
      .expect(200);
    expect(found.body.data.total).toBe(1);
    expect(found.body.data.items[0].id).toBe('usr_search_alpha');
    expect(found.body.data.items[0].message_count).toBe(1);
    expect(JSON.stringify(found.body)).not.toContain('这是不该出现在管理台的原文');

    const wildcard = await request(server.baseUrl)
      .get('/api/admin/users')
      .query({ q: '%' })
      .set('Cookie', adminCookie)
      .expect(200);
    expect(wildcard.body.data.total).toBe(0);

    const page = await request(server.baseUrl)
      .get('/api/admin/users')
      .query({ page_size: 1, page: 1 })
      .set('Cookie', adminCookie)
      .expect(200);
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.total).toBeGreaterThan(1);

    const badPage = await request(server.baseUrl)
      .get('/api/admin/users')
      .query({ page_size: 101 })
      .set('Cookie', adminCookie);
    expect(badPage.status).toBe(400);
  });
});
