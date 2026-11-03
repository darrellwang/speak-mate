/**
 * 小程序入口（app.ts）
 *
 * 职责刻意保持最小：只做「运行时配置的装载」，不碰业务。
 * 配置来源优先级：本地 Storage（设置页写入） > config.local.ts（本机，不入库） > config.ts 占位默认值。
 *
 * 为什么配置不在编译期固定：SpeakMate 是自托管应用，
 * 后端可能跑在 NAS、云服务器或本机，地址必须让用户在手机上现场改。
 *
 * P2-5 多用户：onLaunch 里预热登录（wx.login → 后端换 token → 存 Storage），
 * 避免首个业务请求干等一轮登录往返。
 */

import { DEFAULT_SETTINGS } from './config';
import { ensureLogin } from './utils/auth';
import { diag } from './utils/diag';
import { bindPrivacyListener } from './utils/privacy';
import { getSettings } from './utils/storage';

// IAppOption 的 globalData 结构定义在 types/global.d.ts（全局声明），
// 供任意页面的 getApp<IAppOption>() 拿到带类型的 globalData。

App<IAppOption>({
  globalData: {
    settings: { ...DEFAULT_SETTINGS },
    currentSessionId: '',
  },

  onLaunch() {
    this.globalData.settings = getSettings();
    // 冷启动恢复上次会话（避免每次进「练习」页都回空态）
    this.globalData.currentSessionId =
      (wx.getStorageSync('current_session_id') as string | '') || '';

    // 隐私模式：**官方弹窗**（见 utils/privacy.ts 文件头）。
    // 这个调用现在是空实现——刻意不注册 wx.onNeedPrivacyAuthorization，
    // 让微信在 requirePrivacyAuthorize 时弹出自带的官方隐私弹窗。
    // 一旦注册了监听，微信就不再弹官方窗、转而要求自定义实现
    // （且必须用 <button open-type="agreePrivacyAuthorization"> + resolve 带 buttonId），
    // 本项目曾因此在真机上「按住说话毫无反应」，故改回官方模式。
    bindPrivacyListener();

    // 预热登录（P2-5）：wx.login → 后端换 token → 存 Storage。
    // 提前发起，首个业务请求就能直接带上令牌，避免页面加载时干等一轮登录往返。
    // 失败不阻塞启动——真正的请求仍会走 ensureLogin() 的重试与错误提示路径。
    void ensureLogin()
      .then(() => {
        // 登录成功后再做一次环境自检上报（此时令牌已就绪，诊断请求才能通过鉴权）
        diag('app_launch', 'logged_in');
        void reportEnv();
      })
      .catch(() => {
        // 静默失败：此时用户还没有任何操作，错误由后续请求统一呈现
      });
  },
});

/**
 * 环境自检上报（app.ts）
 *
 * 目的：真机调试时，一次启动就能看到「引擎名 / 麦克风权限状态 / 基础库版本」，
 * 不必等到用户按了按钮才发现环境不对。
 */
async function reportEnv(): Promise<void> {
  try {
    const info = wx.getSystemInfoSync() as {
      SDKVersion?: string;
      platform?: string;
    };
    diag('env_platform', info.platform ?? '');
    diag('env_sdk', info.SDKVersion ?? '');

    const setting = await new Promise<Record<string, boolean | undefined>>((resolve) => {
      wx.getSetting({
        success: (s) => resolve(s.authSetting as Record<string, boolean | undefined>),
        fail: () => resolve({}),
      });
    });
    const rec = setting['scope.record'];
    diag('env_record_perm', rec === undefined ? 'undefined' : String(rec));
  } catch {
    // 自检失败无所谓
  }
}
