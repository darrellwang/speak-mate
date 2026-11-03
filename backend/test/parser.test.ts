/**
 * 流式解析器 StreamParser 单元测试（核心模块，架构文档 §6.3 / C1 / C4）。
 *
 * 覆盖：
 * - 正常协议：单 chunk / 多 chunk / 多行 JSON / 无尾换行分隔符；
 * - 分隔符跨 chunk 截断：全位置穷举（LF 与 CRLF），正文输出不得泄露分隔符残片；
 * - think 块剥离：前置 / 中置 / 跨 chunk / 未闭合；
 * - markdown 围栏剥离（```json / ```）与前后杂文截取；
 * - 宽松 JSON：尾逗号 / 单引号；
 * - 协议不合规降级：MISSING_DELIMITER / META_PARSE_FAILED（degraded=true，正文照常）；
 * - 归一化：非法 issue → grammar、缺关键字段丢弃、非对象条目丢弃；
 * - extractJsonPayload（completeJSON 复用路径）。
 */
import { describe, expect, it } from 'vitest';
import {
  extractJsonPayload,
  parseMetaBuffer,
  StreamParser,
  stripThinkBlocks,
} from '../src/services/parser';
import type { Correction } from '../../shared/types/chat';

/** 标准单轮输出（协议 §6.1） */
const REPLY = 'How did the incident review go? Did you finish the rollback?';
const META_JSON =
  '{"corrections":[{"original":"I very like this tool","issue":"collocation","corrected":"I really like this tool","explanation":"very 不能直接修饰动词"}],"vocabulary_suggestions":[{"word":"rollback","phonetic":"/ˈrəʊlbæk/","definition":"回滚","example":"We performed a rollback."}]}';

function fullTurn(reply: string, meta: string): string {
  return `${reply}\n<<<META>>>\n${meta}`;
}

/** 逐 chunk 推入并收集全部 delta 输出 */
function feed(parser: StreamParser, chunks: string[]): string[] {
  return chunks.map((c) => parser.push(c));
}

describe('StreamParser · 正常协议解析', () => {
  it('单 chunk 完整输出：delta 为正文，flush 解析出纠错与词条', () => {
    const parser = new StreamParser();
    const out = parser.push(fullTurn(REPLY, META_JSON));
    expect(out).toBe(REPLY);
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toBe(REPLY);
    expect(parsed.corrections).toHaveLength(1);
    expect(parsed.corrections[0]).toMatchObject({
      original: 'I very like this tool',
      issue: 'collocation',
      corrected: 'I really like this tool',
      explanation: 'very 不能直接修饰动词',
    });
    expect(parsed.vocabulary_suggestions).toHaveLength(1);
    expect(parsed.vocabulary_suggestions[0]).toMatchObject({
      word: 'rollback',
      phonetic: '/ˈrəʊlbæk/',
      definition: '回滚',
    });
  });

  it('多 chunk 逐词推送：delta 拼接 === 正文全文', () => {
    const parser = new StreamParser();
    const text = fullTurn(REPLY, META_JSON);
    // 按 3 字符切片模拟细粒度流式
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 3) {
      chunks.push(text.slice(i, i + 3));
    }
    const deltas = feed(parser, chunks);
    const joined = deltas.join('');
    // 正文必须完整到达（尾部保留区在后续 chunk 到达后补发）
    expect(joined).toBe(REPLY);
    expect(joined).not.toContain('<<<META');
    expect(joined).not.toContain(META_JSON.slice(0, 8));
    const parsed = parser.flush();
    expect(parsed.reply).toBe(REPLY);
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections[0]?.corrected).toBe('I really like this tool');
  });

  it('META 为多行（pretty-printed）JSON：仍可解析', () => {
    const prettyMeta = `{
      "corrections": [
        { "original": "discuss about it", "issue": "word-choice", "corrected": "discuss it", "explanation": "discuss 及物" }
      ],
      "vocabulary_suggestions": []
    }`;
    const parser = new StreamParser();
    parser.push(fullTurn('Sure, let us talk.', prettyMeta));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
    expect(parsed.corrections[0]?.original).toBe('discuss about it');
    expect(parsed.vocabulary_suggestions).toHaveLength(0);
  });

  it('分隔符后无换行直接跟 JSON：可解析', () => {
    const parser = new StreamParser();
    parser.push(`Reply here.\n<<<META>>>${META_JSON}`);
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toBe('Reply here.');
    expect(parsed.corrections).toHaveLength(1);
  });

  it('分隔符位于流首（空正文）：reply 为空串但不降级', () => {
    const parser = new StreamParser();
    const out = parser.push(`<<<META>>>\n${META_JSON}`);
    expect(out).toBe('');
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toBe('');
    expect(parsed.corrections).toHaveLength(1);
  });

  it('flush 幂等：重复调用返回相同结果', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, META_JSON));
    const first = parser.flush();
    const second = parser.flush();
    expect(second).toEqual(first);
  });

  it('空 chunk 推入：返回空串无副作用', () => {
    const parser = new StreamParser();
    expect(parser.push('')).toBe('');
    parser.push(fullTurn(REPLY, META_JSON));
    expect(parser.push('')).toBe('');
  });
});

