/**
 * API 集成测试 · 词汇接口（#10–#14）：define 四要素 / UPSERT / 列表过滤分页 /
 * 掌握度更新 / 删除。
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

type WordRow = {
  id: string;
  word: string;
  phonetic: string;
  definition: string;
  example: string;
  context: string;
  source_session_id: string | null;
  source_scene_id: string;
  mastery_level: number;
  review_count: number;
  created_at: string;
  updated_at: string;
};

/** 入库词条（返回 supertest Test，可链式 .expect） */
function saveWord(body: Record<string, unknown>) {
  return request(app).post('/api/words').send(body);
}

async function listWords(qs = '') {
  const res = await request(app).get(`/api/words${qs}`).expect(200);
  return res.body.data as { items: WordRow[]; total: number; has_more: boolean };
}

describe('#10 POST /api/words/define（LLM 生成词条四要素，P0-5）', () => {
  it('已收录词（rollback）：四要素齐全 + context 原样回传', async () => {
    const res = await request(app)
      .post('/api/words/define')
      .send({ word: 'rollback', context: 'We performed a rollback last night.' })
      .expect(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;
    expect(data.word).toBe('rollback');
    expect(data.phonetic.startsWith('/')).toBe(true);
    expect(data.definition).toContain('回滚');
    expect(data.example.length).toBeGreaterThan(10);
    expect(data.example).toMatch(/[Ee]n|rollback/);
    expect(data.context).toBe('We performed a rollback last night.');
  });

  it('未收录词：返回结构完整的兜底条目（四要素非空）', async () => {
    const res = await request(app)
      .post('/api/words/define')
      .send({ word: 'flibbertigibbet', context: 'any context' })
      .expect(200);
    const data = res.body.data;
    expect(data.word).toBe('flibbertigibbet');
    expect(data.phonetic.length).toBeGreaterThan(0);
    expect(data.definition.length).toBeGreaterThan(0);
    expect(data.example.length).toBeGreaterThan(0);
  });

  it('带 session_id：正常返回（context 回传不受影响）', async () => {
    const created = await request(app).post('/api/sessions').send({ scene_id: 'code-review' }).expect(201);
    const sessionId = created.body.data.session.id as string;
    const res = await request(app)
      .post('/api/words/define')
      .send({ word: 'pipeline', context: 'The pipeline broke.', session_id: sessionId })
      .expect(200);
    expect(res.body.data.word).toBe('pipeline');
    expect(res.body.data.phonetic).toBe('/ˈpaɪplaɪn/');
  });

  it('word 缺失 / 空白 / 超长（>100）→ 400 + 1001', async () => {
    for (const body of [{}, { word: '' }, { word: '   ' }, { word: 'x'.repeat(101) }]) {
      const res = await request(app).post('/api/words/define').send(body).expect(400);
      expect(res.body.code, JSON.stringify(body)).toBe(1001);
    }
  });
});

describe('#11 POST /api/words（UPSERT 入库）', () => {
  it('新词入库 → {id, word, created:true}，字段持久化', async () => {
    const res = await saveWord({
      word: 'postmortem',
      phonetic: '/ˌpoʊstˈmɔːrtəm/',
      definition: '事故复盘报告',
      example: 'We wrote the postmortem together.',
      context: 'Let us write the postmortem.',
      source_scene_id: 'incident-retro',
    }).expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.data.created).toBe(true);
    expect(res.body.data.word).toBe('postmortem');
    expect(res.body.data.id).toMatch(/[0-9a-f-]{36}/);

    const page = await listWords();
    const saved = page.items.find((w) => w.word === 'postmortem');
    expect(saved).toBeDefined();
    expect(saved?.definition).toBe('事故复盘报告');
    expect(saved?.mastery_level).toBe(0);
    expect(saved?.review_count).toBe(0);
    expect(saved?.source_scene_id).toBe('incident-retro');
  });

  it('仅 word 必填：其余字段缺省为空串（UPSERT 后可由 define 补全）', async () => {
    const res = await saveWord({ word: 'triage' }).expect(200);
    expect(res.body.data.created).toBe(true);
    const page = await listWords();
    const saved = page.items.find((w) => w.word === 'triage');
    expect(saved?.phonetic).toBe('');
    expect(saved?.definition).toBe('');
    expect(saved?.example).toBe('');
    expect(saved?.context).toBe('');
  });

  it('同词重复标记 → UPSERT：created:false、review_count+1、created_at 保留、释义覆盖更新', async () => {
    await saveWord({
      word: 'bottleneck',
      phonetic: '/x/',
      definition: '旧释义',
      example: 'old example',
      context: 'old context',
    }).expect(200);
    const first = (await listWords()).items.find((w) => w.word === 'bottleneck');
    expect(first).toBeDefined();
    const firstCreatedAt = first!.created_at;
    const firstId = first!.id;
    await new Promise((r) => setTimeout(r, 10)); // 保证 updated_at 可区分

    const second = await saveWord({
      word: 'bottleneck',
      phonetic: '/ˈbɑːtlnek/',
      definition: '瓶颈（更新后）',
      example: 'new example',
      context: 'new context',
    }).expect(200);
    expect(second.body.data.created).toBe(false);
    expect(second.body.data.id).toBe(firstId); // 同一条记录

    const after = (await listWords()).items.find((w) => w.word === 'bottleneck');
    expect(after?.review_count).toBe(1);
    expect(after?.created_at).toBe(firstCreatedAt); // 保留最早 created_at
    expect(after!.updated_at >= firstCreatedAt).toBe(true);
    expect(after?.definition).toBe('瓶颈（更新后）');
    expect(after?.phonetic).toBe('/ˈbɑːtlnek/');
  });

  it('UPSERT 保留既有掌握度（复习连续性，§3.3.2）', async () => {
    await saveWord({ word: 'on-call', definition: '值班' }).expect(200);
    const saved = (await listWords()).items.find((w) => w.word === 'on-call');
    await request(app).patch(`/api/words/${saved!.id}`).send({ mastery_level: 2 }).expect(200);

    // 重复标记 → 掌握度不被重置为 0
    await saveWord({ word: 'on-call', definition: '值班（更新）' }).expect(200);
    const after = (await listWords()).items.find((w) => w.word === 'on-call');
    expect(after?.mastery_level).toBe(2);
    expect(after?.review_count).toBe(1);
  });

  it('word 缺失 / 超长 → 400 + 1001', async () => {
    for (const body of [{}, { word: '' }, { word: 'y'.repeat(101) }]) {
      const res = await saveWord(body).expect(400);
      expect(res.body.code).toBe(1001);
    }
  });
});

