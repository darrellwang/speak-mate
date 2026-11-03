/**
 * chat.service 对话编排服务级测试（架构文档 §5.1 时序、§4.3 SSE 契约）。
 *
 * 通过 vi.mock 替换 llm.service 的 llmClient 单例注入「伪 LLM」，
 * 精确控制 LLM 输出以覆盖 API 层难以触发的分支：
 * - 降级：无分隔符 / META 解析失败 → error 3003（正文已流式展示且已落库）；
 * - LLM 连接失败 → error 3001（user 消息保留，构成幂等重试依据）；
 * - 未预期异常 → error 5000；
 * - 正常协议 → delta* → meta → done（message_id 与落库一致）；
 * - 幂等重试复用（§4.3）：失败重发同 content 不重复插入 user 消息；
 * - 客户端断开（AbortSignal）→ 静默结束，不落库 assistant。
 *
 * 会话/消息持久化使用真实 SQLite（setup.ts 分配的临时库）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LlmChatMessage, LlmCallOptions } from '../src/services/llm.service';

/** 伪 LLM 行为注入点（每个用例前重置） */
const fake = vi.hoisted(() => ({
  streamChatImpl: null as null | ((
    messages: LlmChatMessage[],
    opts?: LlmCallOptions,
  ) => AsyncGenerator<string, void, void>),
}));

vi.mock('../src/services/llm.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/services/llm.service')>();
  return {
    ...actual,
    llmClient: {
      provider: 'fake',
      model: 'fake-model',
      streamChat: (messages: LlmChatMessage[], opts?: LlmCallOptions) => {
        if (fake.streamChatImpl === null) {
          throw new Error('测试未注入 streamChatImpl');
        }
        return fake.streamChatImpl(messages, opts);
      },
      completeText: async () => {
        throw new Error('本测试文件不应调用 completeText');
      },
      completeJSON: async () => {
        throw new Error('本测试文件不应调用 completeJSON');
      },
    },
  };
});

import { sendMessage } from '../src/services/chat.service';
import { appendMessage, createSession, getRecentMessages, countMessages } from '../src/services/session.service';
import { ApiError, ErrorCode } from '../src/middleware/error';
import type { ChatSseEvent } from '../../shared/types/chat';
import { collectAsyncIterator } from './helpers/server';

/** 造一个固定输出的伪流式 LLM */
function fakeStream(chunks: string[]): void {
  fake.streamChatImpl = async function* () {
    for (const c of chunks) {
      yield c;
    }
  };
}

const VALID_META =
  '{"corrections":[{"original":"I very like it","issue":"collocation","corrected":"I really like it","explanation":"very 不能修饰动词"}],"vocabulary_suggestions":[{"word":"rollback","phonetic":"/ˈrəʊlbæk/","definition":"回滚","example":"We performed a rollback."}]}';

beforeEach(() => {
  fake.streamChatImpl = null;
});

