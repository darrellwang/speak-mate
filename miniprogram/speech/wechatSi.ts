/**
 * 微信同声传译插件实现（speech/wechatSi.ts）
 *
 * ASR（语音识别）：使用微信同声传译插件的 getRecordRecognitionManager，支持 en_US。
 * TTS（语音合成）：改用后端 Edge TTS（/api/tts），音质远超 WechatSI 的机器人声。
 *
 * 使用前提（缺一会导致 `requirePlugin('WechatSI')` 编译期报错）：
 *   1. app.json 已声明 `plugins.WechatSI`（version 0.3.10，provider wx069ba97219f66d99）
 *   2. 小程序后台已添加该插件授权（设置 → 第三方设置 → 插件管理，或微信服务市场）
 *   3. 小程序使用真实 AppID（测试号/游客 AppID 无法使用插件）
 *
 * TTS 改用后端 Edge TTS 的原因：
 *   WechatSI 的 textToSpeech 只有一个默认女声，音质像机器人，不支持选音色。
 *   后端 Edge TTS 走微软 Neural 声音（en-US-JennyNeural 等），接近真人发音。
 *
 * 退回纯文字版：删掉本文件、移除 app.json 的 plugins 声明、并把 speech/index.ts 的
 * `createSpeechAdapter` 分支恢复为 `return textOnlyAdapter`。
 */

import { DEFAULT_BASE_URL } from '../config';
import { getToken } from '../utils/auth';
import { diag } from '../utils/diag';
import { getSettings } from '../utils/storage';
import type {
  AsrError,
  AsrErrorKind,
  AsrSession,
  AsrStartOptions,
  SpeechAdapter,
  TtsController,
  TtsControllerOptions,
} from './adapter';

/** 插件识别语言（英文，匹配口语陪练场景） */
const LANG = 'en_US';

/** 单次录音上限（毫秒），到时自动停并定稿 */
const MAX_DURATION = 60000;

/**
 * 微信同声传译的语音识别管理器。
 *
 * ⚠️ 官方文档（recordRecoManager）确认：**只有 start / stop 两个方法，没有 abort**。
 * 取消录音只能调 stop()，然后用 settled 标志忽略其后续回调。
 */
interface RecognitionManager {
  start(options: { lang: string; duration?: number }): void;
  stop(): void;
  onStart?: (res: { msg?: string }) => void;
  onRecognize?: (res: { result: string }) => void;
  onStop?: (res: { result: string; tempFilePath?: string }) => void;
  onError?: (res: { retcode: number; msg: string; result?: string }) => void;
}

interface SiPlugin {
  getRecordRecognitionManager(): RecognitionManager;
  textToSpeech(options: {
    lang: string;
    content: string;
    success?: (res: { filename: string; retcode: number }) => void;
    fail?: (res: { retcode: number; msg?: string }) => void;
  }): void;
}

/**
 * 把插件错误码映射到业务错误分类（错误码见微信同声传译官方文档）。
 *
 * ⚠️ -30001 的官方定义是「录音接口出错」，**不是网络问题**——
 * 真机上最常见的成因是：Android 系统级麦克风权限未授予，
 * 插件在 manager.start() 时触发系统权限弹窗并立刻回调 -30001。
 * 早期版本把它误映射成「识别服务连接失败，请检查网络」，误导排查方向。
 */
