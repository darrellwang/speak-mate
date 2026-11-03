/**
 * 场景选择页（架构文档 §2 pages/ScenesPage.tsx，路由 /scenes，P0-4）。
 *
 * 「接着上次聊」（延续模式，最近使用场景）+ 三分类分组网格：
 * IT 职场 5 / 生活 4 / 面试 1；最近使用的场景卡片带标记；
 * 选定即新建会话 + 场景开场白 → 跳回对话页。
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardActionArea from '@mui/material/CardActionArea';
import Chip from '@mui/material/Chip';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { Scene, SceneCategory } from '@shared/types/models';
import { useScenes } from '../hooks/useScenes';
import { useSessionStore } from '../stores/sessionStore';
import { SCENE_CATEGORY_LABEL } from '../utils/sceneMap';
import { ArrowBackIcon, RefreshIcon } from '../components/icons';

interface SceneCardProps {
  scene: Scene;
  recent: boolean;
  creating: boolean;
  onPick(scene: Scene): void;
}

function SceneCard({ scene, recent, creating, onPick }: SceneCardProps): JSX.Element {
  return (
    <Card
      variant="outlined"
      sx={{
        borderRadius: 2.5,
        position: 'relative',
        borderColor: creating ? 'primary.main' : 'divider',
        borderWidth: creating ? 2 : 1,
      }}
    >
      <CardActionArea onClick={() => onPick(scene)} sx={{ height: '100%', p: 1.5, display: 'block' }}>
        <Box className="flex items-start justify-between gap-1">
          <Typography variant="subtitle1" component="div" sx={{ fontWeight: 600 }}>
            {scene.name}
          </Typography>
          {recent && <Chip label="最近" size="small" color="primary" sx={{ height: 22, fontSize: 11 }} />}
        </Box>
        <Typography
          variant="caption"
          component="div"
          sx={{ color: 'text.secondary', mb: 0.5, fontStyle: 'italic' }}
        >
          {scene.name_en}
        </Typography>
        <Typography variant="body2" sx={{ color: 'text.secondary', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', lineHeight: 1.5 }}>
          {scene.description}
        </Typography>
        {creating && (
          <Box className="absolute inset-0 flex items-center justify-center" sx={{ bgcolor: 'background.paper', opacity: 0.8, borderRadius: 2.5 }}>
            <CircularProgress size={26} />
          </Box>
        )}
      </CardActionArea>
    </Card>
  );
}

interface SceneGroupProps {
  title: string;
  scenes: Scene[];
  recentIds: ReadonlySet<string>;
  creatingSceneId: string | null;
  onPick(scene: Scene): void;
}

function SceneGroup({ title, scenes, recentIds, creatingSceneId, onPick }: SceneGroupProps): JSX.Element {
  if (scenes.length === 0) return <></>;
  return (
    <Box className="flex flex-col gap-2">
      <Typography variant="subtitle2" sx={{ color: 'text.secondary', fontWeight: 600 }}>
        {title}（{scenes.length}）
      </Typography>
      <Box className="grid grid-cols-2 gap-2">
        {scenes.map((scene) => (
          <SceneCard
            key={scene.id}
            scene={scene}
            recent={recentIds.has(scene.id)}
            creating={creatingSceneId === scene.id}
            onPick={onPick}
          />
        ))}
      </Box>
    </Box>
  );
}

export default function ScenesPage(): JSX.Element {
  const navigate = useNavigate();
  const { scenes, recentSceneIds, loading, creating, createSession, reload } = useScenes();
  const hasCurrentSession = useSessionStore((state) => state.currentSession !== null);

  const recentIdSet = useMemo(() => new Set(recentSceneIds), [recentSceneIds]);
  const groups = useMemo(() => {
    const byCategory = new Map<SceneCategory, Scene[]>();
    for (const scene of scenes) {
      const list = byCategory.get(scene.category) ?? [];
      list.push(scene);
      byCategory.set(scene.category, list);
    }
    return byCategory;
  }, [scenes]);

  const handlePick = async (scene: Scene): Promise<void> => {
    const ok = await createSession(scene.id);
    if (ok) navigate('/', { replace: true });
  };

  /** 接着上次聊：最近使用场景 + 延续模式（LLM 生成延续性开场白） */
  const handleContinue = async (): Promise<void> => {
    const lastSceneId = recentSceneIds[0];
    if (lastSceneId === undefined) return;
    const ok = await createSession(lastSceneId, true);
    if (ok) navigate('/', { replace: true });
  };

  const continueBusy = creating?.continueFromLast === true;

  return (
    <Box className="flex h-full min-h-0 flex-col">
      {/* 顶栏 */}
      <Box
        component="header"
        className="pt-safe flex items-center gap-1 px-1"
        sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        {hasCurrentSession && (
          <Button
            size="small"
            startIcon={<ArrowBackIcon />}
            onClick={() => navigate('/')}
            sx={{ color: 'text.secondary' }}
          >
            返回对话
          </Button>
        )}
        <Typography variant="subtitle1" sx={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>
          选择场景
        </Typography>
        <IconButton onClick={() => void reload()} aria-label="刷新场景" size="small">
          <RefreshIcon fontSize="small" />
        </IconButton>
      </Box>

      {/* 内容 */}
      <Box className="thin-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {loading ? (
          <Box sx={{ px: 1 }}>
            <LinearProgress sx={{ borderRadius: 999 }} />
          </Box>
        ) : (
          <Box className="flex flex-col gap-4">
            {/* 接着上次聊（延续模式） */}
            {recentSceneIds.length > 0 && (
              <Button
                variant="contained"
                size="large"
                fullWidth
                disabled={continueBusy}
                onClick={() => void handleContinue()}
                startIcon={continueBusy ? <CircularProgress size={18} color="inherit" /> : undefined}
                sx={{ py: 1.5 }}
              >
                {continueBusy ? '正在生成延续性开场白…' : '接着上次聊（延续话题新会话）'}
              </Button>
            )}

            <SceneGroup
              title={SCENE_CATEGORY_LABEL.it}
              scenes={groups.get('it') ?? []}
              recentIds={recentIdSet}
              creatingSceneId={creating?.sceneId ?? null}
              onPick={(scene) => void handlePick(scene)}
            />
            <SceneGroup
              title={SCENE_CATEGORY_LABEL.life}
              scenes={groups.get('life') ?? []}
              recentIds={recentIdSet}
              creatingSceneId={creating?.sceneId ?? null}
              onPick={(scene) => void handlePick(scene)}
            />
            <SceneGroup
              title={SCENE_CATEGORY_LABEL.interview}
              scenes={groups.get('interview') ?? []}
              recentIds={recentIdSet}
              creatingSceneId={creating?.sceneId ?? null}
              onPick={(scene) => void handlePick(scene)}
            />
          </Box>
        )}
      </Box>
    </Box>
  );
}
