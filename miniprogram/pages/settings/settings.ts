/**
 * 设置页（pages/settings/settings.ts）
 *
 * P2-5 多用户后新增三块：
 * - 当前账号（展示服务端返回的随机昵称，让用户知道"我"是谁）；
 * - 访问令牌（主人填写管理员 ACCESS_TOKEN；普通用户走 wx.login 静默登录，无需填写）；
 * - 清除我的数据（PIPL 删除权：删除自己的会话、词汇本与学习画像）。
 *
 * 其余保持：
 * - 测试连接（验证后端是否在线）——已从首屏挪进「高级」卡片，与其它排障项归堆；
 * - TTS 开关/语速、流式开关；
 * - 语音引擎状态与启用提示；
 * - 学习画像（只读展示，让用户看到 AI 记住了什么）。
 */

import type { Settings } from '../../config';
import { DEFAULT_BASE_URL } from '../../config';
import { api } from '../../services/api';
import type { ConfigData, ProfileSummary } from '../../types/api';
import { clearToken, forceLogin, getCachedUser, getToken } from '../../utils/auth';
import { categoryLabel } from '../../utils/format';
import { ApiError, http } from '../../utils/request';
import { isChunkedSupported } from '../../utils/sse';
import {
  clearSettings,
  getAdminToken,
  getSettings,
  saveSettings,
  setAdminToken,
} from '../../utils/storage';

interface MistakeItem {
  pattern: string;
  corrected: string;
  count: number;
}

/**
 * 后端 /api/config 的 tts.engine → 展示文案。
 *
 * kokoro-local = 本地 Kokoro 模型离线合成（默认，完全不依赖外网）；
 * edge-tts     = 在线微软 Edge TTS（本地引擎不可用时的回退方案）。
 */
const TTS_ENGINE_NAMES: Record<string, string> = {
  'kokoro-local': '本地 AI 语音',
  'edge-tts': '微软在线语音',
};

const TTS_ENGINE_LABELS: Record<string, string> = {
  'kokoro-local': '本地 AI 语音（离线合成）',
  'edge-tts': '微软在线语音（需联网）',
};

/**
 * 试听用的固定句子。
 *
 * 选它是因为：短（合成约 0.7s，点击后很快出声）、含多种元音辅音
 * （能听出音色差异）、且是标准英语表达。
 */
const PREVIEW_TEXT = "Hi! This is how I'll sound. Ready to practice?";

/**
 * 试听播放用的 InnerAudioContext（页面级单例）。
 *
 * ⚠️ 必须显式 destroy：官方文档明确「InnerAudioContext 音频资源不会自动释放」，
 * 不销毁会造成内存泄漏。onUnload 时统一清理。
 */
let previewAudio: WechatMiniprogram.InnerAudioContext | null = null;

/**
 * 页面当前是否「可见且未卸载」。
 *
 * 下载音频是异步的，两种情况必须在回调里挡一下：
 * - 用户已离开页面 → setData 会报 "setData of a destroyed page"；
 * - 页面切到后台 → 若不挡，下载完成会在后台突然出声。
 */
let pageActive = true;

/**
 * 试听状态：idle 空闲 / loading 合成中 / playing 播放中。
 * 合成中与播放中再次点击按钮 = 停止。
 */
type PreviewState = 'idle' | 'loading' | 'playing';

