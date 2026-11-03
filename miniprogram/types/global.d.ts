/**
 * 小程序端全局类型补充（types/global.d.ts，手写，非 sync-types 生成）
 *
 * - `IAppOption`：miniprogram-api-typings 约定由业务方声明的全局 App 类型，
 *   供 `getApp<IAppOption>()` 与 `App<IAppOption>()` 使用；
 * - 该文件为纯声明，微信开发者工具不编译 .d.ts，不产生任何运行时产物。
 */

import type { Settings } from '../config';

declare global {
  interface IAppOption {
    globalData: {
      /** 运行时设置（Storage 装载，设置页保存后同步刷新） */
      settings: Settings;
      /**
       * 当前会话 id。
       * tabBar 页之间只能 switchTab，无法带 query 传参，因此会话 id 走
       * 「globalData 内存 + Storage 持久化」双写：前者管本次运行，后者管冷启动恢复。
       */
      currentSessionId: string;
    };
  }

  /**
   * 微信同声传译插件（WechatSI）能力声明。
   * 插件未添加时本类型无用，但保留声明可让 wechatSi.ts 保持类型完整。
   */
  interface WechatSiPlugin {
    /** 语音识别管理器（按住说话） */
    getRecordRecognitionManager(): WechatSiRecordManager;
    /** 文本转语音，成功回调返回本地音频文件路径 */
    textToSpeech(options: {
      lang: string;
      content?: string;
      tts?: string;
      success?: (res: { filename: string; retcode: number; msg?: string }) => void;
      fail?: (res: { retcode: number; msg?: string }) => void;
      complete?: () => void;
    }): void;
  }

  interface WechatSiRecordManager {
    start(options: { lang: string; duration?: number }): void;
    stop(): void;
    /** 中间结果（边说边上屏） */
    onRecognize?: (res: { result: string }) => void;
    /** 定稿结果（stop 后触发） */
    onStop?: (res: { result: string; tempFilePath?: string; duration?: number }) => void;
    onStart?: (res: unknown) => void;
    onError?: (res: { retcode: number; msg: string; result?: string }) => void;
  }

  /** requirePlugin 编译期指令（app.json 声明插件后可用） */
  function requirePlugin(name: 'WechatSI'): WechatSiPlugin;
  function requirePlugin(name: string): unknown;
}
