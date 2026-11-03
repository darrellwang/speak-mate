/**
 * MUI 主题（架构文档 §2 theme.ts）。
 *
 * - 深色模式跟随系统：App.tsx 依据 prefers-color-scheme 计算 mode 后调用 buildTheme；
 * - 移动端优先：触控目标 ≥44px（MuiButtonBase 全局 minHeight）、圆角卡片、中文优先字体栈。
 */
import { createTheme, type Theme } from '@mui/material/styles';

export type ThemeMode = 'light' | 'dark';

/** 中文优先字体栈（iOS/macOS/Android/桌面全覆盖） */
const FONT_STACK = [
  '-apple-system',
  'BlinkMacSystemFont',
  '"Segoe UI"',
  '"PingFang SC"',
  '"HarmonyOS Sans SC"',
  '"Microsoft YaHei"',
  'Roboto',
  '"Helvetica Neue"',
  'Arial',
  'sans-serif',
].join(', ');

export function buildTheme(mode: ThemeMode): Theme {
  const dark = mode === 'dark';
  return createTheme({
    palette: {
      mode,
      primary: { main: '#2563eb' },
      secondary: { main: '#0ea5e9' },
      success: { main: '#16a34a' },
      warning: { main: '#d97706' },
      error: { main: '#dc2626' },
      background: dark
        ? { default: '#0b0f14', paper: '#151a21' }
        : { default: '#f3f5f9', paper: '#ffffff' },
    },
    shape: { borderRadius: 12 },
    typography: {
      fontFamily: FONT_STACK,
    },
    components: {
      /* 触控目标 ≥44px：所有可点元素统一抬升最小高度（主理人硬性要求） */
      MuiButtonBase: {
        styleOverrides: {
          root: { minHeight: 44 },
        },
      },
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: { textTransform: 'none', borderRadius: 999 },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: { '&.Mui-disabled': { opacity: 0.38 } },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: { borderRadius: 999 },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
        },
      },
    },
  });
}
