/**
 * Kokoro 本地加载诊断（一次性脚本）
 *
 * 排查目标：transformers.js 的 env.localModelPath 设置是否生效、
 * 预期路径下文件是否真的存在、from_pretrained 报的真实错误是什么。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 必须从 '@huggingface/transformers' 导入 env，而不是从 'kokoro-js'。
// kokoro-js re-export 的 env 是个代理对象，改它不会影响真正干活的
// transformers 实例（实测：allowRemoteModels=false 不生效，本地路径也不生效）。
import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const here = path.dirname(fileURLToPath(import.meta.url));
const modelsRoot = path.resolve(here, '../models');
const modelId = 'onnx-community/Kokoro-82M-v1.0-ONNX';

env.localModelPath = modelsRoot;
env.allowRemoteModels = false;

console.log('cwd                =', process.cwd());
console.log('env.localModelPath =', env.localModelPath);
console.log('env.allowLocalModels  =', env.allowLocalModels);
console.log('env.allowRemoteModels =', env.allowRemoteModels);
console.log('env.useFSCache     =', env.useFSCache);
console.log('env.cacheDir       =', env.cacheDir);
console.log('env.remoteHost     =', env.remoteHost);

// 逐个检查预期文件
const files = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
  'voices/af_heart.bin',
];
for (const f of files) {
  const p = path.join(modelsRoot, modelId, f);
  const exists = fs.existsSync(p);
  console.log(`  ${exists ? 'OK ' : 'MISS'} ${f}${exists ? ` (${fs.statSync(p).size} B)` : ''}`);
}

// 试加载；错误信息只取前若干行，避免打印 phonemizer 的单行压缩源码（1.3MB）
try {
  const tts = await KokoroTTS.from_pretrained(modelId, { dtype: 'q8', device: 'cpu' });
  console.log('LOAD OK, voices =', tts.list_voices().length);
} catch (err) {
  console.log('LOAD FAILED');
  console.log('message:', String(err?.message ?? err).slice(0, 300));
  console.log('cause  :', String(err?.cause?.message ?? err?.cause ?? '').slice(0, 300));
  const stack = String(err?.stack ?? '')
    .split('\n')
    .filter((l) => !l.includes('phonemizer.js:1'))
    .slice(0, 14)
    .join('\n');
  console.log('stack  :\n' + stack);
}
