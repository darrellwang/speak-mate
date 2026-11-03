/**
 * 环境变量加载与校验 + LLM provider 预设解析（架构文档 §2 config/env.ts、§9.15）
 *
 * - dotenv 在本模块顶部加载，任何模块使用环境变量前必然先 import 本模块；
 * - provider 预设：deepseek / qwen / openai / lmstudio / mock（默认 mock，无 Key 时不误调真实端点）；
 * - 覆盖顺序：LLM_BASE_URL 显式配置 > 预设；
 * - qwen / lmstudio 默认附加 chat_template_kwargs.enable_thinking=false（LLM_ENABLE_THINKING=true 可开启）。
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';

/**
 * 默认数据目录：相对本模块文件解析（<backend>/data），而非 process.cwd()。
 * 避免从仓库根目录启动时把数据库建到非预期位置，导致「按文档备份却备份了个寂寞」。
 */
const DEFAULT_DATA_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data',
);

/** 读取 backend/package.json 的版本号（读取失败时回退固定值，绝不因元数据问题阻断启动） */
function readPackageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : '1.0.0';
  } catch {
    return '1.0.0';
  }
}

export type LlmProvider = 'mock' | 'deepseek' | 'qwen' | 'openai' | 'lmstudio' | 'ollama';

/**
 * TTS 引擎模式。
 *
 * - local：只用本地 Kokoro（离线），失败直接报错；
 * - edge ：只用在线 Edge TTS（微软公共端点）；
 * - auto ：本地优先，失败/不可用时自动回退 Edge TTS（默认，保证播报不中断）。
 */
export type TtsEngineMode = 'local' | 'edge' | 'auto';

export interface TtsConfig {
  /** 引擎模式 */
  engine: TtsEngineMode;
  /**
   * 本地模型根目录：其下需存在 <org>/<repo>/ 结构（如
   * models/onnx-community/Kokoro-82M-v1.0-ONNX/）。
   */
  modelDir: string;
  /**
   * ffmpeg 可执行文件路径。用于把本地合成的 PCM 转成 mp3
   * （微信 InnerAudioContext 对 mp3 兼容性最好，与原在线方案一致）。
   * 留空则按 'ffmpeg' 走系统 PATH；找不到时本地引擎不可用，自动回退 Edge TTS。
   */
  ffmpegPath: string;
}

interface ProviderPreset {
  readonly baseURL: string;
  readonly model: string;
  /** 非 mock/lmstudio 时缺少 LLM_API_KEY 需要启动警告 */
  readonly requiresApiKey: boolean;
  /** 是否默认关闭 qwen3 思考块输出（附加 enable_thinking:false） */
  readonly disableThinkingByDefault: boolean;
}

const PROVIDER_PRESETS: Readonly<Record<LlmProvider, ProviderPreset>> = {
  mock: {
    baseURL: '',
    model: 'mock-english-coach',
    requiresApiKey: false,
    disableThinkingByDefault: false,
  },
  deepseek: {
    baseURL: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    requiresApiKey: true,
    disableThinkingByDefault: false,
  },
  qwen: {
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    requiresApiKey: true,
    disableThinkingByDefault: true,
  },
  openai: {
    baseURL: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    requiresApiKey: true,
    disableThinkingByDefault: false,
  },
  lmstudio: {
    baseURL: 'http://localhost:1234/v1',
    model: 'qwen3.6-35b-a3b',
    requiresApiKey: false,
    disableThinkingByDefault: true,
  },
  /**
   * Ollama：走**原生**端点 /api/chat（由 llm.service.ts 的 OllamaNativeClient 推导）。
   *
   * ⚠️ 不用 /v1 兼容层的原因：Ollama 的 /v1 **无法关闭 thinking**
   * （传 think:false 或 chat_template_kwargs.enable_thinking 均不生效），
   * 思考过程先输出到 reasoning 字段并占用 max_tokens 配额。
   * 实测（qwen3.6:35b + 真实对话 prompt）：
   *   - /v1：首个 content 延迟 10.55s → 逼近 15s 首字超时阈值，表现为「响应超时」；
   *   - /api/chat + think:false：首个 content 延迟 0.11s，思考长度 0。
   *
   * 这里的 baseURL 仍写 /v1 形式：OllamaNativeClient 会据此推导 /api/chat，
   * 同时保持与其他 provider 的「OpenAI 兼容地址」书写习惯一致。
   */
  ollama: {
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen3.6:35b',
    requiresApiKey: false,
    // Ollama 通过原生端点的 think:false 关闭思考，不走 chat_template_kwargs 路径
    disableThinkingByDefault: false,
  },
};

