/**
 * POST + SSE 消费器（架构文档 §2 api/sse.ts、§4.3 SSE 事件契约）。
 *
 * 浏览器 EventSource 仅支持 GET，因此用 fetch POST + ReadableStream 手动消费：
 * - 按 `\n\n` 分帧，每帧解析 `event: <name>\ndata: <json>`（data 可跨多行，以 \n 连接）；
 * - 事件以 ChatSseEvent 判别联合分派（delta / meta / done / error），非法帧静默丢弃；
 * - 开流前的业务错误（1001/2001 等）走统一 JSON 包裹 → 抛 ApiError；
 * - AbortController 中止（取消/重试场景）由调用方传入 signal；
 * - 正常时序 delta*→meta→done；失败 delta*?→error（发送后流关闭）。
 */
import type { ChatRequest } from '@shared/types/api';
import type { ChatSseEvent, Correction, VocabSuggestion } from '@shared/types/chat';
import { ApiError, UNAUTHORIZED_HINT } from './client';
import { withAuthHeaders } from './token';

export interface ChatStreamOptions {
  /** 中止信号（切换会话/用户取消时透传给 fetch） */
  signal?: AbortSignal;
  /** 每个已解析 SSE 事件的回调 */
  onEvent: (event: ChatSseEvent) => void;
}

interface SseFrame {
  event: string;
  data: string;
}

/** 解析单帧原始文本 → {event, data}；无事件名或无 data 返回 null */
function parseFrame(raw: string): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue; // 空行 / 注释行
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (event === '' || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 帧 → ChatSseEvent 判别联合（载荷字段宽松校验，异常降级为 null 丢弃） */
function toChatEvent(frame: SseFrame): ChatSseEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  switch (frame.event) {
    case 'delta':
      return typeof obj.text === 'string' ? { event: 'delta', data: { text: obj.text } } : null;
    case 'meta':
      return {
        event: 'meta',
        data: {
          corrections: Array.isArray(obj.corrections) ? (obj.corrections as Correction[]) : [],
          vocabulary_suggestions: Array.isArray(obj.vocabulary_suggestions)
            ? (obj.vocabulary_suggestions as VocabSuggestion[])
            : [],
        },
      };
    case 'done':
      return typeof obj.message_id === 'string'
        ? {
            event: 'done',
            data: {
              message_id: obj.message_id,
              session_id: typeof obj.session_id === 'string' ? obj.session_id : '',
            },
          }
        : null;
    case 'error':
      return {
        event: 'error',
        data: {
          code: typeof obj.code === 'number' ? obj.code : 5000,
          message: typeof obj.message === 'string' ? obj.message : '未知错误',
        },
      };
    default:
      return null;
  }
}

/**
 * 消费一轮 POST /api/chat SSE 流。
 *
 * resolve 于流正常关闭（无论 done 还是 error 事件——定论交由调用方检查 store 状态）；
 * reject 于：网络失败 / 开流前业务错误（ApiError）/ AbortError。
 */
export async function streamChat(request: ChatRequest, options: ChatStreamOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: withAuthHeaders({
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      }),
      body: JSON.stringify(request),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new ApiError('网络连接失败，消息未送达', -1, 0);
  }

  // 开流前的业务错误（参数校验 1001 / 会话不存在 2001）：统一 JSON 包裹
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok || contentType.includes('application/json')) {
    let message =
    response.status === 401 ? UNAUTHORIZED_HINT : `请求失败（HTTP ${response.status}）`;
    let code = response.status;
    try {
      const payload = (await response.json()) as { code?: number; message?: string };
      if (payload && typeof payload.message === 'string' && response.status !== 401) {
        message = payload.message;
        code = typeof payload.code === 'number' ? payload.code : response.status;
      }
    } catch {
      // 保持默认错误信息
    }
    throw new ApiError(message, code, response.status);
  }

  if (!response.body) {
    throw new ApiError('响应无内容流', -1, response.status);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  const dispatchFrame = (raw: string): void => {
    const frame = parseFrame(raw);
    if (frame === null) return;
    const event = toChatEvent(frame);
    if (event !== null) options.onEvent(event);
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let separatorIndex = buffer.indexOf('\n\n');
    while (separatorIndex >= 0) {
      const rawFrame = buffer.slice(0, separatorIndex);
      buffer = buffer.slice(separatorIndex + 2);
      dispatchFrame(rawFrame);
      separatorIndex = buffer.indexOf('\n\n');
    }
  }
  // 兜底：最后一帧可能无结尾空行
  buffer += decoder.decode();
  if (buffer.trim().length > 0) dispatchFrame(buffer);
}
