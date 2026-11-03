/**
 * Mock LLM Provider（主理人增补需求）
 *
 * LLM_PROVIDER=mock 时不调用真实 LLM，返回内置模拟数据，供前端联调与冒烟测试：
 * - streamChat：内置模拟对话（逼真英语陪练回复 + 1–2 条中式英语纠错 + 词条建议），
 *   严格遵循输出协议（正文 + <<<META>>> + 单行 JSON），按词分块流式推送（25–45ms/块）；
 * - completeText：
 *   · 词条生成（define）：按内置词典返回四要素 JSON（未收录词返回结构完整的兜底条目）；
 *   · 延续开场白（opener）：基于 prompt 中的最近话题生成延续性开场白（同样遵循输出协议）。
 *
 * 与 OpenAiCompatClient 实现同一 LlmClient 接口（类型经 llm.service type-only 引入，无运行时循环依赖）。
 */

import type { Correction, VocabSuggestion } from '../../../shared/types/chat';
import type { LlmCallOptions, LlmChatMessage, LlmClient } from './llm.service';

/* ============================================================
 * 内置词典（词条建议 + define 共用）
 * ============================================================ */

function S(word: string, phonetic: string, definition: string, example: string): VocabSuggestion {
  return { word, phonetic, definition, example };
}

const MOCK_DICTIONARY: Readonly<Record<string, VocabSuggestion>> = {
  rollback: S('rollback', '/ˈroʊlbæk/', '回滚；将系统恢复到之前稳定版本的操作', 'We performed a rollback to the last stable release within ten minutes.'),
  pipeline: S('pipeline', '/ˈpaɪplaɪn/', '流水线；CI/CD 中自动化构建-测试-部署的流程', 'The deployment pipeline runs unit tests before pushing the image to production.'),
  deployment: S('deployment', '/dɪˈplɔɪmənt/', '部署；将软件发布到运行环境的过程', 'The deployment failed because of a missing environment variable.'),
  retrospective: S('retrospective', '/ˌretrəˈspektɪv/', '复盘会；回顾总结得失的会议', 'In the retrospective, we agreed to add more automated tests before releases.'),
  blocker: S('blocker', '/ˈblɑːkər/', '阻塞项；阻碍进展的问题', 'The API contract is still a blocker for the frontend team.'),
  standup: S('standup', '/ˈstændʌp/', '每日站会；敏捷团队简短的日常同步会议', "I'll bring up the login bug in tomorrow's standup."),
  backlog: S('backlog', '/ˈbæklɔːɡ/', '待办事项列表；需求池', 'We moved the search feature to the top of the backlog for next sprint.'),
  'on-call': S('on-call', '/ˌɒn ˈkɔːl/', '值班的；随时待命处理线上问题的（工作状态）', 'I was on-call last night when the alert about high latency fired.'),
  postmortem: S('postmortem', '/ˌpoʊstˈmɔːrtəm/', '事故复盘报告；对故障的事后分析', 'The postmortem identified a flaky integration test as the root cause.'),
  incident: S('incident', '/ˈɪnsɪdənt/', '（线上）事故；影响服务的意外事件', 'The incident was triggered by a bad config push yesterday evening.'),
  triage: S('triage', '/ˈtriːɑːʒ/', '分诊；问题分级与优先处理', 'During triage, we labeled the payment failures as P1 and paged the owner.'),
  hotfix: S('hotfix', '/ˈhɑːtfɪks/', '紧急修复；跳过常规流程快速上线的补丁', 'We shipped a hotfix to stop the memory leak on the order service.'),
  stakeholder: S('stakeholder', '/ˈsteɪkhoʊldər/', '利益相关方；项目干系人', "Let's sync with the stakeholders before changing the release date."),
  bottleneck: S('bottleneck', '/ˈbɑːtlnek/', '瓶颈；限制整体性能或进度的环节', 'Database queries became the main bottleneck under heavy traffic.'),
  latency: S('latency', '/ˈleɪtənsi/', '延迟；请求从发出到响应的耗时', 'P99 latency dropped by 40% after we enabled the cache.'),
  milestone: S('milestone', '/ˈmaɪlstoʊn/', '里程碑；项目中的关键节点', 'We hit the beta milestone a week ahead of schedule.'),
  deadline: S('deadline', '/ˈdedlaɪn/', '截止日期', "I'm worried we might miss the deadline if the review takes too long."),
  feedback: S('feedback', '/ˈfiːdbæk/', '反馈；评审或工作评价意见', 'Thanks for the detailed feedback on my pull request!'),
  'carry over': S('carry over', '/ˈkæri ˌoʊvər/', '遗留；从上个周期顺延到下个周期的（任务）', 'Two bugs will carry over to the next sprint because of the holiday.'),
  'follow up': S('follow up', '/ˈfɑːloʊ ʌp/', '跟进；后续追踪', "I'll follow up with the platform team about the API quota issue."),
  recharge: S('recharge', '/riːˈtʃɑːrdʒ/', '休整放松；恢复精力', 'I just want to recharge at home this weekend — maybe binge a show.'),
  commute: S('commute', '/kəˈmjuːt/', '通勤；上下班路程', 'My new commute is only fifteen minutes by bike.'),
  groceries: S('groceries', '/ˈɡroʊsəriz/', '食品杂货', 'I need to pick up some groceries on the way home.'),
  workout: S('workout', '/ˈwɜːrkaʊt/', '锻炼；健身训练', 'My morning workout gives me energy for the whole day.'),
  'hang out': S('hang out', '/hæŋ aʊt/', '（和朋友）闲逛、聚在一起玩', 'Do you want to hang out at the new board game cafe on Saturday?'),
  takeout: S('takeout', '/ˈteɪkaʊt/', '外卖；外带食物', "I'm too tired to cook — let's just order takeout."),
};

