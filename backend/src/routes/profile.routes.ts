/**
 * 学习画像接口（#15 GET /api/profile、#16 PATCH /api/profile）。
 */

import { Router } from 'express';
import { TTS_RATE_MAX, TTS_RATE_MIN } from '../../../shared/constants';
import { requireUserId } from '../middleware/context';
import { badRequest, sendOk } from '../middleware/error';
import { readLimiter, writeLimiter } from '../middleware/rateLimit';
import * as profileService from '../services/profile.service';

export const profileRouter = Router();

/** #15 画像摘要：stats（会话/消息/词数/已掌握） + 常错 Top5 + 高频场景（P1-6） */
profileRouter.get('/', readLimiter, (req, res) => {
  sendOk(res, profileService.getProfileSummary(requireUserId(req)));
});

/** #16 更新画像/设置：{display_name?, settings?} → {profile} */
profileRouter.patch('/', writeLimiter, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const patch: profileService.ProfilePatch = {};

  if (body.display_name !== undefined) {
    if (typeof body.display_name !== 'string' || !body.display_name.trim() || body.display_name.length > 30) {
      throw badRequest('display_name 必须为 1–30 字符');
    }
    patch.display_name = body.display_name.trim();
  }

  if (body.settings !== undefined) {
    if (typeof body.settings !== 'object' || body.settings === null || Array.isArray(body.settings)) {
      throw badRequest('settings 格式非法');
    }
    const s = body.settings as Record<string, unknown>;
    const settings: { tts_enabled?: boolean; tts_rate?: number } = {};
    if (s.tts_enabled !== undefined) {
      if (typeof s.tts_enabled !== 'boolean') {
        throw badRequest('tts_enabled 必须为布尔值');
      }
      settings.tts_enabled = s.tts_enabled;
    }
    if (s.tts_rate !== undefined) {
      if (
        typeof s.tts_rate !== 'number' ||
        !Number.isFinite(s.tts_rate) ||
        s.tts_rate < TTS_RATE_MIN ||
        s.tts_rate > TTS_RATE_MAX
      ) {
        throw badRequest(`tts_rate 必须为 ${TTS_RATE_MIN}–${TTS_RATE_MAX} 之间的数值`);
      }
      settings.tts_rate = s.tts_rate;
    }
    patch.settings = settings;
  }

  if (patch.display_name === undefined && patch.settings === undefined) {
    throw badRequest('无有效更新字段（display_name / settings）');
  }

  sendOk(res, { profile: profileService.updateProfile(requireUserId(req), patch) });
});
