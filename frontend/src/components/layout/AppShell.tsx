/**
 * 页面骨架（架构文档 §2 components/layout/AppShell.tsx）。
 *
 * - 全屏 flex 纵向布局（100dvh，#root 承担）：内容区（页面自治滚动）+ 底部导航；
 * - 全局 Toast 渲染（utils/notify 事件总线 → Snackbar，含可点动作按钮）；
 * - safe-area 适配由 BottomNav（底部）与各页面顶栏（pt-safe）分担。
 */
import { useEffect, useState } from 'react';
import { Outlet } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
import BottomNav from './BottomNav';
import { subscribeToToasts, type ToastPayload } from '../../utils/notify';

export default function AppShell(): JSX.Element {
  const [toast, setToast] = useState<ToastPayload | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(
    () =>
      subscribeToToasts((payload) => {
        setToast(payload);
        setOpen(true);
      }),
    [],
  );

  const handleClose = (_event?: unknown, reason?: string): void => {
    if (reason === 'clickaway') return;
    setOpen(false);
  };

  const actionNode =
    toast?.action !== undefined ? (
      <Button
        color="inherit"
        size="small"
        onClick={() => {
          toast.action?.onClick();
          handleClose();
        }}
      >
        {toast.action.label}
      </Button>
    ) : undefined;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, bgcolor: 'background.default', color: 'text.primary' }}>
      {/* 内容区：页面自治滚动（对话页消息流 / 列表页各自管理） */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
      <BottomNav />

      {/* 全局 Toast（顶部居中，避开底部输入区） */}
      <Snackbar
        key={toast?.key}
        open={open}
        autoHideDuration={toast?.severity === 'error' ? 5000 : 3200}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert
          severity={toast?.severity ?? 'info'}
          variant="filled"
          onClose={handleClose}
          action={actionNode}
          sx={{ alignItems: 'center', maxWidth: '92vw' }}
        >
          {toast?.message ?? ''}
        </Alert>
      </Snackbar>
    </Box>
  );
}
