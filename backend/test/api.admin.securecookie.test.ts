/**
 * 生产环境显式配置了 ADMIN_PASSWORD 时，会话 cookie 必须带 Secure。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

const ADMIN_PASSWORD = 'production-test-password-xyz';

process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;
delete process.env.ACCESS_TOKEN;
process.env.NODE_ENV = 'production';

const { createApp } = await import('../src/app');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('生产环境管理台 cookie', () => {
  it('登录成功且 Set-Cookie 带 Secure 与 HttpOnly', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('\n') : '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toContain(ADMIN_PASSWORD);
  });
});