/* ============================================================
 * 纠错规则表：识别典型中式英语错误（每轮最多取 2 条，不硬纠）
 * ============================================================ */

const PAST_TENSE: Readonly<Record<string, string>> = {
  go: 'went',
  do: 'did',
  have: 'had',
  meet: 'met',
  fix: 'fixed',
  deploy: 'deployed',
};

interface CorrectionRule {
  test: RegExp;
  build: (match: RegExpMatchArray) => Correction;
}

const MOCK_CORRECTION_RULES: readonly CorrectionRule[] = [
  {
    test: /\bI very (like|love|enjoy|want|need)\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'collocation',
      corrected: `I really ${m[1]!.toLowerCase()}`,
      explanation: '"very" 不能直接修饰动词，表示程度要用 "really" 或 "… very much"。',
    }),
  },
  {
    test: /\bdiscuss about\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'word-choice',
      corrected: 'discuss',
      explanation: '"discuss" 是及物动词，直接接宾语，不需要介词 about。',
    }),
  },
  {
    test: /\bopen the (light|tv|computer|air conditioner)\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'collocation',
      corrected: `turn on the ${m[1]!.toLowerCase()}`,
      explanation: '电器开关用 "turn on/off"，"open/close" 用于门窗、盒子等具体开合。',
    }),
  },
  {
    test: /\b(more|most) better\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'grammar',
      corrected: 'better',
      explanation: 'better 本身已是比较级，前面不能再加 more/most。',
    }),
  },
  {
    test: /\bI'm agree\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'grammar',
      corrected: 'I agree',
      explanation: 'agree 是动词，表达观点直接说 "I agree"，不需要 be 动词。',
    }),
  },
  {
    test: /\bcan you borrow me\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'word-choice',
      corrected: 'can you lend me',
      explanation: 'borrow 是"（向别人）借入"，lend 是"借出"；借东西给别人用 lend。',
    }),
  },
  {
    test: /\byesterday I (go|do|have|meet|fix|deploy)\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'grammar',
      corrected: `yesterday I ${PAST_TENSE[m[1]!.toLowerCase()] ?? m[1]!.toLowerCase() + 'ed'}`,
      explanation: '句中有 yesterday 等过去时间词时，动词要用过去式。',
    }),
  },
  {
    test: /\b(he|she) (like|want|need|think|say|work)\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'grammar',
      corrected: `${m[1]!.toLowerCase()} ${m[2]!.toLowerCase()}s`,
      explanation: '第三人称单数主语的一般现在时，动词要加 -s。',
    }),
  },
  {
    test: /\b(\d+|two|three|four|five|six|seven) years? experience\b/i,
    build: (m) => ({
      original: m[0],
      issue: 'grammar',
      corrected: `${m[1]!.toLowerCase()} years of experience`,
      explanation: '表达"几年经验"要说 "X years of experience"，介词 of 不能省略。',
    }),
  },
];

/* ============================================================
 * 回复模板池：按关键词选场景化回复（均为 1–4 句 + 追问）
 * ============================================================ */

interface MockReplyTemplate {
  keywords: RegExp;
  replies: readonly string[];
  /** 词条建议候选（从内置词典取 key） */
  suggestions: readonly string[];
}

