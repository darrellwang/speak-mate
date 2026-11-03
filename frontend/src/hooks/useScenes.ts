/**
 * 场景 hook（架构文档 §2 hooks/useScenes.ts）。
 *
 * - 场景列表 + 最近使用（GET /api/scenes；失败降级 shared/scenes.json 静态兜底）；
 * - 新建会话（含延续模式 continue_from_last）：成功后写入 sessionStore.currentSession
 *   与 chatStore 开场白消息，并刷新历史列表计数。
 */
import { useCallback, useEffect, useState } from 'react';
import type { Scene } from '@shared/types/models';
import { api } from '../api/endpoints';
import { useChatStore } from '../stores/chatStore';
import { useSessionStore } from '../stores/sessionStore';
import { SCENES as FALLBACK_SCENES } from '../utils/sceneMap';

/** 新建会话进行中标记（null = 空闲） */
export interface CreatingState {
  sceneId: string;
  continueFromLast: boolean;
}

export function useScenes() {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [recentSceneIds, setRecentSceneIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState<CreatingState | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await api.getScenes();
      setScenes(data.scenes);
      setRecentSceneIds(data.recent_scene_ids);
    } catch {
      // client 已统一错误提示；场景静态兜底保证页面可用（最近使用清空）
      setScenes(FALLBACK_SCENES);
      setRecentSceneIds([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 新建会话（P0-4：选定即新会话 + 场景开场白；
   * continueFromLast=true 为延续模式，LLM 生成延续性开场白，失败后端降级静态 opener）
   */
  const createSession = useCallback(
    async (sceneId: string, continueFromLast = false): Promise<boolean> => {
      setCreating({ sceneId, continueFromLast });
      try {
        const data = await api.createSession({
          scene_id: sceneId,
          continue_from_last: continueFromLast,
        });
        useSessionStore.getState().setCurrent(data.session);
        useChatStore.getState().setMessages(data.messages);
        // 后台刷新历史列表（新会话已入库；失败静默，client 已 toast）
        void useSessionStore.getState().loadSessions(true);
        return true;
      } catch {
        return false;
      } finally {
        setCreating(null);
      }
    },
    [],
  );

  return { scenes, recentSceneIds, loading, creating, createSession, reload: load };
}
