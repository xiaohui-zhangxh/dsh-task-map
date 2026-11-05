# M3 独立验收审计报告（Gate M3）

> 日期：2026-11-05 ｜ 审计人：**m3-verifier**（独立验收审计，不参与 M3 实现）
> 审计基线：`dsh-task-map` git HEAD = **`ed15aef`**（`docs: correct M3 E2E numbers and evidence attribution (audit D1-D5)`；工作区除本审计交付物 `docs/M3-AUDIT.md` 未跟踪外干净）
> 审计方式：只读、可重算项全部独立重算（自写一次性脚本，位于 `/tmp`，不写入仓库），不采信实现者注释/文档结论；不可复跑项（已删除的隔离实例 E2E）标注「依赖实现者证据」并做 JSON ↔ run 日志 ↔ 截图 ↔ 独立折叠四方数值交叉核对。

---

## 0. 结论

**PASS（Gate M3 通过）**。产品方案 §8 的 M3 出口标准（US-6 场景通过；8→9 插入可见）与 §3 US-6/US-7 渲染链路验收要点全部满足；**0 项阻断 FAIL**。

- **A 测试全绿 + M1/M2 不回归**：`npm test` exit 0；derive **270/270**、host-smoke **23/23**、client-smoke **464/464**、client-logic **240/240**（合计 **997 断言 0 失败**，与 README/进度日志声明一致）；3 会话黄金值断言与 M2 回放语义断言均在且通过。
- **B 数据层独立重算**：审计方自写独立折叠（不调用 derive 的 fold）从 3 个 fixture 重算 → 与 derive 输出 **逐字段一致**：baklib baseline **7（task-1..7，23:42:04.074 建/23:42:43.402 封板，seq 299）** + added **['task-8']**（log at = createdAt = **1793807665978**、seq 835、时刻 23:54:25.978）；p2p **3+6**；athena **5+1**；`dependencyChanged=[]` 且**证实真实 fixture 存在 +11ms 的尾随 blockedBy revision（task-7）被 10s 宽限期正确吞掉**；合成 8→9/dependency/split/todo 移除/宽限边界（300ms、10000ms 不报，10001ms 报）全部通过。**222 项检查：221 通过，1 项暴露同毫秒边界不一致（P3，真实数据不触发）**。
- **C 客户端变更流/回放/无障碍/性能**：审计方自建 stub 宿主 + 伪 React 加载真实 `client.js`，**125/125 通过**：NEW 仅在 `createdAt<=currentTime`（帧更新路径）、计划 Ghost、变更 as-of 过滤与「另有 N 条未来变更」、点击变更 `currentTime===entry.at` 并选中目标、拆分分叉/变更历史、回放范围= `view.timeRange`、未来不剧透、Enter/Space/空格/←→/Esc、aria/焦点样式/reduced-motion、`{}`/异常字段/最小视图/warnings 降级。19/200 任务性能断言真实存在且数值可信（审计方独立计时同量级）。
- **D E2E 证据核对**：`docs/m3-e2e-verification.json` ↔ `tmp/e2e-work/m3-e2e-run6.log` ↔ 8 张截图 ↔ 报告 **45/45 通过**（结构化 36 + JSON↔独立折叠 9）；`45 checks / 0 failed`、baseline 7+added 1、1:06:36/1:06:41/1:06:51、`data-tm-current-time===1793807665978`、拆分/19 任务合成、`consoleErrors=[]` 全部对得上。**首轮发现的 D1~D5 文档数字/证据归属问题已在 `ed15aef` 全部修正并经审计方复核闭环**（见 §8.1）。
- **E US-6/US-7 对照**：US-6 **已覆盖（真实数据+E2E 证据）**；US-7 **已覆盖（合成/组件证据）**，真实对话拆分按报告诚实声明留 M4/W5.3。
- **F 环境与仓库卫生**：11 项全部通过（HEAD/工作区、`.dsh-lab` 不存在、`~/.dsh` 无插件、fixtures/golden 冻结、无凭据/构建产物、文档计数一致）。

**计数**：A 997 + B 221（另 1 项 P3 边界发现）+ C 125 + D 45 + F 11 = **1,399 项检查通过 / 0 项阻断失败**；D1~D5 文档问题 5 项「发现→修正→复核」闭环；非阻断观察 O1~O4 及边界项转入 M4/M5 跟进（§10）。

---

## 1. 审计对象与证据基线

| 项 | 值 |
|---|---|
| 仓库/HEAD | `~/dsh-task-map` ｜ `ed15aef29d039decb9ddc5e2951352f3505f8738` |
| 工作区 | `git status --short`：仅 `?? docs/M3-AUDIT.md`（本审计交付物，待 Lead 收口提交） |
| M3 提交 | `d4da2c5` 数据层（baseline/changeLog/changes + derive 测试 270）→ `c907cab` 客户端+E2E（client-smoke 464/client-logic 240 + `m3-e2e-verification.json`/报告/8 张截图）→ `329dcc4` 截图计数 9→8（Lead）→ `ed15aef` D1~D5 文档修正（Lead） |
| 文档修正基线 | 审计首轮基于 `329dcc4`（`git diff c907cab..329dcc4` 仅进度日志一行）；D1~D5 修正后 `git diff 329dcc4..ed15aef` 仅 `docs/M3-E2E-VERIFICATION.md` + `docs/进度日志.md` 两文件（8 insert / 6 delete），**代码/测试/fixture/golden/E2E JSON/截图均未动** |
| 插件版本 | `package.json` version `0.2.0`；client 标记 `0.2.0-m2`（M3 未升版，见 O1）；host/client `stateVersion=2`（M3 未升版，见 O2） |
| 冻结数据 | `git diff d14b015..HEAD -- test/fixtures docs/golden-values.json` 为空 → M1 黄金数据自冻结后未改 |
| M2 证据 | `git diff 0eb8d5c..HEAD -- docs/m2-e2e-verification.json docs/m2-*.png docs/M2-E2E-VERIFICATION.md` 为空 → M2 E2E 证据未被 M3 改动 |
| E2E 证据 | `docs/m3-e2e-verification.json` + 8 张 PNG + `tmp/e2e-work/m3-e2e-run6.log`，文件 mtime 均 **09:48**（同一轮 run6；JSON `verifiedAt=2026-11-05T01:47:53Z` 为脚本启动时刻） |
| 审计限制 | 未运行 `dsh plugin`/`dsh web`（隔离实例已删、无凭据副本）；未重跑 `make-fixtures`；未联网、未 npm install、未写 `~/.dsh`、未 git commit；一次性脚本位于 `/tmp/m3-audit-{b,c}.mjs`、`/tmp/m3-audit-d.py` |

