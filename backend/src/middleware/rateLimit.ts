/**
 * 速率限制器（审查报告 H2：LLM 接口无限制 → API 额度可被刷爆）
 *
 * 按"请求成本"分三档，各路由按需挂载：
 * - `llmLimiter`：真实消耗 LLM token 的接口（POST /api/chat、POST /api/words/define）——最严格；
 * - `writeLimiter`：写操作（创建/更新/删除）——中等；
 * - `readLimiter`：读操作——宽松，仅防暴力扫描。
 *
 * 设计权衡：
 * - 单机内存计数即可满足单用户场景，**不引入 Redis**（架构 §0 原则 1：不引入非必要组件）；
 * - 阈值可通过环境变量覆盖，便于不同部署形态调整；
 * - 命中上限时返回项目统一契约 `{code: 4290, ...}`，而非中间件的默认纯文本；
 * - `trust proxy` 需显式开启（TRUST_PROXY=true），避免在未部署反代时被伪造的
 *   X-Forwarded-For 绕过限制。
 *
 * 注意：单用户正常使用量远低于默认阈值（人一分钟发不了 30 轮对话），误伤概率极低。
 */
import type { NextFunction, Request, Response } from 'express';
import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';

/** 429 业务错误码（架构 §4.1 错误码表增补） */
export const RATE_LIMIT_CODE = 4290;

/** 读取环境变量阈值，非法值回退默认 */
function maxFromEnv(envKey: string, fallback: number): number {
  const raw = Number(process.env[envKey]);
  return Number.isInteger(raw) && raw > 0 ? raw : fallback;
}

/**
 * 测试环境默认关闭限流（NODE_ENV=test 时由 vitest 注入），
 * 避免集成测试因共享计数被 429 阻断；需要专门验证限流行为的用例
 * 可通过 ENABLE_RATE_LIMIT=true 显式开启。
 */
function rateLimitEnabled(): boolean {
  if (process.env.ENABLE_RATE_LIMIT === 'true') return true;
  return process.env.NODE_ENV !== 'test';
}

/** 关闭状态下的直通中间件 */
function passthrough(_req: Request, _res: Response, next: NextFunction): void {
  next();
}

const commonOptions: Partial<RateLimitOptions> = {
  standardHeaders: true, // 回传 RateLimit-* 标准头，便于客户端退避
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      code: RATE_LIMIT_CODE,
      data: null,
      message: '请求过于频繁，请稍后再试',
    });
  },
};

/**
 * 计数键生成（P2-5 多用户）。
 *
 * 纯 IP 计数在多用户场景下有缺陷：同一 WiFi 下的多个用户共享同一个出口 IP，
 * 会互相抢配额——一个人狂刷 LLM 接口，其他人直接被 429 拦下。
 *
 * 因此按维度分键：
 * - **已识别用户**（req.userId 存在）→ 按 userId 计数，各用户互不干扰；
 * - **未识别用户**（登录接口、鉴权失败）→ 退回 IP，兼顾防扫描/防暴力猜码。
 *
 * IPv6 归并：取 /64 前缀（保留前三段），避免同一用户的 IPv6 地址轮换绕过限流。
 * 注：express-rate-limit v7 未导出 ipKeyGenerator（v8 才有），此处自行实现。
 */
function normalizeIp(ip: string): string {
  if (!ip.includes(':')) {
    return ip;
  }
  const parts = ip.split(':');
  return parts.slice(0, 3).join(':');
}

function userOrIpKeyGenerator(req: Request): string {
  const userId = req.userId;
  if (typeof userId === 'string' && userId !== '') {
    return `u:${userId}`;
  }
  return `ip:${normalizeIp(req.ip ?? '')}`;
}

function buildLimiter(envKey: string, fallback: number): ReturnType<typeof rateLimit> {
  if (!rateLimitEnabled()) {
    return passthrough as unknown as ReturnType<typeof rateLimit>;
  }
  return rateLimit({
    ...commonOptions,
    windowMs: 60_000,
    max: maxFromEnv(envKey, fallback),
    // v7 的 keyGenerator 类型签名用的是其内部的 Request 类型（Web 标准），
    // 与 Express Request 不兼容——运行时行为一致，这里做一次类型断言。
    keyGenerator: userOrIpKeyGenerator as unknown as RateLimitOptions['keyGenerator'],
  });
}

/** LLM 消耗型接口：默认 30 次 / 分钟 */
export const llmLimiter = buildLimiter('RATE_LIMIT_LLM_PER_MIN', 30);

/** 写操作：默认 120 次 / 分钟 */
export const writeLimiter = buildLimiter('RATE_LIMIT_WRITE_PER_MIN', 120);

/** 读操作：默认 300 次 / 分钟 */
export const readLimiter = buildLimiter('RATE_LIMIT_READ_PER_MIN', 300);