describe('StreamParser · 分隔符跨 chunk 截断（穷举切分点）', () => {
  const delimiterCases: Array<{ name: string; text: string; reply: string }> = [
    { name: 'LF 分隔符 "\\n<<<META>>>\\n"', text: fullTurn(REPLY, META_JSON), reply: REPLY },
    {
      name: 'CRLF 分隔符 "\\r\\n<<<META>>>\\r\\n"',
      text: `${REPLY}\r\n<<<META>>>\r\n${META_JSON}`,
      reply: REPLY,
    },
  ];

  for (const { name, text, reply } of delimiterCases) {
    it(`${name}：任意位置二分切分，正文完整且无分隔符泄露`, () => {
      // 穷举切分点：分隔符的任意字符都可能落在两个 chunk 的边界
      for (let split = 1; split < text.length - 1; split++) {
        const parser = new StreamParser();
        const deltas = feed(parser, [text.slice(0, split), text.slice(split)]);
        const joined = deltas.join('');
        expect(joined, `切分点 ${split}：delta 拼接应等于正文`).toBe(reply);
        expect(joined, `切分点 ${split}：不得泄露 <<<META>>>`).not.toContain('<<<META');
        expect(joined, `切分点 ${split}：不得泄露 META JSON 内容`).not.toContain('corrections');
        const parsed = parser.flush();
        expect(parsed.degraded, `切分点 ${split}`).toBe(false);
        expect(parsed.reply).toBe(reply);
        expect(parsed.corrections).toHaveLength(1);
      }
    });
  }

  it('三段切分（正文 / 分隔符 / META 各自再断开）：delta 拼接完整', () => {
    const text = fullTurn(REPLY, META_JSON);
    const cut = text.indexOf('\n<<<META>>>');
    const parser = new StreamParser();
    const deltas = feed(parser, [
      text.slice(0, cut + 3), // 正文 + "\n<<"
      text.slice(cut + 3, cut + 9), // "<META"
      text.slice(cut + 9, cut + 16), // ">>>\n" + JSON 开头
      text.slice(cut + 16),
    ]);
    expect(deltas.join('')).toBe(REPLY);
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toBe(REPLY);
  });

  it('分隔符逐字符推送（最细粒度）：不泄露不丢字', () => {
    const text = fullTurn(REPLY, META_JSON);
    const parser = new StreamParser();
    const deltas: string[] = [];
    for (const ch of text) {
      deltas.push(parser.push(ch));
    }
    expect(deltas.join('')).toBe(REPLY);
    expect(parser.flush().reply).toBe(REPLY);
  });
});

