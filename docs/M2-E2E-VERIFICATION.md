# M2 隔离实例 E2E 验证报告（W2.7）

> 日期：2026-11-05 ｜ DSH 0.2.1-rc.5 ｜ 插件版本 0.2.0-m2
> 结论：**M2 可视化 E2E 通过**（81 项断言 / 0 失败，含布局与可见性断言；复验于 2026-11-05 04:34（JSON verifiedAt=2026-11-04T20:34:16Z））：3 个真实会话 + 空状态在真实 `dsh web` 隔离实例中渲染任务图/甘特/回放/详情/总览，回放 120fps，未来不剧透，无 console error。
> 环境纪律：全部安装/启动使用隔离 `DSH_HOME=~/.dsh-lab`，**未修改 `~/.dsh`**；验证后删除隔离 home（含临时复制的凭据/会话）。

---

## 1. 验证环境

```bash
LAB=~/.dsh-lab
# 复制 3 个真实会话 + 凭据到隔离 home（源 ~/.dsh 只读；验证后删除）
DSH_HOME="$LAB" dsh plugin --profile web add link:~/dsh-task-map
DSH_HOME="$LAB" dsh web --no-open --port 8089
# 无头 Chrome + playwright-core：打开 3 个真实会话 → 任务地图页签 → 截图/交互/采样
node tmp/e2e-work/m2-e2e.cjs '<token URL>'
```

宿主日志确认插件加载（`stateVersion=2`、投影/工具/路由注册）；`GET /task-map/api/health` 返回 `ok:true, stateVersion:2`。

---

## 2. 结果总览（3 个真实会话）

| 会话 | 任务图节点 | 甘特行 | 回放范围（内容） | 收尾尾巴（剔除） | 断言 |
|---|---|---|---|---|---|
| `baklib-feishu-sso`（8 任务全完成） | 8 | 8 | 22:47:44 → 00:14:54（1:27:10） | +4.27h | ✅ |
| `p2p-athena-port`（9 任务） | 9 | 9 | 01:08:05 → 03:03:59（1:55:55） | +1.46h | ✅ |
| `athena-plan-board`（6 任务，历史恢复） | 6 | 6 | 00:39:26 → 01:27:29（48:03） | +3.07h | ✅ |
| 新建空会话（无任务板） | 0 | 0 | — | — | ✅ 空状态不伪造 |

- **回放时长正确**：会话被 App 打开/关闭时会追加一条无内容的 `session/end-seed`，曾把回放/墙钟拉长数小时（baklib 5:23:02 → 修正后 1:27:10）。已由数据层 `contentEnd`/`timeRange.rawEnd`/`waits.tailMs` 剔除，UI 在总览显示「会话末尾有 X 的收尾记录（无任务/工具活动），已从回放与墙钟统计剔除」。注：上表 tailMs 为当轮 E2E 实测值；历史会话每次在隔离实例中被打开都会再追加一条 end-seed，tail 会随打开次数增长，但都被剔除，不影响回放/墙钟。
- **会话前空闲带**：baklib 甘特左侧显示「会话创建→开工 47 分 47 秒」；p2p preTurn=4 分 8 秒（同样绘制）；athena 历史恢复会话 preTurn 为负，不绘制。
- **未来不剧透**：回放中段（baklib ≈ 43:35，所有任务尚未创建）流程图节点显示「未创建」；回放早期（00:05）选中任务时详情面板 `data-tm-detail-state="future"` 且不出现完成时间/最终耗时/写入范围；选中执行中任务为 `running`（「已跑 X」、无完成时间）。
- **E2E 断言通过项**（每会话）：视图根节点/data 属性、任务图节点数、甘特行数、总览/详情渲染、任务点击选中、回放拖动/播放/时钟前进、跳到开始/完成、甘特空闲带、范围/尾巴字段、早期不剧透、无 task-map console error。
- **性能**：回放期间 rAF 采样 **120fps**（每会话 180~181 帧 / 1500~1508ms，1680×1050）。
- **视图自适应高度**（审计期间发现并修复）：插件视图需按宿主 `conversation.view` 可视区自适应，否则右侧详情/甘特底部被裁并出现整页滚动。最终实现（无 probe 测量）：`H = 滚动容器 clientHeight − scrollHeight + root 当前高度`，clamp `[360, innerHeight−60]`，`data-tm-height` 暴露给 E2E；实测 root 804px ≤ 宿主滚动容器 974px、`document.scrollingElement.scrollHeight == clientHeight`（无整页滚动）、甘特任务行/流程图节点真实可见（E2E 增加「可见行数 ≥ 任务数」「节点尺寸正常」断言）。

