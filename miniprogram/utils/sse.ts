/**
 * 对话发送：流式优先 + 非流式兜底（utils/sse.ts）
 *
 * 小程序里没有 EventSource，也没有 fetch 流，唯一能读到增量响应的是
 * `wx.request({ enableChunked: true })` 的 `onChunkReceived`（要求基础库 ≥ 2.20.0）。
 * 但这条路有两个现实风险：
 *   1. 真机上分块到达时机受网关缓冲影响，可能被缓存到响应结束才一次性吐出；
 *   2. 部分安卓机型的分块回调存在丢帧。
 *
 * 因此本模块采用**双通道**：
 *   - 支持分块 → 走 SSE 流，逐字渲染；
 *   - 首块超时 / 流中途断掉没收到 done → 自动改用 POST /api/chat/sync 一次性拿全量。
 * 兜底之所以安全：后端 sendMessage 做了幂等（最后一条 user 消息相同则复用），
 * 重试不会产生两条用户消息，也不会二次计费两次完整生成（只是一次重新生成，语义上等同重试）。
 */

import { STREAM_FIRST_CHUNK_TIMEOUT } from '../config';
import type { ChatRequest, ChatSyncData } from '../types/api';
import type { Correction, VocabSuggestion } from '../types/chat';
import { ensureLogin } from './auth';
import { ApiError, buildHeaders, buildUrl, http } from './request';
import { getSettings } from './storage';
import { Utf8StreamDecoder } from './utf8';

/** onChunkReceived 所需的最低基础库版本 */
const MIN_CHUNKED_VERSION = '2.20.0';

export interface ChatHandlers {
  /** 增量文本（流式）；非流式兜底时一次性回调全文 */
  onDelta(text: string): void;
  /** 纠错 + 词条建议（对应 SSE meta 事件） */
  onMeta(corrections: Correction[], suggestions: VocabSuggestion[]): void;
  /** 完成（message_id 可能在降级场景下为空串） */
  onDone(messageId: string, sessionId: string): void;
}

export interface ChatTask {
  /** 中止（用户退出页面 / 主动取消） */
  abort(): void;
}

/** 版本比较：a >= b 返回 1，相等 0，小于 -1 */
function compareVersion(a: string, b: string): number {
  const left = a.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const right = b.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** 当前环境是否支持分块接收（基础库版本 + 用户设置双重判断） */
export function isChunkedSupported(): boolean {
  if (!getSettings().streamingEnabled) return false;
  try {
    const info = wx.getSystemInfoSync() as { SDKVersion?: string };
    const version = info.SDKVersion ?? '';
    return version !== '' && compareVersion(version, MIN_CHUNKED_VERSION) >= 0;
  } catch {
    return false;
  }
}

/* ---------- SSE 帧解析（与 H5 端 api/sse.ts 同一套规则） ---------- */

interface SseFrame {
  event: string;
  data: string;
}

function parseFrame(raw: string): SseFrame | null {
  let event = '';
  const dataLines: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim();
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).trimStart());
    }
  }
  if (event === '' || dataLines.length === 0) return null;
  return { event, data: dataLines.join('\n') };
}

/** 把一帧文本分派给业务回调；返回是否收到了终止事件（done / error） */
function dispatchFrame(raw: string, handlers: ChatHandlers, ctx: StreamContext): void {
  const frame = parseFrame(raw);
  if (frame === null) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.data);
  } catch {
    return;
  }
  if (parsed === null || typeof parsed !== 'object') return;
  const obj = parsed as Record<string, unknown>;

  switch (frame.event) {
    case 'delta': {
      if (typeof obj.text === 'string') handlers.onDelta(obj.text);
      break;
    }
    case 'meta': {
      ctx.receivedMeta = true;
      handlers.onMeta(
        Array.isArray(obj.corrections) ? (obj.corrections as Correction[]) : [],
        Array.isArray(obj.vocabulary_suggestions)
          ? (obj.vocabulary_suggestions as VocabSuggestion[])
          : [],
      );
      break;
    }
    case 'done': {
      ctx.receivedDone = true;
      handlers.onDone(
        typeof obj.message_id === 'string' ? obj.message_id : '',
        typeof obj.session_id === 'string' ? obj.session_id : '',
      );
      break;
    }
    case 'error': {
      ctx.receivedError = {
        code: typeof obj.code === 'number' ? obj.code : 5000,
        message: typeof obj.message === 'string' ? obj.message : '未知错误',
      };
      break;
    }
    default:
      break;
  }
}

interface StreamContext {
  receivedMeta: boolean;
  receivedDone: boolean;
  receivedError: { code: number; message: string } | null;
  /** 首块是否已到达（用于判定网关缓冲） */
  receivedChunk: boolean;
  /** 已主动请求降级（abort 后不再当作失败处理） */
  fallback: boolean;
  aborted: boolean;
}