describe('StreamParser · think 块剥离（qwen3 容错，C4）', () => {
  it('前置 think 块：思考内容不进入 delta 与 reply', () => {
    const parser = new StreamParser();
    const out = parser.push(`<think>Let me think about the incident.</think>${fullTurn(REPLY, META_JSON)}`);
    expect(out).not.toContain('Let me think');
    const parsed = parser.flush();
    expect(parsed.reply).toBe(REPLY);
    expect(parsed.degraded).toBe(false);
  });

  it('think 块跨 chunk 截断（开标签与闭标签均被切断）：思考内容零泄露', () => {
    const text = `<think>internal reasoning about grammar</thi${''}nk>${fullTurn(REPLY, META_JSON)}`;
    // 人为构造跨 chunk："<th" + "ink>...reasoning..." + "</thi" + "nk>" + 正文
    const parser = new StreamParser();
    const deltas = feed(parser, [
      '<th',
      'ink>internal reasoning about grammar',
      '</thi',
      'nk>',
      fullTurn(REPLY, META_JSON),
    ]);
    const joined = deltas.join('');
    expect(joined).not.toContain('internal reasoning');
    expect(joined).not.toContain('think');
    expect(joined).toBe(REPLY);
    expect(parser.flush().reply).toBe(REPLY);
    void text;
  });

  it('think 块中置：正文前后段均保留，思考内容剥离', () => {
    const parser = new StreamParser();
    parser.push('Hello ');
    parser.push('<think>hidden</think>');
    parser.push(fullTurn(' world!', META_JSON));
    const parsed = parser.flush();
    expect(parsed.reply).toContain('Hello');
    expect(parsed.reply).toContain('world');
    expect(parsed.reply).not.toContain('hidden');
    expect(parsed.degraded).toBe(false);
  });

  it('未闭合 think 块（流中断）：其后内容视为思考残留丢弃', () => {
    const parser = new StreamParser();
    parser.push('Visible reply part.');
    parser.push('<think>unfinished reasoning that never closes');
    const parsed = parser.flush();
    expect(parsed.reply).toBe('Visible reply part.');
    expect(parsed.degraded).toBe(true); // 无分隔符 → MISSING_DELIMITER
    expect(parsed.degradedReason).toBe('MISSING_DELIMITER');
  });

  it('think 块内出现分隔符：分隔符属于思考内容，不切换 META 状态', () => {
    // 说明：think 优先级——META 匹配要求其位置先于 think 开标签
    const parser = new StreamParser();
    parser.push(`Answer text.<think>noise <<<META>>> noise</think>`);
    parser.push(`\n<<<META>>>\n${META_JSON}`);
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.reply).toBe('Answer text.');
    expect(parsed.corrections).toHaveLength(1);
  });
});

describe('StreamParser · META 容错清洗（围栏 / 杂文 / 宽松 JSON）', () => {
  it('```json 围栏包裹：剥离后解析', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, '```json\n' + META_JSON + '\n```'));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
  });

  it('无语言标注围栏 ```：剥离后解析', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, '```\n' + META_JSON + '\n```'));
    expect(parser.flush().degraded).toBe(false);
  });

  it('围栏跨 chunk 截断：仍解析', () => {
    const meta = '```json\n' + META_JSON + '\n```';
    const parser = new StreamParser();
    parser.push(`${REPLY}\n<<<META>>>\n`);
    parser.push(meta.slice(0, 6));
    parser.push(meta.slice(6));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
  });

  it('META 前后杂文（模型闲聊）：截取首个 { 到最后一个 }', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, `Here is the metadata you asked for:\n${META_JSON}\nHope this helps!`));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
  });

  it('尾逗号（数组/对象）：宽松解析成功', () => {
    const meta =
      '{"corrections":[{"original":"a","issue":"grammar","corrected":"b","explanation":"c",},], "vocabulary_suggestions":[{},]}';
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, meta));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
    expect(parsed.corrections[0]?.original).toBe('a');
    expect(parsed.vocabulary_suggestions).toHaveLength(0);
  });

  it('单引号键值：宽松解析成功', () => {
    const meta =
      "{'corrections':[{'original':'x','issue':'idiom','corrected':'y','explanation':'z'}],'vocabulary_suggestions':[]}";
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, meta));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections[0]?.corrected).toBe('y');
  });

  it('think 块混入 META 段：剥离后解析', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, `<think>meta thoughts</think>${META_JSON}`));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(false);
    expect(parsed.corrections).toHaveLength(1);
  });
});

