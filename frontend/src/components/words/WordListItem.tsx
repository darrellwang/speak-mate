/**
 * 词汇本条目（架构文档 §2 components/words/WordListItem.tsx，P0-6）。
 *
 * 单词 / 音标 / 释义 / 来源场景 + 掌握度三档标记（生疏/熟悉/已掌握，=2 注入画像）
 * + 删除（父级二次确认）。掌握度以色标区分。
 */
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import IconButton from '@mui/material/IconButton';
import Typography from '@mui/material/Typography';
import type { MasteryLevel, Word } from '@shared/types/models';
import { getSceneName } from '../../utils/sceneMap';
import { DeleteIcon } from '../icons';

const MASTERY_OPTIONS: ReadonlyArray<{ level: MasteryLevel; label: string; color: 'inherit' | 'warning' | 'success' }> = [
  { level: 0, label: '生疏', color: 'inherit' },
  { level: 1, label: '熟悉', color: 'warning' },
  { level: 2, label: '已掌握', color: 'success' },
];

interface WordListItemProps {
  word: Word;
  onDelete(word: Word): void;
  onMasteryChange(word: Word, level: MasteryLevel): void;
}

export default function WordListItem({
  word,
  onDelete,
  onMasteryChange,
}: WordListItemProps): JSX.Element {
  return (
    <Box
      sx={{
        bgcolor: 'background.paper',
        borderRadius: 2,
        border: 1,
        borderColor: 'divider',
        px: 2,
        py: 1.5,
      }}
      className="flex flex-col gap-1.5"
    >
      {/* 第一行：单词 + 音标 + 删除 */}
      <Box className="flex items-start gap-2">
        <Box className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
          <Typography variant="subtitle1" component="span" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
            {word.word}
          </Typography>
          {word.phonetic.length > 0 && (
            <Typography variant="caption" component="span" sx={{ color: 'text.secondary' }}>
              {word.phonetic}
            </Typography>
          )}
        </Box>
        <IconButton
          size="small"
          onClick={() => onDelete(word)}
          aria-label={`删除 ${word.word}`}
          sx={{ minHeight: 40, minWidth: 40 }}
        >
          <DeleteIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* 释义 */}
      {word.definition.length > 0 && (
        <Typography variant="body2" sx={{ color: 'text.primary', lineHeight: 1.6 }}>
          {word.definition}
        </Typography>
      )}

      {/* 来源场景 + 掌握度三档 */}
      <Box className="flex flex-wrap items-center justify-between gap-2">
        <Chip
          label={getSceneName(word.source_scene_id)}
          size="small"
          variant="outlined"
          sx={{ height: 28, color: 'text.secondary' }}
        />
        <Box className="flex items-center gap-1">
          {MASTERY_OPTIONS.map((option) => {
            const active = word.mastery_level === option.level;
            return (
              <Button
                key={option.level}
                size="small"
                variant={active ? 'contained' : 'text'}
                color={option.color === 'inherit' ? 'primary' : option.color}
                disabled={active}
                onClick={() => onMasteryChange(word, option.level)}
                sx={{ minHeight: 36, minWidth: 52, px: 1, fontSize: '0.75rem' }}
              >
                {option.label}
              </Button>
            );
          })}
        </Box>
      </Box>
    </Box>
  );
}
