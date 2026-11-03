/**
 * 语音抽象接口（speech/adapter.ts）
 *
 * 与 H5 端 speech/SpeechAdapter.ts 刻意保持同构：业务层只依赖本接口，
 * 这样「浏览器 Web Speech API / 微信同声传译插件 / 纯文字」三种实现可以随意替换。
 *
 * 小程序侧的语义差异：
 * - ASR 不再是「边说边出结果的连续识别」，而是「按住录音 → 松手等定稿」；
 * - TTS 没有系统合成队列，需要自己落盘音频文件并用 InnerAudioContext 串行播放。
 */

/** ASR 错误分类（业务层按类别决定是否永久降级） */
export type AsrErrorKind =
  | 'permission' // 未授权麦克风 → 引导去设置页开启
  | 'unsupported' // 当前环境/引擎不支持 → 永久降级文字输入
  | 'network' // 识别服务网络异常
  | 'no-speech' // 没听清（可重试）
  | 'aborted' // 主动放弃
  | 'unknown';

export interface AsrError {
  kind: AsrErrorKind;
  message: string;
}

export interface AsrStartOptions {
  /** 中间结果回调（边说边上屏；不支持时可不回调） */
  onInterim(text: string): void;
  /**
   * 定稿（空串 = 未识别到有效语音）。
   *
   * @param recording 录音临时文件（引擎支持时提供）——用于发音评估上传：
   *   WechatSI 的 onStop 回调自带 tempFilePath（mp3），业务层拿去调 /api/pronounce。
   *   纯文字引擎无录音，为 undefined。
   */
  onFinal(text: string, recording?: { filePath: string }): void;
  /** 错误（触发后本轮结束，不再 onFinal） */
  onError(error: AsrError): void;
}

export interface AsrSession {
  /** 松手：等待定稿后回调 onFinal */
  stop(): void;
  /** 放弃本轮（不交付结果） */
  abort(): void;
}

export interface TtsControllerOptions {
  /** 语速 0.5–2.0 */
  rate?: number;
  /** 播报状态变化（顶栏指示用） */
  onSpeakingChange?(speaking: boolean): void;
  /** 开始朗读某一句时回调（逐句高亮用；text 为即将朗读的句子原文） */
  onSentenceStart?(text: string): void;
}

export interface TtsController {
  /** 追加一句（自动串行播放） */
  enqueue(text: string): void;
  /** 清空队列并立即停止 */
  stop(): void;
  setRate(rate: number): void;
  /** 释放音频实例（页面卸载时必须调用，否则后台继续播） */
  destroy(): void;
}

export interface SpeechAdapter {
  /** 引擎名（UI 展示与日志） */
  readonly name: string;
  readonly asrSupported: boolean;
  readonly ttsSupported: boolean;

  startAsr(options: AsrStartOptions): AsrSession;
  createTts(options?: TtsControllerOptions): TtsController;
}
