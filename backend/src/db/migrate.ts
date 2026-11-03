/**
 * Schema 版本与迁移执行器（审查报告 M3）。
 *
 * 原实现把版本号硬编码在 schema.sql 末尾（`PRAGMA user_version = 1`）且无迁移执行器：
 * 一旦后续要改表，老库无法演进——每次启动都会把版本写回 1，任何迁移判断都不会触发。
 *
 * 新约定：
 * - schema.sql 只做幂等建表（`CREATE ... IF NOT EXISTS`），**不再写 user_version**；
 * - 每次结构变更新增一条 Migration（version 严格递增，up 必须幂等可重入）；
 * - 迁移体与版本号在同一事务内提交，中断不会留下"改了一半"的库；
 * - MIGRATIONS[0] 是基线：对全新库建表，对历史遗留的无版本老库同样安全；
 * - 库版本高于程序支持的版本（降级启动）→ 直接抛错，避免静默写坏数据。
 */

import { readFileSync } from 'node:fs';
import type Database from 'better-sqlite3';

const SCHEMA_URL = new URL('./schema.sql', import.meta.url);

export interface Migration {
  /** schema 版本号（严格递增，对应 PRAGMA user_version） */
  version: number;
  /** 可读名称，用于启动日志 */
  name: string;
  /** 迁移体，必须幂等；抛错则整条迁移回滚 */
  up: (db: Database.Database) => void;
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline-schema',
    up: (db) => db.exec(readFileSync(SCHEMA_URL, 'utf-8')),
  },
  {
    // getProfileSummary 按 user_id 统计消息总数，此前只能全表扫描
    version: 2,
    name: 'messages-user-index',
    up: (db) =>
      db.exec('CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id, created_at DESC)'),
  },
  {
    // 多用户体系（P2-5）：账号表 + 登录态表 + 存量数据归属管理员
    version: 3,
    name: 'multi-user-schema',
    up: (db) => {
      // 用户表：openid 为微信应用级唯一标识；nickname 由服务端随机生成（不取微信昵称）
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id            TEXT PRIMARY KEY,              -- uuid v4
          openid        TEXT UNIQUE,                   -- 微信 openid（邀请码用户为 NULL）
          source        TEXT NOT NULL,                 -- wechat | invite
          nickname      TEXT NOT NULL DEFAULT '',      -- 随机生成的展示名
          created_at    TEXT NOT NULL,
          last_login_at TEXT NOT NULL
        );
      `);

      // 登录态表：只存 token 的 sha256，原始 token 仅在登录响应中返回一次
      db.exec(`
        CREATE TABLE IF NOT EXISTS auth_sessions (
          token_hash TEXT PRIMARY KEY,                -- sha256(token)
          user_id    TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);
      db.exec('CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id)');

      // 存量数据归属：历史 user_id='default' 的数据属于管理员账号
      db.exec("UPDATE sessions    SET user_id = 'admin' WHERE user_id = 'default'");
      db.exec("UPDATE messages    SET user_id = 'admin' WHERE user_id = 'default'");
      db.exec("UPDATE vocabulary  SET user_id = 'admin' WHERE user_id = 'default'");
      db.exec("UPDATE user_profile SET user_id = 'admin' WHERE user_id = 'default'");
    },
  },
];

/** 当前程序支持的 schema 版本 */
export const SCHEMA_VERSION: number = MIGRATIONS[MIGRATIONS.length - 1].version;

/** 读取库内 schema 版本（0 = 全新库或未经版本化的历史库） */
export function currentUserVersion(db: Database.Database): number {
  const value = db.pragma('user_version', { simple: true });
  return typeof value === 'number' ? value : 0;
}

/**
 * 执行所有待应用迁移。幂等：已应用的按版本跳过。
 * @throws 库版本高于程序支持版本时抛错（拒绝降级启动）
 */
export function runMigrations(db: Database.Database): void {
  const from = currentUserVersion(db);
  if (from > SCHEMA_VERSION) {
    throw new Error(
      `数据库 schema 版本 ${from} 高于当前程序支持的 ${SCHEMA_VERSION}，请升级 SpeakMate 后再启动`,
    );
  }
  for (const migration of MIGRATIONS) {
    if (migration.version <= from) continue;
    db.transaction(() => {
      migration.up(db);
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}
