/**
 * 访问控制（审查报告 H1）与 CORS 白名单的集成测试。
 *
 * config/env.ts 在**模块加载时**读取环境变量，因此本文件必须在设置
 * process.env 之后用**动态 import** 加载 src/app（静态 import 会被提升到赋值之前）。
 *
 * 注意：vitest 用 singleFork，process.env 是进程级全局——本文件设置的变量
 * 由 test/setup.ts 在每个测试文件加载前复位，不会污染其他文件。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestServer, type TestServer } from './helpers/server';

const ACCESS_TOKEN = 'test-token-abc-123';
const ALLOWED_ORIGIN = 'https://allowed.example.com';

process.env.ACCESS_TOKEN = ACCESS_TOKEN;
process.env.CORS_ORIGIN = ALLOWED_ORIGIN;

const { createApp } = await import('../src/app');
const { FORBIDDEN_CODE, UNAUTHORIZED_CODE } = await import('../src/middleware/auth');

let server: TestServer;
let app: Express;

beforeAll(async () => {
  app = createApp();
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

describe('访问控制 · ACCESS_TOKEN 已配置', () => {
  it('无 Authorization 头 → 401 + 4010 业务码', async () => {
    const res = await request(server.baseUrl).get('/api/health');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
    expect(res.body.data).toBeNull();
  });

  it('错误的令牌 → 401（且不泄露正确与否的线索）', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('非 Bearer 方案（如 Basic）→ 401', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', `Basic ${ACCESS_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('正确的 Bearer 令牌 → 200', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body.code).toBe(0);
  });

  it('bearer 小写（方案名大小写不敏感）→ 200', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', `bearer ${ACCESS_TOKEN}`);
    expect(res.status).toBe(200);
  });

  it('令牌经 URL query 传递 → 401（刻意不接受，避免令牌进访问日志/Referer）', async () => {
    const res = await request(server.baseUrl).get(`/api/health?token=${ACCESS_TOKEN}`);
    expect(res.status).toBe(401);
  });

  it('写接口同样受保护（不存在"漏网"的写路由）', async () => {
    const res = await request(server.baseUrl).post('/api/sessions').send({ scene_id: 'daily-standup' });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('ACCESS_TOKEN 仍可访问学员接口，但不能打开管理台', async () => {
    const learner = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(learner.status).toBe(200);

    const res = await request(server.baseUrl)
      .get('/api/admin/health')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body.code).toBe(FORBIDDEN_CODE);
    expect(res.body.message).toContain('管理员');
  });

  it('错误令牌不能打开管理台', async () => {
    const res = await request(server.baseUrl)
      .get('/api/admin/users')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('管理接口同样不接受 URL query 令牌', async () => {
    const res = await request(server.baseUrl).get(`/api/admin/health?token=${ACCESS_TOKEN}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe(UNAUTHORIZED_CODE);
  });

  it('鉴权守卫只作用于 /api（非 api 路径不会被令牌拦截）', async () => {
    const res = await request(server.baseUrl).get('/not-an-api-route');
    // 具体状态码取决于 frontend/dist 是否存在（存在时命中 SPA 回退返回 index.html），
    // 但无论如何都不该是鉴权失败——这里断言的是"守卫作用域"而非具体响应
    expect(res.status).not.toBe(401);
    expect(res.body.code).not.toBe(UNAUTHORIZED_CODE);
  });
});

describe('CORS 白名单', () => {
  it('白名单内的 Origin → 回传 Access-Control-Allow-Origin', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
  });

  it('白名单外的 Origin → 不回传 CORS 头', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('无 Origin（同源请求）→ 不回传 CORS 头', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('绝不回传通配符 "*"', async () => {
    const res = await request(server.baseUrl)
      .get('/api/health')
      .set('Origin', 'https://anything.example.com')
      .set('Authorization', `Bearer ${ACCESS_TOKEN}`);
    expect(res.headers['access-control-allow-origin']).not.toBe('*');
  });
});
