/**
 * 管理台 Vite 配置。
 *
 * - base 固定为 /admin/，与后端静态托管路径一致；
 * - dev / preview 把 /api 代理到后端 3001，浏览器只跟管理台同源说话。
 */
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const apiProxy = {
  '/api': {
    target: 'http://localhost:3001',
    changeOrigin: true,
  },
};

export default defineConfig({
  base: '/admin/',
  plugins: [react()],
  server: {
    port: 5174,
    proxy: apiProxy,
  },
  preview: {
    port: 4174,
    proxy: apiProxy,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
