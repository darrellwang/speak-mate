/**
 * API 集成测试 · 会话接口（#4–#8）：创建（含延续模式开场白）/ 列表分页 /
 * 详情消息分页 / 重命名 / 级联删除。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/database';
import { SCENE_MAP } from '../src/config/scenes';

const app = createApp();

/** 创建会话（返回 supertest Test，可链式 .expect） */
function createSession(body: Record<string, unknown>) {
  return request(app).post('/api/sessions').send(body);
}

describe('#4 POST /api/sessions', () => {
  it('合法 scene_id → 201 + {session, messages=开场白}', async () => {
    const res = await createSession({ scene_id: 'daily-standup' }).expect(201);
    expect(res.body.code).toBe(0);
    const { session, messages } = res.body.data;
    expect(session.id).toMatch(/[0-9a-f-]{36}/);
    expect(session.scene_id).toBe('daily-standup');
    expect(session.status).toBe('active');
    // P2-5 多用户：零配置模式下 requireAuth 把身份落为管理员账号 'admin'
    // （原为硬编码的 DEFAULT_USER_ID='default'）
    expect(session.user_id).toBe('admin');
    expect(session.message_count).toBe(1);
    expect(session.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // 开场白：1 条 assistant 消息，内容为场景静态 opener（P0-4）
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(messages[0].content).toBe(SCENE_MAP.get('daily-standup')?.opener);
    expect(messages[0].corrections).toEqual([]);
  });

  it('scene_id 不存在 → 404 + code 2002', async () => {
    const res = await createSession({ scene_id: 'no-such-scene' }).expect(404);
    expect(res.body.code).toBe(2002);
    expect(res.body.data).toBeNull();
    expect(res.body.message).toContain('场景不存在');
  });

  it('scene_id 缺失/空白 → 400 + code 1001', async () => {
    const missing = await createSession({}).expect(400);
    expect(missing.body.code).toBe(1001);
    const blank = await createSession({ scene_id: '   ' }).expect(400);
    expect(blank.body.code).toBe(1001);
  });

  it('scene_id 非字符串 → 400 + code 1001', async () => {
    const res = await createSession({ scene_id: 123 }).expect(400);
    expect(res.body.code).toBe(1001);
  });

  it('continue_from_last=true 且库中无任何历史会话 → 降级为静态开场白（新建会话永不失败）', async () => {
    // 模拟全新用户：清空会话与消息（本文件独享临时库，可安全重置状态）
    getDb().exec('DELETE FROM messages; DELETE FROM sessions;');
    const res = await createSession({ scene_id: 'code-review', continue_from_last: true }).expect(201);
    expect(res.body.code).toBe(0);
    const opener = res.body.data.messages[0].content as string;
    expect(opener).toBe(SCENE_MAP.get('code-review')?.opener);
  });

  it('continue_from_last=true 且历史会话仅有开场白（无 Learner 消息）→ LLM 生成通用欢迎语', async () => {
    const res = await createSession({ scene_id: 'tech-1on1', continue_from_last: true }).expect(201);
    const opener = res.body.data.messages[0].content as string;
    // 上一用例遗留 code-review 会话（仅开场白）→ mock 生成无主题的 Welcome back
    expect(opener).toMatch(/Welcome back/i);
  });

  it('continue_from_last=true 且有历史对话 → 生成延续性开场白（≠ 静态 opener）', async () => {
    // 会话 A：制造一段含 Learner 消息的真实对话历史（走 SSE，mock provider）
    const server = await import('./helpers/server').then((m) => m.startTestServer(app));
    try {
      const created = await createSession({ scene_id: 'incident-retro' });
      const sessionId = created.body.data.session.id as string;
      const chatRes = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          content: 'Yesterday we had a deployment failure and thirty minutes downtime.',
        }),
      });
      expect(chatRes.ok).toBe(true);
      await chatRes.text();

      // 会话 B：延续模式 → mock 生成 "Welcome back! ..." 延续性开场（P0-8 跨会话记忆）
      const res = await createSession({ scene_id: 'code-review', continue_from_last: true }).expect(201);
      const opener = res.body.data.messages[0].content as string;
      expect(opener).not.toBe(SCENE_MAP.get('code-review')?.opener);
      expect(opener).toMatch(/Welcome back/i);
      expect(opener.length).toBeGreaterThan(10);
    } finally {
      await server.close();
    }
  });

  it('continue_from_last 非布尔值 → 按false处理（静态开场白）', async () => {
    const res = await createSession({ scene_id: 'gym-fitness', continue_from_last: 'yes' }).expect(201);
    expect(res.body.data.messages[0].content).toBe(SCENE_MAP.get('gym-fitness')?.opener);
  });
});

