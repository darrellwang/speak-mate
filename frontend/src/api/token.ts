/**
 * 访问令牌的本地存取（审查报告 H1 的配套前端实现）。
 *
 * 后端 `ACCESS_TOKEN` 非空时 /api/* 全部要求 `Authorization: Bearer <token>`，
 * 因此前端必须有一条注入通道，否则一旦启用令牌整个应用就不可用。
 *
 * 为什么不放 Vite 环境变量（`VITE_ACCESS_TOKEN`）：
 * 那会被内联进打包后的 JS，任何人打开页面查看源码即可拿到，等同于没有鉴权。
 * 改为首次使用时由用户录入，存 localStorage（与"单用户自托管"的定位一致）。
 */

const STORAGE_KEY = 'speakmate-access-token';

/** 读取当前令牌（未设置返回空串） */
export function getAccessToken(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    // 隐私模式 / 禁用存储 → 视为未设置，不阻断使用
    return '';
  }
}

/** 保存令牌（空串等价于清除） */
export function setAccessToken(token: string): void {
  try {
    if (token === '') {
      localStorage.removeItem(STORAGE_KEY);
    } else {
      localStorage.setItem(STORAGE_KEY, token);
    }
  } catch {
    // 存不进去也不影响当次会话：由调用方决定是否提示
  }
}

/** 清除令牌 */
export function clearAccessToken(): void {
  setAccessToken('');
}

/**
 * 构造请求头：始终包含传入的基础头，令牌存在时附加 Authorization。
 */
export function withAuthHeaders(base: Record<string, string>): Record<string, string> {
  const token = getAccessToken();
  if (token === '') {
    return base;
  }
  return { ...base, Authorization: `Bearer ${token}` };
}
