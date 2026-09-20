#!/usr/bin/env bash
# 模拟新成员从零装 —— 推完基线之后跑这个，别等成员踩了才发现问题
#
# 用法：bash scripts/simulate-member.sh v1.6.2
#
# 做法：
#   1. 造一个隔离的 agent 配置目录（PI_CODING_AGENT_DIR），完全不碰本机 ~/.pi/agent
#   2. 从 PATH 里摘掉 rtk（模拟从没装过 rtk 的机器）
#   3. 跑 install → 第一次启动（扩展写清单 + 补 rtk）→ pi list
#   4. 把三条链路的证据打出来，肉眼判断
#
# 判据：User packages 三项齐全（pi-workflow / pi-context-view / pi-rtk-optimizer），
#       且 rtk 落在一个 PATH 能找到的目录里。
set -uo pipefail

V="${1:-}"
if [ -z "$V" ]; then
  echo "用法: bash scripts/simulate-member.sh v1.6.2" >&2
  exit 1
fi
case "$V" in v*) ;; *) echo "版本号要以 v 开头" >&2; exit 1 ;; esac

cd "$(dirname "$0")/.."
REPO_SRC="git:github.com/kurumi1ksllq/pi-workflow@$V"

# PI_CODING_AGENT_DIR 是给原生程序读的，必须是 Windows 路径写法
BASE=$(cygpath -w "$HOME" 2>/dev/null | sed 's|\\|/|g')
[ -n "$BASE" ] || BASE="C:/Users/${USERNAME:-user}"
SB="${PI_SIM_DIR:-$BASE/pi-member-sim}"
mkdir -p "$SB/agent" "$SB/proj"

# 隔离目录没有凭据，pi 启动会直接退出 —— 只拷凭据文件，不拷已装的包
for f in auth.json models.json; do
  [ -f "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$SB/agent/" 2>/dev/null
done

export PI_CODING_AGENT_DIR="$SB/agent"
# 摘掉含 rtk 的目录（本机 rtk 一般在 ~/.local/bin），制造"没装过 rtk"的初始条件
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '\.local/bin' | paste -sd:)

echo "隔离 agent 目录：$SB/agent"
echo "rtk 初始可见性：$(command -v rtk || echo '（不可见 —— 符合模拟条件）')"
echo

echo "=== 1/3 install ==="
pi install "$REPO_SRC" 2>&1 | grep -aE "Installed|error|Error|not exist" | tail -5

echo
echo "=== 2/3 第一次启动（扩展写清单 + 补 rtk）==="
(cd "$SB/proj" && pi -p "ok" 2>&1 | grep -a "team-baseline" || echo "（没有 team-baseline 输出 —— 扩展没跑起来）")

echo
echo "=== 3/3 pi list ==="
(cd "$SB/proj" && pi list 2>&1 | tail -20)

echo
echo "=== rtk 落点 ==="
command -v rtk || echo "（找不到 rtk —— 这一步失败了）"

echo
echo "判据：User packages 三项齐全 + rtk 能被找到。"
echo "清理：rm -rf \"$SB\""
