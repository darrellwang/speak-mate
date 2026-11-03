/**
 * 会话/消息持久化服务（类图 SessionService）
 *
 * - create：场景校验 → 开场白（延续模式 LLM 生成 / 失败降级静态 opener）
 *   → 建会话 + 写开场白（单事务，不留无消息的僵尸会话）；
 * - list / getWithMessages / rename / remove（级联删除，FK ON DELETE CASCADE）；
 * - appendMessage：写消息 + 冗余计数 + 列表摘要（用户首条消息截断 50 字符）
 *   + 话题延续摘要（场景名 + 首条消息要点）；
 * - 幂等支持：getLastMessage 供 chat.service 判定重试复用（§4.3）。
 */

import { randomUUID } from 'node:crypto';
import type { Message, Session, SessionListItem } from '../../../shared/types/models';
import type { Correction, VocabSuggestion } from '../../../shared/types/chat';
import type { Page } from '../../../shared/types/api';
import { getSceneOrUndefined, mustGetScene, sceneDisplayName } from '../config/scenes';
import { getDb } from '../db/database';
import { sessionNotFound } from '../middleware/error';
import { llmClient } from './llm.service';
import { StreamParser } from './parser';
import { buildContinueOpenerPrompt } from './prompt.service';

/* ---------- 行类型与映射 ---------- */

interface SessionRow {
  id: string;
  user_id: string;
  scene_id: string;
  title: string;
  summary: string;
  status: string;
  message_count: number;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  user_id: string;
  role: string;
  content: string;
  corrections: string;
  vocab_suggestions: string;
  created_at: string;
}

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    user_id: row.user_id,
    scene_id: row.scene_id,
    title: row.title,
    summary: row.summary,
    status: row.status === 'archived' ? 'archived' : 'active',
    message_count: row.message_count,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToListItem(row: SessionRow): SessionListItem {
  const scene = getSceneOrUndefined(row.scene_id);
  return {
    ...rowToSession(row),
    scene_name: scene?.name_en ?? row.scene_id,
    scene_category: scene?.category ?? 'it',
  };
}

function safeJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    session_id: row.session_id,
    user_id: row.user_id,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: row.content,
    corrections: safeJsonArray<Correction>(row.corrections),
    vocab_suggestions: safeJsonArray<VocabSuggestion>(row.vocab_suggestions),
    created_at: row.created_at,
  };
}

/* ---------- 查询 ---------- */

/** 获取会话，不存在抛 2001 */
export function mustGetSession(userId: string, sessionId: string): Session {
  const row = getDb()
    .prepare('SELECT * FROM sessions WHERE id = ? AND user_id = ?')
    .get(sessionId, userId) as SessionRow | undefined;
  if (!row) {
    throw sessionNotFound();
  }
  return rowToSession(row);
}

export function listSessions(userId: string, limit: number, offset: number): Page<SessionListItem> {
  const db = getDb();
  // rowid 兜底：updated_at 是 ISO 毫秒串，同毫秒内创建的会话会并列，顺序未定义；
  // 追加单调自增的 rowid 保证「同时间戳时后创建的在前」，列表顺序稳定。
  const rows = db
    .prepare(
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?',
    )
    .all(userId, limit, offset) as SessionRow[];
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(userId) as { c: number }
  ).c;
  return {
    items: rows.map(rowToListItem),
    total,
    has_more: offset + rows.length < total,
  };
}

/**
 * 最近使用的场景 id（按各场景最近一次会话时间倒序，最多 limit 个）。
 *
 * 原先该查询内联在 routes/scenes.routes.ts 中，违反"路由层不直连数据库"的分层约定
 * （审查报告 M5）；下沉至此后可被复用与单独测试。
 */
export function recentSceneIds(userId: string, limit = 5): string[] {
  // 同理用 MAX(rowid) 兜底，保证同毫秒创建时顺序稳定（最近创建的场景排最前）
  const rows = getDb()
    .prepare(
      `SELECT scene_id, MAX(rowid) AS latest_row FROM sessions WHERE user_id = ?
       GROUP BY scene_id ORDER BY MAX(updated_at) DESC, latest_row DESC LIMIT ?`,
    )
    .all(userId, limit) as Array<{ scene_id: string }>;
  return rows.map((r) => r.scene_id);
}

