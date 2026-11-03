/**
 * 语音生命周期 hook（架构文档 §2 hooks/useSpeech.ts）。
 *
 * - ASR：按住说话生命周期（start/stop/cancel），interim 实时状态供上屏；
 * - TTS：句级播报队列（C5）——feedDelta 做句边界检测（正则见 §9.11），
 *   delta 累积命中完整句立即入队（首句即播报，不等整段生成完）；
 *   流结束 flushSpeech 播残句；失败 discardPendingSpeech 丢弃残句；
 * - TTS 不可用：静默降级纯文字（适配器 no-op）；ttsEnabled=false 时不入队并清空。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AsrError, AsrSession, TtsController } from '../speech/SpeechAdapter';
import { speechAdapter } from '../speech/WebSpeechAdapter';
import { useSettingsStore } from '../stores/settingsStore';

/** 句边界正则（架构文档 §9.11）：非终结符 + 终结符(.!?) + 可选收尾引号/括号 + 空白 */
const SENTENCE_PATTERN = /[^.!?]+[.!?]+["')\]]*\s*/;

export interface StartListeningOptions {
  onFinal(text: string): void;
  onError(error: AsrError): void;
}

/** 从缓冲中抽出全部完整句，返回剩余残句 */
function extractSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;
  for (;;) {
    const match = rest.match(SENTENCE_PATTERN);
    if (match === null || match.index === undefined || match[0].length === 0) break;
    sentences.push(match[0].trim());
    rest = rest.slice(match.index + match[0].length);
  }
  return { sentences, rest };
}

export function useSpeech() {
  const ttsEnabled = useSettingsStore((state) => state.ttsEnabled);
  const ttsRate = useSettingsStore((state) => state.ttsRate);

  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [speaking, setSpeaking] = useState(false);

  const asrSessionRef = useRef<AsrSession | null>(null);
  const ttsRef = useRef<TtsController | null>(null);
  const sentenceBufferRef = useRef('');
  const ttsEnabledRef = useRef(ttsEnabled);
  ttsEnabledRef.current = ttsEnabled;

  /** 懒创建 TTS 控制器（首句入队时；rate 取创建时最新值，此后由 effect 同步） */
  const ensureTts = useCallback((): TtsController | null => {
    if (!speechAdapter.ttsSupported) return null;
    if (ttsRef.current === null) {
      ttsRef.current = speechAdapter.createTts({
        rate: useSettingsStore.getState().ttsRate,
        onSpeakingChange: setSpeaking,
      });
    }
    return ttsRef.current;
  }, []);

  /* 语速变化即时生效（P1-1） */
  useEffect(() => {
    ttsRef.current?.setRate(ttsRate);
  }, [ttsRate]);

  /* TTS 关闭：丢弃残句并停止当前播报 */
  useEffect(() => {
    if (!ttsEnabled) {
      sentenceBufferRef.current = '';
      ttsRef.current?.stop();
    }
  }, [ttsEnabled]);

  /* 卸载清理：中止识别、停止播报 */
  useEffect(
    () => () => {
      asrSessionRef.current?.abort();
      asrSessionRef.current = null;
      ttsRef.current?.stop();
    },
    [],
  );

  const startListening = useCallback((options: StartListeningOptions): void => {
    if (!speechAdapter.asrSupported) {
      options.onError({ kind: 'unsupported', message: '当前浏览器不支持语音识别' });
      return;
    }
    if (asrSessionRef.current !== null) return; // 已在识别中，忽略重复按压

    setListening(true);
    setInterim('');
    asrSessionRef.current = speechAdapter.startAsr({
      lang: 'en-US',
      onInterim: (text) => setInterim(text),
      onFinal: (text) => {
        asrSessionRef.current = null;
        setListening(false);
        setInterim('');
        options.onFinal(text);
      },
      onError: (error) => {
        asrSessionRef.current = null;
        setListening(false);
        setInterim('');
        options.onError(error);
      },
    });
  }, []);

  /** 松开按钮：等待定稿（onFinal 异步到达） */
  const stopListening = useCallback((): void => {
    asrSessionRef.current?.stop();
    setListening(false);
  }, []);

  /** 立即放弃本轮（<300ms 误触等） */
  const cancelListening = useCallback((): void => {
    asrSessionRef.current?.abort();
    asrSessionRef.current = null;
    setListening(false);
    setInterim('');
  }, []);

  /** delta 到达：句边界检测 → 完整句立即入队播报（首句即播，C5） */
  const feedDelta = useCallback(
    (text: string): void => {
      if (!ttsEnabledRef.current) return;
      const controller = ensureTts();
      if (controller === null) return;
      sentenceBufferRef.current += text;
      const { sentences, rest } = extractSentences(sentenceBufferRef.current);
      sentenceBufferRef.current = rest;
      for (const sentence of sentences) {
        controller.enqueue(sentence);
      }
    },
    [ensureTts],
  );

  /** 流式定论：把残句播完 */
  const flushSpeech = useCallback((): void => {
    const rest = sentenceBufferRef.current.trim();
    sentenceBufferRef.current = '';
    if (!ttsEnabledRef.current || rest.length === 0) return;
    const controller = ensureTts();
    controller?.enqueue(rest);
  }, [ensureTts]);

  /** 本轮失败：丢弃未播残句（避免播出半截失败回复） */
  const discardPendingSpeech = useCallback((): void => {
    sentenceBufferRef.current = '';
  }, []);

  /** 立即停止播报（顶栏停止按钮，P1-1） */
  const stopSpeaking = useCallback((): void => {
    sentenceBufferRef.current = '';
    ttsRef.current?.stop();
  }, []);

  return {
    asrSupported: speechAdapter.asrSupported,
    ttsSupported: speechAdapter.ttsSupported,
    listening,
    interim,
    speaking,
    startListening,
    stopListening,
    cancelListening,
    feedDelta,
    flushSpeech,
    discardPendingSpeech,
    stopSpeaking,
  };
}
