/**
 * Kokoro 本地 TTS 冒烟测试
 *
 * 用法：node scripts/test-kokoro.mjs
 *
 * 验证：本地加载模型 → 列出音色 → 合成句子并计时 → 落盘 wav
 *
 * ⚠️ env 必须从 '@huggingface/transformers' 导入。
 * kokoro-js re-export 的 env 是代理对象，改它不影响真正干活的 transformers 实例。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsRoot = path.resolve(here, '../models');

env.localModelPath = modelsRoot;
env.cacheDir = path.join(modelsRoot, 'transformers');
// 纯本地推理：模型已预下载到 models/。关掉远程回退，
// 缺文件时立刻报错，而不是卡 10 秒连接超时（排查时极易误判成网络问题）。
env.allowRemoteModels = false;

console.log(`[test] localModelPath = ${env.localModelPath}`);

const t0 = Date.now();
const tts = await KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX', {
  dtype: 'q8',
  device: 'cpu',
});
console.log(`[test] 模型加载完成，耗时 ${Date.now() - t0} ms`);

const voiceIds = Object.keys(tts.voices ?? {});
console.log(`[test] 可用音色 ${voiceIds.length} 个`);

for (const voice of ['af_heart', 'am_michael', 'bf_emma']) {
  const t1 = Date.now();
  const audio = await tts.generate('Nice to meet you. How are you doing today?', { voice });
  const ms = Date.now() - t1;
  const seconds = audio.audio.length / audio.sampling_rate;
  console.log(
    `[test] ${voice}: ${ms} ms, ${seconds.toFixed(2)} s 音频, 实时率 ${(seconds / (ms / 1000)).toFixed(2)}x, 采样率 ${audio.sampling_rate}`,
  );
  await audio.save(path.resolve(here, `../models/test-${voice}.wav`));
}

console.log('[test] OK');
