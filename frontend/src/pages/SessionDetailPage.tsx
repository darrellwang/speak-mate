/**
 * 历史回看只读页（架构文档 §2 pages/SessionDetailPage.tsx，路由 /history/:id，P1-3）。
 *
 * 会话只读回看：消息分页（每页 50 条，「加载更早」向前翻页）+ 纠错卡片展示；
 * 「继续此会话」恢复上下文回 ChatPage 继续聊（与历史列表点击一致）。
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import type { Message, Session } from '@shared/types/models';
import MessageBubble from '../components/chat/MessageBubble';
import { ArrowBackIcon } from '../components/icons';
import { api } from '../api/endpoints';
import { useSessionStore } from '../stores/sessionStore';
import { formatDateTime } from '../utils/format';
import { getScene } from '../utils/sceneMap';

const PAGE_SIZE = 50;

export default function SessionDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadFirst = useCallback(async (sessionId: string): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const detail = await api.getSessionDetail(sessionId, {
        msg_limit: PAGE_SIZE,
        msg_offset: 0,
      });
      setSession(detail.session);
      setMessages(detail.messages);
      setHasMore(detail.has_more);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (id !== undefined && id.length > 0) {
      void loadFirst(id);
    }
  }, [id, loadFirst]);

  /** 加载更早消息（正序分页向前翻） */
  const loadEarlier = async (): Promise<void> => {
    if (id === undefined || loadingMore) return;
    setLoadingMore(true);
    try {
      const detail = await api.getSessionDetail(id, {
        msg_limit: PAGE_SIZE,
        msg_offset: messages.length,
      });
      setMessages((prev) => [...detail.messages, ...prev]); // 更早消息前插
      setHasMore(detail.has_more);
    } catch {
      // client 已统一错误提示
    } finally {
      setLoadingMore(false);
    }
  };

  /** 继续此会话：恢复上下文回对话页 */
  const continueChat = async (): Promise<void> => {
    if (id === undefined) return;
    const ok = await useSessionStore.getState().restoreSession(id);
    if (ok) navigate('/');
  };

  const scene = getScene(session?.scene_id);

  return (
    <Box className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <Box
        component="header"
        className="pt-safe flex items-center gap-1 px-1"
        sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <IconButton onClick={() => navigate('/history')} aria-label="返回历史列表">
          <ArrowBackIcon />
        </IconButton>
        <Box className="flex min-w-0 flex-1 flex-col">
          <Typography variant="subtitle2" noWrap sx={{ fontWeight: 600 }}>
            {session?.title || scene?.name || '会话回看'}
          </Typography>
          {session !== null && (
            <Typography variant="caption" noWrap sx={{ color: 'text.secondary' }}>
              {scene?.name ?? session.scene_id} · {formatDateTime(session.updated_at)} ·{' '}
              {session.message_count} 条消息
            </Typography>
          )}
        </Box>
        <Button size="small" variant="contained" onClick={() => void continueChat()}>
          继续此会话
        </Button>
      </Box>

      {/* 消息流（只读） */}
      <Box className="thin-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {loading ? (
          <Box className="flex h-full items-center justify-center">
            <CircularProgress size={28} />
          </Box>
        ) : error !== null ? (
          <Box className="flex h-full flex-col items-center justify-center gap-2">
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {error}
            </Typography>
            <Button variant="outlined" onClick={() => id !== undefined && void loadFirst(id)}>
              重试
            </Button>
          </Box>
        ) : (
          <>
            {hasMore && (
              <Button
                fullWidth
                variant="text"
                disabled={loadingMore}
                onClick={() => void loadEarlier()}
                startIcon={loadingMore ? <CircularProgress size={16} color="inherit" /> : undefined}
                sx={{ mb: 1 }}
              >
                {loadingMore ? '加载中…' : '加载更早消息'}
              </Button>
            )}
            {messages.map((message) => (
              <MessageBubble
                key={message.id}
                message={message}
                readOnly
                sceneId={session?.scene_id ?? ''}
              />
            ))}
          </>
        )}
      </Box>
    </Box>
  );
}
