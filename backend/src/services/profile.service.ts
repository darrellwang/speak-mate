/**
 * 学习画像服务（类图 ProfileService，P0-8 跨会话记忆）
 *
 * - getProfileSummary：统计（会话/消息/词数/已掌握）+ 常错 Top5 + 高频场景（实时聚合）；
 * - updateProfile：display_name / settings 合并更新（upsert）；
 * - recordCorrections：每轮对话纠错 → common_mistakes 增量统计（同 pattern 计数累加，保留 Top 20）；
 * - aggregateScenes：preferred_scenes 从 sessions 表实时聚合（§3.3.4，JSON 列仅做预留）；
 * - getLearnerContext：System Prompt 注入上下文（常错 Top5 / 已掌握词 ≤100 / 高频场景）。
 */

import type Database from 'better-sqlite3';
import type {
  MistakePattern,
  Profile,
  ProfileSettings,
  ProfileStats,
  ProfileSummary,
  SceneStat,
} from '../../../shared/types/models';
import type { Correction } from '../../../shared/types/chat';
import { getDb } from '../db/database';
import type { LearnerProfileContext } from './prompt.service';
// 复用词汇服务的已掌握词查询，避免同一条 SQL 在两处各写一遍（审查报告 L1）
import { masteredWords } from './vocabulary.service';

/** common_mistakes 保留上限 */
const MAX_MISTAKE_PATTERNS = 20;
/** Prompt 注入的常错条数 */
const MISTAKE_INJECT_LIMIT = 5;
/** 已掌握词注入上限 */
const MASTERED_WORDS_LIMIT = 100;

const DEFAULT_SETTINGS: ProfileSettings = { tts_enabled: true, tts_rate: 1 };

/* ---------- 行类型 ---------- */

interface ProfileRow {
  user_id: string;
  display_name: string;
  common_mistakes: string;
  preferred_scenes: string;
  settings: string;
  updated_at: string;
}

function getProfileRow(userId: string): ProfileRow | undefined {
  return getDb()
    .prepare('SELECT * FROM user_profile WHERE user_id = ?')
    .get(userId) as ProfileRow | undefined;
}

function safeJsonParse<T>(raw: string | undefined, fallback: T): T {
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function parseMistakes(raw: string): MistakePattern[] {
  const parsed = safeJsonParse<unknown>(raw, []);
  return Array.isArray(parsed)
    ? parsed.filter(
        (m): m is MistakePattern =>
          typeof m === 'object' &&
          m !== null &&
          typeof (m as MistakePattern).pattern === 'string' &&
          typeof (m as MistakePattern).corrected === 'string',
      )
    : [];
}

function normalizeMistake(m: MistakePattern): MistakePattern {
  return {
    pattern: m.pattern,
    corrected: m.corrected,
    issue: typeof m.issue === 'string' ? m.issue : 'grammar',
    count: typeof m.count === 'number' && m.count > 0 ? m.count : 1,
    example: typeof m.example === 'string' ? m.example : m.pattern,
    last_seen_at: typeof m.last_seen_at === 'string' ? m.last_seen_at : new Date().toISOString(),
  };
}

/* ---------- 读取 ---------- */

/** 高频场景统计（sessions 表实时聚合，§3.3.4） */
export function aggregateScenes(userId: string): SceneStat[] {
  const rows = getDb()
    .prepare(
      `SELECT scene_id, COUNT(*) AS count FROM sessions WHERE user_id = ?
       GROUP BY scene_id ORDER BY count DESC, scene_id ASC`,
    )
    .all(userId) as Array<{ scene_id: string; count: number }>;
  return rows.map((r) => ({ scene_id: r.scene_id, count: r.count }));
}

function buildProfile(userId: string): Profile {
  const row = getProfileRow(userId);
  const settingsRaw = safeJsonParse<Partial<ProfileSettings>>(row?.settings, {});
  return {
    user_id: userId,
    display_name: row?.display_name ?? 'SpeakMate',
    common_mistakes: parseMistakes(row?.common_mistakes ?? '[]').map(normalizeMistake),
    preferred_scenes: aggregateScenes(userId),
    settings: { ...DEFAULT_SETTINGS, ...settingsRaw },
    updated_at: row?.updated_at ?? new Date().toISOString(),
  };
}

/** 完整画像（GET 场景，preferred_scenes 实时聚合） */
export function getProfile(userId: string): Profile {
  return buildProfile(userId);
}

/** 画像摘要（#15）：统计 + 常错 Top5 + 高频场景 */
export function getProfileSummary(userId: string): ProfileSummary {
  const db = getDb();
  const sessionCount = (
    db.prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?').get(userId) as {
      c: number;
    }
  ).c;
  const messageCount = (
    db.prepare('SELECT COUNT(*) AS c FROM messages WHERE user_id = ?').get(userId) as {
      c: number;
    }
  ).c;
  const wordCount = (
    db.prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE user_id = ?').get(userId) as {
      c: number;
    }
  ).c;
  const masteredCount = (
    db
      .prepare('SELECT COUNT(*) AS c FROM vocabulary WHERE user_id = ? AND mastery_level = 2')
      .get(userId) as { c: number }
  ).c;

  const stats: ProfileStats = {
    session_count: sessionCount,
    message_count: messageCount,
    word_count: wordCount,
    mastered_count: masteredCount,
  };
  const profile = buildProfile(userId);
  return {
    stats,
    common_mistakes: [...profile.common_mistakes]
      .sort((a, b) => b.count - a.count)
      .slice(0, MISTAKE_INJECT_LIMIT),
    preferred_scenes: profile.preferred_scenes,
    display_name: profile.display_name,
  };
}

