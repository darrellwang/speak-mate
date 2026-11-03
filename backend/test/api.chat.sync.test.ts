/**
 * API 集成测试 · #9b POST /api/chat/sync（非流式对话接口）。
 *
 * 存在理由：微信小程序等客户端无法可靠消费 SSE 分块流（基础库版本/网关缓冲），
 * 因此后端提供语义等价的一次性接口。本文件锁死「等价」这两个字的含义：
 * - 响应是普通 JSON（不是 text/event-stream），走统一 {code,data,message} 包裹；
 * - 字段与 SSE 事件一一对应：delta*→content、meta→corrections+ suggestions、done→message_id；
 * - degraded=true 对应 SSE 的 3003（正文可用、纠错缺失）；
 * - 开流前的错误与 SSE 路径完全相同（1001 / 2001），不因为换了传输层就变口径。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { startTestServer, type TestServer } from './helpers/server';

const app = createApp();
let server: TestServer;

beforeAll(async () => {
  server = await startTestServer(app);
});

afterAll(async () => {
  await server.close();
});

async function createSession(sceneId = 'daily-standup'): Promise<string> {
  const res = await request(app).post('/api/sessions').send({ scene_id: sceneId }).expect(201);
  return res.body.data.session.id as string;
}

interface SyncData {
  message_id: string;
  session_id: string;
  content: string;
  corrections: { original: string; issue: string; corrected: string; explanation: string }[];
  vocabulary_suggestions: { word: string; phonetic: string; definition: string; example: string }[];
  degraded: boolean;
}

async function sync(sessionId: string, content: string) {
  return request(app).post('/api/chat/sync').send({ session_id: sessionId, content });
}

describe('#9b POST /api/chat/sync · 正常流', () => {
  it('返回普通 JSON（非 SSE）+ 统一包裹，六字段契约齐全且 degraded=false', async () => {
    const sessionId = await createSession();
    const res = await sync(sessionId, 'The deployment finished last night.');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('ok');

    const data = res.body.data as SyncData;
    expect(typeof data.content).toBe('string');
    expect(data.content.length).toBeGreaterThan(0);
    // 正文已剥离协议分隔符，绝不能把 <<<META>>> 泄漏给客户端
    expect(data.content).not.toContain('<<<META>>>');
    expect(typeof data.message_id).toBe('string');
    expect(data.message_id.length).toBeGreaterThan(0);
    expect(data.session_id).toBe(sessionId);
    expect(Array.isArray(data.corrections)).toBe(true);
    expect(Array.isArray(data.vocabulary_suggestions)).toBe(true);
    expect(data.degraded).toBe(false);
  });

  it('返回的正文与落库 assistant 消息完全一致（聚合结果与持久化同源）', async () => {
    const sessionId = await createSession();
    const res = await sync(sessionId, 'I will carry over two bugs to next sprint.');
    const data = res.body.data as SyncData;

    const detail = await request(app).get(`/api/sessions/${sessionId}?msg_limit=50`).expect(200);
    const messages = detail.body.data.messages as { id: string; role: string; content: string }[];
    const assistant = messages.find((m) => m.id === data.message_id);
    expect(assistant).toBeDefined();
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe(data.content);
  });

  it('命中中式英语时返回纠错四要素（与 SSE meta 事件同一份数据）', async () => {
    const sessionId = await createSession();
    // "discuss about" 命中 mock 的 word-choice 纠错规则
    const res = await sync(sessionId, "Let's discuss about the deployment plan tomorrow.");
    const data = res.body.data as SyncData;

    expect(data.corrections.length).toBeGreaterThan(0);
    const first = data.corrections[0]!;
    expect(typeof first.original).toBe('string');
    expect(typeof first.issue).toBe('string');
    expect(typeof first.corrected).toBe('string');
    expect(typeof first.explanation).toBe('string');
  });

  it('连续两轮对话：消息按序落库，用户/助手交替', async () => {
    const sessionId = await createSession();
    const first = await sync(sessionId, 'First message from me.');
    const second = await sync(sessionId, 'Second message from me.');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const detail = await request(app).get(`/api/sessions/${sessionId}?msg_limit=50`).expect(200);
    const messages = detail.body.data.messages as { role: string; content: string }[];
    // 开场白(assistant) + 两轮(user/assistant)
    expect(messages.length).toBe(5);
    expect(messages.map((m) => m.role)).toEqual([
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });
});

describe('#9b POST /api/chat/sync · 错误处理（与 SSE 路径同口径）', () => {
  it('session_id 缺失 → 400 + 1001', async () => {
    const res = await request(app).post('/api/chat/sync').send({ content: 'hello' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(1001);
    expect(res.body.data).toBeNull();
  });

  it('content 空白 → 400 + 1001', async () => {
    const sessionId = await createSession();
    const res = await sync(sessionId, '   ');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(1001);
  });

  it('content 超过 2000 字符 → 400 + 1001', async () => {
    const sessionId = await createSession();
    const res = await sync(sessionId, 'a'.repeat(2001));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(1001);
  });

  it('会话不存在 → 404 + 2001（不开流，走统一 JSON 错误）', async () => {
    const res = await sync('session-not-exist', 'hello');
    expect(res.status).toBe(404);
    expect(res.body.code).toBe(2001);
    expect(res.headers['content-type']).toContain('application/json');
  });
});
