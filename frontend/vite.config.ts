/**
 * Vite 配置（架构文档 §2 / §9.13）
 *
 * - `@shared` 别名指向 ../shared：前端原样 import 共享契约 TS 类型与 scenes.json（零编译产物）；
 * - dev 代理 `/api` → http://localhost:3001（后端 dev/prod 端口约定）；
 * - preview（4173）显式配置同一代理：`pnpm build && pnpm preview` 联调生产构建用；
 * - manualChunks vendor 分包：react 系与 MUI 系拆分，消除单 chunk >500kB 警告，
 *   同时提升缓存命中率（业务代码改动不再导致整个 vendor 缓存失效）；
 * - 生产模式由 Express 托管 dist 静态文件（同源部署，无 CORS）。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/** 以 import.meta.url 定位路径（ESM 无 __dirname，且不引入 @types/node） */
const resolveFromRoot = (relative: string): string => new URL(relative, import.meta.url).pathname;

/** /api 代理规则（dev 与 preview 共用同一份） */
const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
};

/**
 * vendor 分包（按包名精确归属，避免 Rollup 对象式 manualChunks 的循环 chunk 警告）：
 * - mui-vendor：@mui/* + @emotion/*（组件库全家桶）；
 * - react-vendor：react / react-dom / react-router 系（含其独占依赖 scheduler 等）；
 * - 其余第三方（zustand / clsx 等小包）随业务 chunk，不值得单独拆。
 */
const REACT_VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  'react',
  'react-dom',
  'react-router-dom',
  '@remix-run/router',
  'scheduler',
]);

/** 从模块路径提取包名（兼容 npm 平铺与 pnpm 符号链接两种 node_modules 布局） */
function packageNameOf(id: string): string {
  const matches = id.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/g);
  if (matches === null || matches.length === 0) return '';
  return matches[matches.length - 1].slice('node_modules/'.length);
}

function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return undefined;
  const pkg = packageNameOf(id);
  if (pkg.startsWith('@mui/') || pkg.startsWith('@emotion/')) return 'mui-vendor';
  if (REACT_VENDOR_PACKAGES.has(pkg)) return 'react-vendor';
  return undefined;
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolveFromRoot('./src'),
      '@shared': resolveFromRoot('../shared'),
    },
  },
  server: {
    port: 5173,
    proxy: apiProxy,
  },
  preview: {
    port: 4173,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: vendorChunk,
      },
    },
  },
});
