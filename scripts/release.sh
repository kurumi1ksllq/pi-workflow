#!/usr/bin/env bash
# 发版脚本 —— 把版本号对齐这件事从"记性"变成"流程"
#
# 用法：./scripts/release.sh v1.4.0 "这次改了什么"
#
# 做四件事：
#   1. 把 package.json 的 version 同步成这次 tag（去掉前导 v）
#   2. 提交所有改动
#   3. 打 tag
#   4. 推 main 和 tag
set -euo pipefail

V="${1:-}"
MSG="${2:-release $V}"
if [ -z "$V" ]; then
  echo "用法: ./scripts/release.sh v1.4.0 \"改了什么\"" >&2
  exit 1
fi

case "$V" in
  v*) ;;
  *) echo "tag 必须以 v 开头，比如 v1.4.0" >&2; exit 1 ;;
esac

cd "$(dirname "$0")/.."

# 1) 同步 package.json 的 version
node -e "
const fs = require('fs');
const p = 'package.json';
const d = JSON.parse(fs.readFileSync(p, 'utf8'));
d.version = '${V#v}';
fs.writeFileSync(p, JSON.stringify(d, null, 2) + '\n');
console.log('package.json version -> ' + d.version);
"

# 2) 提交
git add -A
if git diff --cached --quiet; then
  echo "(没有改动需要提交)"
else
  git commit -m "$MSG"
fi

# 3) 打 tag（已存在就报错退出，避免覆盖已发布的 tag）
if git rev-parse "$V" >/dev/null 2>&1; then
  echo "tag $V 已存在，换个版本号" >&2
  exit 1
fi
git tag "$V"

# 4) 推
git push origin main
git push origin "$V"

echo ""
echo "已发布 $V"
echo "下一步：更新各项目 .pi/settings.json 里的 ref，通知成员跑"
echo "  pi install git:github.com/kurumi1ksllq/pi-workflow@$V"
