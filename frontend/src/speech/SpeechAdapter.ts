/**
 * 语音抽象接口（架构文档 §2 speech/SpeechAdapter.ts，可替换点，PRD §6.4）。
 *
 * 业务组件只依赖本接口，不触碰 Web Speech API 细节；
 * 当前唯一实现为 WebSpeechAdapter，未来可整体替换为原生 SDK/云端 ASR 而不动业务层。
 *
 * - ASR：start（en-US、interim 实时回调）→ stop（定稿交付）/ abort（放弃）；
 * - TTS：createTts 创建串行播报控制器（enqueue 队列 / stop 立停 / setRate 调速）。
 */

/** ASR 错误分类（前端按类别降级，架构文档 C6） */
export type AsrErrorKind =
  | 'permission' // 权限拒绝 / 无麦克风 → 永久降级文字输入
  | 'unsupported' // 浏览器不支持 SpeechRecognition → 永久降级
  | 'network' // 识别服务网络异常
  | 'no-speech' // 未识别到语音（可重试）
  | 'aborted' // 主动中止（不作为错误提示）
  | 'unknown';

export interface AsrError {
  kind: AsrErrorKind;
  message: string;
}

export interface AsrStartOptions {
  /** 识别语言，默认 'en-US' */
  lang?: string;
  /** 中间结果实时回调（P1-2：按住说话时上屏增量文本） */
  onInterim(text: string): void;
  /** 定稿交付（stop 后触发；空串 = 无有效语音） */
  onFinal(text: string): void;
  /** 错误回调（触发后本轮会话即结束，不再 onFinal） */
  onError(error: AsrError): void;
}

export interface AsrSession {
  /** 主动结束（松开按钮）：内部等待定稿 → onFinal */
  stop(): void;
  /** 立即放弃本轮识别（不交付结果） */
  abort(): void;
}

export interface TtsControllerOptions {
  /** 语速 0.5–2.0，默认 1（对应画像 settings.tts_rate） */
  rate?: number;
  /** 播报状态回调（顶栏「播报中 + 停止」指示） */
  onSpeakingChange?(speaking: boolean): void;
}

/** TTS 串行播报控制器：句子逐条入队、播完自动下一条（§9.11，规避 Chrome 合成队列上限） */
export interface TtsController {
  /** 追加一句（自动开始播报；队列空且未在播报时立即出队） */
  enqueue(text: string): void;
  /** 清空队列并立即停止当前播报 */
  stop(): void;
  /** 调整语速（对后续入队/未开始的句子生效） */
  setRate(rate: number): void;
}

export interface SpeechAdapter {
  /** 当前环境是否可用浏览器 ASR（不可用 → 语音按钮置灰 + 文字输入兜底） */
  readonly asrSupported: boolean;
  /** 当前环境是否可用浏览器 TTS（不可用 → 静默降级纯文字） */
  readonly ttsSupported: boolean;

  /** 开启一轮按住说话识别 */
  startAsr(options: AsrStartOptions): AsrSession;
  /** 创建 TTS 播报控制器（每页面实例一个） */
  createTts(options?: TtsControllerOptions): TtsController;
}
