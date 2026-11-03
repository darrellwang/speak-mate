/**
 * TTS 接口（#17 GET /api/tts）
 *
 * 引擎：默认本地 Kokoro-82M（进程内 ONNX 推理，完全离线）；
 *       可用 .env 的 TTS_ENGINE=edge 切回在线 Edge TTS，
 *       或 TTS_ENGINE=auto（默认）——本地优先，失败自动回退 Edge，保证播报不中断。
 *
 * 对外音色 id 保持 Edge TTS 命名（en-US-JennyNeural 等），
 * 后端内部翻译成本地 Kokoro 音色名，因此**小程序端零改动**。
 *
 * 参数：
 *   text  (必填) 要合成的文本（上限 500 字符，逐句调用）
 *   voice (可选) 音色名称，默认 en-US-JennyNeural
 *   rate  (可选) 语速 SSML prosody 值，如 "+0%"、"+10%"、"-10%"
 *
 * 返回：audio/mpeg 二进制（mp3），可直接被 wx.downloadFile 下载播放
 */

import { Router, type Request } from 'express';
import rateLimit from 'express-rate-limit';

import { asyncHandler } from '../middleware/error';
import { TTS_CONTENT_TYPE, synthesizeSpeech } from '../services/tts.service';

export const ttsRouter = Router();

/** 默认音色：Jenny（女声，温和自然）；本地映射到 Kokoro 的 af_heart */
export const DEFAULT_VOICE = 'en-US-JennyNeural';

/** 单次合成文本上限（逐句调用，正常句子远小于此） */
const MAX_TEXT_LENGTH = 500;

/**
 * 计数键（P2-5 多用户）：已登录按 userId（各用户互不干扰），
 * 未登录退回 IP（防扫描）。IPv6 取 /64 前缀避免轮换绕过。
 */
function userOrIpKeyGenerator(req: Request): string {
  const userId = req.userId;
  if (typeof userId === 'string' && userId !== '') {
    return `u:${userId}`;
  }
  const ip = req.ip ?? '';
  return `ip:${ip.includes(':') ? ip.split(':').slice(0, 3).join(':') : ip}`;
}

/** TTS 限流：每分钟 60 次（逐句调用，AI 回复通常 5-15 句） */
const ttsLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // v7 的 keyGenerator 类型用的是其内部 Request 类型，做一次断言（运行时行为一致）
  keyGenerator: userOrIpKeyGenerator as never,
  message: { code: 4029, data: null, message: 'TTS 请求过于频繁，请稍后再试' },
});

ttsRouter.use(ttsLimiter);

/**
 * 可选音色白名单。
 *
 * ⚠️ 必须白名单校验，不能把任意 voice 字符串透传给引擎——
 * 那相当于允许客户端向第三方接口注入任意参数。
 * 新增音色时同步更新这里；前端从 /api/config 的 tts.voices 拿列表。
 *
 * id 沿用 Edge TTS 命名以兼容既有客户端；后端映射到本地 Kokoro 音色
 * （见 services/tts.service.ts 的 KOKORO_VOICE_MAP）。
 */
export const TTS_VOICES = [
  { id: 'en-US-JennyNeural', label: 'Jenny · 美式女声 · 温和（默认）' },
  { id: 'en-US-GuyNeural', label: 'Guy · 美式男声 · 沉稳' },
  { id: 'en-US-AriaNeural', label: 'Aria · 美式女声 · 专业' },
  { id: 'en-US-ChristopherNeural', label: 'Christopher · 美式男声 · 播音' },
  { id: 'en-GB-SoniaNeural', label: 'Sonia · 英式女声 · 温和' },
  { id: 'en-GB-RyanNeural', label: 'Ryan · 英式男声 · 英式腔' },
] as const;

const VOICE_IDS = new Set<string>(TTS_VOICES.map((v) => v.id));

ttsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const text = String(req.query.text ?? '').trim();
    // 音色白名单校验：非法值静默回退默认（不报错，保证朗读不中断）
    const voiceRaw = String(req.query.voice ?? DEFAULT_VOICE);
    const voice = VOICE_IDS.has(voiceRaw) ? voiceRaw : DEFAULT_VOICE;
    const rate = String(req.query.rate ?? '+0%');

    if (text === '') {
      res.status(400).json({ code: 4001, data: null, message: 'text 不能为空' });
      return;
    }
    if (text.length > MAX_TEXT_LENGTH) {
      res
        .status(400)
        .json({ code: 4002, data: null, message: `text 过长（上限 ${MAX_TEXT_LENGTH} 字符，当前 ${text.length}）` });
      return;
    }

    try {
      const result = await synthesizeSpeech(text, voice, rate);

      res.setHeader('Content-Type', TTS_CONTENT_TYPE);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.setHeader('X-TTS-Voice', result.voice);
      // 实际生效的引擎（kokoro / edge）——便于诊断「到底走了哪条链路」
      res.setHeader('X-TTS-Engine', result.engine);

      res.send(result.buffer);
    } catch (err) {
      console.error('[tts] 合成失败:', err);
      if (!res.headersSent) {
        res.status(500).json({ code: 5001, data: null, message: 'TTS 合成失败' });
      } else {
        res.end();
      }
    }
  }),
);
