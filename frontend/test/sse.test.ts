/**
 * sse.ts（POST+SSE 消费器）单元测试。
 *
 * 用 FakeResponse + stubGlobal('fetch') 构造 SSE 字节流，
 * 重点验证「跨 chunk 分帧」：帧边界被任意切断（含多字节 UTF-8 截断）时仍能正确重组。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from '../src/api/sse';
import { ApiError } from '../src/api/client';
import type { ChatSseEvent } from '@shared/types/chat';

const encoder = new TextEncoder();

/** 构造一个「分块推送字符串」的 Response（模拟网络逐包到达） */
function sseResponse(
  chunks: string[],
  opts: { status?: number; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      // 支持中途 abort：以 error 终止流，reader.read() 将 reject AbortError
      if (opts.signal) {
        opts.signal.addEventListener('abort', () => {
          controller.error(new DOMException('Aborted', 'AbortError'));
        });
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: opts.status ?? 200,
    headers: { 'Content-Type': 'text/event-stream', ...(opts.headers ?? {}) },
  });
}

/** JSON 错误响应（开流前业务错误） */
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) =>
      impl(String(input), init),
    ),
  );
}

beforeEach(() => {
  stubFetch(async () => sseResponse(['event: delta\ndata: {"text":"fallback"}\n\n']));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function collect(request: { session_id: string; content: string }, signal?: AbortSignal) {
  const events: ChatSseEvent[] = [];
  await streamChat(request, {
    signal,
    onEvent: (e) => events.push(e),
  });
  return events;
}

describe('sse.ts · 正常流解析', () => {
  it('完整序列 delta* → meta → done 按序派发', async () => {
    const raw = [
      'event: delta\ndata: {"text":"Hello "}\n\n',
      'event: delta\ndata: {"text":"world!"}\n\n',
      'event: meta\ndata: {"corrections":[],"vocabulary_suggestions":[]}\n\n',
      'event: done\ndata: {"message_id":"m-1","session_id":"s-1"}\n\n',
    ].join('');
    stubFetch(async () => sseResponse([raw]));

    const events = await collect({ session_id: 's-1', content: 'hi' });
    expect(events.map((e) => e.event)).toEqual(['delta', 'delta', 'meta', 'done']);
    expect((events[0] as { data: { text: string } }).data.text).toBe('Hello ');
    expect((events[2] as { data: { corrections: unknown[] } }).data.corrections).toEqual([]);
    expect((events[3] as { data: { message_id: string } }).data.message_id).toBe('m-1');
  });

  it('error 事件携带 code 与 message', async () => {
    stubFetch(async () =>
      sseResponse(['event: error\ndata: {"code":3001,"message":"LLM 连接失败"}\n\n']),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      event: 'error',
      data: { code: 3001, message: 'LLM 连接失败' },
    });
  });
});

describe('sse.ts · 跨 chunk 分帧（核心鲁棒性）', () => {
  it('帧边界跨 chunk 切断：事件名与 data 各自被切断仍正确重组', async () => {
    stubFetch(async () =>
      sseResponse([
        'event: del',
        'ta\ndata: {"te',
        'xt":"拼接成功"}',
        '\n\nevent: meta\ndata: {"corrections":[],"vocab_suggestions":[]}\n\n',
        'event: done\ndata: {"message_id":"m-2","session_id":"s"}',
        '\n\n',
      ]),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events.map((e) => e.event)).toEqual(['delta', 'meta', 'done']);
    expect((events[0] as { data: { text: string } }).data.text).toBe('拼接成功');
  });

  it('单帧内 data 在 "data:" 之后被切断（含冒号后空格差异）', async () => {
    stubFetch(async () =>
      sseResponse(['event: delta\ndata:', ' {"text":"跨包"}', '\n\n']),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events[0]).toEqual({ event: 'delta', data: { text: '跨包' } });
  });

  it('多字节 UTF-8（中文 + emoji）在码点中间被切断：TextDecoder 流式重组不乱码', async () => {
    const text = '你好🌍世界';
    const bytes = encoder.encode(`event: delta\ndata: ${JSON.stringify({ text })}\n\n`);
    // 在 emoji（4 字节）中间找切断点：先定位 emoji 起始字节
    const emojiBytes = encoder.encode('🌍');
    const emojiStart = bytes.indexOf(emojiBytes[0]);
    const cut = emojiStart + 2; // 切在码点中间
    stubFetch(async () =>
      sseResponseRaw([bytes.slice(0, cut), bytes.slice(cut)]),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events[0]).toEqual({ event: 'delta', data: { text: '你好🌍世界' } });
  });

  it('逐字节推送（最细粒度分帧）：全部事件完整还原', async () => {
    const raw =
      'event: delta\ndata: {"text":"A"}\n\nevent: meta\ndata: {"corrections":[],"vocabulary_suggestions":[]}\n\nevent: done\ndata: {"message_id":"m","session_id":"s"}\n\n';
    const bytes = encoder.encode(raw);
    const byteChunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) {
      byteChunks.push(bytes.slice(i, i + 1));
    }
    stubFetch(async () => sseResponseRaw(byteChunks));
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events.map((e) => e.event)).toEqual(['delta', 'meta', 'done']);
    expect((events[2] as { data: { message_id: string } }).data.message_id).toBe('m');
  });

  it('多行 data（JSON pretty-print）：以 \\n 连接后解析', async () => {
    stubFetch(async () =>
      sseResponse([
        'event: meta\n',
        'data: {"corrections": [\n',
        'data:  {"original":"a","issue":"grammar","corrected":"b","explanation":"c"}\n',
        'data: ],"vocabulary_suggestions":[]}\n\n',
      ]),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    const meta = events[0] as {
      event: string;
      data: { corrections: Array<{ original: string }> };
    };
    expect(meta.event).toBe('meta');
    expect(meta.data.corrections[0]?.original).toBe('a');
  });

  it('帧尾无 \\n\\n（流直接结束）：兜底派发最后一帧', async () => {
    stubFetch(async () =>
      sseResponse(['event: done\ndata: {"message_id":"last","session_id":"s"}']),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'done', data: { message_id: 'last', session_id: 's' } });
  });

  it('注释行（: heartbeat）与空行被忽略', async () => {
    stubFetch(async () =>
      sseResponse([
        ': heartbeat\n\n',
        'event: delta\ndata: {"text":"keep"}\n\n',
        ': another comment\n\n',
      ]),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'delta', data: { text: 'keep' } });
  });

  it('非法载荷（非 JSON / 缺字段 / 未知事件名）静默丢弃，不影响后续帧', async () => {
    stubFetch(async () =>
      sseResponse([
        'event: delta\ndata: not-json\n\n',
        'event: delta\ndata: {"no_text_field":1}\n\n',
        'event: unknown-event\ndata: {"x":1}\n\n',
        'event: delta\ndata: {"text":"ok"}\n\n',
      ]),
    );
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ event: 'delta', data: { text: 'ok' } });
  });

  it('error 事件缺 code → 兜底 5000；缺 message → 未知错误', async () => {
    stubFetch(async () => sseResponse(['event: error\ndata: {}\n\n']));
    const events = await collect({ session_id: 's', content: 'x' });
    expect(events[0]).toEqual({ event: 'error', data: { code: 5000, message: '未知错误' } });
  });
});

