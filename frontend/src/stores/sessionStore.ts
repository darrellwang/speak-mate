/**
 * 会话 store（架构文档 §2 stores/sessionStore.ts）。
 *
 * 会话列表（分页）与当前会话元信息；消息流归 chatStore（恢复/新建时由本 store 写入）。
 * 「最近会话 id」持久化到 localStorage（key: speakmate:last-session-id）：
 * ChatPage 启动时据此续上次会话（PRD §5.1 启动直达对话页）。
 */
import { create } from 'zustand';
import type { Session, SessionListItem } from '@shared/types/models';
import { api } from '../api/endpoints';
import { useChatStore } from './chatStore';

const LAST_SESSION_KEY = 'speakmate:last-session-id';
const LIST_PAGE_SIZE = 20;
/** 恢复会话时拉取的消息窗口（消息正序分页，取最近 N 条） */
const RESTORE_WINDOW = 50;

export function saveLastSessionId(sessionId: string | null): void {
  try {
    if (sessionId === null) {
      window.localStorage.removeItem(LAST_SESSION_KEY);
    } else {
      window.localStorage.setItem(LAST_SESSION_KEY, sessionId);
    }
  } catch {
    // localStorage 不可用（隐私模式等）时静默降级
  }
}

export function getLastSessionId(): string | null {
  try {
    return window.localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

interface SessionState {
  sessions: SessionListItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  currentSession: Session | null;

  /** 历史列表加载（reset=true 重置到第一页） */
  loadSessions(reset?: boolean): Promise<void>;
  /** 设置当前会话（null = 清空并重置消息流） */
  setCurrent(session: Session | null): void;
  /**
   * 恢复历史会话到当前会话并载入最近消息窗口。
   * 两段式：先取 session 元信息（message_count），再按 offset 取最近 N 条。
   * @returns 是否成功（失败时 client 层已 toast）
   */
  restoreSession(sessionId: string): Promise<boolean>;
  renameSession(sessionId: string, title: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  total: 0,
  hasMore: false,
  loading: false,
  currentSession: null,

  loadSessions: async (reset = false) => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const offset = reset ? 0 : get().sessions.length;
      const page = await api.listSessions({ limit: LIST_PAGE_SIZE, offset });
      set((state) => ({
        sessions: reset ? page.items : [...state.sessions, ...page.items],
        total: page.total,
        hasMore: page.has_more,
      }));
    } catch {
      // client 已统一 toast；保持现有列表
    } finally {
      set({ loading: false });
    }
  },

  setCurrent: (session) => {
    set({ currentSession: session });
    saveLastSessionId(session === null ? null : session.id);
    if (session === null) {
      useChatStore.getState().reset();
    }
  },

  restoreSession: async (sessionId) => {
    try {
      // 1) 元信息（含 message_count 冗余计数）
      const head = await api.getSessionDetail(sessionId, { msg_limit: 1, msg_offset: 0 });
      const count = head.session.message_count;
      // 2) 最近 N 条（正序）：offset = max(0, count - N)
      const offset = Math.max(0, count - RESTORE_WINDOW);
      const detail =
        count <= 1
          ? head
          : await api.getSessionDetail(sessionId, {
              msg_limit: RESTORE_WINDOW,
              msg_offset: offset,
            });
      set({ currentSession: detail.session });
      saveLastSessionId(detail.session.id);
      useChatStore.getState().setMessages(detail.messages);
      return true;
    } catch {
      return false;
    }
  },

  renameSession: async (sessionId, title) => {
    const result = await api.renameSession(sessionId, title);
    set((state) => ({
      sessions: state.sessions.map((item) =>
        item.id === sessionId ? { ...item, title: result.session.title } : item,
      ),
    }));
    if (get().currentSession?.id === sessionId) {
      set({ currentSession: result.session });
    }
  },

  deleteSession: async (sessionId) => {
    await api.deleteSession(sessionId);
    set((state) => ({
      sessions: state.sessions.filter((item) => item.id !== sessionId),
      total: Math.max(0, state.total - 1),
    }));
    if (get().currentSession?.id === sessionId) {
      // 删除的是当前会话：清空当前会话与消息流，回场景选择
      set({ currentSession: null });
      saveLastSessionId(null);
      useChatStore.getState().reset();
    }
  },
}));
