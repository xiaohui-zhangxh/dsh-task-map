#!/usr/bin/env bash
# DSH Task Map 安装脚本（安装到指定 profile，默认 desktop = 日常使用的 DSH）。
#
# 用法：
#   ./scripts/install.sh                 # 安装到 desktop profile（日常 DSH）
#   PROFILE=web ./scripts/install.sh     # 安装到 web profile
#   DSH_HOME=/path/to/isolated ./scripts/install.sh   # 隔离演练（不碰 ~/.dsh）
#
# 说明：使用 `dsh plugin --profile <p> add link:<本仓库>` 安装；DSH 会把本插件
# 追加到该 profile 的 dsh.profile.bundles。安装后需重启 DSH（桌面端退出重开 / dsh web 重启）。
set -euo pipefail

PLUGIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${PROFILE:-desktop}"

echo "== DSH Task Map 安装 =="
echo "插件目录: $PLUGIN_DIR"
echo "目标 profile: $PROFILE"
if [[ -n "${DSH_HOME:-}" ]]; then
  echo "DSH_HOME: $DSH_HOME  （隔离环境）"
else
  echo "DSH_HOME: 未设置（将写入 ~/.dsh —— 日常环境）"
fi

if ! command -v dsh >/dev/null 2>&1; then
  echo "错误：找不到 dsh 命令，请确认 DSH 已安装并在 PATH 中。" >&2
  exit 1
fi
if ! command -v node >/dev/null 2>&1; then
  echo "错误：找不到 node，请先安装 Node.js（>=20）。" >&2
  exit 1
fi
if [[ ! -f "$PLUGIN_DIR/package.json" ]]; then
  echo "错误：$PLUGIN_DIR 不是插件仓库根目录（缺 package.json）。" >&2
  exit 1
fi

dsh plugin --profile "$PROFILE" add "link:$PLUGIN_DIR"

echo
echo "✅ 已安装到 profile: $PROFILE"
echo "下一步：重启 DSH（桌面端退出重开；或重启 dsh web）后，打开任一含任务板的会话，"
echo "        在会话头部页签选择「对话 / 轨迹 / 任务地图」，即可看到任务地图。"
echo "卸载：./scripts/uninstall.sh  或  PROFILE=$PROFILE ./scripts/uninstall.sh"
