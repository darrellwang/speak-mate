/**
 * 训练器页（pages/trainer/trainer.ts）
 *
 * 移植自 H5 端 D:\work\myresume\trainer_template.html，
 * 核心差异（都是小程序运行时逼出来的）：
 * 1. **没有 SpeechSynthesisUtterance**：TTS 走 WechatSI 插件 + InnerAudioContext（复用 speech/wechatSi.ts）。
 * 2. **没有 MediaRecorder**：跟读对比改用 ASR 识别 → diff，比录音回放更有训练价值。
 * 3. **没有键盘事件**：键盘快捷键去掉，只保留触屏操作。
 * 4. **没有 localStorage**：用 wx.setStorageSync（utils/handbookStorage.ts 包装）。
 *
 * 四种模式与 H5 完全一致：
 *   listen（盲听）/ dictation（听写）/ shadow（跟读）/ recall（中译英）
 *
 * 刻意不带 Page<IData,ICustom> 泛型：与 chat.ts 一致，泛型签名会拒绝
 * 非响应式字段（speech/tts/asr/orderList 等）。字面量推断的类型已够用。
 */

import { createSpeechAdapter } from '../../speech/index';
import type { AsrSession, SpeechAdapter, TtsController } from '../../speech/adapter';
import handbookData from '../../data/handbook';
import type {
  DiffToken,
  HandbookMastery,
  HandbookProgress,
  TrainerMode,
  TrainerOrder,
  TrainerScope,
} from '../../types/handbook';
import { diffEnglish, normalizeForTts } from '../../utils/format';
import { diag } from '../../utils/diag';
import { ensureLogin } from '../../utils/auth';
import { getSettings } from '../../utils/storage';
import {
  bumpSeen,
  clearProgress,
  getProgress,
  getStats,
  setMastery as storeMastery,
  toggleStar as storeToggleStar,
  type ProgressStats,
} from '../../utils/handbookStorage';
import { ensurePrivacyAuthorized } from '../../utils/privacy';

/** 训练素材（外企 IT 职场英语常用句，编译期 inline，不依赖运行时 require JSON） */
const DATA = handbookData;

/**
 * 发音评估结果（/api/pronounce 的 data 契约，与 WSL OpenPronounce 服务对应）。
 * errorRateText 为展示用预格式化字段——WXML 表达式不支持 `??`/数字格式化，
 * 复杂处理一律在 TS 侧做完再 setData。
 */
interface PronErrorItem {
  word: string;
  expected: string;
  actual: string;
  confidence?: number;
}

interface PronResult {
  score: number;
  transcribe?: string;
  differences?: {
    errors?: PronErrorItem[];
    phoneme_error_rate?: number;
    word_error_rate?: number;
  };
  /** 音素错误率的展示文本（TS 侧预格式化，如 '9.1%' 或 '-'） */
  errorRateText?: string;
  elapsed_ms?: number;
}

/** 自动连播「揭示后停留」最短时间 */
const AUTO_GAP_MIN_MS = 1200;
/** 单句 TTS 估算时长（WechatSI 无 onend 透传，粗略等待） */
const TTS_SENTENCE_MS = 1500;

