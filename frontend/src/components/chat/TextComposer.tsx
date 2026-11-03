/**
 * 文字输入兜底（架构文档 §2 components/chat/TextComposer.tsx，P0-9）。
 *
 * - 编辑识别文本 / 纯键盘输入统一入口：ASR 定稿文本直接回填此输入框（点击即编辑，≤1 次点击）；
 * - 回车 / 发送按钮提交；AI 输出中发送禁用但输入不禁（可提前打字）；
 * - 左侧麦克风按钮切回语音模式（ASR 可用时显示）。
 */
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import TextField from '@mui/material/TextField';
import { MicIcon, SendIcon } from '../icons';

interface TextComposerProps {
  value: string;
  onChange(value: string): void;
  onSend(): void;
  /** AI 输出中：禁发不禁输 */
  disabled?: boolean;
  /** 是否显示切回语音模式按钮（ASR 可用） */
  showVoiceSwitch: boolean;
  onSwitchToVoice(): void;
}

export default function TextComposer({
  value,
  onChange,
  onSend,
  disabled = false,
  showVoiceSwitch,
  onSwitchToVoice,
}: TextComposerProps): JSX.Element {
  const canSend = !disabled && value.trim().length > 0;

  return (
    <Box
      component="form"
      className="pb-safe flex items-end gap-1.5 px-2.5 pt-1.5"
      sx={{ bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider' }}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      {showVoiceSwitch && (
        <IconButton onClick={onSwitchToVoice} color="primary" aria-label="切换按住说话">
          <MicIcon />
        </IconButton>
      )}
      <TextField
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="输入英文，回车发送…"
        fullWidth
        multiline
        maxRows={4}
        size="small"
        autoComplete="off"
        sx={{
          flex: 1,
          '& .MuiOutlinedInput-root': {
            borderRadius: 5,
            bgcolor: 'background.default',
            fontSize: '0.9rem',
          },
        }}
      />
      <IconButton
        type="submit"
        aria-label="发送"
        disabled={!canSend}
        sx={{
          bgcolor: canSend ? 'primary.main' : 'action.disabledBackground',
          color: canSend ? 'primary.contrastText' : 'text.disabled',
          '&.Mui-disabled': { bgcolor: 'action.disabledBackground' },
        }}
      >
        <SendIcon />
      </IconButton>
    </Box>
  );
}
