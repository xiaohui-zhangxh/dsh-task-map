# W5.3 可复跑 E2E 脚本说明

> 脚本：[`tools/e2e/task-map-e2e.mjs`](../tools/e2e/task-map-e2e.mjs)
> 定位：开发/验收辅助，不随插件发布，也不在 `npm test` 中运行（依赖真实 DSH 实例 + Chrome）。

## 用法

```bash
# 需要：正在运行的 DSH Web 实例（拿到带 token 的 URL）+ 系统 Chrome + playwright-core
PLAYWRIGHT_CORE=<PLAYWRIGHT_CORE> \
node tools/e2e/task-map-e2e.mjs \
  'http://127.0.0.1:8088/?token=…' \
  'session-a1c3d78d-eaa0-405e-807d-3c037524a987' \
  tmp/e2e-out
```

- `PLAYWRIGHT_CORE`：playwright-core 所在目录（可用 `npm i -D playwright-core` 或复用本机已有安装）；
- `CHROME_PATH`：可选，默认 macOS 系统 Chrome 路径；
- 第三个参数为输出目录（默认 `tmp/e2e-out`），产出 `overview.png`、`replay-mid.png`、`result.json`。

## 断言（只读）

- client bundle 加载（`window.__TASK_MAP_M2__`）；
- 会话打开 + 「任务地图」页签；
- 任务图节点 / 甘特行（含真实可见性）/ 总览 / 回放控件渲染；
- 回放范围有效、拖动生效、播放 1.5s 帧率 ≥30fps（目标 55+）；
- 视图高度适配宿主（不高于滚动容器）；
- `stateVersion >= 3`；无 task-map console error。

全部通过 exit 0，任一失败 exit 1；`result.json` 含所有 data 属性与帧率。

## 限制

1. **实时任务链路**：隔离 `dsh web` profile 若未挂 Agent Teams，无法在 UI 里「对话建任务/拆分」；本脚本只验证只读视图。真实 Agent Teams profile 的实时 e2e 需在用户日常环境手工/脚本另行验证（M5 已用真实工具调用在隔离会话验证关系工具；实时任务事件仍属已知限制）。
2. 依赖页面带 token URL；脚本会把 token 从输出中脱敏。
3. 会话若为历史会话，首次打开会追加 `session/end-seed`（投影已用 `tailMs` 剔除对回放/墙钟的影响）。

## 历史临时脚本

M1~M4 阶段的更细脚本（冷读黄金值核对、关系合成注入、真实工具调用证据）在 `tmp/e2e-work/`，属一次性验证工具；本仓库脚本是收敛后的通用冒烟。