describe('#12 GET /api/words（列表：倒序 / 过滤 / 分页 / 排序）', () => {
  it('默认 created_desc：最新保存的在前', async () => {
    const words = ['alpha', 'bravo', 'charlie'];
    for (const w of words) {
      await saveWord({ word: w }).expect(200);
    }
    const page = await listWords();
    const positions = words.map((w) => page.items.findIndex((x) => x.word === w));
    // 后保存的排在前面（即便同一毫秒，rowid 兜底）
    expect(positions[0]).toBeGreaterThan(positions[1]);
    expect(positions[1]).toBeGreaterThan(positions[2]);
  });

  it('mastery 过滤：仅返回对应掌握度', async () => {
    const mastered = (await listWords()).items.find((w) => w.word === 'on-call');
    expect(mastered?.mastery_level).toBe(2);

    const onlyMastered = await listWords('?mastery=2');
    expect(onlyMastered.total).toBeGreaterThanOrEqual(1);
    for (const w of onlyMastered.items) {
      expect(w.mastery_level).toBe(2);
    }

    const onlyFresh = await listWords('?mastery=0');
    for (const w of onlyFresh.items) {
      expect(w.mastery_level).toBe(0);
    }
    expect(onlyMastered.total + onlyFresh.total).toBe((await listWords()).total);
  });

  it('分页：limit / offset / has_more', async () => {
    const all = await listWords('?limit=200');
    const total = all.total;
    expect(total).toBeGreaterThanOrEqual(5);

    const page1 = await listWords('?limit=2&offset=0');
    expect(page1.items).toHaveLength(2);
    expect(page1.has_more).toBe(true);

    const lastOffset = Math.max(0, total - 2);
    const lastPage = await listWords(`?limit=2&offset=${lastOffset}`);
    expect(lastPage.items).toHaveLength(Math.min(2, total - lastOffset));
    expect(lastPage.has_more).toBe(false);
  });

  it('sort=created_asc：正序排列', async () => {
    const page = await listWords('?sort=created_asc&limit=200');
    const created = page.items.map((w) => w.created_at);
    const sorted = [...created].sort();
    expect(created).toEqual(sorted);
  });

  it('非法参数：mastery=3 / mastery=abc / limit=0 / limit=201 / offset=-1 → 400 + 1001', async () => {
    for (const qs of ['?mastery=3', '?mastery=abc', '?limit=0', '?limit=201', '?offset=-1']) {
      const res = await request(app).get(`/api/words${qs}`).expect(400);
      expect(res.body.code, `query ${qs}`).toBe(1001);
    }
  });
});

