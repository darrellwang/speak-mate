/**
 * 历史会话页（pages/history/history.ts）
 *
 * 会话列表 + 左滑删除 + 「继续聊」（写回 currentSessionId 并切到练习页）。
 * 只读回看走 session-detail 页，这里只列摘要，避免一进页面就拉一大批消息。
 */

import { api } from '../../services/api';
import type { SessionListItem } from '../../types/models';
import { formatRelative } from '../../utils/format';
import { ApiError } from '../../utils/request';
import { getCurrentSessionId, setCurrentSessionId } from '../../utils/storage';

const PAGE_SIZE = 20;

interface IHistoryData {
  loading: boolean;
  loadingMore: boolean;
  sessions: SessionListItem[];
  hasMore: boolean;
  slideIndex: number;
}

interface IHistoryCustom {
  touchStartX: number;
  touchStartY: number;

  reload(): Promise<void>;
  loadMore(): Promise<void>;
  onOpenSession(e: WechatMiniprogram.TouchEvent): void;
  onContinue(e: WechatMiniprogram.TouchEvent): void;
  onDelete(e: WechatMiniprogram.TouchEvent): Promise<void>;
  onTouchStart(e: WechatMiniprogram.TouchEvent): void;
  onTouchMove(e: WechatMiniprogram.TouchEvent): void;
  onTouchEnd(): void;
}

Page<IHistoryData, IHistoryCustom>({
  data: {
    loading: false,
    loadingMore: false,
    sessions: [],
    hasMore: false,
    slideIndex: -1,
  },

  touchStartX: 0,
  touchStartY: 0,

  onShow() {
    void this.reload();
  },

  async reload(): Promise<void> {
    this.setData({ loading: true, slideIndex: -1 });
    try {
      const data = await api.listSessions({ limit: PAGE_SIZE, offset: 0 }, { silent: true });
      this.setData({
        sessions: data.items.map((item) => ({
          ...item,
          updated_text: formatRelative(item.updated_at),
        })),
        hasMore: data.has_more,
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
    if (!this.data.hasMore || this.data.loadingMore) return;
    this.setData({ loadingMore: true });
    try {
      const data = await api.listSessions(
        { limit: PAGE_SIZE, offset: this.data.sessions.length },
        { silent: true },
      );
      this.setData({
        sessions: [
          ...this.data.sessions,
          ...data.items.map((item) => ({
            ...item,
            updated_text: formatRelative(item.updated_at),
          })),
        ],
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

  onOpenSession(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { id?: string };
    const id = dataset.id ?? '';
    if (id === '') return;
    wx.navigateTo({ url: `/pages/session-detail/session-detail?id=${id}` });
  },

  /** 继续这个会话：写回当前会话并切到练习页 */
  onContinue(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { id?: string };
    const id = dataset.id ?? '';
    if (id === '') return;
    setCurrentSessionId(id);
    getApp<IAppOption>().globalData.currentSessionId = id;
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  async onDelete(e: WechatMiniprogram.TouchEvent): Promise<void> {
    const dataset = e.currentTarget.dataset as { idx?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    const session = this.data.sessions[idx];
    if (session === undefined) return;

    const confirmed = await new Promise<boolean>((resolve) => {
      wx.showModal({
        title: '删除会话',
        content: `删除后无法恢复，确定删除「${session.title || session.scene_name}」吗？`,
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
      await api.deleteSession(session.id, { silent: true });
      // 删的正好是当前会话 → 练习页回空态
      if (getCurrentSessionId() === session.id) {
        setCurrentSessionId('');
        getApp<IAppOption>().globalData.currentSessionId = '';
      }
      this.setData({
        sessions: this.data.sessions.filter((_, i) => i !== idx),
        slideIndex: -1,
      });
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (err) {
      wx.showToast({
        title: err instanceof ApiError ? err.message : '删除失败',
        icon: 'none',
      });
    }
  },

  /* ---------- 左滑 ---------- */

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
});
