import { useEffect, useState } from 'react';
import { fetchStats, formatTime, type AdminStats } from '../api';

export function StatsPage() {
  const [data, setData] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStats()
      .then((stats) => {
        if (!cancelled) setData(stats);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) return <p className="form-error">{error}</p>;
  if (data === null) return <p className="muted">正在汇总…</p>;

  const sourceMax = Math.max(data.users.by_source.wechat, data.users.by_source.invite, 1);

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>统计</h1>
          <p>截至 {formatTime(data.generated_at)}。只统计数量，不读取对话内容。</p>
        </div>
      </header>

      <div className="cards">
        <article>
          <span>用户</span>
          <strong>{data.users.total}</strong>
          <small>
            正常 {data.users.active} · 封禁 {data.users.banned}
          </small>
        </article>
        <article>
          <span>会话</span>
          <strong>{data.sessions.total}</strong>
          <small>近 7 天新建 {data.recent.sessions_7d}</small>
        </article>
        <article>
          <span>消息</span>
          <strong>{data.messages.total}</strong>
          <small>近 24 小时 {data.recent.messages_24h}</small>
        </article>
        <article>
          <span>近 7 天</span>
          <strong>{data.recent.new_users_7d}</strong>
          <small>新用户 · 有登录 {data.recent.logins_7d}</small>
        </article>
      </div>

      <div className="panel">
        <h2>来源</h2>
        <SourceBar label="微信" value={data.users.by_source.wechat} max={sourceMax} />
        <SourceBar label="邀请码" value={data.users.by_source.invite} max={sourceMax} />
      </div>
    </section>
  );
}

function SourceBar({ label, value, max }: { label: string; value: number; max: number }) {
  const width = `${Math.round((value / max) * 100)}%`;
  return (
    <div className="bar-row">
      <span>{label}</span>
      <div className="bar" aria-hidden="true">
        <i style={{ width }} />
      </div>
      <strong>{value}</strong>
    </div>
  );
}