---

## 3. 功能对照（产品方案 §3 / §10.3）

| 场景 | 验证结果 | 证据 |
|---|---|---|
| US-1 执行前看计划 | 任务图 8/9/6 节点、负责人/依赖/状态可见；无任务会话显示空状态 | `m2-*-overview.png`、`m2-empty-state.png` |
| US-2 执行中看进度 | 回放时钟/状态 chips/甘特播放头随 currentTime 变化；未完成「已跑 X」 | replay-mid/end 截图 |
| US-3 结束后复盘 | 回放 0→end 可拖动/播放/倍速（60~600×）；任意时刻 `data-tm-current-time` 可复现 | replay-* 截图、E2E JSON |
| US-4 耗时/等待 | 详情：执行耗时/排队/依赖阻塞/就绪延迟/交接/总周期（task-7 = 阻塞 23 分、就绪 37 秒、交接 37 秒）；总览等待拆解 9 类 | `m2-*-detail.png`、`m2-*-dark.png` |
| US-5 任务执行过程 | 详情执行过程按时间窗推断（tool/job/approval，含耗时、点击跳转，标注「按时间窗推断」/截断提示） | detail 截图 |
| 暗/亮主题 | 两种主题均可读（`--dsw-alias-*` 变量） | `m2-*-dark.png` + 亮色截图 |
| 无 console error | 0 条 task-map 相关错误；官方导航类提示与本插件无关 | E2E JSON |
| 布局/自适应 | 视图高度 804px ≤ 宿主可视区 974px；无整页纵向滚动；甘特行/节点可见 | E2E 断言 + 截图 |

---

## 4. 证据文件

- 结构化摘要：`docs/m2-e2e-verification.json`（每会话 view 统计、回放范围/尾巴、console errors）
- 截图（19 张）：
  - `docs/m2-baklib-feishu-sso-{overview,detail,replay-early,replay-mid,replay-end,dark}.png`
  - `docs/m2-p2p-athena-port-*.png`、`docs/m2-athena-plan-board-*.png`
  - `docs/m2-empty-state.png`（无任务板空状态）
- E2E 脚本（临时，不随插件发布）：`tmp/e2e-work/m2-e2e.cjs`；W5.3 会沉淀为可复跑 e2e。

---

## 5. 限制与已知问题

1. **实时任务事件未端到端**：隔离 `dsh web` profile 只挂 `dsh-base + dsh-web-app + 本插件`，未挂 Agent Teams，模型侧没有 `team_task_*`/`todo_write` 工具，因此本环境只能验证「冷读历史会话 + 实时投影初始化/空状态」。真实 profile 的「对话建任务 → 面板实时出现」留待 M5/W5.3 e2e。
2. **隔离实例已删除**：截图与 JSON 为一次性证据，无法独立复跑（冷读数据本身由 M1 黄金测试独立覆盖）。
3. **暗色主题**：通过 `emulateMedia({colorScheme:'dark'})` + 宿主主题变量验证可读性；DSH 主题跟随用户设置，建议 M5 手工验收再确认。
4. 未来事件在甘特/流程图中为「置灰可见」而非隐藏（产品方案允许「隐藏或置灰」）。
5. 大会话（>80 任务行）走窗口化渲染；本轮 3 会话（6~9 任务）未触发，200 任务路径由 `test/client-logic.test.mjs` 单测覆盖。
