# M2 独立验收审计报告（Gate M2）

> 日期：2026-11-05 ｜ 审计人：m2-verifier（独立验收审计，不参与 M2 实现）
> 审计基线：`dsh-task-map` git HEAD = **`0eb8d5c`**（`docs: correct remaining test counts in README`；工作区除本审计交付物 `docs/M2-AUDIT.md` 未跟踪外干净）
> 审计方式：只读、可重算项全部独立重算（自写 `/tmp` 脚本 + 原始快照/黄金值交叉核对），不采信实现者注释/报告结论；不可复跑项（已删除的隔离实例 E2E）标注「依赖实现者证据」并做数值一致性核对。

---

## 0. 结论

**PASS（Gate M2 通过）**。产品方案 §8 的 M2 出口标准（60fps；任意时刻状态可复现；未发生未来不显示；截图通过）与交接文件 §8 的 MVP 可视化相关判据全部满足；**0 项阻断 FAIL**；审计发现的问题（含 2 个代码级、1 个数据层边缘、文档数字不实）已全部闭环或降级为 M3/M5 跟进。

- **A 测试全绿 + M1 不回归**：`npm test` exit 0；derive **219/219**、host-smoke **23/23**、client-smoke **338/338**、client-logic **185/185**（合计 **765 断言 0 失败**）；3 会话黄金值断言仍在且通过。
- **B 数据层硬化独立重算**：合成 200 任务 / 3000 span / 6600 事件压测 → `wire.view` **181,084 bytes（176.8KB）< 200KB**、`spansTruncated=true`、`spanSummary` 自洽；等待指标与审计方独立累加完全一致（61700/38850/27750ms）；`apply` 均值 0.0030ms、p95 0.0082ms、max 0.182ms；`buildClientView` 5.4~6.3ms；**审计暴露的 P2 边缘（等待 span 关闭前被 MAX_SPANS 淘汰→少算）已在 `6a0b660` 修复并经审计方复验精确累加**；end-seed 修复经合成事件流 + 3 会话黄金值 + 原始快照三路核对通过。
- **C 客户端契约**：单文件 CJS factory、仅 `require('react')`、无 JSX/构建链/外部库/网络/存储/eval、只读派生、错误边界、184 个 CSS 选择器全部 `tm-` 前缀、E2E data 属性齐备、M0+M2 标记保留、`useHostFitHeight` 无 probe —— **24/24**。
- **D 回放语义独立验证**：审计方自建 stub 宿主 + 自写 mock 视图加载真实 `client.js`：20 边界时刻 × 3 任务 + 200 随机时刻状态/计数全一致；未来不剧透（节点/详情/span/完成度/完成时间）；回放范围来自 `view.timeRange` 而非 `Date.now()`；0→end 101 时刻无异常 —— **44/44**。
- **E E2E 证据核对**：结构化 JSON/数值 **24/24**；E2E 报告 + README + 进度日志数字 **17/17**（首轮发现的 8 类数字不实经两轮修正后全部对齐证据）；19 张截图均为有效 PNG 且抽查 7 张与描述一致；81 checks/0 failed 与 run5 日志一致；布局修复指标（root ≤ host、无整页滚动、甘特/节点可见）全部满足。
- **G 环境与仓库卫生**：HEAD=`0eb8d5c`；工作区仅多审计交付物；`.dsh-lab` 不存在；`~/.dsh` 三个 profile 均无 `@local/dsh-task-map`；无凭据泄漏、无构建产物。

**计数**：A/B/C/D/E 共 **963 项断言/检查通过、0 项失败**（A 765 + B1 27 + B2 62 + C 24 + D 44 + E 41）；G 环境与仓库卫生 8 项人工核对全部通过。**判定：功能与证据 PASS；残余风险与 M3/M5 跟进见 §12。**

---

## 1. 审计对象与证据基线

| 项 | 值 |
|---|---|
| 仓库/HEAD | `~/dsh-task-map` ｜ `0eb8d5c27318c84f76b3a700ee02e2b40db2a38e` |
| 工作区 | `git status --short`：仅 `?? docs/M2-AUDIT.md`（本审计交付物，待 Lead 收口提交） |
| 提交历史 | `d14b015` M1 数据核心 → `f245806` W2.0 体积 guard/等待累加器 → `3cf1601` end-seed 修复 → `b4c3ff4` 任务图/甘特/回放 → `857f9dd` 详情/总览/空态/E2E → `0aec782` 宿主自适应高度修复 → `6a0b660` 证据数字修正 + 等待淘汰边缘修复 → `0eb8d5c` README 计数修正 |
| 插件版本 | `package.json` version `0.2.0`；client 标记 `0.2.0-m2`；`npm test` 含 `client-logic` |
| 冻结数据 | `git diff d14b015..HEAD -- test/fixtures docs/golden-values.json` 为空 → M1 黄金数据未被 M2 改动 |
| 隔离实例 | `.dsh-lab` 不存在；`~/.dsh/profiles/{desktop,web,headless}/package.json` 均无 `@local/dsh-task-map`（未污染用户环境） |
| E2E 证据 | `docs/m2-e2e-verification.json` + 19 张 PNG 自 `0aec782` 起未再改动（`git diff --stat 0aec782..0eb8d5c -- docs/m2-*.png docs/m2-e2e-verification.json` 为空）；`client.js` 自 `0aec782` 起的 diff 仅为 JSDoc 注释（见 §9.1），故该轮 E2E 对最终 HEAD 的客户端运行时依然有效（`derive` 仅改超长会话等待累加，3 会话黄金值由 219 checks 保证不回归） |
| 审计限制 | 未运行 `dsh plugin`/`dsh web`（实例已删、无凭据副本）；未重跑 `make-fixtures`；E2E 数值可交叉核对但不可独立复跑 |

