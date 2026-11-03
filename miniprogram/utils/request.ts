/**
 * 统一请求封装（utils/request.ts）
 *
 * 与 H5 端 api/client.ts 一一对应，差异点只有传输层：
 * - 传输：fetch → wx.request（无 CORS 概念，但受「服务器域名白名单」约束，见 README）；
 * - 相对路径不可用：小程序里 `/api` 会打向微信自身的域名，必须拼后端绝对地址；
 * - 统一解包 `{code, data, message}`：code=0 返回 data，非 0 抛 ApiError。
 *
 * 令牌（P2-5 多用户）：
 * - 令牌来自 utils/auth.ts 的静默登录结果，存在本机 Storage，**不写进代码包**；
 *   （小程序包体可被反编译，硬编码令牌等同于公开）
 * - 请求前若无有效 token → 自动静默登录补齐；
 * - 收到 401 → 强制重新登录并**重试一次**（token 过期 / 被服务端注销的兜底）。
 */

import { REQUEST_TIMEOUT } from '../config';
import { ensureLogin, forceLogin, getToken } from './auth';
import { getSettings } from './storage';

/** 业务/网络错误统一异常（错误码语义见 backend/middleware/error.ts） */
export class ApiError extends Error {
  /** 业务错误码（-1 = 网络失败 / 非 0 业务码 / HTTP status 兜底） */
  readonly code: number;
  /** HTTP 状态码（网络失败为 0） */
  readonly status: number;

  constructor(message: string, code: number, status: number) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

export const UNAUTHORIZED_HINT = '登录已失效，请下拉刷新重试';

export interface RequestOptions {
  /** true = 不弹全局错误 Toast（调用方自行处理） */
  silent?: boolean;
  /** 单次超时（毫秒），默认 REQUEST_TIMEOUT */
  timeout?: number;
}

/** 拼接绝对 URL：baseUrl 去尾斜杠 + 接口路径（路径一律以 /api 开头） */
export function buildUrl(path: string): string {
  const base = (getSettings().baseUrl || '').trim().replace(/\/+$/, '');
  if (base === '') {
    throw new ApiError('尚未配置后端地址，请在「我的」页填写', -1, 0);
  }
  return `${base}${path}`;
}

/** 构造请求头（令牌来自 Storage，由 utils/auth.ts 维护） */
export function buildHeaders(withBody: boolean, token: string): Record<string, string> {
  const header: Record<string, string> = { Accept: 'application/json' };
  if (withBody) {
    header['Content-Type'] = 'application/json';
  }
  if (token !== '') {
    header.Authorization = `Bearer ${token}`;
  }
  return header;
}

interface RawResponse {
  statusCode: number;
  data: unknown;
}

/**
 * miniprogram-api-typings 的 `wx.request` method 联合类型里漏了 PATCH
 * （基础库本身支持），这里显式断言绕过，避免为此放弃统一封装。
 */
type WxMethod = WechatMiniprogram.RequestOption['method'];

/**
 * 发起请求（不解析业务码），返回原始状态码与数据
 *
 * @param token 本次请求使用的令牌（由调用方从 utils/auth.ts 取得）
 */
function rawRequest(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  options: RequestOptions,
  token: string,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    wx.request({
      url: buildUrl(path),
      method: method as WxMethod,
      data: body as never,
      header: buildHeaders(body !== undefined, token),
      timeout: options.timeout ?? REQUEST_TIMEOUT,
      success: (res) => resolve({ statusCode: res.statusCode, data: res.data }),
      fail: (err) => reject(err),
    });
  });
}

/** 解包：code=0 返回 data，否则抛 ApiError（401 单独给可执行提示） */
function unwrap<T>(res: RawResponse, options: RequestOptions): T {
  const payload = res.data as { code?: number; data?: T; message?: string } | null;
  const isEnvelope =
    payload !== null && typeof payload === 'object' && typeof payload.code === 'number';
  const ok = res.statusCode >= 200 && res.statusCode < 300 && isEnvelope && payload?.code === 0;

  if (!ok) {
    const unauthorized = res.statusCode === 401;
    const message = unauthorized
      ? UNAUTHORIZED_HINT
      : (payload?.message as string | undefined) || `请求失败（HTTP ${res.statusCode}）`;
    const code = isEnvelope ? (payload?.code as number) : res.statusCode;
    const error = new ApiError(message, code, res.statusCode);
    if (!options.silent) {
      wx.showToast({ title: message, icon: 'none', duration: 2600 });
    }
    throw error;
  }
  return (payload as { data: T }).data;
}

async function request<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body: unknown | undefined,
  options: RequestOptions,
): Promise<T> {
  // 登录接口本身不需要令牌（否则鸡生蛋），其余接口先确保已登录
  let token: string;
  try {
    token = path.startsWith('/api/auth/') ? getToken() : await ensureLogin();
  } catch (err) {
    // 登录失败（后端未配置微信登录 / 网络不通 / baseUrl 为空）——
    // 必须转成 ApiError 并走统一 Toast，否则业务层的 instanceof 判断会失效
    const message = err instanceof Error ? err.message : '登录失败，请稍后重试';
    const error = new ApiError(message, -1, 0);
    if (!options.silent) {
      wx.showToast({ title: message, icon: 'none', duration: 2600 });
    }
    throw error;
  }

  let res: RawResponse;
  try {
    res = await rawRequest(method, path, body, options, token);
  } catch (err) {
    const detail = err as { errMsg?: string };
    // 域名不合法 / 证书问题 / 后端未启动，都归到这一类
    const message =
      detail?.errMsg && detail.errMsg.includes('url not in domain list')
        ? '域名不在白名单：请在「我的」页改用已备案 HTTPS 地址，或勾选开发者工具「不校验合法域名」'
        : '网络连接失败，请检查后端服务与网络';
    const error = new ApiError(message, -1, 0);
    if (!options.silent) {
      wx.showToast({ title: message, icon: 'none', duration: 2600 });
    }
    throw error;
  }

  // 401 → 令牌过期或被注销：强制重新登录后重试一次
  if (res.statusCode === 401 && !path.startsWith('/api/auth/')) {
    try {
      const freshToken = await forceLogin();
      res = await rawRequest(method, path, body, options, freshToken);
    } catch {
      // 重登失败（网络/后端未启动）→ 落到下方统一解包，401 会给出可执行提示
    }
  }

  return unwrap<T>(res, options);
}

export const http = {
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>('GET', path, undefined, options);
  },
  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>('POST', path, body ?? {}, options);
  },
  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>('PATCH', path, body ?? {}, options);
  },
  del<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>('DELETE', path, undefined, options);
  },
};
