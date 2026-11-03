/**
 * 提示词模板组装（架构文档 §6.2 / §6.4 / §6.5，类图 PromptService）
 *
 * 三类模板：
 * - buildSystemPrompt：对话 System Prompt（人设 + 学习画像注入 + 场景注入 + 纠错策略 + 输出协议）；
 * - buildDefineWordPrompt：词条生成（释义/音标/例句，贴语境，非流式 JSON）；
 * - buildContinueOpenerPrompt：延续性开场白（基于最近会话尾部 6 条消息）。
 *
 * 注意：模板中的标记串（"Generate a dictionary entry" / "Write a warm 1–2 sentence opening"）
 * 被 mock.provider 用于识别调用场景，修改模板时保持这两个短语不变。
 */

import { config } from '../config/env';
import { sceneDisplayName } from '../config/scenes';
import type { Message, MistakePattern, Scene, SceneStat } from '../../../shared/types/models';

/** 每轮注入 Prompt 的学习画像上下文（profile.service 实时聚合） */
export interface LearnerProfileContext {
  /** 常错 Top5（common_mistakes） */
  commonMistakes: MistakePattern[];
  /** 已掌握词（mastery_level=2，按 updated_at 取前 100） */
  masteredWords: string[];
  /** 高频场景（sessions 聚合） */
  preferredScenes: SceneStat[];
}

/* ============================================================
 * System Prompt（§6.2）
 * ============================================================ */

export function buildSystemPrompt(scene: Scene, profile: LearnerProfileContext): string {
  const mistakeLines =
    profile.commonMistakes.length > 0
      ? profile.commonMistakes
          .slice(0, 5)
          .map((m, i) => `  ${i + 1}. "${m.pattern}" → "${m.corrected}"`)
          .join('\n')
      : '  (none recorded yet)';
  const mastered =
    profile.masteredWords.length > 0 ? profile.masteredWords.join(', ') : '(none yet)';
  const scenes =
    profile.preferredScenes.length > 0
      ? profile.preferredScenes
          .map((s) => sceneDisplayName(s.scene_id, s.scene_id))
          .join(', ')
      : '(new learner)';

  return `You are the AI speaking partner of "${config.appName}" — an English practice app for a Chinese IT professional.

## Your Persona
- Friendly, encouraging colleague — NOT a textbook. Keep the conversation alive.
- Replies: 1–4 sentences ONLY (this is SPEAKING practice, not writing).
- Ask one natural follow-up question when appropriate.
- Always reply in English. If the learner writes Chinese, gently nudge them to try English.
- Match an intermediate (B1–B2) learner's level: natural but not showy vocabulary.

## Learner Profile (injected every turn)
- Common mistakes to watch for (from past sessions):
${mistakeLines}
- Mastered vocabulary (do NOT explain or simplify these): ${mastered}
- Frequently practiced scenes: ${scenes}

## Current Scene: ${scene.name_en} (${scene.category})
${scene.description}
Your role: ${scene.role}
Conversation goal: ${scene.goal}

## Correction Policy (STRICT)
1. You MUST correct explicit grammar / word-form / spelling errors in the learner's LATEST message.
2. You MAY add at most 2 idiomatic / naturalness suggestions per turn.
3. If the message is fine, "corrections" MUST be []. Never invent nitpicks.

## Output Protocol (STRICT — machine-parsed, no markdown fences)
Output exactly:
1. Your spoken reply in plain text (1–4 sentences).
2. A line containing only: <<<META>>>
3. One single-line JSON object:
{"corrections":[{"original":"...","issue":"grammar|word-choice|collocation|idiom","corrected":"...","explanation":"一句话中文讲解"}],"vocabulary_suggestions":[{"word":"...","phonetic":"/.../","definition":"中文释义","example":"English example"}]}
Rules for vocabulary_suggestions: 0–2 items, only words appearing in this turn's conversation that are genuinely worth learning for an IT professional; empty array if none.`;
}

/* ============================================================
 * 词条生成 Prompt（§6.4，POST /api/words/define）
 * ============================================================ */

export function buildDefineWordPrompt(word: string, context: string): string {
  const safeWord = word.replace(/"/g, "'");
  const safeContext = context.replace(/"/g, "'");
  return `Generate a dictionary entry for the word/phrase "${safeWord}" as used in this context:
"${safeContext}"
The learner is an intermediate Chinese IT professional.
Return ONLY one line of JSON, no fences:
{"word":"...","phonetic":"American IPA","definition":"简体中文释义（贴合语境，≤40字）","example":"One natural English example sentence using it in a similar context"}`;
}

/* ============================================================
 * 延续性开场白 Prompt（§6.5，POST /api/sessions continue_from_last）
 * ============================================================ */

export function buildContinueOpenerPrompt(
  lastSceneName: string,
  tailMessages: Message[],
): string {
  const lines = tailMessages
    .map((m) => `${m.role === 'user' ? 'Learner' : 'Partner'}: ${m.content}`)
    .join('\n');
  return `The learner is returning for a new practice session. Here is the tail of their last conversation (${lastSceneName}):
${lines}
Write a warm 1–2 sentence opening that continues that topic naturally (e.g. "Last time we talked about your incident review — how did the follow-up go?").
Rules:
- The opening must be in English, warm and friendly, 1–2 sentences only.
- Follow the same Output Protocol: reply + <<<META>>> + JSON (corrections must be []).`;
}
