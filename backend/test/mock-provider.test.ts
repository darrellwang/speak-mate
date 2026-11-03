/**
 * MockLlmClient 单元测试（LLM_PROVIDER=mock 的内置规则，供前端联调与冒烟测试）。
 *
 * 覆盖：
 * - 纠错规则触发：典型中式英语输入必出纠错（"I very like" / "discuss about" / 过去式 /
 *   三单 / years of experience / open the light / more better / I'm agree / borrow me）；
 * - 干净输入不硬纠（corrections = []）；
 * - 每轮纠错上限 2 条；
 * - streamChat 输出严格遵循协议（正文 + <<<META>>> + 单行 JSON），且可被 StreamParser 还原；
 * - completeText 两条路径：词条生成（define）与延续开场白（opener）；
 * - 词条建议 0–2 条且四要素齐全。
 */
import { describe, expect, it } from 'vitest';
import { MockLlmClient } from '../src/services/mock.provider';
import { StreamParser } from '../src/services/parser';
import { buildContinueOpenerPrompt, buildDefineWordPrompt } from '../src/services/prompt.service';
import type { LlmChatMessage } from '../src/services/llm.service';
import type { Message } from '../../shared/types/models';

const client = new MockLlmClient();

function userTurn(content: string): LlmChatMessage[] {
  return [
    { role: 'system', content: 'system prompt' },
    { role: 'assistant', content: 'opener' },
    { role: 'user', content },
  ];
}

/** 消费一轮 mock 流式输出并用 StreamParser 还原为结构化单轮结果 */
async function mockTurn(content: string): Promise<{ reply: string; corrections: ReturnType<StreamParser['flush']>['corrections']; suggestions: ReturnType<StreamParser['flush']>['vocabulary_suggestions'] }> {
  const parser = new StreamParser();
  for await (const chunk of client.streamChat(userTurn(content))) {
    parser.push(chunk);
  }
  const parsed = parser.flush();
  return {
    reply: parsed.reply,
    corrections: parsed.corrections,
    suggestions: parsed.vocabulary_suggestions,
  };
}

describe('MockLlmClient · 纠错规则触发（典型中式英语必出纠错）', () => {
  it('"I very like this tool" → collocation 纠错 I really like', async () => {
    const { corrections } = await mockTurn('I very like this tool, it saves me a lot of time.');
    expect(corrections.length).toBeGreaterThanOrEqual(1);
    const c = corrections.find((x) => /very/.test(x.original));
    expect(c).toMatchObject({
      original: 'I very like',
      issue: 'collocation',
      corrected: 'I really like',
    });
    expect(c?.explanation.length).toBeGreaterThan(0);
  });

  it('"discuss about the incident" → word-choice 纠错 discuss', async () => {
    const { corrections } = await mockTurn('We need to discuss about the incident in the meeting.');
    const c = corrections.find((x) => x.original === 'discuss about');
    expect(c).toMatchObject({ issue: 'word-choice', corrected: 'discuss' });
  });

  it('"Yesterday I deploy the service" → grammar 过去式纠错', async () => {
    const { corrections } = await mockTurn('Yesterday I deploy the payment service twice.');
    const c = corrections.find((x) => x.original === 'Yesterday I deploy');
    expect(c).toMatchObject({ issue: 'grammar', corrected: 'yesterday I deployed' });
  });

  it('"he like pizza" → 三单纠错 he likes', async () => {
    const { corrections } = await mockTurn('My teammate he like pizza very much.');
    // 注：规则为 (he|she) + 动词原形；"he like" 命中
    const c = corrections.find((x) => x.corrected === 'he likes');
    expect(c?.issue).toBe('grammar');
  });

  it('"three years experience" → years of experience 纠错', async () => {
    const { corrections } = await mockTurn('I have three years experience in DevOps.');
    const c = corrections.find((x) => x.corrected === 'three years of experience');
    expect(c?.issue).toBe('grammar');
  });

  it('"open the light" → turn on the light 纠错', async () => {
    const { corrections } = await mockTurn('Please open the light in the meeting room.');
    const c = corrections.find((x) => x.corrected === 'turn on the light');
    expect(c?.issue).toBe('collocation');
  });

  it('"more better" → better 纠错', async () => {
    const { corrections } = await mockTurn('This approach is more better than the old one.');
    const c = corrections.find((x) => x.original === 'more better');
    expect(c?.issue).toBe('grammar');
  });

  it('"I\'m agree" → I agree 纠错', async () => {
    const { corrections } = await mockTurn("I'm agree with your assessment of the outage.");
    const c = corrections.find((x) => x.corrected === 'I agree');
    expect(c?.issue).toBe('grammar');
  });

  it('"can you borrow me" → lend me 纠错', async () => {
    const { corrections } = await mockTurn('Can you borrow me your laptop charger?');
    const c = corrections.find((x) => x.corrected === 'can you lend me');
    expect(c?.issue).toBe('word-choice');
  });

  it('干净输入（无规则命中）→ 不硬纠，corrections = []', async () => {
    const { corrections } = await mockTurn('The deployment went smoothly this morning.');
    expect(corrections).toEqual([]);
  });

  it('三个及以上错误 → 每轮最多 2 条纠错', async () => {
    const { corrections } = await mockTurn(
      'Yesterday I deploy the service and I very like it, then we discuss about the results.',
    );
    expect(corrections.length).toBeLessThanOrEqual(2);
    expect(corrections.length).toBeGreaterThanOrEqual(1);
  });
});

