/**
 * 运行时配置默认值（config.ts）
 *
 * 配置来源优先级（高 → 低）：
 * 1) 小程序 Storage（设置页写入）
 * 2) 本机 `config.local.ts`（gitignore，不入库；从 config.example.ts 复制）
 * 3) 下方占位默认值（仅本机开发；请勿把真实生产域名写进本文件）
 */

export type SpeechEngine = 'text-only' | 'wechat-si';

export interface Settings {
  /** 后端基址（不含结尾斜杠） */
  baseUrl: string;
  /** AI 回复是否自动朗读（需语音引擎支持） */
  ttsEnabled: boolean;
  /** 语速 0.5–2.0 */
  ttsRate: number;
  /** 朗读音色（Edge TTS 神经网络音色 id，列表由 /api/config 下发） */
  ttsVoice: string;
  /** 语音引擎（默认纯文字，插件未添加时强制回落该值） */
  speechEngine: SpeechEngine;
  /** 是否开启逐字流式渲染（基础库不支持时自动关闭） */
  streamingEnabled: boolean;
}

/**
 * 读取本机覆盖（config.local.ts）。
 * 文件不存在时回落占位；真实生产 URL 只放 local，勿提交。
 */
function readLocalBaseUrl(): string | undefined {
  try {
    // 拼接路径降低部分打包器对缺失模块的静态分析误报；文件缺失则 catch。
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const local = require('./config' + '.local') as {
      LOCAL_DEFAULT_BASE_URL?: string;
    };
    const v = local.LOCAL_DEFAULT_BASE_URL;
    if (typeof v !== 'string') return undefined;
    const trimmed = v.trim().replace(/\/+$/, '');
    return trimmed || undefined;
  } catch {
    return undefined;
  }
}

/** 本机开发占位；生产请在 config.local.ts 覆盖 */
export const DEFAULT_BASE_URL =
  readLocalBaseUrl() ?? 'http://127.0.0.1:3001';

/**
 * 访问令牌（ACCESS_TOKEN）不在此文件存放。
 * 管理员令牌由设置页录入，存 Storage（见 utils/storage.ts）。
 */

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: DEFAULT_BASE_URL,
  ttsEnabled: true,
  ttsRate: 1,
  ttsVoice: 'en-US-JennyNeural',
  speechEngine: 'text-only',
  streamingEnabled: true,
};

/** 网络超时（毫秒）：LLM 首字可能较慢，给足 30s */
export const REQUEST_TIMEOUT = 30000;

/** 流式首个分片等待上限：超时未收到首块 → 判定网关缓冲，降级为非流式 */
export const STREAM_FIRST_CHUNK_TIMEOUT = 8000;
