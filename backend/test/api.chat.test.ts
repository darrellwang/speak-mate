/**
 * API 集成测试 · #9 POST /api/chat（SSE 流式对话，核心接口）。
 *
 * 用真实 HTTP 服务器 + fetch 消费 SSE 流（supertest 不便处理流式逐帧读取）：
 * - 事件序列 delta* → meta → done（§4.3 契约）；
 * - 纠错卡四要素字段（P0-3）；
 * - done.message_id 与落库消息一致（P0-7 持久化）；
 * - 开流前错误走统一 JSON 包裹（1001 / 2001）；
 * - 幂等重试（§4.3）：客户端中断后重发同 content 不重复插入 user 消息；
 * - 不同 content / 已完成轮次后的同 content 正常插入。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { eventSequence, parseSseText, startTestServer, type SseFrame, type TestServer } from './helpers/server';

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

/** 消费一轮完整 SSE 对话，返回解析后的帧 */
async function chatOnce(sessionId: string, content: string): Promise<{ raw: string; frames: SseFrame[] }> {
  const res = await fetch(`${server.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, content }),
  });
  const raw = await res.text();
  return { raw, frames: parseSseText(raw) };
}

describe('#9 POST /api/chat · 正常流', () => {
  it('SSE 响应头：text/event-stream + no-cache + X-Accel-Buffering: no', async () => {
    const sessionId = await createSession();
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content: 'Hello there!' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.text();
  });

  it('事件序列 delta* → meta → done（delta 至少 1 个，meta/done 各 1 个）', async () => {
    const sessionId = await createSession();
    const { frames } = await chatOnce(sessionId, 'Hello, I finished the refactor yesterday.');
    const seq = eventSequence(frames);

    expect(seq.length).toBeGreaterThanOrEqual(3);
    expect(seq[0]).toBe('delta');
    expect(seq.filter((e) => e === 'meta')).toHaveLength(1);
    expect(seq.filter((e) => e === 'done')).toHaveLength(1);
    // 顺序：所有 delta 在 meta 前，meta 在 done 前，done 为最后一个事件
    const firstDelta = seq.indexOf('delta');
    const metaIdx = seq.indexOf('meta');
    const doneIdx = seq.indexOf('done');
    expect(firstDelta).toBeLessThan(metaIdx);
    expect(metaIdx).toBeLessThan(doneIdx);
    expect(doneIdx).toBe(seq.length - 1);
    // 无 error 事件
    expect(seq).not.toContain('error');
  });

  it('delta 拼接 === 落库 assistant 正文；done.message_id === 落库消息 id（P0-7）', async () => {
    const sessionId = await createSession('incident-retro');
    const { frames } = await chatOnce(sessionId, 'We had an outage last night because of a bad config.');

    const deltaText = frames
      .filter((f) => f.event === 'delta')
      .map((f) => (f.data as { text: string }).text)
      .join('');
    expect(deltaText.length).toBeGreaterThan(0);

    const done = frames.find((f) => f.event === 'done')?.data as {
      message_id: string;
      session_id: string;
    };
    expect(done).toBeDefined();
    expect(done.session_id).toBe(sessionId);

    const detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const messages = detail.body.data.messages as Array<{
      id: string;
      role: string;
      content: string;
      corrections: unknown[];
      vocab_suggestions: unknown[];
    }>;
    expect(messages).toHaveLength(3); // opener + user + assistant
    const assistant = messages[2];
    expect(assistant.role).toBe('assistant');
    expect(assistant.id).toBe(done.message_id);
    expect(assistant.content).toBe(deltaText);
    expect(assistant.content).not.toContain('<<<META');

    // user 消息正确落库
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toBe('We had an outage last night because of a bad config.');
  });

  it('纠错轮：meta 携带纠错卡四要素，且与落库 corrections 一致（P0-3）', async () => {
    const sessionId = await createSession();
    const { frames } = await chatOnce(sessionId, 'I very like this tool, and we discuss about the rollout plan.');
    const meta = frames.find((f) => f.event === 'meta')?.data as {
      corrections: Array<{ original: string; issue: string; corrected: string; explanation: string }>;
      vocabulary_suggestions: Array<{ word: string; phonetic: string; definition: string; example: string }>;
    };
    expect(meta).toBeDefined();
    expect(meta.corrections.length).toBeGreaterThanOrEqual(1);
    expect(meta.corrections.length).toBeLessThanOrEqual(2);
    for (const c of meta.corrections) {
      // 四要素齐全
      expect(c.original.length).toBeGreaterThan(0);
      expect(c.corrected.length).toBeGreaterThan(0);
      expect(c.explanation.length).toBeGreaterThan(0);
      expect(['grammar', 'word-choice', 'collocation', 'idiom']).toContain(c.issue);
    }
    // 必含 "I very like" 纠错（mock 规则表）
    expect(meta.corrections.some((c) => c.original === 'I very like' && c.corrected === 'I really like')).toBe(true);

    // 词条建议四要素（P0-5 路径B）
    for (const s of meta.vocabulary_suggestions) {
      expect(s.word.length).toBeGreaterThan(0);
      expect(s.phonetic.length).toBeGreaterThan(0);
      expect(s.definition.length).toBeGreaterThan(0);
      expect(s.example.length).toBeGreaterThan(0);
    }

    // meta 与落库一致
    const detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const assistant = detail.body.data.messages[2];
    expect(assistant.corrections).toEqual(meta.corrections);
    expect(assistant.vocab_suggestions).toEqual(meta.vocabulary_suggestions);
  });

  it('干净输入：meta.corrections = []（无错误不硬纠，P0-3）', async () => {
    const sessionId = await createSession();
    const { frames } = await chatOnce(sessionId, 'The deployment went smoothly this morning.');
    const meta = frames.find((f) => f.event === 'meta')?.data as { corrections: unknown[] };
    expect(meta?.corrections).toEqual([]);
  });

  it('会话摘要更新：首条 user 消息截断为 title（本地生成）', async () => {
    const sessionId = await createSession();
    const longContent = 'A'.repeat(120);
    await chatOnce(sessionId, longContent);
    const detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    expect(detail.body.data.session.title).toBe('A'.repeat(50));
    expect(detail.body.data.session.message_count).toBe(3);
  });
});

describe('#9 POST /api/chat · 开流前错误（统一 JSON 包裹）', () => {
  it('session_id 缺失 → 400 + 1001（JSON，非 SSE）', async () => {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hi' }),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(1001);
    expect(body.message).toContain('session_id');
  });

  it('content 空白 → 400 + 1001', async () => {
    const sessionId = await createSession();
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content: '   ' }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(1001);
  });

  it('content 超长（>2000 字符）→ 400 + 1001', async () => {
    const sessionId = await createSession();
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content: 'x'.repeat(2001) }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: number }).code).toBe(1001);
  });

  it('会话不存在 → 404 + 2001（JSON，非 SSE）', async () => {
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000000', content: 'hi' }),
    });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { code: number; message: string };
    expect(body.code).toBe(2001);
  });
});

describe('#9 POST /api/chat · 幂等重试（§4.3：中断重发同 content 不重插）', () => {
  it('客户端中途断开 → assistant 不落库；重发同 content → user 消息复用，最终仅 1 条', async () => {
    const sessionId = await createSession();
    const content = 'Please tell me about the pipeline failure.';

    // 第一轮：读到首个 delta 帧后立即断开
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let received = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += decoder.decode(value, { stream: true });
      if (received.includes('event: delta')) {
        controller.abort();
        break;
      }
    }
    expect(received).toContain('event: delta');
    await reader.cancel().catch(() => undefined);
    // 等待服务端感知断开并收尾
    await new Promise((r) => setTimeout(r, 400));

    // 断开后：user 已落库、assistant 未落库
    let detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    let messages = detail.body.data.messages as Array<{ role: string; content: string }>;
    expect(messages).toHaveLength(2); // opener + user
    expect(messages[1]).toMatchObject({ role: 'user', content });

    // 第二轮：重发相同 content（模拟前端失败重试）
    const retry = await chatOnce(sessionId, content);
    expect(eventSequence(retry.frames)).toContain('done');

    detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    messages = detail.body.data.messages;
    expect(messages).toHaveLength(3); // opener + user(复用) + assistant
    const userMessages = messages.filter((m: { role: string }) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe(content);
  });

  it('断开后改发不同 content → 插入新 user 消息（不过度抑制）', async () => {
    const sessionId = await createSession();

    // 中断第一轮
    const controller = new AbortController();
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, content: 'aborted message' }),
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (new TextDecoder().decode(value).length > 0) {
        controller.abort();
        break;
      }
    }
    await reader.cancel().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 400));

    // 改发不同内容
    const second = await chatOnce(sessionId, 'a different message');
    expect(eventSequence(second.frames)).toContain('done');

    const detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const messages = detail.body.data.messages as Array<{ role: string; content: string }>;
    const userContents = messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userContents).toEqual(['aborted message', 'a different message']);
  });

  it('已完成轮次后重发同 content → 视为新轮次，正常插入（幂等仅针对失败轮）', async () => {
    const sessionId = await createSession();
    const content = 'Same words but a brand new turn.';

    await chatOnce(sessionId, content);
    await chatOnce(sessionId, content);

    const detail = await request(app).get(`/api/sessions/${sessionId}`).expect(200);
    const messages = detail.body.data.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(5); // opener + u + a + u + a
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });
});
