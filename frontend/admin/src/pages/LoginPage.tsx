import { useState, type FormEvent } from 'react';
import { AdminApiError } from '../api';
import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await login(username, password);
    } catch (err) {
      const message = err instanceof AdminApiError || err instanceof Error ? err.message : '登录失败';
      setError(message);
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
          使用用户名和密码登录。默认用户名是 <code>admin</code>，密码来自服务器的{' '}
          <code>ADMIN_PASSWORD</code>。邀请码和微信登录态不能用在这里。
        </p>
        <label htmlFor="admin-username">用户名</label>
        <input
          id="admin-username"
          name="username"
          type="text"
          autoComplete="username"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
        <label htmlFor="admin-password">密码</label>
        <input
          id="admin-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
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
