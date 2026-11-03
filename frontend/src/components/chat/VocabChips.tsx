/**
 * AI 建议词条 chips（架构文档 §2 components/chat/VocabChips.tsx，P0-5 路径 B）。
 *
 * meta 事件已携带四要素 → 点击 chip 直接 POST /api/words 入库，零额外请求；
 * 入库成功 Toast「已加入词汇本」，动作按钮直达 /words（PRD §5.3）；
 * 同词防重复点击；UNIQUE UPSERT（created=false = 覆盖更新）。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import type { VocabSuggestion } from '@shared/types/chat';
import { api } from '../../api/endpoints';
import { notifySuccess } from '../../utils/notify';

interface VocabChipsProps {
  suggestions: VocabSuggestion[];
  /** 来源会话 id（词条溯源） */
  sessionId: string;
  /** 来源场景 id（列表展示需要） */
  sceneId: string;
  /** 来源上下文（AI 回复原句） */
  context: string;
}

export default function VocabChips({
  suggestions,
  sessionId,
  sceneId,
  context,
}: VocabChipsProps): JSX.Element | null {
  const navigate = useNavigate();
  const [savingWord, setSavingWord] = useState<string | null>(null);
  const [savedWords, setSavedWords] = useState<ReadonlySet<string>>(new Set());

  if (suggestions.length === 0) return null;

  const handleSave = async (suggestion: VocabSuggestion): Promise<void> => {
    if (savingWord !== null || savedWords.has(suggestion.word)) return;
    setSavingWord(suggestion.word);
    try {
      await api.saveWord({
        word: suggestion.word,
        phonetic: suggestion.phonetic,
        definition: suggestion.definition,
        example: suggestion.example,
        context,
        source_session_id: sessionId,
        source_scene_id: sceneId,
      });
      setSavedWords((prev) => new Set(prev).add(suggestion.word));
      notifySuccess(`「${suggestion.word}」已加入词汇本`, {
        label: '查看',
        onClick: () => navigate('/words'),
      });
    } catch {
      // client 已统一错误提示
    } finally {
      setSavingWord(null);
    }
  };

  return (
    <Box className="flex flex-wrap items-center gap-1.5" sx={{ maxWidth: '75%' }}>
      <Box component="span" className="text-xs" sx={{ color: 'text.secondary' }}>
        值得学：
      </Box>
      {suggestions.map((suggestion) => {
        const saved = savedWords.has(suggestion.word);
        const saving = savingWord === suggestion.word;
        return (
          <Chip
            key={suggestion.word}
            size="small"
            color={saved ? 'success' : 'primary'}
            variant={saved ? 'filled' : 'outlined'}
            label={saved ? `✓ ${suggestion.word}` : `+ ${suggestion.word}`}
            onClick={() => void handleSave(suggestion)}
            disabled={saving || saved}
            deleteIcon={undefined}
            sx={{ height: 36, '& .MuiChip-label': { fontWeight: 500 } }}
          />
        );
      })}
      {savingWord !== null && <CircularProgress size={14} sx={{ alignSelf: 'center' }} />}
    </Box>
  );
}
