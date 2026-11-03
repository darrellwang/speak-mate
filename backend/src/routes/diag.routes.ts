/**
 * 诊断上报接口（routes/diag.routes.ts）
 *
 * 用途：小程序端把语音链路的关键节点上报到这里，写进服务日志。
 * 真机调试时用 `tail -f data/speakmate-service.log` 就能看到客户端走到哪一步断了——
 * 这比"看现象猜原因"可靠得多。
 *
 * ⚠️ 安全约束：
 * - **不记录任何文本内容**，只接受阶段名 + 标量信息（防把用户对话写进日志）；
 * - 阶段名做白名单式长度限制（最多 64 字符，字母数字下划线短横线）；
 * - 挂在 /api 下，受 requireAuth 保护（除非零配置放行模式）。
 */

import { Router } from 'express';
import { config } from '../config/env';
import { badRequest, sendOk } from '../middleware/error';
import { readLimiter } from '../middleware/rateLimit';

export const diagRouter = Router();

/** 允许的阶段名：字母、数字、下划线、短横线，长度 ≤ 64 */
const STEP_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** info 字段最大长度（截断而非报错，避免客户端小瑕疵导致上报失败）
 *  留 120 是为了能装下完整的微信错误信息（如
 *  `authorize:fail api scope is not declared in the privacy agreement`），
 *  截太短会把关键线索切断。 */
const MAX_INFO_LENGTH = 120;

/**
 * POST /api/diag/voice → {}
 *
 * 客户端上报语音链路阶段。响应恒为成功——诊断失败不该影响客户端。
 *
 * ⚠️ 鉴权：此路由挂在 requireAuth **之后**（/api 前缀），所以需要 Authorization 头。
 * 这是刻意的——诊断接口不应成为无鉴权的写入入口（防止被刷日志）。
 */
diagRouter.post('/voice', readLimiter, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const step = typeof body.step === 'string' ? body.step : '';
  if (!STEP_PATTERN.test(step)) {
    throw badRequest('step 格式非法');
  }

  const infoRaw = body.info;
  const info =
    typeof infoRaw === 'number' || typeof infoRaw === 'boolean'
      ? String(infoRaw)
      : typeof infoRaw === 'string'
        ? infoRaw.slice(0, MAX_INFO_LENGTH)
        : '';

  const ms = typeof body.ms === 'number' && Number.isFinite(body.ms) ? Math.round(body.ms) : -1;
  const platform = typeof body.platform === 'string' ? body.platform.slice(0, 16) : '';

  // 写到标准输出——NSSM 会把它收进服务日志文件
  console.log(`[diag] voice step=${step} info=${info} ms=${ms} platform=${platform}`);
  sendOk(res, {});
});

/**
 * GET /api/diag/ping → {ok:true}
 *
 * 无需鉴权的连通性探针（挂在 requireAuth 之前）。
 * 用于确认"客户端能不能到达后端"——诊断上报 401 时先打这个，
 * 区分是"网络不通"还是"令牌没带"。
 */
export const diagPublicRouter = Router();

diagPublicRouter.get('/ping', (_req, res) => {
  console.log('[diag] ping');
  sendOk(res, { ok: true, auth_required: config.security.accessToken !== '' });
});