---

## 2. A. 测试全绿 + M1/M2 不回归（PASS，997/997）

命令与结果（`ed15aef`，仓库根目录，本机 Node v26.8.1）：

```bash
npm test exit 0
node test/derive.test.mjs        # [derive-test] 270 checks passed, 0 failed → PASS
node test/host-smoke.mjs         # 23 项 ✓ → PASS
node test/client-smoke.mjs       # [client-smoke] PASS (464 checks)
node test/client-logic.test.mjs  # [client-logic] PASS (240 checks)
```

- **断言数**：270 + 23 + 464 + 240 = **997，0 失败**；与 README（270/464/240/23）、`docs/进度日志.md` W3.1/W3.2/W3.3、M3-E2E 报告 §5 声明一致，非虚报。
- **3 会话黄金值仍在且通过**（`docs/golden-values.json`，由 `tools/handcalc.py` Python 独立手算，测试先校验 fixture/snapshot sha256 链）：
  - `athena-plan-board`：6 tasks / 230 spans / 37.7KB view / waitAgent 23.2min
  - `baklib-feishu-sso`：8 tasks / 313 spans / 49.1KB view / waitAgent 13.7min
  - `p2p-athena-port`：9 tasks / 410 spans / 59.5KB view / waitAgent 38.3min
  - 3 会话 view 均 <200KB 硬上限；200 任务压测 view **172.0KB**、`apply` 0.0030ms/事件、`buildClientView` 4.7ms。
- **M2 回放语义不回归**：`test/client-logic.test.mjs` 中 `git diff 0eb8d5c..HEAD` 仅 2 行 mock 视图字段被更新（补 M3 baseline/changes 形状），**无删除断言**；M2 的「任意时刻状态/计数、未来不剧透、回放 store、二分、fit-height、200 任务」断言全部保留并通过（240 = M2 185 + M3 55）。`test/client-smoke.mjs` 删除的 2 条 M2 断言（「总览显示基线变更 NEW」「计划任务 +1（未创建）」）被 W3.2 更强的变更流/Ghost 断言组替代；M2 E2E 证据文件未被改动。
- **M1 不回归的结构性证据**：`lib/derive.js` M3 改动为 baseline/changeLog 增强 + M3 视图字段（+200/-10 行），未触碰 M2 的 end-seed/体积 guard/等待累加器路径；fixtures/golden 冻结。

---

## 3. B. 数据层独立重算（W3.1；PASS，221/222 + 1 项 P3 边界）

> 方法：`/tmp/m3-audit-b.mjs` 自己解析 `test/fixtures/*.jsonl`，按事件顺序独立实现「基线建立→封板→新增→依赖补写→宽限」推导（**不调用** derive 的 fold），再与 `foldEvents+buildClientView` 输出逐字段对照；合成事件流的期望值全部先手算再断言。

### 3.1 真实 fixture：基线 / 新增 / 封板时刻（独立重算 = derive 输出）

| 会话 | 基线任务 | baseline.at（本地） | baseline.seq | 封板 closedAt（本地） | 变更 added | added 记录 at / seq |
|---|---|---|---|---|---|---|
| baklib-feishu-sso | **7**（task-1..7） | 23:42:04.074（1793806924074） | 299 | 23:42:43.402（1793806963402） | **['task-8']** | **1793807665978**（23:54:25.978）/ 835 |
| p2p-athena-port | **3**（task-1..3） | 01:59:09.843 | 764 | 01:59:36.905 | **6**（task-4..9） | 各任务首事件时刻 |
| athena-plan-board | **5**（task-1..5） | 00:42:29.300 | 151 | 00:42:40.460 | **1**（task-6） | 1793811372119（+16:46） |

- 三会话任务数（8/9/6）与 Python 手算 `golden-values.json` 一致；`changes.added` 为 task id 数组（M2 兼容），`changes.counts = {planned 7/3/5, added 1/6/1, removed 0, dependencyChanged 0, splits 0}` 全部符合。
- baklib `log` 仅 1 条 `added(task-8)`，`at == task.createdAt == 1793807665978`、`seq == 原始 team/task seq == 835`，`at > closedAt`；E2E 报告/JSON 引用的 `data-tm-current-time === 1793807665978` 与 fixture 独立重算**完全一致**（±0ms）。
- E2E 报告时刻换算核对：回放起点 1793803664622 下，创建前 5s=**1:06:36**、创建时刻=**1:06:41**、创建后 10s=**1:06:51**（与报告 §2.1 一致）。
- 三会话 `changes.log` 均按 `at/seq` 有序；`text` 非空且含任务标题。

### 3.2 基线封板 10s 宽限期：真实数据确实需要它，且行为符合预期

