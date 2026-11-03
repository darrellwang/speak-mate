/**
 * 词汇本页（pages/words/words.ts）
 *
 * 两个模式共用一个列表：
 * - 浏览模式：倒序列表 + 来源场景 + 左滑删除；
 * - 复习模式：释义默认遮盖，点开自测后打三档掌握度（=2 的词会注入画像，AI 不再解释）。
 */

import { api } from '../../services/api';
import type { MasteryLevel, Word } from '../../types/models';
import { ApiError } from '../../utils/request';

const PAGE_SIZE = 30;

/** 筛选档位：null = 全部 */
type MasteryFilter = MasteryLevel | null;

interface IWordsData {
  loading: boolean;
  loadingMore: boolean;
  words: Word[];
  total: number;
  hasMore: boolean;
  /** 筛选高亮（null = 全部） */
  filter: MasteryFilter;
  reviewMode: boolean;
  /** 复习模式下已翻开的词条下标 */
  revealed: number[];
  /** 左滑展开的条目下标（-1 = 无） */
  slideIndex: number;
  sceneNames: Record<string, string>;
}

interface IWordsCustom {
  touchStartX: number;
  touchStartY: number;

  reload(): Promise<void>;
  loadMore(): Promise<void>;
  onFilter(e: WechatMiniprogram.TouchEvent): void;
  onToggleReview(): void;
  onReveal(e: WechatMiniprogram.TouchEvent): void;
  onSetMastery(e: WechatMiniprogram.TouchEvent): Promise<void>;
  onTouchStart(e: WechatMiniprogram.TouchEvent): void;
  onTouchMove(e: WechatMiniprogram.TouchEvent): void;
  onTouchEnd(): void;
  onDeleteWord(e: WechatMiniprogram.TouchEvent): Promise<void>;
}

Page<IWordsData, IWordsCustom>({
  data: {
    loading: false,
    loadingMore: false,
    words: [],
    total: 0,
    hasMore: false,
    filter: null,
    reviewMode: false,
    revealed: [],
    slideIndex: -1,
    sceneNames: {},
  },

  touchStartX: 0,
  touchStartY: 0,

  onShow() {
    void this.reload();
  },

  async reload(): Promise<void> {
    this.setData({ loading: true, slideIndex: -1 });
    const names =
      (wx.getStorageSync('scene_name_map') as Record<string, string> | '') || {};
    this.setData({ sceneNames: names });
    try {
      const data = await api.listWords(
        {
          mastery: this.data.filter ?? undefined,
          limit: PAGE_SIZE,
          offset: 0,
          sort: 'created_desc',
        },
        { silent: true },
      );
      this.setData({
        words: data.items,
        total: data.total,
        hasMore: data.has_more,
        revealed: [],
      });
    } catch (err) {
      wx.showToast({
        title: err instanceof ApiError ? err.message : '加载失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  async loadMore(): Promise<void> {
    if (!this.data.hasMore || this.data.loadingMore || this.data.loading) return;
    this.setData({ loadingMore: true });
    try {
      const data = await api.listWords(
        {
          mastery: this.data.filter ?? undefined,
          limit: PAGE_SIZE,
          offset: this.data.words.length,
          sort: 'created_desc',
        },
        { silent: true },
      );
      this.setData({
        words: [...this.data.words, ...data.items],
        total: data.total,
        hasMore: data.has_more,
      });
    } finally {
      this.setData({ loadingMore: false });
    }
  },

  onReachBottom() {
    void this.loadMore();
  },

  async onPullDownRefresh(): Promise<void> {
    await this.reload();
    wx.stopPullDownRefresh();
  },

  onFilter(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { value?: string };
    const raw = dataset.value ?? 'all';
    const filter: MasteryFilter = raw === 'all' ? null : (Number.parseInt(raw, 10) as MasteryLevel);
    if (filter === this.data.filter) return;
    this.setData({ filter });
    void this.reload();
  },

  onToggleReview(): void {
    this.setData({ reviewMode: !this.data.reviewMode, revealed: [], slideIndex: -1 });
  },

  onReveal(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { idx?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    if (idx < 0 || this.data.revealed.indexOf(idx) >= 0) return;
    this.setData({ revealed: [...this.data.revealed, idx] });
  },

  async onSetMastery(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const dataset = e.currentTarget.dataset as { idx?: string; level?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    const level = Number.parseInt(dataset.level ?? '0', 10) as MasteryLevel;
    const word = this.data.words[idx];
    if (word === undefined || word.mastery_level === level) return;

    // 乐观更新：先改界面再发请求，网络慢时不至于卡手感
    this.setData({ [`words[${idx}].mastery_level`]: level } as never);
    try {
      const result = await api.updateWordMastery(word.id, level, { silent: true });
      this.setData({ [`words[${idx}]`]: result.word } as never);
    } catch (err) {
      this.setData({ [`words[${idx}].mastery_level`]: word.mastery_level } as never);
      wx.showToast({
        title: err instanceof ApiError ? err.message : '更新失败',
        icon: 'none',
      });
    }
  },

  /* ---------- 左滑删除 ---------- */

  onTouchStart(e: WechatMiniprogram.TouchEvent): void {
    const touch = e.touches[0];
    this.touchStartX = touch?.clientX ?? 0;
    this.touchStartY = touch?.clientY ?? 0;
  },

  onTouchMove(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { idx?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    const touch = e.touches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - this.touchStartX;
    const dy = touch.clientY - this.touchStartY;
    // 纵向滚动优先：纵向位移更大时不触发左滑
    if (Math.abs(dy) > Math.abs(dx)) return;
    if (dx < -24 && this.data.slideIndex !== idx) {
      this.setData({ slideIndex: idx });
    } else if (dx > 24 && this.data.slideIndex === idx) {
      this.setData({ slideIndex: -1 });
    }
  },

  onTouchEnd(): void {
    this.touchStartX = 0;
    this.touchStartY = 0;
  },

  async onDeleteWord(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const dataset = e.currentTarget.dataset as { idx?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    const word = this.data.words[idx];
    if (word === undefined) return;

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '删除词条',
        content: `确定删除「${word.word}」吗？`,
        confirmColor: '#E5484D',
        success: (res) => resolve(res.confirm),
        fail: () => resolve(false),
      });
    });
    if (!confirmed) {
      this.setData({ slideIndex: -1 });
      return;
    }
    try {
      await api.deleteWord(word.id, { silent: true });
      this.setData({
        words: this.data.words.filter((_, i) => i !== idx),
        slideIndex: -1,
        total: Math.max(0, this.data.total - 1),
      });
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showToast({
        title: err instanceof ApiError ? err.message : '删除失败',
        icon: 'none',
      });
    }
  },
});
