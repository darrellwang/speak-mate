/**
 * SQLite 初始化（better-sqlite3）：WAL / 外键 / 幂等建表。
 *
 * - 数据文件：<DATA_DIR>/speakmate.db（目录自动创建）；
 * - PRAGMA journal_mode=WAL（读写并发）、foreign_keys=ON（messages 级联删除）；
 * - schema 版本与演进由 db/migrate.ts 统一管理（PRAGMA user_version），
 *   schema.sql 仅负责幂等建表。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../config/env';
import { runMigrations } from './migrate';

let dbInstance: Database.Database | null = null;

/** 获取数据库单例（首次调用时完成初始化与建表） */
export function getDb(): Database.Database {
  if (dbInstance) {
    return dbInstance;
  }
  const dataDir = path.resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });

  const db = new Database(path.join(dataDir, 'speakmate.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // schema 演进：按 user_version 应用待执行的迁移（幂等）
  runMigrations(db);

  dbInstance = db;
  return db;
}

/** 关闭连接（测试/优雅停机用） */
export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