- **真实 fixture 证据**：baklib 基线于 23:42:43.402 封板；**+11ms（23:42:43.413）** task-7 的 `blockedBy` 从 `[]` 补写为 `[task-1..task-6]`（任务板初始批量的尾随 revision，task-7 尚未开始）。derive 结果：`changes.dependencyChanged = []`，且 `state.baseline.blockedBy['task-7']` 已并入 6 个依赖、view task-7 blockedBy 正确 → **宽限期确实避免了误报**（若无宽限，此处会被报成 1 条依赖变更）。p2p/athena 无基线后依赖补写。
- **合成边界**（手算期望）：封板后 +300ms / +10000ms（含边界）改未开始基线任务的 blockedBy → `dependencyChanged=[]` 且基线快照更新；**+10001ms** → 产生 1 条 `{from,to,at}` + log `kind=dependency`；**已开始任务**即使 +300ms 内改依赖也**不宽限**（产生变更）。
- 基线段内（`baselineOpen=true`）新任务并入基线、不产生 added；封板时机 = 首个非 pending 快照 / `turn/end` / `session/end-seed`（与代码一致，三会话均按首个非 pending 快照封板）。

### 3.3 合成用例（手算期望 = 实测）

| 用例 | 期望 | 实测 |
|---|---|---|
| 8→9 插入（基线 8 后新增 task-9@20s，blockedBy=[task-1]） | counts planned=8/added=1；`added=['task-9']`；log `[added,task-9,20000,seq]`；文案含标题；blockedBy 边 | ✅ 全等 |
| 基线后改依赖（task-2@30s → ['task-1']） | `dependencyChanged=[{id,from:[],to:['task-1'],at:30000}]`；log kind=dependency 含 from/to | ✅ |
| 同任务二次改依赖（@31s） | `dependencyChanged` 按任务去重取最后（counts.dependencyChanged=1）；log 2 条 dependency | ✅（客户端 chips 按 log 计=2，见 O3-3） |
| 关系记录（task_map_record_relation parent=task-1 children=[task-9] kind=split @40s） | `changes.splits=[{parent,children,kind,at,seq}]`；log kind=split；relation 边；**任务状态不变**；重复记录幂等（不重复 split/log） | ✅ 全等 |
| 封板前（规划段）关系记录 | 不进 `changes.splits`（recordedAt <= cutoff），但进 `view.relations` | ✅（口径记录） |
| todo 降级：首次清单 2 项为基线，第二次删 1 项 | baseline=2 已封板；`removed` 1；log kind=removed@3000；counts planned2/removed1 | ✅；再新增 1 项 → added@4000 ✅ |
| 变更流排序 | log 按 at/seq 升序 | ✅（真实/合成均有序） |
| 旧字段兼容 | `changes.added/removed` 仍为字符串数组供 M2 NEW 标记 | ✅（client-smoke/client-logic 均消费 added） |

### 3.4 边界行为与风险（如实记录；均不阻断 M3 Gate）

| ID | 级别 | 边界 | 实测行为 | 影响/跟进 |
|---|---|---|---|---|
| B-1 | P3 | **同一毫秒**封板 + 新增任务 | `changes.added` 含该任务，但 `changes.log` 因视图过滤严格 `at > closedAt` **缺该条**（added 与 log 条数不一致） | 真实 3 会话新增距封板 ≥12min，不触发；M4 数据层小修（Lead 已认领） |
| B-2 | P3 | 基线**未封板**（全 pending 规划中）时改 blockedBy | 会写入 `changeLog` 并出现在 `changes.dependencyChanged/log`（cutoff=baseline.at），UI 同时显示「（记录中）」 | 语义可接受但未文档化；M4 补边界测试 |
| B-3 | P3 | `counts.dependencyChanged`（按任务去重）vs log 条数 | 两口径可不同（同任务多次改依赖）；客户端 chips 按 log 计 | 真实数据 0 条；M4 统一口径 |
| B-4 | P3 | `todo→team` 模式切换 | todo 阶段基线/变更流被**丢弃并重置**为 team 首任务（changeLog 清空） | 合理（team 为权威）但信息丢失需文档化；M4 补测试 |
| B-5 | P3 | 变更日志 cap | state `changeLog` 500、view `log` 200（最近 200 条）；`changes.added` 仍全量 | >200 条时客户端 chips（按 log 计）会低报；超长会话才可能触发，M5 观察 |
| B-6 | P3 | 乱序时间事件（seq 升、at 降） | 数据层 view.log 依赖折叠顺序（不显式排序）；客户端 `normalizeChanges` 会按 at/seq 重排 | UI 安全；记录实现假设 |

### 3.5 `test/derive.test.mjs` M3 断言真实性评估（不只是"跑通过"）

- M3 段（`[5] M3 基线与变更流`，+51 checks）**确为有效断言**：3 会话基线数（7/3/5 硬编码期望，经审计方独立重算证明正确）+ counts 全字段 + added 记录时刻=任务 createdAt + log 有序 + 8→9 插入 + 依赖变更（>宽限）+ 拆分（splits/log/relation 边/状态不变）+ todo 移除 + 宽限期 +300ms 不产生变更。
- **覆盖缺口**（审计方已另用 B-1~B-6 独立覆盖，建议 M4 补测）：变更日志 cap（500/200）、基线未封板行为、todo→team 切换的变更流重置、同毫秒边界、依赖去重口径、规划段关系过滤、`baseline.at/seq` 与原始事件的显式对照（现测试仅断言 `closedAt > at`，未断言 at/seq 等于首事件）。
- 3 会话的期望基线数为测试内硬编码常量（非运行时从 fixture 重算）；因 fixture sha256 链冻结，且审计方独立折叠确认数值正确，可接受。

---

## 4. C. 客户端变更流与回放语义（W3.2/W3.3；PASS，125/125）

> 方法：`/tmp/m3-audit-c.mjs` 自建 stub `__ModuleLoader__` + 伪 React + DOM 桩加载**真实 `client.js`**，只调用 `__test` 公开面；合成视图 = 基线 7 + 新增 task-8 + 依赖变更 + 拆分 + 3 条变更（故意乱序传入）。

