/**
 * 对话编排（架构文档 §5.1 时序图，类图 ChatService.sendMessage）
 *
 * 一轮对话闭环：
 *  1. 会话校验（2001）→ 幂等复用/写入用户消息（§4.3 幂等重试）；
 *  2. 读最近 20 条历史 + 实时聚合学习画像（常错 Top5 / 已掌握词 ≤100 / 高频场景）；
 *  3. buildSystemPrompt 组装 → llm.streamChat 流式请求；
 *  4. parser.push 逐 chunk → yield SSE delta（正文直通）；
 *  5. 流结束 parser.flush → 持久化 AI 消息 + 更新画像（纠错统计）+ 会话摘要；
 *  6. yield meta（纠错 + 词条建议）→ yield done（message_id）；
 *  7. META 缺失/解析失败 → 降级纯文本（3003，正文照常、对话不中断）；
 *     LLM 连接失败/超时 → error 事件（3001/3002），用户消息保留在库（幂等重试依据）。
 *
 * 本服务产出 shared ChatSseEvent 事件流，HTTP/SSE 帧写入由 chat.routes 完成（服务与传输解耦）。
 */

import type { ChatSseEvent } from '../../../shared/types/chat';
import { mustGetScene } from '../config/scenes';
import { ApiError, ErrorCode } from '../middleware/error';
import { llmClient, type LlmChatMessage } from './llm.service';
import { StreamParser } from './parser';
import { buildSystemPrompt } from './prompt.service';
import * as profileService from './profile.service';
import * as sessionService from './session.service';

/** 注入 LLM 的历史窗口（≥10 轮，满足 P0-2；开场白计入） */
const HISTORY_WINDOW = 20;

export interface SendMessageOptions {
  /** 客户端断开时中止 LLM 请求 */
  signal?: AbortSignal;
}

/**
 * 发送一轮对话，返回 SSE 事件流（AsyncGenerator）。
 *
 * 调用方逐事件消费并写入 HTTP 响应；内部已捕获全部业务错误并转为 error 事件，
 * 唯一可能向上抛出的是同步参数前置错误（由路由层在开流前规避）。
 */
export async function* sendMessage(
  userId: string,
  sessionId: string,
  content: string,
  opts: SendMessageOptions = {},
): AsyncGenerator<ChatSseEvent, void, void> {
  // 1. 会话校验（不存在 → 2001，路由层开流前已校验一次，此处兜底）
  const session = sessionService.mustGetSession(userId, sessionId);

  // 2. 幂等（§4.3）：该会话最后一条消息为 user 且 content 相同且无后继 assistant
  //    → 复用该用户消息（SSE 中断重试不重复插入）
  const last = sessionService.getLastMessage(sessionId);
  if (!(last && last.role === 'user' && last.content === content)) {
    sessionService.appendMessage(sessionId, 'user', content);
  }

  // 3. 历史窗口（含刚写入的用户消息）+ 画像注入
  const history = sessionService.getRecentMessages(sessionId, HISTORY_WINDOW);
  const scene = mustGetScene(session.scene_id);
  const learnerContext = profileService.getLearnerContext(userId);
  const systemPrompt = buildSystemPrompt(scene, learnerContext);

  const llmMessages: LlmChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history.map((m): LlmChatMessage => ({ role: m.role, content: m.content })),
  ];
  // 防御：确保最后一条是本轮用户消息（异常情况下补齐，避免上下文错位）
  if (llmMessages[llmMessages.length - 1]?.role !== 'user') {
    llmMessages.push({ role: 'user', content });
  }

  // 4. 流式消费：正文直通，META 缓冲
  const parser = new StreamParser();
  try {
    for await (const chunk of llmClient.streamChat(llmMessages, {
      temperature: 0.7,
      maxTokens: 500,
      signal: opts.signal,
    })) {
      if (opts.signal?.aborted) {
        return;
      }
      const out = parser.push(chunk);
      if (out.length > 0) {
        yield { event: 'delta', data: { text: out } };
      }
    }
    if (opts.signal?.aborted) {
      return;
    }

    // 5. 解析收尾 + 持久化（先落库再发事件，保证 done 到达时数据可查）
    const parsed = parser.flush();
    const assistantMessage = sessionService.appendMessage(sessionId, 'assistant', parsed.reply, {
      corrections: parsed.corrections,
      vocabSuggestions: parsed.vocabulary_suggestions,
    });
    if (parsed.corrections.length > 0) {
      profileService.recordCorrections(userId, parsed.corrections);
    }

    // 6a. 降级：协议不合规（无分隔符 / JSON 解析失败）→ 3003，正文已照常流式展示，对话不中断
    if (parsed.degraded) {
      yield {
        event: 'error',
        data: {
          code: ErrorCode.LLM_PARSE,
          message:
            'AI 回复的纠错数据解析失败，已按纯文本展示（不影响对话，可直接继续或重试本句）',
        },
      };
      return;
    }

    // 6b. 正常：meta → done
    yield {
      event: 'meta',
      data: {
        corrections: parsed.corrections,
        vocabulary_suggestions: parsed.vocabulary_suggestions,
      },
    };
    yield {
      event: 'done',
      data: { message_id: assistantMessage.id, session_id: sessionId },
    };
  } catch (err) {
    if (opts.signal?.aborted) {
      return; // 客户端已断开，静默结束
    }
    if (err instanceof ApiError) {
      yield { event: 'error', data: { code: err.code, message: err.message } };
      return;
    }
    console.error('[chat] unexpected error:', err);
    yield {
      event: 'error',
      data: { code: ErrorCode.INTERNAL, message: '服务内部错误，请稍后重试' },
    };
  }
}
