/**
 * 场景静态映射（shared/scenes.json 唯一事实源的本地只读视图）。
 *
 * 页面主数据来自 GET /api/scenes（含最近使用聚合）；本模块用于：
 * - 仅持有 scene_id 场景下的名称展示（对话顶栏 / 词汇本来源 / 历史列表）；
 * - /api/scenes 请求失败时的场景兜底（useScenes）。
 */
import SCENES_JSON from '@shared/scenes.json';
import type { Scene, SceneCategory } from '@shared/types/models';

export const SCENES: Scene[] = SCENES_JSON as unknown as Scene[];

export const SCENE_MAP: ReadonlyMap<string, Scene> = new Map(SCENES.map((scene) => [scene.id, scene]));

export const SCENE_CATEGORY_LABEL: Record<SceneCategory, string> = {
  it: 'IT 职场',
  life: '生活',
  interview: '面试',
};

/** 场景中文名（含英文名），查不到时回退 id */
export function getSceneName(id: string): string {
  const scene = SCENE_MAP.get(id);
  return scene ? `${scene.name}` : id;
}

export function getScene(id: string | null | undefined): Scene | undefined {
  if (!id) return undefined;
  return SCENE_MAP.get(id);
}
