/**
 * 本地存储（utils/storage.ts）
 *
 * 只放四类数据：设置项、当前会话 id、最近使用过的场景、管理员访问令牌。
 * 一律同步读写（小程序同步 API 的耗时在 KB 级数据上可忽略，代码却清晰得多）。
 *
 * 刻意不缓存会话消息：消息以服务端为准，本地缓存只会带来「回看看到旧数据」的困惑。
 *
 * 关于令牌（P2-5 多用户）：
 * - 普通用户的登录态 token 由 utils/auth.ts 管理（wx.login 静默登录 → 服务端签发）；
 * - 这里额外存的是**管理员访问令牌**（对应后端 ACCESS_TOKEN），仅主人本地持有，
 *   用于在未登录微信账号的情况下以管理员身份访问（多用户体系里落 'admin' 账号）。
 *   它曾硬编码在 config.ts 里，因小程序包体可反编译而已移除。
 */

import { DEFAULT_SETTINGS, type Settings } from '../config';

const KEY_SETTINGS = 'speakmate_settings';
const KEY_SESSION_ID = 'current_session_id';
const KEY_RECENT_SCENES = 'recent_scene_ids';
const KEY_ADMIN_TOKEN = 'speakmate_admin_token';

/** 读取设置（缺失字段用默认值补齐，保证老版本 Storage 升级后不炸） */
export function getSettings(): Settings {
  const raw = wx.getStorageSync(KEY_SETTINGS) as Partial<Settings> | '';
  const stored = typeof raw === 'object' && raw !== null ? raw : {};
  return { ...DEFAULT_SETTINGS, ...stored };
}

/** 合并保存设置，返回保存后的完整设置 */
export function saveSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  wx.setStorageSync(KEY_SETTINGS, next);
  return next;
}

/** 清空全部本地设置（设置页「恢复默认」） */
export function clearSettings(): Settings {
  wx.removeStorageSync(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS };
}

/** 当前会话 id（空串 = 无会话，练习页展示空态） */
export function getCurrentSessionId(): string {
  return (wx.getStorageSync(KEY_SESSION_ID) as string | '') || '';
}

export function setCurrentSessionId(id: string): void {
  if (id === '') {
    wx.removeStorageSync(KEY_SESSION_ID);
    return;
  }
  wx.setStorageSync(KEY_SESSION_ID, id);
}

/** 最近使用的场景 id（最多 5 个，最新在前；本地维护即可，服务端不关心） */
export function getRecentSceneIds(): string[] {
  const raw = wx.getStorageSync(KEY_RECENT_SCENES);
  return Array.isArray(raw) ? (raw as string[]).slice(0, 5) : [];
}

export function pushRecentSceneId(sceneId: string): string[] {
  const next = [sceneId, ...getRecentSceneIds().filter((id) => id !== sceneId)].slice(0, 5);
  wx.setStorageSync(KEY_RECENT_SCENES, next);
  return next;
}

/** 读取管理员访问令牌（未设置返回空串） */
export function getAdminToken(): string {
  return (wx.getStorageSync(KEY_ADMIN_TOKEN) as string) || '';
}

/** 保存管理员访问令牌（空串等价于清除） */
export function setAdminToken(token: string): void {
  if (token === '') {
    wx.removeStorageSync(KEY_ADMIN_TOKEN);
    return;
  }
  wx.setStorageSync(KEY_ADMIN_TOKEN, token);
}