interface ISettingsData {
  ttsEnabled: boolean;
  ttsRate: number;
  streamingEnabled: boolean;
  speechEngine: string;
  /** 基础库是否真的支持分块流（决定流式开关能否生效） */
  chunkedSupported: boolean;
  testing: boolean;
  testResult: string;
  serverInfo: ConfigData | null;
  profile: ProfileSummary | null;
  mistakes: MistakeItem[];
  topScenes: { name: string; count: number }[];
  /** 当前账号昵称（服务端随机生成） */
  nickname: string;
  /** 是否已登录（false = 尚未完成静默登录） */
  loggedIn: boolean;
  /** 管理员令牌草稿 */
  adminToken: string;
  /** 是否已填管理员令牌 */
  hasAdminToken: boolean;
  /** 正在清除数据 */
  clearing: boolean;
  /** 朗读音色：picker 的展示标签列表（来自 /api/config 的 tts.voices） */
  voiceLabels: string[];
  /** 当前选中的音色下标（对应 voiceLabels） */
  voiceIndex: number;
  /** 当前音色的展示标签 */
  currentVoiceLabel: string;
  /** TTS 引擎简称（用于「语音引擎」行的描述拼接） */
  ttsEngineName: string;
  /** TTS 引擎全称（用于信息区展示） */
  ttsEngineLabel: string;
  /** 试听状态：idle / loading / playing */
  previewState: PreviewState;
}

interface ISettingsCustom {
  loadProfile(): Promise<void>;
  loadAccount(): Promise<void>;
  onTest(): Promise<void>;
  onTtsToggle(e: WechatMiniprogram.SwitchChange): void;
  onStreamToggle(e: WechatMiniprogram.SwitchChange): void;
  onRateChange(e: WechatMiniprogram.SliderChange): void;
  onVoiceChange(e: WechatMiniprogram.PickerChange): void;
  onPreviewTts(): void;
  /** 播放已下载的试听音频（内部） */
  playPreview(filePath: string): void;
  /** 停止试听（内部） */
  stopPreview(reset?: boolean): void;
  /** 释放 InnerAudioContext（内部） */
  destroyPreviewAudio(): void;
  onRestoreDefault(): void;
  onEndSession(): void;
  onSpeechEngineChange(e: WechatMiniprogram.SwitchChange): void;
  onPrivacy(): void;
  onAdminTokenInput(e: WechatMiniprogram.Input): void;
  onSaveAdminToken(): void;
  onClearAdminToken(): void;
  onClearMyData(): void;
  onRelogin(): void;
}

