/**
 * 展示层格式化（utils/format.ts）
 *
 * 只做「展示用」的纯函数：时间、场景分类、句子切分。
 * 全部同步、无依赖，便于在 wxml 里通过 wxs 或预先计算后绑定。
 */

import type { DiffToken } from '../types/handbook';
import type { SceneCategory } from '../types/models';

const CATEGORY_LABEL: Record<SceneCategory, string> = {
  it: 'IT 职场',
  life: '日常生活',
  interview: '面试',
};

export function categoryLabel(category: string): string {
  return CATEGORY_LABEL[category as SceneCategory] ?? '其它';
}

const CATEGORY_ORDER: SceneCategory[] = ['it', 'life', 'interview'];

export function categoryOrder(): SceneCategory[] {
  return [...CATEGORY_ORDER];
}

/** ISO 时间 → 本地时间字符串（YYYY-MM-DD HH:mm） */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
}

/** 相对时间：今天显示时刻，昨天显示「昨天」，更早显示日期 */
export function formatRelative(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diffDays = Math.floor((startOfToday - date.getTime()) / 86400000);

  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (diffDays <= 0) return time;
  if (diffDays === 1) return `昨天 ${time}`;
  if (diffDays < 365) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 英文句子切分（TTS 首句即播用）。
 *
 * 刻意不用 `/(?<=[.!?])\s+/` 后行断言：小程序 JS 引擎（尤其旧版 iOS WebView）
 * 对 ES2018 正则后行断言支持不一致，运行时可能直接抛语法错误。手写逐字扫描最稳。
 * 切分后过短的片段（<3 词）并入上一句，避免 "Hi." 被单独朗读。
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (/[.!?。！？]/.test(char)) {
      const trimmed = current.trim();
      if (trimmed !== '') sentences.push(trimmed);
      current = '';
    }
  }
  const tail = current.trim();
  if (tail !== '') sentences.push(tail);

  // 过短片段并入上一句
  const merged: string[] = [];
  for (const sentence of sentences) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last.split(/\s+/).length < 3) {
      merged[merged.length - 1] = `${last} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }
  return merged;
}

/** 英文分词（长按选词用）：保留标点归属，过滤空串 */
export function tokenizeEnglish(text: string): string[] {
  return text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t !== '');
}

/** 掌握度文案 */
export function masteryLabel(level: number): string {
  if (level === 2) return '已掌握';
  if (level === 1) return '熟悉';
  return '生疏';
}

/* ------------------------------------------------------------------ *
 * 以下为训练器（pages/trainer）专用工具，从 H5 端 trainer_template.html
 * 移植而来。源项目：D:\work\myresume\trainer_template.html
 * 保持算法一致，便于两端行为对齐。
 * ------------------------------------------------------------------ */

/**
 * 代码符号转读音（normalize）。
 *
 * 让 TTS 把 `+=`、`O(n)`、`KeyError` 这类技术符号念得更像人话。
 * 与 H5 端 normalize() 保持同一套规则——改一处要同步改另一处。
 */
export function normalizeForTts(text: string): string {
  const map: ReadonlyArray<[RegExp, string]> = [
    [/\+=/g, ' plus equals '],
    [/===/g, ' triple equals '],
    [/==/g, ' equals '],
    [/!=/g, ' not equals '],
    [/<=/g, ' less than or equal to '],
    [/>=/g, ' greater than or equal to '],
    [/->/g, ' arrow '],
    [/=>/g, ' arrow '],
    [/\bNone\b/g, 'none'],
    [/\bnil\b/g, 'nil'],
    [/\bA-Z\b/g, 'A Z'],
    [/\bO\(n\)/g, 'O of n'],
    [/\bk log k/g, 'k log k'],
    [/\bC-I-D\b/g, 'C I D'],
    [/\bKey-Error\b/g, 'key error'],
    [/\bKeyError\b/g, 'key error'],
    [/\//g, ', '],
  ];
  let s = ` ${text} `;
  for (const [pattern, replacement] of map) {
    s = s.replace(pattern, replacement);
  }
  return s.replace(/\s+/g, ' ').trim();
}

/** 英文分词（diff 用）：小写化、去标点、按空白拆分、过滤空串 */
function tokenizeForDiff(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9'\- ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');
}

/**
 * 英文听写 / 跟读 diff：LCS（最长公共子序列）逐词比对。
 *
 * 算法与 H5 端 diff() 完全一致，只是返回结构化 DiffToken[]
 * 而不是 HTML 字符串——小程序 wxml 用 wx:for 渲染。
 *
 * - good：答案有、用户也写了（命中）
 * - miss：答案有、用户漏写（黄色）
 * - bad：用户写了但答案没有（红色，多余或拼错）
 */
export function diffEnglish(answer: string, typed: string): DiffToken[] {
  const A = tokenizeForDiff(answer);
  const B = tokenizeForDiff(typed);
  const n = A.length;
  const m = B.length;
  // dp[i][j] = A[i:] 与 B[j:] 的 LCS 长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffToken[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ text: A[i], kind: 'good' });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ text: A[i], kind: 'miss' });
      i += 1;
    } else {
      out.push({ text: B[j], kind: 'bad' });
      j += 1;
    }
  }
  while (i < n) {
    out.push({ text: A[i], kind: 'miss' });
    i += 1;
  }
  while (j < m) {
    out.push({ text: B[j], kind: 'bad' });
    j += 1;
  }
  return out;
}