### 4.1 纯函数（as-of 语义）

| 契约 | 结果 |
|---|---|
| `normalizeChanges` 排序（乱序 log → at/seq 升序）、splits/dependencyChanged 归一化、counts 保真、200 条上限（保留最早 200；数据层已先截最近 200）、异常输入不崩/过滤空条目 | ✅ |
| `asOfChangeCounts` 边界：entry.at-1 → hidden；entry.at → visible；分类计数 added/removed/dependencyChanged/splits；终态=3/0/1/1；旧投影无 log 时按任务 createdAt 兜底 | ✅ 7 个时刻边界全对 |
| `visibleChangeLog` 早期过滤 / `moment=null` 返回全量 | ✅ |
| `taskChangeEntries`：新增任务含 added+被拆分；早于变更时刻过滤；父任务含 split；被依赖变更任务含 dependency；未来变更不显示 | ✅ |
| `isNewBadgeVisible` / `isPlannedTask`：`<createdAt`→NEW false/Ghost true；`===createdAt`→NEW true/Ghost false（**当帧切换**） | ✅ |
| `changeTargetTaskId`：added→新任务；split→父任务；父缺失→子任务；removed→无目标；目标缺失→空 | ✅ |

### 4.2 渲染与交互

- **NEW / Ghost**：任务图节点 `data-tm-new` 仅 `createdAt<=currentTime` 为 true（帧更新路径 `applyFlowState` 每帧用 `isNewBadgeVisible` 更新并隐藏 NEW 徽标元素）；`data-tm-planned=true` + `tm-future` 虚线降透明 + aria「计划未创建」。甘特行 `data-tm-planned` + 标签「〔计划〕」、任务条 aria「计划未创建」；创建后消失。
- **变更流 UI**：总览「计划基线 N 个任务 · 封板 HH:MM」+ chips（新增/移除/依赖变更/拆分，按回放时刻过滤）；变更列表按 at/seq 排序、`button` 可达；早期 `data-tm-changes-visible=0` + 文案「另有 N 条未来变更（回放中隐藏）」且**不泄露未来拆分文案**；点击条目 → `store.pause(); store.setTime(entry.at)`（**精确等于**）+ 按 `changeTargetTaskId` 选中相关任务。
- **详情变更历史**：future 任务 → `detail-state=future`、无「已跑」/完成时间、无未来变更历史；创建后 → NEW 徽标 + 变更历史（新增 + 被拆分）；被改依赖任务显示依赖变更；执行中任务显示「已跑」、未完成标注「未完成」（无完成时间）。
- **拆分分叉**：relation 边渲染 + 拆分变更文案 + 详情历史。

### 4.3 回放语义（M2 不回归，独立复核）

- 回放范围 start/end = `view.timeRange`（合成视图精确匹配；与 `Date.now()` 差 >1e10ms，证明非系统时间）；初始停在终点。
- store：play/pause、`setTime` 夹紧范围、`step(±30s)`、isAtEnd；拖动到任意 t 可复现状态（C 4.1 的 as-of 纯函数逐边界验证）。
- 全局键盘（document 监听）：空格播放/暂停切换、←→ 步进 30s、Esc 取消选中；输入控件（INPUT 等）内不劫持；`marker.actions.getState()` 可观测。

### 4.4 无障碍与降级

- 任务图节点/甘特条：`tabIndex=0` + `role=button` + `aria-label`（含 id/状态/负责人；Ghost 标「计划未创建」）+ `aria-pressed`；Enter/Space 选中并 `preventDefault+stopPropagation`（避免触发全局空格播放）；回放按钮 `aria-label`（播放/暂停回放）+ `aria-pressed`；根节点 `role=region`；任务图 svg `role=group`；`:focus-visible` 焦点环；`prefers-reduced-motion` 关闭 transition/animation；CSS 类选择器全部 `tm-` 前缀。
- 错误/降级：`{}` 投影→空态「本会话未维护任务清单」；异常字段（tasks 非数组/timeRange=null 等）→空态不崩；最小任务视图可渲染（空 id 任务被兜底命名，不崩）；投影抛错→局部错误卡片不崩页；`warnings` →「数据缺失 N」chip + 提示文案。
- 说明：键盘行为/焦点样式/reduced-motion 由**组件测试**与本审计 stub 验证；真实实例 E2E 只断言 Tab 聚焦/aria/aria-pressed 初始值（与 ed15aef 修正后的报告表述一致）。

### 4.5 性能断言真实性与可信度

- 断言真实存在：`client-logic` 19 任务 prepareView <200ms、单帧纯计算 <2ms、200 任务 prepareView <300ms、降级单帧 <6ms、200 任务×500 次任意时刻统计 <200ms；`client-smoke` 19 任务首屏 prepare/render 预算与 19 节点渲染。
- 实现者数值：19 任务 **0.004ms/帧**、200 任务降级 **0.020ms/帧**（测试日志实测输出）。
- **审计方独立计时**（自写帧循环：statusAtTime + countsAtTime + 甘特几何）：19 任务 prepare **0.10ms**、单帧 **0.0064ms**（500 帧平均）；200 任务 prepare **0.42ms**、单帧 **0.0196ms** → 与实现者同量级（差异来自计时口径/机器抖动），**远低于 55fps 帧预算**，目标可信。E2E 的 120.1fps 为 rAF 代理指标（见 D 段）。

---

## 5. D. E2E 证据核对（PASS，45/45；依赖实现者证据）

> 隔离实例已删除，E2E 不可独立复跑；本审计做 JSON 内部一致性 + JSON↔run6 日志↔截图↔报告↔独立折叠五方交叉核对。

### 5.1 结构化 JSON（`docs/m3-e2e-verification.json`）

