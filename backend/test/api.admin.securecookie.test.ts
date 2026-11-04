/**
 * 管理台会话 cookie 的 Secure 跟随请求协议：HTTPS（含反代转发）带 Secure，HTTP 不带。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

const ADMIN_PASSWORD = 'production-test-password-xyz';

process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;
delete process.env.ACCESS_TOKEN;
process.env.NODE_ENV = 'production';
process.env.TRUST_PROXY = 'true';

const { createApp } = await import('../src/app');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

function setCookieOf(res: request.Response): string {
  return Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'].join('\n') : '';
}

describe('管理台 cookie 的 Secure 标记', () => {
  it('反代转发 HTTPS 时 Set-Cookie 带 Secure 与 HttpOnly', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .set('X-Forwarded-Proto', 'https')
      .send({ username: 'admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = setCookieOf(res);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/Secure/i);
    expect(setCookie).not.toContain(ADMIN_PASSWORD);
  });

  it('生产环境走 HTTP 时不带 Secure，避免浏览器丢弃 cookie', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: ADMIN_PASSWORD });
    expect(res.status).toBe(200);
    const setCookie = setCookieOf(res);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it('退出时清除 cookie 同样跟随协议', async () => {
    const res = await request(server.baseUrl)
      .post('/api/admin/logout')
      .set('X-Forwarded-Proto', 'https')
      .send({});
    expect(res.status).toBe(200);
    const setCookie = setCookieOf(res);
    expect(setCookie).toMatch(/Max-Age=0/);
    expect(setCookie).toMatch(/Secure/i);
  });
});
