/**
 * 路由表（架构文档 §2 router.tsx：6 条路由 = 5 页 + 历史回看详情页）。
 *
 * AppShell 为布局路由：内容区 + 底部四 Tab 导航（safe-area 适配）。
 */
import { createBrowserRouter } from 'react-router-dom';
import AppShell from './components/layout/AppShell';
import ChatPage from './pages/ChatPage';
import HistoryPage from './pages/HistoryPage';
import ScenesPage from './pages/ScenesPage';
import SessionDetailPage from './pages/SessionDetailPage';
import SettingsPage from './pages/SettingsPage';
import WordsPage from './pages/WordsPage';

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <ChatPage /> },
      { path: 'scenes', element: <ScenesPage /> },
      { path: 'words', element: <WordsPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'history/:id', element: <SessionDetailPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);
