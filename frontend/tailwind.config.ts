/**
 * Tailwind 配置（架构文档 §9.8）
 *
 * 关闭 preflight：reset 交由 MUI CssBaseline 接管，避免双 reset 冲突；
 * MUI 组件内的布局一律使用 Tailwind 工具类，减少 sx 混用。
 */
import type { Config } from 'tailwindcss';

export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  corePlugins: {
    preflight: false,
  },
  theme: {
    extend: {},
  },
  plugins: [],
} satisfies Config;
