/**
 * Kokoro 推理 Worker（独立线程，纯 ESM JavaScript）
 *
 * ⚠️ 为什么必须放在 Worker 里：
 * onnxruntime-node 的 CPU 推理是**同步 native 调用**，会阻塞所在线程的整个事件循环。
 * 放在 Express 主线程里，单句合成约 1.5-2s，期间聊天页的 SSE 流式推送、鉴权、限流
 * 全部停摆——多用户并发时会叠加成服务假死。Worker 线程把阻塞限制在独立线程内。
 *
 * ⚠️ 为什么是 .mjs 而不是 .ts：
 * Worker 入口文件由 Node 直接加载，不经过 tsx 的 TS 编译管线；
 * 写成纯 ESM JS 可以避免 worker 内的编译/loader 差异问题。
 * 所以本文件里**不能出现任何 TypeScript 类型标注**。
 *
 * 消息协议：
 *   主 → worker : { id, type: 'synthesize', text, voice, speed }
 *   worker → 主 : { id, type: 'audio', audio: Float32Array, samplingRate }
 *                 { id, type: 'error', message }
 *   worker → 主 : { type: 'ready', voices: string[] }   （模型加载完成时主动上报）
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 模型仓库 id（与本地目录结构 models/onnx-community/Kokoro-82M-v1.0-ONNX/ 对应） */
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

/**
 * 模型根目录。
 * 优先用主线程通过 workerData 传入的值，其次 TTS_MODEL_DIR 环境变量，
 * 最后回退到 <backend>/models（本文件在 backend/workers/ 下，故取 ../models）。
 */
const modelsRoot =
  workerData?.modelDir ??
  process.env.TTS_MODEL_DIR ??
  path.resolve(here, '../models');

// ⚠️ env 必须从 '@huggingface/transformers' 导入，且必须在 from_pretrained 之前设置。
// kokoro-js re-export 的 env 是代理对象，改它不会影响真正执行推理的 transformers 实例
// （实测：设 allowRemoteModels=false 不生效，本地模型路径也不生效）。
env.localModelPath = modelsRoot;
env.cacheDir = path.join(modelsRoot, 'transformers');
// 纯本地推理：模型文件已预下载。关掉远程回退——缺文件时立刻报错，
// 而不是卡 10 秒连接超时，排查时极易误判成网络问题。
env.allowRemoteModels = false;

if (parentPort === null) {
  throw new Error('[tts-worker] 必须以 Worker 方式启动');
}

let ttsPromise = null;

function getTts() {
  if (ttsPromise === null) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'cpu' });
  }
  return ttsPromise;
}

parentPort.on('message', (msg) => {
  const id = typeof msg.id === 'number' ? msg.id : 0;
  if (msg.type !== 'synthesize') {
    return;
  }
  void (async () => {
    try {
      const tts = await getTts();
      const audio = await tts.generate(String(msg.text ?? ''), {
        voice: String(msg.voice ?? 'af_heart'),
        speed: typeof msg.speed === 'number' ? msg.speed : 1,
      });
      const pcm = audio.audio;
      // 转移（transfer）ArrayBuffer，避免大数组结构化克隆的拷贝开销
      parentPort.postMessage(
        { id, type: 'audio', audio: pcm, samplingRate: audio.sampling_rate },
        [pcm.buffer],
      );
    } catch (err) {
      parentPort.postMessage({
        id,
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  })();
});

// 模型加载完成后主动上报就绪（主线程在此之前会把请求排队）
void (async () => {
  try {
    const tts = await getTts();
    parentPort.postMessage({ type: 'ready', voices: Object.keys(tts.voices ?? {}) });
  } catch (err) {
    parentPort.postMessage({
      type: 'fatal',
      message: err instanceof Error ? err.message : String(err),
    });
  }
})();
