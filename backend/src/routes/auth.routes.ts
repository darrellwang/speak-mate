/**
 * 认证接口（POST /api/auth/*、GET /api/auth/me、DELETE /api/me/data）
 *
 * 身份来源：
 * - `POST /api/auth/wechat-login`：小程序端 wx.login 拿 code → 后端换 openid → 签发 token；
 * - `POST /api/auth/invite-login`：邀请码登录（主人 / 受邀用户）；
 * - `GET  /api/auth/me`：查询当前登录用户（需鉴权）；
 * - `POST /api/auth/logout`：注销当前用户全部登录态（需鉴权）；
 * - `DELETE /api/me/data`：清除当前用户全部业务数据（PIPL 删除权，需鉴权）。
 *
 * ⚠️ 挂载位置（见 app.ts）：
 * - `authPublicRouter` 挂在 requireAuth **之前**——登录接口本身就是入口，
 *   凭 code / 邀请码换取登录态，不能被守卫拦住；
 * - `authRouter`（/me、/logout）与 `meRouter`（/me/data）挂在 requireAuth **之后**，
 *   由守卫写入 req.userId 后才可取用户标识。
 */

import { Router } from 'express';
import type { AuthSession } from '../../../shared/types/models';
import { config } from '../config/env';
import { asyncHandler, badRequest, sendOk } from '../middleware/error';
import { writeLimiter } from '../middleware/rateLimit';
import * as authService from '../services/auth.service';

/**
 * 公开认证路由（无需鉴权）：登录接口。
 *
 * 单独成一个 Router，是为了让 app.ts 能把它挂在 requireAuth 之前，
 * 而把需要鉴权的 /me、/logout 留在守卫之后——两者挂载点不同，权限语义也不同。
 */
export const authPublicRouter = Router();

/** 需鉴权的认证路由：/api/auth/me、/api/auth/logout */
export const authRouter = Router();

/** 登录接口限流：防止暴力猜邀请码 / 刷 code（每 IP 每分钟 10 次） */
const loginLimiter = writeLimiter;

/** 读取请求中的当前用户 id（requireAuth 已保证存在，这里兜底） */
function currentUserId(req: { userId?: string }): string {
  const id = req.userId;
  if (typeof id !== 'string' || id === '') {
    throw badRequest('未识别到当前用户');
  }
  return id;
}

/**
 * 微信小程序静默登录：{ code } → { token, user, expires_at }
 *
 * code 由 wx.login() 生成（5 分钟有效、一次性）。
 * 后端用 code 换 openid，**session_key 不下发前端、不落库**。
 */
authPublicRouter.post(
  '/wechat-login',
  loginLimiter,
  asyncHandler(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const code = typeof body.code === 'string' ? body.code.trim() : '';
    if (code === '') {
      throw badRequest('code 不能为空');
    }
    authService.assertWechatCodeFormat(code);

    const { wechatAppId, wechatAppSecret } = config.security;
    if (wechatAppId === '' || wechatAppSecret === '') {
      throw badRequest('服务端未配置微信登录（WECHAT_APP_ID / WECHAT_APP_SECRET）');
    }

    const { openid } = await authService.exchangeCodeForOpenid(code, wechatAppId, wechatAppSecret);
    const user = authService.upsertWechatUser(openid);
    const result: AuthSession = authService.issueToken(user.id);
    sendOk(res, result);
  }),
);

/** 邀请码登录：{ code } → { token, user, expires_at } */
authPublicRouter.post('/invite-login', loginLimiter, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (code === '') {
    throw badRequest('邀请码不能为空');
  }
  if (config.security.inviteCodes.length === 0) {
    throw badRequest('服务端未配置邀请码（INVITE_CODES）');
  }
  const user = authService.upsertInviteUser(code, config.security.inviteCodes);
  const result: AuthSession = authService.issueToken(user.id);
  sendOk(res, result);
});

/** 当前登录用户：GET /api/auth/me → { user } */
authRouter.get('/me', (req, res) => {
  const userId = currentUserId(req);
  const user = authService.findUserById(userId);
  if (!user) {
    // 管理员账号可能不在 users 表中（存量数据迁移只改了业务表）
    sendOk(res, {
      user: {
        id: userId,
        source: 'invite',
        nickname: 'SpeakMate',
        created_at: new Date().toISOString(),
        last_login_at: new Date().toISOString(),
      },
    });
    return;
  }
  sendOk(res, { user });
});

/** 注销：POST /api/auth/logout → {}（清空当前用户的全部登录态） */
authRouter.post('/logout', (req, res) => {
  authService.revokeTokens(currentUserId(req));
  sendOk(res, {});
});

/**
 * 清除我的数据：DELETE /api/me/data → { deleted: { sessions, words } }
 *
 * PIPL 删除权：用户有权要求删除其个人数据。删完保留账号本身
 * （用户可重新登录并拥有全新数据）。
 */
export const meRouter = Router();

meRouter.delete('/data', (req, res) => {
  const userId = currentUserId(req);
  const deleted = authService.deleteUserData(userId);
  sendOk(res, { deleted });
});
