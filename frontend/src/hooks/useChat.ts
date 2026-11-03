/**
 * 发送一轮对话（架构文档 §2 hooks/useChat.ts）。
 *
 * 持有 SSE 消费循环（api/sse.ts），把 delta/meta/done/error 事件翻译为 chatStore 状态：
 * - delta → appendDelta（气泡逐字渲染）+ onDelta 回调（TTS 句级入队，C5）；
 * - meta  → applyMeta（纠错卡片 + 词条建议 chips）；
 * - done  → finishStreaming（真实 message_id 定稿）；
 * - error → 3003 降级保留气泡轻提示；其余失败 → failStreaming（失败态 + 幂等重试）；
 * - 流意外关闭（无定论事件）→ 视为连接中断，同样走失败态。
 *
 * AI 正在输出时禁止重复发送（streaming 锁）。
 *
 * 可取消性（审查报告 H3 第一道防线）：每轮持有一个 AbortController，出现以下任一
 * 情况立即中止在途 SSE，避免"旧会话的 AI 回复被拼到新会话开场白上"：
 * - onEvent 中检测到 currentSession 已变化（切换会话）；
 * - 调用方调用 cancel()（用户点停止）；
 * - 组件卸载。
 *
 * 中止后走 abortStreaming 而非 failStreaming：主动取消不是发送失败，不应展示重试入口。
 * 另用 runId 标识轮次，确保迟到的旧轮回执不会污染新轮状态（防止竞态）。
 * chatStore 的 activeStreamSessionId 归属校验是第二道防线。
 */
import { useCallback, useEffect, useRef } from 'react';
import { streamChat } from '../api/sse';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { notifyInfo } from '../utils/notify';

/** SSE 错误码：LLM 输出解析失败（正文已流式展示且已落库，§4.1） */
const LLM_PARSE_DEGRADED_CODE = 3003;

export interface UseChatOptions {
  /** 每个 delta 到达时回调（供 TTS 句边界检测与入队） */
  onDelta?: (text: string) => void;
  /** 本轮正常定论（done 或 3003 降级）后回调（供 TTS 播完残句） */
  onStreamSettled?: () => void;
  /** 本轮失败或取消后回调（供 TTS 丢弃未播残句） */
  onFailure?: (message: string) => void;
}

export function useChat(options: UseChatOptions = {}) {
  // 回调经 ref 转发，避免调用方因回调身份变化导致 send 重建
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /** 在途流的控制器（同时最多一个） */
  const abortRef = useRef<AbortController | null>(null);
  /** 本轮是否被主动取消（取消 / 切换会话 / 卸载）——抑制失败态 */
  const cancelledRef = useRef(false);
  /** 轮次号：每次 send 自增，用于判定迟到的旧轮回执 */
  const runIdRef = useRef(0);

  /* ---- 卸载：中止在途流，避免卸载后继续写 store ---- */
  useEffect(
    () => () => {
      if (abortRef.current === null) return;
      cancelledRef.current = true;
      abortRef.current.abort();
      abortRef.current = null;
    },
    [],
  );

  const messages = useChatStore((state) => state.messages);
  const streaming = useChatStore((state) => state.streaming);
  const failedContent = useChatStore((state) => state.failedContent);
  const failureMessage = useChatStore((state) => state.failureMessage);

  /** 主动取消本轮输出（无在途流时为空操作） */
  const cancel = useCallback((): void => {
    const controller = abortRef.current;
    if (controller === null) return;
    cancelledRef.current = true;
    abortRef.current = null;
    controller.abort();
  }, []);

  const send = useCallback(async (raw: string): Promise<boolean> => {
    const content = raw.trim();
    if (content.length === 0) return false;

    const sessionId = useSessionStore.getState().currentSession?.id;
    if (sessionId === undefined || sessionId === null) {
      notifyInfo('会话未就绪，请先选择场景');
      return false;
    }

    const chat = useChatStore.getState();
    if (chat.streaming || chat.sending) {
      notifyInfo('AI 正在回复，请稍候');
      return false;
    }

    const runId = runIdRef.current + 1;
    runIdRef.current = runId;
    const isStale = (): boolean => runIdRef.current !== runId;

    const controller = new AbortController();
    abortRef.current = controller;
    cancelledRef.current = false;

    // 传入 sessionId 以启用 store 侧流归属校验（H3 第二道防线）
    chat.beginSend(content, sessionId);

    try {
      await streamChat({ session_id: sessionId, content }, {
        signal: controller.signal,
        onEvent: (event) => {
          // 会话已被切换 → 立刻中止，后续事件一律不再上屏
          if (useSessionStore.getState().currentSession?.id !== sessionId) {
            cancelledRef.current = true;
            controller.abort();
            return;
          }
          if (isStale()) return;

          const store = useChatStore.getState();
          switch (event.event) {
            case 'delta':
              store.appendDelta(event.data.text);
              optionsRef.current.onDelta?.(event.data.text);
              break;
            case 'meta':
              store.applyMeta(event.data.corrections, event.data.vocabulary_suggestions);
              break;
            case 'done':
              store.finishStreaming(event.data.message_id);
              break;
            case 'error': {
              if (event.data.code === LLM_PARSE_DEGRADED_CODE) {
                // 降级：正文已流式展示且已落库 → 不清空气泡，轻提示继续对话
                store.finishDegraded();
                notifyInfo(event.data.message);
              } else {
                store.failStreaming(content, event.data.message);
              }
              break;
            }
            default:
              break;
          }
        },
      });

      // 取消 / 轮次已作废：不写失败态，仅让 TTS 丢弃未播残句
      if (cancelledRef.current || isStale()) {
        if (!isStale()) useChatStore.getState().abortStreaming();
        optionsRef.current.onFailure?.('已取消');
        return false;
      }

      // 流已关闭但未收到任何定论事件 → 连接中断（幂等重发安全）
      const after = useChatStore.getState();
      if (!after.streamSettled) {
        after.failStreaming(content, '连接中断，请重试');
        optionsRef.current.onFailure?.('连接中断，请重试');
        return false;
      }
      if (after.failureMessage !== null) {
        optionsRef.current.onFailure?.(after.failureMessage);
        return false;
      }
      // 正常定论（done / 3003）：TTS 播完残句
      optionsRef.current.onStreamSettled?.();
      return true;
    } catch (err) {
      // 主动取消 / 轮次已作废：静默收尾，不展示失败态与重试入口
      if (cancelledRef.current || isStale() || (err instanceof Error && err.name === 'AbortError')) {
        if (!isStale()) useChatStore.getState().abortStreaming();
        optionsRef.current.onFailure?.('已取消');
        return false;
      }
      const message =
        err instanceof Error && err.message.length > 0 ? err.message : '发送失败，请重试';
      useChatStore.getState().failStreaming(content, message);
      optionsRef.current.onFailure?.(message);
      return false;
    } finally {
      if (!isStale()) abortRef.current = null;
    }
  }, []);

  /** 失败重试：原样重发同 content（后端幂等，不重复插入 user 消息） */
  const retry = useCallback((): void => {
    const content = useChatStore.getState().failedContent;
    if (content !== null && content.length > 0) {
      void send(content);
    }
  }, [send]);

  return { messages, streaming, failedContent, failureMessage, send, retry, cancel };
}
