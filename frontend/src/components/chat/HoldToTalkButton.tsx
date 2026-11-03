/**
 * 按住说话按钮（架构文档 §2 components/chat/HoldToTalkButton.tsx，PRD §5.3）。
 *
 * - pointer 事件 + setPointerCapture（按住拖出按钮仍正常收口）；
 * - 按压 <300ms 视为误触：提示「长按说话」并放弃本轮识别；
 * - 录音态：波纹扩散动画（CSS hold-talk-pulse）+ 状态文案；
 * - 不支持 ASR / AI 输出中：置灰禁用（文字输入始终可用，P0-9）。
 */
import { useRef, useState } from 'react';
import Box from '@mui/material/Box';
import CircularProgress from '@mui/material/CircularProgress';
import { MicIcon } from '../icons';

/** 有效按压阈值（PRD §5.3） */
const PRESS_THRESHOLD_MS = 300;

interface HoldToTalkButtonProps {
  listening: boolean;
  disabled?: boolean;
  onPressStart(): void;
  onPressEnd(): void;
  /** <300ms 误触回调（放弃本轮识别） */
  onInvalidTap(): void;
}

export default function HoldToTalkButton({
  listening,
  disabled = false,
  onPressStart,
  onPressEnd,
  onInvalidTap,
}: HoldToTalkButtonProps): JSX.Element {
  const pressStartAt = useRef(0);
  const [held, setHeld] = useState(false);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (disabled || listening) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pressStartAt.current = Date.now();
    setHeld(true);
    onPressStart();
  };

  const release = (): void => {
    if (!held) return;
    setHeld(false);
    const elapsed = Date.now() - pressStartAt.current;
    if (elapsed < PRESS_THRESHOLD_MS) {
      onInvalidTap();
    } else {
      onPressEnd();
    }
  };

  return (
    <Box className="flex flex-col items-center gap-1.5 select-none">
      <Box
        role="button"
        aria-label={listening ? '松开结束' : '按住说话'}
        aria-disabled={disabled}
        onPointerDown={handlePointerDown}
        onPointerUp={release}
        onPointerCancel={release}
        sx={{
          position: 'relative',
          width: 76,
          height: 76,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: disabled ? 'not-allowed' : 'pointer',
          touchAction: 'none', // 阻止长按触发系统手势/选择
          transition: 'transform 0.12s ease',
          transform: held ? 'scale(1.06)' : 'scale(1)',
          bgcolor: disabled ? 'action.disabledBackground' : listening ? 'error.main' : 'primary.main',
          color: disabled ? 'text.disabled' : 'primary.contrastText',
          boxShadow: disabled ? 'none' : 3,
        }}
      >
        {/* 录音波纹 */}
        {listening && (
          <Box
            className="hold-talk-pulse"
            sx={{
              position: 'absolute',
              inset: 0,
              borderRadius: '50%',
              bgcolor: 'error.main',
              pointerEvents: 'none',
            }}
          />
        )}
        {disabled ? <CircularProgress size={24} color="inherit" /> : <MicIcon sx={{ fontSize: 34 }} />}
      </Box>
      <Box component="span" className="text-xs" sx={{ color: 'text.secondary' }}>
        {disabled ? 'AI 回复中…' : listening ? '松开结束' : '按住说话'}
      </Box>
    </Box>
  );
}
