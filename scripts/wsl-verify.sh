#!/usr/bin/env bash
#
# WSL2 一键验证脚本（SpeakMate）
#
# 作用：把代码落到 Linux 原生文件系统 → 装依赖 → 类型检查 → 构建 → 跑全量测试
#      → 启动后端冒烟（含 SIGTERM 优雅停机验证，Windows 上做不到）。
#
# 用法（在 WSL 的 bash 里执行）：
#
#   1) 从 Windows 源码目录复制（默认，无需网络）：
#        bash wsl-verify.sh
#        LOCAL_SRC=/mnt/d/Work/SpeakMate bash wsl-verify.sh
#
#   2) 从 git 仓库克隆：
#        REPO_URL=https://github.com/<you>/speakmate.git bash wsl-verify.sh
#
# 可选环境变量：
#   WORKDIR      目标目录，默认 $HOME/workspace/speakmate
#   LOCAL_SRC    Windows 源码挂载路径，默认 /mnt/d/Work/SpeakMate
#   REPO_URL     非空时优先用 git clone
#   PORT         冒烟端口，默认 3001
#   SKIP_SMOKE   设为 1 只跑构建与测试，不做启动冒烟
#   RELAX_SUPPLY_CHAIN
#                设为 1 时给所有 pnpm 命令附加 --config.minimum-release-age=0，
#                跳过 pnpm 11 的「包发布不足 24 小时则拒绝安装」策略。
#                仅在你需要立刻跑通、且能接受该风险时使用。
#
set -euo pipefail