| 断言 | 实测 |
|---|---|
| 4 条会话记录（baklib before/after + p2p + athena）；`instance` token 已脱敏；`consoleErrors=[]` | ✅ |
| baklib before（1:06:36）：baseline 7 / **可见变更 0** / NEW 0 / Ghost=['task-8'] / 变更区文案「回放时刻暂无计划变更（未来变更尚未发生）」 | ✅ 与独立折叠一致 |
| baklib after：baseline 7 / added 1 / NEW=['task-8'] / 变更条目 `added task-8 @1793807665978` / 文案「+1:06:41 新增 新增任务 T7a 验收预检与验收报告骨架（T1/T3/T6 已完成部分）」 | ✅（at 与 fixture 独立重算 ±0ms） |
| p2p：baseline 3 / added 6 / 可见 6 / NEW 6；6 条变更 task-4..9 的 at 与独立折叠**逐条一致** | ✅ |
| athena：baseline 5 / added 1 / NEW 1；task-6 @1793811372119 | ✅ |
| baklib timeRange = golden（rangeStart 1793803664622 / rangeEnd 1793808894961）；tailMs 三会话为正（打开次数增长） | ✅（34,053,307 / 23,912,574 / 29,703,731ms） |
| 合成拆分：注入 parent=task-1 child=task-8、行「+1:27:10 拆分 拆分 task-1 → task-8（合成数据）」、可见变更 2 | ✅ |
| 合成 19 任务：renderedTasks 19 / gantt 8 行 / hasScrollHint true / **fps 120.1 / frameMs 2.98** | ✅ |

### 5.2 run6 日志（实现者临时证据，只读）

- `tmp/e2e-work/m3-e2e-run6.log`：**45 ✓ 行 / 0 ✗ 行 / `[m3-e2e] 45 checks, 0 failed` / PASS**；含「点击变更后 currentTime === change.at（精确）」「创建前: 可见变更 = 0（未来变更不剧透）」「创建前: task-8 显示为计划任务（Ghost）」「19 任务合成: 全部渲染」「任务节点可 Tab 聚焦」等关键断言；longSession 行与 JSON **完全相同**（120.1/2.98）。
- 各 run 日志对比确认文档曾引用的 119.3fps/2.65ms 来自**旧轮次 run4**，run6 为最终证据（D1 修正依据）。

### 5.3 截图（8/8 逐张查看）

- 文件完整性：`docs/m3-*.png` **8 张**（`git ls-files` 一致；7 张 1680×1050 + `m3-baklib-changes-list.png` 310×22 元素截图），mtime 与 JSON/run6 同为 09:48；全部有效 PNG。
- 逐张核对：
  - `m3-baklib-before-new.png`：**已回放 1:06:36 / 1:27:10**；task-8 虚线 Ghost「计划·未创建」、甘特「〔计划〕」；「会话末尾 9 时 27 分收尾记录已剔除」。
  - `m3-baklib-after-new.png`：**1:06:41**（点击变更跳转后）；task-8 NEW；右侧 TASK-8 详情（NEW/待开始/变更历史 +1:06:41 新增/写范围）。
  - `m3-baklib-changes-end.png`：1:27:10 终点；总览「计划基线 7 个任务 · 封板 23:42」+ chips 新增1/移除0/依赖变更0/拆分0 + 「+1:06:41 新增…」条目。
  - `m3-baklib-changes-list.png`：「+1:06:41 新增 新增任务 T7a 验收预检与验收报告骨架（T1…」。
  - `m3-p2p-changes.png`：9 任务 6 个 NEW；基线 3（封板 01:59）+ 新增 6 + 6 条变更（1:12:37…1:38:58）。
  - `m3-athena-changes.png`：6 任务；基线 5（封板 00:42）+ 新增 1（+16:46）；「会话从历史恢复」提示。
  - `m3-split-synthetic.png`：紫色虚线关系边 task-1→task-8；拆分 1；「+1:27:10 拆分 拆分 task-1 → task-8（合成数据）」。
  - `m3-long-session-synthetic.png`：任务 19；「共 5 行 / 19 个任务 · 滚动查看全部」；甘特 8 行窗口化；基线 19。
- 与报告描述一致；`m3-split-synthetic.png`/`m3-long-session-synthetic.png` 为合成视图（报告已标注）。

### 5.4 报告数字复核与 D1~D5 闭环（首轮 329dcc4 发现 → ed15aef 修正 → 审计复核）

| ID | 问题（首轮发现） | 修正（ed15aef）与复核 |
|---|---|---|
| D1 | M3-E2E §3 + 进度日志 W3.4：**119fps / 2.65ms**（旧轮 run4 值），与最终 JSON/run6（**120.1fps / 2.98ms**）不一致 | ✅ 已改为 120.1fps / frameMs 2.98ms；全仓已无 119fps/2.65ms 残留 |
| D2 | §2.1 把 `m3-baklib-after-new.png` 对应「1:06:51（创建后10秒）」，实际截图时钟 **1:06:41**（脚本断言 +10s 后点击变更跳转才截图） | ✅ 已注明「1:06:51 为断言时刻；截图实际在点击变更跳转后的 1:06:41 拍摄」 |
| D3 | §2.2「点击拆分条目跳转+选中父任务」非 E2E 断言（仅组件测试） | ✅ 已区分：关系边/拆分记录=真实实例 E2E；点击跳转/选中/不改状态=组件+数据层测试 |
| D4 | §3 无障碍把 Enter/Space、空格/←→/Esc 等组件级断言列入「真实实例」验证 | ✅ 已分列「真实实例 E2E 断言」与「组件测试断言」 |
| D5 | §3「rAF 采样 180 帧/1.5s」无日志直接记录（fps×时长推算）；「19 节点全部渲染」实为 DOM 渲染、可视区 5 行滚动 | ✅ 已改为「约 180 帧（由 fps×时长推算）」「DOM 渲染 19 节点（可视区按 5 行滚动）」 |

