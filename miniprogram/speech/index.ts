/**
 * 语音引擎工厂（speech/index.ts）
 *
 * 支持两种引擎：`text-only`（纯文字，零依赖）与 `wechat-si`（微信同声传译插件）。
 * 默认配置为 `text-only`，用户可在「我的」页切到 `wechat-si`（需已添加插件授权）。
 */

import type { SpeechEngine } from '../config';
import type { SpeechAdapter } from './adapter';
import { textOnlyAdapter } from './textOnly';
import { createWechatSiAdapter } from './wechatSi';

export type { SpeechAdapter } from './adapter';
export { textOnlyAdapter } from './textOnly';

/**
 * 按设置创建语音适配器。
 */
export function createSpeechAdapter(engine: SpeechEngine): SpeechAdapter {
  if (engine === 'wechat-si') {
    return createWechatSiAdapter();
  }
  return textOnlyAdapter;
}