审计用独立脚本（一次性，位于 `/tmp`，不写入仓库）：`/tmp/m2-audit-b1.mjs`（200 任务压测/等待累加器/P2 边缘）、`/tmp/m2-audit-b2.mjs`（end-seed/黄金值/E2E 数值）、`/tmp/m2-audit-c.mjs`（客户端契约）、`/tmp/m2-audit-d.mjs`（回放语义）。

---

## 2. A. 测试全绿 + M1 不回归（PASS，765/765）

命令与结果（`0eb8d5c`，本机 Node v26.8.1，仓库根目录）：

```bash
npm test exit 0
node test/derive.test.mjs        # [derive-test] 219 checks passed, 0 failed → PASS
node test/host-smoke.mjs         # 23 项 ✓ → PASS
node test/client-smoke.mjs       # [client-smoke] PASS (338 checks)
node test/client-logic.test.mjs  # [client-logic] PASS (185 checks)
```

- **断言数**：219 + 23 + 338 + 185 = **765，0 失败**（与实现者声明的 219/338/185 一致，非虚报）。
- **3 会话黄金值不回归**（derive 测试，`docs/golden-values.json`）：athena 6 tasks/230 spans/37.5KB、baklib 8 tasks/313 spans/48.8KB、p2p 9 tasks/410 spans/58.3KB；`fold+view` 2.5/1.7/1.8ms；waitAgent 23.2/13.7/38.3min 等全过。
- **M2 数据层压测**（derive [4] 段）：4819 事件 / 200 任务 / state spans 2000 / view 171.9KB / `fold` 0.0023~0.0032ms/事件 / view 4.0~4.9ms；断言通过。
- **219 中的 3 个新增 checks**（`6a0b660`）：P2 边缘（wait/approval span 被 MAX_SPANS 淘汰后仍精确累加、pending 表清理）——审计方另用独立脚本复验（§3.1）。
- **M1 不回归的结构性证据**：M2 的 `lib/derive.js` 改动仅为体积 guard + 等待独立累加器 + `contentEnd` + `pendingWaits/pendingApprovals`；`test/fixtures/**` 与 `docs/golden-values.json` 自 M1 冻结后未再改动（§1）。

---

## 3. B. 数据层硬化有效性（独立重算，PASS；P2 边缘已闭环）

### 3.1 B1：200 任务 + 大量 span 压测（审计方自建事件流）

审计方独立合成事件流（未复用实现者压测代码）：200 个 `team/task`（pending→in_progress→completed）、每任务 12 个 tool span + 2 个 job span + 1 个等待类 span（wait_agent/ask_user_question/approval/普通工具各占 1/4），共 **6600 事件 / 3000 span**；等待时长由审计方在生成时独立累加。

| 指标 | 审计方实测（`0eb8d5c`） | 断言 |
|---|---|---|
| `wire.view` 序列化（UTF-8 bytes） | **181,084 bytes = 176.8KB** | < 200KB ✅ |
| `spansTruncated` | `true` | ✅ |
| state spans 上限 | **2000**（= MAX_SPANS，不再增长） | ✅ |
| view 保留 span / 档位 | 120 条 / `{description:20, spans:120}`（第 4 档） | 最近 N 条 ✅ |
| `spanSummary` | total=2000, kept=120, omitted=1880；tool 1698 + job 268 + approval 34 = 2000；open=0 | 自洽 ✅ |
| `waits.waitAgentMs` | **61,700ms = 独立累加 61,700ms** | ✅（M1-AUDIT P1 风险关闭） |
| `waits.askUserMs` | **38,850ms = 独立累加 38,850ms** | ✅ |
| `waits.approvalMs` | **27,750ms = 独立累加 27,750ms** | ✅ |
| counters | waitAgents=50、askUsers=50 | ✅ |
| `apply` 单事件 | avg **0.0028~0.0030ms**、p95 0.0069~0.0082ms、max 0.18~0.22ms | <2ms ✅ |
| `buildClientView` | 5.4~6.3ms | 记录 |
| timeRange/waits | end=最后内容事件；wallClock=contentEnd−createdAt；tailMs=0 | ✅ |

> `spanSummary.total` 语义是「state 内保留的 span 数（≤2000）」而非历史总数（更早的 span 已被 MAX_SPANS 丢弃、不可知），`omitted` 只反映视图级截断；审计方按此定义核对自洽。

### 3.2 B1b：P2 边缘（等待 span 在关闭前被 MAX_SPANS 淘汰）→ 数据层修复 → 独立复验（PASS）

**审计首轮发现**：若一个 wait/approval span 在**关闭之前**被 MAX_SPANS 淘汰，其等待时长会丢失（构造：open wait_agent → 2100 个填充 span → 关闭；期望 4201ms/实际 0ms）。

**实现者修复**（`6a0b660`）：`lib/derive.js` 新增 `pendingWaits` / `pendingApprovals`，在 wait_agent / ask_user_question / approval **打开时登记起点**；关闭时即使对应 span 已被淘汰，也按 pending 起点精确累加并清理 pending 表；`test/derive.test.mjs` 增加 3 个边缘 checks（219 checks）。

