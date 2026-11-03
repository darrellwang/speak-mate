/**
 * 系统接口（#1 GET /api/health、#2 GET /api/config）
 */

import { Router } from 'express';
import { config } from '../config/env';
import { getDb } from '../db/database';
import { sendOk } from '../middleware/error';
import { localTtsStatus } from '../services/tts.service';
import { DEFAULT_VOICE, TTS_VOICES } from './tts.routes';

export const systemRouter = Router();

/** #1 健康检查 / 部署自检：status + db 探活 + LLM provider 只读信息（不含 Key） */
systemRouter.get('/health', (_req, res) => {
  let dbStatus = 'ok';
  try {
    getDb().prepare('SELECT 1 AS one').get();
  } catch (err) {
    console.error('[health] database check failed:', err);
    dbStatus = 'error';
  }
  if (dbStatus !== 'ok') {
    res.status(500).json({ code: 5000, data: null, message: '数据库不可用' });
    return;
  }
  sendOk(res, {
    status: 'ok',
    db: dbStatus,
    llm: { provider: config.llm.provider, model: config.llm.model },
    // TTS 引擎状态：mode 是配置的模式，local 是本地 Kokoro 的实际就绪情况
    tts: { mode: config.tts.engine, local: localTtsStatus() },
  });
});

/** #2 系统配置：产品显示名 + provider 只读展示（设置页）+ TTS 引擎与音色 + 版本 */
systemRouter.get('/config', (_req, res) => {
  sendOk(res, {
    app_name: config.appName,
    llm: { provider: config.llm.provider, model: config.llm.model },
    // tts.engine 说明实际使用的引擎：
    //   kokoro-local = 本地 Kokoro 模型（离线合成）
    //   edge-tts     = 在线微软 Edge TTS
    // 音色列表沿用对外统一的 Edge 命名（后端内部映射到本地音色），小程序端零改动。
    tts: {
      engine: config.tts.engine === 'edge' ? 'edge-tts' : 'kokoro-local',
      default_voice: DEFAULT_VOICE,
      voices: TTS_VOICES,
    },
    version: config.version,
  });
});
