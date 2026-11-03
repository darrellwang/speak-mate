/**
 * TTS 引擎服务：本地 Kokoro（主）+ 在线 Edge TTS（回退）
 *
 * ## 架构
 *
 *   GET /api/tts
 *        │
 *        ├─ engine=edge  ──────────────→ Edge TTS（微软公共端点，流式收集成 mp3）
 *        │
 *        └─ engine=local/auto
 *               │
 *               ├─ Worker 线程（ONNX Runtime CPU 推理，隔离事件循环阻塞）
 *               │     └─ Float32 PCM (24kHz mono)
 *               └─ ffmpeg（管道）→ mp3
 *                        │
 *                        └─ 失败 → engine=auto 时回退 Edge TTS
 *
 * ## 为什么推理要放 Worker 线程
 *
 * onnxruntime-node 的 CPU 推理是同步 native 调用，会阻塞所在线程的事件循环。
 * 若直接放在 Express 主线程，单句合成约 1.5-2s，期间聊天页的 SSE 流式推送、
 * 鉴权、限流全部停摆——并发时叠加成服务假死。Worker 线程把阻塞限制在独立线程。
 *
 * ## 为什么本地引擎输出 mp3 而非 wav
 *
 * 微信 InnerAudioContext 官方支持 wav（iOS/Android 均可），但 mp3 兼容性最好、
 * 体积更小（3s 音频：wav 282KB → mp3 25KB），且与原在线 Edge TTS 方案行为一致，
 * 小程序端零改动。ffmpeg 管道转码实测约 120ms。
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';

import { config } from '../config/env';

/** 本地引擎合成的音频格式 */
export const TTS_CONTENT_TYPE = 'audio/mpeg';

/** 单次合成的超时（毫秒）——本地推理 3s 音频约 1.7s，留足余量 */
const SYNTH_TIMEOUT_MS = 30_000;

/**
 * 对外音色 id（Edge TTS 命名）→ 本地 Kokoro 音色 id。
 *
 * 保持对外 id 不变，小程序端（config.ts / 设置页 picker）**零改动**；
 * 只有后端把 id 翻译成本地模型里的音色名。
 *
 * 选音依据：Kokoro 官方给出每个音色的训练目标与总评级，优先取高评级；
 * 男女/美英的组合尽量覆盖原来的 6 个音色定位。
 */
export const KOKORO_VOICE_MAP: Readonly<Record<string, string>> = {
  'en-US-JennyNeural': 'af_heart', // 美式女 · 评级 A（最高）
  'en-US-GuyNeural': 'am_michael', // 美式男 · 评级 C+
  'en-US-AriaNeural': 'af_bella', // 美式女 · 评级 A-
  'en-US-ChristopherNeural': 'am_fenrir', // 美式男 · 评级 C+
  'en-GB-SoniaNeural': 'bf_emma', // 英式女 · 评级 B-
  'en-GB-RyanNeural': 'bm_george', // 英式男 · 评级 C
};

/** 把 Edge 语速（SSML prosody，如 "+10%"）换算成 Kokoro 的 speed 倍率（0.5-2.0） */
export function parseSpeed(rate: string): number {
  const m = /([+-]?\d+(?:\.\d+)?)%/.exec(rate.trim());
  if (m === null) {
    return 1;
  }
  const pct = Number(m[1]);
  if (!Number.isFinite(pct)) {
    return 1;
  }
  return Math.min(2, Math.max(0.5, 1 + pct / 100));
}

/** 合成结果 */
export interface TtsAudio {
  /** mp3 二进制 */
  buffer: Buffer;
  /** 实际使用的引擎 */
  engine: 'kokoro' | 'edge';
  /** 实际使用的音色（Edge id 或 Kokoro id） */
  voice: string;
}

// ---------------------------------------------------------------------------
// 本地引擎（Worker 线程）
// ---------------------------------------------------------------------------

interface PendingJob {
  resolve: (v: { pcm: Float32Array; samplingRate: number }) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

type TtsStatus = 'idle' | 'loading' | 'ready' | 'error';

class LocalTtsEngine {
  private worker: Worker | null = null;
  private status: TtsStatus = 'idle';
  private lastError: string | null = null;
  private seq = 0;
  private readonly pending = new Map<number, PendingJob>();
  /** 就绪前收到的请求，模型就绪后依次发出 */
  private readonly queue: Array<{ id: number; text: string; voice: string; speed: number }> = [];

