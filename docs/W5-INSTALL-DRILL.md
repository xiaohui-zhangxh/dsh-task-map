# W5.2 安装 / 卸载隔离演练记录

> 日期：2026-11-05 ｜ 环境：隔离 `DSH_HOME=~/.dsh-lab-drill`（演练后删除，未触碰 `~/.dsh`）
> 脚本：`scripts/install.sh` / `scripts/uninstall.sh`（`PROFILE` 环境变量选择 profile）
> 结论：**安装 → 验证 → 卸载 → 无残留 全流程通过**。

## 1. 安装

```bash
chmod +x scripts/install.sh scripts/uninstall.sh
LAB=~/.dsh-lab-drill
DSH_HOME="$LAB" PROFILE=web ./scripts/install.sh
```

输出（节选）：

```text
== DSH Task Map 安装 ==
插件目录: ~/dsh-task-map
目标 profile: web
DSH_HOME: ~/.dsh-lab-drill  （隔离环境）
dependencies:
+ @local/dsh-task-map 0.4.0 <- ../../../dsh-task-map
✅ 已安装到 profile: web
```

校验 `$LAB/profiles/web/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "@local/dsh-task-map"] } },
  "dependencies": { "@local/dsh-task-map": "link:~/dsh-task-map" }
}
```

## 2. 卸载

```bash
DSH_HOME="$LAB" PROFILE=web ./scripts/uninstall.sh
```

输出（节选）：

```text
dependencies:
- @local/dsh-task-map link:~/dsh-task-map
✅ 已卸载（profile: web）。请重启 DSH 使改动完全生效。
```

校验 `$LAB/profiles/web/package.json`：

```json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  "dependencies": null
}
```

→ 插件行 `@local/dsh-task-map` 已从 `bundles` 与 `dependencies` 全部移除（`uninstall.sh` 会清理 pnpm remove 后可能残留的 bundles 行）。

## 2.1 卸载后 node_modules 检查（审计补强）

早期演练发现部分 pnpm 版本在 `remove` 后仍保留 `node_modules/@local/dsh-task-map` 符号链接；`uninstall.sh` 已补清理逻辑并复验：

```bash
LAB=~/.dsh-lab-drill
DSH_HOME="$LAB" PROFILE=web ./scripts/install.sh
test -e "$LAB/profiles/web/node_modules/@local/dsh-task-map" && echo "installed link ok"
DSH_HOME="$LAB" PROFILE=web ./scripts/uninstall.sh
test -e "$LAB/profiles/web/node_modules/@local/dsh-task-map" && echo "STILL EXISTS" || echo "node_modules link removed"
# → node_modules link removed
# bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]，dependencies: None
```

> 演练记录中的版本 `0.4.0` 为当时快照；最终交付/实机安装版本为 **1.0.0**。

## 3. 清理与残留检查

```bash
rm -rf ~/.dsh-lab-drill
```

- 隔离 home 删除后无残留；
- `~/.dsh` 未发生任何写入（演练全程使用 `DSH_HOME` 覆盖）；
- 日常 DSH 的安装由 `scripts/install.sh` 在用户确认后执行（默认 `PROFILE=desktop`）。

## 4. 排错

| 现象 | 处理 |
|---|---|
| `找不到 dsh 命令` | 确认 DSH 已安装；桌面版可在 App 内终端/或把 `dsh` 加入 PATH |
| 安装后页签未出现 | 重启 DSH（桌面端退出重开）；确认插件行在 `~/.dsh/profiles/<profile>/package.json` 的 bundles 中 |
| 会话没有「任务地图」页签 | 该会话无任务板/未加载插件；检查 `/task-map/api/health`（同源页面内可读；无头 curl 会 403） |
| 卸载不彻底 | 重跑 `./scripts/uninstall.sh`；或手动删除 profile package.json 中 `@local/dsh-task-map` 行与 node_modules 链接 |

## 5. 实机安装记录（用户桌面 profile）

```text
plugin_manager install_bundle target=~/dsh-task-map
→ stage=enable, application=applied, bundle=@local/dsh-task-map, version=1.0.0, warnings=[]
→ dependencies: + @local/dsh-task-map 1.0.0 <- ../../../hermes-workspaces/dsh-task-map
```

验证：

- `~/.dsh/profiles/desktop/package.json`：bundles 含 `@local/dsh-task-map`；dependencies 指向本仓库 link。
- 运行中实例 `http://127.0.0.1:55021`：
  - 裸 `curl /task-map/api/health` → **403**；
  - `curl -H "Sec-Fetch-Site: same-origin" -H "Host: 127.0.0.1:55021"` → **200**，`{"ok":true,"version":"1.0.0","stateVersion":3,...}`；
  - 当前会话 Agent 工具已热加载 `task_map_ping` / `task_map_record_relation`（host 侧即时生效）。
- 客户端页签：刷新 DSH Web 页面后可用（client bundle 在页面启动时注入）。
