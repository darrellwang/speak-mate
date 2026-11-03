/**
 * 对话 store（架构文档 §2 stores/chatStore.ts）。
 *
 * 当前会话消息流 / streaming 状态 / 失败重试（幂等）——由 useChat 消费 SSE 事件驱动。
 *
 * 临时消息约定：乐观插入的 user/assistant 消息以 `temp-` 前缀 id 标识；
 * done 事件携带真实 message_id 后替换；3003 降级保留 temp id（正文已落库）。
 *
 * 幂等重试镜像后端判定（§4.3）：beginSend 时若尾消息已是同 content 的 user 消息
 * （上一轮失败残留）→ 不重复插入本地气泡，仅重建待输出 assistant 占位。
 *
 * 流归属校验（审查报告 H3 第二道防线）：`activeStreamSessionId` 记录当前流属于哪个会话。
 * 若一轮输出期间会话被切换（setMessages 会将其清空），后续到达的 delta/meta
 * 会被静默丢弃，从而避免"旧会话的 AI 回复被拼到新会话开场白上"。
 * 传 null 时不启用该校验（便于纯状态机单测）。
 */
import { create } from 'zustand';
import type { Correction, VocabSuggestion } from '@shared/types/chat';
import type { Message, MessageRole } from '@shared/types/models';

const TEMP_PREFIX = 'temp-';

function genTempId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${TEMP_PREFIX}${Date.now().toString(36)}-${random}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tempMessage(role: MessageRole, content: string): Message {
  return {
    id: genTempId(),
    session_id: '',
    user_id: 'default',
    role,
    content,
    corrections: [],
    vocab_suggestions: [],
    created_at: nowIso(),
  };
}

interface ChatState {
  messages: Message[];
  /** assistant 输出中（含等待首字的占位气泡） */
  streaming: boolean;
  /** 一轮请求进行中（发出 → done/error/error 事件定论） */
  sending: boolean;
  /** 本轮是否已定论（done / 3003 降级 / 失败）；流意外关闭时用于判定中断 */
  streamSettled: boolean;
  /** 发送失败待重试的用户原文（null = 无失败态） */
  failedContent: string | null;
  failureMessage: string | null;
  /**
   * 当前流归属的会话 id（null = 无进行中的流 或 未启用归属校验）。
   * 归属不匹配时 delta/meta/done 一律丢弃（H3 第二道防线）。
   */
  activeStreamSessionId: string | null;

  /** 整体替换（恢复会话 / 新建会话开场白） */
  setMessages(messages: Message[]): void;
  reset(): void;
  /**
   * 发起一轮：追加 user 气泡（幂等复用）+ assistant 占位气泡。
   * @param content 本轮用户原文
   * @param sessionId 当前会话 id；传入后启用流归属校验（推荐）
   */
  beginSend(content: string, sessionId?: string | null): void;
  appendDelta(text: string): void;
  applyMeta(corrections: Correction[], suggestions: VocabSuggestion[]): void;
  /** done：以真实 message_id 定稿 assistant 消息 */
  finishStreaming(messageId: string): void;
  /** 3003 降级：正文已落库，保留气泡与内容，corrections 留空 */
  finishDegraded(): void;
  /** 失败：移除未定论的 assistant 占位，标记失败态（幂等重试可用） */
  failStreaming(content: string, message: string): void;
  /**
   * 主动取消本轮输出（用户点停止 / 切换会话 / 组件卸载）。
   * 与 failStreaming 的区别：不写入失败态，因此不展示"重试"入口——
   * 用户主动取消不是发送失败。同样移除未定论的 assistant 占位并复位发送锁。
   */
  abortStreaming(): void;
}

/** 更新末尾 assistant 消息的纯函数辅助 */
function updateLastAssistant(
  messages: Message[],
  updater: (message: Message) => Message,
): Message[] | null {
  if (messages.length === 0) return null;
  const index = messages.length - 1;
  const last = messages[index];
  if (last.role !== 'assistant') return null;
  const next = messages.slice();
  next[index] = updater(last);
  return next;
}

