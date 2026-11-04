/**
 * 仅 NODE_ENV=development 且未设置 ADMIN_PASSWORD 时，允许文档中的本地默认口令。
 * 该口令必须写在 .env.example 与 docs/ADMIN.md，且不得当作生产密码。
 */
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

const DEV_PASSWORD = 'speakmate-local-dev-only';

delete process.env.ADMIN_PASSWORD;
delete process.env.ADMIN_USERNAME;
delete process.env.ACCESS_TOKEN;
process.env.NODE_ENV = 'development';

const { createApp } = await import('../src/app');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('本地开发默认管理员口令', () => {
  it('文档写明该口令，且只用默认用户名 admin 能登录', async () => {
    const envExample = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
    const adminDoc = readFileSync(new URL('../../docs/ADMIN.md', import.meta.url), 'utf8');
    expect(envExample).toContain(DEV_PASSWORD);
    expect(envExample).toContain('ADMIN_PASSWORD');
    expect(adminDoc).toContain(DEV_PASSWORD);
    expect(adminDoc).toContain('admin');

    const ok = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: DEV_PASSWORD });
    expect(ok.status).toBe(200);
    expect(ok.body.data.username).toBe('admin');
    const setCookie = Array.isArray(ok.headers['set-cookie']) ? ok.headers['set-cookie'].join('\n') : '';
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).not.toMatch(/Secure/i);

    const bad = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'not-the-dev-password' });
    expect(bad.status).toBe(401);
    expect(bad.body.message).toBe('用户名或密码错误');
  });
});
