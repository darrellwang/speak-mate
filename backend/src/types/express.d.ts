/**
 * Express Request 类型增强（P2-5 多用户）。
 *
 * `req.userId` 由 middleware/auth.ts 的 requireAuth 写入——
 * 它是路由层获取用户标识的唯一来源（路由层不再硬编码 DEFAULT_USER_ID）。
 *
 * 挂载方式：在入口文件中 `import './types/express'`，或由 tsconfig 的
 * "include" 覆盖本文件即可（TS 全局声明文件需被项目引用）。
 */
declare global {
  namespace Express {
    interface Request {
      /**
       * 当前请求的用户标识。
       *
       * - 登录态 token → 真实 userId（uuid v4）
       * - 静态 ACCESS_TOKEN → 'admin'
       * - 零配置放行模式 → 'admin'
       *
       * 由 requireAuth 保证在进入业务路由前已赋值；
       * 单独挂载的业务路由若未经该中间件，此值为 undefined。
       */
      userId?: string;
    }
  }
}

export {};
