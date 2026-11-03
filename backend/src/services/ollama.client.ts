/**
 * Ollama 原生端点客户端（services/ollama.client.ts）
 *
 * ── 为什么不复用 OpenAI 兼容实现 ──
 * Ollama 的 /v1 兼容层**无法关闭 thinking**：传 `think:false` 或
 * `chat_template_kwargs.enable_thinking` 均不生效，思考过程始终先输出到
 * `reasoning` 字段并占用 max_tokens 配额。实测（qwen3.6:35b，真实对话 prompt）：
 *   - /v1 端点：首个 content 延迟 10.55s，reasoning 753 块 / content 仅 43 块
 *     → 逼近本项目 15s 首字超时阈值，表现为「LLM 响应超时（首字 15s 未返回）」；
 *   - /api/chat 原生端点 + think:false：首个 content 延迟 **0.11s**，思考长度 0。
 *
 * 因此 Ollama 走原生端点：响应格式是 NDJSON（每行一个 JSON 对象，非 SSE），
 * 字段为 { message: { content, thinking }, done }。
 *
 * ── 与其他 provider 的差异 ──
 * - 不需要 Authorization 头（本地服务无鉴权；带上也无妨，Ollama 忽略）
 * - max_tokens 放在 options.num_predict
 * - 温度放在 options.temperature
 * - 思考内容在 message.thinking（原生端点才有，/v1 叫 reasoning）
 */

import { config } from '../config/env';
import { ErrorCode, ApiError, llmConnectError, llmTimeoutError } from '../middleware/error';
import { extractJsonPayload } from './parser';
import type { LlmCallOptions, LlmChatMessage, LlmClient } from './llm.service';

export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 15_000;
export const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_COMPLETE_TOTAL_TIMEOUT_MS = 20_000;

/** Ollama 原生端点地址（由 LLM_BASE_URL 的 /v1 后缀推导） */
function nativeEndpoint(): string {
  const base = config.llm.baseURL.replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base.slice(0, -3)}/api/chat` : `${base}/api/chat`;
}

/** 原生端点的流式响应行 → { content, thinking } */
interface OllamaChunk {
  message?: { content?: unknown; thinking?: unknown };
  done?: boolean;
}

export class OllamaNativeClient implements LlmClient {
  readonly provider = config.llm.provider;
  readonly model = config.llm.model;

  private buildBody(
    messages: LlmChatMessage[],
    opts: LlmCallOptions,
    stream: boolean,
  ): Record<string, unknown> {
    return {
      model: this.model,
      messages,
      stream,
      // think:false —— 原生端点唯一能真正关闭思考的方式
      think: false,
      options: {
        temperature: opts.temperature ?? 0.7,
        num_predict: opts.maxTokens ?? 500,
      },
    };
  }

  async *streamChat(
    messages: LlmChatMessage[],
    opts: LlmCallOptions = {},
  ): AsyncGenerator<string, void, void> {
    const firstTokenTimeoutMs = opts.firstTokenTimeoutMs ?? DEFAULT_FIRST_TOKEN_TIMEOUT_MS;
    const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_STREAM_TOTAL_TIMEOUT_MS;

    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(new Error('CLIENT_ABORTED'));
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

    let firstTokenSeen = false;
    const firstTokenTimer = setTimeout(
      () => controller.abort(new Error('FIRST_TOKEN_TIMEOUT')),
      firstTokenTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => controller.abort(new Error('TOTAL_TIMEOUT')),
      totalTimeoutMs,
    );

    try {
      let res: Response;
      try {
        res = await fetch(nativeEndpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.buildBody(messages, opts, true)),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.translateConnectError(err);
      }

      if (!res.ok) {
        throw llmConnectError(
          `LLM 服务响应异常（HTTP ${res.status}）。请检查 Ollama：① 服务已启动（ollama serve，默认端口 11434）；② 模型已拉取（当前配置 ${config.llm.model}）`,
        );
      }
      if (!res.body) {
        throw llmConnectError('LLM 服务未返回响应体');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // 原生端点是 NDJSON：每行一个 JSON 对象
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (line === '') continue;

          let chunk: OllamaChunk;
          try {
            chunk = JSON.parse(line) as OllamaChunk;
          } catch {
            continue; // 单行损坏不中断整流
          }
          const content = chunk.message?.content;
          if (typeof content === 'string' && content.length > 0) {
            if (!firstTokenSeen) {
              firstTokenSeen = true;
              clearTimeout(firstTokenTimer);
            }
            yield content;
          }
        }
      }
    } catch (err) {
      throw this.translateStreamError(err, firstTokenSeen, opts.signal);
    } finally {
      clearTimeout(firstTokenTimer);
      clearTimeout(totalTimer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async completeText(messages: LlmChatMessage[], opts: LlmCallOptions = {}): Promise<string> {
    const totalTimeoutMs = opts.totalTimeoutMs ?? DEFAULT_COMPLETE_TOTAL_TIMEOUT_MS;
    const controller = new AbortController();
    const onExternalAbort = (): void => controller.abort(new Error('CLIENT_ABORTED'));
    opts.signal?.addEventListener('abort', onExternalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('TOTAL_TIMEOUT')), totalTimeoutMs);

    try {
      let res: Response;
      try {
        res = await fetch(nativeEndpoint(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.buildBody(messages, opts, false)),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.translateConnectError(err);
      }
      if (!res.ok) {
        throw llmConnectError(
          `LLM 服务响应异常（HTTP ${res.status}）。请检查 Ollama 服务与模型：${config.llm.model}`,
        );
      }
      const json = (await res.json()) as { message?: { content?: unknown } };
      const content = json.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw llmConnectError('LLM 返回内容为空');
      }
      return content;
    } catch (err) {
      if (err instanceof ApiError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('TOTAL_TIMEOUT')) {
        throw llmTimeoutError('LLM 请求超时，请稍后重试');
      }
      throw this.translateConnectError(err);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  async completeJSON<T = unknown>(
    messages: LlmChatMessage[],
    opts: LlmCallOptions = {},
  ): Promise<T> {
    const text = await this.completeText(messages, opts);
    const parsed = extractJsonPayload(text);
    if (parsed === null || typeof parsed !== 'object') {
      throw new ApiError(502, ErrorCode.LLM_PARSE, 'LLM 输出解析失败，请重试');
    }
    return parsed as T;
  }

  /* ---------- 错误转译（脱敏） ---------- */

  private translateConnectError(err: unknown): ApiError {
    const raw = err instanceof Error ? err.message : String(err);
    let detail = raw;
    const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
    if (cause && typeof cause.code === 'string') {
      detail = `${raw}（${cause.code}）`;
    }
    return llmConnectError(
      `LLM 连接失败：${detail}。请检查 Ollama：① 服务已启动（ollama serve，默认端口 11434）；② 模型已拉取（ollama list，当前配置 ${config.llm.model}）`,
    );
  }

  private translateStreamError(err: unknown, firstTokenSeen: boolean, external?: AbortSignal): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (external?.aborted || msg.includes('CLIENT_ABORTED')) {
      return new Error('CLIENT_ABORTED');
    }
    if (err instanceof ApiError) return err;
    if (!firstTokenSeen && (msg.includes('FIRST_TOKEN_TIMEOUT') || msg === 'AbortError')) {
      return llmTimeoutError('LLM 响应超时（首字 15s 未返回），请检查模型是否已加载或改用更小的模型');
    }
    if (msg.includes('TOTAL_TIMEOUT')) {
      return llmConnectError('LLM 请求总时长超时（120s），本轮对话已中断');
    }
    return this.translateConnectError(err);
  }
}
