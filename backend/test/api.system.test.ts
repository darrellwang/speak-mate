/**
 * API 集成测试 · 系统与场景接口（#1 / #2 / #3）+ 统一包裹与 404 语义。
 *
 * 通过 supertest 打真实 Express app 实例（createApp），数据落在 setup.ts 分配的临时库。
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';

const app = createApp();

describe('#1 GET /api/health', () => {
  it('返回 200 + {code:0, data:{status,db,llm,tts}}，db 探活 ok、provider=mock', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.code).toBe(0);
    expect(res.body.message).toBe('ok');
    expect(res.body.data).toEqual({
      status: 'ok',
      db: 'ok',
      llm: { provider: 'mock', model: 'mock-english-coach' },
      // TTS 引擎状态：mode 是配置模式，local 是本地 Kokoro 的实际就绪情况
      tts: {
        mode: 'auto',
        local: { status: 'idle', error: null, modelDir: expect.any(String) },
      },
    });
  });

  it('响应不包含 API Key（P0-11 零泄露冒烟）', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(JSON.stringify(res.body)).not.toMatch(/sk-|Bearer|apiKey|api_key/i);
  });
});

describe('#2 GET /api/config', () => {
  it('返回产品显示名 + provider 只读展示 + TTS 引擎与音色 + 版本', async () => {
    const res = await request(app).get('/api/config').expect(200);
    expect(res.body.code).toBe(0);
    const data = res.body.data;
    expect(data.app_name).toBe('SpeakMate');
    expect(data.llm).toEqual({ provider: 'mock', model: 'mock-english-coach' });
    expect(data.version).toBe('1.0.0');
    // TTS：engine 标识当前生效的引擎——
    //   kokoro-local = 本地 Kokoro 模型（离线合成，TTS_ENGINE=local/auto）
    //   edge-tts     = 在线微软 Edge TTS（TTS_ENGINE=edge）
    // 音色 id 对外沿用 Edge 命名（后端内部映射到本地音色），小程序端零改动。
    expect(['kokoro-local', 'edge-tts']).toContain(data.tts.engine);
    expect(data.tts.default_voice).toBe('en-US-JennyNeural');
    expect(data.tts.voices.length).toBeGreaterThanOrEqual(4);
    expect(data.tts.voices[0]).toMatchObject({ id: 'en-US-JennyNeural' });
    for (const v of data.tts.voices) {
      expect(v.id).toMatch(/^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/);
      expect(typeof v.label).toBe('string');
    }
  });
});

describe('#3 GET /api/scenes', () => {
  it('返回 10 个内置场景：IT 5 + 生活 4 + 面试 1（P0-4 首期 ≥9）', async () => {
    const res = await request(app).get('/api/scenes').expect(200);
    expect(res.body.code).toBe(0);
    const scenes = res.body.data.scenes as Array<{
      id: string;
      name: string;
      name_en: string;
      category: string;
      opener: string;
      role: string;
      goal: string;
    }>;
    expect(scenes).toHaveLength(10);

    const byCategory = scenes.reduce<Record<string, number>>((acc, s) => {
      acc[s.category] = (acc[s.category] ?? 0) + 1;
      return acc;
    }, {});
    expect(byCategory).toEqual({ it: 5, life: 4, interview: 1 });

    expect(scenes.map((s) => s.id)).toEqual(
      expect.arrayContaining([
        'daily-standup',
        'sprint-planning',
        'incident-retro',
        'code-review',
        'tech-1on1',
        'coffee-chat',
        'weekend-plan',
        'restaurant-order',
        'gym-fitness',
        'amd-devops-interview',
      ]),
    );

    // 每个场景具备开场所需完整字段（选定后 AI 首条消息为该场景角色开场白）
    for (const s of scenes) {
      expect(s.opener.length, `场景 ${s.id} opener`).toBeGreaterThan(0);
      expect(s.role.length, `场景 ${s.id} role`).toBeGreaterThan(0);
      expect(s.goal.length, `场景 ${s.id} goal`).toBeGreaterThan(0);
      expect(s.name.length).toBeGreaterThan(0);
      expect(s.name_en.length).toBeGreaterThan(0);
    }
  });

  it('场景 id 唯一', async () => {
    const res = await request(app).get('/api/scenes').expect(200);
    const ids = (res.body.data.scenes as Array<{ id: string }>).map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('无会话时 recent_scene_ids 为空数组', async () => {
    const res = await request(app).get('/api/scenes').expect(200);
    expect(res.body.data.recent_scene_ids).toEqual([]);
  });

  it('创建会话后 recent_scene_ids 聚合最近使用场景', async () => {
    await request(app).post('/api/sessions').send({ scene_id: 'daily-standup' }).expect(201);
    await new Promise((r) => setTimeout(r, 10)); // 保证 updated_at 严格递增，规避同毫秒排序抖动
    await request(app).post('/api/sessions').send({ scene_id: 'code-review' }).expect(201);

    const res = await request(app).get('/api/scenes').expect(200);
    const recent = res.body.data.recent_scene_ids as string[];
    expect(recent).toContain('daily-standup');
    expect(recent).toContain('code-review');
    // 最近使用的排在前面
    expect(recent[0]).toBe('code-review');
  });
});

describe('统一约定（架构 §4.1）', () => {
  it('未知 API 路由 → 404 JSON 包裹', async () => {
    const res = await request(app).get('/api/no-such-endpoint').expect(404);
    expect(res.body.code).toBeDefined();
    expect(res.body.code).not.toBe(0);
    expect(typeof res.body.message).toBe('string');
  });

  it('统一响应包裹结构：{code, data, message}', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['code', 'data', 'message']);
  });

  it('安全响应头（helmet）已启用', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });
});