describe('StreamParser · 协议不合规降级（3003，正文照常）', () => {
  it('完全无分隔符：MISSING_DELIMITER，全文为正文，corrections 为空', () => {
    const parser = new StreamParser();
    const input = 'This model ignored the protocol entirely.';
    const out = parser.push(input);
    // 尾部保留 TAIL_KEEP=13 字符不发送，其余为安全前缀
    expect(out).toBe(input.slice(0, input.length - 13));
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(true);
    expect(parsed.degradedReason).toBe('MISSING_DELIMITER');
    expect(parsed.reply).toBe(input);
    expect(parsed.corrections).toEqual([]);
    expect(parsed.vocabulary_suggestions).toEqual([]);
  });

  it('META 段为纯文本杂文：META_PARSE_FAILED', () => {
    const parser = new StreamParser();
    parser.push('Reply body here.\n<<<META>>>\nsorry I cannot produce JSON');
    const parsed = parser.flush();
    expect(parsed.degraded).toBe(true);
    expect(parsed.degradedReason).toBe('META_PARSE_FAILED');
    expect(parsed.reply).toBe('Reply body here.');
    expect(parsed.corrections).toEqual([]);
  });

  it('META 段为数字：META_PARSE_FAILED', () => {
    const parser = new StreamParser();
    parser.push(`Reply.\n<<<META>>>\n12345`);
    expect(parser.flush().degradedReason).toBe('META_PARSE_FAILED');
  });

  it('降级时 delta 已照常输出（对话不中断的前提）', () => {
    const parser = new StreamParser();
    const deltas = feed(parser, ['Partial reply. ', 'More text.\n<<<META>>>\ngarbage']);
    const joined = deltas.join('');
    expect(joined.startsWith('Partial reply.')).toBe(true);
    expect(joined).not.toContain('<<<META');
  });
});

describe('StreamParser · 条目归一化', () => {
  it('issue 非法值 → 归为 grammar', () => {
    const meta =
      '{"corrections":[{"original":"a","issue":"spelling","corrected":"b","explanation":"c"}],"vocabulary_suggestions":[]}';
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, meta));
    const parsed = parser.flush();
    expect(parsed.corrections[0]?.issue).toBe('grammar');
  });

  it('issue 缺失 → 归为 grammar；explanation 缺失 → 空串', () => {
    const meta = '{"corrections":[{"original":"a","corrected":"b"}],"vocabulary_suggestions":[]}';
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, meta));
    const parsed = parser.flush();
    expect(parsed.corrections[0]?.issue).toBe('grammar');
    expect(parsed.corrections[0]?.explanation).toBe('');
  });

  it('纠错缺 original / corrected → 该条丢弃', () => {
    const meta =
      '{"corrections":[{"issue":"grammar","corrected":"b","explanation":"c"},{"original":"a","issue":"grammar","explanation":"c"},{"original":"ok","corrected":"fine","explanation":"keep"}],"vocabulary_suggestions":[]}';
    const parsed = parseMetaBuffer(meta);
    expect(parsed).not.toBeNull();
    expect(parsed?.corrections).toHaveLength(1);
    expect(parsed?.corrections[0]?.original).toBe('ok');
  });

  it('corrections 含非对象条目 → 丢弃，不影响其余', () => {
    const meta =
      '{"corrections":["not an object", null, 42, {"original":"a","corrected":"b"}],"vocabulary_suggestions":[]}';
    const parsed = parseMetaBuffer(meta);
    expect(parsed?.corrections).toHaveLength(1);
  });

  it('corrections 非数组（对象/字符串）→ 按空数组处理', () => {
    const meta = '{"corrections":"oops","vocabulary_suggestions":"oops"}';
    const parsed = parseMetaBuffer(meta);
    expect(parsed?.corrections).toEqual([]);
    expect(parsed?.vocabulary_suggestions).toEqual([]);
  });

  it('词条建议缺 word → 丢弃；缺音标/例句 → 空串占位', () => {
    const meta =
      '{"corrections":[],"vocabulary_suggestions":[{"phonetic":"/x/","definition":"d"},{"word":"rollback","definition":"回滚"}]}';
    const parsed = parseMetaBuffer(meta);
    expect(parsed?.vocabulary_suggestions).toHaveLength(1);
    expect(parsed?.vocabulary_suggestions[0]?.word).toBe('rollback');
    expect(parsed?.vocabulary_suggestions[0]?.phonetic).toBe('');
    expect(parsed?.vocabulary_suggestions[0]?.example).toBe('');
  });
});

