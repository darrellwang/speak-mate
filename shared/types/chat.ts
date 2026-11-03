/**
 * LLM 输出契约（shared/types/chat.ts）
 *
 * SpeakMate 前后端共享的「对话流」契约：
 * - Correction / VocabSuggestion：LLM 单轮输出协议（正文 + <<<META>>> + 单行 JSON）中的结构化部分；
 * - ChatSseEvent：POST /api/chat 的 SSE 四事件（delta / meta / done / error）；
 * - LlmTurnOutput：解析器 flush 后的完整单轮输出。
 *
 * 本文件为纯类型文件，零运行时依赖，前后端共同引用（后端经相对路径，前端经 @shared 别名）。
 */

/** 纠错问题类型（LLM 输出枚举，见架构文档 §6.1） */
export type CorrectionIssue = 'grammar' | 'word-choice' | 'collocation' | 'idiom';

/** 单条纠错：❌原句 → ⚠️问题 → ✅正确 → 💡讲解（四要素，纠错卡片渲染依据） */
export interface Correction {
  /** 用户原句（错误片段或整句） */
  original: string;
  /** 问题类型：grammar | word-choice | collocation | idiom */
  issue: CorrectionIssue;
  /** 正确说法 */
  corrected: string;
  /** 一句话讲解（简体中文，帮助中文母语者理解） */
  explanation: string;
}

/** AI 主动建议的词条（0–2 个/轮，四要素齐全，可一键入库） */
export interface VocabSuggestion {
  /** 词或短语 */
  word: string;
  /** 音标（美式 IPA） */
  phonetic: string;
  /** 中文释义（贴合本轮语境） */
  definition: string;
  /** 英文例句 */
  example: string;
}

/**
 * SSE 事件契约（POST /api/chat，架构文档 §4.3）
 *
 * 前端以 fetch POST + ReadableStream 消费（EventSource 仅支持 GET），
 * 按 `\n\n` 分帧，每帧形如：`event: <name>\ndata: <json>\n\n`。
 *
 * 正常时序：delta(0..n) → meta(1) → done(1，最后)
 * 失败时序：delta(0..n)? → error(1，发送后流关闭)
 */
export type ChatSseEvent =
  | { event: 'delta'; data: { text: string } }
  | { event: 'meta'; data: { corrections: Correction[]; vocabulary_suggestions: VocabSuggestion[] } }
  | { event: 'done'; data: { message_id: string; session_id: string } }
  | { event: 'error'; data: { code: number; message: string } };

/** LLM 单轮完整输出（流式解析器 flush 后的产物） */
export interface LlmTurnOutput {
  /** 正文（纯文本，1–4 句） */
  reply: string;
  /** 纠错（显式错误必纠；地道性建议每轮 ≤2 条；无错误=空数组，不硬纠） */
  corrections: Correction[];
  /** AI 主动建议词条（0–2 个） */
  vocabulary_suggestions: VocabSuggestion[];
}
