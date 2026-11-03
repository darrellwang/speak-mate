/**
 * 流式输出解析状态机（架构文档 §6.3、C1/C4）
 *
 * 处理「正文 + <<<META>>> + 单行 JSON」输出协议的流式解析：
 * - REPLY 状态：正文直通（滑动窗口保留尾部，防止分隔符/`<think>` 跨 chunk 截断误发）；
 * - THINKING 状态：剥离 qwen3 思考块 <think>...</think>（含未闭合尾部，静默缓冲不发）；
 * - META 状态：分隔符出现后静默缓冲全部后续 chunk；
 * - flush()：容错清洗（think 块 → markdown 围栏 → 截取 {} → 宽松 JSON）→ 归一化校验
 *   → 返回 { reply, corrections, vocabulary_suggestions, degraded }；解析失败降级纯文本（3003）。
 *
 * 本文件是 LLM 输出的唯一解析点，所有容错集中在此（§9.3）。
 */

import type { Correction, CorrectionIssue, VocabSuggestion } from '../../../shared/types/chat';

/** META 分隔符（宽松匹配：允许前后可选换行与 \r\n，容忍模型不完全独占一行的情况） */
const META_DELIMITER_RE = /\r?\n?<<<META>>>\r?\n?/;
const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';
/**
 * 尾部保留窗口：正文直通时缓冲区尾部保留该长度的字符不发送，
 * 保证跨 chunk 截断的 `\r\n<<<META>>>`（最长 12 字符）与 `</think>`（8 字符）不被误发。
 */
const TAIL_KEEP = 13;

const VALID_ISSUES: readonly CorrectionIssue[] = ['grammar', 'word-choice', 'collocation', 'idiom'];

/* ============================================================
 * 类型定义
 * ============================================================ */

export interface ParsedTurn {
  /** 正文（已剥离 think 块与协议残片，trim 后的最终值） */
  reply: string;
  corrections: Correction[];
  vocabulary_suggestions: VocabSuggestion[];
  /** true = META 段缺失或解析失败，已降级纯文本（业务码 3003，正文照常展示） */
  degraded: boolean;
  /** 降级原因（MISSING_DELIMITER | META_PARSE_FAILED），degraded=false 时为 undefined */
  degradedReason?: string;
}

type ParserState = 'reply' | 'thinking' | 'meta';

/* ============================================================
 * 状态机
 * ============================================================ */

export class StreamParser {
  private state: ParserState = 'reply';
  /** REPLY 状态下尚未确认安全的正文候选（含尾部保留区） */
  private pending = '';
  /** META 状态缓冲 */
  private metaBuffer = '';
  /** 是否已见到分隔符 */
  private metaStarted = false;
  /** 已确认的正文全文（flush 时作为 reply 基准） */
  private fullReply = '';

  /**
   * 推入一个 LLM 输出 chunk，返回可安全转发给前端的正文增量（可能为空串）。
   * 分隔符跨 chunk 截断安全：未确认安全的内容保留在内部缓冲。
   */
  push(chunk: string): string {
    if (chunk.length === 0) {
      return '';
    }
    if (this.state === 'meta') {
      this.metaBuffer += chunk;
      return '';
    }
    if (this.state === 'thinking') {
      this.pending += chunk;
      return this.drainThinking();
    }
    // state === 'reply'
    this.pending += chunk;
    return this.drainReply();
  }

  /**
   * 流结束：补齐正文尾部 + 解析 META 缓冲，返回完整单轮输出。
   * 可安全地在流结束后调用一次（幂等：重复调用返回相同结果）。
   */
  flush(): ParsedTurn {
    // 正文收尾
    if (this.state === 'thinking') {
      // 未闭合的 <think>：思考内容全部丢弃
      this.pending = '';
    } else if (this.state === 'reply') {
      this.fullReply += this.pending;
      this.pending = '';
    }

    let reply = stripThinkBlocks(this.fullReply);
    reply = stripTrailingPartialMarkers(reply).trim();

    if (!this.metaStarted) {
      // 模型未按协议输出分隔符：整体降级为纯文本
      return {
        reply,
        corrections: [],
        vocabulary_suggestions: [],
        degraded: true,
        degradedReason: 'MISSING_DELIMITER',
      };
    }
    const meta = parseMetaBuffer(this.metaBuffer);
    if (meta === null) {
      return {
        reply,
        corrections: [],
        vocabulary_suggestions: [],
        degraded: true,
        degradedReason: 'META_PARSE_FAILED',
      };
    }
    return {
      reply,
      corrections: meta.corrections,
      vocabulary_suggestions: meta.vocabulary_suggestions,
      degraded: false,
    };
  }