/**
 * 发送一轮对话。
 *
 * 约定：无论走哪条通道，回调时序一致（delta* → meta? → done），
 * 业务层（pages/chat）无需关心底层是流式还是一次性返回。
 * 异常通过返回的 Promise reject 抛出（调用方自行 try/catch）。
 */
export function sendChat(payload: ChatRequest, handlers: ChatHandlers): ChatTask & {
  promise: Promise<void>;
} {
  const ctx: StreamContext = {
    receivedMeta: false,
    receivedDone: false,
    receivedError: null,
    receivedChunk: false,
    fallback: false,
    aborted: false,
  };

  if (!isChunkedSupported()) {
    return wrap(syncChat(payload, handlers));
  }

  const decoder = new Utf8StreamDecoder();
  let buffer = '';
  let task: WechatMiniprogram.RequestTask | null = null;
  let firstChunkTimer: ReturnType<typeof setTimeout> | null = null;

  /** 从缓冲区取出完整 SSE 帧并分派（帧边界为 \n\n） */
  const drain = (): void => {
    let index = buffer.indexOf('\n\n');
    while (index >= 0) {
      const rawFrame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      dispatchFrame(rawFrame, handlers, ctx);
      index = buffer.indexOf('\n\n');
    }
  };

  const promise = new Promise<void>((resolve, reject) => {
    const finish = (): void => {
      if (firstChunkTimer !== null) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
      if (ctx.receivedError !== null) {
        // 3003（协议降级）由业务层当作「正文可用」处理，此处只透出其余错误
        reject(new ApiError(ctx.receivedError.message, ctx.receivedError.code, 200));
        return;
      }
      resolve();
    };

    const fallbackToSync = (): void => {
      if (ctx.aborted || ctx.receivedDone) return;
      ctx.fallback = true;
      if (firstChunkTimer !== null) {
        clearTimeout(firstChunkTimer);
        firstChunkTimer = null;
      }
      task?.abort();
      syncChat(payload, handlers).then(resolve, reject);
    };

    // 流式请求同样需要登录态：先确保已登录再发起
    ensureLogin()
      .then((token) => {
        task = wx.request({
          url: buildUrl('/api/chat'),
          method: 'POST',
          data: payload as never,
          header: buildHeaders(true, token),
          responseType: 'arraybuffer',
          enableChunked: true,
          timeout: 0, // 流式请求交给首块超时自行兜底，不用 wx 的总超时
          success: (res) => {
            // 分块回调在部分机型上可能整体缺席：此时 success 的 data 就是完整响应体
            if (!ctx.receivedChunk && res.data instanceof ArrayBuffer) {
              buffer += decoder.push(new Uint8Array(res.data));
              drain();
            }
            if (ctx.receivedDone || ctx.receivedError !== null) {
              finish();
              return;
            }
            // 流结束却没收到 done：多半被网关缓冲成了一次性响应但解包失败 → 兜底
            fallbackToSync();
          },
          fail: (err) => {
            if (ctx.fallback || ctx.aborted) return;
            const message = /abort/i.test(err.errMsg ?? '')
              ? '请求已取消'
              : '网络连接失败，请检查后端服务';
            reject(new ApiError(message, -1, 0));
          },
        });

        task.onChunkReceived?.((res) => {
          ctx.receivedChunk = true;
          if (firstChunkTimer !== null) {
            clearTimeout(firstChunkTimer);
            firstChunkTimer = null;
          }
          buffer += decoder.push(new Uint8Array(res.data));
          drain();
        });

        // 首块迟迟不来 → 判定网关缓冲/不支持，直接降级，不让用户干等
        firstChunkTimer = setTimeout(() => {
          if (!ctx.receivedChunk && !ctx.receivedDone) {
            fallbackToSync();
          }
        }, STREAM_FIRST_CHUNK_TIMEOUT);
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '登录失败，请稍后重试';
        reject(new ApiError(message, -1, 0));
      });
  });

  return {
    promise,
    abort(): void {
      ctx.aborted = true;
      task?.abort();
    },
  };
}

/** 一次性通道：POST /api/chat/sync（后端聚合 SSE 事件后的等价接口） */
export async function syncChat(payload: ChatRequest, handlers: ChatHandlers): Promise<void> {
  const data = await http.post<ChatSyncData>(
    '/api/chat/sync',
    payload,
    { silent: true, timeout: 60000 },
  );
  if (data.content !== '') {
    handlers.onDelta(data.content);
  }
  handlers.onMeta(data.corrections ?? [], data.vocabulary_suggestions ?? []);
  handlers.onDone(data.message_id ?? '', data.session_id ?? payload.session_id);
}

/** 无流式需求时的简单包装（统一返回结构体） */
function wrap(promise: Promise<void>): ChatTask & { promise: Promise<void> } {
  return { promise, abort(): void {} };
}
