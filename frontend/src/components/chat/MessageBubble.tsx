/**
 * 消息气泡（架构文档 §2 components/chat/MessageBubble.tsx）。
 *
 * - 用户：右侧主色气泡（最大宽 75%）；AI：左侧纸色气泡 + 流式光标；
 * - AI 消息「选词模式」（P0-5 路径 A）：「选词」按钮或长按 500ms 进入，
 *   正文按词切分渲染为可点 chip，点词回调（→ WordEntryDialog 词条卡）；
 * - AI 消息尾部渲染纠错卡片（CorrectionCard）与建议词条 chips（VocabChips）；
 * - readOnly（历史回看）：仅展示，无选词入口。
 */
import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import type { Message } from '@shared/types/models';
import CorrectionCard from './CorrectionCard';
import VocabChips from './VocabChips';
import { SearchIcon } from '../icons';

export interface MessageBubbleProps {
  message: Message;
  /** 该消息正在流式输出（末尾光标） */
  isStreaming?: boolean;
  /** 只读模式（历史回看详情页） */
  readOnly?: boolean;
  /** 来源场景 id（词条入库溯源） */
  sceneId?: string;
  /** 选词模式点词回调 */
  onPickWord?: (word: string, context: string) => void;
}

interface Token {
  text: string;
  /** 可查询的词（剥离边缘标点后）；null = 空白/纯标点 */
  word: string | null;
}

/** 词元切分：保留空白与原文，剥离边缘标点得到查询词 */
const EDGE_PUNCTUATION = /^[^A-Za-z0-9'-]+|[^A-Za-z0-9'-]+$/g;

function tokenize(content: string): Token[] {
  return content.split(/(\s+)/).map((text) => {
    if (text.length === 0 || /^\s+$/.test(text)) return { text, word: null };
    const word = text.replace(EDGE_PUNCTUATION, '');
    return { text, word: word.length > 0 ? word : null };
  });
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;

export default function MessageBubble({
  message,
  isStreaming = false,
  readOnly = false,
  sceneId = '',
  onPickWord,
}: MessageBubbleProps): JSX.Element {
  const [selectMode, setSelectMode] = useState(false);
  const pressTimer = useRef<number | null>(null);
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const canSelect = isAssistant && !isStreaming && !readOnly && message.content.trim().length > 0;

  const clearPressTimer = (): void => {
    if (pressTimer.current !== null) {
      window.clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
    pressOrigin.current = null;
  };

  /** 长按 500ms（位移 <8px）进入选词模式 */
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (!canSelect || selectMode) return;
    pressOrigin.current = { x: event.clientX, y: event.clientY };
    clearPressTimer();
    pressTimer.current = window.setTimeout(() => {
      pressTimer.current = null;
      if (navigator.vibrate !== undefined) navigator.vibrate(10);
      setSelectMode(true);
    }, LONG_PRESS_MS);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    if (pressTimer.current === null || pressOrigin.current === null) return;
    const dx = event.clientX - pressOrigin.current.x;
    const dy = event.clientY - pressOrigin.current.y;
    if (Math.abs(dx) > LONG_PRESS_SLOP_PX || Math.abs(dy) > LONG_PRESS_SLOP_PX) {
      clearPressTimer(); // 手指滑动（滚动）取消长按
    }
  };

  const handlePointerUp = (): void => {
    clearPressTimer();
  };

  return (
    <Box
      className={`mb-2 flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
      sx={{ maxWidth: '100%' }}
    >
      {/* 气泡主体 */}
      <Box
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        sx={{
          maxWidth: '75%',
          px: 1.75,
          py: 1.25,
          borderRadius: 2.5,
          wordBreak: 'break-word',
          whiteSpace: 'pre-wrap',
          lineHeight: 1.6,
          fontSize: '0.9rem',
          userSelect: selectMode ? 'none' : 'auto',
          ...(isUser
            ? {
                bgcolor: 'primary.main',
                color: 'primary.contrastText',
                borderBottomRightRadius: 6,
              }
            : {
                bgcolor: 'background.paper',
                color: 'text.primary',
                border: 1,
                borderColor: 'divider',
                borderBottomLeftRadius: 6,
              }),
        }}
      >
        {selectMode && isAssistant ? (
          // 选词模式：词元可点（触控目标通过内边距抬升）
          <span>
            {tokenize(message.content).map((token, index) =>
              token.word === null ? (
                <span key={index}>{token.text}</span>
              ) : (
                <Box
                  key={index}
                  component="span"
                  onClick={() => onPickWord?.(token.word as string, message.content)}
                  sx={{
                    display: 'inline-block',
                    px: 0.5,
                    py: 0.5,
                    my: 0.25,
                    borderRadius: 1,
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'action.hover' },
                    '&:active': { bgcolor: 'action.selected' },
                  }}
                >
                  {token.text}
                </Box>
              ),
            )}
          </span>
        ) : (
          <span>
            {message.content}
            {isStreaming && <span className="streaming-cursor" aria-label="正在输入" />}
          </span>
        )}
      </Box>

      {/* 选词模式提示条 */}
      {selectMode && isAssistant && (
        <Box className="mt-1 flex items-center gap-2" sx={{ maxWidth: '75%' }}>
          <Box component="span" className="text-xs" sx={{ color: 'text.secondary' }}>
            点击要查的单词
          </Box>
          <Button size="small" onClick={() => setSelectMode(false)} sx={{ minHeight: 32, py: 0 }}>
            退出选词
          </Button>
        </Box>
      )}

      {/* AI 消息附属：选词入口 / 纠错卡片 / 建议词条 */}
      {isAssistant && !isStreaming && (
        <>
          {canSelect && !selectMode && (
            <Button
              size="small"
              startIcon={<SearchIcon />}
              onClick={() => setSelectMode(true)}
              sx={{ minHeight: 36, py: 0, px: 1.5, mt: -0.5, alignSelf: 'flex-start', color: 'text.secondary' }}
            >
              选词
            </Button>
          )}
          {message.corrections.length > 0 && <CorrectionCard corrections={message.corrections} />}
          {message.vocab_suggestions.length > 0 && (
            <VocabChips
              suggestions={message.vocab_suggestions}
              sessionId={message.session_id}
              sceneId={sceneId}
              context={message.content}
            />
          )}
        </>
      )}
    </Box>
  );
}
