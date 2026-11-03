/**
 * 会话回看页（pages/session-detail/session-detail.ts）
 *
 * 只读回看：用同一个 message-bubble 组件渲染，但关闭交互（不弹选词、不显示入库按钮），
 * 避免用户误以为在回看页的操作也会写进词汇本。
 * 想继续聊 → 写回 currentSessionId 再 switchTab 到练习页。
 */

import { api } from '../../services/api';
import type { Message } from '../../types/models';
import { formatRelative } from '../../utils/format';
import { ApiError } from '../../utils/request';
import { setCurrentSessionId } from '../../utils/storage';

interface DisplayMessage extends Message {
  timeText?: string;
}

interface IDetailData {
  sessionId: string;
  sceneName: string;
  messages: DisplayMessage[];
  loading: boolean;
  /** 会话已删除（后端 404） */
  missing: boolean;
}

interface IDetailCustom {
  load(id: string): Promise<void>;
  onContinue(): void;
  goScenes(): void;
}

Page<IDetailData, IDetailCustom>({
  data: {
    sessionId: '',
    sceneName: '',
    messages: [],
    loading: false,
    missing: false,
  },

  onLoad(options: Record<string, string | undefined>) {
    const id = options.id ?? '';
    if (id === '') {
      this.setData({ missing: true });
      return;
    }
    this.setData({ sessionId: id });
    void this.load(id);
  },

  async load(id: string): Promise<void> {
    this.setData({ loading: true });
    try {
      const detail = await api.getSessionDetail(
        id,
        { msg_limit: 200 },
        { silent: true },
      );
      const names = (wx.getStorageSync('scene_name_map') as Record<string, string> | '') || {};
      const sceneName = names[detail.session.scene_id] ?? detail.session.scene_id;
      this.setData({
        messages: detail.messages.map((m) => ({
          ...m,
          corrections: m.corrections ?? [],
          vocab_suggestions: m.vocab_suggestions ?? [],
          timeText: formatRelative(m.created_at),
        })),
        sceneName,
      });
      wx.setNavigationBarTitle({ title: sceneName });
    } catch (err) {
      if (err instanceof ApiError && err.code === 2001) {
        this.setData({ missing: true });
        return;
      }
      wx.showToast({
        title: err instanceof ApiError ? err.message : '加载失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onContinue(): void {
    const id = this.data.sessionId;
    if (id === '') return;
    setCurrentSessionId(id);
    getApp<IAppOption>().globalData.currentSessionId = id;
    wx.switchTab({ url: '/pages/chat/chat' });
  },

  goScenes(): void {
    wx.navigateTo({ url: '/pages/scenes/scenes' });
  },
});