- 其余数字全部对得上：45 checks/0 failed、baseline 7+1/3+6/5+1、封板 23:42:43、1:06:36/1:06:41、change.at=1793807665978、拆分/19 任务合成、consoleErrors=[]、8 张截图。
- 微瑕（不影响 Gate，可留收口处理）：修正后 §3 用「组件测试断言（jsdom/伪 React）」，实际客户端测试用 **stub 宿主 + 伪 React**（无 jsdom 依赖）——建议措辞为「stub 宿主 + 伪 React」。

### 5.5 证据限制（与报告 §5 一致）

1. **一次性证据**：隔离实例已删除不可复跑；依赖 run6 日志/JSON/截图。
2. **拆分场景为合成数据**：真实 3 会话无 `task_map_record_relation` 调用；真实对话拆分留 M4/W5.3。
3. **19 任务为合成视图**：真实 3 会话最大 9 任务；真实长会话 M5/W5.3。
4. **p2p/athena 为增长中会话**：数字为验证时点投影值；baklib 为稳定主证据。
5. **tail 随打开增长**：历史会话每次打开追加 `session/end-seed`，被 `tailMs` 剔除（报告与截图均显示）。
6. E2E 帧率为 rAF 代理指标（约 180 帧/1.5s ≈ 120fps），不是渲染帧数；≥30/55fps 门槛成立（P3）。

---

## 6. E. US-6 / US-7 对照（产品方案 §3）

| 用户故事 | 验收要点 | 结论 | 证据 / 说明 |
|---|---|---|---|
| **US-6** 对话插入任务（真实 7→8） | 新任务节点出现；`NEW` 标记；计划基线 diff「新增 1」；回放中在插入时刻出现 | **已覆盖** | 真实 baklib 数据（fixture 显示 task-8 于 23:54:25.978 真实创建）→ 独立重算 baseline 7 + added 1；E2E 回放 1:06:36（0 可见变更 + Ghost）/1:06:51（1 条 + NEW）/终点（新增1）三态断言与截图；点击变更 `currentTime===change.at`（1793807665978）；截图可见基线 7+新增1。限制：验证的是**历史真实数据的回放**，「对话实时插入→面板实时出现」留 M5/W5.3（M2-2 已知项）。 |
| **US-7** 拆分成两条支线 | 父子关系记录并渲染；变更记录含时间；父任务状态不被插件改写 | **已覆盖（合成/组件证据）** | 真实会话无 relation 记录 → 数据层合成 relation 用例（splits/log/edges/状态不变/幂等）+ client-smoke 组件断言（分叉渲染、拆分条目跳转选中父/子、状态不变）+ E2E preview 合成截图（紫色关系边、拆分文案，明确标注「合成数据」）。**真实对话拆分验收留 M4/W4.3 + W5.3**（报告 §5.1 已诚实标注）——该限制不阻断 M3（M3 仅要求渲染链路），但 US-7 的 Gate 仍属 M4。 |

---

## 7. F. 环境与仓库卫生（11 项全部通过）

| 项 | 结果 |
|---|---|
| HEAD / 工作区 | `ed15aef`；`git status --short` 仅 `?? docs/M3-AUDIT.md`（本审计交付物）✅ |
| 提交历史 | M3 两个功能提交（`d4da2c5`/`c907cab`）+ 两个文档修正（`329dcc4`/`ed15aef`），修正 diff 仅文档 ✅ |
| 隔离环境 | `~/.dsh-lab` **不存在** ✅ |
| 用户 profile | `~/.dsh/profiles/{desktop,web,headless}/package.json` 均无 `@local/dsh-task-map` ✅ |
| 投影缓存 | `~/.dsh/storages/session_projcache` 无 `"taskMap"` 投影键；含 `dsh-task-map` 字样的 7 个文件均为**开发会话内容缓存**（提示词/标题中出现项目路径），非插件安装 ✅ |
| 冻结数据 | fixtures/golden 自 M1（`d14b015`）未改；M2 E2E 证据自 M2 审计基线（`0eb8d5c`）未改 ✅ |
| package.json | version `0.2.0`；`npm test` 含 derive/host/client-smoke/client-logic；`files` 白名单不含 docs/fixtures ✅ |
| 无凭据泄漏 | 代码/测试/文档/JSON 扫描 `sk-*`/`Bearer`/`password`/`api_key`/真实 token 无命中（E2E JSON token 已脱敏；`tmp/m3-url.txt` 在仓库外）✅ |
| 无构建产物 | 无 `dist/`/`build/`/`node_modules`；68 个跟踪文件均为源码/文档/测试/证据 ✅ |
| 文档数字一致 | README 270/464/240/23、M2 81/19 张；进度日志 W3.4 45 checks/8 张/120.1fps/2.98ms；M3-E2E 报告 45/8 张/120.1fps；执行清单 Gate M3 待审计勾选（收口时由 Lead 勾选）✅ |
| M3 截图 | 8 张均为有效 PNG 且与 run6 同轮；报告 §4 以花括号缩写列出全部 8 张 ✅ |

---

## 8. 问题清单（定级与状态）

### 8.1 已闭环（D1~D5：文档数字/证据归属不实；ed15aef 修正，审计方复核）

