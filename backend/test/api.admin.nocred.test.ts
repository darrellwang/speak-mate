/**
 * 未配置 ACCESS_TOKEN 时，管理台必须保持关闭。
 * 零配置放行只覆盖学员接口，不能把 /api/admin 变成匿名入口。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

delete process.env.ACCESS_TOKEN;

const { createApp } = await import('../src/app');
const { FORBIDDEN_CODE } = await import('../src/middleware/auth');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('未配置 ACCESS_TOKEN', () => {
  it('匿名请求管理接口 → 403，而不是放行', async () => {
    const res = await request(server.baseUrl).get('/api/admin/health');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(FORBIDDEN_CODE);
  });

  it('任意 Bearer 也不能充当管理员', async () => {
    const res = await request(server.baseUrl)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer some-invite-session-token');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(FORBIDDEN_CODE);
  });

  it('学员健康检查在零配置模式下仍然可用', async () => {
    const res = await request(server.baseUrl).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });
});