describe('#5 GET /api/sessions（列表分页）', () => {
  beforeAll(async () => {
    // 补充会话，保证列表有 ≥3 条
    await createSession({ scene_id: 'coffee-chat' });
    await createSession({ scene_id: 'weekend-plan' });
  });

  it('默认分页：{items, total, has_more}', async () => {
    const res = await request(app).get('/api/sessions').expect(200);
    expect(res.body.code).toBe(0);
    const { items, total, has_more } = res.body.data;
    expect(Array.isArray(items)).toBe(true);
    expect(total).toBeGreaterThanOrEqual(3);
    expect(typeof has_more).toBe('boolean');
    expect(has_more).toBe(false); // 默认 limit=20 > total
  });

  it('limit=2 → items 2 条 + has_more=true', async () => {
    const res = await request(app).get('/api/sessions?limit=2').expect(200);
    expect(res.body.data.items).toHaveLength(2);
    expect(res.body.data.has_more).toBe(true);
    expect(res.body.data.total).toBeGreaterThanOrEqual(3);
  });

  it('offset 翻页：offset=total → 空列表 + has_more=false', async () => {
    const first = await request(app).get('/api/sessions?limit=100').expect(200);
    const total = first.body.data.total as number;
    const res = await request(app).get(`/api/sessions?limit=100&offset=${total}`).expect(200);
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.has_more).toBe(false);
  });

  it('列表项含场景冗余字段 scene_name / scene_category', async () => {
    const res = await request(app).get('/api/sessions?limit=1').expect(200);
    const item = res.body.data.items[0];
    expect(item.scene_name.length).toBeGreaterThan(0);
    expect(['it', 'life', 'interview']).toContain(item.scene_category);
  });

  it('按 updated_at 倒序：重命名的会话浮到最前', async () => {
    const list = await request(app).get('/api/sessions?limit=100').expect(200);
    const oldest = list.body.data.items[list.body.data.items.length - 1];
    await new Promise((r) => setTimeout(r, 10)); // 保证 updated_at 变化
    await request(app).patch(`/api/sessions/${oldest.id}`).send({ title: 'recently touched' }).expect(200);
    const after = await request(app).get('/api/sessions?limit=1').expect(200);
    expect(after.body.data.items[0].id).toBe(oldest.id);
    expect(after.body.data.items[0].title).toBe('recently touched');
  });

  it('非法分页参数 → 400 + 1001（limit=0 / limit=101 / offset=-1 / limit=abc）', async () => {
    // 注：limit=1.5 等小数未在契约中约定——路由按范围校验后 floor，宽松接受（此处不约束）
    for (const qs of ['?limit=0', '?limit=101', '?offset=-1', '?limit=abc', '?offset=1.5']) {
      const res = await request(app).get(`/api/sessions${qs}`).expect(400);
      expect(res.body.code, `query ${qs}`).toBe(1001);
    }
  });
});

