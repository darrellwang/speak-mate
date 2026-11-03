/**
 * 场景选择页（pages/scenes/scenes.ts）
 *
 * 场景数据来自服务端 /api/scenes（与后端共用 shared/scenes.json 一份事实源），
 * 不做本地硬编码——否则改了场景库要发两处版本。
 *
 * 选中即创建会话并跳回对话页：小程序 tabBar 之间只能 switchTab，
 * 所以会话 id 写进 globalData + Storage，由对话页 onShow 自行装载。
 */

import { api } from '../../services/api';
import type { Scene } from '../../types/models';
import { categoryLabel, categoryOrder } from '../../utils/format';
import { pushRecentSceneId } from '../../utils/storage';

interface SceneGroup {
  category: string;
  label: string;
  scenes: Scene[];
}

interface IScenesData {
  loading: boolean;
  creating: boolean;
  groups: SceneGroup[];
  recent: Scene[];
  /** 延续上次话题（新会话基于最近会话尾部生成开场白） */
  continueMode: boolean;
}

interface IScenesCustom {
  load(): Promise<void>;
  onToggleContinue(e: WechatMiniprogram.SwitchChange): void;
  onPickScene(e: WechatMiniprogram.TouchEvent): Promise<void>;
}

Page<IScenesData, IScenesCustom>({
  data: {
    loading: false,
    creating: false,
    groups: [],
    recent: [],
    continueMode: false,
  },

  async onLoad() {
    await this.load();
  },

  async load(): Promise<void> {
    this.setData({ loading: true });
    try {
      const data = await api.getScenes({ silent: true });
      // 场景名缓存：对话页/历史页展示场景中文名时复用，省一次请求
      const nameMap: Record<string, string> = {};
      data.scenes.forEach((scene) => {
        nameMap[scene.id] = scene.name;
      });
      wx.setStorageSync('scene_name_map', nameMap);

      const groups: SceneGroup[] = categoryOrder()
        .map((category) => ({
          category,
          label: categoryLabel(category),
          scenes: data.scenes.filter((scene) => scene.category === category),
        }))
        .filter((group) => group.scenes.length > 0);

      // 兜底：出现未知分类时也别把场景藏起来
      const known = new Set(groups.flatMap((g) => g.scenes.map((s) => s.id)));
      const others = data.scenes.filter((scene) => !known.has(scene.id));
      if (others.length > 0) {
        groups.push({ category: 'other', label: '其它', scenes: others });
      }

      const recent = (data.recent_scene_ids ?? [])
        .map((id) => data.scenes.find((scene) => scene.id === id))
        .filter((scene): scene is Scene => scene !== undefined);

      this.setData({ groups, recent });
    } catch {
      wx.showToast({ title: '场景加载失败，请检查后端', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onToggleContinue(e: WechatMiniprogram.SwitchChange): void {
    this.setData({ continueMode: e.detail.value });
  },

  async onPickScene(e: WechatMiniprogram.TouchEvent): Promise<void> {
    if (this.data.creating) return;
    const dataset = e.currentTarget.dataset as { id?: string };
    const sceneId = dataset.id ?? '';
    if (sceneId === '') return;

    this.setData({ creating: true });
    wx.showLoading({ title: '准备中…', mask: true });
    try {
      const result = await api.createSession(
        { scene_id: sceneId, continue_from_last: this.data.continueMode },
        { silent: true },
      );
      pushRecentSceneId(sceneId);
      const app = getApp<IAppOption>();
      app.globalData.currentSessionId = result.session.id;
      wx.setStorageSync('current_session_id', result.session.id);
      wx.hideLoading();
      wx.switchTab({ url: '/pages/chat/chat' });
    } catch {
      wx.hideLoading();
      wx.showToast({ title: '创建会话失败，请重试', icon: 'none' });
    } finally {
      this.setData({ creating: false });
    }
  },
});
