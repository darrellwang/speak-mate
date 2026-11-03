/**
 * 复习卡片（架构文档 §2 components/words/ReviewCard.tsx，P1-4）。
 *
 * 遮盖释义自测：先展示单词 + 音标，点「显示释义」揭示释义与例句；
 * 随后三档掌握度标记（生疏/熟悉/已掌握，PATCH /api/words/:id，=2 注入画像）→ 下一张；
 * 全部完成展示结束态。
 */
import { useMemo, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { MasteryLevel, Word } from '@shared/types/models';
import { getSceneName } from '../../utils/sceneMap';
import { VisibilityIcon } from '../icons';

interface ReviewCardProps {
  words: Word[];
  onClose(): void;
  onMasteryChange(word: Word, level: MasteryLevel): void;
}

export default function ReviewCard({ words, onClose, onMasteryChange }: ReviewCardProps): JSX.Element {
  const [index, setIndex] = useState(0);
  const [revealed, setRevealed] = useState(false);
  const finished = index >= words.length;
  const current = useMemo(() => words[Math.min(index, words.length - 1)], [words, index]);

  const handleMark = (level: MasteryLevel): void => {
    if (current === undefined) return;
    onMasteryChange(current, level);
    setRevealed(false);
    setIndex((prev) => prev + 1);
  };

  return (
    <Box className="flex h-full flex-col gap-3 px-4 py-4">
      {/* 进度 */}
      <Box className="flex items-center gap-3">
        <LinearProgress
          variant="determinate"
          value={words.length === 0 ? 100 : (Math.min(index, words.length) / words.length) * 100}
          sx={{ flex: 1, borderRadius: 999, height: 6 }}
        />
        <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
          {Math.min(index, words.length)} / {words.length}
        </Typography>
      </Box>

      {finished ? (
        /* 完成态 */
        <Box className="flex flex-1 flex-col items-center justify-center gap-4">
          <Typography variant="h6">🎉 本轮复习完成</Typography>
          <Typography variant="body2" sx={{ color: 'text.secondary' }}>
            标记为「已掌握」的词将不再被 AI 解释
          </Typography>
          <Button variant="contained" onClick={onClose}>
            返回词汇本
          </Button>
        </Box>
      ) : (
        current !== undefined && (
          <Box className="flex flex-1 flex-col justify-center gap-4">
            {/* 卡面：单词 + 音标 + 场景 */}
            <Box
              sx={{
                bgcolor: 'background.paper',
                border: 1,
                borderColor: 'divider',
                borderRadius: 3,
                p: 3,
              }}
              className="flex flex-col items-center gap-2 text-center"
            >
              <Typography variant="h4" component="span" sx={{ fontWeight: 700, wordBreak: 'break-word' }}>
                {current.word}
              </Typography>
              {current.phonetic.length > 0 && (
                <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                  {current.phonetic}
                </Typography>
              )}
              <Chip
                label={getSceneName(current.source_scene_id)}
                size="small"
                variant="outlined"
                sx={{ height: 26 }}
              />
            </Box>

            {/* 遮盖自测 → 揭示 */}
            {revealed ? (
              <Box sx={{ bgcolor: 'action.hover', borderRadius: 2, p: 2 }} className="flex flex-col gap-2">
                <Typography variant="body1">{current.definition}</Typography>
                {current.example.length > 0 && (
                  <Typography variant="body2" sx={{ fontStyle: 'italic', color: 'text.secondary' }}>
                    {current.example}
                  </Typography>
                )}
              </Box>
            ) : (
              <Button
                variant="outlined"
                size="large"
                startIcon={<VisibilityIcon />}
                onClick={() => setRevealed(true)}
              >
                显示释义
              </Button>
            )}

            {/* 三档掌握度 */}
            <Box className="flex items-center justify-center gap-2">
              <Button
                variant="contained"
                color="inherit"
                sx={{ bgcolor: 'action.hover', color: 'text.primary' }}
                onClick={() => handleMark(0)}
              >
                还是生疏
              </Button>
              <Button variant="contained" color="warning" onClick={() => handleMark(1)}>
                有点熟了
              </Button>
              <Button variant="contained" color="success" onClick={() => handleMark(2)}>
                已掌握
              </Button>
            </Box>
          </Box>
        )
      )}
    </Box>
  );
}
