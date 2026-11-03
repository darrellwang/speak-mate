/**
 * 会话/消息写入的事务一致性测试（审查报告 M2 / M6）。
 *
 * - M2：appendMessage 的「写消息 + 更新会话冗余字段」必须在同一事务内；
 * - M6：createSession 必须「先备好开场白，再一次性落库」，不留无消息的僵尸会话。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from '../src/db/database';
import {
  appendMessage,
  countMessages,
  createSession,
  recentSceneIds,
} from '../src/services/session.service';

const USER = 'default';

/** 库中消息数为 0 的会话数量（僵尸会话检测） */
function zombieSessionCount(): number {
  return (
    getDb().prepare('SELECT COUNT(*) AS c FROM sessions WHERE message_count = 0').get() as {
      c: number;
    }
  ).c;
}

/** 某会话在 sessions 表里的冗余计数 */
function storedMessageCount(sessionId: string): number {
  return (
    getDb().prepare('SELECT message_count FROM sessions WHERE id = ?').get(sessionId) as {
      message_count: number;
    }
  ).message_count;
}

beforeEach(() => {
  // 每个用例从干净库开始（表结构由迁移建立，仅清数据）
  const db = getDb();
  db.exec('DELETE FROM messages; DELETE FROM sessions;');
});

describe('createSession · 会话与开场白的原子写入（M6）', () => {
  it('新建会话：返回体与库中冗余计数一致（开场白随会话同时落库）', async () => {
    const { session, messages } = await createSession(USER, 'daily-standup', false);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
    expect(session.message_count).toBe(1);
    expect(storedMessageCount(session.id)).toBe(1);
    expect(countMessages(session.id)).toBe(1);
  });

  it('延续模式无历史会话 → 降级静态开场白，同样不产生空会话', async () => {
    const { session, messages } = await createSession(USER, 'incident-retro', true);
    expect(messages).toHaveLength(1);
    expect(messages[0].content.length).toBeGreaterThan(0);
    expect(storedMessageCount(session.id)).toBe(1);
  });

  it('不留下任何 0 消息的僵尸会话', async () => {
    await createSession(USER, 'daily-standup', false);
    await createSession(USER, 'incident-retro', true);
    await createSession(USER, 'daily-standup', true);
    expect(zombieSessionCount()).toBe(0);
  });
});

describe('appendMessage · 消息与冗余字段的事物一致性（M2）', () => {
  it('连续追加后：sessions.message_count 与真实消息数始终一致', async () => {
    const { session } = await createSession(USER, 'daily-standup', false);
    appendMessage(session.id, 'user', 'Yesterday I fixed the CI pipeline.');
    appendMessage(session.id, 'assistant', 'Nice — what was the root cause?');
    appendMessage(session.id, 'user', 'A flaky test in the deploy step.');

    expect(countMessages(session.id)).toBe(4); // 开场白 + 3 条
    expect(storedMessageCount(session.id)).toBe(4);
  });

  it('首条 user 消息 → 生成 title（截断 50）与 summary（场景名前缀）', async () => {
    const { session } = await createSession(USER, 'daily-standup', false);
    const long = 'Yesterday I migrated the build agents to the new Kubernetes cluster and it worked.';
    appendMessage(session.id, 'user', long);

    const row = getDb()
      .prepare('SELECT title, summary FROM sessions WHERE id = ?')
      .get(session.id) as { title: string; summary: string };
    expect(row.title).toBe(long.slice(0, 50));
    expect(row.summary.startsWith('Daily Standup')).toBe(true);
  });

  it('assistant 消息不覆盖已生成的 title/summary', async () => {
    const { session } = await createSession(USER, 'daily-standup', false);
    appendMessage(session.id, 'user', 'Blocked on the DB migration.');
    const before = getDb()
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(session.id) as { title: string };

    appendMessage(session.id, 'assistant', 'Got it, what is blocking?');
    const after = getDb()
      .prepare('SELECT title FROM sessions WHERE id = ?')
      .get(session.id) as { title: string };
    expect(after.title).toBe(before.title);
  });

  it('会话不存在 → 抛错且不写入任何消息（事务回滚）', async () => {
    const before = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(() => appendMessage('no-such-session', 'user', 'orphan')).toThrow();
    const after = (getDb().prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;
    expect(after).toBe(before);
  });
});

describe('recentSceneIds · 路由层下沉后的服务函数（M5）', () => {
  it('按各场景最近使用时间倒序返回场景 id', async () => {
    await createSession(USER, 'daily-standup', false);
    await createSession(USER, 'incident-retro', false);
    await createSession(USER, 'daily-standup', false); // 再次使用 → 排到最前

    const ids = recentSceneIds(USER, 5);
    expect(ids[0]).toBe('daily-standup');
    expect(new Set(ids)).toEqual(new Set(['daily-standup', 'incident-retro']));
  });

  it('无会话 → 空数组', () => {
    expect(recentSceneIds(USER, 5)).toEqual([]);
  });
});
