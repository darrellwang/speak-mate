/**
 * 多用户隔离测试（P2-5）
 *
 * 验证三件事：
 * 1. **数据隔离**：用户 A 创建的会话/词条，用户 B 看不到；
 * 2. **身份解析**：登录态 token 解析出真实 userId，静态 ACCESS_TOKEN 落 admin；
 * 3. **生命周期**：注销后 token 失效、数据删除通道可用。
 *
 * 与其他测试文件的区别：本文件**动态 import** src/app（设置 ACCESS_TOKEN 后再加载），
 * 与 api.auth.test.ts 同一套路——config/env.ts 在模块加载时读 env，静态 import 会被提升。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestServer, type TestServer } from './helpers/server';

const ADMIN_TOKEN = 'admin-token-multi-user';
/** 两个不同的邀请码 → 两个独立账号（每个邀请码派生一个稳定 userId） */
const INVITE_CODE_A = 'invite-code-a-multi-user';
const INVITE_CODE_B = 'invite-code-b-multi-user';

process.env.ACCESS_TOKEN = ADMIN_TOKEN;
process.env.INVITE_CODES = `${INVITE_CODE_A},${INVITE_CODE_B}`;
// 微信登录配置（假值即可：真实外呼已被 stubGlobal 拦截，见各用例）
process.env.WECHAT_APP_ID = 'wx-test-appid';
process.env.WECHAT_APP_SECRET = 'test-secret-not-real';

const { createApp } = await import('../src/app');
const { UNAUTHORIZED_CODE } = await import('../src/middleware/auth');

let server: TestServer;
let app: Express;

/** 以某个令牌发起请求 */
function asToken(token: string) {
  return {
    get: (path: string) => request(server.baseUrl).get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string) =>
      request(server.baseUrl).post(path).set('Authorization', `Bearer ${token}`),
    delete: (path: string) =>
      request(server.baseUrl).delete(path).set('Authorization', `Bearer ${token}`),
    patch: (path: string) =>
      request(server.baseUrl).patch(path).set('Authorization', `Bearer ${token}`),
  };
}

