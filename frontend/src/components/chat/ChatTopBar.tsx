/**
 * 对话页顶栏（架构文档 §2 components/chat/ChatTopBar.tsx）。
 *
 * 场景标签（点击 → /scenes 切换）+ 新会话（同场景延续模式「接着上次聊」）
 * + TTS 播报状态（播报中指示 + 一键停止，P1-1）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import { api } from '../../api/endpoints';
import { useChatStore } from '../../stores/chatStore';
import { useSessionStore } from '../../stores/sessionStore';
import { getSceneName } from '../../utils/sceneMap';
import { AddIcon, StopIcon, VolumeIcon } from '../icons';

interface ChatTopBarProps {
  /** TTS 播报中（顶栏指示 + 停止入口） */
  speaking: boolean;
  onStopSpeaking(): void;
}

export default function ChatTopBar({ speaking, onStopSpeaking }: ChatTopBarProps): JSX.Element {
  const navigate = useNavigate();
  const currentSession = useSessionStore((state) => state.currentSession);
  const [creating, setCreating] = useState(false);

  /** 新会话：同场景 + 延续模式（LLM 生成延续性开场白，失败降级静态 opener）；无会话 → 场景选择 */
  const handleNewSession = async (): Promise<void> => {
    if (creating) return;
    const session = useSessionStore.getState().currentSession;
    if (session === null) {
      navigate('/scenes');
      return;
    }
    setCreating(true);
    try {
      const data = await api.createSession({
        scene_id: session.scene_id,
        continue_from_last: true,
      });
      useSessionStore.getState().setCurrent(data.session);
      useChatStore.getState().setMessages(data.messages);
    } catch {
      // client 已统一错误提示
    } finally {
      setCreating(false);
    }
  };

  const sceneLabel =
    currentSession !== null ? getSceneName(currentSession.scene_id) : '选择场景';

  return (
    <Box
      component="header"
      className="pt-safe flex items-center gap-1 px-2"
      sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
    >
      {/* 场景标签：点击切换场景（/scenes） */}
      <Chip
        label={sceneLabel}
        onClick={() => navigate('/scenes')}
        color="primary"
        variant="outlined"
        sx={{ maxWidth: 180, fontWeight: 500 }}
      />

      <Box sx={{ flex: 1 }} />

      {/* TTS 播报状态：播报中图标呼吸 + 停止按钮 */}
      {speaking && (
        <Tooltip title="停止播报">
          <IconButton color="primary" onClick={onStopSpeaking} aria-label="停止播报">
            <VolumeIcon className="animate-pulse" />
          </IconButton>
        </Tooltip>
      )}
      {speaking && (
        <IconButton color="error" onClick={onStopSpeaking} aria-label="停止" sx={{ ml: -1.5 }}>
          <StopIcon />
        </IconButton>
      )}

      {/* 新会话：同场景延续模式 */}
      <IconButton
        onClick={() => void handleNewSession()}
        color="primary"
        disabled={creating}
        aria-label="新会话（接着上次聊）"
      >
        {creating ? <CircularProgress size={22} color="inherit" /> : <AddIcon />}
      </IconButton>
    </Box>
  );
}
