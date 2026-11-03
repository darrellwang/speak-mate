/**
 * 轻量全局 Toast 通知（零依赖：window CustomEvent 事件总线）。
 *
 * - client.ts 统一错误提示、入库成功提示等都经此派发；
 * - AppShell 订阅并渲染 Snackbar（含可选动作按钮，如「已加入词汇本 → 查看」直达词汇本）。
 */

export type ToastSeverity = 'success' | 'error' | 'info' | 'warning';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastPayload {
  key: number;
  severity: ToastSeverity;
  message: string;
  action?: ToastAction;
}

const TOAST_EVENT = 'speakmate:toast';
let toastSeq = 0;

function dispatch(severity: ToastSeverity, message: string, action?: ToastAction): void {
  if (typeof window === 'undefined') return;
  toastSeq += 1;
  const payload: ToastPayload = { key: toastSeq, severity, message, action };
  window.dispatchEvent(new CustomEvent<ToastPayload>(TOAST_EVENT, { detail: payload }));
}

export function notifySuccess(message: string, action?: ToastAction): void {
  dispatch('success', message, action);
}

export function notifyError(message: string): void {
  dispatch('error', message);
}

export function notifyInfo(message: string): void {
  dispatch('info', message);
}

export function notifyWarning(message: string): void {
  dispatch('warning', message);
}

/** AppShell 订阅入口，返回取消订阅函数 */
export function subscribeToToasts(listener: (toast: ToastPayload) => void): () => void {
  const handler = (event: Event): void => {
    listener((event as CustomEvent<ToastPayload>).detail);
  };
  window.addEventListener(TOAST_EVENT, handler);
  return () => window.removeEventListener(TOAST_EVENT, handler);
}
