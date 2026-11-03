/**
 * React 入口：Provider 组装（架构文档 §2 App.tsx）。
 *
 * - MUI ThemeProvider：深色模式跟随系统（prefers-color-scheme）；
 * - CssBaseline 接管全局 reset（Tailwind preflight 已关闭，§9.8）；
 * - RouterProvider：6 条路由（router.tsx 统一定义）。
 */
import { useMemo } from 'react';
import CssBaseline from '@mui/material/CssBaseline';
import useMediaQuery from '@mui/material/useMediaQuery';
import { ThemeProvider } from '@mui/material/styles';
import { RouterProvider } from 'react-router-dom';
import { router } from './router';
import { buildTheme, type ThemeMode } from './theme';

export default function App(): JSX.Element {
  const prefersDark = useMediaQuery('(prefers-color-scheme: dark)', { noSsr: true });
  const mode: ThemeMode = prefersDark ? 'dark' : 'light';
  const theme = useMemo(() => buildTheme(mode), [mode]);

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <RouterProvider router={router} />
    </ThemeProvider>
  );
}
