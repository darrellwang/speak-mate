/**
 * 会话接口（#4–#8）：创建（含延续模式开场白）/ 列表 / 详情（消息分页）/ 重命名 / 删除。
 *
 * 限流：写操作（创建/重命名/删除）走 writeLimiter，读操作走 readLimiter。
 * 分页校验统一使用 middleware/validate.ts 的 parsePagination（与 words 路由共用一套规则）。
 */

import { Router } from 'express';
import { asyncHandler, badRequest, sendOk } from '../middleware/error';
import { requireUserId } from '../middleware/context';
import { readLimiter, writeLimiter } from '../middleware/rateLimit';
import { parsePagination, queryOf } from '../middleware/validate';
import * as sessionService from '../services/session.service';

export const sessionsRouter = Router();

/** #4 创建会话：{scene_id, continue_from_last?} → {session, messages(开场白)} */
sessionsRouter.post(
  '/',
  writeLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const sceneId = typeof body.scene_id === 'string' ? body.scene_id.trim() : '';
    if (!sceneId) {
      throw badRequest('scene_id 不能为空');
    }
    const continueFromLast = body.continue_from_last === true;
    const result = await sessionService.createSession(requireUserId(req), sceneId, continueFromLast);
    res.status(201);
    sendOk(res, result);
  }),
);

/** #5 会话列表：?limit=&offset= → {items, total, has_more} */
sessionsRouter.get('/', readLimiter, (req, res) => {
  const { limit, offset } = parsePagination(queryOf(req), {
    defaultLimit: 20,
    maxLimit: 100,
  });
  sendOk(res, sessionService.listSessions(requireUserId(req), limit, offset));
});

/** #6 会话详情（回看）：?msg_limit=&msg_offset= → {session, messages, has_more} */
sessionsRouter.get('/:id', readLimiter, (req, res) => {
  const { limit, offset } = parsePagination(queryOf(req), {
    limitKey: 'msg_limit',
    offsetKey: 'msg_offset',
    defaultLimit: 50,
    maxLimit: 200,
  });
  sendOk(res, sessionService.getSessionDetail(requireUserId(req), req.params.id, limit, offset));
});

/** #7 重命名（预留）：{title} → {session} */
sessionsRouter.patch('/:id', writeLimiter, (req, res) => {
  const title = (req.body as Record<string, unknown> | undefined)?.title;
  if (typeof title !== 'string' || !title.trim() || title.length > 100) {
    throw badRequest('title 必须为 1–100 字符');
  }
  sendOk(res, {
    session: sessionService.updateSessionTitle(requireUserId(req), req.params.id, title.trim()),
  });
});

/** #8 删除会话（级联删除消息）→ {} */
sessionsRouter.delete('/:id', writeLimiter, (req, res) => {
  sessionService.removeSession(requireUserId(req), req.params.id);
  sendOk(res, {});
});
