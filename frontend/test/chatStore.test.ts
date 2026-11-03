/**
 * chatStore 单元测试（前端对话状态机，架构文档 §2 stores/chatStore.ts）。
 *
 * 重点：
 * - 幂等镜像判定（§4.3）：beginSend 时尾消息为同 content 的 user 消息 → 复用不重插；
 * - 临时消息生命周期：temp- 前缀 → done 后以真实 message_id 定稿；
 * - 3003 降级保留气泡；失败态（failStreaming）只移除未定论的 assistant 占位。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '../src/stores/chatStore';
import type { Message } from '@shared/types/models';

function state() {
  return useChatStore.getState();
}

beforeEach(() => {
  state().reset();
});

describe('chatStore · beginSend 幂等镜像判定（与后端 §4.3 判定一致）', () => {
  it('全新发送：追加 user 气泡 + assistant 占位', () => {
    state().beginSend('Hello!');
    const s = state();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0].role).toBe('user');
    expect(s.messages[0].content).toBe('Hello!');
    expect(s.messages[1].role).toBe('assistant');
    expect(s.messages[1].content).toBe('');
    expect(s.streaming).toBe(true);
    expect(s.sending).toBe(true);
    expect(s.streamSettled).toBe(false);
    expect(s.failedContent).toBeNull();
  });

  it('失败残留（尾部为同 content 的 user 消息）→ 重试不重复插入 user 气泡', () => {
    state().beginSend('retry me'); // 第一轮
    state().failStreaming('retry me', '连接中断'); // 失败 → 尾部残留 user 消息
    expect(state().messages).toHaveLength(1); // assistant 占位被移除

    state().beginSend('retry me'); // 重试同 content
    const s = state();
    expect(s.messages).toHaveLength(2); // 复用 user + 新 assistant 占位
    const userMessages = s.messages.filter((m) => m.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0].content).toBe('retry me');
  });

  it('失败残留但改发不同 content → 插入新 user 气泡', () => {
    state().beginSend('first');
    state().failStreaming('first', '失败');
    state().beginSend('second');
    const s = state();
    expect(s.messages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
      'first',
      'second',
    ]);
    expect(s.messages).toHaveLength(3);
  });

  it('尾部为 assistant（上轮已定稿）→ 同 content 再发为新轮次，正常插入', () => {
    state().beginSend('again');
    state().finishStreaming('real-id-1');
    state().beginSend('again');
    const s = state();
    expect(s.messages.filter((m) => m.role === 'user')).toHaveLength(2);
  });
});

describe('chatStore · 流式更新', () => {
  it('appendDelta：追加到尾部 assistant 消息', () => {
    state().beginSend('hi');
    state().appendDelta('Hello ');
    state().appendDelta('world!');
    const last = state().messages[state().messages.length - 1];
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('Hello world!');
  });

  it('appendDelta：尾部非 assistant（无占位）→ 不做任何修改', () => {
    const messages: Message[] = [
      { id: 'm1', session_id: 's', user_id: 'default', role: 'user', content: 'x', corrections: [], vocab_suggestions: [], created_at: new Date().toISOString() },
    ];
    state().setMessages(messages);
    state().appendDelta('ignored');
    expect(state().messages).toHaveLength(1);
    expect(state().messages[0].content).toBe('x');
  });

  it('applyMeta：纠错与词条建议挂到尾部 assistant 消息', () => {
    state().beginSend('I very like it');
    state().appendDelta('I really like it too.');
    const corrections = [
      { original: 'I very like', issue: 'collocation' as const, corrected: 'I really like', explanation: 'very 不能修饰动词' },
    ];
    const suggestions = [
      { word: 'rollback', phonetic: '/ˈrəʊlbæk/', definition: '回滚', example: 'We rolled back.' },
    ];
    state().applyMeta(corrections, suggestions);
    const last = state().messages[state().messages.length - 1];
    expect(last.corrections).toEqual(corrections);
    expect(last.vocab_suggestions).toEqual(suggestions);
  });
});

describe('chatStore · 定稿与失败态', () => {
  it('finishStreaming：真实 message_id 替换 temp id，状态复位', () => {
    state().beginSend('hi');
    const tempId = state().messages[state().messages.length - 1].id;
    expect(tempId.startsWith('temp-')).toBe(true);

    state().finishStreaming('real-message-id');
    const s = state();
    expect(s.messages[s.messages.length - 1].id).toBe('real-message-id');
    expect(s.streaming).toBe(false);
    expect(s.sending).toBe(false);
    expect(s.streamSettled).toBe(true);
  });

  it('finishDegraded（3003）：保留气泡与内容，状态复位，不清空正文', () => {
    state().beginSend('hi');
    state().appendDelta('Partial reply shown to user.');
    state().finishDegraded();
    const s = state();
    expect(s.messages[s.messages.length - 1].content).toBe('Partial reply shown to user.');
    expect(s.messages[s.messages.length - 1].id.startsWith('temp-')).toBe(true); // 保留 temp id
    expect(s.streaming).toBe(false);
    expect(s.streamSettled).toBe(true);
    expect(s.failedContent).toBeNull();
  });

  it('failStreaming：移除未定论 assistant 占位，记录失败态供重试', () => {
    state().beginSend('will fail');
    state().appendDelta('partial ');
    state().failStreaming('will fail', '网络错误');
    const s = state();
    expect(s.messages).toHaveLength(1); // 只剩 user
    expect(s.messages[0].content).toBe('will fail');
    expect(s.streaming).toBe(false);
    expect(s.streamSettled).toBe(true);
    expect(s.failedContent).toBe('will fail');
    expect(s.failureMessage).toBe('网络错误');
  });

  it('failStreaming：不影响已定稿消息（真实 id 的 assistant 保留）', () => {
    state().beginSend('round one');
    state().finishStreaming('real-id-1');
    state().beginSend('round two'); // 新占位
    state().failStreaming('round two', '失败');
    const s = state();
    // user(real) + assistant(real-id-1) + user(round two)，round two 的占位被移除
    expect(s.messages).toHaveLength(3);
    expect(s.messages[1].id).toBe('real-id-1');
    expect(s.messages[1].role).toBe('assistant');
  });

  it('failStreaming：3003 降级保留的历史 temp 消息不被移除', () => {
    state().beginSend('degraded round');
    state().appendDelta('kept content');
    state().finishDegraded(); // 降级定论，保留 temp id
    state().beginSend('next round'); // 新占位
    state().failStreaming('next round', '失败');
    const s = state();
    expect(s.messages).toHaveLength(3); // degraded assistant + user + 新 assistant 占位移除 → user(1) + assistant(1) + user(1)
    expect(s.messages[1].content).toBe('kept content');
  });
});

describe('chatStore · 流归属校验（审查报告 H3 第二道防线）', () => {
  /** 会话 B 的开场白（模拟切换会话后 setMessages 载入的内容） */
  const openerB: Message[] = [
    {
      id: 'b-opener',
      session_id: 'session-B',
      user_id: 'default',
      role: 'assistant',
      content: 'Welcome to session B!',
      corrections: [],
      vocab_suggestions: [],
      created_at: new Date().toISOString(),
    },
  ];

  it('beginSend 传入 sessionId → 记录流归属', () => {
    state().beginSend('hi', 'session-A');
    expect(state().activeStreamSessionId).toBe('session-A');
  });

  it('不传 sessionId（遗留调用）→ 不启用归属校验，事件照常生效', () => {
    state().beginSend('hi');
    expect(state().activeStreamSessionId).toBeNull();
    state().appendDelta('text');
    state().applyMeta([], []);
    state().finishStreaming('real-id');
    expect(state().messages[state().messages.length - 1].content).toBe('text');
    expect(state().messages[state().messages.length - 1].id).toBe('real-id');
  });

  it('输出期间切换会话 → 旧流的 delta/meta/done 全部被丢弃', () => {
    state().beginSend('hi', 'session-A');
    state().appendDelta('Welcome to session A');

    // 切换会话：sessionStore.selectSession → setMessages（会清空 activeStreamSessionId）
    state().setMessages(openerB);

    // 旧会话的剩余事件迟到
    state().appendDelta('。以及旧会话的尾巴');
    state().applyMeta(
      [{ original: 'x', issue: 'grammar', corrected: 'y', explanation: 'z' }],
      [{ word: 'rollback', phonetic: '', definition: '回滚', example: '' }],
    );
    state().finishStreaming('old-session-message-id');

    const s = state();
    // 关键回归：新会话开场白未被旧会话输出拼接污染
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].id).toBe('b-opener');
    expect(s.messages[0].content).toBe('Welcome to session B!');
    expect(s.messages[0].corrections).toEqual([]);
    expect(s.messages[0].vocab_suggestions).toEqual([]);
  });

  it('abortStreaming：移除未定论占位并复位，且不进入失败态（主动取消 ≠ 发送失败）', () => {
    state().beginSend('hi', 'session-A');
    state().appendDelta('partial output');
    state().abortStreaming();
    const s = state();
    expect(s.messages).toHaveLength(1); // 只剩 user 气泡
    expect(s.messages[0].content).toBe('hi');
    expect(s.streaming).toBe(false);
    expect(s.sending).toBe(false);
    expect(s.streamSettled).toBe(true);
    expect(s.failedContent).toBeNull(); // 不展示"重试"入口
    expect(s.failureMessage).toBeNull();
    expect(s.activeStreamSessionId).toBeNull();
  });

  it('abortStreaming：会话已切换时为空操作，不误删新会话的消息', () => {
    state().beginSend('hi', 'session-A');
    state().appendDelta('partial');
    state().setMessages(openerB); // 切走
    state().abortStreaming(); // 迟到的取消回执
    const s = state();
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0].id).toBe('b-opener');
  });
});

describe('chatStore · setMessages / reset', () => {
  it('setMessages：整体替换并复位全部标志位', () => {
    state().beginSend('x');
    state().failStreaming('x', 'err');
    const fresh: Message[] = [
      { id: 'a1', session_id: 's', user_id: 'default', role: 'assistant', content: 'opener', corrections: [], vocab_suggestions: [], created_at: new Date().toISOString() },
    ];
    state().setMessages(fresh);
    const s = state();
    expect(s.messages).toEqual(fresh);
    expect(s.streaming).toBe(false);
    expect(s.sending).toBe(false);
    expect(s.streamSettled).toBe(true);
    expect(s.failedContent).toBeNull();
    expect(s.failureMessage).toBeNull();
  });

  it('reset：清空到初始状态', () => {
    state().beginSend('x');
    state().reset();
    expect(state().messages).toEqual([]);
    expect(state().streaming).toBe(false);
    expect(state().failedContent).toBeNull();
  });
});
