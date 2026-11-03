/**
 * 静默登录（utils/auth.ts）—— P2-5 多用户
 *
 * 流程（微信官方标准登录链路）：
 *   1. wx.login() 静默拿到临时凭证 code（5 分钟有效、一次性、无弹窗）；
 *   2. code 发给后端 POST /api/auth/wechat-login；
 *   3. 后端用 AppID + AppSecret 调 code2Session 换 openid，签发自己的 token；
 *   4. token 存本机 Storage，后续请求经 Authorization: Bearer 头携带。
 *
 * 为什么只取 openid、不取头像昵称：
 * - wx.getUserProfile 需要 button open-type 主动触发 + 系统授权弹窗，
 *   隐私声明与审核门槛都高一档；
 * - SpeakMate 不展示头像昵称也能跑通，少收一份数据符合"最小必要"原则。
 *
 * ⚠️ 微信后台前提：《用户隐私保护指引》必须声明「用户账号信息 / OpenID」
 * 并勾选 wx.login 权限，否则后端拿到的 openid 带 `temp-` 前缀（临时值、不稳定），
 * 后端会明确报错而不是静默用临时标识建账号。
 *
 * 并发注意：code 一次性且多接口并行会拿到不同 code，导致签发多个 token。
 * 这里用 loginPromise 单飞（single-flight）保证同一时刻只有一个登录请求在飞，
 * 所有调用方共享同一个 Promise。
 */

import { getAdminToken, getSettings } from './storage';

/** Storage key：登录态 token */
const KEY_TOKEN = 'speakmate_token';
/** Storage key：登录态过期时间（ISO 8601） */
const KEY_EXPIRES_AT = 'speakmate_token_expires_at';
/** Storage key：当前用户信息（仅用于展示，如随机昵称） */
const KEY_USER = 'speakmate_user';

/** 距过期不足此时长即视为需要重新登录（留出网络往返余量） */
const EXPIRY_SKEW_MS = 60_000;

/** 单飞锁：并发调用共享同一个登录 Promise */
let loginPromise: Promise<string> | null = null;

/** 上次登录失败的原因（用于冷却期内复用，避免反复弹窗） */
let lastLoginError: Error | null = null;
/** 上次登录失败的时间戳 */
let lastLoginErrorAt = 0;
/** 登录失败冷却时长：30 秒 */
const LOGIN_FAIL_COOLDOWN_MS = 30_000;

/**
 * 读取本地 token（无或已过期返回空串）。
 *
 * 优先级：管理员访问令牌 > 微信登录态 token。
 * 管理员令牌是主人手动填入的静态凭证（对应后端 ACCESS_TOKEN），
 * 一旦填了就一直有效，不参与微信静默登录流程。
 */
export function getToken(): string {
  const admin = getAdminToken();
  if (admin !== '') {
    return admin;
  }
  const token = (wx.getStorageSync(KEY_TOKEN) as string) || '';
  if (token === '') return '';
  const expiresAt = (wx.getStorageSync(KEY_EXPIRES_AT) as string) || '';
  if (expiresAt !== '' && new Date(expiresAt).getTime() - EXPIRY_SKEW_MS <= Date.now()) {
    return '';
  }
  return token;
}

/** 读取本地缓存的用户信息 */
export function getCachedUser(): { nickname: string; id: string } | null {
  const raw = wx.getStorageSync(KEY_USER);
  if (typeof raw !== 'object' || raw === null) return null;
  const u = raw as { nickname?: unknown; id?: unknown };
  return {
    nickname: typeof u.nickname === 'string' ? u.nickname : '学习者',
    id: typeof u.id === 'string' ? u.id : '',
  };
}

/**
 * 当前是否运行在微信开发者工具里。
 *
 * ⚠️ 开发者工具的**模拟器**里 wx.login() 返回的是固定假 code（如 devtools_fake_code），
 * 不是真的微信临时凭证——拿它去换 openid 必然失败（后端会先被 code 格式校验拦成 400）。
 * 所以模拟器里需要一条降级路径，否则「测试连接」永远失败、日常调试无法进行。
 *
 * 真机预览 / 正式发布时 platform 为 'ios'/'android'/'devtools' 之外的平台，走正常微信登录。
 */
export function isDevTools(): boolean {
  try {
    const info = wx.getSystemInfoSync() as { platform?: string };
    return info.platform === 'devtools';
  } catch {
    return false;
  }
}

/** 清除本地登录态（退出登录 / 数据被清空后） */
export function clearToken(): void {
  wx.removeStorageSync(KEY_TOKEN);
  wx.removeStorageSync(KEY_EXPIRES_AT);
  wx.removeStorageSync(KEY_USER);
}

