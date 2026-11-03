/**
 * API 集成测试 · 学习画像接口（#15 / #16）：统计聚合 / 常错 Top / 高频场景 /
 * display_name 与 settings 校验（P0-8、P1-6）。
 *
 * 常错统计经真实 SSE 对话轮（mock 纠错规则）驱动，验证「纠错 → 画像 → 聚合」链路。
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

async function createSession(sceneId: string): Promise<string> {
  const res = await request(app).post('/api/sessions').send({ scene_id: sceneId }).expect(201);
  return res.body.data.session.id as string;
}

async function chat(sessionId: string, content: string): Promise<void> {
  const res = await fetch(`${server.baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, content }),
  });
  await res.text();
}

describe('#15 GET /api/profile（画像摘要）', () => {
  it('空库：stats 全 0，display_name 默认，常错/高频场景为空', async () => {
    const res = await request(app).get('/api/profile').expect(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;
    expect(data.stats).toEqual({
      session_count: 0,
      message_count: 0,
      word_count: 0,
      mastered_count: 0,
    });
    expect(data.display_name).toBe('SpeakMate');
    expect(data.common_mistakes).toEqual([]);
    expect(data.preferred_scenes).toEqual([]);
  });

  it('stats 聚合：会话数 / 消息数 / 词数 / 已掌握数', async () => {
    // 2 个会话 + 2 轮对话（4 条消息）+ 2 词条（1 个已掌握）
    const s1 = await createSession('daily-standup');
    await chat(s1, 'I very like this standup format.');
    const s2 = await createSession('code-review');
    await chat(s2, 'Yesterday I fix the flaky test in the pipeline.');

    await request(app).post('/api/words').send({ word: 'rollback', definition: '回滚' }).expect(200);
    await request(app).post('/api/words').send({ word: 'pipeline', definition: '流水线' }).expect(200);
    const list = await request(app).get('/api/words').expect(200);
    const rollback = list.body.data.items.find((w: { word: string }) => w.word === 'rollback');
    await request(app).patch(`/api/words/${rollback.id}`).send({ mastery_level: 2 }).expect(200);

    const res = await request(app).get('/api/profile').expect(200);
    const data = res.body.data;
    expect(data.stats.session_count).toBe(2);
    expect(data.stats.message_count).toBe(6); // (opener+u+a) × 2
    expect(data.stats.word_count).toBe(2);
    expect(data.stats.mastered_count).toBe(1);
  });

  it('常错聚合：同 pattern 计数累加，出现在 common_mistakes（P0-8）', async () => {
    // 两轮不同的句子命中同一条规则 "I very like ..."
    const s = await createSession('coffee-chat');
    await chat(s, 'I very like this coffee.');
    await chat(s, 'I very like the new machine too.');

    const res = await request(app).get('/api/profile').expect(200);
    const mistakes = res.body.data.common_mistakes as Array<{
      pattern: string;
      corrected: string;
      count: number;
      example: string;
      last_seen_at: string;
    }>;
    const veryLike = mistakes.find((m) => m.pattern === 'I very like');
    expect(veryLike).toBeDefined();
    expect(veryLike?.count).toBeGreaterThanOrEqual(3); // 本用例 2 次 + 前一用例 1 次
    expect(veryLike?.corrected).toBe('I really like');
    expect(veryLike?.example).toBe('I very like');
    expect(veryLike?.last_seen_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('常错 Top 按出现次数倒序', async () => {
    // 再造一个只出现 1 次的错误，"I very like" 应排在它前面
    const s = await createSession('gym-fitness');
    await chat(s, 'Can you borrow me a towel please?');

    const res = await request(app).get('/api/profile').expect(200);
    const mistakes = res.body.data.common_mistakes as Array<{ pattern: string; count: number }>;
    expect(mistakes.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < mistakes.length; i++) {
      expect(mistakes[i - 1].count).toBeGreaterThanOrEqual(mistakes[i].count);
    }
    expect(mistakes[0].pattern).toBe('I very like');
  });

  it('高频场景聚合：preferred_scenes 含各场景会话数（sessions 实时聚合）', async () => {
    const res = await request(app).get('/api/profile').expect(200);
    const scenes = res.body.data.preferred_scenes as Array<{ scene_id: string; count: number }>;
    const map = new Map(scenes.map((s) => [s.scene_id, s.count]));
    expect(map.get('daily-standup')).toBe(1);
    expect(map.get('code-review')).toBe(1);
    expect(map.get('coffee-chat')).toBe(1);
    expect(map.get('gym-fitness')).toBe(1);
    expect(scenes.every((s) => s.count >= 1)).toBe(true);
  });
});

describe('#16 PATCH /api/profile（更新画像/设置）', () => {
  it('display_name 合法更新（1–30 字符）→ 返回完整画像，GET 摘要回显', async () => {
    const res = await request(app)
      .patch('/api/profile')
      .send({ display_name: 'Darrell' })
      .expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.profile.display_name).toBe('Darrell');

    const summary = await request(app).get('/api/profile').expect(200);
    expect(summary.body.data.display_name).toBe('Darrell');
  });

  it('display_name 非法（空 / 空白 / 31字符 / 非字符串）→ 400 + 1001', async () => {
    for (const body of [
      { display_name: '' },
      { display_name: '   ' },
      { display_name: 'x'.repeat(31) },
      { display_name: 42 },
    ]) {
      const res = await request(app).patch('/api/profile').send(body).expect(400);
      expect(res.body.code, JSON.stringify(body)).toBe(1001);
      expect(res.body.message).toContain('display_name');
    }
  });

  it('settings 合法更新：tts_enabled / tts_rate 持久化，并与默认值合并', async () => {
    const res = await request(app)
      .patch('/api/profile')
      .send({ settings: { tts_rate: 1.25 } })
      .expect(200);
    // 未提交 tts_enabled → 保留默认 true（合并语义）
    expect(res.body.data.profile.settings).toEqual({ tts_enabled: true, tts_rate: 1.25 });

    const res2 = await request(app)
      .patch('/api/profile')
      .send({ settings: { tts_enabled: false } })
      .expect(200);
    expect(res2.body.data.profile.settings).toEqual({ tts_enabled: false, tts_rate: 1.25 });
  });

  it('settings 非法（tts_rate 越界 / 类型错误 / settings 为数组）→ 400 + 1001', async () => {
    for (const body of [
      { settings: { tts_rate: 0.4 } },
      { settings: { tts_rate: 2.5 } },
      { settings: { tts_rate: 'fast' } },
      { settings: { tts_enabled: 'yes' } },
      { settings: [1, 2, 3] },
    ]) {
      const res = await request(app).patch('/api/profile').send(body).expect(400);
      expect(res.body.code, JSON.stringify(body)).toBe(1001);
    }
  });

  it('空 patch（无任何有效字段）→ 400 + 1001', async () => {
    const res = await request(app).patch('/api/profile').send({}).expect(400);
    expect(res.body.code).toBe(1001);
  });

  it('更新设置不破坏已有常错统计（common_mistakes 保留）', async () => {
    const before = await request(app).get('/api/profile').expect(200);
    const mistakesBefore = before.body.data.common_mistakes;
    expect(mistakesBefore.length).toBeGreaterThan(0);

    await request(app).patch('/api/profile').send({ display_name: 'Yan' }).expect(200);

    const after = await request(app).get('/api/profile').expect(200);
    expect(after.body.data.common_mistakes).toEqual(mistakesBefore);
    expect(after.body.data.display_name).toBe('Yan');
  });
});
