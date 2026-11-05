#!/usr/bin/env bash
# DSH Task Map 卸载脚本：从指定 profile 移除插件，并清理 profile bundles 中的残留行。
#
# 用法：
#   ./scripts/uninstall.sh                 # 从 desktop profile 卸载
#   PROFILE=web ./scripts/uninstall.sh
#   DSH_HOME=/path/to/isolated ./scripts/uninstall.sh   # 隔离演练
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PROFILE:-desktop}"
PKG_NAME="@local/dsh-task-map"

echo "== DSH Task Map 卸载 =="
echo "目标 profile: $PROFILE"
if [[ -n "${DSH_HOME:-}" ]]; then echo "DSH_HOME: $DSH_HOME （隔离环境）"; else echo "DSH_HOME: 未设置（将清理 ~/.dsh）"; fi

if command -v dsh >/dev/null 2>&1; then
  dsh plugin --profile "$PROFILE" remove "$PKG_NAME" || true
else
  echo "警告：找不到 dsh，跳过 pnpm remove，仅尝试清理 profile 配置。" >&2
fi

# 清理 node_modules 符号链接（部分 pnpm 版本 remove 后会保留 link）
PROFILE_HOME="${DSH_HOME:-$HOME/.dsh}/profiles/${PROFILE}"
rm -f "$PROFILE_HOME/node_modules/@local/dsh-task-map" 2>/dev/null || true
rmdir "$PROFILE_HOME/node_modules/@local" 2>/dev/null || true

# 清理 profile bundles 残留（pnpm remove 后 dsh.profile.bundles 可能仍含该行）
node - "$PROFILE" <<'NODE'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const profile = process.argv[2]
const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
const file = path.join(home, 'profiles', profile, 'package.json')
if (!fs.existsSync(file)) process.exit(0)
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
const pkgs = pkg.dsh && pkg.dsh.profile && Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : null
if (!pkgs) process.exit(0)
const next = pkgs.filter((name) => name !== '@local/dsh-task-map')
if (next.length !== pkgs.length) {
  pkg.dsh.profile.bundles = next
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
  console.log('已从 profile bundles 清理 @local/dsh-task-map')
}
NODE

echo
echo "✅ 已卸载（profile: ${PROFILE}）。请重启 DSH 使改动完全生效。"
echo "如果你曾用隔离 DSH_HOME 演练，可直接删除该目录完成无残留清理。"
