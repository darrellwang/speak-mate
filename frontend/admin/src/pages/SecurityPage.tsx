import { useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { banUser, formatTime, sourceLabel, unbanUser, type AdminUser } from '../api';

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function SecurityPage() {
  const [params] = useSearchParams();
  const userFromQuery = params.get('user') ?? '';
  const [userId, setUserId] = useState(userFromQuery);

  useEffect(() => {
    if (userFromQuery !== '') setUserId(userFromQuery);
  }, [userFromQuery]);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<AdminUser | null>(null);
  const [note, setNote] = useState<string | null>(null);

  async function run(action: 'ban' | 'unban', event: FormEvent | { preventDefault(): void }) {
    event.preventDefault();
    const id = userId.trim();
    if (!USER_ID_RE.test(id)) {
      setError('用户 id 只允许字母、数字、下划线和连字符，最长 64 位。');
      return;
    }
    if (id === 'admin') {
      setError('不能封禁管理员身份。ACCESS_TOKEN 对应的 admin 不是 users 表里的学员。');
      return;
    }
    const verb = action === 'ban' ? '封禁' : '解封';
    if (!window.confirm(`${verb} ${id}？这会立即清除该用户的全部登录态。`)) return;

    setPending(true);
    setError(null);
    setNote(null);
    try {
      const result = action === 'ban' ? await banUser(id, reason.trim()) : await unbanUser(id);
      setUser(result.user);
      setNote(action === 'ban' ? '已封禁，现有登录态已失效。' : '已解封。用户需要重新登录。');
    } catch (err) {
      setUser(null);
      setError(err instanceof Error ? err.message : '操作失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="security">
      <header className="page-head">
        <div>
          <h1>安全</h1>
          <p>封禁会写入 users.status，并删除该用户在 auth_sessions 中的全部令牌。之后任何学员接口都返回 401。</p>
        </div>
      </header>

      <div className="split">
        <form className="panel" onSubmit={(event) => event.preventDefault()}>
          <h2>封禁 / 解封</h2>
          <label htmlFor="user-id">用户 id</label>
          <input
            id="user-id"
            value={userId}
            onChange={(event) => setUserId(event.target.value)}
            placeholder="例如 inv_ 开头或微信用户 uuid"
            required
          />
          <label htmlFor="ban-reason">封禁原因（可选，最多 200 字）</label>
          <textarea
            id="ban-reason"
            value={reason}
            maxLength={200}
            rows={4}
            onChange={(event) => setReason(event.target.value)}
            placeholder="只给管理员自己看，不会发给用户"
          />
          <div className="row-actions">
            <button type="button" className="danger" disabled={pending} onClick={(event) => void run('ban', event)}>
              封禁
            </button>
            <button type="button" className="ghost" disabled={pending} onClick={(event) => void run('unban', event)}>
              解封
            </button>
          </div>
          {error !== null ? <p className="form-error">{error}</p> : null}
          {note !== null ? <p className="form-ok">{note}</p> : null}
        </form>

        <aside className="panel policy">
          <h2>谁能进管理台</h2>
          <ul>
            <li>只有与 ACCESS_TOKEN 一致的 Bearer 会被标成管理员。</li>
            <li>邀请码和微信登录换到的令牌访问 /api/admin 会得到 403。</li>
            <li>没配置 ACCESS_TOKEN 时，管理接口同样关闭，零配置模式不会把管理台公开。</li>
            <li>解封也会清掉登录态，用户要用原来的邀请码或微信重新登录。</li>
          </ul>
          {user !== null ? (
            <div className="result">
              <strong>{user.nickname || user.id}</strong>
              <span>
                {sourceLabel(user.source)} · {user.status === 'banned' ? '已封禁' : '正常'}
              </span>
              <span>最近登录 {formatTime(user.last_login_at)}</span>
              {user.banned_at !== null ? <span>封禁于 {formatTime(user.banned_at)}</span> : null}
              {user.ban_reason !== '' ? <span>原因：{user.ban_reason}</span> : null}
            </div>
          ) : null}
        </aside>
      </div>
    </section>
  );
}
