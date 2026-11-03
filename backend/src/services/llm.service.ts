/**
 * 自研 OpenAI 兼容 LLM 客户端（架构文档 §1.2、§2 services/llm.service.ts）
 *
 * - 原生 fetch 零依赖：DeepSeek / 通义千问 / OpenAI / LMStudio 四端点 100% 兼容，
 *   配置切换零代码改动（P0-10）；
 * - streamChat()：流式（SSE 协议逐 chunk 转发原始 delta），首字 15s 超时（3002）、总时长 120s；
 * - completeText()：非流式全文（词条生成 / 延续开场白）；
 * - completeJSON()：非流式 + JSON 提取（容错清洗复用 parser.ts）；
 * - qwen/lmstudio 默认附加 chat_template_kwargs.enable_thinking=false；
 * - Key 只进请求头，绝不出现在日志与错误信息中（P0-11）。
 */

import { config } from '../config/env';
import type { LlmProvider } from '../config/env';
import { ErrorCode, ApiError, llmConnectError, llmTimeoutError } from '../middleware/error';
import { extractJsonPayload } from './parser';
import { MockLlmClient } from './mock.provider';
import { OllamaNativeClient } from './ollama.client';

/* ---------- 对外类型 ---------- */

export interface LlmChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCallOptions {
  temperature?: number;
  maxTokens?: number;
  /** 首字超时（仅流式），默认 15s */
  firstTokenTimeoutMs?: number;
  /** 请求总超时，流式默认 120s，非流式默认 20s */
  totalTimeoutMs?: number;
  /** 外部中断信号（客户端断开 SSE 时中止 LLM 请求） */
  signal?: AbortSignal;
}

export interface LlmClient {
  readonly provider: string;
  readonly model: string;
  /** 流式对话：逐 chunk yield 原始 delta 文本 */
  streamChat(messages: LlmChatMessage[], opts?: LlmCallOptions): AsyncGenerator<string, void, void>;
  /** 非流式补全：返回完整文本 */
  completeText(messages: LlmChatMessage[], opts?: LlmCallOptions): Promise<string>;
  /** 非流式 + JSON 提取：返回解析后的对象；解析失败抛 3003 */
  completeJSON<T = unknown>(messages: LlmChatMessage[], opts?: LlmCallOptions): Promise<T>;
}

export const DEFAULT_FIRST_TOKEN_TIMEOUT_MS = 15_000;
export const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = 120_000;
export const DEFAULT_COMPLETE_TOTAL_TIMEOUT_MS = 20_000;

/**
 * max_tokens 下限兜底。
 *
 * 背景：Ollama 的 OpenAI 兼容端点（/v1）**不支持**关闭 thinking——
 * 无论传 `think:false` 还是 `chat_template_kwargs.enable_thinking` 都不生效，
 * 思考过程始终先输出到 `reasoning` 字段，并且**占用同一份 max_tokens 配额**。
 * 若 max_tokens 偏小，额度会被思考吃光，正文被截断
 * （现象：finish_reason="length"，content 为空字符串 → 前端收到空回复）。
 *
 * 注：Ollama 现已改走原生 /api/chat 端点（OllamaNativeClient），
 * 该端点 think:false 生效、思考不占正文配额，因此不再需要额外抬高下限。
 * 保留这张表是为了将来有人把 Ollama 切回 /v1 时仍有兜底。
 */
const MAX_TOKENS_FLOOR_BY_PROVIDER: Partial<Record<LlmProvider, number>> = {};

/** 按 provider 计算实际的 max_tokens（不小于调用方指定值与 provider 下限中的较大者） */
function resolveMaxTokens(requested: number | undefined, provider: LlmProvider): number {
  const base = requested ?? 500;
  const floor = MAX_TOKENS_FLOOR_BY_PROVIDER[provider] ?? 0;
  return Math.max(base, floor);
}

/* ---------- 工厂与全局单例 ---------- */

// 工厂函数与 llmClient 单例定义在文件末尾（OpenAiCompatClient 类定义之后），
// 避免「类在工厂函数之后声明」导致的暂时性死区（TDZ）错误：
//   ReferenceError: Cannot access 'OpenAiCompatClient' before initialization

/* ============================================================
 * OpenAI 兼容实现（真实 provider）
 * ============================================================ */

class OpenAiCompatClient implements LlmClient {
  readonly provider = config.llm.provider;
  readonly model = config.llm.model;

