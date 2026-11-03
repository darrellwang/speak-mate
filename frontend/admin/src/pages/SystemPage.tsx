import { useEffect, useState } from 'react';
import { fetchHealth, formatUptime, type AdminHealth } from '../api';

export function SystemPage() {
  const [data, setData] = useState<AdminHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHealth()
      .then((health) => {
        if (!cancelled) setData(health);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : '加载失败');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error !== null) return <p className="form-error">{error}</p>;
  if (data === null) return <p className="muted">正在检查…</p>;

  const schemaMatch = data.schema.user_version === data.schema.version;

  return (
    <section>
      <header className="page-head">
        <div>
          <h1>系统</h1>
          <p>本地探测：数据库、进程、schema、TTS 内存状态。不会调用 LLM。</p>
        </div>
        <span className={data.status === 'ok' ? 'pill ok' : 'pill warn'}>
          {data.status === 'ok' ? '正常' : '降级'}
        </span>
      </header>

      <div className="kv">
        <Row label="数据库" value={data.db === 'ok' ? '可连接' : '不可用'} />
        <Row label="运行时间" value={formatUptime(data.uptime_seconds)} />
        <Row label="Node" value={data.node} />
        <Row
          label="Schema"
          value={
            schemaMatch
              ? `v${data.schema.version}`
              : `程序 v${data.schema.version} / 库 ${data.schema.user_version ?? '未知'}`
          }
        />
        <Row label="LLM" value={`${data.llm.provider} · ${data.llm.model}`} />
        <Row label="LLM Key" value={data.llm.key_present ? '已配置' : '未配置或为本地占位'} />
        <Row label="LLM 探测" value={data.llm.probed ? '已外呼' : '未外呼'} />
        <Row label="TTS 模式" value={data.tts.mode} />
        <Row
          label="本地 TTS"
          value={data.tts.local.error ? `${data.tts.local.status}（${data.tts.local.error}）` : data.tts.local.status}
        />
        <Row label="模型目录" value={data.tts.local.modelDir} />
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
