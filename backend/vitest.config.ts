/**
 * Vitest 配置（QA 增补，仅供测试，不属于运行时代码）
 *
 * - pool: forks + singleFork：测试文件顺序执行（避免多文件并行写同一 SQLite 产生竞争），
 *   每个测试文件在隔离的模块注册表中加载（isolate 默认 true），
 *   setup.ts 会在每个文件加载前设置独立随机的 DATA_DIR，实现「一文件一临时库」；
 * - setup.ts 在任何被测模块 import 前设置环境变量（config/env.ts 在 import 时读 env）；
 * - 测试超时放宽到 30s（mock provider 按词流式推送有 25–45ms/块延迟）。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
    testTimeout: 30_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
    },
  },
});
