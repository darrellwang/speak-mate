/**
 * Web Speech API 实现（架构文档 §2 speech/WebSpeechAdapter.ts，唯一实现）。
 *
 * ASR（webkitSpeechRecognition 兼容）：
 * - lang=en-US、continuous=true（按住期间不自动断流）、interimResults=true（实时上屏）；
 * - 松开 → stop() → 浏览器补定稿 → onend 交付（final 累积 + 残余 interim 兜底）；
 * - 权限失败（not-allowed/audio-capture）→ onError(kind='permission')，前端降级文字输入；
 *
 * TTS（speechSynthesis）：
 * - en-US 音色择优（Google US English / 自然音色 / 任意 en-US）；
 * - 句级串行队列：onend 后播下一句；stop() 用代际计数作废挂起回调；
 * - 语速 0.5–2.0（来自画像 settings.tts_rate，上下限见 shared/constants）。
 */
import { TTS_RATE_DEFAULT, clampTtsRate } from '@shared/constants';
import type {
  AsrErrorKind,
  AsrSession,
  AsrStartOptions,
  SpeechAdapter,
  TtsController,
  TtsControllerOptions,
} from './SpeechAdapter';

/* ---------- Web Speech API 最小类型声明（TS lib.dom 未收录 SpeechRecognition） ---------- */

interface SpeechRecognitionAlternativeLike {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResultLike {
  readonly length: number;
  readonly isFinal: boolean;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionResultListLike {
  readonly length: number;
  [index: number]: SpeechRecognitionResultLike;
}

interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultListLike;
}

interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
  readonly message?: string;
}

interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: ((event: Event) => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/* ---------- 工具 ---------- */

const ASR_ERROR_MESSAGES: Record<AsrErrorKind, string> = {
  permission: '未获得麦克风权限，已切换为文字输入',
  unsupported: '当前浏览器不支持语音识别，已切换为文字输入',
  network: '语音识别服务网络异常，请稍后重试',
  'no-speech': '没有识别到语音，请再试一次',
  aborted: '已取消',
  unknown: '语音识别出现问题，请重试',
};

function mapAsrErrorKind(code: string): AsrErrorKind {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'permission';
  if (code === 'audio-capture') return 'permission';
  if (code === 'network') return 'network';
  if (code === 'no-speech') return 'no-speech';
  if (code === 'aborted') return 'aborted';
  return 'unknown';
}

/* ---------- 实现 ---------- */

export class WebSpeechAdapter implements SpeechAdapter {
  readonly asrSupported: boolean;
  readonly ttsSupported: boolean;

  private readonly recognitionCtor: SpeechRecognitionCtor | null;

  constructor() {
    const w = window as unknown as SpeechRecognitionWindow;
    this.recognitionCtor = w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
    this.asrSupported = this.recognitionCtor !== null;
    this.ttsSupported =
      typeof window !== 'undefined' &&
      typeof window.speechSynthesis !== 'undefined' &&
      typeof window.SpeechSynthesisUtterance !== 'undefined';
  }

  startAsr(options: AsrStartOptions): AsrSession {
    const Ctor = this.recognitionCtor;
    if (Ctor === null) {
      options.onError({ kind: 'unsupported', message: ASR_ERROR_MESSAGES.unsupported });
      return { stop: () => undefined, abort: () => undefined };
    }

    const recognition = new Ctor();
    recognition.lang = options.lang ?? 'en-US';
    recognition.continuous = true; // 按住期间不自动断流，由 stop() 收口
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let finalText = '';
    let lastInterim = '';
    let aborted = false;
    let errorReported = false;
    let finished = false;

    /** 交付定稿（final 累积 + 残余 interim 兜底拼接） */
    const finish = (deliver: boolean): void => {
      if (finished) return;
      finished = true;
      if (!deliver || aborted || errorReported) return;
      const parts = [finalText.trim(), lastInterim.trim()].filter((part) => part.length > 0);
      options.onFinal(parts.join(' '));
    };

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const alternative = result[0];
        const transcript = alternative !== undefined ? alternative.transcript : '';
        if (result.isFinal) {
          finalText += transcript;
        } else {
          interim += transcript;
        }
      }
      lastInterim = interim;
      // 实时上屏：已定稿 + 当前中间结果（P1-2）
      const display = [finalText.trim(), interim.trim()].filter((part) => part.length > 0).join(' ');
      options.onInterim(display);
    };

    recognition.onerror = (event) => {
      if (aborted || event.error === 'aborted') return;
      errorReported = true;
      const kind = mapAsrErrorKind(event.error);
      options.onError({ kind, message: ASR_ERROR_MESSAGES[kind] });
    };

    recognition.onend = () => finish(true);

    try {
      recognition.start();
    } catch {
      finished = true;
      options.onError({ kind: 'unknown', message: '无法启动语音识别，请稍后重试' });
    }

    return {
      stop: () => {
        try {
          recognition.stop();
        } catch {
          finish(true);
        }
      },
      abort: () => {
        aborted = true;
        try {
          recognition.abort();
        } catch {
          finish(false);
        }
      },
    };
  }

  createTts(options: TtsControllerOptions = {}): TtsController {
    if (!this.ttsSupported) {
      // TTS 不可用：静默降级为纯文字（PRD 异常分支），控制器全部 no-op
      return { enqueue: () => undefined, stop: () => undefined, setRate: () => undefined };
    }
    const synth = window.speechSynthesis;
    let rate = clampTtsRate(options.rate ?? TTS_RATE_DEFAULT);
    let queue: string[] = [];
    let speaking = false;
    let generation = 0; // stop() 递增，作废挂起的 onend/onerror 回调链

    const notifySpeaking = (): void => {
      options.onSpeakingChange?.(speaking);
    };

    /* 音色缓存：Chrome getVoices 异步填充，监听 voiceschanged 刷新 */
    let voicesCache: SpeechSynthesisVoice[] = [];
    const loadVoices = (): void => {
      voicesCache = synth.getVoices();
    };
    loadVoices();
    if (typeof synth.onvoiceschanged !== 'undefined') {
      synth.onvoiceschanged = loadVoices;
    }

    const pickVoice = (): SpeechSynthesisVoice | null => {
      const enUs = voicesCache.filter((voice) => voice.lang === 'en-US' || voice.lang.startsWith('en_US'));
      if (enUs.length === 0) return null;
      const preferred =
        enUs.find((voice) => /google us english/i.test(voice.name)) ??
        enUs.find((voice) => /samantha|aria|jenny|guy|natural|neural/i.test(voice.name)) ??
        null;
      return preferred ?? enUs[0];
    };

    const speakNext = (): void => {
      if (queue.length === 0) {
        if (speaking) {
          speaking = false;
          notifySpeaking();
        }
        return;
      }
      const text = queue.shift() as string;
      const currentGeneration = generation;
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'en-US';
      utterance.rate = rate;
      const voice = pickVoice();
      if (voice !== null) utterance.voice = voice;
      utterance.onend = () => {
        if (currentGeneration !== generation) return; // 已 stop，作废
        speakNext();
      };
      utterance.onerror = () => {
        if (currentGeneration !== generation) return;
        speakNext(); // 单句失败不阻断队列
      };
      if (!speaking) {
        speaking = true;
        notifySpeaking();
      }
      if (synth.paused) synth.resume();
      synth.speak(utterance);
    };

    return {
      enqueue: (text) => {
        const trimmed = text.trim();
        if (trimmed.length === 0) return;
        queue.push(trimmed);
        if (!speaking) speakNext();
      },
      stop: () => {
        generation += 1;
        queue = [];
        try {
          synth.cancel();
        } catch {
          // 个别浏览器 cancel 抛错可忽略
        }
        if (speaking) {
          speaking = false;
          notifySpeaking();
        }
      },
      setRate: (nextRate) => {
        rate = clampTtsRate(nextRate);
      },
    };
  }
}

/** 全局单例（特性检测在构造时完成一次） */
export const speechAdapter: SpeechAdapter = new WebSpeechAdapter();
