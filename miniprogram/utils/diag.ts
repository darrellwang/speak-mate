/**
 * 语音链路诊断上报（utils/diag.ts）
 *
 * 用途：真机上"按了没反应"这类问题无法靠猜——需要知道客户端到底走到哪一步断了。
 * 本模块把关键节点 POST 到后端 /api/diag/voice，后端写进服务日志，
 * 于是用 `tail -f` 就能实时看到手机的语音链路轨迹。
 *
 * 设计原则：
 * - **绝不阻塞**：诊断上报是 fire-and-forget，失败静默忽略，绝不影响主流程；
 * - **不记录音频内容**：只上报阶段名与布尔状态，绝不上报任何文本/音频；
 * - **必须带令牌**：诊断接口挂在 /api 下受 requireAuth 保护，
 *   这里必须自己附加 Authorization 头（不能依赖 utils/request.ts——
 *   那个封装会触发登录重试，诊断路径不需要、也不该被登录状态牵连）。
 */

import { getToken } from './auth';
import { getSettings } from './storage';

/** 后端诊断接口（与 backend/src/routes/diag.routes.ts 对应） */
const DIAG_URL = '/api/diag/voice';

/** Storage 键：语音诊断开关（默认关，排查时在开发者工具里手动置 true） */
const KEY_DIAG = 'debug_voice';

/**
 * 诊断上报是否启用。
 *
 * ⚠️ **默认关闭**：语音链路已修复（2026-11-02 验证通过），平时开着只会
 * 每次按住在后台多发 5–6 个请求，白白污染服务日志。
 *
 * 需要排查语音问题时，在微信开发者工具的 Storage 面板加一个键：
 *   key = `debug_voice`, value = true
 * 重新编译即可看到 `[diag] voice step=...` 的完整轨迹。
 */
let enabled: boolean | null = null;

function readEnabled(): boolean {
  if (enabled !== null) return enabled;
  try {
    const raw = wx.getStorageSync(KEY_DIAG);
    enabled = raw === true || raw === 'true' || raw === 1;
  } catch {
    enabled = false;
  }
  return enabled;
}

export function setDiagEnabled(v: boolean): void {
  enabled = v;
  try {
    wx.setStorageSync(KEY_DIAG, v);
  } catch {
    // ignore
  }
}

export function isDiagEnabled(): boolean {
  return readEnabled();
}

/** 单次上报的阶段信息（只允许标量，绝不传文本） */
export interface VoiceDiagStep {
  /** 阶段标识（如 'talk_start' / 'perm_granted' / 'asr_started'） */
  step: string;
  /** 补充信息（数字/布尔/短标签） */
  info?: string | number | boolean;
  /** 耗时（毫秒），用于定位慢在哪一步 */
  ms?: number;
}

/** 计时起点 */
let t0 = Date.now();

export function resetDiagClock(): void {
  t0 = Date.now();
}

/**
 * 上报一个阶段。
 *
 * ⚠️ 全程 try/catch 包裹：诊断代码的任何异常都不能影响语音主流程。
 */
export function diag(step: string, info?: string | number | boolean): void {
  if (!readEnabled()) return;
  try {
    const base = (getSettings().baseUrl || '').trim().replace(/\/+$/, '');
    if (base === '') return;
    const payload = {
      step,
      info: info ?? '',
      ms: Date.now() - t0,
      platform: safePlatform(),
    };
    // ⚠️ 必须带 Authorization：诊断接口在 /api 下受鉴权保护
    const token = getToken();
    const header: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token !== '') {
      header.Authorization = `Bearer ${token}`;
    }
    wx.request({
      url: `${base}${DIAG_URL}`,
      method: 'POST',
      data: payload,
      header,
      timeout: 5000,
      success: () => {},
      fail: () => {},
    });
  } catch {
    // 诊断失败无所谓，静默
  }
}

/** 取平台标识（devtools / ios / android），失败返回空串 */
function safePlatform(): string {
  try {
    const info = wx.getSystemInfoSync() as { platform?: string };
    return info.platform ?? '';
  } catch {
    return '';
  }
}