Page<ISettingsData, ISettingsCustom>({
  data: {
    ttsEnabled: true,
    ttsRate: 1,
    streamingEnabled: true,
    speechEngine: 'text-only',
    chunkedSupported: false,
    testing: false,
    testResult: '',
    serverInfo: null,
    profile: null,
    mistakes: [],
    topScenes: [],
    nickname: '',
    loggedIn: false,
    adminToken: '',
    hasAdminToken: false,
    clearing: false,
    voiceLabels: [] as string[],
    voiceIndex: 0,
    currentVoiceLabel: '默认音色',
    /** TTS 引擎的展示名（本地 Kokoro / 微软在线），从 /api/config 的 tts.engine 映射 */
    ttsEngineName: '本地 AI 语音',
    /** 信息区的引擎全称 */
    ttsEngineLabel: '本地 AI 语音（离线）',
    previewState: 'idle' as PreviewState,
  },

  onShow() {
    pageActive = true;
    const settings = getSettings();
    const cached = getCachedUser();
    this.setData({
      ttsEnabled: settings.ttsEnabled,
      ttsRate: settings.ttsRate,
      streamingEnabled: settings.streamingEnabled,
      speechEngine: settings.speechEngine,
      chunkedSupported: isChunkedSupported(),
      nickname: cached?.nickname ?? '',
      loggedIn: cached !== null,
      adminToken: getAdminToken(),
      hasAdminToken: getAdminToken() !== '',
    });
    void this.loadProfile();
  },

  /** 页面切到后台：停止试听，避免后台还在出声 */
  onHide(): void {
    pageActive = false;
    this.stopPreview();
  },

  /** 页面卸载：释放 InnerAudioContext（官方要求，否则内存泄漏） */
  onUnload(): void {
    pageActive = false;
    this.stopPreview();
  },

  async loadProfile(): Promise<void> {
    try {
      const [profile, config] = await Promise.all([
        api.getProfile({ silent: true }),
        api.getConfig({ silent: true }),
      ]);
      const names = (wx.getStorageSync('scene_name_map') as Record<string, string> | '') || {};
      // 音色列表：来自后端白名单（/api/config 的 tts.voices）
      const voices = config.tts?.voices ?? [];
      const voiceLabels = voices.map((v) => v.label);
      const currentVoice = getSettings().ttsVoice;
      const voiceIndex = Math.max(
        0,
        voices.findIndex((v) => v.id === currentVoice),
      );
      this.setData({
        profile,
        serverInfo: config,
        voiceLabels,
        voiceIndex,
        currentVoiceLabel: voiceLabels[voiceIndex] ?? '默认音色',
        ttsEngineName: TTS_ENGINE_NAMES[config.tts?.engine ?? ''] ?? 'AI 朗读',
        ttsEngineLabel: TTS_ENGINE_LABELS[config.tts?.engine ?? ''] ?? 'AI 朗读',
        mistakes: profile.common_mistakes.slice(0, 5).map((m) => ({
          pattern: m.pattern,
          corrected: m.corrected,
          count: m.count,
        })),
        topScenes: profile.preferred_scenes.slice(0, 3).map((s) => ({
          name: names[s.scene_id] ?? categoryLabel(s.scene_id),
          count: s.count,
        })),
      });
    } catch {
      // 画像拉不到不影响设置页本身
    }
    void this.loadAccount();
  },

  /** 拉取当前账号信息（服务端返回的随机昵称） */
  async loadAccount(): Promise<void> {
    try {
      const res = await http.get<{ user: { nickname: string } }>('/api/auth/me', { silent: true });
      this.setData({ nickname: res.user.nickname, loggedIn: true });
    } catch {
      // 未登录或后端不可达：保持现状
    }
  },

  /* ---------- 测试连接 ---------- */

  async onTest(): Promise<void> {
    if (this.data.testing) return;
    this.setData({ testing: true, testResult: '连接中…' });
    try {
      const health = await api.getHealth({ silent: true });
      this.setData({
        testResult: `连接成功 · ${health.llm.provider} / ${health.llm.model}`,
      });
    } catch (err) {
      this.setData({
        testResult: err instanceof ApiError ? err.message : '连接失败',
      });
    } finally {
      this.setData({ testing: false });
    }
  },

  /* ---------- 开关 ---------- */

  onTtsToggle(e: WechatMiniprogram.SwitchChange): void {
    const value = e.detail.value;
    this.setData({ ttsEnabled: value });
    const settings = saveSettings({ ttsEnabled: value });
    getApp<IAppOption>().globalData.settings = settings;
  },

  onStreamToggle(e: WechatMiniprogram.SwitchChange): void {
    const value = e.detail.value;
    this.setData({ streamingEnabled: value });
    const settings = saveSettings({ streamingEnabled: value });
    getApp<IAppOption>().globalData.settings = settings;
  },

  onRateChange(e: WechatMiniprogram.SliderChange): void {
    const rate = Math.round(Number(e.detail.value) * 10) / 10;
    this.setData({ ttsRate: rate });
    const settings = saveSettings({ ttsRate: rate });
    getApp<IAppOption>().globalData.settings = settings;
  },

  /** 音色选择（picker）：列表来自 /api/config 的 tts.voices 白名单 */
  onVoiceChange(e: WechatMiniprogram.PickerChange): void {
    const idx = Number(e.detail.value);
    const voices = this.data.serverInfo?.tts?.voices ?? [];
    const picked = voices[idx];
    if (picked === undefined) return;
    this.setData({
      voiceIndex: idx,
      currentVoiceLabel: picked.label,
    });
    const settings = saveSettings({ ttsVoice: picked.id });
    getApp<IAppOption>().globalData.settings = settings;
  },

  /* ---------- 音色试听 ---------- */

  /**
   * 试听当前选中的音色（用当前语速合成一句固定台词并播放）。
   *
   * 交互约定：
   * - 合成中 / 播放中再次点击 = 停止（按钮文案会变成「停止」）；
   * - 试听独立于「AI 回复自动朗读」开关——即使关掉自动朗读也能试听音色；
   * - 语速会一并传给后端（SSML rate），所以听到的就是真实播报效果。
   */
  onPreviewTts(): void {
    if (this.data.previewState !== 'idle') {
      this.stopPreview();
      return;
    }

    const settings = getSettings();
    const base = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const token = getToken();
    const header: Record<string, string> =
      token === '' ? {} : { Authorization: `Bearer ${token}` };

    // 语速倍率 → 后端的 SSML rate（1.2x → "+20%"，0.8x → "-20%"）
    const pct = Math.round((settings.ttsRate - 1) * 100);
    const rate = pct === 0 ? '+0%' : `${pct > 0 ? '+' : ''}${pct}%`;

    const url =
      `${base}/api/tts?voice=${encodeURIComponent(settings.ttsVoice || 'en-US-JennyNeural')}` +
      `&rate=${encodeURIComponent(rate)}` +
      `&text=${encodeURIComponent(PREVIEW_TEXT)}`;

    this.setData({ previewState: 'loading' });

    wx.downloadFile({
      url,
      header,
      success: (res) => {
        // 页面可能已卸载（用户切走），此时不要 setData / 播放
        if (!pageActive) return;
        if (res.statusCode !== 200) {
          this.setData({ previewState: 'idle' });
          wx.showToast({ title: `试听失败（${res.statusCode}）`, icon: 'none' });
          return;
        }
        this.playPreview(res.tempFilePath);
      },
      fail: () => {
        if (!pageActive) return;
        this.setData({ previewState: 'idle' });
        wx.showToast({ title: '试听失败，请检查后端服务', icon: 'none' });
      },
    });
  },

  /** 播放已下载的试听音频 */
  playPreview(filePath: string): void {
    // 先清掉上一次的实例，避免两个 InnerAudioContext 同时发声
    this.stopPreview(false);

    const audio = wx.createInnerAudioContext();
    previewAudio = audio;
    audio.src = filePath;
    // 后端已按 rate 参数合成好语速，这里保持原速播放——
    // 这样听到的音色与语速，就是对话页真实播报的效果。
    audio.playbackRate = 1;
    // 试听是用户主动触发的，静音键不应吞掉声音（否则会以为功能坏了）
    audio.obeyMuteSwitch = false;

    audio.onEnded(() => {
      this.setData({ previewState: 'idle' });
      this.destroyPreviewAudio();
    });
    audio.onError(() => {
      this.setData({ previewState: 'idle' });
      this.destroyPreviewAudio();
      wx.showToast({ title: '播放失败', icon: 'none' });
    });

    audio.play();
    this.setData({ previewState: 'playing' });
  },

  /** 停止试听（reset=false 时只释放资源，不改按钮状态） */
  stopPreview(reset = true): void {
    this.destroyPreviewAudio();
    if (reset) {
      this.setData({ previewState: 'idle' });
    }
  },

  /** 释放 InnerAudioContext（官方要求：不用时必须 destroy，否则内存泄漏） */
  destroyPreviewAudio(): void {
    if (previewAudio === null) return;
    try {
      previewAudio.stop();
    } catch {
      /* 实例可能已被系统回收，忽略 */
    }
    try {
      previewAudio.destroy();
    } catch {
      /* 同上 */
    }
    previewAudio = null;
  },

  onRestoreDefault(): void {
    wx.showModal({
      title: '恢复默认设置',
      content: '语音与播报设置将恢复默认，确定吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return;
        const settings = clearSettings();
        getApp<IAppOption>().globalData.settings = settings;
        this.setData({
          ttsEnabled: settings.ttsEnabled,
          ttsRate: settings.ttsRate,
          streamingEnabled: settings.streamingEnabled,
          speechEngine: settings.speechEngine,
          testResult: '',
        });
        wx.showToast({ title: '已恢复默认', icon: 'success' });
      },
    });
  },

  /** 结束当前会话（练习页回到空态） */
  onEndSession(): void {
    wx.showModal({
      title: '结束当前会话',
      content: '只是回到选择场景的状态，历史记录不会被删除。',
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync('current_session_id');
        getApp<IAppOption>().globalData.currentSessionId = '';
        wx.switchTab({ url: '/pages/chat/chat' });
      },
    });
  },

  /** 切换语音引擎（纯文字 ↔ 智能语音） */
  onSpeechEngineChange(e: WechatMiniprogram.SwitchChange): void {
    const next: Settings['speechEngine'] = e.detail.value ? 'wechat-si' : 'text-only';
    this.setData({ speechEngine: next });
    const settings = saveSettings({ speechEngine: next });
    getApp<IAppOption>().globalData.settings = settings;
    wx.showToast({
      title: next === 'wechat-si' ? '已启用智能语音' : '已切回纯文字',
      icon: 'none',
      duration: 2200,
    });
  },

  /** 跳转隐私政策页 */
  onPrivacy(): void {
    wx.navigateTo({ url: '/pages/privacy/privacy' });
  },

  /* ---------- 账号与令牌（P2-5）---------- */

  onAdminTokenInput(e: WechatMiniprogram.Input): void {
    this.setData({ adminToken: e.detail.value });
  },

  /** 保存管理员令牌：填入后立即生效（优先于微信静默登录） */
  onSaveAdminToken(): void {
    const token = this.data.adminToken.trim();
    if (token === '') {
      wx.showToast({ title: '令牌不能为空', icon: 'none' });
      return;
    }
    setAdminToken(token);
    this.setData({ hasAdminToken: true, adminToken: token });
    wx.showToast({ title: '令牌已保存', icon: 'success' });
    void this.loadProfile();
  },

  /** 清除管理员令牌：恢复为微信静默登录身份 */
  onClearAdminToken(): void {
    wx.showModal({
      title: '清除访问令牌',
      content: '清除后将改用微信账号身份登录，你将看到该账号自己的数据。确定吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return;
        setAdminToken('');
        this.setData({ hasAdminToken: false, adminToken: '' });
        wx.showToast({ title: '已清除', icon: 'success' });
        void this.loadProfile();
      },
    });
  },

  /** 重新登录（令牌失效或换了微信账号时使用） */
  onRelogin(): void {
    wx.showToast({ title: '重新登录中…', icon: 'none' });
    clearToken();
    forceLogin()
      .then(() => {
        wx.showToast({ title: '登录成功', icon: 'success' });
        void this.loadProfile();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : '登录失败';
        wx.showToast({ title: message, icon: 'none', duration: 2600 });
      });
  },

  /**
   * 清除我的数据（PIPL 删除权）。
   *
   * 删除当前账号的会话、消息、词汇本与学习画像；账号本身保留，
   * 删除后可以重新开始积累。
   */
  onClearMyData(): void {
    if (this.data.clearing) return;
    wx.showModal({
      title: '清除我的数据',
      content: '将删除你的全部对话记录、词汇本与学习画像，且不可恢复。确定吗？',
      confirmColor: '#E5484D',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ clearing: true });
        http.del<{ deleted: { sessions: number; words: number } }>('/api/me/data', { silent: true })
          .then((res2) => {
            const d = res2.deleted;
            wx.showToast({
              title: `已清除 ${d.sessions} 个会话 / ${d.words} 个词条`,
              icon: 'none',
              duration: 2600,
            });
            void this.loadProfile();
          })
          .catch((err: unknown) => {
            const message = err instanceof ApiError ? err.message : '清除失败';
            wx.showToast({ title: message, icon: 'none', duration: 2600 });
          })
          .finally(() => {
            this.setData({ clearing: false });
          });
      },
    });
  },
});
