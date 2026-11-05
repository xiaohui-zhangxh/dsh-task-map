# M1 隔离实例验证报告（W1.6）

> 日期：2026-11-05 ｜ DSH 0.2.1-rc.5 ｜ 插件版本 0.1.0-m1
> 结论：**W1.6 通过**。真实 `dsh web` 隔离实例中，3 个真实会话的 `taskMap` 投影与 Python 独立手算黄金值一致（任务/状态/时间/耗时/等待/负责人/依赖/排名/回合/token/计数全部精确相等）；实时会话的投影随事件推进；空任务状态不伪造。
> 环境纪律：全部安装/启动都使用隔离 `DSH_HOME=~/.dsh-lab`，**未修改 `~/.dsh`**；验证结束后已停止实例并**删除 `.dsh-lab`（含临时复制的凭据/会话）**。

---

## 1. 验证环境与步骤

```bash
# 1) 隔离 home + 复制 3 个真实会话（只读复制；不复制凭据时 UI 处于未登录态，无法打开会话）
LAB=~/.dsh-lab
mkdir -p "$LAB/sessions"
#    baklib / hermes-workspaces 两个项目目录下各复制对应 session 目录
# 2) 安装插件（写入的只有 $DSH_HOME）
DSH_HOME="$LAB" dsh plugin --profile web add link:~/dsh-task-map
# 3) 启动隔离 Web 实例（端口 8088，--no-open）
DSH_HOME="$LAB" dsh web --no-open --port 8088
# 4) 无头 Chrome + playwright-core 打开带 token 的 URL，逐个会话切「任务地图」页签并读取投影
# 5) 清理：kill 实例；rm -rf "$LAB"
```

插件装载日志（真实宿主）：

```text
[task-map] host applying (0.1.0-m1)
[task-map] projection "taskMap" registered
[task-map] tool "task_map_ping" registered
[task-map] tool "task_map_record_relation" registered
[task-map] route "/task-map/api/health" registered
dsh web: http://127.0.0.1:8088/?token=…
```

健康路由（未带 token 也可访问——已知安全问题，M5/W5.1 修复）：

```json
{"ok":true,"plugin":"@local/dsh-task-map","version":"0.1.0-m1","mode":"m1",
 "projection":true,"projectionError":null,"stateVersion":2,
 "tools":["task_map_ping","task_map_record_relation"],"toolErrors":[],
 "route":true,"routeError":null}
```

---

## 2. 冷读：真实会话 → 真实投影 ↔ 独立手算黄金值

对每个会话：侧栏点击打开 → 切「任务地图」页签 → 从页面读取 `useProjection('taskMap')` 的实际值
（即 host `wire.view = buildClientView` 的输出），与 `docs/golden-values.json`（`tools/handcalc.py`
用 Python 标准库独立计算，不读 `lib/derive.js`）逐字段比较。

**结果：91 项断言通过，1 项失败**（失败项为「空会话: 任务地图视图已渲染」——新建草稿会话停在 hero 页，
官方不会挂载 `conversation.view` 页签，属 UI 层预期行为，见 §3；数据层空态另有证据）。
结构化摘要见 `dsh-task-map/docs/m1-lab-verification.json`。

| 会话 | 任务数 | asOfSeq（实例 / 冻结 fixture） | 断言 |
|---|---|---|---|
| `baklib-feishu-sso`（8 任务全完成） | 8 | 1156 / 1155 | 任务状态/开始完成时间/execMs/queueMs/blockedWaitMs/readyDelayMs/owner/依赖/排名/phases、waits、turns、usage、counters、taskStats、baseline diff、顺序 全部一致 |
| `p2p-athena-port`（9 任务全完成） | 9 | 1781 / 1780 | 同上（含 2 个 killed job span、6 回合） |
| `athena-plan-board`（6 任务，历史恢复会话） | 6 | 1006 / 1005 | 同上（`preTurnMs=-2815140`、`preTurnRestored=true`、7 个继承成员 owner 映射） |

证据截图（真实 Web UI + 「任务地图」页签 + 已读到投影值）：

- `docs/m1-real-baklib-feishu-sso.png`
- `docs/m1-real-p2p-athena-port.png`
- `docs/m1-real-athena-plan-board.png`