describe('#6 GET /api/sessions/:id（详情 + 消息分页）', () => {
  it('返回 session + messages（正序，含开场白）+ has_more', async () => {
    const created = await createSession({ scene_id: 'tech-1on1' }).expect(201);
    const id = created.body.data.session.id as string;

    const res = await request(app).get(`/api/sessions/${id}`).expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.session.id).toBe(id);
    expect(res.body.data.messages).toHaveLength(1); // 开场白
    expect(res.body.data.messages[0].role).toBe('assistant');
    expect(res.body.data.has_more).toBe(false);
  });

  it('消息分页：msg_limit / msg_offset', async () => {
    // 制造 3 条消息：开场白 + user + assistant（走一轮真实 SSE）
    const server = await import('./helpers/server').then((m) => m.startTestServer(app));
    try {
      const created = await createSession({ scene_id: 'coffee-chat' });
      const id = created.body.data.session.id as string;
      const chatRes = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id, content: 'Morning! Just grabbing my coffee.' }),
      });
      await chatRes.text();

      const page1 = await request(app).get(`/api/sessions/${id}?msg_limit=1&msg_offset=0`).expect(200);
      expect(page1.body.data.messages).toHaveLength(1);
      expect(page1.body.data.messages[0].role).toBe('assistant'); // 最早消息 = 开场白
      expect(page1.body.data.has_more).toBe(true);

      const page3 = await request(app).get(`/api/sessions/${id}?msg_limit=1&msg_offset=2`).expect(200);
      expect(page3.body.data.messages).toHaveLength(1);
      expect(page3.body.data.messages[0].role).toBe('assistant'); // 最后一条 = AI 回复
      expect(page3.body.data.has_more).toBe(false);

      const page2 = await request(app).get(`/api/sessions/${id}?msg_limit=2&msg_offset=1`).expect(200);
      expect(page2.body.data.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    } finally {
      await server.close();
    }
  });

  it('会话不存在 → 404 + code 2001', async () => {
    const res = await request(app).get('/api/sessions/00000000-0000-4000-8000-000000000000').expect(404);
    expect(res.body.code).toBe(2001);
    expect(res.body.message).toBe('会话不存在');
  });

  it('非法消息分页参数 → 400 + 1001', async () => {
    const created = await createSession({ scene_id: 'coffee-chat' }).expect(201);
    const id = created.body.data.session.id as string;
    for (const qs of ['?msg_limit=0', '?msg_limit=201', '?msg_offset=-1', '?msg_limit=xyz']) {
      const res = await request(app).get(`/api/sessions/${id}${qs}`).expect(400);
      expect(res.body.code, `query ${qs}`).toBe(1001);
    }
  });
});

describe('#7 PATCH /api/sessions/:id（重命名）', () => {
  it('合法 title → 更新成功并返回 session', async () => {
    const created = await createSession({ scene_id: 'sprint-planning' }).expect(201);
    const id = created.body.data.session.id as string;
    const res = await request(app).patch(`/api/sessions/${id}`).send({ title: 'My planning session' }).expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.session.title).toBe('My planning session');
  });

  it('title 超长（101 字符）/ 空白 / 缺失 → 400 + 1001', async () => {
    const created = await createSession({ scene_id: 'sprint-planning' }).expect(201);
    const id = created.body.data.session.id as string;
    await request(app).patch(`/api/sessions/${id}`).send({ title: 'a'.repeat(101) }).expect(400).then((r) => {
      expect(r.body.code).toBe(1001);
    });
    await request(app).patch(`/api/sessions/${id}`).send({ title: '   ' }).expect(400);
    await request(app).patch(`/api/sessions/${id}`).send({}).expect(400);
  });

  it('会话不存在 → 404 + 2001', async () => {
    await request(app)
      .patch('/api/sessions/00000000-0000-4000-8000-000000000000')
      .send({ title: 'x' })
      .expect(404)
      .then((r) => expect(r.body.code).toBe(2001));
  });
});

describe('#8 DELETE /api/sessions/:id（级联删除）', () => {
  it('删除成功 → {}；再查 404；消息级联删除（FK ON DELETE CASCADE）', async () => {
    const server = await import('./helpers/server').then((m) => m.startTestServer(app));
    try {
      const created = await createSession({ scene_id: 'gym-fitness' }).expect(201);
      const id = created.body.data.session.id as string;
      const chatRes = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: id, content: 'I want to build some muscle.' }),
      });
      await chatRes.text();
      expect(countMessagesDirect(id)).toBe(3);

      const del = await request(app).delete(`/api/sessions/${id}`).expect(200);
      expect(del.body).toEqual({ code: 0, data: {}, message: 'ok' });

      await request(app).get(`/api/sessions/${id}`).expect(404).then((r) => {
        expect(r.body.code).toBe(2001);
      });

      // 消息已级联删除（直接查临时库验证）
      expect(countMessagesDirect(id)).toBe(0);

      // 重复删除 → 404 + 2001
      await request(app).delete(`/api/sessions/${id}`).expect(404).then((r) => {
        expect(r.body.code).toBe(2001);
      });
    } finally {
      await server.close();
    }
  });
});

function countMessagesDirect(sessionId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
      .get(sessionId) as { c: number }
  ).c;
}
