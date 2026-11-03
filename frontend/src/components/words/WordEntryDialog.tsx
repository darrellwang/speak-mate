/**
 * 词条卡弹窗（架构文档 §2 components/words/WordEntryDialog.tsx，P0-5 路径 A 第 2-3 步）。
 *
 * 选词 → 骨架屏 → POST /api/words/define 生成四要素（释义/音标/例句/来源上下文）
 * → 「加入词汇本」POST /api/words 入库。标记到入库 ≤3 步。
 * 失败显示错误 + 重试；静默错误处理（silent，弹窗内自展示，不走全局 Toast）。
 */
import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { WordDefineResult } from '@shared/types/models';
import { api } from '../../api/endpoints';
import { notifySuccess } from '../../utils/notify';
import { CheckIcon, CloseIcon, RefreshIcon } from '../icons';

interface WordEntryDialogProps {
  open: boolean;
  /** 待查询词（选词模式点选） */
  word: string;
  /** 来源上下文（AI 回复原句） */
  context: string;
  sessionId: string | null;
  sceneId: string;
  onClose(): void;
}

export default function WordEntryDialog({
  open,
  word,
  context,
  sessionId,
  sceneId,
  onClose,
}: WordEntryDialogProps): JSX.Element {
  const [entry, setEntry] = useState<WordDefineResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const loadEntry = useCallback(
    async (targetWord: string): Promise<void> => {
      setLoading(true);
      setError(null);
      setEntry(null);
      setSaved(false);
      try {
        const data = await api.defineWord(
          { word: targetWord, context, session_id: sessionId ?? undefined },
          { silent: true }, // 弹窗内自行展示错误与重试
        );
        setEntry(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : '获取释义失败，请重试');
      } finally {
        setLoading(false);
      }
    },
    [context, sessionId],
  );

  useEffect(() => {
    if (open && word.length > 0) {
      void loadEntry(word);
    }
  }, [open, word, loadEntry]);

  const handleSave = async (): Promise<void> => {
    if (entry === null || saving || saved) return;
    setSaving(true);
    try {
      const result = await api.saveWord({
        word: entry.word,
        phonetic: entry.phonetic,
        definition: entry.definition,
        example: entry.example,
        context: entry.context,
        source_session_id: sessionId,
        source_scene_id: sceneId,
      });
      setSaved(true);
      notifySuccess(
        result.created ? `「${entry.word}」已加入词汇本` : `「${entry.word}」词条已更新`,
      );
      onClose();
    } catch {
      // client 已统一错误提示
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} fullScreen>
      {/* 顶栏 */}
      <Box
        className="pt-safe flex items-center gap-1 px-2"
        sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <IconButton onClick={onClose} aria-label="关闭">
          <CloseIcon />
        </IconButton>
        <Typography variant="subtitle1" component="span" sx={{ fontWeight: 600, flex: 1 }}>
          {word}
        </Typography>
        {saved && <CheckIcon color="success" />}
      </Box>

      <DialogContent className="flex flex-col gap-3 py-3">
        {/* 骨架屏（LLM 生成中） */}
        {loading && (
          <Box className="flex flex-col gap-2">
            <Skeleton variant="text" width="40%" height={32} />
            <Skeleton variant="text" width="60%" />
            <Skeleton variant="rectangular" height={64} sx={{ borderRadius: 2 }} />
            <Skeleton variant="rectangular" height={88} sx={{ borderRadius: 2 }} />
          </Box>
        )}

        {/* 失败 + 重试 */}
        {error !== null && !loading && (
          <Box className="flex flex-col items-center gap-3 py-10">
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              {error}
            </Typography>
            <Button
              variant="outlined"
              startIcon={<RefreshIcon />}
              onClick={() => void loadEntry(word)}
            >
              重试
            </Button>
          </Box>
        )}

        {/* 词条四要素 */}
        {entry !== null && !loading && (
          <Box className="flex flex-col gap-3">
            <Box className="flex flex-wrap items-baseline gap-x-2">
              <Typography variant="h6" component="span" sx={{ fontWeight: 700 }}>
                {entry.word}
              </Typography>
              {entry.phonetic.length > 0 && (
                <Typography variant="body2" component="span" sx={{ color: 'text.secondary' }}>
                  {entry.phonetic}
                </Typography>
              )}
            </Box>

            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                释义
              </Typography>
              <Typography variant="body1">{entry.definition}</Typography>
            </Box>

            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                例句
              </Typography>
              <Typography
                variant="body2"
                sx={{ fontStyle: 'italic', lineHeight: 1.7 }}
              >
                {entry.example}
              </Typography>
            </Box>

            <Box
              sx={{ bgcolor: 'action.hover', borderRadius: 2, p: 1.5 }}
              className="flex flex-col gap-0.5"
            >
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>
                来源上下文
              </Typography>
              <Typography variant="body2" sx={{ wordBreak: 'break-word' }}>
                {entry.context}
              </Typography>
            </Box>

            <Button
              fullWidth
              variant="contained"
              size="large"
              disabled={saving || saved}
              onClick={() => void handleSave()}
              startIcon={saving ? <CircularProgress size={18} color="inherit" /> : undefined}
              sx={{ mt: 1 }}
            >
              {saved ? '已加入词汇本' : '加入词汇本'}
            </Button>
          </Box>
        )}
      </DialogContent>
    </Dialog>
  );
}
