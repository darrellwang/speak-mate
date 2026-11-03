/**
 * ⚠️ 本文件由 scripts/sync-types.mjs 从 shared/types 自动生成，请勿手动编辑。
 * 唯一事实源：shared/types/（后端与 H5 前端共用同一份契约）。
 * 修改契约后请重跑：node scripts/sync-types.mjs
 */

/**
 * 领域模型（shared/types/models.ts）
 *
 * Session / Message / Word / Profile / Scene 五个领域实体，
 * 与 SQLite 表结构（backend/src/db/schema.sql §3.2）一一对应。
 * 纯类型文件，零运行时依赖。
 */

import type { Correction, VocabSuggestion } from './chat';

/** 场景分类：IT 职场 / 生活 / （AMD DevOps）面试 */
export type SceneCategory = 'it' | 'life' | 'interview';

/** 内置场景（shared/scenes.json 的单条结构，前后端唯一事实源） */
export interface Scene {
  /** 场景标识（如 daily-standup） */
  id: string;
  /** 中文名（如 每日站会） */
  name: string;
  /** 英文名（注入 System Prompt 与列表展示，如 Daily Standup） */
  name_en: string;
  /** 分类：it | life | interview */
  category: SceneCategory;
  /** 中文描述（场景选择页展示） */
  description: string;
  /** AI 扮演角色（英文，注入 System Prompt） */
  role: string;
  /** 对话目标（英文，注入 System Prompt） */
  goal: string;
  /** 静态开场白（英文；延续模式 LLM 生成失败时的降级兜底） */
  opener: string;
}

export type SessionStatus = 'active' | 'archived';

/** 用户账号来源：微信登录 / 邀请码登录 */
export type UserSource = 'wechat' | 'invite';

/** 用户账号（P2-5 多用户体系） */
export interface User {
  id: string;
  source: UserSource;
  /** 随机生成的展示名（不取微信昵称/头像） */
  nickname: string;
  created_at: string;
  last_login_at: string;
}

/** 登录响应（POST /api/auth/*） */
export interface AuthSession {
  /** 自签 token，仅本次返回 */
  token: string;
  user: User;
  /** 过期时间（ISO 8601） */
  expires_at: string;
}

/** 会话 */
export interface Session {
  id: string;
  user_id: string;
  /** 关联场景 id（scenes.json） */
  scene_id: string;
  /** 列表摘要：用户首条消息截断 50 字符（本地生成，零成本） */
  title: string;
  /** 话题延续摘要：场景名 + 用户首条消息要点 */
  summary: string;
  status: SessionStatus;
  /** 冗余计数，列表页免 COUNT 查询 */
  message_count: number;
  created_at: string;
  updated_at: string;
}

/** 会话列表项（Session + 场景冗余信息，历史列表展示用） */
export interface SessionListItem extends Session {
  /** 场景英文名（冗余自 scenes.json） */
  scene_name: string;
  /** 场景分类（冗余自 scenes.json） */
  scene_category: SceneCategory;
}

export type MessageRole = 'user' | 'assistant';

/** 单条消息 */
export interface Message {
  id: string;
  session_id: string;
  user_id: string;
  role: MessageRole;
  /** 正文（assistant 为流式完成后的全文） */
  content: string;
  /** 纠错卡片数组（assistant 消息可携带，user 恒为 []） */
  corrections: Correction[];
  /** AI 建议词条数组（assistant 消息可携带，user 恒为 []） */
  vocab_suggestions: VocabSuggestion[];
  created_at: string;
}

/** 掌握度：0=生疏 1=熟悉 2=已掌握（=2 时注入画像，AI 不再解释该词） */
export type MasteryLevel = 0 | 1 | 2;

/** 词汇本词条 */
export interface Word {
  id: string;
  user_id: string;
  /** 单词或短语（保留原大小写与空格） */
  word: string;
  /** 音标（美式 IPA） */
  phonetic: string;
  /** 中文释义（贴合来源语境） */
  definition: string;
  /** 英文例句 */
  example: string;
  /** 来源上下文（含该词的对话原句） */
  context: string;
  /** 来源会话（可空：手动添加无来源） */
  source_session_id: string | null;
  /** 来源场景 id（列表展示需要） */
  source_scene_id: string;
  mastery_level: MasteryLevel;
  /** 复习次数（重复标记同词 UPSERT 时 +1） */
  review_count: number;
  created_at: string;
  updated_at: string;
}

/** POST /api/words/define 的返回（LLM 生成词条四要素，不自动入库） */
export interface WordDefineResult {
  word: string;
  phonetic: string;
  definition: string;
  example: string;
  /** 回传请求时的来源上下文 */
  context: string;
}

/** 常错表达统计（user_profile.common_mistakes 的单条，保留 Top 20） */
export interface MistakePattern {
  /** 错误表达（original） */
  pattern: string;
  /** 正应表达（corrected，用于 Prompt 注入 "A → B"） */
  corrected: string;
  /** 问题类型（CorrectionIssue） */
  issue: string;
  /** 出现次数 */
  count: number;
  /** 最近一次原句示例 */
  example: string;
  /** 最近出现时间（ISO 8601 UTC） */
  last_seen_at: string;
}

/** 高频场景统计（sessions 表实时聚合） */
export interface SceneStat {
  scene_id: string;
  count: number;
}

/** 用户设置（TTS 等，多端同步预留） */
export interface ProfileSettings {
  tts_enabled: boolean;
  /** 0.5 – 2.0，1 为正常语速 */
  tts_rate: number;
}

/** 学习画像（GET /api/profile 的完整对象） */
export interface Profile {
  user_id: string;
  /** 预留：AI 对用户的称呼（首期不注入 Prompt） */
  display_name: string;
  common_mistakes: MistakePattern[];
  preferred_scenes: SceneStat[];
  settings: ProfileSettings;
  updated_at: string;
}

/** 画像统计摘要 */
export interface ProfileStats {
  session_count: number;
  message_count: number;
  word_count: number;
  mastered_count: number;
}

/** GET /api/profile 的 data（画像摘要，设置页展示） */
export interface ProfileSummary {
  stats: ProfileStats;
  /** 常错 Top5 */
  common_mistakes: MistakePattern[];
  preferred_scenes: SceneStat[];
  /** AI 对用户的称呼（T8 增补：设置页 display_name 编辑的回显字段，additive 向后兼容） */
  display_name: string;
}