beforeAll(async () => {
  app = createApp();
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('P2-5 · 登录与身份解析', () => {
  it('邀请码登录 → 返回 token + 随机昵称用户', async () => {
    const res = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    expect(res.body.code).toBe(0);
    const { token, user } = res.body.data;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(32);
    expect(user.nickname).toBeTruthy();
    // 昵称随机生成，不是微信昵称
    expect(user.nickname).not.toContain('@');
  });

  it('错误邀请码 → 401', async () => {
    const res = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: 'wrong-code' })
      .expect(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('空 code → 400', async () => {
    const res = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: '' })
      .expect(400);
    expect(res.body.code).toBe(1001);
  });

  it('微信登录：code 格式宽松校验（开发者工具假 code 应被转发给微信，而非本地拦截）', async () => {
    // 开发者工具模拟器的 wx.login 返回形如 devtools_fake_code 的假值：
    // 本地不该用严格正则拦它，应转发到微信服务器，由微信判定真伪。
    //
    // ⚠️ 用 stubGlobal 模拟微信响应（errcode 40029 = invalid code），
    // 不做真实外呼——这个用例曾靠 .env 的真实 AppSecret 才通过，
    // 属于"测试隐式依赖生产凭据"，关闭 dotenv 后暴露出来。
    const wechatResponse = {
      ok: true,
      status: 200,
      json: async () => ({ errcode: 40029, errmsg: 'invalid code' }),
    };
    vi.stubGlobal('fetch', vi.fn(async () => wechatResponse));
    try {
      const res = await request(server.baseUrl)
        .post('/api/auth/wechat-login')
        .send({ code: 'devtools_fake_code' })
        .expect(401);
      expect(res.body.code).toBe(UNAUTHORIZED_CODE);
      // 消息来自微信服务器（40029）而不是本地格式校验（1001）
      expect(res.body.message).toContain('40029');
      expect(res.body.message).not.toContain('格式非法');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('微信登录：成功路径（mock 微信返回 openid）→ 200 + token + wechat 账号', async () => {
    // 之前从未覆盖过成功路径（曾靠 .env 的真实 Secret + 真实微信外呼，
    // 既依赖生产凭据又依赖外网）。现在 mock fetch 返回合法 openid。
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ openid: 'oMockOpenId_success_12345', session_key: 'sk' }),
    })));
    try {
      const res = await request(server.baseUrl)
        .post('/api/auth/wechat-login')
        .send({ code: '0123456789abcdef0123456789abcdef' })
        .expect(200);
      expect(res.body.code).toBe(0);
      const { token, user } = res.body.data;
      expect(typeof token).toBe('string');
      expect(token.length).toBeGreaterThan(32);
      expect(user.id).toBeTruthy();
      expect(user.nickname).toBeTruthy();

      // 登录态 token 立即可用于受保护接口
      const me = await request(server.baseUrl)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(me.body.data.user.id).toBe(user.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('微信登录：明显非法的 code（超长/含特殊字符）→ 400 本地拦截', async () => {
    const res = await request(server.baseUrl)
      .post('/api/auth/wechat-login')
      .send({ code: 'a'.repeat(200) })
      .expect(400);
    expect(res.body.code).toBe(1001);
  });

  it('静态 ACCESS_TOKEN → 身份为 admin', async () => {
    const res = await asToken(ADMIN_TOKEN).get('/api/auth/me').expect(200);
    expect(res.body.data.user.id).toBe('admin');
  });

  it('无令牌访问受保护接口 → 401', async () => {
    const res = await request(server.baseUrl).get('/api/sessions').expect(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('伪造令牌 → 401', async () => {
    const res = await asToken('fake-token-xyz').get('/api/sessions').expect(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });
});

describe('P2-5 · 数据隔离', () => {
  it('两个用户的会话互相不可见', async () => {
    // 用户 A 登录
    const loginA = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    const tokenA = loginA.body.data.token;

    // 用户 A 创建一个会话
    const created = await asToken(tokenA).post('/api/sessions').send({ scene_id: 'daily-standup' });
    expect(created.status).toBe(201);
    const sessionAId = created.body.data.session.id;

    // 用户 A 能看到自己的会话
    const listA = await asToken(tokenA).get('/api/sessions').expect(200);
    expect(listA.body.data.items.some((s: { id: string }) => s.id === sessionAId)).toBe(true);

    // 管理员（不同 userId）看不到用户 A 的会话
    const listAdmin = await asToken(ADMIN_TOKEN).get('/api/sessions').expect(200);
    expect(listAdmin.body.data.items.some((s: { id: string }) => s.id === sessionAId)).toBe(false);

    // 用户 A 直接按 id 访问管理员的会话 → 404（不是 403，避免泄露存在性）
    const adminSessions = await asToken(ADMIN_TOKEN).get('/api/sessions').expect(200);
    const adminSessionId = adminSessions.body.data.items[0]?.id;
    if (adminSessionId !== undefined) {
      const cross = await asToken(tokenA).get(`/api/sessions/${adminSessionId}`).expect(404);
      expect(cross.body.code).toBe(2001);
    }
  });

  it('词汇本按用户隔离：同一单词在两个用户下互不覆盖', async () => {
    const loginA = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    const tokenA = loginA.body.data.token;

    const loginB = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_B })
      .expect(200);
    const tokenB = loginB.body.data.token;

    // 两个用户各自存同一个词
    await asToken(tokenA)
      .post('/api/words')
      .send({ word: 'leverage', definition: 'A 的释义' })
      .expect(200);
    await asToken(tokenB)
      .post('/api/words')
      .send({ word: 'leverage', definition: 'B 的释义' })
      .expect(200);

    // 各自看到自己的释义
    const wordsA = await asToken(tokenA).get('/api/words').expect(200);
    const wordsB = await asToken(tokenB).get('/api/words').expect(200);

    const itemA = wordsA.body.data.items.find((w: { word: string }) => w.word === 'leverage');
    const itemB = wordsB.body.data.items.find((w: { word: string }) => w.word === 'leverage');

    expect(itemA).toBeDefined();
    expect(itemB).toBeDefined();
    expect(itemA.definition).toBe('A 的释义');
    expect(itemB.definition).toBe('B 的释义');
  });

  it('画像按用户隔离：常错统计互不串', async () => {
    const loginA = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    const tokenA = loginA.body.data.token;

    const profileA = await asToken(tokenA).get('/api/profile').expect(200);
    const profileAdmin = await asToken(ADMIN_TOKEN).get('/api/profile').expect(200);

    // 两个用户画像的会话数各自独立
    expect(profileA.body.data.stats.session_count).not.toBe(
      profileAdmin.body.data.stats.session_count,
    );
  });
});

describe('P2-5 · 生命周期', () => {
  it('注销后 token 失效 → 401', async () => {
    const login = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    const token = login.body.data.token;

    // 注销前可访问
    await asToken(token).get('/api/sessions').expect(200);

    // 注销
    await asToken(token).post('/api/auth/logout').expect(200);

    // 注销后 401
    const res = await asToken(token).get('/api/sessions').expect(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('清除我的数据 → 清空会话与词条，画像归零', async () => {
    const login = await request(server.baseUrl)
      .post('/api/auth/invite-login')
      .send({ code: INVITE_CODE_A })
      .expect(200);
    const token = login.body.data.token;

    // 先造点数据
    await asToken(token).post('/api/sessions').send({ scene_id: 'daily-standup' }).expect(201);
    await asToken(token).post('/api/words').send({ word: 'ephemeral' }).expect(200);

    const before = await asToken(token).get('/api/profile').expect(200);
    expect(before.body.data.stats.session_count).toBeGreaterThan(0);

    // 清除
    const res = await asToken(token).delete('/api/me/data').expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.deleted.sessions).toBeGreaterThan(0);

    // 清空后归零
    const after = await asToken(token).get('/api/profile').expect(200);
    expect(after.body.data.stats.session_count).toBe(0);
    expect(after.body.data.stats.word_count).toBe(0);
  });
});