export interface LlmConfig {
  provider: LlmProvider;
  baseURL: string;
  /** 仅后端内存持有，绝不写入日志或响应（P0-11） */
  apiKey: string;
  model: string;
  /** 请求体是否附加 chat_template_kwargs: { enable_thinking: false } */
  attachDisableThinking: boolean;
}

export interface AppConfig {
  port: number;
  appName: string;
  dataDir: string;
  version: string;
  llm: LlmConfig;
  /** 语音合成引擎（本地 Kokoro / 在线 Edge TTS） */
  tts: TtsConfig;
  /** 可选 HTTPS 服务（局域网手机麦克风的安全上下文要求，见 DEPLOYMENT.md 方案A） */
  https: {
    /** 私钥文件路径（与 certFile 同时非空才启用） */
    keyFile: string;
    /** 证书文件路径 */
    certFile: string;
    /** HTTPS 监听端口，默认 3443 */
    port: number;
  };
  /** 访问控制（见 middleware/auth.ts） */
  security: {
    /**
     * 访问令牌：非空时 /api/* 全部要求鉴权，且**只接受** `Authorization: Bearer <token>`。
     * 刻意不接受 URL query 参数传令牌（?token=...）——那会进入 access log、浏览器历史与 Referer。
     * 留空 = 不启用鉴权，仅适用于局域网/本机部署。
     *
     * ⚠️ 多用户模式（P2-5）语义变更：该令牌现在是**管理员凭证**，
     * 请求带此令牌会被识别为 admin 用户；普通用户走 /api/auth/* 换取的登录态 token。
     * 管理台（/api/admin、/admin）只接受这一枚令牌，不接受邀请码换到的登录态。
     */
    accessToken: string;
    /**
     * CORS 允许的来源列表（逗号分隔的精确 origin，如 https://a.com,https://b.com）。
     * 留空 = 同源部署，不发送任何 CORS 响应头（最严格）。
     * 注意：绝不可配置为 '*'——那等价于对全网开放读写。
     */
    corsOrigins: readonly string[];
    /**
     * 微信小程序 AppID / AppSecret（小程序端 wx.login 静默登录用）。
     *
     * AppSecret 只存在于后端内存与 .env，**绝不下发前端、绝不写入日志**。
     * 未配置时小程序端无法登录，仅管理员令牌可用。
     */
    wechatAppId: string;
    wechatAppSecret: string;
    /**
     * 邀请码列表（逗号分隔）：主人用于登录 / 发放给受邀用户。
     * 邀请码是"谁能进这个应用"的门禁，登录后换取自己的登录态 token。
     */
    inviteCodes: readonly string[];
  };
}

/**
 * 管理员账号 id（P2-5 多用户）。
 *
 * 存量数据的归属方：migration v3 把历史 user_id='default' 的数据统一重命名为 'admin'，
 * 因此这个常量有两个作用——① 标识管理员身份；② 与迁移后的存量数据对齐。
 */
export const ADMIN_USER_ID = 'admin';

/**
 * @deprecated P2-5 多用户改造后不再使用。保留仅为向后兼容：
 * 迁移 v3 已把 user_id='default' 的存量数据重命名为 ADMIN_USER_ID，
 * 新代码一律通过 req.userId 取用户标识。请勿在新代码中引用。
 */
export const DEFAULT_USER_ID = 'default';

function parseProvider(raw: string | undefined): LlmProvider {
  const value = (raw ?? 'mock').trim().toLowerCase();
  if (value in PROVIDER_PRESETS) {
    return value as LlmProvider;
  }
  throw new Error(
    `[config] LLM_PROVIDER 非法："${raw ?? '(空)'}"（可选：mock / deepseek / qwen / openai / lmstudio / ollama）`,
  );
}

