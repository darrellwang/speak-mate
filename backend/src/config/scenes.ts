/**
 * 场景库加载器：shared/scenes.json 的唯一后端入口（前后端唯一事实源）。
 *
 * 启动期完成结构校验（10 个场景 / 分类合法 / id 唯一），校验失败快速退出，
 * 运行期以 SCENES 数组与 SCENE_MAP 提供只读访问。
 */

import scenesJson from '../../../shared/scenes.json';
import type { Scene } from '../../../shared/types/models';
import { sceneNotFound } from '../middleware/error';

const EXPECTED_SCENE_COUNT = 10;
const VALID_CATEGORIES: ReadonlySet<string> = new Set(['it', 'life', 'interview']);

function isSceneLike(value: unknown): value is Scene {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (
    typeof o.id === 'string' &&
    o.id.length > 0 &&
    typeof o.name === 'string' &&
    o.name.length > 0 &&
    typeof o.name_en === 'string' &&
    o.name_en.length > 0 &&
    typeof o.category === 'string' &&
    VALID_CATEGORIES.has(o.category) &&
    typeof o.description === 'string' &&
    typeof o.role === 'string' &&
    typeof o.goal === 'string' &&
    typeof o.opener === 'string' &&
    o.opener.length > 0
  );
}

function loadScenes(): Scene[] {
  const raw: unknown[] = Array.isArray(scenesJson) ? scenesJson : [];
  const scenes = raw.filter(isSceneLike).map((s) => ({ ...s }));
  if (scenes.length !== EXPECTED_SCENE_COUNT) {
    throw new Error(
      `[scenes] scenes.json 场景数据不完整（期望 ${EXPECTED_SCENE_COUNT} 个，实际合法 ${scenes.length} 个）`,
    );
  }
  const ids = new Set(scenes.map((s) => s.id));
  if (ids.size !== scenes.length) {
    throw new Error('[scenes] scenes.json 存在重复场景 id');
  }
  return scenes;
}

/** 全部内置场景（顺序即 scenes.json 顺序：IT 5 + 生活 4 + 面试 1） */
export const SCENES: readonly Scene[] = loadScenes();

/** id → Scene 只读映射 */
export const SCENE_MAP: ReadonlyMap<string, Scene> = new Map(SCENES.map((s) => [s.id, s]));

export function getSceneOrUndefined(sceneId: string): Scene | undefined {
  return SCENE_MAP.get(sceneId);
}

/** 获取场景，不存在抛 2002（架构 §4.1 错误码表） */
export function mustGetScene(sceneId: string): Scene {
  const scene = SCENE_MAP.get(sceneId);
  if (!scene) {
    throw sceneNotFound(sceneId);
  }
  return scene;
}

/** 场景显示名（英文名优先；查不到时返回 fallback，不抛错，用于列表冗余字段） */
export function sceneDisplayName(sceneId: string, fallback = 'Unknown Scene'): string {
  return SCENE_MAP.get(sceneId)?.name_en ?? fallback;
}