  getStatus(): TtsStatus {
    return this.status;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  /** 启动 Worker 并加载模型（幂等，可重复调用） */
  start(): void {
    if (this.worker !== null) {
      return;
    }
    this.status = 'loading';
    this.lastError = null;

    const here = path.dirname(fileURLToPath(import.meta.url));
    const workerFile = path.resolve(here, '../../workers/tts.worker.mjs');
    // ⚠️ 必须传 URL **对象**：Node 的 Worker 构造函数接受 URL 对象，
    // 但传 file:// 的字符串会报 "must be an absolute path or a relative path
    // starting with './' or '../'"（file:// URL 字符串不被接受）。
    const workerUrl = new URL(pathToFileURL(workerFile).href);

    let worker: Worker;
    try {
      worker = new Worker(workerUrl, {
        // 把模型目录传给 worker，避免两边各自算一遍相对路径
        workerData: { modelDir: config.tts.modelDir },
      });
    } catch (err) {
      this.status = 'error';
      this.lastError = err instanceof Error ? err.message : String(err);
      console.error('[tts] 本地引擎 Worker 启动失败:', this.lastError);
      return;
    }
    this.worker = worker;

    worker.on('message', (msg: Record<string, unknown>) => {
      this.handleMessage(msg);
    });
    worker.on('error', (err: Error) => {
      this.failAll(err);
      this.status = 'error';
      this.lastError = err.message;
      console.error('[tts] 本地引擎 Worker 异常:', err.message);
      this.worker = null;
    });
    worker.on('exit', (code: number) => {
      if (code !== 0) {
        this.failAll(new Error(`本地引擎 Worker 退出，code=${code}`));
        this.status = 'error';
        this.lastError = `Worker 退出 code=${code}`;
      }
      this.worker = null;
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    const type = msg['type'];
    if (type === 'ready') {
      this.status = 'ready';
      this.lastError = null;
      const voices = Array.isArray(msg['voices']) ? (msg['voices'] as string[]) : [];
      console.log(`[tts] 本地 Kokoro 引擎就绪（${voices.length} 个音色，模型目录 ${config.tts.modelDir}）`);
      this.flushQueue();
      return;
    }
    if (type === 'fatal') {
      const message = String(msg['message'] ?? '未知错误');
      this.status = 'error';
      this.lastError = message;
      console.error('[tts] 本地引擎加载失败:', message);
      this.failAll(new Error(message));
      return;
    }

    const id = typeof msg['id'] === 'number' ? msg['id'] : -1;
    const job = this.pending.get(id);
    if (job === undefined) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(job.timer);

    if (type === 'error') {
      job.reject(new Error(String(msg['message'] ?? '本地合成失败')));
      return;
    }
    if (type === 'audio') {
      const pcm = msg['audio'];
      const samplingRate = typeof msg['samplingRate'] === 'number' ? msg['samplingRate'] : 24_000;
      if (!(pcm instanceof Float32Array)) {
        job.reject(new Error('本地引擎返回的音频数据格式异常'));
        return;
      }
      job.resolve({ pcm, samplingRate });
    }
  }

  /** 模型就绪后把排队的请求发出去 */
  private flushQueue(): void {
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      if (item === undefined) {
        break;
      }
      this.dispatch(item);
    }
  }

  private dispatch(item: { id: number; text: string; voice: string; speed: number }): void {
    this.worker?.postMessage({
      id: item.id,
      type: 'synthesize',
      text: item.text,
      voice: item.voice,
      speed: item.speed,
    });
  }

  private failAll(err: Error): void {
    for (const job of this.pending.values()) {
      clearTimeout(job.timer);
      job.reject(err);
    }
    this.pending.clear();
    this.queue.length = 0;
  }

  /** 本地合成：Float32 PCM */
  async synthesize(text: string, kokoroVoice: string, speed: number): Promise<{ pcm: Float32Array; samplingRate: number }> {
    this.start();
    if (this.status === 'error') {
      throw new Error(this.lastError ?? '本地引擎不可用');
    }

    const id = ++this.seq;
    return new Promise<{ pcm: Float32Array; samplingRate: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('本地合成超时'));
      }, SYNTH_TIMEOUT_MS);
      // 定时器不应拖住进程退出
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });

      if (this.status === 'ready') {
        this.dispatch({ id, text, voice: kokoroVoice, speed });
      } else {
        // 还没就绪 → 排队，等 'ready' 消息后统一发出
        this.queue.push({ id, text, voice: kokoroVoice, speed });
      }
    });
  }
}

const localEngine = new LocalTtsEngine();