**审计方独立复验**（`0eb8d5c`，B1 27/27 全过）：

```
边界(tool):     期望=4201ms 实际=4201ms；state.spans=2000；pending 残留=0
边界(approval): 期望=4201ms 实际=4201ms；state.spans=2000；pending 残留=0
✓ 等待 span 关闭前被 MAX_SPANS 淘汰后仍精确累加（tool / approval）
✓ pending 表关闭后清理
```

结论：M1-AUDIT 的 P1 风险（span 上限导致等待少算）**在主路径与淘汰边缘两条路径上均已关闭**。

### 3.3 B2：`session/end-seed` 尾巴修复（独立验证，62/62）

合成事件流：内容事件至 T0+25s，随后两条 `session/end-seed`（T0+60s、T0+3h+60s）：

| 断言 | 实测 |
|---|---|
| `view.timeRange.end` = 内容终点 | T0+25,000ms ✅（非 T0+3h） |
| `view.timeRange.rawEnd` = 日志末事件 | T0+10,860,000ms ✅ |
| `state.asOfTime` 保留全量水位 | T0+10,860,000ms ✅ |
| `waits.wallClockMs` 不含尾巴 | 25,000ms ✅ |
| `waits.tailMs` = 尾巴长度 | 10,835,000ms（= rawEnd−contentEnd）✅ |
| 中段 end-seed 后仍有内容事件 | contentEnd 继续推进、tailMs=0 ✅ |

3 会话 fixture ↔ Python 手算黄金值：三会话 `view.timeRange.end` 均 = `golden.sessionCreatedAt+waits.wallClockMs`（1793808894961 / 1793819039850 / 1793813249656），`taskStats` = 8/9/6 ✅。

E2E JSON ↔ 原始快照（`tmp/e2e-work/snapshots/*.jsonl`，只读）独立核对：三会话 E2E `rangeEnd` = 原始快照最后一个「非 end-seed」事件时刻（1793808894961 / 1793819039850 / 1793813249656）✅；`tailMs = rawEnd − rangeEnd`（15,383,185 / 5,244,901 / 11,041,698ms）✅。
> rawEnd 晚于快照末事件属预期：快照冻结于 03:22，E2E 在 04:34 打开同一会话时 App 又追加了 end-seed——这正是本修复剔除的尾巴（历史会话每次被打开都会增长）。

### 3.4 B3：回放语义单测审查（读代码，不轻信输出）

`test/client-logic.test.mjs` 的语义测试**确为有效断言**：通过 stub `__ModuleLoader__` + 伪 React 加载**真实 `client.js`**；状态推导用独立构造 fixture 逐边界断言（`<createdAt` / `=createdAt` / `start-1` / `=startedAt` / `=completedAt` / `>completedAt` / failed / null 容错）；任意时刻计数用手算期望逐时刻比对；二分查找覆盖 6 类边界且 `client.js:213` 确为二分实现；回放 store 用自建 rAF 队列断言 play/pause/step/倍速白名单/followEnd 夹紧；未来过滤另有 client-smoke 独立断言。备注：`statusAtTime` 对 phases 为线性扫描（单任务 phases 极少，可接受）。

---

## 4. C. 客户端契约审查（PASS，24/24）

审计方以 stub 宿主加载真实 `client.js`（24/24）+ 源码 grep：