function mapError(retcode: number, msg: string): AsrError {
  // ⚠️ 隐私协议未声明「访问你的麦克风」——这是后台配置缺失，不是代码问题。
  // 微信原文：`authorize:fail api scope is not declared in the privacy agreement`
  // 现象特征：wx.getSetting 里根本没有 scope.record，微信「授权设置」页也看不到麦克风项。
  if (/not declared in the privacy agreement|privacy permission is not|scope is not declared/i.test(msg)) {
    return {
      kind: 'permission',
      message:
        '后台未声明麦克风权限：请到微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引，补充「访问你的麦克风」并提交审核，通过后重试',
    };
  }
  if (/privacy agreement/i.test(msg)) {
    return {
      kind: 'permission',
      message: '录音权限未在隐私协议中声明，请到小程序后台「用户隐私保护指引」勾选麦克风',
    };
  }
  if (retcode === -30001) {
    // 「录音接口出错」：通常是系统级麦克风权限没给（Android 特有）
    return {
      kind: 'permission',
      message: '录音启动失败：请检查手机是否允许微信使用麦克风（设置 → 应用 → 微信 → 权限 → 麦克风）',
    };
  }
  if (retcode === -30002) {
    // 「录音暂停接口被调用，录音终止」
    return { kind: 'network', message: '录音被中断，请重试' };
  }
  if (retcode === -30003 || retcode === -30008) {
    // 帧数据传输失败 / 查询请求网络失败
    return { kind: 'network', message: '识别服务连接失败，请检查网络后重试' };
  }
  if (retcode === -30005) {
    return { kind: 'network', message: '语音识别服务内部错误，请稍后重试' };
  }
  if (retcode === -30011 || retcode === -30012) {
    return { kind: 'no-speech', message: '没听清，再说一次试试' };
  }
  if (retcode === -30007) {
    return { kind: 'unsupported', message: '语音识别启动参数错误，请反馈' };
  }
  // 未覆盖的错误码：保留微信原始 msg，便于对号入座查官方文档
  return { kind: 'unknown', message: msg ? `语音识别失败（${retcode}）：${msg}` : '语音识别失败，请改用文字输入' };
}

