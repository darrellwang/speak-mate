/**
 * fetch 封装（架构文档 §2 api/client.ts）。
 *
 * - 统一解包 REST 响应包裹 `{code, data, message}`：code=0 返回 data，非 0 抛 ApiError；
 * - 网络失败 / 非 JSON 响应 → ApiError（code=-1 / HTTP status）；
 * - 默认派发全局错误 Toast（silent 选项供自行处理错误的调用方关闭，如词条卡弹窗重试）；
 * - 零第三方依赖：原生 fetch。
 */
import type { ApiEnvelope } from '@shared/types/api';
import { notifyError } from '../utils/notify';
import { withAuthHeaders } from './token';

/** 业务/网络错误统一异常（携带契约错误码，见架构文档 §4.1 错误码表） */
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

/** 未授权时给用户的可执行提示（后端设置了 ACCESS_TOKEN 但前端未配置） */
export const UNAUTHORIZED_HINT = '未授权：请在「设置」页填写访问令牌（对应后端 ACCESS_TOKEN）';

export interface RequestOptions {
  /** true = 不派发全局错误 Toast（调用方自行处理） */
  silent?: boolean;
  /** 透传 AbortController.signal */
  signal?: AbortSignal;
}

async function request<T>(
  path: string,
  method: string,
  body: unknown | undefined,
  options: RequestOptions,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: withAuthHeaders(
        body === undefined
          ? { Accept: 'application/json' }
          : { Accept: 'application/json', 'Content-Type': 'application/json' },
      ),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    const apiError = new ApiError('网络连接失败，请检查网络或后端服务', -1, 0);
    if (!options.silent) notifyError(apiError.message);
    throw apiError;
  }

  let payload: ApiEnvelope<T> | null = null;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch {
    payload = null; // 非 JSON 响应（网关错误页等）
  }

  if (!response.ok || payload === null || typeof payload.code !== 'number' || payload.code !== 0) {
    // 401 单独提示：默认文案只说"未授权"，用户不知道该去哪儿处理
    const unauthorized = response.status === 401;
    const message = unauthorized
      ? UNAUTHORIZED_HINT
      : payload?.message || `请求失败（HTTP ${response.status}）`;
    const apiError = new ApiError(message, payload?.code ?? response.status, response.status);
    if (!options.silent) notifyError(apiError.message);
    throw apiError;
  }
  return payload.data;
}

export const http = {
  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, 'GET', undefined, options);
  },
  post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, 'POST', body ?? {}, options);
  },
  patch<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, 'PATCH', body ?? {}, options);
  },
  del<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    return request<T>(path, 'DELETE', undefined, options);
  },
};
