/**
 * ⚠️ 本文件由 scripts/sync-types.mjs 从 shared/types 自动生成，请勿手动编辑。
 * 唯一事实源：shared/types/（后端与 H5 前端共用同一份契约）。
 * 修改契约后请重跑：node scripts/sync-types.mjs
 */

/**
 * REST 请求/响应契约（shared/types/api.ts）
 *
 * 覆盖架构文档 §4.2 全部 16 个接口的入参/出参类型。
 * 统一响应包裹：{ code, data, message }（code=0 成功）；
 * SSE 事件契约见 ./chat.ts（不走包裹）。
 * 纯类型文件，零运行时依赖。
 */

import type { Correction, VocabSuggestion } from './chat';
import type {
  MasteryLevel,
  Message,
  Profile,
  ProfileSettings,
  ProfileSummary,
  Scene,
  Session,
  SessionListItem,
  Word,
  WordDefineResult,
} from './models';

/**
 * 画像摘要再导出：它是 #15 GET /api/profile 的响应体契约（ProfileData），
 * 消费方（H5 设置页 / 小程序设置页）应按「契约模块」引用，
 * 不必先知道它定义在 models 里 —— 省一次跨模块的间接依赖。
 */
export type { ProfileSummary } from './models';

/** 统一响应包裹 */
export interface ApiEnvelope<T> {
  code: number;
  data: T;
  message: string;
}

/** 分页包裹（?limit=&offset= → {items, total, has_more}） */
export interface Page<T> {
  items: T[];
  total: number;
  has_more: boolean;
}

/* ---------- #1 GET /api/health ---------- */
export interface HealthData {
  status: string;
  db: string;
  llm: { provider: string; model: string };
}

/* ---------- #2 GET /api/config ---------- */

/** 可选朗读音色（Edge TTS 神经网络音色，后端白名单下发） */
export interface TtsVoice {
  id: string;
  label: string;
}

export interface ConfigData {
  app_name: string;
  llm: { provider: string; model: string };
  tts: {
    engine: string;
    default_voice: string;
    voices: TtsVoice[];
  };
  version: string;
}

/* ---------- #3 GET /api/scenes ---------- */
export interface ScenesData {
  scenes: Scene[];
  /** 最近使用的场景 id（按最近使用时间倒序、去重，最多 5 个） */
  recent_scene_ids: string[];
}

/* ---------- #4 POST /api/sessions ---------- */
export interface CreateSessionRequest {
  scene_id: string;
  /** true = 延续模式：基于最近会话尾部消息由 LLM 生成延续性开场白（失败降级静态 opener） */
  continue_from_last?: boolean;
}

export interface CreateSessionData {
  session: Session;
  /** 开场白消息（assistant，恒 1 条） */
  messages: Message[];
}

/* ---------- #5 GET /api/sessions ---------- */
export type SessionListData = Page<SessionListItem>;

/* ---------- #6 GET /api/sessions/:id ---------- */
export interface SessionDetailQuery {
  msg_limit?: number;
  msg_offset?: number;
}

export interface SessionDetailData {
  session: Session;
  messages: Message[];
  has_more: boolean;
}

/* ---------- #7 PATCH /api/sessions/:id ---------- */
export interface UpdateSessionRequest {
  title?: string;
}

/* ---------- #9 POST /api/chat（SSE 流，事件类型见 ./chat.ts） ---------- */
export interface ChatRequest {
  session_id: string;
  content: string;
}

/* ---------- #9b POST /api/chat/sync（非流式，SSE 聚合版） ----------
 * 为不支持分块传输的客户端（微信小程序 wx.request 低版本基础库等）提供等价能力：
 * 服务端内部消费同一套 sendMessage 事件流，聚合为一次性 JSON 响应。
 * 语义与 SSE 完全一致：degraded=true 对应 SSE 的 3003（正文可用、无纠错/词条）。
 */
export type ChatSyncRequest = ChatRequest;

export interface ChatSyncData {
  /** 落库的 assistant 消息 id */
  message_id: string;
  session_id: string;
  /** AI 回复正文（全部 delta 事件按序拼接） */
  content: string;
  /** 本轮纠错（降级时为空数组） */
  corrections: Correction[];
  /** 本轮 AI 建议词条（降级时为空数组） */
  vocabulary_suggestions: VocabSuggestion[];
  /** true = LLM 输出协议降级（3003）：正文照常可用，但纠错/词条建议缺失 */
  degraded: boolean;
}

/* ---------- #10 POST /api/words/define ---------- */
export interface DefineWordRequest {
  word: string;
  context: string;
  session_id?: string;
}

export type DefineWordData = WordDefineResult;

/* ---------- #11 POST /api/words ---------- */
export interface SaveWordRequest {
  word: string;
  phonetic?: string;
  definition?: string;
  example?: string;
  context?: string;
  source_session_id?: string | null;
  source_scene_id?: string;
}

export interface SaveWordData {
  id: string;
  word: string;
  /** true = 新建；false = 命中 UNIQUE(user_id, word) 走 UPSERT 更新 */
  created: boolean;
}

/* ---------- #12 GET /api/words ---------- */
export interface ListWordsQuery {
  mastery?: MasteryLevel;
  limit?: number;
  offset?: number;
  /** 默认 created_desc（倒序） */
  sort?: 'created_desc' | 'created_asc';
}

export type ListWordsData = Page<Word>;

/* ---------- #13 PATCH /api/words/:id ---------- */
export interface UpdateWordRequest {
  mastery_level: MasteryLevel;
}

export interface UpdateWordData {
  word: Word;
}

/* ---------- #15 GET /api/profile ---------- */
export type ProfileData = ProfileSummary;

/* ---------- #16 PATCH /api/profile ---------- */
export interface UpdateProfileRequest {
  display_name?: string;
  settings?: Partial<ProfileSettings>;
}

export interface UpdateProfileData {
  profile: Profile;
}
