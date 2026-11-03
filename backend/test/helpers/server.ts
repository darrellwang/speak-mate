/**
 * 测试辅助：HTTP 服务器启动（随机端口，用完释放）+ SSE 帧解析。
 */
import type { Express } from 'express';
import http from 'node:http';

export interface TestServer {
  server: http.Server;
  baseUrl: string;
  close(): Promise<void>;
}

/** 在随机端口启动 Express app（127.0.0.1，避免环境无 IPv6 时 localhost 解析问题） */
export async function startTestServer(app: Express): Promise<TestServer> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    server.close();
    throw new Error('无法获取测试服务器端口');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Node 18.2+：强制断开 keep-alive 残留连接，保证 close() 及时返回
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * 解析一段完整 SSE 响应文本 → 帧数组。
 * 帧格式（与 chat.routes.ts writeEvent 一致）：`event: <name>\ndata: <json>\n\n`
 */
export function parseSseText(raw: string): SseFrame[] {
  const frames: SseFrame[] = [];
  for (const block of raw.split('\n\n')) {
    if (block.trim().length === 0) continue;
    let event = '';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (event === '' || dataLines.length === 0) continue;
    const joined = dataLines.join('\n');
    try {
      frames.push({ event, data: JSON.parse(joined) as unknown });
    } catch {
      frames.push({ event, data: joined });
    }
  }
  return frames;
}

/** 提取指定类型事件的序列（保持原始顺序），便于断言 delta* → meta → done */
export function eventSequence(frames: SseFrame[]): string[] {
  return frames.map((f) => f.event);
}

/** 断言辅助：收集异步生成器的全部事件 */
export async function collectAsyncIterator<T>(iter: AsyncGenerator<T, void, void>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) {
    out.push(item);
  }
  return out;
}
