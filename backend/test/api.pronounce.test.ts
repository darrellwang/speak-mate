/**
 * 发音评估接口测试（POST /api/pronounce）
 *
 * 测试环境不依赖真实评测服务（WSL 里的 OpenPronounce）：
 * - PRONOUNCE_URL 指向无人监听的端口 → 验证「服务不可达」时返回明确的可执行提示；
 * - 参数校验（text 缺失 / 音频缺失 / 过大）走纯本地逻辑；
 * - 真实链路由部署后手动验证（见 DEPLOYMENT.md）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import { startTestServer, type TestServer } from './helpers/server';

// 指向无人监听的端口：让 fetch 立即连接失败，走「服务不可达」分支
process.env.ACCESS_TOKEN = 'pronounce-test-token';
process.env.PRONOUNCE_URL = 'http://127.0.0.1:19999';

const { createApp } = await import('../src/app');

let server: TestServer;
let app: Express;

const TOKEN = 'pronounce-test-token';
const WAV_BYTES = Buffer.from(
  'RIFF' + '\x00'.repeat(8) + 'WAVE' + '\x00'.repeat(40),
  'binary',
);

beforeAll(async () => {
  app = createApp();
  server = await startTestServer(app);
});

describe('POST /api/pronounce', () => {
  it('无令牌 → 401', async () => {
    const res = await request(server.baseUrl)
      .post('/api/pronounce?text=hello')
      .send(WAV_BYTES);
    expect(res.status).toBe(401);
  });

  it('缺 text → 400', async () => {
    const res = await request(server.baseUrl)
      .post('/api/pronounce')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'audio/wav')
      .send(WAV_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('text');
  });

  it('缺音频 body → 400', async () => {
    const res = await request(server.baseUrl)
      .post('/api/pronounce?text=hello')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'audio/wav')
      .send(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('音频');
  });

  it('评测服务不可达 → 400 且提示包含启动指引（而非笼统 500）', async () => {
    const res = await request(server.baseUrl)
      .post('/api/pronounce?text=hello')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'audio/wav')
      .send(WAV_BYTES);
    expect(res.status).toBe(400);
    expect(res.body.message).toContain('评测服务不可达');
    expect(res.body.message.length).toBeGreaterThan(20); // 有可执行信息，不是空报错
  });

  it('响应契约：错误也走统一 {code, data, message} 包裹', async () => {
    const res = await request(server.baseUrl)
      .post('/api/pronounce?text=hello')
      .set('Authorization', `Bearer ${TOKEN}`)
      .set('Content-Type', 'audio/wav')
      .send(WAV_BYTES);
    expect(res.body.code).toBe(1001);
    expect(res.body.data).toBeNull();
    expect(typeof res.body.message).toBe('string');
  });
});