| ID | 级别 | 类型 | 描述 | 闭环 |
|---|---|---|---|---|
| D1 | P2（文档） | 数字不实 | M3-E2E §3 / 进度日志 W3.4 性能 119fps/2.65ms（旧轮 run4）≠ 最终证据 120.1fps/2.98ms | ✅ 已改为 120.1fps/2.98ms（JSON+run6 一致），无残留 |
| D2 | P3（文档） | 时刻标注 | after-new 截图实际 1:06:41 被对应到 1:06:51 | ✅ 已注明断言时刻与截图拍摄时刻差异 |
| D3 | P3（证据） | 归属 | 拆分点击跳转/选中被写成 E2E 断言（实为组件测试） | ✅ 已分列证据来源 |
| D4 | P3（证据） | 归属 | 键盘行为被列入真实实例验证（实为组件测试） | ✅ 已分列「真实实例/组件测试」 |
| D5 | P3（表述） | 不精确 | 「180 帧」无日志记录（推算）；「19 节点全部渲染」为 DOM 而非可视 | ✅ 已标注推算/可视区滚动 |

> 注：M1/M2 审计均发现过「文档数字不实」类问题；本次 M3 同类问题 **1 项数字不实（D1）+ 3 项证据归属（D2~D4）+ 1 项表述（D5）**，均在 Gate 判定前修正并复核。建议 M4/M5 报告继续执行「先 JSON/日志/截图核对、后写文档数字」的收口流程。

### 8.2 非阻断观察（P3，转 M4/M5 跟进）

| ID | 描述 | 影响 | 跟进 |
|---|---|---|---|
| O1 | `client.js` CLIENT_VERSION 仍 `0.2.0-m2`、package version 仍 `0.2.0`（M3 客户端行为已变；报告「插件版本 0.2.0（M3 客户端）」易混淆） | 版本标识/审计可追溯性 | M4/M5 随契约升版一并更新 |
| O2 | `STATE_VERSION=2` 未因 M3 state 形状新增（`changeLog`/`baseline.blockedBy`/`task.createdSeq`/`dependencyChanges`/`blockedByChangedAt`）而升版（M2 新增 `waitsAcc` 等亦未升，存量问题）；违反 `lib/derive.js` 自述纪律 | 旧缓存状态缺新字段时变化流退化为空（已实测 buildClientView 降级不崩：changes 全空数组、baseline.seq=-1，client 归一化兜底） | Lead 已认领：M4 升 STATE_VERSION 并标注 view/state 契约 |
| O3-1 | 同毫秒封板+新增 → added/log 条数不一致（严格 `>`） | 真实数据不触发 | M4 数据层小修 + 边界测试（Lead 已认领） |
| O3-2 | 基线未封板时依赖变更进入 changes.log/dependencyChanged | 规划阶段语义未文档化 | M4 数据层小修 + 边界测试（Lead 已认领） |
| O3-3 | `counts.dependencyChanged`（按任务去重）vs log 条数/客户端 chips 口径可能不同 | 合成场景可见；真实数据 0 条 | M4 统一口径 |
| O3-4 | todo→team 切换丢弃 todo 阶段变更流并重置基线 | 合理但需文档化 | M4 文档/测试 |
| O3-5 | 变更流 >200 条时客户端 chips（按 log 计）低报（`changes.added` 全量） | 超长会话才可能触发 | M5 观察/长会话测试 |
| O3-6 | 数据层 view.log 依赖折叠顺序（不显式 sort；客户端重排） | UI 安全 | M5 可选加固 |
| O4 | M2-1（降级视图详情「共 N 条（截至回放时刻）」用最终水位）**部分闭环**：未开始任务已改 0，已开始未完成任务仍用最终 `spanCount`（>~60 任务降级视图触发；3 会话不触发） | 超长会话回放早段计数偏高（明细列表本身按时刻过滤正确） | M4/M5 按 as-of 聚合或标注累计 |

### 8.3 不阻断但已知（M4/M5 范围，非 M3 新增）

- M5-1：`/task-map/api/health` 无同源鉴权（P0 发布阻断，W5.1 修复）。
- M5-2：实时任务事件未端到端（隔离 profile 未挂 Agent Teams）。
- M5-4：E2E 帧率为 rAF 代理指标；3 秒首屏无计时断言。
- M5-5：fixtures/截图含内网 IP/本地用户名/路径（仓库公开前需脱敏；npm `files` 已排除 docs/fixtures）。

---

## 9. Gate M3 判定（对照产品方案 §8、§3 US-6/US-7、交接文件 §8）

| Gate 判据 | 结果 | 证据 |
|---|---|---|
| US-6 场景通过 | **PASS** | 真实 baklib 回放：基线 7 + 新增 1；1:06:36 Ghost/0 变更 → 1:06:51 NEW/1 变更；1:06:41 点击对齐；截图+JSON+run6+独立折叠五方一致 |
| 8→9 插入可见 | **PASS** | 数据层合成 8→9 diff +1、log 时刻正确；client-smoke 变更流/Ghost/NEW 断言；E2E 真实 7→8 可见 |
| US-7 分叉渲染链路 | **PASS（M3 范围）** | 合成 relation → splits/log/edges/状态不变；组件断言分叉渲染+跳转选中；E2E 合成截图（标注合成）；真实拆分留 M4 |
| 变更记录/计数 as-of 过滤、未来不剧透 | **PASS** | C 段 125/125；E2E before-new visible 0/hidden 1 |
| 17 任务性能/无障碍/错误态（W3.3） | **PASS** | 19/200 任务帧预算断言 + 审计方独立计时；aria/键盘/reduced-motion；`{}`/异常字段/warnings 降级 |
| 不回归 M1/M2、不碰 `~/.dsh` | **PASS** | A 段 997/997；fixtures/golden/M2 证据冻结；环境 11 项 |
| 无 console error | **PASS** | E2E `consoleErrors=[]` + run6 断言 |

**最终判定：PASS。** Gate M3 通过；剩余项均为 P3 观察、M4/M5 范围或已由 Lead 认领的 M4 小修。

---

## 10. 残余风险（Top5）与 M4/M5 跟进清单

**残余风险 Top5**

