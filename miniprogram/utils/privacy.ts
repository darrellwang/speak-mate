/**
 * 隐私授权工具（utils/privacy.ts）
 *
 * ── 采用「微信官方隐私弹窗」模式 ──
 *
 * 微信提供两种模式，二选一：
 *
 * **A. 官方弹窗（本项目采用）**
 *   - **不注册** `wx.onNeedPrivacyAuthorization`；
 *   - 直接调 `wx.requirePrivacyAuthorize()` → 微信弹出**官方**隐私协议弹窗；
 *   - 用户点「同意」→ success；点「拒绝」→ fail。
 *
 * **B. 自定义弹窗**
 *   - 注册 `wx.onNeedPrivacyAuthorization`；
 *   - 微信**不再**弹官方窗，必须在回调里自己弹；
 *   - 且「同意」必须通过 `<button open-type="agreePrivacyAuthorization">` 组件触发，
 *     并 `resolve({ buttonId: 'agree-btn', event: 'agree' })`——
 *     **buttonId 必填**，漏了或按钮不是 agreePrivacyAuthorization 类型，
 *     微信会判定未授权，接口报 `fail privacy permission is not authorized`。
 *
 * ── 为什么从 B 改回 A（2026-11-02 教训）──
 * 本项目原先自己实现了自定义弹窗，但用的是普通 `<view>` 按钮 + `resolve({event:'agree'})`
 * （缺 buttonId），微信不认 → 录音接口一直报「未授权」，且**表现极其隐蔽**：
 * 不弹任何错误、界面毫无反应，只有抓真机错误码才看得到。
 * 官方弹窗模式没有这个隐患：不依赖按钮组件、不需要 buttonId、内容由平台按后台协议渲染。
 *
 * 代价：弹窗样式不可定制。对这个项目来说可靠性远比样式重要。
 */

/** 隐私协议是否已同意（getPrivacySetting 查询结果缓存） */
let privacyAuthorized = false;

/** 是否已完成一次 getPrivacySetting 查询 */
let privacyChecked = false;

/**
 * 查询隐私授权状态。
 *
 * ⚠️ `needAuthorization === false` 有两种含义：① 用户已同意；② 本小程序不涉及隐私接口。
 * 两种情况下都视为可继续（真有问题时隐私接口自己会报错，不必在此拦截）。
 */
function checkPrivacy(): Promise<boolean> {
  if (privacyChecked) {
    return Promise.resolve(privacyAuthorized);
  }
  return new Promise<boolean>((resolve) => {
    // 基础库过低不支持隐私协议 API：直接放行，由具体接口自行报错
    if (typeof wx.getPrivacySetting !== 'function') {
      privacyChecked = true;
      privacyAuthorized = true;
      resolve(true);
      return;
    }
    wx.getPrivacySetting({
      success: (res) => {
        privacyChecked = true;
        privacyAuthorized = res.needAuthorization === false;
        resolve(privacyAuthorized);
      },
      fail: () => {
        privacyChecked = true;
        privacyAuthorized = false;
        resolve(false);
      },
    });
  });
}

/**
 * 对外主入口：确保隐私协议已同意。
 *
 * 未同意时调 `wx.requirePrivacyAuthorize()`，**微信会弹出官方隐私弹窗**，
 * 用户的选择直接体现在 success / fail 上。业务只需根据返回值决定是否继续。
 */
async function ensurePrivacyAuthorized(): Promise<boolean> {
  const ok = await checkPrivacy();
  if (ok) return true;

  return new Promise<boolean>((resolve) => {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      // 基础库过低：放行，由具体隐私接口自行报错（错误更精确）
      resolve(true);
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => {
        privacyAuthorized = true;
        resolve(true);
      },
      fail: () => {
        // 用户拒绝（或在官方弹窗里点了拒绝）
        privacyAuthorized = false;
        resolve(false);
      },
    });
  });
}

/**
 * 打开《隐私保护指引》全文（供页面「查看详情」入口使用）。
 */
function openPrivacyContract(): void {
  if (typeof wx.openPrivacyContract === 'function') {
    wx.openPrivacyContract({});
    return;
  }
  wx.showToast({ title: '当前微信版本不支持查看隐私协议', icon: 'none' });
}

/**
 * 兼容保留：官方弹窗模式下不需要开发者处理同意/拒绝。
 * 页面若仍调用，视为无操作（状态由微信官方弹窗直接回写）。
 */
function agreePrivacy(): void {
  privacyAuthorized = true;
}

function disagreePrivacy(): void {
  privacyAuthorized = false;
}

/**
 * 兼容保留：官方弹窗模式下**不能**注册 onNeedPrivacyAuthorization，
 * 否则微信不再弹官方窗（会转而要求开发者自定义），故此处为空实现。
 */
function bindPrivacyListener(): void {
  // 刻意留空：见文件头「为什么从 B 改回 A」
}

/** 重置缓存（调试用：想重新走一次授权流程时调用） */
function resetPrivacyCache(): void {
  privacyChecked = false;
  privacyAuthorized = false;
}

export {
  ensurePrivacyAuthorized,
  bindPrivacyListener,
  agreePrivacy,
  disagreePrivacy,
  openPrivacyContract,
  resetPrivacyCache,
};