### 2.1 两处已知且已解释的差异（非缺陷）

1. **asOfSeq +1 / wallClock 变大**：DSH 在**打开历史会话时向日志追加一条 `session/end-seed`**
   （追加式，不改写历史）。因此隔离副本比冻结 fixture 多 1 个事件，`asOfSeq +1`；
   `wallClockMs = asOfTime - sessionCreatedAt` 相应变大（等待拆解其余项不受影响）。
   验证脚本对 `asOfSeq` 用「fixture 末事件 seq ~ +2」区间断言、对 `wallClock` 用「≥ 冻结值」断言，
   其余等待指标仍要求 ±0ms 相等。
2. **官方 404**：隔离 `dsh web` 组合缺少 `GET /api/changes.summary` 宿主 API，官方「工作区修改」
   面板请求 404（`3` 条），与本插件无关；无任何 `task-map` 相关 console error。
   另有 3 条官方侧栏会话切换时的 `Session reference … is released` 提示（DOM 快速连点的 churn），
   与本插件无关（插件注册 `errors=[]`）。

---

## 3. 实时：新会话事件驱动投影

在隔离实例里新建真实会话并发送一条普通消息（模型真实应答），读取「任务地图」投影：

- session 启动后投影按**实时事件**推进：`asOfSeq=27`、`turns=[{turn:1,start,end}]`、`counters.steps=1/stepEnds=1`；
- 无任务板 → `hasTeamBoard=false`、`dataSource='none'`、`tasks=[]`（视图层空状态提示由 M2 组件实现）；
- 数据层空态证据：`docs/m1-live-verification.json`（`tasks=[]` / `dataSource=none`）+ `test/derive.test.mjs` 的空会话断言；
- **未覆盖**：草稿（未开始的会话）在官方 UI 里停在 hero 页、不挂载 `conversation.view`，因此「空状态组件」的
  真实 UI 渲染留到 M2（W2.6）用有事件但无任务板的会话验证；本次验证脚本对该项的 DOM 断言失败即此原因，
  已如实记录为 1 项失败，不计入数据核心 Gate。
- 无 console error。
- 证据：`docs/m1-live-verification.json`、`docs/m1-real-live.png`。

> 限制（如实记录）：本隔离 `dsh web` profile 只挂 `dsh-base + dsh-web-app + 本插件`，**未挂 Agent Teams**，
> 模型侧也未出现 `todo_write`/`team_task_*` 工具（`toolCalls=0`），所以「实时任务事件」在本环境无法自然产生；
> 实时折叠路径由 host-smoke 的 apply 序列 + 上述实时投影推进共同覆盖。M2/W5.3 的 e2e 会在装有 Agent Teams 的
> 真实 profile 上补一次「对话建任务 → 面板实时出现」的端到端验证。

---

## 4. 结论

| 检查项 | 结果 |
|---|---|
| 真实实例加载插件、注册投影/工具/路由 | ✅ |
| 3 个真实会话冷读投影 = 独立手算黄金值（±0ms） | ✅ 冷读相关断言全部通过（该轮 91 passed / 1 failed，唯一失败项是草稿会话 UI 渲染，见 §3 说明） |
| 实时会话投影随事件推进 | ✅（任务事件受 profile 工具面限制，见 §3 限制） |
| 空任务状态不伪造（`tasks=[]`、`dataSource=none`） | ✅ |
| 无 task-map 相关 console error | ✅ |
| 视图体积 < 200KB（**实例实测** 51.0/61.3/39.8KB；本地 fixture 口径 48.6/58.1/37.2KB，均 < 200KB） | ✅ |
| 未修改 `~/.dsh`；`.dsh-lab` 已删除 | ✅ |
| `/task-map/api/health` 无鉴权 | ⚠️ 已知，M5/W5.1 修复（同源校验 + 移除调试字段） |

> 验证辅助脚本位于工作区临时目录（`tmp/e2e-work/verify-lab.cjs`、`verify-live.cjs`），
> 依赖系统 Chrome 与本机 `playwright-core`，不随插件发布；W5.3 会沉淀为可复跑的 e2e。
