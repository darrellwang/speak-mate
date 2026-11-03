/**
 * 隐私政策页（pages/privacy/privacy.ts）
 *
 * 展示 SpeakMate 收集/使用的隐私信息说明，并提供：
 *  - 「打开隐私保护指引」：调 wx.openPrivacyContract 打开微信官方协议页
 *  - 「查看权限状态」：调 wx.getPrivacySetting 展示当前是否已同意
 *  - 「同意并继续」：标记隐私已同意（供业务后续免弹窗）
 *
 * 微信审核要求：涉及隐私的接口使用前必须能跳转到本页让用户知悉。
 */

Page({
  data: {
    /** 是否已同意隐私协议 */
    authorized: false,
    /** 基础库是否支持隐私协议 API（不支持则隐藏相关按钮） */
    privacyApiSupported: false,
  },

  onLoad() {
    const supported = typeof wx.getPrivacySetting === 'function';
    this.setData({ privacyApiSupported: supported });
    if (supported) {
      wx.getPrivacySetting({
        success: (res) => {
          this.setData({ authorized: res.needAuthorization === false });
        },
        fail: () => {
          this.setData({ authorized: false });
        },
      });
    }
  },

  /** 打开微信官方《隐私保护指引》 */
  openContract() {
    if (typeof wx.openPrivacyContract === 'function') {
      wx.openPrivacyContract({
        fail: () => {
          wx.showToast({ title: '打开协议失败，请稍后再试', icon: 'none' });
        },
      });
    } else {
      wx.showToast({ title: '当前微信版本过低', icon: 'none' });
    }
  },

  /** 重新查询授权状态 */
  refreshStatus() {
    if (typeof wx.getPrivacySetting !== 'function') return;
    wx.getPrivacySetting({
      success: (res) => {
        this.setData({ authorized: res.needAuthorization === false });
      },
    });
  },

  /** 主动触发授权弹窗 */
  agree() {
    if (typeof wx.requirePrivacyAuthorize !== 'function') {
      wx.showToast({ title: '当前微信版本过低', icon: 'none' });
      return;
    }
    wx.requirePrivacyAuthorize({
      success: () => {
        this.setData({ authorized: true });
        wx.showToast({ title: '已同意', icon: 'success' });
      },
      fail: () => {
        this.refreshStatus();
      },
    });
  },
});
