/**
 * 对话页（架构文档 §2 pages/ChatPage.tsx，路由 /，P0-1/2/9）。
 *
 * 完整语音闭环：场景选择或延续上次 → 消息气泡流 → 按住说话（ASR 中间结果实时上屏）
 * → 松开定稿回填输入框（可编辑，第一道兜底）→ 发送 → SSE delta 逐字渲染
 * → 句级 TTS 首句即播（可停）→ 纠错卡片 + 词条 chips → 继续/选词标词。
 *
 * 启动直达（PRD §5.1）：有上次会话 → 恢复最近 50 条继续聊；无 → 跳场景选择。
 * 降级：ASR 不支持/权限拒绝 → 一次性提示 + 切文字输入（C6）；TTS 不可用 → 纯文字。
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import IconButton from '@mui/material/IconButton';
import ChatTopBar from '../components/chat/ChatTopBar';
import HoldToTalkButton from '../components/chat/HoldToTalkButton';
import MessageBubble from '../components/chat/MessageBubble';
import TextComposer from '../components/chat/TextComposer';
import WordEntryDialog from '../components/words/WordEntryDialog';
import { KeyboardIcon } from '../components/icons';
import { useChat } from '../hooks/useChat';
import { useSpeech } from '../hooks/useSpeech';
import { useChatStore } from '../stores/chatStore';
import { getLastSessionId, useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { notifyInfo } from '../utils/notify';

interface PickedWord {
  word: string;
  context: string;
}

export default function ChatPage(): JSX.Element {
  const navigate = useNavigate();
  const currentSession = useSessionStore((state) => state.currentSession);
  const inputMode = useSettingsStore((state) => state.inputMode);
  const setInputMode = useSettingsStore((state) => state.setInputMode);
  const asrNoticeShown = useSettingsStore((state) => state.asrNoticeShown);
  const markAsrNoticeShown = useSettingsStore((state) => state.markAsrNoticeShown);

  const speech = useSpeech();
  const { messages, streaming, failedContent, failureMessage, send, retry } = useChat({
    onDelta: (text) => speech.feedDelta(text),
    onStreamSettled: () => speech.flushSpeech(),
    onFailure: () => speech.discardPendingSpeech(),
  });

  const [draft, setDraft] = useState('');
  const [booting, setBooting] = useState(true);
  const [pickedWord, setPickedWord] = useState<PickedWord | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bootstrappedRef = useRef(false);
  const announcedSessionsRef = useRef<ReadonlySet<string>>(new Set());

  /* ---- 启动直达：续上次会话或跳场景选择（StrictMode 双执行防抖） ---- */
  useEffect(() => {
    if (bootstrappedRef.current) return;
    bootstrappedRef.current = true;
    if (useSessionStore.getState().currentSession !== null) {
      setBooting(false);
      return;
    }
    const lastSessionId = getLastSessionId();
    if (lastSessionId === null) {
      setBooting(false);
      navigate('/scenes', { replace: true });
      return;
    }
    void (async () => {
      const ok = await useSessionStore.getState().restoreSession(lastSessionId);
      setBooting(false);
      if (!ok) navigate('/scenes', { replace: true });
    })();
  }, [navigate]);

  /* ---- ASR 不支持：一次性提示 + 自动切文字输入（C6，localStorage 记忆不反复骚扰） ---- */
  useEffect(() => {
    if (!speech.asrSupported && !asrNoticeShown) {
      setInputMode('text');
      markAsrNoticeShown();
      notifyInfo('当前浏览器不支持语音识别，已切换为文字输入');
    }
  }, [speech.asrSupported, asrNoticeShown, setInputMode, markAsrNoticeShown]);

  /* ---- 新会话开场白 TTS 播报（messages 恰为 1 条 assistant 时；StrictMode 去重） ---- */
  useEffect(() => {
    const sessionId = currentSession?.id;
    if (sessionId === undefined) return;
    if (announcedSessionsRef.current.has(sessionId)) return;
    const chatState = useChatStore.getState();
    if (chatState.messages.length === 1 && chatState.messages[0].role === 'assistant') {
      announcedSessionsRef.current = new Set([...announcedSessionsRef.current, sessionId]);
      const opener = chatState.messages[0].content;
      if (opener.trim().length > 0) {
        speech.feedDelta(opener);
        speech.flushSpeech();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSession?.id]);

  /* ---- 自动滚动：新消息 / 流式增量时贴底 ---- */
  const lastMessage = messages[messages.length - 1];
  useEffect(() => {
    const element = scrollRef.current;
    if (element === null) return;
    element.scrollTop = element.scrollHeight;
  }, [messages.length, lastMessage?.content, failedContent]);

  /* ---- 语音输入 ---- */
  const effectiveVoiceMode = inputMode === 'voice' && speech.asrSupported;

  const handlePressStart = (): void => {
    speech.stopSpeaking(); // 新一轮说话前停止上一轮播报
    speech.startListening({
      onFinal: (text) => {
        // 定稿回填输入框：即「待发送气泡（点击可编辑）」——发送前可修改（P0-9 第一道兜底）
        if (text.trim().length > 0) {
          setDraft(text);
        } else {
          notifyInfo('没有识别到内容，可重试或改用键盘输入');
        }
      },
      onError: (error) => {
        if (error.kind === 'permission') {
          setInputMode('text'); // 永久降级文字输入
        }
        if (error.kind !== 'aborted') notifyInfo(error.message);
      },
    });
  };

  const handleInvalidTap = (): void => {
    speech.cancelListening();
    notifyInfo('长按说话，松开结束');
  };

  /* ---- 发送 ---- */
  const handleSend = (): void => {
    if (streaming) {
      notifyInfo('AI 正在回复，请稍候');
      return;
    }
    const text = draft;
    if (text.trim().length === 0) return;
    setDraft('');
    void send(text);
  };

  /* ---- 选词（P0-5 路径 A） ---- */
  const handlePickWord = (word: string, context: string): void => {
    setPickedWord({ word, context });
  };

  if (booting) {
    return (
      <Box className="flex h-full flex-col items-center justify-center gap-2">
        <CircularProgress size={28} />
        <Box component="span" className="text-sm" sx={{ color: 'text.secondary' }}>
          正在恢复上次会话…
        </Box>
      </Box>
    );
  }

  return (
    <Box className="flex h-full min-h-0 flex-col">
      <ChatTopBar speaking={speech.speaking} onStopSpeaking={speech.stopSpeaking} />

      {/* 消息流 */}
      <Box
        ref={scrollRef}
        className="thin-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3"
        aria-label="消息流"
      >
        {messages.map((message) => (
          <MessageBubble
            key={message.id}
            message={message}
            isStreaming={
              streaming &&
              message.role === 'assistant' &&
              message.id === lastMessage?.id
            }
            sceneId={currentSession?.scene_id ?? ''}
            onPickWord={handlePickWord}
          />
        ))}

        {/* 失败态：原样重发（后端幂等，不重复插入 user 消息） */}
        {failedContent !== null && (
          <Alert
            severity="error"
            variant="outlined"
            sx={{ mt: 1, alignItems: 'center' }}
            action={
              <Button color="error" size="small" onClick={retry} sx={{ minHeight: 36 }}>
                重试
              </Button>
            }
          >
            {failureMessage ?? '发送失败'}，可原样重试（不会重复入库）
          </Alert>
        )}

        {messages.length === 0 && (
          <Box className="flex h-full items-center justify-center">
            <Box component="span" className="text-sm" sx={{ color: 'text.secondary' }}>
              选择场景，开始第一句对话吧
            </Box>
          </Box>
        )}
      </Box>

      {/* 输入区：语音模式（按住说话 + 键盘切换）/ 文字模式 */}
      {effectiveVoiceMode ? (
        <Box
          className="pb-safe flex items-center justify-center gap-4 px-4 pt-2"
          sx={{ bgcolor: 'background.paper', borderTop: 1, borderColor: 'divider' }}
        >
          <IconButton
            onClick={() => setInputMode('text')}
            aria-label="切换键盘输入"
            color="default"
          >
            <KeyboardIcon />
          </IconButton>

          <Box className="flex flex-col items-center">
            <HoldToTalkButton
              listening={speech.listening}
              disabled={streaming}
              onPressStart={handlePressStart}
              onPressEnd={speech.stopListening}
              onInvalidTap={handleInvalidTap}
            />
            {/* ASR 中间结果实时上屏（P1-2） */}
            <Box
              className="mt-1 min-h-5 max-h-16 w-full overflow-y-auto px-2 text-center text-sm"
              sx={{ color: speech.listening ? 'text.primary' : 'text.disabled' }}
            >
              {speech.interim.length > 0 ? speech.interim : 'Recognizing…'}
            </Box>
          </Box>

          {/* 占位对称 */}
          <Box sx={{ width: 48 }} />
        </Box>
      ) : (
        <TextComposer
          value={draft}
          onChange={setDraft}
          onSend={handleSend}
          disabled={streaming}
          showVoiceSwitch={speech.asrSupported}
          onSwitchToVoice={() => setInputMode('voice')}
        />
      )}

      {/* 词条卡弹窗（选词 → define → 入库） */}
      <WordEntryDialog
        open={pickedWord !== null}
        word={pickedWord?.word ?? ''}
        context={pickedWord?.context ?? ''}
        sessionId={currentSession?.id ?? null}
        sceneId={currentSession?.scene_id ?? ''}
        onClose={() => setPickedWord(null)}
      />
    </Box>
  );
}
