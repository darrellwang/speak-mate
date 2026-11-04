/**
 * 生产环境未设置 ADMIN_PASSWORD 时，管理台登录必须关闭。
 * 不得回退到本地开发默认口令。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;
delete process.env.ACCESS_TOKEN;
process.env.NODE_ENV = 'production';

const { createApp } = await import('../src/app');
const { UNAUTHORIZED_CODE } = await import('../src/middleware/auth');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('生产环境必须设置 ADMIN_PASSWORD', () => {
  it('开发默认口令不能登录', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'speakmate-local-dev-only' });
    expect(res.status).toBe(503);
    expect(res.body.message).toContain('ADMIN_PASSWORD');
    expect(JSON.stringify(res.body)).not.toContain('speakmate-local-dev-only');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('管理接口保持关闭', async () => {
    const res = await request(server.baseUrl).get('/api/admin/health');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });
});
