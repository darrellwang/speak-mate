/**
 * Vitest 配置（QA 增补，仅供测试）。
 *
 * - 复用 @shared 别名（与 vite.config.ts / tsconfig paths 对齐）；
 * - node 环境：chatStore（zustand）与 sse.ts（fetch/ReadableStream）均为纯逻辑模块，
 *   无需 DOM；fetch 以 FakeResponse 注入（见 test/sse.test.ts）；
 * - 测试目录 frontend/test/ 已纳入 tsconfig include（审查报告 L9），与源码一起接受类型检查，
 *   重构时不会被漏改；依赖显式 `import { describe, it, expect } from 'vitest'`，无需 globals。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 15_000,
  },
});