// ---------------------------------------------------------------------------
// ffmpeg：PCM → mp3
// ---------------------------------------------------------------------------

/**
 * 用 ffmpeg 把 Float32 PCM 转成 mp3（管道传输，不落盘）。
 *
 * 用 -f f32le 直接喂原始浮点采样，不必先封 WAV，省一步封装。
 */
function encodeMp3(pcm: Float32Array, samplingRate: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'f32le',
      '-ar',
      String(samplingRate),
      '-ac',
      '1',
      '-i',
      'pipe:0',
      '-codec:a',
      'libmp3lame',
      '-b:a',
      '64k',
      '-f',
      'mp3',
      'pipe:1',
    ];

    let child;
    try {
      child = spawn(config.tts.ffmpegPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }

    const chunks: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (c: Buffer) => chunks.push(c));
    child.stderr.on('data', (c: Buffer) => stderr.push(c));
    child.on('error', (err: Error) => reject(err));
    child.on('close', (code: number | null) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').slice(0, 300);
        reject(new Error(`ffmpeg 转码失败（code=${code}）：${detail}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    // 注意：Float32Array 可能是 Buffer 视图的一段，必须用 byteOffset/byteLength
    const raw = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    child.stdin.on('error', () => {
      /* 子进程提前退出时忽略 EPIPE，由 close 事件统一报错 */
    });
    child.stdin.end(raw);
  });
}

// ---------------------------------------------------------------------------
// Edge TTS（在线回退）
// ---------------------------------------------------------------------------

/**
 * Edge TTS 需要 SSML prosody，文本里的 XML 特殊字符必须转义。
 *
 * ⚠️ 转义只在这一条分支里做：Kokoro 走纯文本输入，
 * 若在路由层统一转义，本地引擎会把 "&" 当字面念出来。
 */
function escapeXml(text: string): string {
  // 用 charCode 构造 &，源码里不出现裸实体字面量（避免被工具链/编码吞掉）
  const amp = String.fromCharCode(38);
  return text
    .replace(/&/g, `${amp}amp;`)
    .replace(/</g, `${amp}lt;`)
    .replace(/>/g, `${amp}gt;`)
    .replace(/"/g, `${amp}quot;`)
    .replace(/'/g, `${amp}apos;`);
}

/** 把 Edge TTS 的音频流收集成完整 Buffer */
async function synthesizeWithEdge(text: string, voice: string, rate: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(escapeXml(text), { rate });

  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    audioStream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
    audioStream.on('end', () => resolve(Buffer.concat(chunks)));
    audioStream.on('error', (err: unknown) =>
      reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

/** 后台预热：启动时就把模型加载起来，避免首个请求等 1~2s */
export function warmupLocalTts(): void {
  if (config.tts.engine === 'edge') {
    return;
  }
  setImmediate(() => {
    localEngine.start();
  });
}

/** 本地引擎状态（供 /api/health 使用） */
export function localTtsStatus(): { status: TtsStatus; error: string | null; modelDir: string } {
  return {
    status: localEngine.getStatus(),
    error: localEngine.getLastError(),
    modelDir: config.tts.modelDir,
  };
}

/**
 * 合成语音（统一入口）。
 *
 * - engine=edge  → 直接走在线 Edge TTS
 * - engine=local → 只用本地 Kokoro，失败抛错
 * - engine=auto  → 本地优先，失败自动回退 Edge TTS
 *
 * @param text        要合成的文本
 * @param voice       对外音色 id（Edge 命名），非法值由调用方校验
 * @param rate        语速（SSML prosody 风格，如 "+0%"）
 */
export async function synthesizeSpeech(text: string, voice: string, rate: string): Promise<TtsAudio> {
  const mode = config.tts.engine;

  if (mode === 'edge') {
    const buffer = await synthesizeWithEdge(text, voice, rate);
    return { buffer, engine: 'edge', voice };
  }

  const kokoroVoice = KOKORO_VOICE_MAP[voice] ?? KOKORO_VOICE_MAP['en-US-JennyNeural'];
  try {
    const { pcm, samplingRate } = await localEngine.synthesize(text, kokoroVoice, parseSpeed(rate));
    const buffer = await encodeMp3(pcm, samplingRate);
    return { buffer, engine: 'kokoro', voice };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (mode === 'local') {
      throw new Error(`本地 TTS 合成失败：${message}`);
    }
    console.warn(`[tts] 本地引擎失败，回退 Edge TTS：${message}`);
    const buffer = await synthesizeWithEdge(text, voice, rate);
    return { buffer, engine: 'edge', voice };
  }
}
