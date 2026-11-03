/**
 * 下载本地 TTS 模型（Kokoro-82M）到 backend/models/
 *
 * 用法：
 *   node backend/scripts/fetch-kokoro-model.mjs
 *
 * 为什么需要这个脚本：
 * - transformers.js 用 **Node 原生 fetch**（undici）拉模型，而 undici **不读
 *   HTTP_PROXY/HTTPS_PROXY 环境变量** → 直连 huggingface.co 必然超时；
 * - huggingface.co 在国内还可能被 DNS 污染（实测解析到 Facebook 的 IP）。
 *
 * 所以这里改用系统 curl（Windows 10+ 自带 curl.exe，Git Bash/WSL 也有），
 * 显式带上代理（-x $HTTPS_PROXY）与重定向跟随（-L）。
 *
 * 已存在的文件会跳过，可重复执行、断点续传。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');
const modelsRoot = path.resolve(backendRoot, 'models');

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const HOST = process.env.HF_ENDPOINT ?? 'https://hf-mirror.com';
const BASE = `${HOST.replace(/\/+$/, '')}/${REPO}/resolve/main`;

const PROXY = (process.env.HTTPS_PROXY ?? process.env.https_proxy ?? '').trim();

const VOICES = [
  'af_heart', 'af_alloy', 'af_aoede', 'af_bella', 'af_jessica', 'af_kore', 'af_nicole',
  'af_nova', 'af_river', 'af_sarah', 'af_sky',
  'am_adam', 'am_echo', 'am_eric', 'am_fenrir', 'am_liam', 'am_michael', 'am_onyx',
  'am_puck', 'am_santa',
  'bf_alice', 'bf_emma', 'bf_isabella', 'bf_lily',
  'bm_daniel', 'bm_fable', 'bm_george', 'bm_lewis',
];

/** 需要下载的文件（相对模型目录） */
const FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx',
  ...VOICES.map((v) => `voices/${v}.bin`),
];

function curl(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (c) => stderr.push(c));
    child.on('error', (err) =>
      reject(new Error(`无法启动 curl：${err.message}（请确认系统 PATH 里有 curl.exe）`)),
    );
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`curl 退出码 ${code}：${Buffer.concat(stderr).toString('utf8').slice(0, 300)}`));
      }
    });
  });
}

async function download(relative) {
  // 与 transformers.js 的本地加载规则对齐：
  //   env.localModelPath = models/，model_id = <org>/<repo>
  //   → 实际读取 models/<org>/<repo>/<file>
  const dest = path.join(modelsRoot, ...REPO.split('/'), ...relative.split('/'));
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  const args = ['-sSL', '--connect-timeout', '15', '--max-time', '900', '-o', dest];
  if (PROXY !== '') {
    args.unshift('-x', PROXY);
  }
  args.push(`${BASE}/${relative}`);

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await curl(args);
      const size = fs.statSync(dest).size;
      if (size === 0) {
        throw new Error('下载结果为空');
      }
      return size;
    } catch (err) {
      if (attempt === 3) {
        throw err;
      }
      console.log(`    重试 ${attempt}/2 …`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return 0;
}

async function main() {
  console.log(`[fetch] 模型仓库 : ${REPO}`);
  console.log(`[fetch] 下载源   : ${HOST}`);
  console.log(`[fetch] 代理     : ${PROXY === '' ? '（直连）' : PROXY}`);
  console.log(`[fetch] 目标目录 : ${modelsRoot}\n`);

  let downloaded = 0;
  let skipped = 0;
  let totalBytes = 0;

  for (const relative of FILES) {
    const dest = path.join(modelsRoot, ...REPO.split('/'), ...relative.split('/'));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      skipped += 1;
      continue;
    }
    process.stdout.write(`  ↓ ${relative} …`);
    const size = await download(relative);
    totalBytes += size;
    downloaded += 1;
    console.log(` ${(size / 1024 / 1024).toFixed(2)} MB`);
  }

  console.log(
    `\n[fetch] 完成：新下载 ${downloaded} 个（${(totalBytes / 1024 / 1024).toFixed(1)} MB），` +
      `已存在跳过 ${skipped} 个`,
  );
  console.log('[fetch] 可用命令验证：node backend/scripts/test-kokoro.mjs');
}

main().catch((err) => {
  console.error('[fetch] 失败：', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