/** 保存登录态 */
function saveToken(token: string, expiresAt: string, user: unknown): void {
  wx.setStorageSync(KEY_TOKEN, token);
  wx.setStorageSync(KEY_EXPIRES_AT, expiresAt);
  wx.setStorageSync(KEY_USER, user);
}

/** wx.login 包装为 Promise */
function wxLogin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    wx.login({
      success: (res) => {
        if (res.code) {
          resolve(res.code);
        } else {
          reject(new Error('wx.login 未返回 code'));
        }
      },
      fail: (err) => reject(new Error(err.errMsg ?? 'wx.login 调用失败')),
    });
  });
}

/**
 * 底层登录：wx.login → 后端换 token（不走单飞锁）
 * @param force 忽略本地缓存强制重新登录
 */
async function doLogin(force: boolean): Promise<string> {
  const cached = force ? '' : getToken();
  if (cached !== '') {
    return cached;
  }

  const base = (getSettings().baseUrl || '').trim().replace(/\/+$/, '');
  if (base === '') {
    throw new Error('尚未配置后端地址，请在「我的」页填写');
  }

  const code = await wxLogin();
  const res = await new Promise<{
    statusCode: number;
    data: { code?: number; data?: { token?: string; expires_at?: string; user?: unknown }; message?: string } | null;
  }>((resolve, reject) => {
    wx.request({
      url: `${base}/api/auth/wechat-login`,
      method: 'POST',
      data: { code },
      header: { 'Content-Type': 'application/json', Accept: 'application/json' },
      timeout: 15000,
      success: (r) => resolve(r as never),
      fail: (err) => reject(new Error(err.errMsg ?? '登录请求失败')),
    });
  });

  const payload = res.data;
  if (res.statusCode !== 200 || payload === null || payload.code !== 0) {
    const message = payload?.message ?? `登录失败（HTTP ${res.statusCode}）`;
    throw new Error(message);
  }
  const token = payload.data?.token;
  const expiresAt = payload.data?.expires_at;
  if (typeof token !== 'string' || token === '' || typeof expiresAt !== 'string') {
    throw new Error('登录响应格式异常');
  }

  saveToken(token, expiresAt, payload.data?.user ?? {});
  return token;
}

/**
 * 确保已登录：返回可用 token。
 *
 * - 已有管理员令牌或有效登录态 → 直接返回（不发请求）
 * - 否则 → 走静默登录（单飞，并发调用共享一次登录）
 *
 * ⚠️ 失败冷却：登录失败后短时间内不再重试。
 * 否则每个业务请求都会触发一次 wx.login + 后端往返，失败时变成"每点一次弹一次 Toast"，
 * 既吵又浪费微信的 code 配额。冷却期内直接抛出上次的错误。
 */
export function ensureLogin(): Promise<string> {
  const cached = getToken();
  if (cached !== '') {
    return Promise.resolve(cached);
  }
  // 冷却期内：直接复用上次的错误，不再发起登录请求
  if (lastLoginError !== null && Date.now() - lastLoginErrorAt < LOGIN_FAIL_COOLDOWN_MS) {
    return Promise.reject(lastLoginError);
  }
  if (loginPromise !== null) {
    return loginPromise;
  }
  loginPromise = doLogin(false)
    .catch((err: unknown) => {
      // 降级：开发者工具模拟器的 wx.login 拿不到真 code，
      // 此时若用户填了访问令牌，就用它继续调试（身份落 admin）。
      if (isDevTools()) {
        const admin = getAdminToken();
        if (admin !== '') {
          return admin;
        }
      }
      lastLoginError = err instanceof Error ? err : new Error(String(err));
      lastLoginErrorAt = Date.now();
      throw lastLoginError;
    })
    .finally(() => {
      loginPromise = null;
    });
  return loginPromise;
}

/**
 * 强制重新登录（token 被服务端注销或数据被清空后使用）。
 *
 * ⚠️ 若设置了管理员令牌，则不做静默登录——直接复用管理员令牌
 * （否则 401 重试会把管理员身份换成微信身份，主人会突然看不到自己的数据）。
 */
export function forceLogin(): Promise<string> {
  const admin = getAdminToken();
  if (admin !== '') {
    return Promise.resolve(admin);
  }
  // 开发者工具模拟器：wx.login 拿不到真 code，只能靠管理员令牌兜底
  if (isDevTools()) {
    return Promise.reject(
      new Error('开发者工具无法完成微信登录，请在「我的」页填写访问令牌后重试'),
    );
  }
  clearToken();
  // 强制重试不受冷却限制（用户明确要求重试）
  lastLoginError = null;
  lastLoginErrorAt = 0;
  return doLogin(true);
}
