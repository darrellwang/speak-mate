/**
 * 默认用户名是 admin；ADMIN_USERNAME 可覆盖。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { startTestServer, type TestServer } from './helpers/server';

process.env.ADMIN_USERNAME = 'owner';
process.env.ADMIN_PASSWORD = 'owner-password-for-tests';
delete process.env.ACCESS_TOKEN;

const { createApp } = await import('../src/app');

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(createApp());
});

afterAll(async () => {
  await server.close();
});

describe('ADMIN_USERNAME', () => {
  it('默认用户名 admin 不再接受，配置的用户名可以登录', async () => {
    const wrong = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'admin', password: 'owner-password-for-tests' });
    expect(wrong.status).toBe(401);

    const ok = await request(server.baseUrl)
      .post('/api/admin/login')
      .send({ username: 'owner', password: 'owner-password-for-tests' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.username).toBe('owner');
  });
});
