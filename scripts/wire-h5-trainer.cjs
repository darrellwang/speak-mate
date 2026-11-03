const fs = require("fs");

const bottomNav = [
  "/**",
  " * 底部导航（架构文档 §2 components/layout/BottomNav.tsx）。",
  " *",
  " * 对话 / 训练 / 词汇本 / 历史 / 设置；",
  " * 「训练」打开独立 karat 风格页 /trainer.html（最新 handbook 数据）；",
  " * /scenes 归属对话域高亮；底部 safe-area padding。",
  " */",
  "import { useLocation, useNavigate } from 'react-router-dom';",
  "import BottomNavigation from '@mui/material/BottomNavigation';",
  "import BottomNavigationAction from '@mui/material/BottomNavigationAction';",
  "import Paper from '@mui/material/Paper';",
  "import { BookIcon, ChatIcon, HistoryIcon, SchoolIcon, SettingsIcon } from '../icons';",
  "",
  "interface TabConfig {",
  "  value: string;",
  "  label: string;",
  "  icon: JSX.Element;",
  "  /** 外部静态页（离开 SPA） */",
  "  external?: boolean;",
  "}",
  "",
  "const TABS: TabConfig[] = [",
  "  { value: '/', label: '对话', icon: <ChatIcon /> },",
  "  { value: '/trainer.html', label: '训练', icon: <SchoolIcon />, external: true },",
  "  { value: '/words', label: '词汇本', icon: <BookIcon /> },",
  "  { value: '/history', label: '历史', icon: <HistoryIcon /> },",
  "  { value: '/settings', label: '设置', icon: <SettingsIcon /> },",
  "];",
  "",
  "/** 当前高亮 Tab：/ 与 /scenes → 对话；其余前缀匹配 */",
  "function resolveActiveTab(pathname: string): string {",
  "  if (pathname === '/' || pathname.startsWith('/scenes')) return '/';",
  "  const matched = TABS.filter((tab) => tab.value !== '/').find((tab) => {",
  "    const base = tab.value.endsWith('.html') ? tab.value.slice(0, -5) : tab.value;",
  "    return pathname === tab.value || pathname.startsWith(base);",
  "  });",
  "  return matched?.value ?? '/';",
  "}",
  "",
  "export default function BottomNav(): JSX.Element {",
  "  const location = useLocation();",
  "  const navigate = useNavigate();",
  "  const active = resolveActiveTab(location.pathname);",
  "",
  "  return (",
  "    <Paper elevation={0} square sx={{ borderTop: 1, borderColor: 'divider' }}>",
  "      <BottomNavigation",
  "        showLabels",
  "        value={active}",
  "        onChange={(_event, value: string) => {",
  "          const tab = TABS.find((t) => t.value === value);",
  "          if (tab?.external) {",
  "            window.location.assign(tab.value);",
  "            return;",
  "          }",
  "          if (value !== location.pathname) navigate(value);",
  "        }}",
  "        sx={{",
  "          height: 60,",
  "          bgcolor: 'transparent',",
  "          paddingBottom: 'env(safe-area-inset-bottom)',",
  "        }}",
  "      >",
  "        {TABS.map((tab) => (",
  "          <BottomNavigationAction",
  "            key={tab.value}",
  "            value={tab.value}",
  "            label={tab.label}",
  "            icon={tab.icon}",
  "            sx={{ minWidth: 56, py: 0.5 }}",
  "          />",
  "        ))}",
  "      </BottomNavigation>",
  "    </Paper>",
  "  );",
  "}",
  "",
].join("\n");

fs.writeFileSync("frontend/src/components/layout/BottomNav.tsx", bottomNav, "utf8");
console.log("BottomNav written", bottomNav.length);

let h = fs.readFileSync("frontend/public/trainer.html", "utf8");
h = h.replace(/id="buildTag">[^<]*/, "id=\"buildTag\">SpeakMate handbook · 648 句");
if (!h.includes('id="backApp"')) {
  h = h.replace(
    '<header class="head">',
    '<header class="head">\n    <div style="width:100%;margin-bottom:4px"><a id="backApp" href="/" style="font-size:13px;color:var(--brand);text-decoration:none">← 返回 SpeakMate</a></div>'
  );
}
fs.writeFileSync("frontend/public/trainer.html", h, "utf8");
fs.copyFileSync("miniprogram/data/handbook.json", "frontend/public/handbook.json");
console.log("trainer polished", fs.statSync("frontend/public/trainer.html").size);
console.log("handbook copied", fs.statSync("frontend/public/handbook.json").size);