1. **US-7 真实场景证据缺口**：拆分渲染链路已验证（合成+组件），但真实「对话拆分→关系记录→子节点/变更记录」未在真实会话/Agent Teams profile 端到端验证；Gate 风险留给 M4/W5.3。
2. **E2E 一次性证据**：隔离实例已删不可复跑；虽经 JSON/run6/截图/独立折叠四方交叉且证据文件自 09:48 未变，仍属实现者证据；帧率为 rAF 代理指标。
3. **超长会话降级视图口径（O4/B-5）**：>~60 任务触发视图降级时，详情「共 N 条」与变更 chips（>200 条时）可能与 as-of 严格语义有偏差；3 个真实会话不触发。
4. **数据层边界口径（O3-1/2/3）**：同毫秒封板+新增、未封板期依赖变更、依赖去重计数与 log 条数不一致——真实数据不触发，但属契约模糊点，M4 小修。
5. **发布阻断项仍在（M5-1/P0）**：health 路由无鉴权；fixtures/截图隐私面；实时事件未端到端——均 M5 范围。

**M4 跟进清单（Lead 已认领）**

- [ ] 升 `STATE_VERSION`（2→3）并同步标注 view/state 契约（O2），更新 client 版本标记（O1）。
- [ ] 数据层小修 + 边界测试：同毫秒封板+新增 log 缺条（O3-1）、未封板期依赖变更口径（O3-2）、`counts.dependencyChanged` 与 log 口径统一（O3-3）；todo→team 切换语义文档化（O3-4）。
- [ ] W4.1/W4.2：`task_map_record_relation` 校验（id 存在/kind 枚举/只记录）+ 真实对话拆分验收；W4.3 子节点渲染/变更记录/父任务提示。
- [ ] 降级视图 as-of 聚合（O4，可并入 M5 观察）。

**M5 跟进清单**

- [ ] W5.1：`/task-map/api/health` 同源校验 + 移除调试字段（P0）。
- [ ] W5.3：沉淀可复跑 E2E（真实 Agent Teams profile：实时建任务/拆分、CDP 帧耗时、首屏计时），替代一次性证据；真实 19 任务长会话验收。
- [ ] W5.4：3 会话验收报告（含 US-6/US-7 真实场景）。
- [ ] W5.5：fixtures/截图脱敏与公开前隐私复审；文档/版本收口。

---

## 11. 复现命令附录

```bash
# A. 测试（仓库根目录，最终 HEAD ed15aef）
cd ~/dsh-task-map
npm test                                   # exit 0
node test/derive.test.mjs                  # 270 checks, 0 failed
node test/host-smoke.mjs                   # 23 ✓
node test/client-smoke.mjs                 # PASS (464 checks)
node test/client-logic.test.mjs            # PASS (240 checks)

# B/C. 审计方独立脚本（一次性，/tmp，不写仓库；最终 HEAD 上重跑）
node /tmp/m3-audit-b.mjs    # fixture 独立折叠 + 合成/边界：221/222（1 项同毫秒边界发现，P3）
node /tmp/m3-audit-c.mjs    # 客户端变更流/回放/无障碍/错误态/性能：125/125
python3 /tmp/m3-audit-d.py  # E2E JSON↔run6↔截图↔报告↔D1~D5 闭环：36/36

# D. E2E 证据交叉（只读）
git ls-files 'docs/m3-*.png' | wc -l                       # 8
grep -c '  ✓' tmp/e2e-work/m3-e2e-run6.log        # 45
grep -E '^\[m3-e2e\]' tmp/e2e-work/m3-e2e-run6.log # 45 checks, 0 failed → PASS
python3 -c "import json;d=json.load(open('docs/m3-e2e-verification.json'));print(d['synthetic']['longSession'])"        # fps 120.1 / frameMs 2.98
python3 -c "import json,struct;raw=open('docs/m3-baklib-before-new.png','rb').read(24);print(struct.unpack('>II',raw[16:24]))"  # (1680,1050)

# F. 环境与仓库卫生
git rev-parse HEAD                                            # ed15aef...
git status --short                                            # 仅 ?? docs/M3-AUDIT.md
ls ~/.dsh-lab                  # NOT EXISTS
grep -l 'dsh-task-map' ~/.dsh/profiles/*/package.json         # 无输出
git diff --stat d14b015..HEAD -- test/fixtures docs/golden-values.json   # 空
grep -rnE 'sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{10,}|password\s*[:=]' \
  --include='*.js' --include='*.mjs' --include='*.json' . | grep -v test/fixtures/   # 无输出
```

> 说明：E2E 隔离实例与 `tmp/e2e-work/*`（run6 日志/E2E 脚本）为仓库外一次性证据，可能随工作区清理消失；本报告记录审计时刻（2026-11-05 09:49~10:05 Asia/Shanghai）的只读核对结果。

---

## 附：审计执行摘要（基线变更与复核记录）

- 审计起始基线 `c907cab`；期间 Lead 修正截图计数（`329dcc4`，仅进度日志一行）；审计方据此复核并发现 D1~D5 文档数字/证据归属问题，Lead 修正后 **FINAL HEAD=`ed15aef`**（仅两文档，diff 已复核）；审计方在 `ed15aef` 上完成全部 D 项与 F 项终审（A/B/C 不依赖文档，代码自 `c907cab` 未变）。
- 全部结论基于：`npm test` 实跑（997/997）、审计方自写 fixture 独立折叠与合成边界脚本（221/222 + 1 P3）、自写客户端 stub 审计（125/125）、E2E 五方交叉（45/45）、环境 11 项人工核对。
- 审计方未修改任何代码/测试/fixture/golden/进度日志；唯一写入为本文件 `docs/M3-AUDIT.md`。未运行 `dsh plugin`/`dsh web`/`make-fixtures`、未 npm install、未联网、未写 `~/.dsh`、未 git commit。