export const useChatStore = create<ChatState>()((set, get) => ({
  messages: [],
  streaming: false,
  sending: false,
  streamSettled: true,
  failedContent: null,
  failureMessage: null,
  activeStreamSessionId: null,

  setMessages: (messages) =>
    set({
      messages,
      streaming: false,
      sending: false,
      streamSettled: true,
      failedContent: null,
      failureMessage: null,
      // 切换会话 → 作废进行中的流归属（旧流的后续事件将被丢弃）
      activeStreamSessionId: null,
    }),

  reset: () =>
    set({
      messages: [],
      streaming: false,
      sending: false,
      streamSettled: true,
      failedContent: null,
      failureMessage: null,
      activeStreamSessionId: null,
    }),

  beginSend: (content, sessionId = null) => {
    const { messages } = get();
    const last = messages[messages.length - 1];
    // 幂等重试：尾消息已是同 content 的 user 消息（上轮失败残留）→ 复用，不重复插入
    const isRetry = last !== undefined && last.role === 'user' && last.content === content;
    const baseMessages = isRetry ? messages : [...messages, tempMessage('user', content)];
    set({
      messages: [...baseMessages, tempMessage('assistant', '')],
      streaming: true,
      sending: true,
      streamSettled: false,
      failedContent: null,
      failureMessage: null,
      activeStreamSessionId: sessionId,
    });
  },

  appendDelta: (text) =>
    set((state) => {
      // 归属校验：会话已切换（activeStreamSessionId 被清空）→ 丢弃旧流的增量
      if (state.activeStreamSessionId === null && !state.streaming) return state;
      const next = updateLastAssistant(state.messages, (message) => ({
        ...message,
        content: message.content + text,
      }));
      return next === null ? state : { messages: next };
    }),

  applyMeta: (corrections, suggestions) =>
    set((state) => {
      if (state.activeStreamSessionId === null && !state.streaming) return state;
      const next = updateLastAssistant(state.messages, (message) => ({
        ...message,
        corrections,
        vocab_suggestions: suggestions,
      }));
      return next === null ? state : { messages: next };
    }),

  finishStreaming: (messageId) =>
    set((state) => {
      // 归属校验：会话已切换 → 不得把旧流的 message_id 定稿到新会话的消息上
      if (state.activeStreamSessionId === null && !state.streaming) return state;
      const next = updateLastAssistant(state.messages, (message) => ({ ...message, id: messageId }));
      return {
        messages: next ?? state.messages,
        streaming: false,
        sending: false,
        streamSettled: true,
        activeStreamSessionId: null,
      };
    }),

  finishDegraded: () =>
    set((state) => {
      if (state.activeStreamSessionId === null && !state.streaming) return state;
      return {
        streaming: false,
        sending: false,
        streamSettled: true,
        failedContent: null,
        failureMessage: null,
        activeStreamSessionId: null,
      };
    }),

  failStreaming: (content, message) =>
    set((state) => {
      // 仅移除本轮未定论的尾部 assistant 占位（done 未到 = 服务端可能未落库）；
      // 已定稿消息（含 3003 降级保留的历史 temp 消息）不受影响。
      // 注：失败清理不做归属校验——TEMP_PREFIX 判定已足够安全，
      // 且调用方（useChat）在主动取消时不会走到这里。
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === 'assistant' && last.id.startsWith(TEMP_PREFIX)) {
        messages.pop();
      }
      return {
        messages,
        streaming: false,
        sending: false,
        streamSettled: true,
        failedContent: content,
        failureMessage: message,
        activeStreamSessionId: null,
      };
    }),

  abortStreaming: () =>
    set((state) => {
      // 归属校验：会话已切换（activeStreamSessionId 被清空）→ 状态已被 setMessages 复位，不干预
      if (state.activeStreamSessionId === null && !state.streaming) return state;
      const messages = state.messages.slice();
      const last = messages[messages.length - 1];
      if (last !== undefined && last.role === 'assistant' && last.id.startsWith(TEMP_PREFIX)) {
        messages.pop();
      }
      return {
        messages,
        streaming: false,
        sending: false,
        streamSettled: true,
        failedContent: null,
        failureMessage: null,
        activeStreamSessionId: null,
      };
    }),
}));