WORKDIR="${WORKDIR:-$HOME/workspace/speakmate}"
LOCAL_SRC="${LOCAL_SRC:-/mnt/d/Work/SpeakMate}"
REPO_URL="${REPO_URL:-}"
PORT="${PORT:-3001}"
SKIP_SMOKE="${SKIP_SMOKE:-0}"
RELAX_SUPPLY_CHAIN="${RELAX_SUPPLY_CHAIN:-0}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
ok()   { printf '\033[1;32m[OK]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; }
die()  { printf '\n\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 0. 环境检查
log "0/7 检查运行环境"

# 注意：判断依据是「项目要放到哪（WORKDIR）」，而不是「本脚本在哪」。
# 脚本本身放在 Windows 侧（/mnt/d/...）用 wsl.exe 直接调起是很常见的用法，不该拦。
case "$WORKDIR" in
  /mnt/*) die "WORKDIR 不能在 /mnt 下（当前：$WORKDIR）。跨文件系统 IO 慢一个数量级，且 SQLite 在 Windows 文件系统上的锁行为不可靠。请改用 Linux 原生路径，如 \$HOME/workspace/speakmate。" ;;
  /*) ;;
  *) WORKDIR="$(cd "$(dirname "$WORKDIR")" && pwd)/$(basename "$WORKDIR")" ;;
esac
[ -n "$WORKDIR" ] && [ "$WORKDIR" != "/" ] || die "WORKDIR 无效：$WORKDIR"

command -v node >/dev/null 2>&1 || die "未找到 node。请先装 Node 20 LTS（见 DEPLOYMENT.md 方案C）。"

# WSL 默认开启 appendWindowsPath，会把 Windows 的 PATH 追加进来。
# 后果：command -v node / npm / corepack 可能命中 /mnt/c/... 下的 Windows 程序，
# 它们在 Linux 上要么报 "required file not found"，要么行为诡异。
# 这里把 /mnt/* 段全部剔除，确保后续用的是 Linux 原生工具链。
BEFORE_PATH="$PATH"
PATH="$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '^/mnt/' | paste -sd: -)"
export PATH
if [ "$BEFORE_PATH" != "$PATH" ]; then
  warn "已从 PATH 中剔除 Windows 路径（/mnt/*），避免误用 Windows 版 node/npm/corepack"
fi

NODE_BIN="$(command -v node)"
case "$NODE_BIN" in
  /mnt/*) die "node 解析到了 Windows 路径：$NODE_BIN。请在 WSL 内安装 Linux 版 Node。" ;;
esac

# 把 node 真实安装目录补进 PATH。
# 很多环境（nvm / 手动安装）只在 /usr/local/bin 放 node、npm 两个软链，
# 而 npm -g 安装的 pnpm、corepack 会落在真正的 bin 目录里 —— 该目录常常不在 PATH 上，
# 结果就是「装上了却 command not found」。这里按 node 的真实路径把它补回来。
NODE_REAL="$(readlink -f "$NODE_BIN" 2>/dev/null || printf '%s' "$NODE_BIN")"
NODE_BIN_DIR="$(dirname "$NODE_REAL")"
case ":$PATH:" in
  *":$NODE_BIN_DIR:"*) ;;
  *) PATH="$NODE_BIN_DIR:$PATH"; export PATH; warn "已补充 node 安装目录到 PATH：$NODE_BIN_DIR" ;;
esac

NODE_VERSION="$(node -v | sed 's/^v//')"
NODE_MAJOR="$(echo "$NODE_VERSION" | cut -d. -f1)"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 18 ] || { [ "$NODE_MAJOR" -eq 18 ] && [ "$NODE_MINOR" -lt 17 ]; }; then
  die "Node 版本过低：$NODE_VERSION（要求 >= 18.17）"
fi
ok "node $NODE_VERSION"

# ---------------------------------------------------------------- 1. 准备源码
log "1/7 准备源码 → $WORKDIR"

mkdir -p "$(dirname "$WORKDIR")"

# 覆盖前给一次反悔机会：目标目录可能已有你自己的东西
if [ -e "$WORKDIR" ]; then
  warn "即将覆盖已存在的目录：$WORKDIR"
  warn "3 秒后继续（Ctrl+C 可取消；换目录用 WORKDIR=... 指定）"
  sleep 3
fi

if [ -n "$REPO_URL" ]; then
  rm -rf "$WORKDIR"
  git clone "$REPO_URL" "$WORKDIR" || die "git clone 失败：$REPO_URL"
  ok "已从 $REPO_URL 克隆"
else
  [ -d "$LOCAL_SRC" ] || die "源码目录不存在：$LOCAL_SRC（可用 LOCAL_SRC=... 指定，或改用 REPO_URL 克隆）"
  rm -rf "$WORKDIR"
  mkdir -p "$WORKDIR"
  # 关键：必须排除 node_modules / dist —— Windows 下编译的 better-sqlite3 原生模块
  # 在 Linux 上无法加载，带过去会直接崩。
  tar -C "$LOCAL_SRC" \
      --exclude='./node_modules' --exclude='node_modules' \
      --exclude='./dist' --exclude='dist' \
      --exclude='./.git' --exclude='.git' \
      --exclude='./.workbuddy' --exclude='.workbuddy' \
      --exclude='./backend/data' --exclude='backend/data' \
      --exclude='./.data-test' --exclude='.data-test' \
      -cf - . | tar -C "$WORKDIR" -xf -
  ok "已从 $LOCAL_SRC 复制（已排除 node_modules / dist / data）"
fi

cd "$WORKDIR"

# ---------------------------------------------------------------- 2. 包管理器
log "2/7 准备 pnpm"

# 原则：优先复用环境里已有的 pnpm，绝不另装一个不同大版本。
#
# 教训（真实踩过）：pnpm 9 / 10 / 11 的 store 目录互不兼容（v3 / v10 / v11）。
# 同一项目被两个版本的 pnpm 装过后，再切回另一个版本就会报
#     ERR_PNPM_UNEXPECTED_STORE
# 而且新装的 pnpm 常因 PATH 优先级抢占前者，现象是「昨天还好好的，今天全崩了」，
# 排查成本极高。所以这里只在完全没有 pnpm 时才装，且装最新版而非固定旧版。
# pnpm 发现逻辑分三步：登录 shell 解析 → 常见安装位置 → 才考虑安装。
#
# 为什么不能直接 command -v：pnpm 官方安装脚本把它放在 ~/.local/share/pnpm/bin，
# 并把 PATH 写进 ~/.bashrc。而 `wsl.exe bash script.sh` 这种非交互 shell 不加载
# ~/.bashrc，于是「用户交互式终端里明明有 pnpm，脚本里却 command not found」。
# 直接用 bash -lc 问登录 shell 最贴近用户真实环境，也最不容易出错。
if ! command -v pnpm >/dev/null 2>&1; then
  # -l（登录 shell）还不够：Ubuntu 默认的 ~/.bashrc 开头就有
  #     case $- in *i*) ;; *) return;; esac
  # 非交互时直接 return，nvm 与 pnpm 的 PATH 都不会被设置。所以再试一次 -i。
  PROFILE_PNPM="$(bash -lc 'command -v pnpm' 2>/dev/null | tail -1 || true)"
  [ -n "$PROFILE_PNPM" ] || PROFILE_PNPM="$(bash -ic 'command -v pnpm' 2>/dev/null | tail -1 || true)"
  case "$PROFILE_PNPM" in
    ""|/mnt/*) PROFILE_PNPM="" ;;   # 空 或 Windows 版 pnpm（不能在 Linux 上跑）
  esac
  if [ -n "$PROFILE_PNPM" ] && [ -x "$PROFILE_PNPM" ]; then
    PATH="$(dirname "$PROFILE_PNPM"):$PATH"; export PATH
    warn "从登录 shell 解析到 pnpm（$PROFILE_PNPM），已加入 PATH"
  fi
fi

# 登录 shell 也没找到时，再扫一遍常见安装位置
if ! command -v pnpm >/dev/null 2>&1; then
  for cand in \
    "$HOME/.local/share/pnpm/pnpm" \
    "$HOME/.local/share/pnpm/bin/pnpm" \
    "$(npm prefix -g 2>/dev/null)/bin/pnpm" \
    "/usr/local/bin/pnpm" \
    "/usr/bin/pnpm"; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    PATH="$(dirname "$cand"):$PATH"; export PATH
    warn "在 $(dirname "$cand") 找到 pnpm，已加入 PATH"
    break
  done
fi

if ! command -v pnpm >/dev/null 2>&1; then
  warn "未找到 pnpm，尝试通过 corepack 启用（需要联网，最多等 3 分钟）"
  # 必须限时：corepack prepare 在弱网/代理环境下可能长时间挂起，
  # 曾出现脚本卡住 11 分钟看起来像死机的情况。
  corepack enable >/dev/null 2>&1 || true
  timeout 180 corepack prepare pnpm@latest --activate >/dev/null 2>&1 \
    || timeout 180 npm install -g pnpm@latest >/dev/null 2>&1 \
    || die "pnpm 安装失败或超时。请手动执行：corepack enable && corepack prepare pnpm@latest --activate"
fi

# 校验 pnpm 真的可用（"装上了但不在 PATH 上"是 WSL 环境的高频问题）
PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
[ -n "$PNPM_BIN" ] || die "pnpm 已安装但无法执行，请检查 PATH（node 的 bin 目录是否在其中）"
PNPM_VERSION="$("$PNPM_BIN" -v 2>/dev/null || true)"
[ -n "$PNPM_VERSION" ] || die "pnpm 无法执行：$PNPM_BIN -v 无输出"
ok "pnpm $PNPM_VERSION（$PNPM_BIN）"

# PATH 上存在多个 pnpm 是 store 版本冲突的头号成因，提前暴露
OTHER_PNPM="$(which -a pnpm 2>/dev/null | grep -vxF "$PNPM_BIN" | head -3 || true)"
if [ -n "$OTHER_PNPM" ]; then
  warn "PATH 上还有其他 pnpm 实例，混用会触发 ERR_PNPM_UNEXPECTED_STORE："
  printf '%s\n' "$OTHER_PNPM" | sed 's/^/         /'
  warn "本次统一使用：$PNPM_BIN（如已报 store 错误，见 DEPLOYMENT.md 方案C 的排查表）"
fi

# ---------------------------------------------------------------- 3. 安装依赖
log "3/7 安装依赖（backend + frontend）"

# 装之前先检查 pnpm-workspace.yaml 是否处于「pnpm 生成的待填写模板」状态。
# pnpm 10+ 拦截构建脚本时会自动落一个残缺模板：
#     allowBuilds:
#       better-sqlite3: set this to true or false
# 它缺 packages 字段，会让 pnpm 9 报 "packages field missing or empty"，
# 且一旦出现，该目录下任何 pnpm 命令都跑不起来。
for d in backend frontend; do
  f="$WORKDIR/$d/pnpm-workspace.yaml"
  # 匹配必须锚定到「非注释行」：该文件自身的说明注释里就可能提到这段占位文字，
  # 裸 grep 会误判（踩过：把仓库里的正确文件当成残缺模板，直接 die）。
  if [ -f "$f" ] && grep -qE '^[[:space:]]+[^#[:space:]]+:[[:space:]]*set this to true or false' "$f" 2>/dev/null; then
    die "$d/pnpm-workspace.yaml 是 pnpm 生成的待填写模板（allowBuilds 的值是占位文字），会让构建持续被拦截。
  修法：删除该文件，然后在 $d/ 下新建 pnpm-workspace.yaml，内容为
      packages:
        - '.'
      allowBuilds:
        better-sqlite3: true
        esbuild: true
  注意 pnpm 11 的键名是 allowBuilds（值为布尔），不是 onlyBuiltDependencies。
  或临时执行：cd $d && pnpm approve-builds --all"
  fi
done

# pnpm 11 内置「供应链策略」：默认拒绝发布不足 24 小时的包（minimumReleaseAge 默认 1440 分钟）。
# 这是真实的安全防护，默认不绕过；仅在显式设置 RELAX_SUPPLY_CHAIN=1 时才放宽。
RELAX_FLAG=""
if [ "$RELAX_SUPPLY_CHAIN" = "1" ]; then
  RELAX_FLAG="--config.minimum-release-age=0"
  warn "RELAX_SUPPLY_CHAIN=1：本次安装将跳过 pnpm 的 24 小时发布年龄校验"
fi

# 安装 + 失败分类诊断。
# pnpm 11 的报错往往指错方向：构建脚本被拦截时，install 本身可能仍返回 0，
# 真正的失败延迟到 `pnpm start`/`pnpm test` 触发的自动 install 时才爆出来。
# 所以这里统一按错误码分类，直接给出可执行的处置建议。
install_pkg() {
  # 必须拆成两行：bash 会先展开整条命令的单词再执行赋值，
  # 写成 local pkg="$1" logfile="/tmp/pnpm-$pkg.log" 时 $pkg 尚未定义（set -u 下报错）。
  local pkg="$1"
  local logfile="/tmp/pnpm-$pkg.log"

  if ! ( cd "$pkg" && "$PNPM_BIN" $RELAX_FLAG install ) 2>"$logfile"; then
    tail -25 "$logfile"

    if grep -q 'ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION' "$logfile"; then
      grep -E 'was published at|ERR_PNPM_MINIMUM' "$logfile" | sed 's/^/    /'
      die "$pkg 依赖被 pnpm 的供应链策略拒绝：锁定版本发布不足 24 小时。
  这是 pnpm 11 的内置防护（拦截刚发布即被投毒的包），三种处置：
    1) 等这些版本满 24 小时再装（最干净，锁文件不用动）；
    2) 本次放宽重跑：RELAX_SUPPLY_CHAIN=1 bash wsl-verify.sh；
    3) 单独执行：cd $pkg && pnpm --config.minimum-release-age=0 install
  注意：环境变量 npm_config_minimum_release_age 对该设置无效，必须用 --config. 传参。"

    elif grep -qiE 'ERR_PNPM_IGNORED_BUILDS|Ignored build scripts' "$logfile"; then
      grep -iE 'Ignored build scripts' "$logfile" | sed 's/^/    /'
      die "$pkg 的依赖构建脚本被拦截，原生模块不会被编译。
  pnpm 11 的键名是 allowBuilds（值为 true/false），不是 onlyBuiltDependencies；
  只写后者仍会被 pnpm 追加待填写模板。
  修法：把包名写进 $pkg/pnpm-workspace.yaml 的 allowBuilds，然后重跑本脚本；
       或临时执行：cd $pkg && pnpm approve-builds --all"

    else
      die "$pkg 依赖安装失败。若报 node-gyp / prebuild 错误，先执行：
    sudo apt update && sudo apt install -y build-essential python3"
    fi
  fi

  # 构建拦截也可能表现为「退出码 0，但什么都没编译」的静默失败，再查一次
  if grep -qiE 'ERR_PNPM_IGNORED_BUILDS|Ignored build scripts' "$logfile"; then
    grep -iE 'Ignored build scripts' "$logfile" | sed 's/^/    /'
    die "$pkg 的依赖构建脚本被拦截（安装退出码为 0，但原生模块/二进制不会生成）。
  修法：把包名写进 $pkg/pnpm-workspace.yaml 的 allowBuilds（pnpm 11 键名）。"
  fi

  ok "$pkg 依赖就绪"
}

install_pkg backend
install_pkg frontend

# 原生模块是「装成功但跑不起来」的高发点，直接断言产物存在
if [ -z "$(find backend/node_modules/.pnpm -name 'better_sqlite3.node' 2>/dev/null | head -1)" ]; then
  die "未找到 better_sqlite3.node，原生模块未编译成功。见上方安装日志。"
fi
ok "better-sqlite3 原生模块已编译"

# ---------------------------------------------------------------- 4. 类型检查
log "4/7 类型检查（双端）"

( cd backend && "$PNPM_BIN" $RELAX_FLAG run typecheck ) || die "backend tsc --noEmit 未通过"
ok "backend 类型检查通过"

( cd frontend && "$PNPM_BIN" $RELAX_FLAG run typecheck ) || die "frontend tsc --noEmit 未通过"
ok "frontend 类型检查通过"

# ---------------------------------------------------------------- 5. 构建 + 测试
log "5/7 前端构建"

( cd frontend && "$PNPM_BIN" $RELAX_FLAG run build ) || die "前端生产构建失败"
ok "前端构建通过（frontend/dist）"

log "6/7 全量测试（backend）"
( cd backend && "$PNPM_BIN" $RELAX_FLAG run test ) || die "后端测试未通过"
ok "后端测试通过"

log "6/7 全量测试（frontend）"
( cd frontend && "$PNPM_BIN" $RELAX_FLAG run test ) || die "前端测试未通过"
ok "前端测试通过"

# ---------------------------------------------------------------- 6. 启动冒烟
if [ "$SKIP_SMOKE" = "1" ]; then
  log "7/7 已跳过启动冒烟（SKIP_SMOKE=1）"
  printf '\n\033[1;32m全部验证通过\033[0m（目录：%s）\n' "$WORKDIR"
  exit 0
fi

log "7/7 启动冒烟 + SIGTERM 优雅停机验证（端口 $PORT）"

cd "$WORKDIR/backend"

# ---- 7-a：先验证用户真正会敲的那条命令 pnpm start ----
# 它比直接跑 tsx 多一层 pnpm 的 workspace / script 解析，而故障恰恰出在这一层
# （pnpm-workspace.yaml 缺 packages 字段 → ERROR packages field missing or empty）。
# 只测 tsx 会漏掉它，所以这里必须单独跑一次。
START_PORT="$((PORT + 1))"
log "7/7-a 冒烟：pnpm start（端口 $START_PORT）"

rm -rf .data-start
DATA_DIR="$WORKDIR/backend/.data-start" LLM_PROVIDER=mock PORT="$START_PORT" \
  "$PNPM_BIN" $RELAX_FLAG start > /tmp/speakmate-start.log 2>&1 &
PSTART_PID=$!

PSTART_OK=""
for _ in $(seq 1 30); do
  if PSTART_OK="$(curl -fsS --noproxy '*' "http://127.0.0.1:$START_PORT/api/health" 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [ -z "$PSTART_OK" ]; then
  echo "--- pnpm start 日志尾部 ---"; tail -25 /tmp/speakmate-start.log
  kill -9 "$PSTART_PID" 2>/dev/null || true
  wait "$PSTART_PID" 2>/dev/null || true
  rm -rf .data-start
  die "pnpm start 未能在 30s 内启动。最常见原因是 pnpm-workspace.yaml 缺 packages 字段，
  详见 DEPLOYMENT.md 方案C 的排查表。"
fi
ok "pnpm start 可用：$PSTART_OK"

# pnpm 是包装进程，SIGKILL 打在它身上带不走子进程，这里按进程名兜底清理
kill -9 "$PSTART_PID" 2>/dev/null || true
wait "$PSTART_PID" 2>/dev/null || true
if command -v pkill >/dev/null 2>&1; then
  pkill -9 -f 'tsx src/index.ts' 2>/dev/null || true
fi
rm -rf .data-start

# ---- 7-b：SIGTERM 优雅停机（必须直接调 tsx）----
rm -rf .data-smoke
# 直接调 tsx 可执行文件（而非 pnpm start），确保 $! 就是 node 进程本身，
# 这样 SIGTERM 能被后端的 shutdown() 收到——Windows 上无法做这个验证。
DATA_DIR="$WORKDIR/backend/.data-smoke" LLM_PROVIDER=mock PORT="$PORT" \
  ./node_modules/.bin/tsx src/index.ts > /tmp/speakmate-smoke.log 2>&1 &
SMOKE_PID=$!

HEALTH=""
for _ in $(seq 1 30); do
  if HEALTH="$(curl -fsS --noproxy '*' "http://127.0.0.1:$PORT/api/health" 2>/dev/null)"; then
    break
  fi
  sleep 1
done

if [ -z "$HEALTH" ]; then
  echo "--- 后端启动日志 ---"; tail -20 /tmp/speakmate-smoke.log
  kill -9 "$SMOKE_PID" 2>/dev/null || true
  die "后端未能在 30s 内就绪，/api/health 无响应"
fi
ok "健康检查通过：$HEALTH"

# 顺带验证鉴权开关（不配 ACCESS_TOKEN 时应直接放行）
CODE_NO_TOKEN="$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/scenes" || true)"
[ "$CODE_NO_TOKEN" = "200" ] || die "未配置 ACCESS_TOKEN 时 /api/scenes 应返回 200，实际 $CODE_NO_TOKEN"
ok "未启用令牌时接口正常放行（200）"

kill -TERM "$SMOKE_PID" 2>/dev/null || true
SMOKE_EXIT=0
wait "$SMOKE_PID" 2>/dev/null || SMOKE_EXIT=$?
[ "$SMOKE_EXIT" -eq 0 ] || die "优雅停机退出码异常：$SMOKE_EXIT（期望 0，即 shutdown() 正常收尾并关闭数据库）"
ok "SIGTERM 优雅停机正常（退出码 0，数据库已关闭）"

if grep -q "shutting down" /tmp/speakmate-smoke.log; then
  ok "停机日志已打印 shutting down"
else
  warn "日志中未找到 'shutting down' 字样，请人工确认停机流程"
fi

rm -rf "$WORKDIR/backend/.data-smoke"

printf '\n\033[1;32m全部验证通过\033[0m（目录：%s）\n' "$WORKDIR"
printf '下一步：cd %s/backend && cp .env.example .env && pnpm start\n' "$WORKDIR"
