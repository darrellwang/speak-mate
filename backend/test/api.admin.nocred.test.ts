/**
 * 未配置 ACCESS_TOKEN / ADMIN_PASSWORD 时，管理台必须保持关闭。
 * 零配置放行只覆盖学员接口，不能把 /api/admin 变成匿名入口。
 * 测试环境不会套用仅限 NODE_ENV=development 的本地默认口令。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

delete process.env.ACCESS_TOKEN;
delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;

const { createApp } = await import('../src/app');
const { FORBIDDEN_CODE, UNAUTHORIZED_CODE } = await import('../src/middleware/auth');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('未配置管理员密码', () => {
  it('匿名请求管理接口 → 401，而不是放行', async () => {
    const res = await request(server.baseUrl).get('/api/admin/health');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('任意 Bearer 也不能充当管理员', async () => {
    const res = await request(server.baseUrl)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer some-invite-session-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
    expect(res.body.code).not.toBe(FORBIDDEN_CODE);
  });

  it('未设置 ADMIN_PASSWORD 时登录被拒绝，且不接受本地开发默认口令', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'speakmate-local-dev-only' });
    expect(res.status).toBe(503);
    expect(res.body.message).toContain('ADMIN_PASSWORD');
    expect(JSON.stringify(res.body)).not.toContain('speakmate-local-dev-only');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('学员健康检查在零配置模式下仍然可用', async () => {
    const res = await request(server.baseUrl).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