/** 会话详情 + 消息分页（正序，回看从最早消息开始） */
export function getSessionDetail(
  userId: string,
  sessionId: string,
  msgLimit: number,
  msgOffset: number,
): { session: Session; messages: Message[]; has_more: boolean } {
  const session = mustGetSession(userId, sessionId);
  const db = getDb();
  const total = (
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?').get(sessionId) as {
      c: number;
    }
  ).c;
  const rows = db
    .prepare(
      'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ? OFFSET ?',
    )
    .all(sessionId, msgLimit, msgOffset) as MessageRow[];
  return {
    session,
    messages: rows.map(rowToMessage),
    has_more: msgOffset + rows.length < total,
  };
}

/** 最近 n 条消息（正序返回，含开场白；窗口注入 LLM 用） */
export function getRecentMessages(sessionId: string, limit: number): Message[] {
  // 注：派生表不继承物理 rowid，需在子查询中以别名带出，供外层稳定排序
  const rows = getDb()
    .prepare(
      `SELECT * FROM (
        SELECT *, rowid AS _row_order FROM messages WHERE session_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT ?
      ) ORDER BY created_at ASC, _row_order ASC`,
    )
    .all(sessionId, limit) as MessageRow[];
  return rows.map(rowToMessage);
}

/** 会话最后一条消息（幂等重试判定用） */
export function getLastMessage(sessionId: string): Message | null {
  const row = getDb()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(sessionId) as MessageRow | undefined;
  return row ? rowToMessage(row) : null;
}

export function countMessages(sessionId: string): number {
  return (
    getDb()
      .prepare('SELECT COUNT(*) AS c FROM messages WHERE session_id = ?')
      .get(sessionId) as { c: number }
  ).c;
}

/* ---------- 写入 ---------- */

export interface MessageMeta {
  corrections: Correction[];
  vocabSuggestions: VocabSuggestion[];
}

/**
 * 追加消息：写入 + 更新会话冗余字段
 * （message_count 真实计数、updated_at、首条用户消息 → title/summary）。
 *
 * 事务化（审查报告 M2）：消息插入与会话冗余字段更新必须同生共死。
 * 拆分执行时，进程在两者之间退出会留下"消息已入库但计数/标题未更新"的不一致状态，
 * 且列表页依赖 message_count 展示，偏差会直接被用户看到。
 * 支持嵌套调用（createSession 中的外层事务会退化为 SAVEPOINT）。
 */
