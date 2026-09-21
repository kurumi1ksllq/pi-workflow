#!/usr/bin/env bash
# 模拟新成员从零装 —— 推完基线之后跑这个，别等成员踩了才发现问题
#
# 用法：bash scripts/simulate-member.sh v1.6.2
#       也可以传分支名（`bash scripts/simulate-member.sh main`）—— 发版前先验主干用
#
# 做法：
#   1. 造一个隔离的 agent 配置目录（PI_CODING_AGENT_DIR），完全不碰本机 ~/.pi/agent
#   2. 从 PATH 里摘掉 rtk（模拟从没装过 rtk 的机器）
#   3. install → 第一次启动（扩展写清单/共享设置/扩展配置 + 补 rtk）→ 第二次启动（清单里的包才装上）→ pi list
#   4. 把各条链路的证据打出来，肉眼判断
#
# 判据：
#   - `pi list` 的 User packages 每一项都**带安装路径**（只看到包名 = 还没装上，缺了第二次启动）
#   - 隔离目录的 npm/node_modules 里确实有清单里的包
#   - rtk 落在一个 PATH 能找到的目录里
#   - 隔离目录 settings.json 里出现 subagents / compaction（共享设置同步）
#   - 隔离目录 extensions/pi-rtk-optimizer/config.json 存在（扩展配置同步）
set -uo pipefail

V="${1:-}"
if [ -z "$V" ]; then
  echo "用法: bash scripts/simulate-member.sh v1.6.2（也可传分支名，如 main）" >&2
  exit 1
fi
cd "$(dirname "$0")/.."
REPO_SRC="git:github.com/kurumi1ksllq/pi-workflow@$V"

# PI_CODING_AGENT_DIR 是给原生程序读的，必须是 Windows 路径写法
BASE=$(cygpath -w "$HOME" 2>/dev/null | sed 's|\\|/|g')
[ -n "$BASE" ] || BASE="C:/Users/${USERNAME:-user}"
SB="${PI_SIM_DIR:-$BASE/pi-member-sim}"
rm -rf "$SB"
mkdir -p "$SB/agent" "$SB/proj"

# 隔离目录没有凭据，pi 启动会直接退出 —— 只拷凭据文件，不拷已装的包
for f in auth.json models.json; do
  [ -f "$HOME/.pi/agent/$f" ] && cp "$HOME/.pi/agent/$f" "$SB/agent/" 2>/dev/null
done

export PI_CODING_AGENT_DIR="$SB/agent"
# 摘掉含 rtk 的目录（本机 rtk 一般在 ~/.local/bin），制造"没装过 rtk"的初始条件
export PATH=$(echo "$PATH" | tr ':' '\n' | grep -v '\.local/bin' | paste -sd:)

echo "隔离 agent 目录：$SB/agent"
echo "安装源：$REPO_SRC"
echo "rtk 初始可见性：$(command -v rtk || echo '（不可见 —— 符合模拟条件）')"
echo

echo "=== 1/6 install ==="
pi install "$REPO_SRC" 2>&1 | grep -aE "Installed|error|Error|not exist" | tail -5

echo
echo "=== 2/6 第一次启动（扩展写清单 + 补共享设置/扩展配置 + 补 rtk）==="
(cd "$SB/proj" && pi -p "ok" 2>&1 | grep -a "team-baseline" || echo "（没有 team-baseline 输出 —— 扩展没跑起来）")

echo
echo "=== 3/6 第二次启动（清单里的包这时才装上）==="
(cd "$SB/proj" && pi -p "ok" 2>&1 | grep -a "team-baseline" || echo "（第二次启动没有 team-baseline 输出 —— 应该安静才对）")

echo
echo "=== 4/6 pi list ==="
(cd "$SB/proj" && pi list 2>&1 | tail -20)

echo
echo "=== 5/6 包装到哪了（有这两个目录才算真装上）==="
ls -d "$SB/agent/git" "$SB/agent/npm/node_modules" 2>/dev/null | sed 's|^|  |'
ls "$SB/agent/npm/node_modules" 2>/dev/null | sed 's|^|  ├─ |'

echo
echo "=== 6/6 各条同步链路的落点 ==="
echo "--- rtk ---"
command -v rtk || echo "  （找不到 rtk —— 这一步失败了）"
echo "--- settings.json（共享设置）---"
node -e '
const fs = require("fs");
const f = process.argv[1];
try {
  const s = JSON.parse(fs.readFileSync(f, "utf-8"));
  console.log("  packages:", (s.packages || []).length, "项");
  console.log("  subagents:", s.subagents ? JSON.stringify(Object.keys(s.subagents)) : "（缺 —— 共享设置没同步）");
  console.log("  compaction:", s.compaction ? JSON.stringify(s.compaction) : "（缺 —— 共享设置没同步）");
  const bad = Object.keys(s).filter((k) => k.startsWith("_"));
  console.log("  模板说明键泄漏:", bad.length ? bad.join(",") + "（不该出现）" : "无 ✓");
} catch (e) {
  console.log("  读不到或不是合法 JSON:", e.message);
}
' "$SB/agent/settings.json"
echo "--- 扩展自己的配置 ---"
if [ -f "$SB/agent/extensions/pi-rtk-optimizer/config.json" ]; then
  echo "  ✓ pi-rtk-optimizer 默认配置已补"
else
  echo "  （没补上 —— 扩展配置同步这一步失败了）"
fi

echo
echo "判据：① pi list 每项都带安装路径 ② node_modules 里有清单里的包 ③ rtk 能被找到"
echo "      ④ settings.json 里有 subagents 和 compaction ⑤ 扩展配置已补 ⑥ 模板说明键没泄漏"
echo "清理：rm -rf \"$SB\""
