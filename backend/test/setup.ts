/**
 * 测试全局 setup（每个测试文件加载前执行一次）。
 *
 * 关键职责：
 * 1. 在任何被测模块 import 之前设置环境变量——config/env.ts 在模块加载时读取 env，
 *    因此本文件绝不能静态 import 任何 src/ 模块（import 会被提升到本文件语句之前）；
 *    关闭 DB 等清理逻辑一律用动态 import。
 * 2. 每个测试文件分配独立随机临时数据目录（DATA_DIR），
 *    配合 vitest 的文件级模块隔离 = 「一文件一临时库」，测试互不干扰；
 * 3. afterAll 关闭 SQLite 连接并删除临时目录——绝不污染 backend/data/ 联调数据；
 * 4. **复位安全相关环境变量**：vitest 配置为 pool=forks + singleFork，
 *    所有测试文件跑在**同一个进程**里，而 process.env 是进程级全局。
 *    先跑的用例若设置了 ACCESS_TOKEN / ENABLE_RATE_LIMIT 等，会残留并污染后续文件
 *    （表现为"明明没配令牌却返回 401"）。因此每个文件加载前统一复位。
 */
import { randomUUID } from 'node:crypto';
import { rmSync, rmdirSync } from 'node:fs';
import path from 'node:path';
import { afterAll } from 'vitest';

// ⚠️ 必须在任何 src 模块（含 dotenv）加载前设置：
// src/config/env.ts 顶部有 `import 'dotenv/config'`，会把 backend/.env 的
// ACCESS_TOKEN 等注入 process.env。setup 里的 delete 发生在它**之前**，
// 但 dotenv 一执行又把值填回来——表现为「单跑测试文件全 401」。
// 把 DOTENV_CONFIG_PATH 指到一个不存在的路径，dotenv 就会静默跳过，
// 单跑与全量行为从此一致（都不受 .env 影响）。
process.env.DOTENV_CONFIG_PATH = path.resolve('.env-not-loaded-in-test');

const dataDir = path.resolve(`./.data-test/${randomUUID()}`);

// 安全/限流相关开关：默认不启用，需要的文件自行在 import src 之前设置
for (const key of [
  'ACCESS_TOKEN',
  'ADMIN_PASSWORD',
  'ADMIN_USERNAME',
  'CORS_ORIGIN',
  'TRUST_PROXY',
  'ENABLE_RATE_LIMIT',
  'RATE_LIMIT_LLM_PER_MIN',
  'RATE_LIMIT_WRITE_PER_MIN',
  'RATE_LIMIT_READ_PER_MIN',
]) {
  delete process.env[key];
}

process.env.DATA_DIR = dataDir;
process.env.LLM_PROVIDER = 'mock'; // 测试一律 mock，绝不调用真实 LLM 端点
process.env.APP_NAME = 'SpeakMate';
process.env.NODE_ENV = 'test';

afterAll(async () => {
  // 动态 import：此时 config 模块已由测试文件以正确的 DATA_DIR 加载完毕
  const { closeDb } = await import('../src/db/database');
  closeDb();
  rmSync(dataDir, { recursive: true, force: true });
  // 父目录若已空则一并移除（rmdirSync 非空时抛错 → 安全跳过，由最后一个完成者清理）
  try {
    rmdirSync(path.dirname(dataDir));
  } catch {
    // 仍有其他文件的临时目录（如并行执行场景）——保留
  }
});