| 契约 | 证据 |
|---|---|
| 单文件 CJS factory | `window.__ModuleLoader__.load({ id:'@local/dsh-task-map', factory(require){…} })`；全文件 `require` 仅 1 处 `require('react')` ✅ |
| 无构建链/JSX/外部库 | 源码无 ESM `import/export`、无 JSX；全程 `React.createElement`；无第三方 import ✅ |
| 无网络/存储/动态执行 | `fetch(`/`XMLHttpRequest`/`WebSocket`/`localStorage`/`sessionStorage`/`document.cookie`/`eval(`/`new Function`/`import(` 均无命中（唯一匹配在文件头注释） ✅ |
| 只读派生、不改会话/任务 | client 仅用 `ctx.slots.inject/register`；无 `team_task_*` 写接口、无 host 路由/工具注册、无 `projection.*` 赋值 ✅ |
| 错误不冒泡 | `TmErrorBoundary`（`getDerivedStateFromError`+`componentDidCatch`）+ 27 处 `recordError` + 投影/渲染 try-catch 局部降级；client-smoke 断言投影抛错只出局部错误卡片、`marker.errors` 不新增 ✅ |
| 样式 | 184 个 CSS 选择器全部 `.tm-` 前缀（无 body/html/:root/* 顶层污染）；15 处 `var(--dsw-alias-*)`；`STYLE_ID='task-map-m2-style'` 单例注入；JS 字面 className 135 个唯一值全部 `tm-` 前缀 ✅ |
| E2E data 属性 | 根/控件 21 项齐备（view/tasks/completed/in-progress/current-time/selected/playing/speed/range-start/range-end/raw-end/tail-ms/duration/detail-state/empty/play/scrubber/jump-start/jump-end/completed-at/height）；节点/甘特 17 项齐备 ✅ |
| 兼容标记 | `window.__TASK_MAP_M0__`（loaded/slots=3）保留；`window.__TASK_MAP_M2__`（loaded/version=0.2.0-m2/errors/view/viewStats/actions/getState）✅ |
| 宿主高度自适应（`0aec782` 新增，`6a0b660` 注释修正） | 仅用 React hooks + DOM API（`getComputedStyle`/`ResizeObserver`/`rAF`），无新依赖；实现为**无 probe**：`H = clientHeight − scrollHeight + root 当前高度`，clamp `[360, innerHeight−60]`，写 `data-tm-height`；JSDoc 已同步为「不做 probe」，与实际实现一致 ✅ |

---

## 5. D. 回放语义独立验证（PASS，44/44）

审计方自写 stub 宿主 + 自建 mock 视图（3 任务=完成/失败/未完成，5 个 span 含未来 span）加载真实 `client.js`：

| 验证项 | 结果 |
|---|---|
| 任意 t 状态可复现 | 20 个边界时刻（含 ±1ms）× 3 任务与「phases 中 at≤t 的最后状态」逐项一致；另 200 个随机时刻 0 差异 ✅ |
| 任意 t 计数 | `countsAtTime` 与独立计数逐项一致；终点 = `view.taskStats`（completed=1/failed=1/in_progress=1）✅ |
| 未来不剧透（图/详情） | t=+0.5s 全部未创建：节点置灰+「未创建」；future 详情 `data-tm-detail-state=future`、无「已跑」/完成时间；running 任务「已跑 X」、无完成时间 ✅ |
| 未来 span 不参与执行过程 | running 详情不含 `future-tool-d @+8.6s`，含窗口内 `running-tool-c @+8.1s`；`taskSpansInWindow` 独立核对只返回 1 条已发生 span ✅ |
| 完成度随 t 变化 | 总览 `data-tm-ov-completed`：+0.5s=0、+2.5s=0、+5.5s=1、+9s=1；`marker.getState().completedAtTime` 序列 0,0,0,1,1,1，终点=1=taskStats ✅ |
| 回放范围来源 | 根节点 `data-tm-range-start/end` = `view.timeRange`；`data-tm-current-time` 初始=回放终点；时间戳与 `Date.now()` 差 ~9.4×10¹⁰ms（证明不是系统时间）✅ |
| 回放 0→end 无异常 | 101 个时刻连续渲染 TaskFlow+Overview+3×TaskDetail+countsAtTime 无抛错 ✅ |
| 空态/错误态 | 空会话 `data-tm-empty=true`+「本会话未维护任务清单」；投影抛错只显示局部错误卡片不崩页 ✅ |

---

## 6. E. E2E 证据核对（PASS；首轮发现数字问题经两轮修正后闭环）

### 6.1 结构化 JSON（`docs/m2-e2e-verification.json`）24/24

| 会话 | tasks | taskNodes | ganttRows | ganttVisibleRows | graphVisibleNodes | rangeEnd=golden | rawEnd>end | tailMs | rootHeight/host | pageScroll |
|---|---|---|---|---|---|---|---|---|---|---|
| baklib-feishu-sso | 8 | 8 | 8 | 8 | 8 | ✅ 1793808894961 | ✅ | 15,383,185 | 804/974 | 1050/1050 |
| p2p-athena-port | 9 | 9 | 9 | 9 | 9 | ✅ 1793819039850 | ✅ | 5,244,901 | 846/974 | 1050/1050 |
| athena-plan-board | 6 | 6 | 6 | 6 | 6 | ✅ 1793813249656 | ✅ | 11,041,698 | 846/974 | 1050/1050 |
| 空会话 | 0 | 0 | 0 | — | — | verified=true | — | 0 | 868/974 | 1050/1050 |

- `consoleErrors=[]`；`instance` 已脱敏 `token=***`；每会话 `errors=[]`。
- JSON `hasOverview=false` 是抓取时刻已选中任务（详情替换总览）所致；E2E 在点击前已断言总览容器存在、`-overview.png` 截图亦可见——不构成缺陷。

### 6.2 截图（19 张，抽查 7 张）

- 文件完整性：`docs/m2-*.png` **19 张**（3 会话 ×6 + 空态），全部有效 PNG、1680×1050、120KB~285KB，与 `git ls-files` 一致。
- 抽查：`m2-baklib-feishu-sso-{overview,detail,dark,replay-mid,replay-early}.png`、`m2-p2p-athena-port-{overview,replay-early}.png`、`m2-empty-state.png`，可见：
  - 任务流程图（S 形/依赖边/关系分叉/NEW/负责人色条/状态色）、甘特（任务/代理/事件/热度、播放头、会话前空闲带）、回放时钟与倍速、右侧总览/详情；
  - baklib 回放 1:27:10；`replay-mid` 实见「已回放 43:35 / 1:27:10」且全部节点「未创建」（与报告「中段 ≈43:35」表述一致）；`replay-early` 实见「已回放 00:05」+ future 详情不泄露完成信息；
  - task-7 详情（`m2-baklib-feishu-sso-dark.png`）显示「依赖阻塞 23 分 / 就绪后延迟 37 秒 / 交接间隔 37 秒 / 执行耗时 5.1 分 / 状态区间」，满足 §10.3「task-7 阻塞 22.5min（显示 23 分）」；
  - 空态截图「本会话未维护任务清单」+ 引导，任务 0 不伪造；暗色主题可读、布局无裁切（与 `0aec782` 修复后一致）。

### 6.3 断言计数、性能与布局

- `tmp/e2e-work/m2-e2e-run5.log`（实现者证据，只读）：**81 ✓ 行 / `[m2-e2e] 81 checks, 0 failed` / PASS**，与报告「81 项断言 / 0 失败」一致。
- 回放帧率实测 120.1 / 120.0 / 120.2fps（181/180/181 帧 / 1500~1508ms），报告「120fps（每会话 180~181 帧 / 1500~1508ms）」一致。
- 布局断言：`data-tm-height` 存在、rootHeight ≤ hostScrollClientHeight、pageScrollHeight ≤ pageClientHeight、ganttVisibleRows ≥ tasks、graphVisibleNodes ≥ tasks —— JSON 全部满足。

### 6.4 报告/README/进度日志数字复核（17/17 通过，修正后）

首轮发现 8 类数字不实（尾巴 +3.93/1.11/2.72h、43:35 与 00:05 混述、1600 帧、复验 04:40、athena 00:42:29、p2p 空闲带 47:47、18 张、README 66/179/18 张），实现者经 `6a0b660` + `0eb8d5c` 两轮修正后，审计方逐条复核通过：

- E2E 报告：尾巴 **+4.27h/+1.46h/+3.07h**（= JSON 15,383,185/5,244,901/11,041,698ms）；athena rangeStart **00:39:26**；空闲带「baklib 47 分 47 秒；p2p preTurn=4 分 8 秒」；未来不剧透区分「中段 43:35（未创建）」与「早期 00:05（future 断言）」；**120fps（180~181 帧/1500~1508ms）**；复验时间 **04:34（JSON verifiedAt=2026-11-04T20:34:16Z）**；截图 **19 张**。
- README：derive **219**、client-smoke **338**、client-logic **185**、E2E **81 checks / 0 failed + 19 张**。
- `docs/进度日志.md` W2.7 行：首轮 66 → 布局修复后复验 **81 checks / 0 failed**、19 张、120fps。
- 扫描 `66 checks / 332 checks / 179 checks / 18 张 / 1600 帧` 在 README/E2E 报告已无残留（进度日志历史行保留当时的真实数字，可接受）。

### 6.5 E2E 证据性质与限制

- 隔离实例已删除，E2E 为**一次性实现者证据**，无法独立复跑；本审计做了 JSON 内部一致性、与黄金值/原始快照的 `rangeEnd`/任务数交叉核对（全过）。
- E2E 证据文件自 `0aec782` 后未改动；`client.js` 自 `0aec782` 起 diff 仅为注释、`derive` 仅新增超长会话等待累加（3 会话黄金值 219 checks 保证不回归），故该轮 E2E 对最终 HEAD 运行时有效。
- 帧率数字来自页面内独立 rAF 采样（~180 帧/1.5s），是主线程/合成响应代理指标（不等于渲染帧数），但 120Hz 下 120fps 说明无长任务，≥55fps 目标成立（P3）。
- 实时任务事件（对话建任务→面板实时出现）**未端到端**（隔离 profile 未挂 Agent Teams）；仅验证冷读历史+空态+实时投影初始化，留 M5/W5.3（与报告 §5 一致）。

---

## 7. F. US-1~US-5 与 §10.3 手工验收对照

| 条目 | 结论 | 证据/说明 |
|---|---|---|
| US-1 执行前看计划 | 已覆盖 | 3 会话任务图/负责人/依赖/状态；空会话不伪造（E2E+截图+单测） |
| US-2 执行中看进度 | 部分覆盖（回放/冷读） | 回放时钟/状态/「已跑 X」全验证；「实时事件到达无需刷新」依赖 host `useProjection`（M0/M1 已验实时投影），M2 E2E 未端到端（M5/W5.3） |
| US-3 结束后复盘 | 已覆盖 | 播放/暂停/60~600×/拖动/键盘/任意时刻状态/未来不剧透（D 44/44、E2E 截图+JSON） |
| US-4 耗时与等待 | 已覆盖 | 详情：执行/排队/阻塞/就绪延迟/交接/总周期；总览等待拆解 9 类；task-7「阻塞 23 分/就绪 37 秒/交接 37 秒」经截图+JSON detailText 核对 |
| US-5 任务执行过程 | 已覆盖 | 详情按时间窗推断（tool/job/approval）、标注「按时间窗推断」、截断提示、跳转开始/完成；未来 span 不显示 |
| §10.3 有任务板 3 秒内可见 | 未独立计时 | E2E 无「3 秒」计时断言；页面渲染在打开页签后亚秒级完成；建议 M5 补计时断言 |
| §10.3 回放 0→end 无报错 | 已覆盖 | E2E 拖动/播放 + consoleErrors=[]；D 101 时刻扫描无异常 |
| §10.3 task-7 详情 | 已覆盖 | `m2-baklib-feishu-sso-dark.png` + E2E JSON detailText |
| §10.3 插入任务 NEW/+1、拆分分叉 | 未覆盖（M3/M4 范围） | M2 仅渲染 `changes.added`→NEW、`relations`→分叉边（单测覆盖），无真实「对话插入/拆分」E2E |
| §10.3 无任务会话空态 | 已覆盖 | E2E `emptyState.verified=true` + `m2-empty-state.png` |
| §10.3 安装→使用→卸载→无残留 | 未覆盖（M5 范围） | 隔离实例已删除，无法复跑；安装/回滚文档留 W5.2 |
| §10.3 `/task-map/api/health` 无 token 403 | 未覆盖（M5/W5.1 已知 P0） | M2 未改 host 路由鉴权；M0/M1 已知问题顺延 M5 |
| §10.3 暗/亮主题可读 | 已覆盖（截图证据） | 暗色经 `emulateMedia` 模拟；建议 M5 真机主题再验 |
| §10.3 19 任务长会话不卡 | 部分覆盖 | 200 任务 derive/client 逻辑压测 + 19 任务布局单测 + 甘特窗口化阈值 80；无真实 19 任务 E2E（M3/M5 建议补） |

---

## 8. G. 环境与仓库卫生（PASS）

| 项 | 结果 |
|---|---|
| HEAD/工作区 | `0eb8d5c`；`git status --short` 仅 `?? docs/M2-AUDIT.md`（本审计交付物）✅ |
| 提交历史一致性 | 8 个提交覆盖 M1 数据核心 → M2 硬化/修复/视图/甘特/回放/详情/E2E/布局修复/证据修正 ✅ |
| 隔离环境 | `.dsh-lab` 不存在 ✅；`~/.dsh/profiles/{desktop,web,headless}` 均无 `@local/dsh-task-map` ✅ |
| package.json | version `0.2.0`；`npm test` 含 derive/host/client-smoke/client-logic ✅ |
| 无凭据 | 实现代码/测试（fixture 除外）/文档/JSON 扫描 `sk-*`/`Bearer`/`token=`/`password`/`api_key` 无命中；E2E JSON token 已脱敏 ✅ |
| 无构建产物 | 无 dist/构建目录；`client.js` 为手写单文件源码；`npm files` 仅运行必需文件（index.js/client.js/lib/cordis.patch.yml/locale）✅ |
| 隐私面（残余，非 Gate） | fixtures 与 19 张截图含真实任务描述、内网 IP、本地用户名/路径（如 `106.75.67.63:60109`、`~/...`）；npm `files` 白名单不含 docs/fixtures，发布不会携带；仓库公开前仍需脱敏（M1-AUDIT 已列，M5/W5.5 跟进） |
| 文档状态 | 首轮发现的 README/E2E 报告数字已两轮修正并复核通过；`docs/执行清单.md` Gate M2 勾选、README 审计链接、M2-AUDIT 提交由 Lead 收口（不在审计写范围） |

---

## 9. 审计期间的三次「发现 → 修复 → 复验」闭环

### 9.1 布局 bug（`0aec782`）

1. **发现**：审计开始后（基线 `857f9dd` 阶段），m2-builder 只读 CDP 检查真实宿主几何时发现插件 `.tm-root` 比宿主 `conversation.view` 可视区高 ~318px，导致详情/甘特底部被裁 + 整页滚动；根因：宿主 `flex:1 0 auto` 父级下 `height:100%` 退化。
2. **修复**（`0aec782`，纳入 M2）：`useHostFitHeight` 无 probe 公式 `H = clientHeight − scrollHeight + root 当前高度`，clamp `[360, innerHeight−60]`，暴露 `data-tm-height`；旧 probe 版本会把任务图压扁/甘特只剩标题行，未进入 HEAD。
3. **修复侧自验**：client-logic → 185 checks（fit-height 不变量 6 项）；client-smoke → 338；E2E → 81 checks/0 failed（新增可见性断言）。
4. **审计方独立复验**：E2E JSON rootHeight 804/846/846/868 ≤ host 974；`pageScrollHeight == pageClientHeight == 1050`（无整页滚动）；`ganttVisibleRows == ganttRows == tasks`、`graphVisibleNodes == tasks`；截图布局完整；测试全绿；C/D 无回归。**判定：修复有效。**
5. **遗留小项**：`useHostFitHeight` 的 JSDoc 仍描述旧 probe 方案 → 已在 `6a0b660` 修正（见 9.3）。

### 9.2 P2 边缘等待少算（数据层，`6a0b660`）

1. **发现**：审计方 B1b 合成用例发现「wait/approval span 在关闭前被 MAX_SPANS 淘汰 → 等待时长丢失」（期望 4201ms / 实际 0ms）。
2. **修复**（`6a0b660`）：`pendingWaits` / `pendingApprovals` 打开时记起点，关闭时即使 span 已淘汰仍精确累加并清理；derive 测试 216 → **219 checks**。
3. **审计方独立复验**：B1b 期望=实际=4201ms（tool/approval 各一例），pending 表清零，B1 27/27 全过；3 会话黄金值不回归。**判定：P2 边缘关闭。**

### 9.3 文档数字不实（两轮修正，`6a0b660` + `0eb8d5c`）

1. **发现（审计首轮）**：E2E 报告/README 8 类数字与刷新后 JSON/日志/截图不一致（尾巴 +3.93h 表、43:35/00:05 混述、1600 帧、复验 04:40、athena 00:42:29、p2p 空闲带、18 张、README 66/179/18 张）。
2. **修正（`6a0b660`）**：E2E 报告数字全部改为实测值并补注 tail 增长原因；README 主要计数修正；`useHostFitHeight` 注释修正。
3. **复核（审计方）**：发现 README 仍有 4 处旧测试计数（derive 216→219、client-smoke 332→338）。
4. **再修正（`0eb8d5c`）**：README 4 处改为 219/338。
5. **终审（审计方）**：E2E 报告/README/进度日志 17/17 数字核对通过；无残留旧数字。**判定：文档准确性问题关闭。**

---

## 10. 问题清单（定级与状态）

### 10.1 已闭环（本轮修复并经审计复验）

| ID | 级别 | 类型 | 描述 | 修复 | 审计复核 |
|---|---|---|---|---|---|
| P2-1 | P2 | 文档 | README/E2E 报告数字不实（66/18 张/179/尾巴 +3.93h/1600 帧/04:40/athena 00:42:29/p2p 空闲带/43:35 混述） | `6a0b660` + `0eb8d5c` | 17/17 数字核对通过，无残留 ✅ |
| P2-2 | P2 | 数据层边缘 | wait/approval span 关闭前被 MAX_SPANS 淘汰 → 等待少算 | `6a0b660` pendingWaits/pendingApprovals + 3 checks | B1b 期望=实际=4201ms、pending 清零、27/27 ✅ |
| P3-1 | P3 | 注释 | `useHostFitHeight` JSDoc 仍描述旧 probe 方案 | `6a0b660` | 注释已同步「不做 probe」，与实现一致 ✅ |

### 10.2 未闭环 / 跟进（均不阻断 Gate M2）

| ID | 级别 | 描述 | 影响 | 跟进 |
|---|---|---|---|---|
| M3-1 | P3 | 降级视图（`spansTruncated`/`task.spanCount` 存在，约 >60 任务触发）详情「共 N 条（截至回放时刻）」用 derive 最终水位聚合值，早于回放时刻会显示未来条数（3 个真实会话不触发） | 超长会话详情计数 | **M3**：按 as-of 时间过滤或标注为累计 |
| M3-2 | — | 19 任务真实长会话 E2E、真实「对话插入/拆分」验收 | M3/M4 场景 | W3.1/W3.2/W4.3 + W5.3 |
| M5-1 | P0 | `/task-map/api/health` 无同源鉴权（M0 起已知） | 安全，发布阻断 | W5.1：Origin/Sec-Fetch-Site 校验 + 移除调试字段 |
| M5-2 | P1 | 实时任务事件未端到端（隔离 web profile 未挂 Agent Teams） | 实时折叠路径未被 E2E 覆盖 | W5.3：真实 profile e2e「对话建任务→面板实时出现」 |
| M5-3 | P1 | 8 任务视图 48.8KB > §10.4 的 30KB 估算（<200KB 硬上限）；详情明细走 HTTP 尚未实现 | 体积指标偏差 | M5 观察/若需压到 30KB 再降字段 |
| M5-4 | P3 | E2E 帧率为 rAF 代理指标；3 秒首屏无计时断言 | 性能证据强度 | W5.3 CDP trace + 首屏计时 |
| M5-5 | P3 | fixtures/截图含内网 IP、本地用户名/路径 | 仓库公开隐私面 | W5.5 脱敏审查（npm files 白名单已排除） |

---

## 11. Gate M2 判定（对照产品方案 §8、交接文件 §8）

| Gate 判据 | 结果 | 证据 |
|---|---|---|
| 60fps（8~20 任务） | PASS | E2E 120.1/120.0/120.2fps（rAF 代理，更严格目标 55fps 也满足）；client-logic 200 任务回放/统计压测 |
| 任意时刻状态可复现 | PASS | D 44/44：20 边界+200 随机时刻状态/计数与独立推导一致；E2E 任意 `data-tm-current-time` 可复现 |
| 未发生未来不显示 | PASS | D 未来节点/详情/span/完成度断言 + E2E replay-mid/early 截图与断言 + client-smoke 未来不剧透组 |
| 截图通过 | PASS | 19 张有效 PNG，抽查 7 张：任务图/甘特/回放/详情/总览/空态/暗色正确；task-7 阻塞 23 分/就绪 37 秒；布局无裁切 |
| 无 console error | PASS | E2E `consoleErrors=[]`；client 渲染过程无未捕获错误 |
| US-1~US-5 | PASS（US-2 实时事件流部分覆盖，见 §7） | E2E + 独立 D + 单测 |
| 不回归 M1、不碰 `~/.dsh` | PASS | §1/§2；fixtures/golden 未改；profiles 干净 |
| 数据层硬化（M1 P1 两项） | PASS | 200 任务 view 176.8KB<200KB；等待累加器正常路径 + 淘汰边缘均已精确 |

**最终判定：PASS。** 功能与证据均满足 Gate M2；剩余项均为 M3/M5 范围或 P3 观察项。

---

## 12. 残余风险（Top5）与 M3/M5 跟进清单

**残余风险 Top5**

1. **降级视图未来条数（M3-1）**：>~60 任务触发视图降级时，详情「共 N 条」使用最终水位 `spanCount`，回放早期可能显示未来条数；3 个真实会话不触发，长会话体验/严谨性风险。
2. **E2E 一次性证据**：隔离实例已删除，E2E 不可独立复跑；虽有 JSON/黄金值/原始快照三方交叉核对且证据文件未随代码变动，但严格意义上仍依赖实现者证据；帧率为 rAF 代理指标。
3. **实时事件未端到端（M5-2）**：隔离 profile 未挂 Agent Teams，「对话建任务→面板实时出现」未验证；M2 的实时路径只有 host 投影 apply 与 M1 隔离实例验证。
4. **health 路由无鉴权（M5-1，P0 已知）**：发布阻断项，M5/W5.1 必须修复。
5. **体积/隐私面（M5-3/M5-5）**：8 任务视图 48.8KB 高于 30KB 估算（<200KB 硬上限）；fixtures 与截图含内网 IP/本地路径/用户名，仓库公开前需脱敏（npm files 白名单不含 docs/fixtures）。

**M3 跟进清单**

- [ ] M3-1：降级视图详情「执行过程共 N 条」按 as-of 时间过滤（或用 `task.spanCount` 时标注为累计/全量）。
- [ ] W3.1/W3.2：baseline diff 与 NEW/变更流 UI；真实「对话插入任务 8→9」可见性验收。
- [ ] W3.3：性能/无障碍/错误处理打磨；真实 19 任务长会话 E2E；首屏 3 秒计时断言。
- [ ] M4/W4.3：真实「拆分任务→子节点/变更记录」验收（关系边渲染已有单测覆盖）。

**M5 跟进清单**

- [ ] W5.1：`/task-map/api/health` 同源校验（Origin/Sec-Fetch-Site）+ 移除调试字段（P0）。
- [ ] W5.3：沉淀可复跑 E2E（含实时建任务、CDP 帧耗时、首屏计时）；替代一次性证据。
- [ ] W5.2/W5.4：安装/卸载/回滚文档 + 干净环境 15 分钟演练 + 3 会话验收报告。
- [ ] W5.5：fixtures/截图脱敏与公开前隐私复审；README/文档最终收口。

---

## 13. 复现命令附录

```bash
# A. 测试（仓库根目录，最终 HEAD 0eb8d5c）
cd ~/dsh-task-map
npm test                                   # exit 0
node test/derive.test.mjs                  # 219 checks, 0 failed
node test/host-smoke.mjs                   # 23 ✓
node test/client-smoke.mjs                 # PASS (338 checks)
node test/client-logic.test.mjs            # PASS (185 checks)

# B/C/D. 审计方独立脚本（一次性，/tmp，不写仓库；最终 HEAD 上重跑）
node /tmp/m2-audit-b1.mjs   # 200 任务压测/等待累加器/P2 边缘：27/27
node /tmp/m2-audit-b2.mjs   # end-seed+黄金值+E2E 数值交叉：62/62
node /tmp/m2-audit-c.mjs    # 客户端契约：24/24
node /tmp/m2-audit-d.mjs    # 回放语义：44/44

# E. E2E 证据核对（只读；最终文档数字 17/17 通过）
python3 - <<'EOF'
import json
d=json.load(open('docs/m2-e2e-verification.json'))
g=json.load(open('docs/golden-values.json'))
for s in d['sessions']:
    v=s['view']; e=g['sessions'][s['slug']]
    assert v['rangeEnd']==e['sessionCreatedAt']+e['waits']['wallClockMs']
    assert v['tailMs']==v['rawEnd']-v['rangeEnd']
    assert v['rootHeight']<=v['hostScrollClientHeight']<=v['pageClientHeight']
    assert v['pageScrollHeight']==v['pageClientHeight']
    assert v['ganttVisibleRows']>=v['tasks'] and v['graphVisibleNodes']>=v['tasks']
print('E2E JSON cross-check OK', len(d['sessions']), 'sessions; consoleErrors=', d['consoleErrors'])
EOF
grep -c '  ✓' tmp/e2e-work/m2-e2e-run5.log                # 81
grep -E '^\[m2-e2e\]' tmp/e2e-work/m2-e2e-run5.log        # 81 checks, 0 failed → PASS
git ls-files 'docs/m2-*.png' | wc -l                               # 19
file docs/m2-*.png | head -3                                       # PNG 1680x1050

# G. 环境与仓库卫生
git status --short                                                   # 仅 ?? docs/M2-AUDIT.md（审计交付物）
git rev-parse HEAD                                                   # 0eb8d5c...
ls ~/.dsh-lab                         # NOT EXISTS
grep -l 'dsh-task-map' ~/.dsh/profiles/*/package.json                # 无输出
grep -rnE 'sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{10,}|password\s*[:=]' \
  --include='*.js' --include='*.mjs' --include='*.json' . | grep -v test/fixtures/   # 无输出