const MOCK_REPLY_TEMPLATES: readonly MockReplyTemplate[] = [
  {
    keywords: /standup|blocker|scrum|sprint|daily/i,
    replies: [
      'Thanks for the update! Sounds like the refactor is moving along nicely. Quick question — is the blocker on the payment service still there today, or did the platform team get back to you?',
      'Good progress! Since that blocker is still pending, shall we flag it in the channel after standup so the platform team can pick it up today?',
    ],
    suggestions: ['blocker', 'follow up', 'carry over'],
  },
  {
    keywords: /incident|rollback|downtime|outage|deploy/i,
    replies: [
      'Okay, that timeline is really helpful. What would you say was the root cause of the failed deployment — the config change itself, or something in the pipeline?',
      'Thanks for walking me through it. For the follow-up actions, do you think an automated rollback would have caught this earlier?',
    ],
    suggestions: ['rollback', 'postmortem', 'hotfix'],
  },
  {
    keywords: /interview|resume|career|position|hiring/i,
    replies: [
      "That's a solid answer — I like how you structured it. Could you also give me a concrete example with numbers, like how much you improved the deployment frequency?",
      'Great experience! Now let me probe a bit: if a production cluster ran out of disk space at 2 a.m., walk me through your first three steps.',
    ],
    suggestions: ['stakeholder', 'milestone', 'feedback'],
  },
  {
    keywords: /code|review|pull request|bug|refactor/i,
    replies: [
      'Makes sense to me. One more thing — how did you cover the edge cases in the retry logic, did you add unit tests for those?',
      "I see your point about keeping it simple. What if we extract that into a small helper — would that make the review easier for the rest of the team?",
    ],
    suggestions: ['feedback', 'pipeline', 'bottleneck'],
  },
  {
    keywords: /weekend|movie|hiking|plan|saturday|sunday/i,
    replies: [
      "That sounds like a perfect way to recharge! What time were you thinking — Saturday morning, or shall we avoid the crowd and go early afternoon?",
      "Nice plan! I'm in if the weather holds. Should we grab lunch afterwards, or do you need to be back home early?",
    ],
    suggestions: ['recharge', 'hang out', 'commute'],
  },
  {
    keywords: /coffee|lunch|tired|week|busy/i,
    replies: [
      "Ha, I feel you — it's been one of those weeks! Are you still on track with your project, or has the scope been creeping up again?",
      "Same here, this coffee is basically holding me together. Anything fun coming up this weekend to look forward to?",
    ],
    suggestions: ['recharge', 'takeout', 'commute'],
  },
  {
    keywords: /gym|workout|run|exercise|fitness/i,
    replies: [
      "That's a great goal! How many days a week can you realistically train without burning out?",
      "Love the motivation! Do you prefer strength training or cardio — or a mix of both?",
    ],
    suggestions: ['workout', 'recharge'],
  },
  {
    keywords: /order|menu|restaurant|dish|bill|eat/i,
    replies: [
      'Great choice! Would you like that with a side of fries or a small salad? And anything to drink?',
      "Absolutely, I can ask the kitchen to go easy on the spice. Would you like to see the dessert menu as well, or just the check at the end?",
    ],
    suggestions: ['takeout', 'groceries'],
  },
];

const DEFAULT_REPLIES: readonly string[] = [
  "That's interesting — tell me more about it! What was the trickiest part for you?",
  'I see what you mean. How did that turn out in the end?',
  "Nice! And how did the rest of your team react to that?",
  'Good point. If you had to do it again, what would you do differently?',
];

const DEFAULT_SUGGESTIONS: readonly string[] = ['follow up', 'feedback'];

/* ============================================================
 * 工具函数
 * ============================================================ */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randInt(minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(Math.random() * (maxInclusive - minInclusive + 1));
}

function pick<T>(items: readonly T[]): T {
  return items[randInt(0, items.length - 1)]!;
}

/** 按词切分文本（保留空白），模拟逐词流式输出 */
function chunkify(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

function lastUserContent(messages: LlmChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === 'user') {
      return m.content;
    }
  }
  return '';
}

/* ============================================================
 * Mock 客户端
 * ============================================================ */

export class MockLlmClient implements LlmClient {
  readonly provider = 'mock';
  readonly model: string;

  constructor(model = 'mock-english-coach') {
    this.model = model;
  }

  async *streamChat(
    messages: LlmChatMessage[],
    opts: LlmCallOptions = {},
  ): AsyncGenerator<string, void, void> {
    const full = this.composeTurn(messages);
    const pieces = chunkify(full);
    for (const piece of pieces) {
      if (opts.signal?.aborted) {
        return;
      }
      await sleep(randInt(25, 45));
      yield piece;
    }
  }

