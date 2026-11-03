/**
 * 词汇本服务（类图 VocabularyService）
 *
 * - define：LLM 生成词条四要素（非流式，15s 超时，失败 3001/3003）；
 * - save：UNIQUE(user_id, word) UPSERT——覆盖更新释义等字段、review_count+1、
 *   保留最早 created_at 与既有掌握度（复习习惯连续性，§3.3.2）；
 * - list：掌握度过滤 + 分页 + 排序；updateMastery / remove；masteredWords 供画像注入。
 */

import { randomUUID } from 'node:crypto';
import type { Page } from '../../../shared/types/api';
import type { MasteryLevel, Word, WordDefineResult } from '../../../shared/types/models';
import { getDb } from '../db/database';
import { llmParseError, wordNotFound } from '../middleware/error';
import { llmClient } from './llm.service';
import { buildDefineWordPrompt } from './prompt.service';

/* ---------- 行类型与映射 ---------- */

interface WordRow {
  id: string;
  user_id: string;
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
}

function clampMastery(value: number): MasteryLevel {
  if (value === 1 || value === 2) {
    return value;
  }
  return 0;
}

function rowToWord(row: WordRow): Word {
  return {
    id: row.id,
    user_id: row.user_id,
    word: row.word,
    phonetic: row.phonetic,
    definition: row.definition,
    example: row.example,
    context: row.context,
    source_session_id: row.source_session_id,
    source_scene_id: row.source_scene_id,
    mastery_level: clampMastery(row.mastery_level),
    review_count: row.review_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ---------- define（#10） ---------- */

/**
 * LLM 生成词条四要素（不自动入库）。
 * LLM 连接/超时失败抛 3001/3002（llm.service）；返回内容无法解析抛 3003。
 *
 * 注（审查报告 L1）：原签名带 userId / sessionId 但均未使用（不查库、不写库）。
 * 已移除——需要按用户个性化时再加，届时由类型系统保证调用点同步更新。
 */
export async function defineWord(word: string, context: string): Promise<WordDefineResult> {
  const prompt = buildDefineWordPrompt(word, context);
  const json = await llmClient.completeJSON<Record<string, unknown>>(
    [{ role: 'user', content: prompt }],
    { temperature: 0.3, maxTokens: 200, totalTimeoutMs: 15_000 },
  );
  const definition = typeof json.definition === 'string' ? json.definition.trim() : '';
  if (!definition) {
    throw llmParseError('LLM 未返回有效释义，请重试');
  }
  return {
    word,
    phonetic: typeof json.phonetic === 'string' ? json.phonetic.trim() : '',
    definition,
    example: typeof json.example === 'string' ? json.example.trim() : '',
    context,
  };
}

/* ---------- save（#11，UPSERT） ---------- */

export interface SaveWordInput {
  word: string;
  phonetic: string;
  definition: string;
  example: string;
  context: string;
  sourceSessionId: string | null;
  sourceSceneId: string;
}

export function saveWord(
  userId: string,
  input: SaveWordInput,
): { id: string; word: string; created: boolean } {
  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM vocabulary WHERE user_id = ? AND word = ?')
    .get(userId, input.word) as { id: string } | undefined;

  const id = existing?.id ?? randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO vocabulary
       (id, user_id, word, phonetic, definition, example, context,
        source_session_id, source_scene_id, mastery_level, review_count, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
     ON CONFLICT(user_id, word) DO UPDATE SET
       phonetic = excluded.phonetic,
       definition = excluded.definition,
       example = excluded.example,
       context = excluded.context,
       source_session_id = excluded.source_session_id,
       source_scene_id = excluded.source_scene_id,
       review_count = vocabulary.review_count + 1,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    userId,
    input.word,
    input.phonetic,
    input.definition,
    input.example,
    input.context,
    input.sourceSessionId,
    input.sourceSceneId,
    now,
    now,
  );
  return { id, word: input.word, created: !existing };
}

/* ---------- list（#12） ---------- */

export interface ListWordsFilters {
  mastery?: MasteryLevel;
  limit: number;
  offset: number;
  sort: 'created_desc' | 'created_asc';
}

export function listWords(userId: string, filters: ListWordsFilters): Page<Word> {
  const db = getDb();
  const where =
    filters.mastery === undefined
      ? 'user_id = ?'
      : 'user_id = ? AND mastery_level = ?';
  const params: (string | number)[] =
    filters.mastery === undefined ? [userId] : [userId, filters.mastery];

  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM vocabulary WHERE ${where}`).get(...params) as {
      c: number;
    }
  ).c;
  const order = filters.sort === 'created_asc' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(
      `SELECT * FROM vocabulary WHERE ${where}
       ORDER BY created_at ${order}, rowid ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, filters.limit, filters.offset) as WordRow[];

  return {
    items: rows.map(rowToWord),
    total,
    has_more: filters.offset + rows.length < total,
  };
}

/* ---------- 掌握度更新（#13） ---------- */

export function updateMastery(userId: string, wordId: string, level: MasteryLevel): Word {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare('UPDATE vocabulary SET mastery_level = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(level, now, wordId, userId);
  if (result.changes === 0) {
    throw wordNotFound();
  }
  return getWordById(userId, wordId);
}

export function getWordById(userId: string, wordId: string): Word {
  const row = getDb()
    .prepare('SELECT * FROM vocabulary WHERE id = ? AND user_id = ?')
    .get(wordId, userId) as WordRow | undefined;
  if (!row) {
    throw wordNotFound();
  }
  return rowToWord(row);
}

/* ---------- 删除（#14） ---------- */

export function removeWord(userId: string, wordId: string): void {
  const result = getDb()
    .prepare('DELETE FROM vocabulary WHERE id = ? AND user_id = ?')
    .run(wordId, userId);
  if (result.changes === 0) {
    throw wordNotFound();
  }
}

/* ---------- 画像注入支持 ---------- */

/** 已掌握词（mastery_level=2，按 updated_at 倒序，上限 100），供 System Prompt 注入（P1-5） */
export function masteredWords(userId: string, limit = 100): string[] {
  const rows = getDb()
    .prepare(
      'SELECT word FROM vocabulary WHERE user_id = ? AND mastery_level = 2 ORDER BY updated_at DESC LIMIT ?',
    )
    .all(userId, limit) as Array<{ word: string }>;
  return rows.map((r) => r.word);
}