describe('chat.service · 正常协议', () => {
  it('delta* → meta → done 事件序列，message_id 与落库消息一致', async () => {
    fakeStream(['Hello! ', 'How ', 'are ', 'you?\n<<<META>>>\n', VALID_META]);
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(
      sendMessage('default', session.id, 'Hi, I am fine.'),
    );

    const seq = events.map((e) => e.event);
    expect(seq[0]).toBe('delta');
    expect(seq.filter((e) => e === 'delta').length).toBeGreaterThanOrEqual(1);
    expect(seq.indexOf('delta')).toBeLessThan(seq.indexOf('meta'));
    expect(seq.indexOf('meta')).toBeLessThan(seq.indexOf('done'));
    expect(seq[seq.length - 1]).toBe('done');

    const done = events.find((e) => e.event === 'done');
    expect(done).toBeDefined();
    if (done?.event !== 'done') return;

    const messages = getRecentMessages(session.id, 50);
    const assistant = messages[messages.length - 1];
    expect(assistant?.id).toBe(done.data.message_id);
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Hello! How are you?');
    expect(assistant?.corrections).toHaveLength(1);
    expect(assistant?.corrections[0]?.corrected).toBe('I really like it');
    expect(assistant?.vocab_suggestions).toHaveLength(1);
  });

  it('delta 拼接 === assistant 落库正文（流式与持久化一致）', async () => {
    fakeStream(['Aaa ', 'Bbb. ', 'Ccc!\n<<<META>>>\n', '{"corrections":[],"vocabulary_suggestions":[]}']);
    const { session } = await createSession('default', 'code-review', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'ok'));
    const joined = events
      .filter((e): e is Extract<ChatSseEvent, { event: 'delta' }> => e.event === 'delta')
      .map((e) => e.data.text)
      .join('');
    const messages = getRecentMessages(session.id, 50);
    expect(messages[messages.length - 1]?.content).toBe(joined);
  });

  it('会话不存在 → 同步抛出 2001（路由层开流前处理）', async () => {
    fakeStream([]);
    await expect(
      collectAsyncIterator(sendMessage('default', 'no-such-session', 'hi')),
    ).rejects.toMatchObject({ code: ErrorCode.SESSION_NOT_FOUND });
  });

  it('历史窗口注入（P0-2）：system + 最近 20 条消息，末位为本轮 user；场景与画像注入 system prompt（P0-8）', async () => {
    let captured: LlmChatMessage[] = [];
    fake.streamChatImpl = async function* (messages) {
      captured = messages;
      yield 'Reply.\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}';
    };
    const { session } = await createSession('default', 'daily-standup', false);
    // 灌 25 条历史（opener 之外），使总消息数超过 20 条窗口
    for (let i = 0; i < 25; i++) {
      appendMessage(session.id, i % 2 === 0 ? 'user' : 'assistant', `history message ${i}`);
    }
    await collectAsyncIterator(sendMessage('default', session.id, 'the newest turn'));

    // 窗口：system(1) + 最近 20 条
    expect(captured).toHaveLength(21);
    expect(captured[0]?.role).toBe('system');
    // system prompt 含应用人设 + 当前场景 + 纠错策略（画像注入入口）
    expect(captured[0]?.content).toContain('SpeakMate');
    expect(captured[0]?.content).toContain('Daily Standup');
    expect(captured[0]?.content).toContain('Correction Policy');
    // 末位为本轮 user 消息（上下文不丢失）
    const last = captured[captured.length - 1];
    expect(last?.role).toBe('user');
    expect(last?.content).toBe('the newest turn');
    // 窗口裁剪：最早的 history message 0 不在窗口内
    expect(captured.some((m) => m.content === 'history message 0')).toBe(false);
    expect(captured.some((m) => m.content === 'history message 6')).toBe(true);
  });
});

describe('chat.service · 协议不合规降级（3003，正文照常展示且已落库）', () => {
  it('LLM 未输出分隔符 → delta* → error 3003，无 meta/done，assistant 已落库', async () => {
    fakeStream(['Sorry, ', 'I forgot ', 'the protocol.']);
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'hello'));

    const seq = events.map((e) => e.event);
    expect(seq).toContain('delta');
    expect(seq).not.toContain('meta');
    expect(seq).not.toContain('done');

    const error = events.find((e) => e.event === 'error');
    expect(error).toBeDefined();
    if (error?.event !== 'error') return;
    expect(error.data.code).toBe(ErrorCode.LLM_PARSE); // 3003
    expect(error.data.message.length).toBeGreaterThan(0);

    // 降级但正文已落库（P0：对话不中断）
    const messages = getRecentMessages(session.id, 50);
    const assistant = messages[messages.length - 1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.content).toBe('Sorry, I forgot the protocol.');
    expect(assistant?.corrections).toEqual([]);
  });

  it('META 段解析失败（纯文本）→ error 3003，正文照常', async () => {
    fakeStream(['Reply body.\n<<<META>>>\n', 'garbage not json']);
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'hello'));
    const error = events.find((e) => e.event === 'error');
    expect(error?.event === 'error' ? error.data.code : undefined).toBe(ErrorCode.LLM_PARSE);
    const messages = getRecentMessages(session.id, 50);
    expect(messages[messages.length - 1]?.content).toBe('Reply body.');
  });
});

describe('chat.service · LLM 失败路径（error 事件，user 消息保留）', () => {
  it('LLM 连接失败（ApiError 3001）→ error 事件，user 消息已落库、无 assistant', async () => {
    fake.streamChatImpl = async function* () {
      throw new ApiError(502, ErrorCode.LLM_CONNECT, 'LLM 连接失败');
      yield ''; // eslint 不可达，仅为生成器签名
    };
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'my message'));
    const error = events.find((e) => e.event === 'error');
    expect(error?.event === 'error' ? error.data.code : undefined).toBe(ErrorCode.LLM_CONNECT);
    expect(error?.event === 'error' ? error.data.message : '').toContain('LLM 连接失败');

    const messages = getRecentMessages(session.id, 50);
    expect(messages[messages.length - 1]?.role).toBe('user');
    expect(messages[messages.length - 1]?.content).toBe('my message');
    expect(countMessages(session.id)).toBe(2); // opener + user
  });

  it('未预期异常 → error 5000，对话流不崩溃', async () => {
    fake.streamChatImpl = async function* () {
      yield 'partial ';
      throw new Error('unexpected boom');
    };
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'hi'));
    const error = events.find((e) => e.event === 'error');
    expect(error?.event === 'error' ? error.data.code : undefined).toBe(ErrorCode.INTERNAL);
  });

  it('LLM 首字超时（ApiError 3002）→ error 3002', async () => {
    fake.streamChatImpl = async function* () {
      throw new ApiError(504, ErrorCode.LLM_TIMEOUT, 'LLM 响应超时');
      yield '';
    };
    const { session } = await createSession('default', 'daily-standup', false);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'hi'));
    const error = events.find((e) => e.event === 'error');
    expect(error?.event === 'error' ? error.data.code : undefined).toBe(ErrorCode.LLM_TIMEOUT);
  });
});

