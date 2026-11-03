import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  fetchUsers,
  formatTime,
  sourceLabel,
  type AdminUserList,
  type UserStatus,
} from '../api';

const PAGE_SIZE = 20;

export function UsersPage() {
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<'' | UserStatus>('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AdminUserList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchUsers({ q, status, page, pageSize: PAGE_SIZE })
      .then((list) => {
        if (!cancelled) {
          setData(list);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page, q, status]);

  function onSearch(event: FormEvent) {
    event.preventDefault();
    setPage(1);
    setQ(draft.trim());
  }

  const totalPages = data === null ? 1 : Math.max(1, Math.ceil(data.total / data.page_size));

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>用户</h1>
          <p>按昵称、用户 id 或 openid 查找。这里不展示对话原文。</p>
        </div>
      </header>

      <form className="toolbar" onSubmit={onSearch}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="搜索昵称 / id / openid"
          aria-label="搜索用户"
        />
        <select
          aria-label="状态"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as '' | UserStatus);
            setPage(1);
          }}
        >
          <option value="">全部状态</option>
          <option value="active">正常</option>
          <option value="banned">已封禁</option>
        </select>
        <button type="submit" className="primary">
          搜索
        </button>
      </form>

      {error !== null ? <p className="form-error">{error}</p> : null}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>用户</th>
              <th>来源</th>
              <th>状态</th>
              <th>最近登录</th>
              <th>会话 / 消息</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && data === null ? (
              <tr>
                <td colSpan={6} className="muted">
                  正在加载…
                </td>
              </tr>
            ) : null}
            {data !== null && data.items.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted">
                  没有匹配的用户。
                </td>
              </tr>
            ) : null}
            {data?.items.map((user) => (
              <tr key={user.id}>
                <td>
                  <div className="who">
                    <strong>{user.nickname || '未命名'}</strong>
                    <code>{user.id}</code>
                  </div>
                </td>
                <td>{sourceLabel(user.source)}</td>
                <td>
                  <span className={user.status === 'banned' ? 'pill danger' : 'pill ok'}>
                    {user.status === 'banned' ? '已封禁' : '正常'}
                  </span>
                  {user.ban_reason !== '' ? <div className="reason">{user.ban_reason}</div> : null}
                </td>
                <td>{formatTime(user.last_login_at)}</td>
                <td>
                  {user.session_count} / {user.message_count}
                </td>
                <td className="actions">
                  <Link to={`/security?user=${encodeURIComponent(user.id)}`}>封禁 / 解封</Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="pager">
        <span>
          {data === null ? '' : `共 ${data.total} 人 · 第 ${data.page} / ${totalPages} 页`}
        </span>
        <div>
          <button type="button" className="ghost" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>
            上一页
          </button>
          <button
            type="button"
            className="ghost"
            disabled={data === null || page >= totalPages}
            onClick={() => setPage((n) => n + 1)}
          >
            下一页
          </button>
        </div>
      </div>
    </section>
  );
}
