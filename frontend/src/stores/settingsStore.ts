/**
 * 设置 store（架构文档 §2 stores/settingsStore.ts）。
 *
 * TTS 开关/语速/输入模式，zustand persist → localStorage（key: speakmate-settings）。
 * 语速范围 0.5–2.0（契约 ProfileSettings.tts_rate），与后端画像 settings 双轨：
 * 本地即时生效，SettingsPage 提交时 PATCH /api/profile 同步（多端预留）。
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { TTS_RATE_DEFAULT, clampTtsRate } from '@shared/constants';

export type InputMode = 'voice' | 'text';

// 语速范围常量已上提到 shared/constants（前后端共用同一份，见该文件的说明）
export { TTS_RATE_MAX, TTS_RATE_MIN } from '@shared/constants';

interface SettingsState {
  /** TTS 播报开关（false = 纯文字模式） */
  ttsEnabled: boolean;
  /** TTS 语速 0.5–2.0 */
  ttsRate: number;
  /** 当前输入模式：语音按住说话 / 键盘文字（P0-9 兜底切换） */
  inputMode: InputMode;
  /** ASR 不可用的一次性提示是否已展示（C6：localStorage 记忆，不反复骚扰） */
  asrNoticeShown: boolean;

  setTtsEnabled(enabled: boolean): void;
  setTtsRate(rate: number): void;
  setInputMode(mode: InputMode): void;
  markAsrNoticeShown(): void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ttsEnabled: true,
      ttsRate: TTS_RATE_DEFAULT,
      inputMode: 'voice',
      asrNoticeShown: false,

      setTtsEnabled: (ttsEnabled) => set({ ttsEnabled }),
      setTtsRate: (ttsRate) => set({ ttsRate: clampTtsRate(ttsRate) }),
      setInputMode: (inputMode) => set({ inputMode }),
      markAsrNoticeShown: () => set({ asrNoticeShown: true }),
    }),
    { name: 'speakmate-settings' },
  ),
);
