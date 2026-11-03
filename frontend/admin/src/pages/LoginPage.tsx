import { useState, type FormEvent } from 'react';
import { AdminApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(token);
    } catch (err) {
      const message = err instanceof AdminApiError || err instanceof Error ? err.message : '登录失败';
      setError(
        message.includes('管理员')
          ? '这不是管理员访问令牌。邀请码换到的登录态不能进入管理台。'
          : message,
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <p className="eyebrow">SpeakMate</p>
        <h1>管理台</h1>
        <p className="lede">
          只接受后端 <code>ACCESS_TOKEN</code>。邀请码和微信登录态不能用在这里。
        </p>
        <label htmlFor="admin-token">管理员访问令牌</label>
        <input
          id="admin-token"
          type="password"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="与 backend/.env 中的 ACCESS_TOKEN 相同"
          required
        />
        {error !== null ? <p className="form-error">{error}</p> : null}
        <button type="submit" className="primary" disabled={pending}>
          {pending ? '正在核对…' : '进入管理台'}
        </button>
      </form>
    </div>
  );
}
