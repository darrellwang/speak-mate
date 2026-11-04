/**
 * 管理台 API。登录只提交用户名和密码，会话放在后端下发的 httpOnly cookie 里。
 * 页面不保存口令，也不调用邀请码登录。
 */

type Listener = () => void;
const authLostListeners = new Set<Listener>();

export function onAuthLost(listener: Listener): () => void {
  authLostListeners.add(listener);
  return () => {
    authLostListeners.delete(listener);
  };
}

function notifyAuthLost(): void {
  for (const listener of authLostListeners) listener();
}

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(message: string, status: number, code: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = code;
  }
}

interface Envelope<T> {
  code: number;
  data: T;
  message: string;
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  ignoreAuthFailure?: boolean;
}

export type UserStatus = 'active' | 'banned';

export interface AdminUser {
  id: string;
  openid: string | null;
  source: string;
  nickname: string;
  status: UserStatus;
  banned_at: string | null;
  ban_reason: string;
  created_at: string;
  last_login_at: string;
  session_count: number;
  message_count: number;
}

export interface AdminUserList {
  items: AdminUser[];
  total: number;
  page: number;
  page_size: number;
}

export interface AdminStats {
  users: {
    total: number;
    active: number;
    banned: number;
    by_source: { wechat: number; invite: number };
  };
  sessions: { total: number };
  messages: { total: number };
  recent: {
    new_users_7d: number;
    logins_7d: number;
    sessions_7d: number;
    messages_24h: number;
  };
  generated_at: string;
}

export interface AdminHealth {
  status: 'ok' | 'degraded';
  db: 'ok' | 'error';
  llm: {
    provider: string;
    model: string;
    probed: boolean;
    key_present: boolean;
  };
  tts: {
    mode: string;
    local: { status: string; error: string | null; modelDir: string };
  };
  uptime_seconds: number;
  schema: { version: number; user_version: number | null };
  node: string;
}

function buildUrl(path: string, query: RequestOptions['query']): string {
  const url = new URL(path, window.location.origin);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
  }
  return `${url.pathname}${url.search}`;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? 'GET',
      headers,
      credentials: 'include',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new AdminApiError('无法连接后端。请确认 backend 已在 3001 端口启动。', 0, -1);
  }

  let payload: Envelope<T> | null = null;
  try {
    payload = (await response.json()) as Envelope<T>;
  } catch {
    payload = null;
  }

  if (!response.ok || payload === null || payload.code !== 0) {
    if ((response.status === 401 || response.status === 403) && options.ignoreAuthFailure !== true) {
      notifyAuthLost();
    }
    throw new AdminApiError(
      payload?.message || `请求失败（HTTP ${response.status}）`,
      response.status,
      payload?.code ?? response.status,
    );
  }
  return payload.data;
}

export function probeAdmin(): Promise<AdminHealth> {
  return request<AdminHealth>('/api/admin/health', { ignoreAuthFailure: true });
}

export function loginAdmin(username: string, password: string): Promise<{ username: string }> {
  return request<{ username: string }>('/api/admin/login', {
    method: 'POST',
    body: { username, password },
    ignoreAuthFailure: true,
  });
}

export function logoutAdmin(): Promise<Record<string, never>> {
  return request<Record<string, never>>('/api/admin/logout', {
    method: 'POST',
    body: {},
    ignoreAuthFailure: true,
  });
}

export function fetchUsers(query: {
  q: string;
  status: '' | UserStatus;
  page: number;
  pageSize: number;
}): Promise<AdminUserList> {
  return request<AdminUserList>('/api/admin/users', {
    query: {
      q: query.q,
      status: query.status,
      page: query.page,
      page_size: query.pageSize,
    },
  });
}

export function fetchStats(): Promise<AdminStats> {
  return request<AdminStats>('/api/admin/stats');
}

export function fetchHealth(): Promise<AdminHealth> {
  return request<AdminHealth>('/api/admin/health');
}

export function banUser(id: string, reason: string): Promise<{ user: AdminUser }> {
  return request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}/ban`, {
    method: 'POST',
    body: { reason },
  });
}

export function unbanUser(id: string): Promise<{ user: AdminUser }> {
  return request<{ user: AdminUser }>(`/api/admin/users/${encodeURIComponent(id)}/unban`, {
    method: 'POST',
    body: {},
  });
}

export function sourceLabel(source: string): string {
  if (source === 'wechat') return '微信';
  if (source === 'invite') return '邀请码';
  return source;
}

export function formatTime(iso: string | null): string {
  if (iso === null || iso === '') return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

export function formatUptime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const days = Math.floor(whole / 86400);
  const hours = Math.floor((whole % 86400) / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${whole} 秒`;
}
