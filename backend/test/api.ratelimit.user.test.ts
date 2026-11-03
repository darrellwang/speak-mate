/**
 * 多用户限流隔离测试（P2-5）
 *
 * 验证按用户分键的限流器：同一 IP 下两个不同用户，各自拥有独立的限流配额。
 *
 * 背景：纯 IP 计数时，同一 WiFi 下的家庭成员共享出口 IP，一人狂刷 LLM 接口
 * 会把其他人一起 429 拦下。改造后按 userId 分键，各用户互不干扰。
 *
 * 注意：本文件用**动态 import** 加载 src/app（需在设置环境变量之后），
 * 与 api.auth.test.ts 同一套路——config/env.ts 在模块加载时读 env。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestServer, type TestServer } from './helpers/server';

const ADMIN_TOKEN = 'admin-token-ratelimit-user';
const INVITE_A = 'invite-a-ratelimit';
const INVITE_B = 'invite-b-ratelimit';

// 读接口阈值压到 2 次/分钟，便于观察配额耗尽
process.env.ACCESS_TOKEN = ADMIN_TOKEN;
process.env.INVITE_CODES = `${INVITE_A},${INVITE_B}`;
process.env.RATE_LIMIT_READ_PER_MIN = '2';
process.env.ENABLE_RATE_LIMIT = 'true';

const { createApp } = await import('../src/app');

let server: TestServer;
let app: Express;

async function login(code: string): Promise<string> {
  const res = await request(server.baseUrl)
    .post('/api/auth/invite-login')
    .send({ code })
    .expect(200);
  return res.body.data.token as string;
}

beforeAll(async () => {
  app = createApp();
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('P2-5 · 限流按用户隔离', () => {
  it('用户 A 用完配额后，用户 B 仍可正常访问', async () => {
    const tokenA = await login(INVITE_A);
    const tokenB = await login(INVITE_B);

    // 用户 A 连打 3 次读接口 → 第 3 次应被限流
    const a1 = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${tokenA}`);
    const a2 = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${tokenA}`);
    const a3 = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${tokenA}`);

    expect(a1.status).toBe(200);
    expect(a2.status).toBe(200);
    expect(a3.status).toBe(429);

    // 用户 B 是独立配额 → 第一次请求必须放行
    const b1 = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${tokenB}`);
    expect(b1.status).toBe(200);
  });

  it('管理员与邀请码用户配额互不影响', async () => {
    const tokenC = await login(INVITE_B);

    // 管理员被限流后（新用户配额）
    await request(server.baseUrl).get('/api/scenes').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    await request(server.baseUrl).get('/api/scenes').set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    const adminBlocked = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${ADMIN_TOKEN}`);
    expect(adminBlocked.status).toBe(429);

    // 另一个用户不受影响
    const c1 = await request(server.baseUrl)
      .get('/api/scenes')
      .set('Authorization', `Bearer ${tokenC}`);
    expect(c1.status).toBe(200);
  });
});
