-- ============================================================
-- SpeakMate SQLite Schema（架构文档 §3.2）
-- 由 backend/src/db/database.ts 在启动时执行（幂等：IF NOT EXISTS）
-- ============================================================

-- 会话表
CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,                  -- UUID v4（crypto.randomUUID）
  user_id        TEXT NOT NULL DEFAULT 'default',   -- 预留多用户（PRD §6.4）
  scene_id       TEXT NOT NULL,                     -- 场景标识，关联 shared/scenes.json
  title          TEXT NOT NULL DEFAULT '',          -- 列表摘要：用户首条消息截断 50 字符（本地生成，零成本）
  summary        TEXT NOT NULL DEFAULT '',          -- 话题延续摘要：场景名 + 用户首条消息要点
  status         TEXT NOT NULL DEFAULT 'active'     -- active | archived（预留）
    CHECK (status IN ('active','archived')),
  message_count  INTEGER NOT NULL DEFAULT 0,        -- 冗余计数，列表页免 COUNT 查询
  created_at     TEXT NOT NULL,                     -- ISO 8601 UTC
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC);

-- 消息表（对话历史，P0-7）
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,               -- UUID v4
  session_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL DEFAULT 'default',
  role              TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content           TEXT NOT NULL,                  -- 正文（assistant 为流式完成后的全文）
  corrections       TEXT NOT NULL DEFAULT '[]',     -- JSON: Correction[]（§6.1 契约）
  vocab_suggestions TEXT NOT NULL DEFAULT '[]',     -- JSON: VocabSuggestion[]（§6.1 契约）
  created_at        TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

-- 词汇表（词汇本，P0-5/P0-6）
CREATE TABLE IF NOT EXISTS vocabulary (
  id                 TEXT PRIMARY KEY,              -- UUID v4
  user_id            TEXT NOT NULL DEFAULT 'default',
  word               TEXT NOT NULL,                 -- 单词或短语（保留原大小写与空格）
  phonetic           TEXT NOT NULL DEFAULT '',      -- 音标（美式 IPA，LLM 生成）
  definition         TEXT NOT NULL DEFAULT '',      -- 中文释义（贴合来源语境）
  example            TEXT NOT NULL DEFAULT '',      -- 英文例句
  context            TEXT NOT NULL DEFAULT '',      -- 来源上下文（含该词的对话原句）
  source_session_id  TEXT,                          -- 可空（手动添加无来源）
  source_scene_id    TEXT NOT NULL DEFAULT '',      -- 来源场景（列表展示需要）
  mastery_level      INTEGER NOT NULL DEFAULT 0     -- 0=生疏 1=熟悉 2=已掌握（P1-4）
    CHECK (mastery_level IN (0,1,2)),
  review_count       INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (user_id, word)                            -- 同词重复标记 → UPSERT 覆盖更新
);
CREATE INDEX IF NOT EXISTS idx_vocab_user_created ON vocabulary(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vocab_mastery ON vocabulary(user_id, mastery_level);

-- 学习画像表（单行，P0-8）
CREATE TABLE IF NOT EXISTS user_profile (
  user_id          TEXT PRIMARY KEY DEFAULT 'default',
  display_name     TEXT NOT NULL DEFAULT 'SpeakMate', -- 预留：AI 对用户的称呼（首期不注入，见架构 §10）
  common_mistakes  TEXT NOT NULL DEFAULT '[]',       -- JSON: {pattern,count,example,last_seen_at}[]，保留 Top 20
  preferred_scenes TEXT NOT NULL DEFAULT '[]',       -- JSON: {scene_id,count}[]（实际读取时实时聚合自 sessions）
  settings         TEXT NOT NULL DEFAULT '{}',       -- JSON: {tts_enabled, tts_rate}（多端同步预留）
  updated_at       TEXT NOT NULL
);

-- 注：schema 版本由 backend/src/db/migrate.ts 通过 PRAGMA user_version 管理，
--     本文件只做幂等建表（IF NOT EXISTS），不得再写 user_version（会破坏迁移判断）。