export function appendMessage(
  sessionId: string,
  role: 'user' | 'assistant',
  content: string,
  meta: MessageMeta = { corrections: [], vocabSuggestions: [] },
): Message {
  const db = getDb();
  const writeMessage = db.transaction((): Message => {
    const sessionRow = db
      .prepare('SELECT user_id, scene_id FROM sessions WHERE id = ?')
      .get(sessionId) as { user_id: string; scene_id: string } | undefined;
    if (!sessionRow) {
      throw sessionNotFound();
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO messages (id, session_id, user_id, role, content, corrections, vocab_suggestions, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      sessionId,
      sessionRow.user_id,
      role,
      content,
      JSON.stringify(meta.corrections),
      JSON.stringify(meta.vocabSuggestions),
      now,
    );

    // 会话冗余字段维护
    const messageCount = countMessages(sessionId);
    let title: string | null = null;
    let summary: string | null = null;
    if (role === 'user') {
      const firstUser = db
        .prepare(
          `SELECT content FROM messages WHERE session_id = ? AND role = 'user'
           ORDER BY created_at ASC, rowid ASC LIMIT 1`,
        )
        .get(sessionId) as { content: string } | undefined;
      if (firstUser) {
        title = firstUser.content.slice(0, 50);
        summary = `${sceneDisplayName(sessionRow.scene_id, sessionRow.scene_id)}: ${firstUser.content.slice(0, 80)}`;
      }
    }
    db.prepare(
      `UPDATE sessions SET
         message_count = ?,
         updated_at = ?,
         title = COALESCE(?, title),
         summary = COALESCE(?, summary)
       WHERE id = ?`,
    ).run(messageCount, now, title, summary, sessionId);

    return {
      id,
      session_id: sessionId,
      user_id: sessionRow.user_id,
      role,
      content,
      corrections: meta.corrections,
      vocab_suggestions: meta.vocabSuggestions,
      created_at: now,
    };
  });

  return writeMessage();
}

/**
 * 创建会话（#4）。
 *
 * 顺序（审查报告 M6）：**先生成开场白，再落库**。
 * 原实现先 INSERT 会话、再等 LLM 生成开场白，中途失败（超时/抛错）会留下
 * "会话已存在但消息数为 0"的僵尸会话——列表页可见、点进去空白。
 * 改为：开场白就绪后，用一条事务同时写入会话与开场白，要么都在、要么都不在。
 *
 * continue_from_last=true：取最近会话尾部 6 条消息 → LLM 生成延续性开场白（6s 超时），
 * 失败降级场景静态 opener——保证新建会话永不失败（§6.5）。
 */
export async function createSession(
  userId: string,
  sceneId: string,
  continueFromLast: boolean,
): Promise<{ session: Session; messages: Message[] }> {
  const scene = mustGetScene(sceneId); // 2002

  // 落库前完成耗时操作：任何失败都不会留下半成品会话
  let opener = scene.opener;
  if (continueFromLast) {
    const generated = await generateContinueOpener(userId);
    if (generated) {
      opener = generated;
    }
  }

  const db = getDb();
  const sessionId = randomUUID();
  const now = new Date().toISOString();
  const createWithOpener = db.transaction((): Message => {
    db.prepare(
      `INSERT INTO sessions (id, user_id, scene_id, title, summary, status, message_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'active', 0, ?, ?)`,
    ).run(sessionId, userId, sceneId, scene.name_en, now, now);
    return appendMessage(sessionId, 'assistant', opener);
  });

  const openerMessage = createWithOpener();
  return { session: mustGetSession(userId, sessionId), messages: [openerMessage] };
}

/**
 * 延续性开场白生成；任何失败返回 null（降级静态 opener）。
 *
 * 会话尚未创建，因此无需排除自身 id——取最近一条会话即可。
 */
async function generateContinueOpener(userId: string): Promise<string | null> {
  try {
    const db = getDb();
    const lastSession = db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1')
      .get(userId) as SessionRow | undefined;
    if (!lastSession) {
      return null;
    }
    const tail = getRecentMessages(lastSession.id, 6);
    if (tail.length === 0) {
      return null;
    }
    const lastScene = getSceneOrUndefined(lastSession.scene_id);
    const prompt = buildContinueOpenerPrompt(
      lastScene?.name_en ?? lastSession.scene_id,
      tail,
    );
    const text = await llmClient.completeText(
      [{ role: 'user', content: prompt }],
      { temperature: 0.8, maxTokens: 200, totalTimeoutMs: 6_000 },
    );
    // 输出遵循对话协议（reply + <<<META>>> + JSON）：用解析器提取正文
    const parser = new StreamParser();
    parser.push(text);
    const parsed = parser.flush();
    const reply = parsed.reply.trim();
    return reply.length > 0 ? reply : null;
  } catch (err) {
    console.warn(
      '[session] 延续性开场白生成失败，降级为静态开场白:',
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** 重命名（#7，预留） */
export function updateSessionTitle(userId: string, sessionId: string, title: string): Session {
  const db = getDb();
  const result = db
    .prepare('UPDATE sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?')
    .run(title, new Date().toISOString(), sessionId, userId);
  if (result.changes === 0) {
    throw sessionNotFound();
  }
  return mustGetSession(userId, sessionId);
}

/** 删除会话（#8）：messages 经 FK ON DELETE CASCADE 级联删除 */
export function removeSession(userId: string, sessionId: string): void {
  const db = getDb();
  const result = db
    .prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?')
    .run(sessionId, userId);
  if (result.changes === 0) {
    throw sessionNotFound();
  }
}