describe('MockLlmClient · streamChat 输出协议合规', () => {
  it('完整输出 = 正文 + 独占一行 <<<META>>> + 单行 JSON', async () => {
    let full = '';
    for await (const chunk of client.streamChat(userTurn('Tell me about your standup blocker.'))) {
      full += chunk;
    }
    expect(full).toMatch(/\n<<<META>>>\n/);
    const [reply, meta] = full.split('\n<<<META>>>\n');
    expect(reply.trim().length).toBeGreaterThan(0);
    const parsed = JSON.parse(meta) as { corrections: unknown[]; vocabulary_suggestions: unknown[] };
    expect(Array.isArray(parsed.corrections)).toBe(true);
    expect(Array.isArray(parsed.vocabulary_suggestions)).toBe(true);
  });

  it('流式输出可被 StreamParser 完整还原（delta 拼接 === reply）', async () => {
    const parser = new StreamParser();
    let deltaJoined = '';
    for await (const chunk of client.streamChat(userTurn('How was the rollback?'))) {
      deltaJoined += parser.push(chunk);
    }
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(deltaJoined).toBe(parsed.reply);
  });

  it('词条建议：0–2 条且四要素齐全', async () => {
    for (let i = 0; i < 5; i++) {
      const { suggestions } = await mockTurn('We had a pipeline incident yesterday.');
      expect(suggestions.length).toBeLessThanOrEqual(2);
      for (const s of suggestions) {
        expect(s.word.length).toBeGreaterThan(0);
        expect(s.phonetic.length).toBeGreaterThan(0);
        expect(s.definition.length).toBeGreaterThan(0);
        expect(s.example.length).toBeGreaterThan(0);
      }
    }
  });

  it('回复正文为英语（非空、含空格的完整句）', async () => {
    const { reply } = await mockTurn('The build failed again.');
    expect(reply).toMatch(/[a-zA-Z]/);
    expect(reply).toMatch(/[.?]/);
  });
});

describe('MockLlmClient · completeText 非流式路径', () => {
  it('词条生成（define）：返回四要素 JSON', async () => {
    const prompt = buildDefineWordPrompt('rollback', 'We performed a rollback last night.');
    const text = await client.completeText([{ role: 'user', content: prompt }]);
    const entry = JSON.parse(text) as Record<string, string>;
    expect(entry.word).toBe('rollback');
    expect(entry.phonetic.startsWith('/')).toBe(true);
    expect(entry.definition).toContain('回滚');
    expect(entry.example.length).toBeGreaterThan(0);
  });

  it('词条生成（define）：未收录词返回结构完整的兜底条目', async () => {
    const prompt = buildDefineWordPrompt('flibbertigibbet', 'some unknown word context');
    const text = await client.completeText([{ role: 'user', content: prompt }]);
    const entry = JSON.parse(text) as Record<string, string>;
    expect(entry.word).toBe('flibbertigibbet');
    expect(entry.phonetic).toBe('/flibbertigibbet/');
    expect(entry.definition.length).toBeGreaterThan(0);
    expect(entry.example.length).toBeGreaterThan(0);
  });

  it('completeJSON：词条生成路径返回解析后的对象', async () => {
    const prompt = buildDefineWordPrompt('postmortem', 'We wrote the postmortem.');
    const json = await client.completeJSON<Record<string, string>>([{ role: 'user', content: prompt }]);
    expect(json.word).toBe('postmortem');
    expect(json.definition).toContain('复盘');
  });

  it('延续开场白（opener）：基于最近 Learner 消息生成延续性开场，遵循协议', async () => {
    const tail: Message[] = [
      {
        id: 'm1',
        session_id: 's1',
        user_id: 'default',
        role: 'user',
        content: 'We rolled back the bad deployment and fixed the config.',
        corrections: [],
        vocab_suggestions: [],
        created_at: new Date().toISOString(),
      },
    ];
    const prompt = buildContinueOpenerPrompt('Incident Retrospective', tail);
    const text = await client.completeText([{ role: 'user', content: prompt }]);
    expect(text).toContain('<<<META>>>');
    const parser = new StreamParser();
    parser.push(text);
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toMatch(/Welcome back/i);
    expect(parsed.corrections).toEqual([]);
  });

  it('延续开场白：无 Learner 消息时生成通用欢迎语', async () => {
    const tail: Message[] = [
      {
        id: 'm1',
        session_id: 's1',
        user_id: 'default',
        role: 'assistant',
        content: 'How was your day?',
        corrections: [],
        vocab_suggestions: [],
        created_at: new Date().toISOString(),
      },
    ];
    const prompt = buildContinueOpenerPrompt('Coffee Break Chat', tail);
    const text = await client.completeText([{ role: 'user', content: prompt }]);
    expect(text).toContain('Welcome back');
  });
});