  /* ---------- 内部：THINKING 状态处理 ---------- */

  private drainThinking(): string {
    const closeIdx = this.pending.indexOf(THINK_CLOSE);
    if (closeIdx === -1) {
      // 未闭合：只保留可能构成 </think> 前缀的尾部，防缓冲无限膨胀
      const keep = Math.min(this.pending.length, THINK_CLOSE.length - 1);
      this.pending = this.pending.slice(this.pending.length - keep);
      return '';
    }
    const rest = this.pending.slice(closeIdx + THINK_CLOSE.length);
    this.pending = rest;
    this.state = 'reply';
    return this.drainReply();
  }

  /* ---------- 内部：REPLY 状态处理 ---------- */

  private drainReply(): string {
    let out = '';
    // 循环处理状态转换（如 <think>...</think> 后紧跟分隔符的情况）
    for (;;) {
      const metaMatch = META_DELIMITER_RE.exec(this.pending);
      const metaIdx = metaMatch?.index ?? -1;
      const thinkIdx = this.pending.indexOf(THINK_OPEN);

      // 分隔符优先级高于 think（think 出现在 META 段之后无意义）
      if (metaIdx !== -1 && (thinkIdx === -1 || metaIdx <= thinkIdx)) {
        const head = this.pending.slice(0, metaIdx);
        const after = this.pending.slice(metaIdx + (metaMatch?.[0].length ?? 0));
        this.pending = '';
        this.state = 'meta';
        this.metaStarted = true;
        this.metaBuffer = after;
        out += head;
        this.fullReply += head;
        return out;
      }

      if (thinkIdx !== -1) {
        const head = this.pending.slice(0, thinkIdx);
        const thinkRest = this.pending.slice(thinkIdx + THINK_OPEN.length);
        out += head;
        this.fullReply += head;
        this.pending = thinkRest;
        this.state = 'thinking';
        const closed = this.drainThinking();
        // closed 的内容已由递归 drainReply() 自行累加进 fullReply，此处仅收集局部 out（delta 用），
        // 不得再次累加（否则单 chunk 内完整 think+正文场景正文会重复两遍，BUG-001）。
        out += closed;
        continue;
      }

      // 无特殊标记：发送确认安全的前缀，尾部保留 TAIL_KEEP 字符
      const safeLen = this.pending.length - TAIL_KEEP;
      if (safeLen > 0) {
        const safe = this.pending.slice(0, safeLen);
        this.pending = this.pending.slice(safeLen);
        out += safe;
        this.fullReply += safe;
      }
      return out;
    }
  }
}

/* ============================================================
 * 容错清洗与宽松解析（§6.3 flush 步骤 a-d）
 * ============================================================ */

/** 剥离完整与未闭合的 think 块 */
export function stripThinkBlocks(text: string): string {
  let t = text.replace(/<think>[\s\S]*?<\/think>/g, '');
  // 未闭合的 <think>（流中断时）：其后内容全部视为思考残留丢弃
  t = t.replace(/<think>[\s\S]*$/g, '');
  return t;
}

/** 剥离尾部未完成的协议残片（如截断的 "<think" / "<<<META" 前缀） */
function stripTrailingPartialMarkers(text: string): string {
  const markers = ['<think>', '<<<META>>>'];
  let t = text;
  let changed = true;
  while (changed) {
    changed = false;
    for (const marker of markers) {
      if (t.endsWith(marker)) {
        t = t.slice(0, -marker.length);
        changed = true;
        break;
      }
      // 尾部是 marker 的真前缀（长度 ≥2，避免误伤正文里普通的 "<"）
      for (let len = marker.length - 1; len >= 2; len--) {
        if (t.endsWith(marker.slice(0, len))) {
          t = t.slice(0, -len);
          changed = true;
          break;
        }
      }
      if (changed) {
        break;
      }
    }
  }
  return t;
}

