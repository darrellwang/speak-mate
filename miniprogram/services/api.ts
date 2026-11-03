/**
 * REST 端点（services/api.ts）
 *
 * 与 H5 端 api/endpoints.ts 一一对应（接口 #1–#16 + #9b sync），
 * 类型全部来自同步生成的 types/*.d.ts，不在小程序端重复定义契约。
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
} from '../types/api';
import type { Session } from '../types/models';
import { http, type RequestOptions } from '../utils/request';

/** PATCH /api/sessions/:id 响应（后端契约里未命名，与 H5 端保持一致声明） */
export interface UpdateSessionData {
  session: Session;
}

/** 查询串构造：跳过 undefined/null/空串（小程序无 URLSearchParams 保证，手写拼接） */
function buildQuery(params: object): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

export const api = {
  /* #1 健康检查（设置页「测试连接」用） */
  getHealth(options?: RequestOptions): Promise<HealthData> {
    return http.get<HealthData>('/api/health', options);
  },

  /* #2 系统配置（设置页只读展示） */
  getConfig(options?: RequestOptions): Promise<ConfigData> {
    return http.get<ConfigData>('/api/config', options);
  },

  /* #3 场景列表 */
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

  /* #6 会话详情（消息分页） */
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

  /* #10 LLM 生成词条四要素（不入库） */
  defineWord(body: DefineWordRequest, options?: RequestOptions): Promise<DefineWordData> {
    return http.post<DefineWordData>('/api/words/define', body, options);
  },

  /* #11 词条入库（UNIQUE UPSERT） */
  saveWord(body: SaveWordRequest, options?: RequestOptions): Promise<SaveWordData> {
    return http.post<SaveWordData>('/api/words', body, options);
  },

  /* #12 词汇本列表 */
  listWords(query: ListWordsQuery, options?: RequestOptions): Promise<ListWordsData> {
    return http.get<ListWordsData>(`/api/words${buildQuery(query)}`, options);
  },

  /* #13 掌握度标记 */
  updateWordMastery(
    wordId: string,
    masteryLevel: 0 | 1 | 2,
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

  /* #16 更新画像/设置 */
  updateProfile(
    body: UpdateProfileRequest,
    options?: RequestOptions,
  ): Promise<UpdateProfileData> {
    return http.patch<UpdateProfileData>('/api/profile', body, options);
  },
};
