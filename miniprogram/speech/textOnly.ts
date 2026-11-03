/**
 * 纯文字降级实现（speech/textOnly.ts）
 *
 * 默认引擎：不需要任何插件、不需要 AppID，项目开箱即可跑通完整对话链路。
 * 它的存在让「没配插件 / 用户拒绝授权 / 引擎初始化失败」始终有兜底，
 * 而不是让页面弹出一堆无法操作的报错。
 */

import type { SpeechAdapter, TtsController } from './adapter';

const noopController: TtsController = {
  enqueue(): void {},
  stop(): void {},
  setRate(): void {},
  destroy(): void {},
};

export const textOnlyAdapter: SpeechAdapter = {
  name: 'text-only',
  asrSupported: false,
  ttsSupported: false,

  startAsr(options) {
    // 同步回调即可（业务层会在点击时先判断 asrSupported，正常走不到这里）
    options.onError({ kind: 'unsupported', message: '当前未启用语音，请用文字输入' });
    return { stop(): void {}, abort(): void {} };
  },

  createTts(): TtsController {
    return noopController;
  },
};