function loadConfig(): AppConfig {
  const provider = parseProvider(process.env.LLM_PROVIDER);
  const preset = PROVIDER_PRESETS[provider];

  const baseURL = (process.env.LLM_BASE_URL ?? '').trim() || preset.baseURL;
  // mock 是零依赖联调模式，模型名无实际意义——**强制用预设值**，
  // 否则 .env 里为真实 provider 配的 LLM_MODEL（如 ollama 的 qwen3.6:35b）
  // 会串到 mock 上，让 /api/health 与 /api/config 暴露错误的模型名。
  const model =
    provider === 'mock'
      ? preset.model
      : (process.env.LLM_MODEL ?? '').trim() || preset.model;
  // mock / lmstudio / ollama 无需真实 Key，给占位符保证请求头格式完整
  const apiKey =
    (process.env.LLM_API_KEY ?? '').trim() ||
    (provider === 'mock' || provider === 'lmstudio' || provider === 'ollama'
      ? 'not-needed'
      : '');

  const enableThinking =
    String(process.env.LLM_ENABLE_THINKING ?? 'false').trim().toLowerCase() === 'true';

  const portRaw = Number(process.env.PORT ?? 3001);
  if (!Number.isInteger(portRaw) || portRaw < 1 || portRaw > 65535) {
    throw new Error(`[config] PORT 非法：${String(process.env.PORT)}`);
  }

  // ---- 可选 HTTPS（mkcert 自签证书，详见 DEPLOYMENT.md 方案A） ----
  const httpsKeyFile = (process.env.HTTPS_KEY_FILE ?? '').trim();
  const httpsCertFile = (process.env.HTTPS_CERT_FILE ?? '').trim();
  if ((httpsKeyFile === '') !== (httpsCertFile === '')) {
    console.warn(
      '[config] 警告：HTTPS_KEY_FILE 与 HTTPS_CERT_FILE 必须同时配置，当前仅配置其一——HTTPS 不启用',
    );
  }
  const httpsPortRaw = Number(process.env.HTTPS_PORT ?? 3443);
  if (!Number.isInteger(httpsPortRaw) || httpsPortRaw < 1 || httpsPortRaw > 65535) {
    throw new Error(`[config] HTTPS_PORT 非法：${String(process.env.HTTPS_PORT)}`);
  }

  if (preset.requiresApiKey && !apiKey) {
    console.warn(
      `[config] 警告：LLM_PROVIDER=${provider} 需要 LLM_API_KEY，当前未配置——对话请求将返回 3001 错误`,
    );
  }

  // ---- 访问控制 ----
  const accessToken = (process.env.ACCESS_TOKEN ?? '').trim();
  const corsOrigins = (process.env.CORS_ORIGIN ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // '*' 等价于对全网开放读写，属配置错误：直接忽略并回落到同源策略
  const wildcardIndex = corsOrigins.indexOf('*');
  if (wildcardIndex !== -1) {
    console.warn(
      '[config] 警告：CORS_ORIGIN 不允许配置为 "*"（等价于对任意站点开放读写），已忽略该项',
    );
    corsOrigins.splice(wildcardIndex, 1);
  }
  // 公网部署建议：启用了 CORS 白名单却没配令牌 → 提示风险
  if (corsOrigins.length > 0 && !accessToken) {
    console.warn(
      '[config] 警告：已配置 CORS_ORIGIN 但未配置 ACCESS_TOKEN——任何来源的站点都可读写数据，建议同时设置 ACCESS_TOKEN',
    );
  }

  // ---- 微信小程序登录（P2-5）----
  const wechatAppId = (process.env.WECHAT_APP_ID ?? '').trim();
  const wechatAppSecret = (process.env.WECHAT_APP_SECRET ?? '').trim();
  if ((wechatAppId === '') !== (wechatAppSecret === '')) {
    console.warn(
      '[config] 警告：WECHAT_APP_ID 与 WECHAT_APP_SECRET 必须同时配置，当前仅配置其一——小程序端将无法登录',
    );
  }

  // ---- 邀请码（P2-5）----
  const inviteCodes = (process.env.INVITE_CODES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  // ---- TTS 引擎 ----
  const ttsEngineRaw = (process.env.TTS_ENGINE ?? 'auto').trim().toLowerCase();
  if (!['local', 'edge', 'auto'].includes(ttsEngineRaw)) {
    throw new Error(
      `[config] TTS_ENGINE 非法："${process.env.TTS_ENGINE ?? '(空)'}"（可选：local / edge / auto）`,
    );
  }
  const ttsEngine = ttsEngineRaw as TtsEngineMode;
  const ttsModelDir =
    (process.env.TTS_MODEL_DIR ?? '').trim() ||
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../models');
  const ttsFfmpegPath = (process.env.FFMPEG_PATH ?? '').trim() || 'ffmpeg';

  return {
    port: portRaw,
    appName: (process.env.APP_NAME ?? 'SpeakMate').trim() || 'SpeakMate',
    dataDir: (process.env.DATA_DIR ?? '').trim() || DEFAULT_DATA_DIR,
    version: readPackageVersion(),
    llm: {
      provider,
      baseURL,
      apiKey,
      model,
      attachDisableThinking: preset.disableThinkingByDefault && !enableThinking,
    },
    tts: {
      engine: ttsEngine,
      modelDir: ttsModelDir,
      ffmpegPath: ttsFfmpegPath,
    },
    https: { keyFile: httpsKeyFile, certFile: httpsCertFile, port: httpsPortRaw },
    security: {
      accessToken,
      corsOrigins,
      wechatAppId,
      wechatAppSecret,
      inviteCodes,
    },
  };
}

export const config: AppConfig = loadConfig();
