/**
 * Schema 迁移执行器单元测试（审查报告 M3）。
 *
 * 覆盖：新库版本化、幂等性、遗留库补齐、降级保护。
 */
import { describe, expect, it } from 'vitest';
import { getDb } from '../src/db/database';
import { SCHEMA_VERSION, currentUserVersion, runMigrations } from '../src/db/migrate';

/** 索引是否存在（sqlite_master 查询） */
function indexExists(name: string): boolean {
  const row = getDb()
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { name: string } | undefined;
  return row !== undefined;
}

describe('schema 迁移 · 版本化', () => {
  it('全新库：初始化后 user_version 等于当前程序支持的版本', () => {
    const db = getDb();
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(2);
  });

  it('迁移幂等：重复执行版本号不漂移', () => {
    const db = getDb();
    runMigrations(db);
    runMigrations(db);
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('v2 产物：messages(user_id) 索引已建立', () => {
    expect(indexExists('idx_messages_user')).toBe(true);
  });

  it('v4 产物：users 具备 status / banned_at / ban_reason，新用户默认 active', () => {
    const db = getDb();
    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const names = columns.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(['status', 'banned_at', 'ban_reason']));

    db.prepare(
      `INSERT INTO users (id, openid, source, nickname, created_at, last_login_at)
       VALUES ('user-v4-default', NULL, 'invite', '默认状态', ?, ?)`,
    ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const row = db.prepare(`SELECT status, banned_at, ban_reason FROM users WHERE id = ?`).get(
      'user-v4-default',
    ) as { status: string; banned_at: string | null; ban_reason: string };
    expect(row.status).toBe('active');
    expect(row.banned_at).toBeNull();
    expect(row.ban_reason).toBe('');
  });
});

/**
 * 优雅停机时的数据库关闭（审查报告 L6）。
 *
 * 注：SIGTERM/SIGINT 的完整停机流程依赖信号投递，Windows 无法跨进程发送 SIGTERM，
 * 故此处只验证被停机流程调用的核心动作 closeDb() 本身，以及「重启后迁移不会重跑」。
 */
describe('closeDb · 优雅停机', () => {
  it('关闭后重新打开得到新连接，且重启不会重复执行迁移', async () => {
    const { getDb, closeDb } = await import('../src/db/database');
    const first = getDb();
    const versionBefore = currentUserVersion(first);
    expect(versionBefore).toBe(SCHEMA_VERSION);

    closeDb();

    const second = getDb();
    expect(second).not.toBe(first);
    // 重新打开的是同一个库文件：版本保持最新，不回退也不重复升级
    expect(currentUserVersion(second)).toBe(SCHEMA_VERSION);
    expect(indexExists('idx_messages_user')).toBe(true);
  });
});

describe('schema 迁移 · 遗留库演进', () => {
  it('历史库（无索引 + user_version=1）→ 执行后补齐索引并升到最新版本', () => {
    const db = getDb();
    // 构造"老库"形态：退回 v1 且去掉 v2 的产物
    db.exec('DROP INDEX IF EXISTS idx_messages_user');
    db.pragma('user_version = 1');
    expect(indexExists('idx_messages_user')).toBe(false);
    expect(currentUserVersion(db)).toBe(1);

    runMigrations(db);

    expect(indexExists('idx_messages_user')).toBe(true);
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('v3 用户表升级到 v4：补齐封禁列且不丢已有用户', () => {
    const db = getDb();
    db.exec('DROP TABLE IF EXISTS users');
    db.exec(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        openid        TEXT UNIQUE,
        source        TEXT NOT NULL,
        nickname      TEXT NOT NULL DEFAULT '',
        created_at    TEXT NOT NULL,
        last_login_at TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO users (id, openid, source, nickname, created_at, last_login_at)
       VALUES ('legacy-user', 'openid-legacy', 'wechat', '老用户', ?, ?)`,
    ).run('2025-01-01T00:00:00.000Z', '2025-06-01T00:00:00.000Z');
    db.pragma('user_version = 3');

    runMigrations(db);

    const columns = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['status', 'banned_at', 'ban_reason']),
    );
    const row = db.prepare('SELECT nickname, status, ban_reason FROM users WHERE id = ?').get(
      'legacy-user',
    ) as { nickname: string; status: string; ban_reason: string };
    expect(row.nickname).toBe('老用户');
    expect(row.status).toBe('active');
    expect(row.ban_reason).toBe('');
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('降级保护：库版本高于程序支持 → 抛错拒绝启动，避免静默写坏数据', () => {
    const db = getDb();
    db.pragma(`user_version = ${SCHEMA_VERSION + 10}`);
    expect(() => runMigrations(db)).toThrow(/高于/);
    // 还原，避免污染同文件后续用例
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    expect(currentUserVersion(db)).toBe(SCHEMA_VERSION);
  });
});
