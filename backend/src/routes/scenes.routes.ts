/**
 * 场景接口（#3 GET /api/scenes）：内置场景列表 + 最近使用标记（P0-4）。
 *
 * 数据访问统一经 service 层（审查报告 M5：原实现在路由层直接执行 SQL，
 * 破坏分层约定且无法单独测试）。
 */

import { Router } from 'express';
import { SCENES, SCENE_MAP } from '../config/scenes';
import { requireUserId } from '../middleware/context';
import { sendOk } from '../middleware/error';
import { readLimiter } from '../middleware/rateLimit';
import * as sessionService from '../services/session.service';

export const scenesRouter = Router();

scenesRouter.get('/', readLimiter, (req, res) => {
  // 最近使用：按各场景最近一次会话时间倒序、去重、取前 5
  const recentSceneIds = sessionService
    .recentSceneIds(requireUserId(req), 5)
    .filter((id) => SCENE_MAP.has(id));
  sendOk(res, { scenes: SCENES, recent_scene_ids: recentSceneIds });
});