describe('#13 PATCH /api/words/:id（掌握度标记，P1-4/5）', () => {
  it('0 → 1 → 2 更新成功并返回完整词条', async () => {
    await saveWord({ word: 'hotfix', definition: '紧急修复' }).expect(200);
    const saved = (await listWords()).items.find((w) => w.word === 'hotfix');

    const p1 = await request(app).patch(`/api/words/${saved!.id}`).send({ mastery_level: 1 }).expect(200);
    expect(p1.body.data.word.mastery_level).toBe(1);
    const p2 = await request(app).patch(`/api/words/${saved!.id}`).send({ mastery_level: 2 }).expect(200);
    expect(p2.body.data.word.mastery_level).toBe(2);
    const p0 = await request(app).patch(`/api/words/${saved!.id}`).send({ mastery_level: 0 }).expect(200);
    expect(p0.body.data.word.mastery_level).toBe(0);
  });

  it('mastery_level 非法（3 / 缺失 / 字符串）→ 400 + 1001', async () => {
    await saveWord({ word: 'latency', definition: '延迟' }).expect(200);
    const saved = (await listWords()).items.find((w) => w.word === 'latency');
    for (const body of [{ mastery_level: 3 }, {}, { mastery_level: 'high' }]) {
      const res = await request(app).patch(`/api/words/${saved!.id}`).send(body).expect(400);
      expect(res.body.code, JSON.stringify(body)).toBe(1001);
    }
  });

  it('词条不存在 → 404 + 2003', async () => {
    const res = await request(app)
      .patch('/api/words/00000000-0000-4000-8000-000000000000')
      .send({ mastery_level: 1 })
      .expect(404);
    expect(res.body.code).toBe(2003);
    expect(res.body.message).toBe('词条不存在');
  });
});

describe('#14 DELETE /api/words/:id', () => {
  it('删除成功 → {}；重复删除 → 404 + 2003', async () => {
    await saveWord({ word: 'deadline', definition: '截止日期' }).expect(200);
    const before = (await listWords()).total;
    const saved = (await listWords()).items.find((w) => w.word === 'deadline');

    const del = await request(app).delete(`/api/words/${saved!.id}`).expect(200);
    expect(del.body).toEqual({ code: 0, data: {}, message: 'ok' });

    const after = await listWords();
    expect(after.total).toBe(before - 1);
    expect(after.items.find((w) => w.word === 'deadline')).toBeUndefined();

    await request(app).delete(`/api/words/${saved!.id}`).expect(404).then((r) => {
      expect(r.body.code).toBe(2003);
    });
  });

  it('词条不存在 → 404 + 2003', async () => {
    await request(app)
      .delete('/api/words/00000000-0000-4000-8000-000000000000')
      .expect(404)
      .then((r) => expect(r.body.code).toBe(2003));
  });
});