export function createWechatSiAdapter(): SpeechAdapter {
  let plugin: SiPlugin | null = null;
  let manager: RecognitionManager | null = null;

  const getPlugin = (): SiPlugin => {
    if (plugin === null) {
      plugin = requirePlugin('WechatSI') as unknown as SiPlugin;
    }
    return plugin;
  };

  return {
    name: 'wechat-si',
    asrSupported: true,
    ttsSupported: true,

    startAsr(options: AsrStartOptions): AsrSession {
      let settled = false;
      let interim = '';
      /** -30001 后的权限竞态重试标记（每次 startAsr 只重试一次，避免死循环） */
      let retriedAfterPermission = false;
      /** 用户是否已放弃本轮（松手/上滑取消发生在录音真正启动之前） */
      let abandoned = false;
      /** 录音是否已真正启动（manager.start() 已执行且未报错） */
      let started = false;

      /** 录音临时文件路径（onStop 时从插件回调里取得，供发音评估上传） */
      let recordedFile: string | undefined;

      const deliver = (text: string): void => {
        if (settled) return;
        settled = true;
        options.onFinal(
          text.trim(),
          recordedFile === undefined ? undefined : { filePath: recordedFile },
        );
      };

      const fail = (kind: AsrErrorKind, message: string): void => {
        if (settled) return;
        settled = true;
        options.onError({ kind, message });
      };

      /**
       * 启动录音前的守卫：若用户已松手/取消，就不要再启动录音。
       * 少了这一步，会出现"用户已松手，录音却还在跑"的孤儿录音。
       *
       * ⚠️ 放弃时**必须回调 onFinal('')** 通知业务层收尾——
       * 否则业务层的"录音中"状态永远不会被清掉（界面卡住）。
       */
      const canStart = (): boolean => {
        if (abandoned) {
          if (!settled) {
            settled = true;
            // 空结果 = 本轮没有有效语音，业务层据此复位 UI
            options.onFinal('');
          }
          return false;
        }
        return true;
      };

      // 授权前置检查（关键：必须先完成授权，再调 manager.start）
      //
      // ⚠️ 曾经把 authSetting['scope.record'] === undefined（用户从未被询问过）
      // 当成"已授权"直接 start —— 这是错的：
      // Android 上此时会弹**系统级**麦克风权限框，插件立刻回调 onError(-30001)，
      // 用户看到的就是"识别服务连接失败"（其实是权限问题，见 mapError 的说明）。
      //
      // 正确顺序：
      //   undefined（未询问）→ 主动 wx.authorize 触发授权 → 授权成功才 start
      //   true（已授权）    → 直接 start
      //   false（已拒绝）  → 引导去设置页
      wx.getSetting({
        success: (setting) => {
          const state = setting.authSetting['scope.record'];
          diag('perm_state', state === undefined ? 'undefined' : String(state));
          if (state === true) {
            startRecognition();
            return;
          }
          if (state === false) {
            // 曾经拒绝过：wx.authorize 不会再弹框，只能引导去设置页
            wx.showModal({
              title: '需要麦克风权限',
              content: '按住说话需要麦克风权限，请在设置中开启后重试。',
              confirmText: '去设置',
              success: (modal) => {
                if (modal.confirm) {
                  wx.openSetting({});
                }
              },
            });
            fail('permission', '未授权麦克风，请在设置中开启');
            return;
          }
          // undefined：从未询问过 → 主动发起授权
          //
          // ⚠️ 必须加超时兜底：`wx.authorize` 是隐私接口，调用时微信会先走隐私检查。
          // 若隐私模块的 onNeedPrivacyAuthorization 没把 resolve 交出去，
          // authorize 会**永远不回调**（既不 success 也不 fail）——
          // 用户看到的就是「按住说话毫无反应」。超时至少能给出可诊断的错误。
          let authorizeSettled = false;
          const authorizeTimer = setTimeout(() => {
            if (authorizeSettled) return;
            authorizeSettled = true;
            diag('authorize_timeout');
            fail('permission', '麦克风授权超时，请到「我的」页填写访问令牌后重试，或检查微信权限设置');
          }, 8000);

          wx.authorize({
            scope: 'scope.record',
            success: () => {
              if (authorizeSettled) return;
              authorizeSettled = true;
              clearTimeout(authorizeTimer);
              diag('authorize_ok');
              startRecognition();
            },
            fail: (err) => {
              if (authorizeSettled) return;
              authorizeSettled = true;
              clearTimeout(authorizeTimer);
              const errMsg = String(err?.errMsg ?? '');
              diag('authorize_fail', errMsg.slice(0, 100));

              // 「隐私协议未声明麦克风」是后台配置缺失，去设置页也没用
              // （微信授权设置里根本不会出现麦克风项）——必须给出准确指引。
              if (/not declared in the privacy agreement|privacy permission is not|scope is not declared/i.test(errMsg)) {
                wx.showModal({
                  title: '需要后台补声明',
                  content:
                    '小程序后台《用户隐私保护指引》未声明「访问你的麦克风」。\n\n请到：微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引，补充麦克风后提交审核，通过后再使用语音。',
                  showCancel: false,
                  confirmText: '知道了',
                });
                fail(
                  'permission',
                  '后台未声明麦克风权限，请在微信公众平台补充《用户隐私保护指引》后重试',
                );
                return;
              }

              // 其他失败（用户拒绝等）→ 引导去设置页
              wx.showModal({
                title: '需要麦克风权限',
                content: '按住说话需要麦克风权限，是否去设置开启？',
                confirmText: '去设置',
                success: (modal) => {
                  if (modal.confirm) {
                    wx.openSetting({});
                  }
                },
              });
              fail('permission', '未授权麦克风');
            },
          });
        },
        fail: () => startRecognition(), // 获取设置失败也尝试启动，由插件兜底报错
      });

      const startRecognition = (): void => {
        // 手势可能已结束（用户在权限弹窗/检查期间就松手了）→ 不再启动录音
        if (!canStart()) {
          diag('start_skipped_abandoned');
          return;
        }
        diag('start_recognition');

        try {
          manager = getPlugin().getRecordRecognitionManager();
        } catch {
          diag('plugin_unavailable');
          fail('unsupported' as never, '语音插件未就绪，请确认已在 app.json 声明 WechatSI');
          return;
        }
        // 重试时清空上一次的中间结果，避免混入残留文本
        interim = '';

        manager.onStart = () => {
          // 官方回调：正常开始录音识别时会调用。
          // 这是"录音真的启动了"的唯一可靠信号——start() 返回不代表成功。
          started = true;
          diag('asr_started');
          // 若用户在启动期间已松手，这里立刻停掉，避免留下孤儿录音
          if (abandoned) {
            manager?.stop();
          }
        };

        manager.onRecognize = (res) => {
          interim = res.result ?? '';
          if (interim !== '') {
            options.onInterim(interim);
            diag('asr_interim', interim.length);
          }
        };
        manager.onStop = (res) => {
          diag('asr_stopped', (res.result ?? '').length);
          // 录音临时文件（mp3）：交给业务层做发音评估（见 adapter.ts onFinal 注释）
          if (typeof res.tempFilePath === 'string' && res.tempFilePath !== '') {
            recordedFile = res.tempFilePath;
          }
          const text = (res.result ?? interim ?? '').trim();
          if (text === '') {
            fail('no-speech', '没听清，再说一次试试');
            return;
          }
          deliver(text);
        };
        manager.onError = (res) => {
          diag('asr_error', `${res.retcode}:${String(res.msg ?? '').slice(0, 30)}`);
          const mapped = mapError(res.retcode, res.msg);
          // 部分机型在「识别超时」时仍会带上已识别文本，优先采用
          if (res.result && res.result.trim() !== '') {
            deliver(res.result);
            return;
          }
          // -30001 竞态重试：Android 上系统权限弹窗与 start() 存在竞态——
          // 用户刚在系统弹窗点「允许」，本次 start 仍可能回调 -30001。
          // 此时重新读一次权限状态：若已是 granted，就再来一次。
          if (res.retcode === -30001 && !retriedAfterPermission) {
            retriedAfterPermission = true;
            wx.getSetting({
              success: (s) => {
                if (s.authSetting['scope.record'] === true) {
                  // 权限已就绪 → 重启一次识别
                  startRecognition();
                  return;
                }
                fail(mapped.kind, mapped.message);
              },
              fail: () => fail(mapped.kind, mapped.message),
            });
            return;
          }
          fail(mapped.kind, mapped.message);
        };

        manager.start({ lang: LANG, duration: MAX_DURATION });

        // 兜底：若启动后很快就被放弃（用户在录音真正启动前松手），立即停掉，
        // 否则会留下一段"孤儿录音"（麦克风一直开着直到 60s 超时）。
        if (abandoned) {
          manager.stop();
        }
      };

      return {
        stop(): void {
          // 用户松手：
          // - 录音已开始（onStart 已触发）→ 正常停止以产出定稿；
          // - 还没开始 → 标记放弃即可（startRecognition 的守卫会阻止启动）。
          abandoned = true;
          if (started) {
            manager?.stop();
            return;
          }
          // 尚未开始：直接给业务层一个空结果，避免界面卡在"录音中"
          if (!settled) {
            settled = true;
            options.onFinal('');
          }
        },
        abort(): void {
          // 取消（用户上滑取消）。插件没有 abort 方法，只能用 stop() 停止录音，
          // 再用 settled 标志忽略随之而来的 onStop/onError 回调。
          abandoned = true;
          if (started) {
            manager?.stop();
          }
          if (!settled) {
            settled = true;
            options.onError({ kind: 'aborted', message: '已取消' });
          }
        },
      };
    },

    createTts(options: TtsControllerOptions = {}): TtsController {
      const queue: string[] = [];
      let rate = options.rate ?? 1;
      let destroyed = false;
      /** 用户主动停止（与 destroyed 区分：stop 后仍可 enqueue 开始新一轮） */
      let stopped = false;

      /**
       * 当前阶段状态机。
       *
       * ⚠️ 必须显式管理，不能只靠一个 `playing` 布尔：
       * 之前用 `playing` + 监听 `audio.onStop` 推进队列，但 **`audio.src` 被替换时
       * InnerAudioContext 会触发 onStop**，于是每切一句就多跑一次 playNext，
       * 队列被提前抽空、并发下载互相覆盖 → 表现为「播两句就不播了」。
       * 现在：不监听 onStop，改用 phase + 重入保护。
       */
      let phase: 'idle' | 'downloading' | 'playing' = 'idle';

      /** 播放看门狗：onEnded 在某些机型上可能不触发，超时强制推进 */
      let watchdog: ReturnType<typeof setTimeout> | null = null;

      /** 预取缓存：播放当前句时就把下一句下好，消除句间等待 */
      let prefetched: { text: string; path: string } | null = null;

      const audio = wx.createInnerAudioContext();
      audio.playbackRate = rate;

      const setSpeaking = (speaking: boolean): void => {
        options.onSpeakingChange?.(speaking);
      };

      const clearWatchdog = (): void => {
        if (watchdog !== null) {
          clearTimeout(watchdog);
          watchdog = null;
        }
      };

      /** 下载一句的 mp3，失败返回 null */
      const download = (text: string): Promise<string | null> =>
        new Promise((resolve) => {
          // 用设置页里的地址，而不是编译期常量（用户可能改过后端地址）
          const settings = getSettings();
          const base = (settings.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
          const token = getToken();
          const header: Record<string, string> =
            token === '' ? {} : { Authorization: `Bearer ${token}` };
          // 音色随设置（后端白名单校验，非法值自动回退默认）
          const voice = encodeURIComponent(settings.ttsVoice || 'en-US-JennyNeural');
          wx.downloadFile({
            url: `${base}/api/tts?voice=${voice}&text=${encodeURIComponent(text)}`,
            header,
            success: (res) => resolve(res.statusCode === 200 ? res.tempFilePath : null),
            fail: () => resolve(null),
          });
        });

      /** 预取队首那句（不消费队列） */
      const prefetchNext = (): void => {
        if (prefetched !== null || queue.length === 0) return;
        const next = queue[0] as string;
        void download(next).then((path) => {
          // 期间可能已被停止或队列变化，做一次校验再缓存
          if (path === null || destroyed || stopped) return;
          if (queue[0] === next) {
            prefetched = { text: next, path };
          }
        });
      };

      const playNext = async (): Promise<void> => {
        if (destroyed || stopped) return;
        // 重入保护：同一时刻只允许一个 playNext 在跑
        if (phase !== 'idle') return;

        if (queue.length === 0) {
          setSpeaking(false);
          prefetched = null;
          return;
        }

        const text = queue.shift() as string;
        phase = 'downloading';
        setSpeaking(true);
        options.onSentenceStart?.(text);

        let path: string | null;
        if (prefetched !== null && prefetched.text === text) {
          path = prefetched.path;
          prefetched = null;
        } else {
          path = await download(text);
        }

        if (destroyed || stopped) {
          phase = 'idle';
          return;
        }
        if (path === null) {
          // 本句下载失败（限流/网络）→ 跳过继续，不让整段卡死
          phase = 'idle';
          void playNext();
          return;
        }

        phase = 'playing';
        audio.src = path;
        audio.playbackRate = rate;
        audio.play();

        // 关键优化：一边播一边把下一句下好 → 句间几乎无等待
        prefetchNext();

        // 看门狗：估算时长 + 宽裕量，超时仍无 onEnded 就强制推进
        clearWatchdog();
        const estimateMs = Math.max(4000, text.length * 140);
        watchdog = setTimeout(() => {
          if (phase === 'playing') {
            phase = 'idle';
            void playNext();
          }
        }, estimateMs);
      };

      audio.onEnded(() => {
        clearWatchdog();
        phase = 'idle';
        void playNext();
      });
      audio.onError(() => {
        clearWatchdog();
        phase = 'idle';
        void playNext();
      });
      // ⚠️ 刻意不监听 onStop：替换 audio.src 时它会被误触发，
      // 导致队列被提前抽空（见 phase 字段注释）。

      return {
        enqueue(text: string): void {
          const trimmed = text.trim();
          if (trimmed === '' || destroyed) return;
          // 新一轮内容：清掉上一轮 stop 留下的停止标记
          stopped = false;
          queue.push(trimmed);
          if (phase === 'idle') {
            void playNext();
          } else {
            // 正在播 → 顺手预取（若队列原本为空，刚入队的这句就是下一句）
            prefetchNext();
          }
        },
        stop(): void {
          stopped = true;
          queue.length = 0;
          prefetched = null;
          clearWatchdog();
          phase = 'idle';
          audio.stop();
          setSpeaking(false);
        },
        setRate(next: number): void {
          rate = next;
          audio.playbackRate = next;
        },
        destroy(): void {
          destroyed = true;
          stopped = true;
          queue.length = 0;
          prefetched = null;
          clearWatchdog();
          audio.stop();
          audio.destroy();
        },
      };
    },
  };
}
