/**
 * 词汇接口（#10–#14）：LLM 词条生成 / UPSERT 入库 / 列表过滤 / 掌握度标记 / 删除。
 */

import { Router } from 'express';
import { requireUserId } from '../middleware/context';
import { asyncHandler, badRequest, sendOk } from '../middleware/error';
import { llmLimiter, readLimiter, writeLimiter } from '../middleware/rateLimit';
import { parsePagination, queryOf } from '../middleware/validate';
import * as vocabularyService from '../services/vocabulary.service';

export const wordsRouter = Router();

/** #10 POST /api/words/define：LLM 生成词条四要素（不自动入库，P0-5） */
wordsRouter.post(
  '/define',
  llmLimiter, // 真实消耗 LLM token
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const word = typeof body.word === 'string' ? body.word.trim() : '';
    if (!word || word.length > 100) {
      throw badRequest('word 必须为 1–100 字符');
    }
    const context =
      typeof body.context === 'string' ? body.context.slice(0, 2000) : '';
    const result = await vocabularyService.defineWord(word, context);
    sendOk(res, result);
  }),
);

/** #11 POST /api/words：词条入库（UNIQUE UPSERT，P0-5） → {id, word, created} */
wordsRouter.post('/', writeLimiter, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const word = typeof body.word === 'string' ? body.word.trim() : '';
  if (!word || word.length > 100) {
    throw badRequest('word 必填（1–100 字符）');
  }
  const strField = (value: unknown, max: number): string =>
    typeof value === 'string' ? value.slice(0, max) : '';
  const sourceSessionId =
    typeof body.source_session_id === 'string' && body.source_session_id.trim()
      ? body.source_session_id.trim()
      : null;
  const result = vocabularyService.saveWord(requireUserId(req), {
    word,
    phonetic: strField(body.phonetic, 200),
    definition: strField(body.definition, 500),
    example: strField(body.example, 500),
    context: strField(body.context, 1000),
    sourceSessionId,
    sourceSceneId: strField(body.source_scene_id, 100),
  });
  sendOk(res, result);
});

/** #12 GET /api/words：词汇本列表 ?mastery=&limit=&offset=&sort= → {items, total, has_more} */
wordsRouter.get('/', readLimiter, (req, res) => {
  const query = queryOf(req);
  // 与 sessions 路由共用同一套分页校验规则（含 limit 整数性校验）
  const { limit, offset } = parsePagination(query, { defaultLimit: 50, maxLimit: 200 });
  let mastery: 0 | 1 | 2 | undefined;
  if (query.mastery !== undefined) {
    const m = Number(query.mastery);
    if (![0, 1, 2].includes(m)) {
      throw badRequest('mastery 必须为 0/1/2');
    }
    mastery = m as 0 | 1 | 2;
  }
  const sort = query.sort === 'created_asc' ? 'created_asc' : 'created_desc';
  sendOk(
    res,
    vocabularyService.listWords(requireUserId(req), {
      mastery,
      limit,
      offset,
      sort,
    }),
  );
});

/** #13 PATCH /api/words/:id：掌握度标记（=2 同步进画像注入，P1-4/5） → {word} */
wordsRouter.patch('/:id', writeLimiter, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const level = Number(body.mastery_level);
  if (![0, 1, 2].includes(level)) {
    throw badRequest('mastery_level 必须为 0/1/2');
  }
  sendOk(res, {
    word: vocabularyService.updateMastery(
      requireUserId(req),
      req.params.id,
      level as 0 | 1 | 2,
    ),
  });
});

/** #14 DELETE /api/words/:id → {} */
wordsRouter.delete('/:id', writeLimiter, (req, res) => {
  vocabularyService.removeWord(requireUserId(req), req.params.id);
  sendOk(res, {});
});