Page({
  data: {
    /* ---- 数据 ---- */
    mode: 'listen' as TrainerMode,
    modes: [
      { key: 'listen', label: '盲听' },
      { key: 'dictation', label: '听写' },
      { key: 'shadow', label: '跟读' },
      { key: 'recall', label: '中译英' },
    ] as Array<{ key: TrainerMode; label: string }>,
    /**
     * 「只练」筛选项。
     *
     * 常驻在主练习区顶部（不用展开「练习范围」折叠面板就能切换）——
     * 筛选器藏太深等于没有：用户找不到就等于功能不存在。
     */
    scopes: [
      { val: 'all', label: '全部' },
      { val: 'new', label: '没练过' },
      { val: 'weak', label: '模糊' },
      { val: 'known', label: '已掌握' },
      { val: 'star', label: '已收藏' },
    ] as Array<{ val: TrainerScope; label: string }>,
    pos: 0,
    total: 0,
    crumb: '',
    en: '',
    zh: '',
    star: false,
    /** 筛选结果为空时的提示文案（空串 = 非空态） */
    emptyHint: '',

    /* ---- 状态 ---- */
    revealed: false,
    playing: false,
    recording: false,

    /* ---- 听写 / 中译英 ---- */
    inputText: '',
    diffTokens: [] as DiffToken[],
    diffVisible: false,

    /* ---- 跟读 ASR ---- */
    interimText: '',
    shadowResult: '',
    shadowDiff: [] as DiffToken[],
    shadowDiffVisible: false,

    /* ---- 设置区 ---- */
    cats: [] as Array<{ name: string; label: string }>,
    selectedCats: [] as string[],
    selectedCatsMap: {} as Record<string, boolean>,
    order: 'seq' as TrainerOrder,
    scope: 'all' as TrainerScope,
    rate: 1,
    repeat: 1,
    gap: 1,
    auto: false,
    rangeFoldOpen: false,
    voiceFoldOpen: false,

    /* ---- 进度 ---- */
    stats: { total: DATA.items.length, seen: 0, known: 0, weak: 0, starred: 0 } as ProgressStats,
    knownPercent: 0,
    weakPercent: 0,

    /* ---- 能力探测 ---- */
    asrSupported: false,
    ttsSupported: false,

    /* ---- 发音评估（跟读后） ---- */
    /** 评测中 */
    pronLoading: false,
    /** 评测结果（null = 无/失败） */
    pron: null as PronResult | null,
    /** 评测失败原因（空串 = 无错误） */
    pronError: '',
  },

  /* ---- 非响应式字段（不参与渲染，不进 setData） ---- */
  speech: null as unknown as SpeechAdapter,
  tts: null as TtsController | null,
  asr: null as AsrSession | null,
  orderList: [] as number[],
  posIndex: -1,
  timers: [] as ReturnType<typeof setTimeout>[],
  touchX: 0,
  touchY: 0,
  touchMoved: false,
  progress: {} as HandbookProgress,
  /**
   * 「用户手还按着」标志（跟读录音的竞态修复）。
   * 与 data.recording 解耦——recording 在按下瞬间置位，talkIntent 表示手势未结束。
   */
  shadowTalkIntent: false,
  /** 麦克风权限是否已预热过 */
  micWarmed: false,

  /* ============ 生命周期 ============ */

  onLoad() {
    const settings = getApp<IAppOption>().globalData.settings;
    this.speech = createSpeechAdapter(settings.speechEngine);
    this.progress = getProgress();

    const cats = DATA.cats.map((c) => ({
      name: c,
      label: `${c} (${DATA.items.filter((i) => i.cat === c).length})`,
    }));
    const selectedCatsMap: Record<string, boolean> = {};
    DATA.cats.forEach((c) => {
      selectedCatsMap[c] = true;
    });

    this.setData({
      cats,
      selectedCats: [...DATA.cats],
      selectedCatsMap,
      asrSupported: this.speech.asrSupported,
      ttsSupported: this.speech.ttsSupported,
      rate: settings.ttsRate || 1,
    });

    if (this.speech.ttsSupported) {
      this.tts = this.speech.createTts({
        rate: this.data.rate,
        onSpeakingChange: (playing: boolean) => this.setData({ playing }),
      });
    }

    this.buildQueue();
  },

  onShow() {
    const settings = getApp<IAppOption>().globalData.settings;
    if (this.speech === null || this.speech.name !== settings.speechEngine) {
      this.tts?.destroy();
      this.tts = null;
      this.speech = createSpeechAdapter(settings.speechEngine);
      this.setData({
        asrSupported: this.speech.asrSupported,
        ttsSupported: this.speech.ttsSupported,
      });
      if (this.speech.ttsSupported && this.tts === null) {
        this.tts = this.speech.createTts({
          rate: this.data.rate,
          onSpeakingChange: (playing: boolean) => this.setData({ playing }),
        });
      }
    } else if (this.tts !== null) {
      this.tts.setRate(this.data.rate);
    }

    // 麦克风权限预热：与聊天页同理——「按住跟读」是手势驱动，
    // 权限申请必须提前，否则用户要一直按着去点系统弹窗「允许」，物理上做不到。
    if (this.speech.asrSupported) {
      this.warmupMicPermission();
    }
  },

  /** 麦克风权限预热（进页面时申请一次，见 chat.ts 同名方法的说明） */
  warmupMicPermission(): void {
    if (this.micWarmed) return;
    this.micWarmed = true;

    wx.getSetting({
      success: (setting) => {
        const state = setting.authSetting['scope.record'];
        diag('trainer_warmup_perm', state === undefined ? 'undefined' : String(state));
        if (state === true) return;
        if (state === false) return; // 曾拒绝：等用户主动操作时再引导
        wx.authorize({
          scope: 'scope.record',
          success: () => diag('trainer_warmup_ok'),
          fail: (err) => diag('trainer_warmup_fail', String(err?.errMsg ?? '').slice(0, 100)),
        });
      },
      fail: () => {},
    });
  },

  onHide() {
    this.stopAll();
    this.stopShadowTalk();
  },

  onUnload() {
    this.stopAll();
    this.stopShadowTalk();
    this.tts?.destroy();
    this.tts = null;
  },

  /* ============ 队列 ============ */

  /**
   * 重建练习队列。
   *
   * 「只练」筛选（scope）：
   * - new   → 还没练过的句子
   * - weak  → 标记为「模糊」的句子
   * - known → 标记为「已掌握」的句子
   * - star  → 打了收藏星标的句子（与掌握状态正交，可同时是 new/weak/known）
   *
   * 筛选结果为空时不回退到全部，否则「只练已收藏」会露出整本句库。
   * 这里给出明确空态，并清空舞台上的残留句子。
   */
  buildQueue(): void {
    const selected = new Set(this.data.selectedCats);
    let idx = DATA.items.map((_, i) => i).filter((i) => selected.has(DATA.items[i].cat));

    if (this.data.scope === 'star') {
      // 收藏：只看 star===1，与掌握状态无关
      idx = idx.filter((i) => this.progress[i]?.star === 1);
    } else if (this.data.scope !== 'all') {
      const want: HandbookMastery =
        this.data.scope === 'known' ? 'known' : this.data.scope === 'weak' ? 'weak' : 'new';
      idx = idx.filter((i) => {
        const entry = this.progress[i];
        const s = entry?.s ?? 'new';
        return s === want;
      });
    }

    if (this.data.scope === 'weak') {
      idx.sort((a, b) => (this.progress[a]?.seen ?? 0) - (this.progress[b]?.seen ?? 0));
    }

    if (this.data.order === 'random') {
      idx.sort(() => Math.random() - 0.5);
    }

    this.orderList = idx;
    this.posIndex = 0;
    this.stopAll();

    if (idx.length === 0) {
      // 空态：清空舞台残留，展示提示文案
      this.resetStage();
      this.setData({
        total: 0,
        pos: 0,
        crumb: '',
        en: '',
        zh: '',
        star: false,
        emptyHint: this.emptyHintForScope(),
      });
      return;
    }

    this.setData({ total: idx.length, pos: 1, emptyHint: '' });
    this.paint();
  },

  /** 按当前筛选范围给出空态提示文案 */
  emptyHintForScope(): string {
    switch (this.data.scope) {
      case 'star':
        return '还没有收藏任何句子。给喜欢的句子点底部「收藏」加星标后，就会出现在这里。';
      case 'known':
        return '还没有标记为「已掌握」的句子。练会的句子点「已掌握」即可归入这里。';
      case 'weak':
        return '还没有标记为「模糊」的句子。点「再来一次」即可归入这里。';
      case 'new':
        return '当前分类下的句子都练过了。换个分类，或点「重置进度」重新开始。';
      default:
        return '当前分类下没有句子，请至少保留一个分类。';
    }
  },

  /** 清空「当前句子」相关的展示状态（换句 / 换模式 / 队列为空时共用） */
  resetStage(): void {
    this.setData({
      revealed: false,
      inputText: '',
      diffVisible: false,
      diffTokens: [],
      shadowResult: '',
      shadowDiff: [],
      shadowDiffVisible: false,
      interimText: '',
      // 换句清空发音评分
      pron: null,
      pronLoading: false,
      pronError: '',
    });
  },

  next(d: number): void {
    // 空态（筛选范围内没有句子）时无可切换的句子——
    // 不加这道守卫，滑动会算出 nextIndex=-1 并把 undefined 写进进度表。
    if (this.orderList.length === 0) return;
    const nextIndex = Math.min(this.orderList.length - 1, Math.max(0, this.posIndex + d));
    if (nextIndex === this.posIndex) return;
    this.posIndex = nextIndex;
    const idx = this.orderList[this.posIndex];
    this.progress = bumpSeen(idx);
    this.stopAll();
    this.resetStage();
    this.setData({ pos: this.posIndex + 1 });
    this.paint();
  },

  paint(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    const item = DATA.items[idx];
    const entry = this.progress[idx];
    const star = entry?.star === 1;

    this.setData({
      crumb: `${item.cat} · ${item.scene}`,
      en: item.en,
      zh: item.zh,
      star,
    });

    this.refreshStats();
  },

  refreshStats(): void {
    const stats = getStats(DATA.items.length);
    const total = stats.total || 1;
    this.setData({
      stats,
      knownPercent: (stats.known / total) * 100,
      weakPercent: (stats.weak / total) * 100,
    });
  },

  /* ============ 播放（TTS） ============ */

  play(): void {
    if (this.tts === null) {
      // tts 为 null = 朗读功能未启用（引擎是纯文字模式或开关关闭）。
      // ⚠️ 之前写「切到微信同传」是错误归因：朗读用的是微软 Edge 语音，
      // 不是微信同传（那是跟读识别的引擎）；但切换引擎确实会连带启用朗读。
      wx.showToast({
        title: '朗读不可用，请到「我的」开启语音引擎',
        icon: 'none',
        duration: 2400,
      });
      return;
    }
    this.stopAll();
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    const item = DATA.items[idx];
    const text = normalizeForTts(item.en);
    const n = this.data.repeat;
    const gap = this.data.gap * 1000;
    let k = 0;

    const one = (): void => {
      if (k >= n) {
        this.setData({ playing: false });
        if (this.data.auto) this.autoFlow();
        return;
      }
      k += 1;
      this.tts?.stop();
      this.tts?.enqueue(text);
      this.timers.push(
        setTimeout(() => {
          if (k < n) one();
          else {
            this.setData({ playing: false });
            if (this.data.auto) this.autoFlow();
          }
        }, gap + TTS_SENTENCE_MS),
      );
    };
    one();
    this.setData({ playing: true });
  },

  autoFlow(): void {
    this.setData({ revealed: true });
    const wait = Math.max(AUTO_GAP_MIN_MS, this.data.gap * 1000 + 1600);
    this.timers.push(
      setTimeout(() => {
        if (this.posIndex < this.orderList.length - 1) {
          this.next(1);
          this.play();
        }
      }, wait),
    );
  },

  stopAll(): void {
    this.tts?.stop();
    this.timers.forEach(clearTimeout);
    this.timers = [];
    this.setData({ playing: false });
  },

  /** 中止跟读录音（页面卸载 / 切换模式时调用，防止留下孤儿录音） */
  stopShadowTalk(): void {
    this.shadowTalkIntent = false;
    this.asr?.abort();
    this.asr = null;
    if (this.data.recording) {
      this.setData({ recording: false, interimText: '' });
    }
  },

  /* ============ 模式切换 ============ */

  onModeTap(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { mode?: string };
    const mode = dataset.mode as TrainerMode | undefined;
    if (mode === undefined || mode === this.data.mode) return;
    this.stopAll();
    this.setData({ mode });
    this.resetStage();
  },

  /* ============ 操作栏 ============ */

  onPlayTap(): void {
    if (this.data.playing) {
      this.stopAll();
    } else {
      this.play();
    }
  },

  onSlowTap(): void {
    const next = Math.max(0.5, this.data.rate - 0.15);
    this.setData({ rate: next });
    this.tts?.setRate(next);
    this.play();
  },

  onRevealTap(): void {
    this.setData({ revealed: !this.data.revealed });
  },

  onPrevTap(): void {
    this.next(-1);
  },

  onNextTap(): void {
    this.next(1);
  },

  onMarkKnown(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    this.progress = storeMastery(idx, 'known');
    this.refreshStats();
    this.next(1);
    if (this.data.auto) this.play();
  },

  onMarkWeak(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    this.progress = storeMastery(idx, 'weak');
    this.refreshStats();
    this.next(1);
    if (this.data.auto) this.play();
  },

  onStarToggle(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    this.progress = storeToggleStar(idx);
    const star = this.progress[idx]?.star === 1;
    this.setData({ star });
    this.refreshStats();

    // 「只练已收藏」视图下取消收藏 → 当前句已不属于该集合，直接跳走
    if (this.data.scope === 'star' && !star) {
      if (this.posIndex < this.orderList.length - 1) {
        this.next(1);
      } else {
        // 是最后一句 → 重建队列（可能变为空态）
        this.buildQueue();
      }
    }
  },

  /* ============ 听写 / 中译英 ============ */

  onInput(e: WechatMiniprogram.TextareaInput): void {
    this.setData({ inputText: e.detail.value });
  },

  onDictationSubmit(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    const answer = DATA.items[idx].en;
    const typed = this.data.inputText;
    if (typed.trim() === '') {
      wx.showToast({ title: '先输入你听到的英文', icon: 'none' });
      return;
    }
    const tokens = diffEnglish(answer, typed);
    this.setData({
      diffTokens: tokens,
      diffVisible: true,
      revealed: true,
    });
  },

  onRecallSubmit(): void {
    const idx = this.orderList[this.posIndex];
    if (idx === undefined) return;
    const answer = DATA.items[idx].en;
    const typed = this.data.inputText;
    if (typed.trim() === '') {
      wx.showToast({ title: '先写出或说出你的英文', icon: 'none' });
      return;
    }
    const tokens = diffEnglish(answer, typed);
    this.setData({
      diffTokens: tokens,
      diffVisible: true,
      revealed: true,
    });
  },

  /* ============ 跟读 ASR ============ */

  /**
   * 按下瞬间置位「跟读意图」。
   *
   * ⚠️ 与聊天页同样的竞态：recording 若等到 await 之后再置位，
   * 用户在权限检查期间松手就会导致 onShadowTalkEnd 直接 return → 孤儿录音。
   */
  async onShadowTalkStart(): Promise<void> {
    diag('shadow_talk_start');
    if (!this.speech.asrSupported || this.shadowTalkIntent) return;
    this.shadowTalkIntent = true;
    this.setData({ recording: true, interimText: '', shadowResult: '' });

    const authorized = await ensurePrivacyAuthorized();
    diag('shadow_privacy', authorized);
    if (!authorized) {
      this.shadowTalkIntent = false;
      this.setData({ recording: false });
      wx.showToast({ title: '未同意隐私协议，无法使用语音', icon: 'none', duration: 2200 });
      return;
    }
    if (!this.shadowTalkIntent) return; // 等待期间已松手
    this.startShadowRecording();
  },

  startShadowRecording(): void {
    if (!this.speech.asrSupported || !this.shadowTalkIntent || this.asr) return;
    this.asr = this.speech.startAsr({
      onInterim: (text) => this.setData({ interimText: text }),
      onFinal: (text, recording) => {
        this.shadowTalkIntent = false;
        this.setData({ recording: false, interimText: '' });
        if (text !== '') {
          this.setData({ shadowResult: text });
          const idx = this.orderList[this.posIndex];
          if (idx === undefined) return;
          const answer = DATA.items[idx].en;
          const tokens = diffEnglish(answer, text);
          this.setData({ shadowDiff: tokens, shadowDiffVisible: true });
          // 有录音文件 → 同时做发音评估（音素级，独立于文字比对）
          if (recording !== undefined) {
            void this.assessPronunciation(recording.filePath, answer);
          }
        }
      },
      onError: (error) => {
        this.shadowTalkIntent = false;
        this.setData({ recording: false, interimText: '' });
        wx.showToast({ title: error.message, icon: 'none', duration: 2200 });
      },
    });
  },

  onShadowTalkEnd(): void {
    if (!this.shadowTalkIntent) return;
    this.shadowTalkIntent = false;
    this.asr?.stop();
    this.asr = null;
    this.setData({ recording: false });
  },

  onShadowTalkCancel(): void {
    if (!this.shadowTalkIntent) return;
    this.shadowTalkIntent = false;
    this.asr?.abort();
    this.asr = null;
    this.setData({ recording: false, interimText: '' });
  },

  /* ============ 发音评估（音素级） ============ */

  /**
   * 上传跟读录音到 /api/pronounce，展示音素级评分。
   *
   * 与文字比对（shadowDiff）是两件事：
   * - 文字比对：识别你「说了什么词」（微信同传 ASR）
   * - 发音评估：识别你「每个音发得准不准」（wav2vec2 音素模型，本地）
   * 两者并行展示，互不依赖（评估失败不影响比对结果）。
   */
  async assessPronunciation(filePath: string, referenceText: string): Promise<void> {
    this.setData({ pronLoading: true, pron: null, pronError: '' });
    try {
      const token = await ensureLogin();
      const base = (getSettings().baseUrl || '').trim().replace(/\/+$/, '');

      const audio = await new Promise<ArrayBuffer>((resolve, reject) => {
        wx.getFileSystemManager().readFile({
          filePath,
          success: (r) => resolve(r.data as ArrayBuffer),
          fail: (e) => reject(new Error(`读录音失败：${e.errMsg}`)),
        });
      });

      const res = await new Promise<{
        statusCode: number;
        data: { code?: number; data?: PronResult; message?: string } | null;
      }>((resolve, reject) => {
        wx.request({
          url: `${base}/api/pronounce?text=${encodeURIComponent(referenceText)}&lang=en`,
          method: 'POST',
          data: audio,
          header: {
            'Content-Type': 'audio/mpeg',
            Authorization: `Bearer ${token}`,
          },
          timeout: 90_000, // 首次评测含模型加载（~10s）
          success: (r) => resolve(r as never),
          fail: (e) => reject(new Error(e.errMsg ?? '评测请求失败')),
        });
      });

      const payload = res.data;
      if (res.statusCode !== 200 || payload === null || payload.code !== 0) {
        throw new Error(payload?.message ?? `评测失败（HTTP ${res.statusCode}）`);
      }
      if (payload.data === undefined || payload.data === null) {
        throw new Error('评测响应格式异常');
      }
      // 归一化：WXML 表达式直接访问 pron.differences.errors，两个字段保证存在
      const pron = payload.data;
      if (pron.differences === undefined) {
        pron.differences = { errors: [] };
      }
      if (pron.differences.errors === undefined) {
        pron.differences.errors = [];
      }
      // 展示文本在 TS 侧格式化（WXML 不支持 ?? 与数字格式化）
      const rate = pron.differences.phoneme_error_rate;
      pron.errorRateText = rate === undefined ? '-' : `${(rate * 100).toFixed(1)}%`;
      this.setData({ pron, pronLoading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : '评测失败';
      this.setData({ pronLoading: false, pronError: message });
    }
  },

  /* ============ 设置区 ============ */

  onToggleRangeFold(): void {
    this.setData({ rangeFoldOpen: !this.data.rangeFoldOpen });
  },

  onToggleVoiceFold(): void {
    this.setData({ voiceFoldOpen: !this.data.voiceFoldOpen });
  },

  onCatTap(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { cat?: string };
    const cat = dataset.cat ?? '';
    if (cat === '') return;
    const selected = new Set(this.data.selectedCats);
    if (selected.has(cat)) {
      if (selected.size === 1) {
        wx.showToast({ title: '至少保留一个分类', icon: 'none' });
        return;
      }
      selected.delete(cat);
    } else {
      selected.add(cat);
    }
    const selectedCatsMap: Record<string, boolean> = {};
    selected.forEach((c) => {
      selectedCatsMap[c] = true;
    });
    this.setData({ selectedCats: Array.from(selected), selectedCatsMap });
    this.buildQueue();
  },

  onOrderChange(e: WechatMiniprogram.PickerChange): void {
    // selector 的 detail.value 是选项下标，不是 'seq' / 'random'
    const index = Number(e.detail.value);
    const order: TrainerOrder = index === 1 ? 'random' : 'seq';
    if (order === this.data.order) return;
    this.setData({ order });
    this.buildQueue();
  },

  /**
   * 顶部筛选条：切换「只练」范围。
   *
   * 与折叠面板里的 picker 等价，但常驻可见、一次点击即达。
   *
   * ⚠️ 实现必须与词汇页（pages/words）的 .filters 筛选条**完全同构**：
   * 普通 <view> 容器 + data-value + bind:tap。
   * 第一版用了 scroll-view + catchtouchstart/catchtouchend，
   * 结果真机上 chip 完全点不动——catch 住 touch 事件把 tap 一起吞了。
   */
  onScopeChipTap(e: WechatMiniprogram.TouchEvent): void {
    const dataset = e.currentTarget.dataset as { value?: string };
    const raw = dataset.value ?? '';
    if (raw === '') {
      // 静默失败是最糟的体验：至少给个提示，便于现场定位
      wx.showToast({ title: '筛选未生效，请重新编译', icon: 'none' });
      return;
    }
    const scope = raw as TrainerScope;
    if (scope === this.data.scope) return;
    this.setData({ scope });
    this.buildQueue();
  },

  onRateChange(e: WechatMiniprogram.SliderChange): void {
    const rate = e.detail.value;
    this.setData({ rate });
    this.tts?.setRate(rate);
  },

  onRepeatChange(e: WechatMiniprogram.SliderChange): void {
    this.setData({ repeat: e.detail.value });
  },

  onGapChange(e: WechatMiniprogram.SliderChange): void {
    this.setData({ gap: e.detail.value });
  },

  onAutoChange(e: WechatMiniprogram.SwitchChange): void {
    this.setData({ auto: e.detail.value });
  },

  onResetProgress(): void {
    wx.showModal({
      title: '重置进度',
      content: '清空所有练习进度和标记？此操作不可撤销。',
      confirmText: '重置',
      confirmColor: '#e5484d',
      success: (res) => {
        if (!res.confirm) return;
        Object.keys(this.progress).forEach((k) => delete this.progress[Number(k)]);
        clearProgress();
        this.progress = getProgress();
        this.buildQueue();
        wx.showToast({ title: '已重置', icon: 'success' });
      },
    });
  },

  /* ============ 触屏滑动切句 ============ */

  onStageTouchStart(e: WechatMiniprogram.TouchEvent): void {
    const touch = e.touches[0];
    if (touch === undefined) return;
    this.touchX = touch.clientX;
    this.touchY = touch.clientY;
    this.touchMoved = true;
  },

  onStageTouchEnd(e: WechatMiniprogram.TouchEvent): void {
    if (!this.touchMoved) return;
    const touch = e.changedTouches[0];
    if (touch === undefined) return;
    const dx = touch.clientX - this.touchX;
    const dy = touch.clientY - this.touchY;
    this.touchMoved = false;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      this.next(dx < 0 ? 1 : -1);
    }
  },

  noop(): void {},
});