describe('sse.ts · 开流前业务错误（统一 JSON 包裹）', () => {
  it('404 + code 2001 → 抛 ApiError(code=2001, status=404)', async () => {
    stubFetch(async () => jsonResponse(404, { code: 2001, data: null, message: '会话不存在' }));
    await expect(collect({ session_id: 'nope', content: 'x' })).rejects.toMatchObject({
      name: 'ApiError',
      code: 2001,
      status: 404,
      message: '会话不存在',
    });
  });

  it('400 + code 1001 → 抛 ApiError(1001)', async () => {
    stubFetch(async () => jsonResponse(400, { code: 1001, data: null, message: 'content 不能为空' }));
    await expect(collect({ session_id: 's', content: '' })).rejects.toMatchObject({
      code: 1001,
      status: 400,
    });
  });

  it('非 JSON 的 502 响应 → 抛 ApiError（HTTP 状态兜底）', async () => {
    stubFetch(
      async () =>
        new Response('<html>Bad Gateway</html>', {
          status: 502,
          headers: { 'Content-Type': 'text/html' },
        }),
    );
    await expect(collect({ session_id: 's', content: 'x' })).rejects.toBeInstanceOf(ApiError);
  });

  it('响应无 body → 抛 ApiError', async () => {
    stubFetch(
      async () =>
        new Response(null, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );
    await expect(collect({ session_id: 's', content: 'x' })).rejects.toBeInstanceOf(ApiError);
  });

  it('网络失败（fetch 抛错）→ 抛 ApiError(code=-1)', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(collect({ session_id: 's', content: 'x' })).rejects.toMatchObject({
      code: -1,
    });
  });
});

describe('sse.ts · 中止（AbortController）', () => {
  it('abort → 以 AbortError 拒绝（用户取消场景）', async () => {
    const controller = new AbortController();
    stubFetch(async (_input, init) => {
      const signal = (init as { signal?: AbortSignal }).signal;
      // 流挂起不结束，等 abort 触发 error
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode('event: delta\ndata: {"text":"par'));
          signal?.addEventListener('abort', () => {
            c.error(new DOMException('Aborted', 'AbortError'));
          });
        },
      });
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const promise = collect({ session_id: 's', content: 'x' }, controller.signal);
    // 稍等流被消费后触发中止
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
  });
});

/** 直接以字节数组分块的 Response（避免字符串切割破坏多字节字符） */
function sseResponseRaw(byteChunks: Uint8Array[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of byteChunks) {
        controller.enqueue(c);
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}