  private buildBody(
    messages: LlmChatMessage[],
    opts: LlmCallOptions,
    stream: boolean,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream,
      temperature: opts.temperature ?? 0.7,
      // max_tokens 走 provider 下限兜底（ollama 的 thinking 会吃掉配额，见 resolveMaxTokens）
      max_tokens: resolveMaxTokens(opts.maxTokens, config.llm.provider),
    };
    if (config.llm.attachDisableThinking) {
      // qwen3 系模型关闭思考块输出（LLM_ENABLE_THINKING=true 时不附加）
      body.chat_template_kwargs = { enable_thinking: false };
    }
    return body;
  }

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.llm.apiKey}`,
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
        res = await fetch(`${config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(this.buildBody(messages, opts, true)),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.translateConnectError(err);
      }

      if (!res.ok) {
        const hint = res.status === 401 ? '（API Key 可能无效或过期）' : '';
        throw llmConnectError(this.withProviderHint(`LLM 服务响应异常（HTTP ${res.status}）${hint}`));
      }
      if (!res.body) {
        throw llmConnectError(this.withProviderHint('LLM 服务未返回响应体'));
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        sseBuffer += decoder.decode(value, { stream: true });
        // SSE 按行分帧：`data: {...}`
        let nl = sseBuffer.indexOf('\n');
        while (nl !== -1) {
          const line = sseBuffer.slice(0, nl).trim();
          sseBuffer = sseBuffer.slice(nl + 1);
          nl = sseBuffer.indexOf('\n');
          if (!line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            return;
          }
          let delta: unknown;
          try {
            delta = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: unknown } }>;
            };
          } catch {
            continue; // 单行损坏不中断整流
          }
          const content = (delta as { choices?: Array<{ delta?: { content?: unknown } }> })
            ?.choices?.[0]?.delta?.content;
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
        res = await fetch(`${config.llm.baseURL}/chat/completions`, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: JSON.stringify(this.buildBody(messages, opts, false)),
          signal: controller.signal,
        });
      } catch (err) {
        throw this.translateConnectError(err);
      }
      if (!res.ok) {
        const hint = res.status === 401 ? '（API Key 可能无效或过期）' : '';
        throw llmConnectError(this.withProviderHint(`LLM 服务响应异常（HTTP ${res.status}）${hint}`));
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
      };
      const content = json.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw llmConnectError(this.withProviderHint('LLM 返回内容为空'));
      }
      return content;
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
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

  /* ---------- 错误转译（脱敏：不含 API Key） ---------- */

  private translateConnectError(err: unknown): ApiError {
    const raw = err instanceof Error ? err.message : String(err);
    let detail = raw;
    const cause = (err as { cause?: { code?: string } } | undefined)?.cause;
    if (cause && typeof cause.code === 'string') {
      detail = `${raw}（${cause.code}）`;
    }
    return llmConnectError(this.withProviderHint(`LLM 连接失败：${detail}`));
  }

  private translateStreamError(err: unknown, firstTokenSeen: boolean, external?: AbortSignal): Error {
    const msg = err instanceof Error ? err.message : String(err);
    if (external?.aborted || msg.includes('CLIENT_ABORTED')) {
      // 客户端主动断开：返回哨兵错误，调用方（chat.service）静默结束
      return new Error('CLIENT_ABORTED');
    }
    if (err instanceof ApiError) {
      return err;
    }
    if (!firstTokenSeen && (msg.includes('FIRST_TOKEN_TIMEOUT') || msg === 'AbortError')) {
      return llmTimeoutError('LLM 响应超时（首字 15s 未返回），请检查网络或模型服务状态后重试');
    }
    if (msg.includes('TOTAL_TIMEOUT')) {
      return llmConnectError(this.withProviderHint('LLM 请求总时长超时（120s），本轮对话已中断'));
    }
    return this.translateConnectError(err);
  }

  /** 本地 LLM 模式附带排查指引文案（架构 §4.1 3001） */
  private withProviderHint(message: string): string {
    if (config.llm.provider === 'lmstudio') {
      return `${message}。请检查 LMStudio：① 应用已启动且模型已加载；② Developer → Start Server 已开启（默认端口 1234）；③ LLM_BASE_URL 配置正确（当前 ${config.llm.baseURL}）`;
    }
    if (config.llm.provider === 'ollama') {
      return `${message}。请检查 Ollama：① 服务已启动（ollama serve，默认端口 11434）；② 模型已拉取（ollama list，当前配置 ${config.llm.model}）；③ LLM_BASE_URL 配置正确（当前 ${config.llm.baseURL}）`;
    }
    return message;
  }
}

/* ============================================================
 * 工厂与全局单例（必须在类定义之后，避免 TDZ）
 * ============================================================ */

export function createLlmClient(): LlmClient {
  if (config.llm.provider === 'mock') {
    return new MockLlmClient(config.llm.model);
  }
  // Ollama 走原生 /api/chat 端点：其 /v1 兼容层无法关闭 thinking，
  // 会导致首字延迟飙高（实测 10.55s）并挤占 max_tokens 配额。
  if (config.llm.provider === 'ollama') {
    return new OllamaNativeClient();
  }
  return new OpenAiCompatClient();
}

/** 全局单例（provider 在进程启动时由 .env 确定，运行期不变） */
export const llmClient: LlmClient = createLlmClient();
