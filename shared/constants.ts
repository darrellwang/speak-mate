/**
 * 跨端共享的业务常量（审查报告 L2）。
 *
 * 只放"前后端必须一致、各自硬编码就会漂移"的数值与文案。
 * 纯常量 + 纯函数，零运行时依赖，可被后端（相对路径）与前端（@shared/* 别名）同时引用。
 */

import type { CorrectionIssue } from './types/chat';

/* ---------- TTS 语速（契约 ProfileSettings.tts_rate） ---------- */

/** TTS 语速下限（Web Speech API 有效范围） */
export const TTS_RATE_MIN = 0.5;
/** TTS 语速上限 */
export const TTS_RATE_MAX = 2;
/** TTS 语速默认值（1 = 正常语速） */
export const TTS_RATE_DEFAULT = 1;

/** 把语速收敛到合法区间（非法值取边界，NaN/Infinity 取默认值） */
export function clampTtsRate(rate: number): number {
  if (!Number.isFinite(rate)) {
    return TTS_RATE_DEFAULT;
  }
  return Math.min(TTS_RATE_MAX, Math.max(TTS_RATE_MIN, rate));
}

/* ---------- 纠错问题类型文案 ---------- */

/**
 * 问题类型的中文展示文案。
 *
 * 原先 CorrectionCard 与 SettingsPage 各维护一份字面量 Map，文案一改就要同步两处。
 * 键覆盖 CorrectionIssue 全集；MistakePattern.issue 是 string（历史数据可能含未知值），
 * 故另行提供 issueLabel() 做兜底。
 */
export const ISSUE_LABEL: Record<CorrectionIssue, string> = {
  grammar: '语法',
  'word-choice': '用词',
  collocation: '搭配',
  idiom: '地道表达',
};

/** 未知/历史脏数据的兜底文案 */
const ISSUE_LABEL_FALLBACK = '表达';

/** 任意 issue 字符串 → 中文标签（未知值回落到「表达」） */
export function issueLabel(issue: string): string {
  return ISSUE_LABEL[issue as CorrectionIssue] ?? ISSUE_LABEL_FALLBACK;
}
