/**
 * 速率限制集成测试（审查报告 H2）。
 *
 * 测试环境（NODE_ENV=test）默认关闭限流以隔离用例，本文件显式开启：
 * 环境变量必须在动态 import src/app 之前设置（限流器在模块加载时构建）。
 *
 * 阈值刻意压到最小（LLM 档 2 次/分钟），避免测试跑几十次请求。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestServer, type TestServer } from './helpers/server';

process.env.ENABLE_RATE_LIMIT = 'true';
process.env.RATE_LIMIT_LLM_PER_MIN = '2';

const { createApp } = await import('../src/app');
const { RATE_LIMIT_CODE } = await import('../src/middleware/rateLimit');

let server: TestServer;
let app: Express;

beforeAll(async () => {
  app = createApp();
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

/** 触发一次 LLM 档请求（POST /api/words/define 挂载 llmLimiter） */
function defineWord(word: string): Promise<request.Response> {
  return request(server.baseUrl)
    .post('/api/words/define')
    .send({ word, context: 'We hit a bottleneck in the pipeline.' });
}

describe('速率限制 · LLM 档（2 次/分钟）', () => {
  it('第 1、2 次放行，第 3 次返回 429 + 统一契约', async () => {
    const first = await defineWord('bottleneck');
    expect(first.status).toBe(200);

    const second = await defineWord('rollback');
    expect(second.status).toBe(200);

    const third = await defineWord('throughput');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe(RATE_LIMIT_CODE);
    expect(third.body.data).toBeNull();
    expect(typeof third.body.message).toBe('string');
  });

  it('429 响应回传 RateLimit 标准头，便于客户端退避', async () => {
    // 上一用例已耗尽配额
    const res = await defineWord('latency');
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBeDefined();
  });
});

describe('速率限制 · 读档不受 LLM 档影响', () => {
  it('读接口连续请求仍放行（分档限流，互不串档）', async () => {
    for (let i = 0; i < 5; i += 1) {
      const res = await request(server.baseUrl).get('/api/scenes');
      expect(res.status).toBe(200);
    }
  });
});