/** System Prompt 注入上下文（每轮对话前实时聚合，C2） */
export function getLearnerContext(userId: string): LearnerProfileContext {
  const mistakes = parseMistakes(getProfileRow(userId)?.common_mistakes ?? '[]')
    .map(normalizeMistake)
    .sort((a, b) => b.count - a.count);
  return {
    commonMistakes: mistakes.slice(0, MISTAKE_INJECT_LIMIT),
    masteredWords: masteredWords(userId, MASTERED_WORDS_LIMIT),
    preferredScenes: aggregateScenes(userId),
  };
}

/* ---------- 写入 ---------- */

/**
 * 允许在 upsert 中更新的列白名单（审查报告 L2）。
 * 两处写入原本各复制一份 INSERT ... ON CONFLICT，列一变就要改两处且容易漏。
 * 列名只可能来自这里的字面量常量，不接受任何外部输入，因此拼接是安全的。
 */
const PROFILE_UPSERT_COLUMNS = ['display_name', 'common_mistakes', 'settings'] as const;
type ProfileUpsertColumn = (typeof PROFILE_UPSERT_COLUMNS)[number];

interface ProfileRowValues {
  display_name: string;
  common_mistakes: string;
  settings: string;
}

/** 单行画像 upsert：不存在则插入，存在则只覆盖指定列（updated_at 始终刷新） */
function upsertProfileRow(
  db: Database.Database,
  userId: string,
  values: ProfileRowValues,
  updateColumns: readonly ProfileUpsertColumn[],
): void {
  const assignments = updateColumns.map((column) => `${column} = excluded.${column}`).join(', ');
  db.prepare(
    `INSERT INTO user_profile (user_id, display_name, common_mistakes, preferred_scenes, settings, updated_at)
     VALUES (?, ?, ?, '[]', ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET ${assignments}, updated_at = excluded.updated_at`,
  ).run(
    userId,
    values.display_name,
    values.common_mistakes,
    values.settings,
    new Date().toISOString(),
  );
}

export interface ProfilePatch {
  display_name?: string;
  settings?: Partial<ProfileSettings>;
}

/**
 * 更新画像/设置（#16）：合并 upsert，返回更新后完整画像。
 *
 * 事务化（审查报告 L3）：读 → 合并 → 写是典型的 read-modify-write。
 * 目前 better-sqlite3 同步 API + Node 单线程保证了它不会被并发打断，
 * 但这属于"靠运行时特性兜底"而非设计约束——一旦改为多进程（pm2 -i）或换异步驱动即会丢更新。
 * 显式事务把约束固化下来；写回时仍需保留未修改的 common_mistakes（避免与 recordCorrections 互相覆盖）。
 */
export function updateProfile(userId: string, patch: ProfilePatch): Profile {
  const db = getDb();
  const applyPatch = db.transaction((): void => {
    const row = getProfileRow(userId);
    const displayName = patch.display_name ?? row?.display_name ?? 'SpeakMate';
    const settings: ProfileSettings = {
      ...DEFAULT_SETTINGS,
      ...safeJsonParse<Partial<ProfileSettings>>(row?.settings, {}),
      ...(patch.settings ?? {}),
    };
    upsertProfileRow(
      db,
      userId,
      {
        display_name: displayName,
        // 未修改的 common_mistakes 必须原样写回，否则会被 recordCorrections 的结果覆盖
        common_mistakes: row?.common_mistakes ?? '[]',
        settings: JSON.stringify(settings),
      },
      ['display_name', 'settings'],
    );
  });
  applyPatch();
  return getProfile(userId);
}

/** 纠错统计：同 pattern（original，忽略大小写）计数累加，保留 Top 20（按 count） */
export function recordCorrections(userId: string, corrections: Correction[]): void {
  if (corrections.length === 0) {
    return;
  }
  const db = getDb();
  // 同 updateProfile：read-modify-write 显式事务化（审查报告 L3）
  const applyCorrections = db.transaction((): void => {
    const row = getProfileRow(userId);
    const mistakes = parseMistakes(row?.common_mistakes ?? '[]').map(normalizeMistake);
    const now = new Date().toISOString();

    for (const c of corrections) {
      const found = mistakes.find((m) => m.pattern.toLowerCase() === c.original.toLowerCase());
      if (found) {
        found.count += 1;
        found.corrected = c.corrected;
        found.issue = c.issue;
        found.example = c.original;
        found.last_seen_at = now;
      } else {
        mistakes.push({
          pattern: c.original,
          corrected: c.corrected,
          issue: c.issue,
          count: 1,
          example: c.original,
          last_seen_at: now,
        });
      }
    }
    mistakes.sort((a, b) => b.count - a.count);
    const top = mistakes.slice(0, MAX_MISTAKE_PATTERNS);

    upsertProfileRow(
      db,
      userId,
      {
        // 未修改的 display_name / settings 必须原样写回，否则会被 updateProfile 的结果覆盖
        display_name: row?.display_name ?? 'SpeakMate',
        common_mistakes: JSON.stringify(top),
        settings: row?.settings ?? '{}',
      },
      ['common_mistakes'],
    );
  });
  applyCorrections();
}
