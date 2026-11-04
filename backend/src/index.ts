/**
 * 启动入口（架构文档 §2 index.ts）：监听端口 + 优雅停机。
 *
 * - 默认仅 HTTP（PORT，默认 3001）；
 * - 配置 HTTPS_KEY_FILE + HTTPS_CERT_FILE（mkcert 自签证书，见 DEPLOYMENT.md 方案A）后，
 *   额外在 HTTPS_PORT（默认 3443）启动 HTTPS 服务——手机浏览器的 Web Speech API
 *   麦克风要求「安全上下文」，局域网必须走 https:// 才能授权麦克风；
 * - 注意：日志中绝不输出 LLM_API_KEY（P0-11）。
 */

import { existsSync, readFileSync } from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { config } from './config/env';
import { createApp } from './app';
import { closeDb } from './db/database';
import { warmupLocalTts } from './services/tts.service';

/** 优雅停机需要关闭的服务（http/https Server 结构化兼容类型） */
interface ClosableServer {
  close(callback?: (err?: Error) => void): unknown;
}

const app = createApp();
const servers: ClosableServer[] = [];

const server = app.listen(config.port, () => {
  console.log(`\n[${config.appName}] backend is running at http://localhost:${config.port}`);
  console.log(`  LLM provider : ${config.llm.provider} (model: ${config.llm.model})`);
  if (!config.security.adminEnabled) {
    console.warn('  admin login  : 已关闭（未设置 ADMIN_PASSWORD）');
  } else if (config.security.adminUsingDevDefault) {
    console.warn('  admin login  : 本地开发默认口令（生产环境必须设置 ADMIN_PASSWORD）');
  } else {
    console.log(`  admin login  : 用户名 ${config.security.adminUsername}`);
  }
  console.log(`  data dir     : ${path.resolve(config.dataDir)}`);
  if (config.llm.provider === 'mock') {
    console.log('  NOTE         : mock 模式 —— 不调用真实 LLM，返回内置模拟数据（仅供前端联调）\n');
  } else {
    console.log(`  LLM endpoint : ${config.llm.baseURL}\n`);
  }
});
servers.push(server);

// ---- 本地 TTS 预热 ----
// 后台加载 Kokoro 模型（约 0.6s），避免首个 TTS 请求干等 1~2s。
// 放后台执行，不阻塞端口监听（服务可用性优先于模型就绪）。
warmupLocalTts();

// ---- 可选 HTTPS 服务（手机麦克风安全上下文，DEPLOYMENT.md 方案A） ----
const httpsEnabled = config.https.keyFile !== '' && config.https.certFile !== '';
if (httpsEnabled) {
  const keyExists = existsSync(config.https.keyFile);
  const certExists = existsSync(config.https.certFile);
  if (!keyExists || !certExists) {
    console.warn(
      `[https] 证书文件不存在，HTTPS 未启动（key=${config.https.keyFile} 存在=${keyExists}，` +
        `cert=${config.https.certFile} 存在=${certExists}）`,
    );
  } else {
    const httpsServer = https.createServer(
      {
        key: readFileSync(config.https.keyFile),
        cert: readFileSync(config.https.certFile),
      },
      app,
    );
    httpsServer.listen(config.https.port, () => {
      console.log(`[${config.appName}] https is running at https://<本机IP>:${config.https.port}`);
      console.log('  手机（同局域网）请访问上述 HTTPS 地址——麦克风语音识别需要安全上下文\n');
    });
    servers.push(httpsServer);
  }
}

/** 停机是否已开始（SIGINT/SIGTERM 重复触发时只执行一次） */
let shuttingDown = false;

/**
 * 优雅停机：先停止接收新连接 → 等待在途请求结束 → 关闭 SQLite → 退出。
 *
 * 关闭数据库（审查报告 L6）：WAL 模式下依赖进程退出回收连接并不可靠
 * （强杀 / 容器 OOM 时可能残留 -wal 文件与未 checkpoint 的页），显式 close 更稳。
 */
function shutdown(): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n[${config.appName}] shutting down...`);

  let exited = false;
  const finish = (): void => {
    if (exited) {
      return;
    }
    exited = true;
    try {
      closeDb();
    } catch (err) {
      console.warn('[db] 关闭连接失败:', err instanceof Error ? err.message : String(err));
    }
    process.exit(0);
  };

  let pending = servers.length;
  if (pending === 0) {
    finish();
    return;
  }
  for (const s of servers) {
    s.close(() => {
      pending -= 1;
      if (pending <= 0) {
        finish();
      }
    });
  }
  // 兜底：3s 内未完成关闭则强制退出
  setTimeout(finish, 3_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
