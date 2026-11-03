/**
 * 对话页（pages/chat/chat.ts）
 *
 * 整个小程序的心脏：消息流 + 流式渲染 + 语音输入 + TTS 播报 + 点词查词。
 *
 * 与 H5 端 useChat 的三点差异（都是小程序运行时逼出来的）：
 * 1. **setData 必须节流**：每次调用都要跨 JS↔渲染层通信，LLM 每秒吐几十个 delta，
 *    直接转发会卡死界面。这里用 80ms 窗口合并写入。
 * 2. **当前会话靠 globalData + Storage 传递**：tabBar 页之间只能 switchTab，
 *    没有 query 参数，也没有 router state。
 * 3. **点词查词改为「长按 → 分词点选」**：小程序无法自由选取文本，
 *    只能把整句切成词块让用户点选。
 */

import { createSpeechAdapter } from '../../speech/index';
import type { AsrSession, SpeechAdapter, TtsController } from '../../speech/adapter';
import { api } from '../../services/api';
import type { Correction, VocabSuggestion } from '../../types/chat';
import type { Message, WordDefineResult } from '../../types/models';
import { formatRelative, splitSentences, tokenizeEnglish } from '../../utils/format';
import { ensurePrivacyAuthorized, openPrivacyContract } from '../../utils/privacy';
import { diag, resetDiagClock } from '../../utils/diag';
import { ApiError } from '../../utils/request';
import { sendChat, type ChatTask } from '../../utils/sse';
import { getCurrentSessionId, setCurrentSessionId } from '../../utils/storage';

interface DisplayMessage extends Message {
  streaming?: boolean;
  failed?: boolean;
  timeText?: string;
  /** 当前正在朗读的句子（非空时气泡高亮该句） */
  highlightText?: string;
}

interface WordToken {
  text: string;
  selected: boolean;
}


/** setData 合并窗口：再快人眼看不出，再慢就会觉得卡 */
const FLUSH_INTERVAL = 80;

const SCENE_NAME_MAP_KEY = 'scene_name_map';

