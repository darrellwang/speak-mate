/**
 * 全部 REST 端点函数（架构文档 §2 api/endpoints.ts，接口清单 §4.2 #1–#16）。
 *
 * 类型一律来自 @shared 契约，不在前端重复定义；
 * 唯一例外：PATCH /api/sessions/:id 的响应 `{session}` 在 shared/types/api.ts 中未命名，
 * 此处按契约 §4.2 #7 本地声明 UpdateSessionData。
 */
import type {
  ConfigData,
  CreateSessionData,
  CreateSessionRequest,
  DefineWordData,
  DefineWordRequest,
  HealthData,
  ListWordsData,
  ListWordsQuery,
  ProfileData,
  SaveWordData,
  SaveWordRequest,
  ScenesData,
  SessionDetailData,
  SessionDetailQuery,
  SessionListData,
  UpdateProfileData,
  UpdateProfileRequest,
  UpdateWordData,
  UpdateWordRequest,
} from '@shared/types/api';
import type { Session } from '@shared/types/models';
import { http, type RequestOptions } from './client';

/** PATCH /api/sessions/:id 响应（§4.2 #7；shared 未命名，按契约本地声明） */
export interface UpdateSessionData {
  session: Session;
}

/** 查询串构造：跳过 undefined/null/空串值（入参为契约 interface，无索引签名） */
function buildQuery(params: object): string {
  const entries = Object.entries(params as Record<string, unknown>);
  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query.length > 0 ? `?${query}` : '';
}

export const api = {
  /* #1 健康检查 */
  getHealth(options?: RequestOptions): Promise<HealthData> {
    return http.get<HealthData>('/api/health', options);
  },

  /* #2 系统配置（设置页只读展示） */
  getConfig(options?: RequestOptions): Promise<ConfigData> {
    return http.get<ConfigData>('/api/config', options);
  },

  /* #3 场景列表 + 最近使用 */
  getScenes(options?: RequestOptions): Promise<ScenesData> {
    return http.get<ScenesData>('/api/scenes', options);
  },

  /* #4 新建会话（含延续模式开场白） */
  createSession(body: CreateSessionRequest, options?: RequestOptions): Promise<CreateSessionData> {
    return http.post<CreateSessionData>('/api/sessions', body, options);
  },

  /* #5 历史会话列表 */
  listSessions(
    query: { limit?: number; offset?: number },
    options?: RequestOptions,
  ): Promise<SessionListData> {
    return http.get<SessionListData>(`/api/sessions${buildQuery(query)}`, options);
  },

  /* #6 会话详情 + 消息分页（消息正序，offset 从最早开始） */
  getSessionDetail(
    sessionId: string,
    query: SessionDetailQuery = {},
    options?: RequestOptions,
  ): Promise<SessionDetailData> {
    return http.get<SessionDetailData>(
      `/api/sessions/${encodeURIComponent(sessionId)}${buildQuery(query)}`,
      options,
    );
  },

  /* #7 会话重命名 */
  renameSession(
    sessionId: string,
    title: string,
    options?: RequestOptions,
  ): Promise<UpdateSessionData> {
    return http.patch<UpdateSessionData>(
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { title },
      options,
    );
  },

  /* #8 删除会话（级联消息） */
  deleteSession(sessionId: string, options?: RequestOptions): Promise<unknown> {
    return http.del(`/api/sessions/${encodeURIComponent(sessionId)}`, options);
  },

  /* #10 LLM 生成词条四要素（不自动入库；弹窗内自行处理错误 → silent） */
  defineWord(body: DefineWordRequest, options?: RequestOptions): Promise<DefineWordData> {
    return http.post<DefineWordData>('/api/words/define', body, options);
  },

  /* #11 词条入库（UNIQUE UPSERT） */
  saveWord(body: SaveWordRequest, options?: RequestOptions): Promise<SaveWordData> {
    return http.post<SaveWordData>('/api/words', body, options);
  },

  /* #12 词汇本列表（mastery 筛选 + 分页） */
  listWords(query: ListWordsQuery, options?: RequestOptions): Promise<ListWordsData> {
    return http.get<ListWordsData>(`/api/words${buildQuery(query)}`, options);
  },

  /* #13 掌握度标记（=2 注入画像） */
  updateWordMastery(
    wordId: string,
    masteryLevel: UpdateWordRequest['mastery_level'],
    options?: RequestOptions,
  ): Promise<UpdateWordData> {
    return http.patch<UpdateWordData>(`/api/words/${encodeURIComponent(wordId)}`, {
      mastery_level: masteryLevel,
    }, options);
  },

  /* #14 删除词条 */
  deleteWord(wordId: string, options?: RequestOptions): Promise<unknown> {
    return http.del(`/api/words/${encodeURIComponent(wordId)}`, options);
  },

  /* #15 学习画像摘要 */
  getProfile(options?: RequestOptions): Promise<ProfileData> {
    return http.get<ProfileData>('/api/profile', options);
  },

  /* #16 更新画像/设置（display_name / settings） */
  updateProfile(
    body: UpdateProfileRequest,
    options?: RequestOptions,
  ): Promise<UpdateProfileData> {
    return http.patch<UpdateProfileData>('/api/profile', body, options);
  },
};
