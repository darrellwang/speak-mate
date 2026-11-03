/**
 * 设置页（架构文档 §2 pages/SettingsPage.tsx，路由 /settings，P1-1）。
 *
 * T8 收尾批次完整形态，自上而下：
 * 1. TTS 控制（开关 + 三档语速，本地即时生效 + PATCH /api/profile 同步画像 settings）；
 * 2. 学习画像（GET /api/profile）：
 *    - display_name 编辑（AI 伙伴对用户的称呼，PATCH /api/profile + 成功 Toast）；
 *    - 统计大数字卡（会话/消息/词汇/已掌握）；
 *    - 常错表达 Top5（pattern → corrected + 次数 + 问题类型）；
 *    - 高频场景 Top3（sessions 实时聚合）；
 * 3. LLM 服务信息（GET /api/config：当前 provider/模型，让用户知道连的谁）；
 * 4. 应用信息（产品名称 / 语音引擎 / 版本）+ 隐私说明（浏览器 ASR 音频不出设备）。
 *
 * 移动端单列布局；图片加载失败均有内联重试。
 */
import { useCallback, useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Chip from '@mui/material/Chip';
import Divider from '@mui/material/Divider';
import FormControlLabel from '@mui/material/FormControlLabel';
import IconButton from '@mui/material/IconButton';
import Skeleton from '@mui/material/Skeleton';
import Slider from '@mui/material/Slider';
import Switch from '@mui/material/Switch';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { ConfigData, ProfileData } from '@shared/types/api';
import type { MistakePattern } from '@shared/types/models';
import { issueLabel } from '@shared/constants';
import { api } from '../api/endpoints';
import { getAccessToken, setAccessToken } from '../api/token';
import { RefreshIcon } from '../components/icons';
import { TTS_RATE_MAX, TTS_RATE_MIN, useSettingsStore } from '../stores/settingsStore';
import { notifySuccess, notifyWarning } from '../utils/notify';
import { getSceneName } from '../utils/sceneMap';

/** LLM provider 友好名称（与后端 config/env.ts 的预设一一对应） */
const PROVIDER_LABEL: Record<string, string> = {
  mock: 'Mock 模拟模式',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  openai: 'OpenAI',
  lmstudio: 'LMStudio（本地）',
};

/** provider 说明文案（设置页只读展示，无任何 Key 信息） */
const PROVIDER_HINT: Record<string, string> = {
  mock: '当前为模拟模式：不调用真实大模型，返回内置模拟对话数据，供联调与冒烟测试使用。',
  deepseek: 'AI 回复由 DeepSeek 云端大模型生成；API Key 仅保存在后端 .env，不经过浏览器。',
  qwen: 'AI 回复由通义千问云端大模型生成；API Key 仅保存在后端 .env，不经过浏览器。',
  openai: 'AI 回复由 OpenAI 云端大模型生成；API Key 仅保存在后端 .env，不经过浏览器。',
  lmstudio: 'AI 回复由本机 LMStudio 加载的模型生成，数据不出内网；请确保 LMStudio 服务已启动。',
};

/** 统计大数字卡（2×2 网格中的单格） */
function StatTile({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <Box
      className="flex flex-col items-center justify-center gap-0.5 py-2.5"
      sx={{ bgcolor: 'action.hover', borderRadius: 2 }}
    >
      <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
        {value}
      </Typography>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>
        {label}
      </Typography>
    </Box>
  );
}

/** 常错表达单行（❌ pattern → ✅ corrected + 问题类型 + 次数） */
function MistakeRow({ mistake }: { mistake: MistakePattern }): JSX.Element {
  return (
    <Box className="flex flex-col gap-1" sx={{ bgcolor: 'action.hover', borderRadius: 1.5, p: 1.25 }}>
      <Box className="flex flex-wrap items-center gap-1.5">
        <Chip
          label={issueLabel(mistake.issue)}
          size="small"
          color="warning"
          variant="outlined"
          sx={{ height: 22 }}
        />
        <Box component="span" className="text-[12px]" sx={{ color: 'text.secondary' }}>
          出现 {mistake.count} 次
        </Box>
      </Box>
      <Box className="text-[13px]" sx={{ color: 'text.secondary', wordBreak: 'break-word' }}>
        ❌ {mistake.pattern}
      </Box>
      <Box className="text-[14px]" sx={{ wordBreak: 'break-word' }}>
        ✅ {mistake.corrected}
      </Box>
    </Box>
  );
}

/** 画像加载失败的内联重试块 */
function RetryBlock({ message, onRetry }: { message: string; onRetry: () => void }): JSX.Element {
  return (
    <Box className="flex items-center justify-between gap-2">
      <Typography variant="body2" sx={{ color: 'text.secondary' }}>
        {message}
      </Typography>
      <Button size="small" variant="outlined" onClick={onRetry} sx={{ flexShrink: 0 }}>
        重试
      </Button>
    </Box>
  );
}

export default function SettingsPage(): JSX.Element {
  const ttsEnabled = useSettingsStore((state) => state.ttsEnabled);
  const ttsRate = useSettingsStore((state) => state.ttsRate);
  const setTtsEnabled = useSettingsStore((state) => state.setTtsEnabled);
  const setTtsRate = useSettingsStore((state) => state.setTtsRate);

  const [config, setConfig] = useState<ConfigData | null>(null);
  const [configFailed, setConfigFailed] = useState(false);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [profileFailed, setProfileFailed] = useState(false);
  /** display_name 编辑草稿（初值来自 GET /api/profile） */
  const [nameDraft, setNameDraft] = useState('');
  const [savingName, setSavingName] = useState(false);
  /** 访问令牌草稿（后端启用 ACCESS_TOKEN 时才需要；留空 = 不使用令牌） */
  const [tokenDraft, setTokenDraft] = useState(() => getAccessToken());

  const loadConfig = useCallback((): void => {
    setConfigFailed(false);
    void api
      .getConfig({ silent: true })
      .then(setConfig)
      .catch(() => setConfigFailed(true));
  }, []);

  const loadProfile = useCallback((): void => {
    setProfileFailed(false);
    void api
      .getProfile({ silent: true })
      .then((data) => {
        setProfile(data);
        setNameDraft(data.display_name);
      })
      .catch(() => setProfileFailed(true));
  }, []);

  useEffect(() => {
    loadConfig();
    loadProfile();
  }, [loadConfig, loadProfile]);

  /** 本地即时生效；停止拖动时提交后端（画像 settings 多端同步预留） */
  const commitSettings = (next: { tts_enabled: boolean; tts_rate: number }): void => {
    void api.updateProfile({ settings: next }).catch(() => undefined);
  };

  /** 保存称呼（PATCH /api/profile；错误经 client.ts 自动全局 Toast，此处无需重复提示） */
  const saveDisplayName = (): void => {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      notifyWarning('称呼不能为空');
      return;
    }
    if (trimmed.length > 30) {
      notifyWarning('称呼需为 1–30 个字符');
      return;
    }
    setSavingName(true);
    void api
      .updateProfile({ display_name: trimmed })
      .then((data) => {
        setNameDraft(data.profile.display_name);
        setProfile((prev) => (prev === null ? prev : { ...prev, display_name: data.profile.display_name }));
        notifySuccess('称呼已更新');
      })
      .catch(() => undefined)
      .finally(() => setSavingName(false));
  };

  /** 保存访问令牌：仅存本机 localStorage，保存后刷新数据验证是否通过鉴权 */
  const saveAccessToken = (): void => {
    setAccessToken(tokenDraft.trim());
    notifySuccess(tokenDraft.trim() === '' ? '已清除访问令牌' : '访问令牌已保存到本机');
    loadConfig();
    loadProfile();
  };

  const topMistakes = profile === null ? [] : profile.common_mistakes.slice(0, 5);
  const topScenes = profile === null ? [] : profile.preferred_scenes.slice(0, 3);
  const nameUnchanged =
    profile === null || nameDraft.trim() === profile.display_name || nameDraft.trim().length === 0;
  const providerLabel = config === null ? '' : PROVIDER_LABEL[config.llm.provider] ?? config.llm.provider;
  const providerHint = config === null ? '' : PROVIDER_HINT[config.llm.provider] ?? '';

  return (
    <Box className="flex h-full min-h-0 flex-col">
      <Box
        component="header"
        className="pt-safe flex items-center px-3"
        sx={{ minHeight: 52, bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider' }}
      >
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          设置
        </Typography>
      </Box>

      <Box className="thin-scroll flex-1 min-h-0 overflow-y-auto px-3 py-3">
        {/* ---------- TTS 控制（P1-1：即时生效） ---------- */}
        <Card variant="outlined" sx={{ borderRadius: 2.5 }}>
          <CardContent className="flex flex-col gap-2">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              语音播报（TTS）
            </Typography>
            <FormControlLabel
              control={
                <Switch
                  checked={ttsEnabled}
                  onChange={(event) => {
                    setTtsEnabled(event.target.checked);
                    commitSettings({ tts_enabled: event.target.checked, tts_rate: ttsRate });
                  }}
                />
              }
              label="AI 回复自动语音播报"
            />
            <Box className={ttsEnabled ? 'flex flex-col gap-1' : 'flex flex-col gap-1 opacity-50 pointer-events-none'}>
              <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                语速：{ttsRate.toFixed(2)}x
              </Typography>
              <Slider
                value={ttsRate}
                min={TTS_RATE_MIN}
                max={TTS_RATE_MAX}
                step={0.25}
                marks={[
                  { value: 0.75, label: '0.75x' },
                  { value: 1, label: '1x' },
                  { value: 1.25, label: '1.25x' },
                ]}
                valueLabelDisplay="auto"
                disabled={!ttsEnabled}
                onChange={(_event, value) => setTtsRate(value as number)}
                onChangeCommitted={(_event, value) =>
                  commitSettings({ tts_enabled: ttsEnabled, tts_rate: value as number })
                }
              />
            </Box>
          </CardContent>
        </Card>

        {/* ---------- 访问令牌（后端启用 ACCESS_TOKEN 时填写） ---------- */}
        <Card variant="outlined" sx={{ borderRadius: 2.5, mt: 2 }}>
          <CardContent className="flex flex-col gap-2">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              访问令牌
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              仅当后端配置了 ACCESS_TOKEN 时才需要填写，留空表示不使用令牌（本机/局域网默认形态）。
              令牌只保存在本机浏览器，不会随分享链接外泄。
            </Typography>
            <TextField
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              placeholder="粘贴后端 ACCESS_TOKEN"
              size="small"
              fullWidth
              type="password"
              autoComplete="off"
              inputProps={{ 'aria-label': '访问令牌' }}
            />
            <Button
              variant="outlined"
              size="small"
              onClick={saveAccessToken}
              disabled={tokenDraft.trim() === getAccessToken()}
            >
              保存并重新连接
            </Button>
          </CardContent>
        </Card>

        {/* ---------- 学习画像（P1-6：GET /api/profile） ---------- */}
        <Card variant="outlined" sx={{ borderRadius: 2.5, mt: 2 }}>
          <CardContent className="flex flex-col gap-2.5">
            <Box className="flex items-center justify-between">
              <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                学习画像
              </Typography>
              <IconButton
                size="small"
                aria-label="刷新画像"
                onClick={loadProfile}
                disabled={profileFailed ? false : profile === null}
              >
                <RefreshIcon sx={{ fontSize: 18 }} />
              </IconButton>
            </Box>

            {profileFailed ? (
              <RetryBlock message="画像加载失败，请检查后端服务" onRetry={loadProfile} />
            ) : profile === null ? (
              <Box className="flex flex-col gap-1.5">
                <Skeleton variant="rounded" height={44} />
                <Skeleton variant="rounded" height={72} />
                <Skeleton variant="rounded" height={56} />
              </Box>
            ) : (
              <Box className="flex flex-col gap-2.5">
                {/* display_name 编辑：AI 伙伴对用户的称呼 */}
                <TextField
                  size="small"
                  label="AI 对你的称呼"
                  placeholder="如 Darrell"
                  value={nameDraft}
                  onChange={(event) => setNameDraft(event.target.value)}
                  inputProps={{ maxLength: 30 }}
                  helperText="保存在学习画像中，用于 AI 伙伴称呼你（1–30 字符）"
                />
                <Button
                  variant="outlined"
                  size="small"
                  disabled={nameUnchanged || savingName}
                  onClick={saveDisplayName}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  {savingName ? '保存中…' : '保存称呼'}
                </Button>

                {/* 统计：会话 / 消息 / 词汇 / 已掌握 */}
                <Box className="grid grid-cols-2 gap-2">
                  <StatTile label="练习会话" value={profile.stats.session_count} />
                  <StatTile label="对话消息" value={profile.stats.message_count} />
                  <StatTile label="词汇本词条" value={profile.stats.word_count} />
                  <StatTile label="已掌握词汇" value={profile.stats.mastered_count} />
                </Box>

                {/* 常错表达 Top5 */}
                <Box className="flex flex-col gap-1.5">
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                    常错表达 Top {topMistakes.length}
                  </Typography>
                  {topMistakes.length === 0 ? (
                    <Typography variant="body2" sx={{ color: 'text.disabled' }}>
                      暂无记录——多说多练，AI 会在这里帮你记住反复出错的表达。
                    </Typography>
                  ) : (
                    topMistakes.map((mistake) => <MistakeRow key={mistake.pattern} mistake={mistake} />)
                  )}
                </Box>

                {/* 高频场景 Top3 */}
                <Box className="flex flex-col gap-1.5">
                  <Typography variant="body2" sx={{ fontWeight: 600, color: 'text.secondary' }}>
                    高频场景 Top {topScenes.length}
                  </Typography>
                  {topScenes.length === 0 ? (
                    <Typography variant="body2" sx={{ color: 'text.disabled' }}>
                      还没有练习记录，去场景页开启第一场对话吧。
                    </Typography>
                  ) : (
                    <Box className="flex flex-wrap gap-1.5">
                      {topScenes.map((scene) => (
                        <Chip
                          key={scene.scene_id}
                          size="small"
                          variant="outlined"
                          label={`${getSceneName(scene.scene_id)} · ${scene.count} 次`}
                          sx={{ height: 26 }}
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              </Box>
            )}
          </CardContent>
        </Card>

        {/* ---------- LLM 服务信息（GET /api/config） ---------- */}
        <Card variant="outlined" sx={{ borderRadius: 2.5, mt: 2 }}>
          <CardContent className="flex flex-col gap-2">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              LLM 服务
            </Typography>
            {configFailed ? (
              <RetryBlock message="服务信息加载失败" onRetry={loadConfig} />
            ) : config === null ? (
              <Skeleton variant="rounded" height={72} />
            ) : (
              <Box className="flex flex-col gap-1.5">
                <Box className="flex items-center justify-between">
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    当前服务
                  </Typography>
                  <Chip size="small" color="primary" variant="outlined" label={providerLabel} sx={{ height: 26 }} />
                </Box>
                <Box className="flex items-center justify-between">
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    模型
                  </Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-all', textAlign: 'right' }}>
                    {config.llm.model}
                  </Typography>
                </Box>
                {providerHint !== '' && (
                  <Typography variant="caption" sx={{ color: 'text.secondary', lineHeight: 1.6 }}>
                    {providerHint}
                  </Typography>
                )}
              </Box>
            )}
          </CardContent>
        </Card>

        {/* ---------- 应用信息 ---------- */}
        <Card variant="outlined" sx={{ borderRadius: 2.5, mt: 2 }}>
          <CardContent className="flex flex-col gap-2">
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              应用信息
            </Typography>
            {config === null ? (
              <Skeleton variant="rounded" height={56} />
            ) : (
              <Box className="flex flex-col gap-1.5">
                <Box className="flex items-center justify-between">
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    产品名称
                  </Typography>
                  <Typography variant="body2">{config.app_name}</Typography>
                </Box>
                <Box className="flex items-center justify-between">
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    语音引擎
                  </Typography>
                  <Typography variant="body2">{config.tts.engine}（浏览器本地合成）</Typography>
                </Box>
                <Box className="flex items-center justify-between">
                  <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                    版本
                  </Typography>
                  <Typography variant="body2">v{config.version}</Typography>
                </Box>
              </Box>
            )}
          </CardContent>
        </Card>

        <Divider sx={{ mt: 3 }} />
        <Typography
          variant="caption"
          sx={{ color: 'text.disabled', display: 'block', textAlign: 'center', mt: 2 }}
        >
          SpeakMate（口语搭子）· 浏览器语音识别由浏览器厂商服务处理，音频不出设备
        </Typography>
      </Box>
    </Box>
  );
}