describe('chat.service · 幂等重试复用（§4.3）', () => {
  it('失败后重发同 content → user 消息复用不重插，最终仅 1 条该 user 消息', async () => {
    // 第一轮：连接失败
    fake.streamChatImpl = async function* () {
      throw new ApiError(502, ErrorCode.LLM_CONNECT, 'LLM 连接失败');
      yield '';
    };
    const { session } = await createSession('default', 'incident-retro', false);
    await collectAsyncIterator(sendMessage('default', session.id, 'please retry me'));
    expect(countMessages(session.id)).toBe(2);

    // 第二轮：重发相同 content（LLM 恢复）
    fakeStream(['Recovered reply.\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}']);
    const events = await collectAsyncIterator(sendMessage('default', session.id, 'please retry me'));
    expect(events.some((e) => e.event === 'done')).toBe(true);

    const messages = getRecentMessages(session.id, 50);
    const userMessages = messages.filter((m) => m.role === 'user' && m.content === 'please retry me');
    expect(userMessages).toHaveLength(1); // 不重插
    expect(countMessages(session.id)).toBe(3); // opener + user + assistant
  });

  it('失败后改发不同 content → 正常插入新 user 消息', async () => {
    fake.streamChatImpl = async function* () {
      throw new ApiError(502, ErrorCode.LLM_CONNECT, 'LLM 连接失败');
      yield '';
    };
    const { session } = await createSession('default', 'incident-retro', false);
    await collectAsyncIterator(sendMessage('default', session.id, 'first attempt'));

    fakeStream(['Different turn.\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}']);
    await collectAsyncIterator(sendMessage('default', session.id, 'second attempt'));

    const messages = getRecentMessages(session.id, 50);
    const userContents = messages.filter((m) => m.role === 'user').map((m) => m.content);
    expect(userContents).toEqual(['first attempt', 'second attempt']);
  });

  it('上轮已成功（尾部为 assistant）→ 同 content 再发视为新的一轮，正常插入', async () => {
    fakeStream(['Round one.\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}']);
    const { session } = await createSession('default', 'incident-retro', false);
    await collectAsyncIterator(sendMessage('default', session.id, 'again'));

    fakeStream(['Round two.\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}']);
    await collectAsyncIterator(sendMessage('default', session.id, 'again'));

    const messages = getRecentMessages(session.id, 50);
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });
});

describe('chat.service · 客户端断开（AbortSignal）', () => {
  it('流中途断开 → 静默结束，不落库 assistant，无 error 事件', async () => {
    fake.streamChatImpl = async function* (_messages, opts) {
      yield 'first ';
      await new Promise((r) => setTimeout(r, 30));
      if (opts?.signal?.aborted) return; // 模拟 mock provider 的 abort 感知
      yield 'second part\n<<<META>>>\n{"corrections":[],"vocabulary_suggestions":[]}';
    };
    const { session } = await createSession('default', 'daily-standup', false);
    const controller = new AbortController();

    const collected: ChatSseEvent[] = [];
    const iter = sendMessage('default', session.id, 'abort me', { signal: controller.signal });
    for await (const evt of iter) {
      collected.push(evt);
      if (collected.some((e) => e.event === 'delta')) {
        controller.abort(); // 收到首个 delta 后立即断开
      }
    }
    expect(collected.some((e) => e.event === 'delta')).toBe(true);
    expect(collected.some((e) => e.event === 'error')).toBe(false);
    expect(collected.some((e) => e.event === 'done')).toBe(false);

    // assistant 未落库，user 消息保留（可幂等重试）
    const messages = getRecentMessages(session.id, 50);
    expect(messages[messages.length - 1]?.role).toBe('user');
    expect(countMessages(session.id)).toBe(2);
  });
});