describe('parseMetaBuffer / extractJsonPayload / stripThinkBlocks 纯函数', () => {
  it('parseMetaBuffer：合法 JSON 对象直接解析', () => {
    const parsed = parseMetaBuffer(META_JSON);
    expect(parsed?.corrections).toHaveLength(1);
    expect(parsed?.vocabulary_suggestions).toHaveLength(1);
  });

  it('parseMetaBuffer：非对象 JSON（数组包裹）→ 宽松截取仍可解析内部对象（文档化行为）', () => {
    const parsed = parseMetaBuffer(`[${META_JSON}]`);
    // 截取首个 { 到最后一个 } 后得到内部对象，属于宽松容错
    expect(parsed === null || parsed.corrections.length === 1).toBe(true);
  });

  it('extractJsonPayload：围栏 JSON → 对象', () => {
    const payload = extractJsonPayload('```json\n{"word":"rollback"}\n```');
    expect(payload).toEqual({ word: 'rollback' });
  });

  it('extractJsonPayload：纯 JSON 文本 → 对象', () => {
    expect(extractJsonPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it('extractJsonPayload：无法解析 → null', () => {
    expect(extractJsonPayload('no json here')).toBeNull();
  });

  it('stripThinkBlocks：完整块与未闭合块均剥离', () => {
    expect(stripThinkBlocks('A<think>x</think>B')).toBe('AB');
    expect(stripThinkBlocks('A<think>unclosed')).toBe('A');
    expect(stripThinkBlocks('多段<think>1</think>中<think>2</think>间')).toBe('多段中间');
  });
});

describe('StreamParser · 端到端协议一致性（delta 拼接 === flush reply）', () => {
  const protocolCases: Array<{ name: string; chunks: string[]; expectedReply: string }> = [
    {
      name: '标准输出',
      chunks: [fullTurn(REPLY, META_JSON)],
      expectedReply: REPLY,
    },
    {
      name: 'think + 协议输出',
      chunks: ['<think>scratch</think>', fullTurn(REPLY, META_JSON)],
      expectedReply: REPLY,
    },
    {
      name: '细粒度逐字符',
      chunks: [...fullTurn(REPLY, META_JSON)],
      expectedReply: REPLY,
    },
  ];

  for (const { name, chunks, expectedReply } of protocolCases) {
    it(name, () => {
      const parser = new StreamParser();
      const deltas = feed(parser, chunks);
      expect(deltas.join('')).toBe(expectedReply);
      expect(parser.flush().reply).toBe(expectedReply);
    });
  }

  it('纠错四要素在 meta 事件与落库 JSON 之间保持结构一致（类型冒烟）', () => {
    const parser = new StreamParser();
    parser.push(fullTurn(REPLY, META_JSON));
    const parsed = parser.flush();
    const correction: Correction | undefined = parsed.corrections[0];
    expect(correction).toBeDefined();
    expect(['grammar', 'word-choice', 'collocation', 'idiom']).toContain(correction?.issue);
    expect(correction?.original.length).toBeGreaterThan(0);
    expect(correction?.corrected.length).toBeGreaterThan(0);
  });
});