Page({
  data: {
    sessionId: '',
    sceneName: '',
    messages: [] as DisplayMessage[],
    hasSession: false,
    loading: false,
    sending: false,
    inputText: '',
    recording: false,
    interimText: '',
    asrSupported: false,
    ttsSupported: false,
    speaking: false,
    scrollAnchor: '',
    pickerVisible: false,
    pickerTokens: [] as WordToken[],
    pickerBusy: false,
    defineResult: null as WordDefineResult | null,
    /** 上滑取消：手指已上滑越过阈值，松手将丢弃本条（见 onTalkMove） */
    talkCancelled: false,
  },

  // ---- 非响应式字段（不参与渲染，不进 setData） ----
  speech: null as unknown as SpeechAdapter,
  tts: null as TtsController | null,
  asr: null as AsrSession | null,
  task: null as ChatTask | null,
  pendingText: '',
  flushTimer: null as ReturnType<typeof setTimeout> | null,
  streamingIndex: -1,
  ttsBuffer: '',
  pickerMessageIndex: -1,
  lastContent: '',
  /** 当前正在朗读的消息下标（-1 = 无），用于逐句高亮 */
  highlightIndex: -1,
  /**
   * 「用户手还按着」标志（P2-5 语音竞态修复）。
   *
   * 与 data.recording 解耦：recording 表示"录音流程已启动"（含等待权限的阶段），
   * talkIntent 表示"用户的按压手势还没结束"。
   * 松手时必须按 talkIntent 判断——否则会在录音真正启动前就 return，
   * 留下一段没人管的孤儿录音。
   */
  talkIntent: false,
  /** 麦克风权限是否已预热过（进页面时申请一次，避免按住时才申请导致手势冲突） */
  micWarmed: false,
  /** 上滑取消：按住起始的 clientY（0 = 未记录） */
  talkStartY: 0,
  /** 上滑取消：是否已上滑越过阈值（松手时据此决定取消还是发送） */
  talkCancelled: false,

  onLoad() {
    const settings = getApp<IAppOption>().globalData.settings;
    this.speech = createSpeechAdapter(settings.speechEngine);
    this.setData({
      asrSupported: this.speech.asrSupported,
      ttsSupported: this.speech.ttsSupported,
    });
    this.syncTts(settings.ttsEnabled, settings.ttsRate);
  },

  onShow() {
    const settings = getApp<IAppOption>().globalData.settings;
    // 诊断：引擎名与支持标志——排查"按钮显示了但录音不工作"的首要怀疑点
    diag('chat_show', `${this.speech?.name ?? 'null'}/${this.speech?.asrSupported ? 'asr' : 'noasr'}`);
    // 引擎可能在「我的」页被切换（纯文字 ↔ 同声传译）——重建适配器并刷新支持标志
    if (this.speech === null || this.speech.name !== settings.speechEngine) {
      // 先销毁旧的 TTS 控制器，避免旧引擎的音频上下文残留
      this.tts?.destroy();
      this.tts = null;
      this.speech = createSpeechAdapter(settings.speechEngine);
      this.setData({
        asrSupported: this.speech.asrSupported,
        ttsSupported: this.speech.ttsSupported,
      });
    }
    // 设置页可能刚改过 TTS 开关/语速
    this.syncTts(settings.ttsEnabled, settings.ttsRate);

    // 麦克风权限预热（重要）：
    // 「按住说话」是手势驱动的——若把权限申请拖到按住那一刻，
    // 用户必须一直按着等系统弹窗、再用同一根手指去点「允许」，体验上根本做不到。
    // 所以进页面时就先把权限问清楚，真正按住时才能立即录音。
    if (this.speech.asrSupported) {
      this.warmupMicPermission();
    }

    const sessionId = getCurrentSessionId();
    if (sessionId === this.data.sessionId && this.data.hasSession) {
      return;
    }
    this.setData({ sessionId, hasSession: sessionId !== '', messages: [] });
    if (sessionId !== '') {
      void this.loadSession(sessionId);
    }
  },

  /**
   * 麦克风权限预热（进页面时调用一次）。
   *
   * 为什么不能等到「按住说话」才申请：
   * 权限申请会弹系统弹窗，用户必须用**同一根手指**去点「允许」——
   * 而「按住说话」要求手指一直按着，两者物理上冲突。
   * 结果就是：用户按住的 1-2 秒里授权流程走不完，松手后录音才姗姗启动，
   * 表现为「按了没反应」。所以提前在进页面时把权限问清楚。
   */
  warmupMicPermission(): void {
    if (this.micWarmed) return;
    this.micWarmed = true;

    wx.getSetting({
      success: (setting) => {
        const state = setting.authSetting['scope.record'];
        diag('warmup_perm', state === undefined ? 'undefined' : String(state));
        if (state === true) return; // 已授权，无需处理

        if (state === false) {
          // 曾拒绝：不打扰用户，等他主动按住说话时再引导去设置页
          return;
        }
        // 从未询问过 → 静默发起授权（微信会弹系统权限框）
        wx.authorize({
          scope: 'scope.record',
          success: () => diag('warmup_authorize_ok'),
          fail: (err) => diag('warmup_authorize_fail', String(err?.errMsg ?? '').slice(0, 100)),
        });
      },
      fail: () => {},
    });
  },

  onHide() {
    // 切后台立即停播，避免在外面继续朗读
    this.tts?.stop();
    this.setData({ speaking: false });
    this.clearHighlight();
  },

  onUnload() {
    this.task?.abort();
    // talkIntent 也要复位：若退出时正处于"等权限"阶段，asr 可能还没创建，
    // 后续异步回调若再启动录音就成了孤儿录音。
    this.talkIntent = false;
    this.asr?.abort();
    this.asr = null;
    this.tts?.destroy();
    this.tts = null;
    this.clearHighlight();
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  },

  /** 按当前设置创建/销毁/调整 TTS 控制器 */
  syncTts(enabled: boolean, rate: number): void {
    const want = enabled && this.speech?.ttsSupported === true;
    if (want && this.tts === null) {
      this.tts = this.speech.createTts({
        rate,
        onSpeakingChange: (speaking) => this.setData({ speaking }),
        onSentenceStart: (text) => this.highlightSentence(text),
      });
      return;
    }
    if (!want && this.tts !== null) {
      this.tts.stop();
      this.tts.destroy();
      this.tts = null;
      this.setData({ speaking: false });
      return;
    }
    if (this.tts !== null) {
      this.tts.setRate(rate);
    }
  },

  /** 场景 id → 中文名（本地缓存缺失时拉取一次场景列表） */
  async resolveSceneName(sceneId: string): Promise<string> {
    const cached = (wx.getStorageSync(SCENE_NAME_MAP_KEY) as Record<string, string> | '') || {};
    if (cached[sceneId] !== undefined) return cached[sceneId] as string;
    try {
      const data = await api.getScenes({ silent: true });
      const map: Record<string, string> = {};
      data.scenes.forEach((scene) => {
        map[scene.id] = scene.name;
      });
      wx.setStorageSync(SCENE_NAME_MAP_KEY, map);
      return map[sceneId] ?? sceneId;
    } catch {
      return sceneId;
    }
  },

  /** 装载会话（默认取最近 50 条消息） */
  async loadSession(sessionId: string): Promise<void> {
    this.setData({ loading: true });
    try {
      const detail = await api.getSessionDetail(sessionId, { msg_limit: 50 }, { silent: true });
      const sceneName = await this.resolveSceneName(detail.session.scene_id);
      this.setData({
        messages: detail.messages.map((m) => this.decorate(m)),
        hasSession: true,
        sceneName,
      });
      wx.setNavigationBarTitle({ title: sceneName });
      this.scrollToBottom();
    } catch (err) {
      // 会话已被删除（历史页删过 / 后端换库）→ 干净地回空态，不要卡在 loading
      setCurrentSessionId('');
      getApp<IAppOption>().globalData.currentSessionId = '';
      this.setData({ hasSession: false, sessionId: '', messages: [] });
      wx.showToast({
        title: err instanceof ApiError ? err.message : '会话加载失败',
        icon: 'none',
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  /** 补齐展示字段（后端返回的消息可能缺 corrections 字段） */
  decorate(message: Message, patch: Partial<DisplayMessage> = {}): DisplayMessage {
    return {
      ...message,
      corrections: message.corrections ?? [],
      vocab_suggestions: message.vocab_suggestions ?? [],
      timeText: formatRelative(message.created_at),
      ...patch,
    };
  },

  /* ---------- 发送 ---------- */

  async send(content: string): Promise<void> {
    const text = content.trim();
    if (text === '' || this.data.sending || this.data.sessionId === '') return;
    this.lastContent = text;

    const now = new Date().toISOString();
    const userMessage = this.decorate({
      id: `local-user-${Date.now()}`,
      session_id: this.data.sessionId,
      user_id: '',
      role: 'user',
      content: text,
      corrections: [],
      vocab_suggestions: [],
      created_at: now,
    });
    const aiMessage = this.decorate(
      {
        id: `local-ai-${Date.now()}`,
        session_id: this.data.sessionId,
        user_id: '',
        role: 'assistant',
        content: '',
        corrections: [],
        vocab_suggestions: [],
        created_at: now,
      },
      { streaming: true },
    );

    const nextIndex = this.data.messages.length + 1;
    this.setData({
      messages: [...this.data.messages, userMessage, aiMessage],
      inputText: '',
      sending: true,
    });
    this.streamingIndex = nextIndex;
    this.pendingText = '';
    this.ttsBuffer = '';
    this.scrollToBottom();

    try {
      await this.runStream(text, nextIndex);
    } catch (err) {
      this.handleSendError(err, nextIndex);
    } finally {
      this.flushPending(true);
      // TTS 尾巴保险：正常情况下 onDone 已把最后一句送去朗读，
      // 但若流异常结束（网络中断/后端没发 done 事件），onDone 可能没触发，
      // 这里补一次，避免「最后一句永远不播」。
      const ttsTail = this.ttsBuffer.trim();
      if (ttsTail !== '') {
        this.tts?.enqueue(ttsTail);
        this.ttsBuffer = '';
      }
      this.setData({ sending: false });
      this.streamingIndex = -1;
      this.task = null;
    }
  },

  /** 一轮请求（utils/sse 内部已含「流式失败 → 非流式」的自动兜底） */
  async runStream(content: string, index: number): Promise<void> {
    const task = sendChat(
      { session_id: this.data.sessionId, content },
      {
        onDelta: (text) => this.onDelta(text),
        onMeta: (corrections, suggestions) => this.onMeta(corrections, suggestions, index),
        onDone: (messageId) => this.onDone(messageId, index),
      },
    );
    this.task = task;
    await task.promise;
  },

  /** 增量文本：写入缓冲 + TTS 按句入队（写入目标下标由 streamingIndex 决定） */
  onDelta(text: string): void {
    this.pendingText += text;
    this.scheduleFlush();
    this.feedTts(text);
  },

  onMeta(corrections: Correction[], suggestions: VocabSuggestion[], index: number): void {
    this.setData({
      [`messages[${index}].corrections`]: corrections,
      [`messages[${index}].vocab_suggestions`]: suggestions,
    } as never);
  },

  onDone(messageId: string, index: number): void {
    // 收尾：把没有句末标点的尾巴也送去朗读
    const tail = this.ttsBuffer.trim();
    if (tail !== '') {
      this.tts?.enqueue(tail);
      this.ttsBuffer = '';
    }
    this.setData({
      [`messages[${index}].streaming`]: false,
      [`messages[${index}].id`]: messageId === '' ? `ai-${Date.now()}` : messageId,
    } as never);
    this.scrollToBottom();
  },

  handleSendError(err: unknown, index: number): void {
    const apiError = err instanceof ApiError ? err : null;
    // 3003 = LLM 输出协议降级：正文已完整送达，只是缺纠错/词条 → 按成功交付处理
    if (apiError?.code === 3003) {
      this.setData({ [`messages[${index}].streaming`]: false } as never);
      wx.showToast({ title: '本轮纠错数据缺失，对话可继续', icon: 'none', duration: 2400 });
      return;
    }
    this.setData({
      [`messages[${index}].streaming`]: false,
      [`messages[${index}].failed`]: true,
    } as never);
    wx.showToast({
      title: apiError?.message ?? '发送失败，请重试',
      icon: 'none',
      duration: 2400,
    });
  },

  /** 节流：80ms 内的 delta 合并成一次 setData */
  scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushPending(false);
    }, FLUSH_INTERVAL);
  },

  flushPending(force: boolean): void {
    const index = this.streamingIndex;
    if (index < 0 || this.pendingText === '') return;
    const chunk = this.pendingText;
    this.pendingText = '';
    const current = this.data.messages[index];
    if (current === undefined) return;
    this.setData({
      [`messages[${index}].content`]: (current.content ?? '') + chunk,
    } as never);
    if (!force) this.scrollToBottom();
  },

  /* ---------- TTS：首句即播 ---------- */

  /**
   * 只在凑够「有句末标点的完整句」时才送去朗读，
   * 这样用户听到第一句的时机远早于整段生成结束。
   */
  feedTts(chunk: string): void {
    if (this.tts === null) return;
    this.ttsBuffer += chunk;
    let stop = -1;
    for (let i = this.ttsBuffer.length - 1; i >= 0; i -= 1) {
      if (/[.!?。！？]/.test(this.ttsBuffer.charAt(i))) {
        stop = i;
        break;
      }
    }
    if (stop < 0) return;
    const complete = this.ttsBuffer.slice(0, stop + 1);
    this.ttsBuffer = this.ttsBuffer.slice(stop + 1);
    for (const sentence of splitSentences(complete)) {
      this.tts.enqueue(sentence);
    }
  },

  onStopSpeaking(): void {
    this.tts?.stop();
    this.setData({ speaking: false });
    this.clearHighlight();
  },

  /** 点 AI 气泡「重播」→ 用 TTS 重新朗读整条回复 */
  onReplay(e: WechatMiniprogram.CustomEvent): void {
    const detail = e.detail as { content: string };
    const content = (detail.content ?? '').trim();
    if (content === '') return;
    if (this.tts === null) {
      // TTS 未启用（引擎不支持或自动朗读关闭）——给个提示，避免点了没反应
      wx.showToast({ title: '未启用语音播报，请到「我的」页开启', icon: 'none', duration: 2200 });
      return;
    }
    this.tts.stop();
    // 整条内容按句拆分逐句播报
    for (const sentence of splitSentences(content)) {
      this.tts.enqueue(sentence);
    }
  },

  /** TTS 开始朗读某句时，高亮对应消息里的该句文字 */
  highlightSentence(text: string): void {
    const sentence = text.trim();
    if (sentence === '') return;
    // 从后往前找第一条「内容包含该句」的 AI 消息（最近生成的最优先）
    let targetIndex = -1;
    for (let i = this.data.messages.length - 1; i >= 0; i -= 1) {
      const m = this.data.messages[i];
      if (m.role === 'assistant' && m.content.includes(sentence)) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return;

    const patch: Record<string, unknown> = {};
    // 清除上一次高亮
    if (this.highlightIndex >= 0 && this.highlightIndex !== targetIndex) {
      patch[`messages[${this.highlightIndex}].highlightText`] = '';
    }
    patch[`messages[${targetIndex}].highlightText`] = sentence;
    this.highlightIndex = targetIndex;
    this.setData(patch as never);
  },

  /** 清除所有消息的高亮（播报结束 / 手动停止 / 页面卸载时） */
  clearHighlight(): void {
    if (this.highlightIndex < 0) return;
    this.setData({ [`messages[${this.highlightIndex}].highlightText`]: '' } as never);
    this.highlightIndex = -1;
  },

  /* ---------- 输入 ---------- */

  onInput(e: WechatMiniprogram.TextareaInput): void {
    this.setData({ inputText: e.detail.value });
  },

  onSendTap(): void {
    void this.send(this.data.inputText);
  },

  /* ---------- 语音输入（按住说话） ---------- */

  /**
   * 按下瞬间就置位「说话意图」。
   *
   * ⚠️ 关键：recording 标志**不能**等到 startRecording() 才设——
   * 那条路径上有隐私授权 + 权限检查两段异步，用户通常在它们完成前就松手了，
   * 结果是：松手时 recording 还是 false → onTalkEnd 直接 return → 录音会话没被停掉，
   * 等录音终于启动时已经没人管它了（孤儿录音），用户表现为"按了没反应也不报错"。
   *
   * 所以这里用 talkIntent 记录"用户手还按着"，与 recording（实际录音中）解耦。
   */
  onTalkStart(): void {
    resetDiagClock();
    // 上滑取消状态复位
    this.talkStartY = 0;
    this.talkCancelled = false;
    diag('talk_start');
    if (!this.speech.asrSupported || this.data.sending) {
      diag('talk_start_rejected', this.speech.asrSupported ? 'sending' : 'asr_unsupported');
      return;
    }
    if (this.talkIntent) {
      diag('talk_start_duplicate');
      return; // 已在录音流程中，忽略重复触发
    }
    this.talkIntent = true;
    this.setData({ recording: true, interimText: '' });

    // 首次语音：先确保隐私协议已同意（微信审核要求「有可见用途才申请权限」，
    // 因此把隐私授权 + 麦克风权限都延迟到用户真正按住说话这一刻触发）。
    void this.beginTalkWithPrivacy();
  },

  /**
   * 按住期间的手指移动（上滑取消）。
   *
   * 实现微信语音消息同款交互：手指上滑越过阈值（100px）→ 标记取消，
   * 浮层提示切换为「松开手指取消本条」；此时松手走 abort 而非发送。
   */
  onTalkMove(e: WechatMiniprogram.TouchEvent): void {
    if (!this.talkIntent) return;
    const touch = e.touches[0];
    if (touch === undefined) return;
    if (this.talkStartY === 0) {
      this.talkStartY = touch.clientY;
      return;
    }
    const slideUp = this.talkStartY - touch.clientY; // 上滑为正
    const cancelled = slideUp > 100;
    if (cancelled !== this.talkCancelled) {
      this.talkCancelled = cancelled;
      this.setData({ talkCancelled: cancelled });
    }
  },

  async beginTalkWithPrivacy(): Promise<void> {
    // 官方弹窗模式：未同意时 wx.requirePrivacyAuthorize 会直接弹微信官方隐私弹窗，
    // 用户的选择体现在返回值上，无需再自己弹窗（见 utils/privacy.ts 文件头说明）。
    const authorized = await ensurePrivacyAuthorized();
    diag('privacy_checked', authorized);
    if (!authorized) {
      this.talkIntent = false;
      this.setData({ recording: false, interimText: '' });
      wx.showToast({ title: '需要同意隐私协议才能使用语音', icon: 'none', duration: 2400 });
      return;
    }
    this.startRecording();
  },

  /**
   * 查看《隐私保护指引》全文（官方接口）。
   * 隐私授权弹窗已改用微信官方弹窗（见 utils/privacy.ts 文件头），
   * 页面不再需要自定义弹窗与「同意/拒绝」处理。
   */
  onPrivacyDetail(): void {
    openPrivacyContract();
  },

  startRecording(): void {
    if (!this.speech.asrSupported || this.data.sending) return;
    // 用户可能已经松手了（异步等待期间）→ 不再启动
    if (!this.talkIntent) return;
    if (this.asr) return;

    this.setData({ interimText: '' });
    this.asr = this.speech.startAsr({
      onInterim: (text) => this.setData({ interimText: text }),
      onFinal: (text) => {
        this.talkIntent = false;
        this.setData({ recording: false, interimText: '' });
        if (text !== '') {
          this.setData({ inputText: this.data.inputText + text });
        }
      },
      onError: (error) => {
        this.talkIntent = false;
        this.setData({ recording: false, interimText: '' });
        wx.showToast({ title: error.message, icon: 'none', duration: 2200 });
      },
    });
  },

  onTalkEnd(): void {
    diag('talk_end', this.talkCancelled ? 'cancelled' : 'send');
    // 注意：不能依赖 this.data.recording 判断——
    // 它在按下瞬间就置 true，但录音可能还没真正启动。
    if (!this.talkIntent) {
      diag('talk_end_no_intent');
      return;
    }
    this.talkIntent = false;
    // 上滑取消：松手时丢弃本条，不发送
    if (this.talkCancelled) {
      this.asr?.abort();
      this.asr = null;
      this.setData({ recording: false, interimText: '', talkCancelled: false });
      wx.showToast({ title: '已取消', icon: 'none', duration: 800 });
      return;
    }
    this.asr?.stop();
    this.asr = null;
    this.setData({ recording: false });
  },

  onTalkCancel(): void {
    diag('talk_cancel');
    if (!this.talkIntent) return;
    this.talkIntent = false;
    this.asr?.abort();
    this.asr = null;
    this.setData({ recording: false, interimText: '', talkCancelled: false });
  },

  /* ---------- 点词查词 ---------- */

  onWordSelect(e: WechatMiniprogram.CustomEvent): void {
    const detail = e.detail as { index: number };
    const message = this.data.messages[detail.index];
    if (message === undefined || message.content.trim() === '') return;
    this.pickerMessageIndex = detail.index;
    this.setData({
      pickerVisible: true,
      pickerTokens: tokenizeEnglish(message.content).map((text) => ({ text, selected: false })),
      defineResult: null,
    });
  },

  onToggleToken(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { idx?: string };
    const idx = Number.parseInt(dataset.idx ?? '-1', 10);
    if (idx < 0 || idx >= this.data.pickerTokens.length) return;
    this.setData({
      pickerTokens: this.data.pickerTokens.map((token, i) =>
        i === idx ? { ...token, selected: !token.selected } : token,
      ),
    });
  },

  onClosePicker(): void {
    this.setData({
      pickerVisible: false,
      pickerTokens: [],
      defineResult: null,
      pickerBusy: false,
    });
  },

  async onDefineWord(): Promise<void> {
    const phrase = this.data.pickerTokens
      .filter((token) => token.selected)
      .map((token) => token.text)
      .join(' ')
      .replace(/[.,!?;:"']+$/, '');
    if (phrase === '') {
      wx.showToast({ title: '先点选一个词或短语', icon: 'none' });
      return;
    }
    const context = this.data.messages[this.pickerMessageIndex]?.content ?? phrase;
    this.setData({ pickerBusy: true });
    try {
      const result = await api.defineWord(
        { word: phrase, context, session_id: this.data.sessionId },
        { silent: true },
      );
      this.setData({ defineResult: result, pickerBusy: false });
    } catch (err) {
      this.setData({ pickerBusy: false });
      wx.showToast({
        title: err instanceof ApiError ? err.message : '查词失败，请重试',
        icon: 'none',
        duration: 2200,
      });
    }
  },

  async onSaveDefinedWord(): Promise<void> {
    const result = this.data.defineResult;
    if (result === null) return;
    try {
      await api.saveWord({
        word: result.word,
        phonetic: result.phonetic,
        definition: result.definition,
        example: result.example,
        context: result.context,
        source_session_id: this.data.sessionId,
      });
      wx.showToast({ title: '已存入词汇本', icon: 'success' });
      this.onClosePicker();
    } catch (err) {
      wx.showToast({ title: err instanceof ApiError ? err.message : '保存失败', icon: 'none' });
    }
  },

  /** AI 建议词条一键入库（message-bubble 组件回调） */
  async onVocabAdd(e: WechatMiniprogram.CustomEvent): Promise<void> {
    const detail = e.detail as { index: number; vocabIndex: number };
    const message = this.data.messages[detail.index];
    const suggestion = message?.vocab_suggestions[detail.vocabIndex];
    if (suggestion === undefined) return;
    try {
      await api.saveWord({
        word: suggestion.word,
        phonetic: suggestion.phonetic,
        definition: suggestion.definition,
        example: suggestion.example,
        context: message.content,
        source_session_id: this.data.sessionId,
      });
      wx.showToast({ title: `已记住 ${suggestion.word}`, icon: 'success' });
    } catch (err) {
      wx.showToast({ title: err instanceof ApiError ? err.message : '保存失败', icon: 'none' });
    }
  },

  onRetry(e: WechatMiniprogram.CustomEvent): void {
    const detail = e.detail as { index: number };
    const message = this.data.messages[detail.index];
    if (message === undefined) return;
    // 失败的都是 AI 占位消息（正文为空）→ 用记录的用户原文重发（后端幂等，不会插两条）
    const content = message.content.trim() === '' ? this.lastContent : message.content;
    this.setData({ messages: this.data.messages.filter((_, i) => i !== detail.index) });
    void this.send(content);
  },

  /* ---------- 导航 ---------- */

  goScenes(): void {
    wx.navigateTo({ url: '/pages/scenes/scenes' });
  },

  scrollToBottom(): void {
    this.setData({ scrollAnchor: '' });
    setTimeout(() => this.setData({ scrollAnchor: 'bottom-anchor' }), 30);
  },

  /** 阻止浮层点击穿透到遮罩（关闭） */
  noop(): void {},
});
