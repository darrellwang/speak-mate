/**
 * 训练器进度存储（utils/handbookStorage.ts）
 *
 * 包装 wx.setStorageSync 读写训练进度。进度按下标存，句库一旦整体替换
 * 就不能沿用旧 key，否则「已掌握」会对到错误的句子上。
 *
 * 进度结构：{ [idx]: { s: 'new'|'known'|'weak', star: 0|1, seen: n } }
 * idx 是 data/handbook.json items 数组下标（0 起，当前共 648 条）。
 */

import type { HandbookMastery, HandbookProgress, HandbookProgressEntry } from '../types/handbook';

const KEY = 'workplace-english-trainer-v1';
/** 旧 Karat 232 条句库的进度。下标和新句库对不上，读到就丢掉。 */
const LEGACY_KEY = 'karat-english-trainer-v1';

function discardLegacyProgress(): void {
  try {
    wx.removeStorageSync(LEGACY_KEY);
  } catch {
    // 旧 key 不存在时忽略
  }
}

const DEFAULT_ENTRY: HandbookProgressEntry = { s: 'new', star: 0, seen: 0 };

/** 读取全量进度（空对象 = 全新用户） */
export function getProgress(): HandbookProgress {
  discardLegacyProgress();
  const raw = wx.getStorageSync(KEY);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  return raw as HandbookProgress;
}

/** 全量覆盖写回（外部修改后调用） */
export function saveProgress(progress: HandbookProgress): void {
  wx.setStorageSync(KEY, progress);
}

/** 取单条进度（缺失返回默认值，不写回） */
export function getEntry(progress: HandbookProgress, idx: number): HandbookProgressEntry {
  const entry = progress[idx];
  if (entry === undefined) return { ...DEFAULT_ENTRY };
  return entry;
}

/** 确保 progress[idx] 存在（不存在则写入默认值并返回引用，便于外部直接改字段） */
export function ensureEntry(progress: HandbookProgress, idx: number): HandbookProgressEntry {
  if (progress[idx] === undefined) {
    progress[idx] = { ...DEFAULT_ENTRY };
  }
  return progress[idx] as HandbookProgressEntry;
}

/** 标记掌握状态并落盘 */
export function setMastery(idx: number, mastery: HandbookMastery): HandbookProgress {
  const progress = getProgress();
  const entry = ensureEntry(progress, idx);
  entry.s = mastery;
  saveProgress(progress);
  return progress;
}

/** 切换收藏并落盘 */
export function toggleStar(idx: number): HandbookProgress {
  const progress = getProgress();
  const entry = ensureEntry(progress, idx);
  entry.star = entry.star === 1 ? 0 : 1;
  saveProgress(progress);
  return progress;
}

/** 累加练习次数并落盘（next() 调用） */
export function bumpSeen(idx: number): HandbookProgress {
  const progress = getProgress();
  const entry = ensureEntry(progress, idx);
  entry.seen += 1;
  saveProgress(progress);
  return progress;
}

/** 清空所有进度（设置页「重置进度」） */
export function clearProgress(): HandbookProgress {
  wx.removeStorageSync(KEY);
  return {};
}

/**
 * 统计摘要：已练 / 已掌握 / 模糊 / 收藏 数量。
 * 传入 items 总数用于计算进度条宽度。
 */
export interface ProgressStats {
  total: number;
  seen: number;
  known: number;
  weak: number;
  starred: number;
}

export function getStats(total: number): ProgressStats {
  const progress = getProgress();
  let seen = 0;
  let known = 0;
  let weak = 0;
  let starred = 0;
  for (let i = 0; i < total; i += 1) {
    const entry = progress[i];
    if (entry === undefined) continue;
    if (entry.seen > 0) seen += 1;
    if (entry.s === 'known') known += 1;
    else if (entry.s === 'weak') weak += 1;
    if (entry.star === 1) starred += 1;
  }
  return { total, seen, known, weak, starred };
}
