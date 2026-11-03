/**
 * 词汇本页（架构文档 §2 pages/WordsPage.tsx，路由 /words，P0-6 / P1-4）。
 *
 * 时间倒序列表（单词/音标/释义/来源场景）+ mastery 三档筛选 + 分页加载
 * + 删除（二次确认）+ 复习模式（遮盖自测 + 掌握度标记，=2 注入画像）。
 */
import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { MasteryLevel, Word } from '@shared/types/models';
import { api } from '../api/endpoints';
import ReviewCard from '../components/words/ReviewCard';
import WordListItem from '../components/words/WordListItem';
import { SchoolIcon } from '../components/icons';
import { notifySuccess } from '../utils/notify';

const PAGE_SIZE = 30;

type MasteryFilter = MasteryLevel | 'all';

const FILTER_OPTIONS: ReadonlyArray<{ value: MasteryFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 0, label: '生疏' },
  { value: 1, label: '熟悉' },
  { value: 2, label: '已掌握' },
];

export default function WordsPage(): JSX.Element {
  const [filter, setFilter] = useState<MasteryFilter>('all');
  const [items, setItems] = useState<Word[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [deleting, setDeleting] = useState<Word | null>(null);

  const load = useCallback(
    async (targetFilter: MasteryFilter, reset: boolean): Promise<void> => {
      if (reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      try {
        const currentItems = reset ? [] : items;
        const page = await api.listWords({
          mastery: targetFilter === 'all' ? undefined : targetFilter,
          limit: PAGE_SIZE,
          offset: currentItems.length,
        });
        setItems(reset ? page.items : [...currentItems, ...page.items]);
        setTotal(page.total);
        setHasMore(page.has_more);
      } catch {
        // client 已统一错误提示
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [items],
  );

  /* 筛选切换 → 重置加载 */
  useEffect(() => {
    setItems([]);
    void load(filter, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const handleDelete = async (): Promise<void> => {
    if (deleting === null) return;
    const target = deleting;
    setDeleting(null);
    try {
      await api.deleteWord(target.id);
      setItems((prev) => prev.filter((item) => item.id !== target.id));
      setTotal((prev) => Math.max(0, prev - 1));
      notifySuccess(`已删除「${target.word}」`);
    } catch {
      // client 已统一错误提示
    }
  };

  const handleMasteryChange = async (word: Word, level: MasteryLevel): Promise<void> => {
    try {
      const result = await api.updateWordMastery(word.id, level);
      const updated = result.word;
      setItems((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      if (level === 2) {
        notifySuccess(`「${updated.word}」已标记为已掌握，AI 将不再解释它`);
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
          词汇本
          {total > 0 && (
            <Typography component="span" variant="body2" sx={{ color: 'text.secondary', ml: 1 }}>
              {total} 词
            </Typography>
          )}
        </Typography>
        <Button
          size="small"
          variant="outlined"
          startIcon={<SchoolIcon />}
          disabled={items.length === 0}
          onClick={() => setReviewOpen(true)}
        >
          复习
        </Button>
      </Box>

      {/* mastery 筛选 */}
      <Box className="flex flex-wrap items-center gap-1.5 px-3 py-2" sx={{ bgcolor: 'background.paper' }}>
        {FILTER_OPTIONS.map((option) => {
          const active = filter === option.value;
          return (
            <Chip
              key={String(option.value)}
              label={option.label}
              color={active ? 'primary' : 'default'}
              variant={active ? 'filled' : 'outlined'}
              onClick={() => setFilter(option.value)}
              sx={{ height: 36 }}
            />
          );
        })}
      </Box>

      {/* 列表 */}
      <Box className="thin-scroll flex-1 min-h-0 overflow-y-auto px-3 pb-4">
        {loading ? (
          <Box className="flex flex-col gap-2 pt-1">
            {[0, 1, 2, 3].map((key) => (
              <Skeleton key={key} variant="rounded" height={92} sx={{ borderRadius: 2 }} />
            ))}
          </Box>
        ) : items.length === 0 ? (
          <Box className="flex h-full flex-col items-center justify-center gap-1 py-16">
            <Typography variant="body1" sx={{ color: 'text.secondary' }}>
              还没有生词
            </Typography>
            <Typography variant="body2" sx={{ color: 'text.disabled' }}>
              对话中点击 AI 消息「选词」或建议词条即可收藏
            </Typography>
          </Box>
        ) : (
          <Box className="flex flex-col gap-2 pt-1">
            {items.map((word) => (
              <WordListItem
                key={word.id}
                word={word}
                onDelete={(target) => setDeleting(target)}
                onMasteryChange={(target, level) => void handleMasteryChange(target, level)}
              />
            ))}
            {hasMore && (
              <Button
                fullWidth
                variant="text"
                disabled={loadingMore}
                onClick={() => void load(filter, false)}
                startIcon={loadingMore ? <CircularProgress size={16} color="inherit" /> : undefined}
                sx={{ mt: 1 }}
              >
                {loadingMore ? '加载中…' : '加载更多'}
              </Button>
            )}
          </Box>
        )}
      </Box>

      {/* 删除二次确认 */}
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)}>
        <DialogTitle>删除词条</DialogTitle>
        <DialogContent>
          <DialogContentText>
            确定删除「{deleting?.word}」吗？删除后不可恢复。
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleting(null)}>取消</Button>
          <Button color="error" onClick={() => void handleDelete()}>
            删除
          </Button>
        </DialogActions>
      </Dialog>

      {/* 复习模式（全屏） */}
      <Dialog open={reviewOpen} onClose={() => setReviewOpen(false)} fullScreen>
        <ReviewCard
          words={items}
          onClose={() => setReviewOpen(false)}
          onMasteryChange={(word, level) => void handleMasteryChange(word, level)}
        />
      </Dialog>
    </Box>
  );
}