  async completeText(messages: LlmChatMessage[], _opts: LlmCallOptions = {}): Promise<string> {
    await sleep(randInt(250, 500));
    const promptText = messages.map((m) => m.content).join('\n');
    // 按调用场景分发（标记串与 prompt.service 模板保持一致）
    if (promptText.includes('Generate a dictionary entry')) {
      return this.mockDefine(promptText);
    }
    if (promptText.includes('Write a warm 1–2 sentence opening')) {
      return this.mockOpener(promptText);
    }
    // 兜底：按对话轮协议返回
    return this.composeTurn(messages);
  }

  async completeJSON<T = unknown>(
    messages: LlmChatMessage[],
    opts: LlmCallOptions = {},
  ): Promise<T> {
    const text = await this.completeText(messages, opts);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new Error('mock completeJSON: 未找到 JSON 载荷');
    }
    return JSON.parse(text.slice(start, end + 1)) as T;
  }

  /* ---------- 对话轮组装（严格遵循输出协议） ---------- */

  private composeTurn(messages: LlmChatMessage[]): string {
    const userContent = lastUserContent(messages);
    const corrections = this.detectCorrections(userContent);
    const template = MOCK_REPLY_TEMPLATES.find((t) => t.keywords.test(userContent));
    const reply = template ? pick(template.replies) : pick(DEFAULT_REPLIES);
    const suggestionKeys = template ? template.suggestions : DEFAULT_SUGGESTIONS;
    const suggestions = this.pickSuggestions(suggestionKeys, corrections);
    const meta = { corrections, vocabulary_suggestions: suggestions };
    return `${reply}\n<<<META>>>\n${JSON.stringify(meta)}`;
  }

  private detectCorrections(userContent: string): Correction[] {
    const found: Correction[] = [];
    for (const rule of MOCK_CORRECTION_RULES) {
      const match = userContent.match(rule.test);
      if (match) {
        found.push(rule.build(match));
        if (found.length >= 2) {
          break; // 每轮最多 2 条，符合纠错策略
        }
      }
    }
    return found;
  }

  /** 取 1–2 个词条建议（避开本轮已被纠错的词） */
  private pickSuggestions(keys: readonly string[], corrections: Correction[]): VocabSuggestion[] {
    const correctedWords = new Set(corrections.map((c) => c.corrected.toLowerCase()));
    const pool = keys
      .map((k) => MOCK_DICTIONARY[k])
      .filter((v): v is VocabSuggestion => v !== undefined)
      .filter((v) => !correctedWords.has(v.word.toLowerCase()));
    if (pool.length === 0) {
      return [];
    }
    const count = Math.min(pool.length, randInt(1, 2));
    const picked = new Map<string, VocabSuggestion>();
    while (picked.size < count) {
      const item = pick(pool);
      picked.set(item.word, item);
    }
    return [...picked.values()];
  }

  /* ---------- 词条生成（POST /api/words/define） ---------- */

  private mockDefine(promptText: string): string {
    const wordMatch = promptText.match(/word\/phrase "([^"]+)" as used in this context/);
    const word = (wordMatch?.[1] ?? 'word').trim();
    const ctxMatch = promptText.match(/this context:\s*"([\s\S]*?)"/);
    const context = (ctxMatch?.[1] ?? '').trim();
    const known = MOCK_DICTIONARY[word.toLowerCase()];
    const entry = known
      ? { ...known, word }
      : {
          word,
          phonetic: `/${word.toLowerCase()}/`,
          definition: `「${word}」在当前语境中的常用含义（mock 模拟数据；接入真实 LLM 后将生成贴合语境的释义）`,
          example: `Let's practice using "${word}" in our conversation again this week.`,
        };
    void context; // context 由路由层原样回传，此处不参与组装
    return JSON.stringify(entry);
  }

  /* ---------- 延续性开场白（POST /api/sessions continue_from_last） ---------- */

  private mockOpener(promptText: string): string {
    const learnerLines = promptText.match(/^Learner: .+$/gm) ?? [];
    const lastLearner = (learnerLines[learnerLines.length - 1] ?? '').replace(/^Learner: /, '');
    const topic = lastLearner
      .split(/\s+/)
      .slice(0, 6)
      .join(' ')
      .replace(/[.,!?;:]+$/, '');
    const opener = topic
      ? `Welcome back! Last time you mentioned "${topic}" — I've been wondering how it went. Ready to pick up where we left off?`
      : "Welcome back! It's great to see you again. What would you like to practice talking about today?";
    return `${opener}\n<<<META>>>\n${JSON.stringify({ corrections: [], vocabulary_suggestions: [] })}`;
  }
}
