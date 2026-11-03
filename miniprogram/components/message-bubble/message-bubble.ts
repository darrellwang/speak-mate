/**
 * 消息气泡组件（components/message-bubble）
 *
 * 承担一整条消息的渲染：正文 + 纠错卡 + AI 建议词条 + 失败重试。
 * 之所以做成组件而不是内联在页面里：聊天列表要靠它复用（历史回看页同样渲染消息），
 * 且把「纠错卡」的渲染细节收敛在此，页面只管数据流。
 */

import type { Correction, VocabSuggestion } from '../../types/chat';
import type { Message } from '../../types/models';

interface DisplayMessage extends Message {
  /** 流式输出中（正文尾部追加光标） */
  streaming?: boolean;
  /** 本条失败（可重试） */
  failed?: boolean;
}

Component({
  options: {
    // 允许使用 app.wxss 里的全局类（卡片、标签等），避免样式重复定义
    addGlobalClass: true,
  },

  properties: {
    message: { type: Object, value: {} as DisplayMessage },
    /** 在列表中的下标（长按选词需要回传定位） */
    index: { type: Number, value: 0 },
    /** 是否展示交互（历史回看页为只读） */
    interactive: { type: Boolean, value: true },
    /** 时间戳展示文案（由页面预先格式化，组件内不做时区换算） */
    timeText: { type: String, value: '' },
    /** 当前正在朗读的句子原文（非空时气泡内高亮该句） */
    highlightText: { type: String, value: '' },
  },

  data: {
    /** 词条是否已入库（本地乐观标记，刷新后以服务端为准） */
    savedVocabIndexes: [] as number[],
    /** 高亮句之前的部分 */
    segBefore: '',
    /** 高亮句本身（当前朗读中） */
    segHighlight: '',
    /** 高亮句之后的部分 */
    segAfter: '',
  },

  observers: {
    'message.content, highlightText': function (content: string, highlight: string) {
      this.computeSegments(content, highlight);
    },
  },

  methods: {
    /** 把正文按高亮句拆成 前/高亮/后 三段，供 wxml 分段渲染 */
    computeSegments(content: string, highlight: string): void {
      const text = content ?? '';
      const hl = (highlight ?? '').trim();
      if (hl === '') {
        this.setData({ segBefore: text, segHighlight: '', segAfter: '' });
        return;
      }
      const idx = text.indexOf(hl);
      if (idx < 0) {
        this.setData({ segBefore: text, segHighlight: '', segAfter: '' });
        return;
      }
      this.setData({
        segBefore: text.slice(0, idx),
        segHighlight: text.slice(idx, idx + hl.length),
        segAfter: text.slice(idx + hl.length),
      });
    },

    /** 长按气泡 → 进入选词（小程序无法自由选取文本，只能分词后点选） */
    onLongPress(): void {
      if (!this.data.interactive) return;
      this.triggerEvent('wordselect', { index: this.data.index });
    },

    /** 点击 AI 建议词条 → 一键入库 */
    onAddVocab(e: WechatMiniprogram.TouchEvent): void {
      const dataset = e.currentTarget.dataset as { vidx?: string };
      const vocabIndex = Number.parseInt(dataset.vidx ?? '-1', 10);
      if (vocabIndex < 0) return;
      if ((this.data.savedVocabIndexes as number[]).includes(vocabIndex)) return;
      this.setData({
        savedVocabIndexes: [...(this.data.savedVocabIndexes as number[]), vocabIndex],
      });
      this.triggerEvent('vocabadd', { index: this.data.index, vocabIndex });
    },

    /** 失败气泡上的「重试」 */
    onRetry(): void {
      this.triggerEvent('retry', { index: this.data.index });
    },

    /** AI 消息的「重播」：把整条内容交给页面用 TTS 朗读 */
    onReplay(): void {
      const message = this.data.message as DisplayMessage;
      this.triggerEvent('replay', { index: this.data.index, content: message.content });
    },

    /** 阻止冒泡：纠错卡上的复制等操作不应触发长按选词 */
    noop(): void {},
  },
});

export type { DisplayMessage, Correction, VocabSuggestion };