```

> 说明：E2E 隔离实例已删除，`tmp/e2e-work/*`（E2E 脚本/run5 日志/原始快照）与 `/tmp/m2-audit-*.mjs` 均为仓库外一次性证据，可能随工作区清理消失；本报告记录审计时刻的只读核对结果。

---

## 附：审计执行摘要（基线变更与重跑记录）

- 审计起始基线 `857f9dd`；期间实现者修复布局 bug（`0aec782`）→ 按 Lead 要求以新 HEAD 复验；随后审计发现的 P2 边缘与文档数字问题由实现者修复（`6a0b660`）；最后 README 计数修正（`0eb8d5c`）后出终版。**本报告全部测试/契约/回放/数据层结论均在 `0eb8d5c` 上重跑或基于该基线的未变证据复核。**
- 复跑记录：`npm test` 在 `0eb8d5c` 重跑 exit 0（219/23/338/185）；`/tmp/m2-audit-{b1,b2,c,d}.mjs` 在 `0eb8d5c` 重跑分别 27/27、62/62、24/24、44/44；E2E 报告/README/进度日志数字在最终文档上逐条复核 17/17 通过。
- 审计方未修改任何代码/测试/fixture/golden/进度日志；唯一写入为本文件 `docs/M2-AUDIT.md`。未运行 `dsh plugin`/`dsh web`/`make-fixtures`、未 npm install、未联网、未写 `~/.dsh`、未 git commit。