/** 清洗 META 文本：剥 think → 剥 markdown 围栏 → 截取首个 { 到最后一个 } */
function cleanFencedText(raw: string): string {
  let t = stripThinkBlocks(raw).trim();
  // 剥离 ```json ... ``` 或 ``` ... ``` 围栏
  t = t.replace(/```[a-zA-Z]*\s*([\s\S]*?)```/g, '$1');
  t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '');
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last > first) {
    t = t.slice(first, last + 1);
  }
  return t.trim();
}

/** 宽松 JSON 解析：原生解析 → 尾逗号/单引号修复后重试 */
function looseJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // 继续宽松尝试
  }
  let repaired = text.replace(/,\s*([}\]])/g, '$1'); // 移除尾逗号
  repaired = repaired
    .replace(/([{,]\s*)'([^']*)'(\s*:)/g, '$1"$2"$3') // 键名单引号
    .replace(/(:\s*)'([^']*)'(\s*[,}\]])/g, '$1"$2"$3'); // 值单引号
  try {
    return JSON.parse(repaired);
  } catch {
    return null;
  }
}

/** 归一化单条纠错：缺关键字段的项丢弃，issue 非法时归为 grammar */
function normalizeCorrection(value: unknown): Correction | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const o = value as Record<string, unknown>;
  const original = typeof o.original === 'string' ? o.original.trim() : '';
  const corrected = typeof o.corrected === 'string' ? o.corrected.trim() : '';
  const explanation = typeof o.explanation === 'string' ? o.explanation.trim() : '';
  const issueRaw = typeof o.issue === 'string' ? (o.issue.trim() as CorrectionIssue) : 'grammar';
  if (!original || !corrected) {
    return null;
  }
  const issue = VALID_ISSUES.includes(issueRaw) ? issueRaw : 'grammar';
  return { original, issue, corrected, explanation };
}

/** 归一化单条词条建议：word 必填，其余缺失给空串（前端占位后可经 define 补全） */
function normalizeVocabSuggestion(value: unknown): VocabSuggestion | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const o = value as Record<string, unknown>;
  const word = typeof o.word === 'string' ? o.word.trim() : '';
  if (!word) {
    return null;
  }
  return {
    word,
    phonetic: typeof o.phonetic === 'string' ? o.phonetic.trim() : '',
    definition: typeof o.definition === 'string' ? o.definition.trim() : '',
    example: typeof o.example === 'string' ? o.example.trim() : '',
  };
}

/** 解析 META 缓冲 → { corrections, vocabulary_suggestions }；失败返回 null（降级） */
export function parseMetaBuffer(raw: string): {
  corrections: Correction[];
  vocabulary_suggestions: VocabSuggestion[];
} | null {
  const cleaned = cleanFencedText(raw);
  if (!cleaned.startsWith('{')) {
    return null;
  }
  const parsed = looseJsonParse(cleaned);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const rawCorrections = Array.isArray(o.corrections) ? o.corrections : [];
  const rawSuggestions = Array.isArray(o.vocabulary_suggestions) ? o.vocabulary_suggestions : [];
  const corrections = rawCorrections
    .map(normalizeCorrection)
    .filter((c): c is Correction => c !== null);
  const vocabulary_suggestions = rawSuggestions
    .map(normalizeVocabSuggestion)
    .filter((v): v is VocabSuggestion => v !== null);
  return { corrections, vocabulary_suggestions };
}

/**
 * 从任意 LLM 文本输出中提取 JSON 载荷（completeJSON 复用）：
 * 清洗 → 宽松解析；失败返回 null。
 */
export function extractJsonPayload(text: string): unknown {
  const parsed = looseJsonParse(cleanFencedText(text));
  return parsed;
}
