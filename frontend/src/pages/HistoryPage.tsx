/**
 * 历史会话页（架构文档 §2 pages/HistoryPage.tsx，路由 /history，P1-3）。
 *
 * 会话列表（场景名/标题/时间/消息数）+ 点击恢复上下文继续聊（回 ChatPage）
 * + 菜单操作：只读回看 / 重命名 / 删除（二次确认）；分页加载。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import IconButton from '@mui/material/IconButton';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import ListItemText from '@mui/material/ListItemText';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Skeleton from '@mui/material/Skeleton';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { SessionListItem } from '@shared/types/models';
import { MoreVertIcon } from '../components/icons';
import { formatDateTime } from '../utils/format';
import { notifySuccess } from '../utils/notify';
import { useSessionStore } from '../stores/sessionStore';

export default function HistoryPage(): JSX.Element {
  const navigate = useNavigate();
  const sessions = useSessionStore((state) => state.sessions);
  const hasMore = useSessionStore((state) => state.hasMore);
  const loading = useSessionStore((state) => state.loading);
  const total = useSessionStore((state) => state.total);

  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [menuAnchor, setMenuAnchor] = useState<{ element: HTMLElement; item: SessionListItem } | null>(null);
  const [renaming, setRenaming] = useState<SessionListItem | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleting, setDeleting] = useState<SessionListItem | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void useSessionStore.getState().loadSessions(true);
  }, []);

  /** 恢复上下文继续聊：载入最近消息窗口 → 回对话页 */
  const continueChat = async (sessionId: string): Promise<void> => {
    if (restoringId !== null) return;
    setRestoringId(sessionId);
    const ok = await useSessionStore.getState().restoreSession(sessionId);
    setRestoringId(null);
    if (ok) navigate('/');
  };

  const handleRename = async (): Promise<void> => {
    if (renaming === null) return;
    const title = renameTitle.trim();
    if (title.length === 0) return;
    setSubmitting(true);
    try {
      await useSessionStore.getState().renameSession(renaming.id, title);
      notifySuccess('已重命名');
      setRenaming(null);
    } catch {
      // client 已统一错误提示
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (): Promise<void> => {
    if (deleting === null) return;
    const target = deleting;
    setDeleting(null);
    try {
      await useSessionStore.getState().deleteSession(target.id);
      notifySuccess('会话已删除');
      // 若删的是当前会话，sessionStore 已清空 currentSession，回场景选择重建
      if (useSessionStore.getState().currentSession === null) {
        navigate('/scenes', { replace: true });
      }
    } catch {
      // client 已统一错误提示
    }
  };

  return (
    <Box className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <Box
        component="header"
        className="pt-safe flex items-center gap-2 px-3"
        sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
          历史会话
          {total > 0 && (
            <Typography component="span" variant="body2" sx={{ color: 'text.secondary', ml: 1 }}>
              {total} 个
            </Typography>
          )}
        </Typography>
      </Box>

      {/* 列表 */}
      <Box className="thin-scroll flex-1 min-h-0 overflow-y-auto pb-4">
        {loading && sessions.length === 0 ? (
          <Box className="flex flex-col gap-2 px-3 pt-2">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} variant="rounded" height={76} sx={{ borderRadius: 2 }} />
            ))}
          </Box>
        ) : sessions.length === 0 ? (
          <Box className="flex h-full flex-col items-center justify-center gap-1 py-16">
            <Typography variant="body1" sx={{ color: 'text.secondary' }}>
              还没有会话
            </Typography>
            <Button variant="contained" onClick={() => navigate('/scenes')} sx={{ mt: 1 }}>
              去开始第一段对话
            </Button>
          </Box>
        ) : (
          <Box className="flex flex-col px-1 pt-1">
            {sessions.map((item) => (
              <ListItem
                key={item.id}
                disablePadding
                secondaryAction={
                  <IconButton
                    edge="end"
                    aria-label="会话操作"
                    onClick={(event) =>
                      setMenuAnchor({ element: event.currentTarget, item })
                    }
                  >
                    <MoreVertIcon />
                  </IconButton>
                }
              >
                <ListItemButton
                  onClick={() => void continueChat(item.id)}
                  sx={{ minHeight: 76, pr: 6 }}
                >
                  <ListItemText
                    primary={
                      <Box className="flex items-center gap-1.5">
                        <Chip
                          label={item.scene_name}
                          size="small"
                          variant="outlined"
                          sx={{ height: 24, fontSize: 11 }}
                        />
                        <Typography
                          component="span"
                          variant="body2"
                          sx={{
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                            color: 'text.primary',
                          }}
                        >
                          {item.title.length > 0 ? item.title : '（未开始对话）'}
                        </Typography>
                      </Box>
                    }
                    secondary={
                      <Typography component="span" variant="caption" sx={{ color: 'text.secondary' }}>
                        {formatDateTime(item.updated_at)} · {item.message_count} 条消息
                        {restoringId === item.id ? ' · 恢复中…' : ''}
                      </Typography>
                    }
                  />
                  {restoringId === item.id && <CircularProgress size={18} sx={{ ml: 1 }} />}
                </ListItemButton>
              </ListItem>
            ))}
            {hasMore && (
              <Button
                fullWidth
                variant="text"
                disabled={loading}
                onClick={() => void useSessionStore.getState().loadSessions(false)}
                startIcon={loading ? <CircularProgress size={16} color="inherit" /> : undefined}
              >
                {loading ? '加载中…' : '加载更多'}
              </Button>
            )}
          </Box>
        )}
      </Box>

      {/* 条目操作菜单 */}
      <Menu
        anchorEl={menuAnchor?.element ?? null}
        open={menuAnchor !== null}
        onClose={() => setMenuAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          onClick={() => {
            const item = menuAnchor?.item;
            setMenuAnchor(null);
            if (item !== undefined) navigate(`/history/${item.id}`);
          }}
        >
          只读回看
        </MenuItem>
        <MenuItem
          onClick={() => {
            const item = menuAnchor?.item;
            setMenuAnchor(null);
            if (item !== undefined) {
              setRenaming(item);
              setRenameTitle(item.title);
            }
          }}
        >
          重命名
        </MenuItem>
        <MenuItem
          onClick={() => {
            const item = menuAnchor?.item;
            setMenuAnchor(null);
            if (item !== undefined) setDeleting(item);
          }}
          sx={{ color: 'error.main' }}
        >
          删除
        </MenuItem>
      </Menu>

      {/* 重命名弹窗 */}
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} fullWidth>
        <DialogTitle>重命名会话</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            value={renameTitle}
            onChange={(event) => setRenameTitle(event.target.value)}
            placeholder="输入新名称"
            fullWidth
            size="small"
            sx={{ mt: 0.5 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRenaming(null)}>取消</Button>
          <Button
            variant="contained"
            disabled={submitting || renameTitle.trim().length === 0}
            onClick={() => void handleRename()}
          >
            保存
          </Button>
        </DialogActions>
      </Dialog>

      {/* 删除二次确认 */}
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)}>
        <DialogTitle>删除会话</DialogTitle>
        <DialogContent>
          <DialogContentText>
            确定删除「{deleting?.title || deleting?.scene_name}」吗？会话内全部消息将一并删除，不可恢复。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>取消</Button>
          <Button color="error" onClick={() => void handleDelete()}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
