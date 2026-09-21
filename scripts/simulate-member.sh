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
echo "=== 6/7 各条同步链路的落点 ==="
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
for name in pi-rtk-optimizer audit-log; do
	if [ -f "$SB/agent/extensions/$name/config.json" ]; then
		echo "  ✓ $name 默认配置已补"
	else
		echo "  （$name 没补上 —— 扩展配置同步这一步失败了）"
	fi
done
echo "--- 审计扩展是否真的在跑（真机证据，不是配置存在就算）---"
audit_log="$SB/agent/audit/logs/$(date +%F).jsonl"
if [ -f "$audit_log" ] && grep -q '"event":"session"' "$audit_log"; then
	sessions="$(grep -c '"event":"session"' "$audit_log")"
	tools="$(grep -c '"event":"tool_result"' "$audit_log")"
	echo "  ✓ 本次启动写出了审计日志：会话 $sessions 个 / 工具结果 $tools 条（$audit_log）"
	# 一个会话只该有一条 session 事件；两条说明同一份扩展被加载了两次（本地副本 + 包内副本）
	dup="$(node -e '
const fs = require("fs");
const c = new Map();
for (const l of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (!l.trim()) continue;
  let r; try { r = JSON.parse(l); } catch { continue; }
  if (r.event === "session") c.set(r.sessionId, (c.get(r.sessionId) || 0) + 1);
}
console.log([...c].filter(([, n]) => n > 1).map(([k]) => k).join(","));
' "$audit_log" 2>/dev/null || echo "")"
	if [ -n "$dup" ]; then
		echo "  ⚠ 有会话写出多条 session 事件（$dup）—— 扩展被重复加载了（本地副本与包内副本同时生效）"
	else
		echo "  ✓ 每个会话只有一条 session 事件（没有重复加载）"
	fi
else
	echo "  （没写出审计日志 —— 审计扩展没被加载或没生效）"
fi

echo
echo "=== 7/7 自动更新（跟远端最新 tag）==="
CLONE="$SB/agent/git/github.com/kurumi1ksllq/pi-workflow"
STATE="$SB/agent/extensions/team-baseline/update-state.json"
if [ -d "$CLONE/.git" ]; then
	case "$V" in
	v[0-9]*)
		# 真实 GitHub 上没有「比刚发的这版更新的 tag」可拉，所以把 origin 换成
		# 一个本地 bare 仓库（内容就是刚装下来的这份 + 一个更高的假 tag v9.9.9）：
		# 这样既保持「扩展代码来自 clone 自己」，又能真的触发一次自动更新。
		FAKE="$SB/fake-origin/pi-workflow.git"
		mkdir -p "$(dirname "$FAKE")"
		git -c advice.detachedHead=false clone -q --bare "$CLONE" "$FAKE"
		git -c advice.detachedHead=false clone -q "$FAKE" "$SB/fake-work"
		# 源 clone 是 detached HEAD（pi 装 tag 时就是那样），工作副本没有分支 —— 所以只推 tag，
		# 不碰 main（自动更新读的就是 ls-remote --tags）
		git -C "$SB/fake-work" -c user.name=sim -c user.email=sim@example.com commit -q --allow-empty -m "假的新版本（仅用于验证自动更新）"
		git -C "$SB/fake-work" tag v9.9.9
		git -C "$SB/fake-work" push -q origin v9.9.9
		want="$(git -C "$SB/fake-work" rev-parse v9.9.9^{commit})"
		git -C "$CLONE" remote set-url origin "$FAKE"
		rm -f "$STATE" # 清掉 TTL 状态，强制本轮真去查远端
		echo "  远端已放上假 tag v9.9.9（$want）；clone 当前：$(git -C "$CLONE" log --oneline -1)"
		(cd "$SB/proj" && PI_BASELINE_UPDATE_TTL_HOURS=0 pi -p "ok" 2>&1 | grep -a "team-baseline" || echo "  （没有 team-baseline 输出 —— 自动更新没跑起来）")
		now="$(git -C "$CLONE" rev-parse HEAD)"
		if [ "$now" = "$want" ]; then
			echo "  ✓ 已自动更新到最新 tag：$(git -C "$CLONE" log --oneline -1)"
			echo "  ✓ settings 里的 ref：$(grep -o 'pi-workflow@[^\"]*' "$SB/agent/settings.json" | head -1)"
		else
			echo "  ✗ 没跟上（现在 HEAD=$now，期望=$want）—— 自动更新链路有问题"
		fi
		;;
	*)
		echo "  安装源是分支（$V）—— 钉分支时自动更新应当**不动作**（别拿最新 tag 覆盖有意的固定）"
		git -C "$CLONE" reset --hard -q HEAD~1
		rm -f "$STATE"
		(cd "$SB/proj" && PI_BASELINE_UPDATE_TTL_HOURS=0 pi -p "ok" 2>&1 | grep -a "team-baseline" || true)
		echo "  HEAD 现在：$(git -C "$CLONE" log --oneline -1)（应当还是上面退后的那一格）"
		;;
	esac
else
	echo "  （没找到 clone —— 跳过）"
fi

echo
echo "判据：① pi list 每项都带安装路径 ② node_modules 里有清单里的包 ③ rtk 能被找到"
echo "      ④ settings.json 里有 subagents 和 compaction ⑤ 扩展配置已补（rtk + 审计）"
echo "      ⑥ 模板说明键没泄漏 ⑦ 审计日志真写出来了且没有重复加载 ⑧ 自动更新跟上了新 tag（用本地假远端验）"
echo "清理：rm -rf \"$SB\""
