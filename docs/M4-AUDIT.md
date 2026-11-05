# M4 独立验收审计报告（Gate M4）

> 日期：2026-11-05 ｜ 审计人：**m3-verifier**（续任 M4 独立验收审计；不参与 M1~M4 实现）
> 审计基线：`dsh-task-map` git HEAD = **`543b69f`**（`docs: fix remaining README stateVersion/host-smoke numbers (audit D-M4-1/D-M4-2)`；工作区除本审计交付物 `docs/M4-AUDIT.md` 未跟踪外干净）
> 审计方式：只读、可重算项全部独立重算（自写一次性脚本，位于 `/tmp`，不写入仓库），不采信实现者注释/文档结论；已删除的隔离实例 E2E 标注「依赖实现者证据」并做 JSON ↔ run 日志 ↔ 截图 ↔ 独立折叠四方数值交叉。

---

## 0. 结论

**PASS（Gate M4 通过）**。产品方案 §8 的 M4 出口标准（US-7 场景通过；插件不改任务状态）与 §3 US-7 验收要点全部满足；**0 项阻断 FAIL**。

- **A 测试全绿 + M1/M2/M3 不回归**：`npm test` exit 0；derive **286/286**、host-smoke **31/31**、client-smoke **513/513**、client-logic **260/260**（合计 **1,090 断言 0 失败**）；3 会话黄金值、M2 回放语义、M3 基线/变更断言均在且通过；`STATE_VERSION=3` 契约（state/view/client/投影注册）一致，旧 v2 状态可优雅降级。
- **B 关系工具校验（W4.1）**：审计方自建 stub ctx（`sessions` / `sessionProjections.stateOf`，任务板对象深冻结）加载真实 `index.js` 的 `apply`，独立枚举 **59 项**：合法 id → `ok:true, validated:true` + 精确 render 文案；parent/child 缺失、空 children、自引用、kind 非法、parent 空白、args 畸形、无会话上下文/会话不在进程/投影服务不可用/无任务板 → `ok:false` 且 reason/invalidIds 正确；children 去重+trim、note 截断 200；**深冻结任务板 + 源码扫描双证「工具执行不写任何任务/会话状态」**。
- **C 数据层 O3 边界与关系数据（W4.2）**：审计方手算事件流 **60/60** 通过：O3-1 同毫秒封板+新增可见（`added at>=cutoff`）而非 added 仍严格 `>`；O3-2 未封板期 cutoff=∞（变更不进 view.changes）；O3-3 同一任务两次依赖变更（数组去重 1 / `counts.dependencyChanged`=log 条数 2）；O3-4 todo→team 切换基线重置/变更流清空；`relations[].source='tool'`、无效 relation `valid=false` + warnings（child/parent missing）、无效关系不建边、幂等、`changes.splits` as-of 过滤；**relation fold 前后 tasks 节点 JSON 完全一致**；3 会话基线/新增（7+1/3+6/5+1）与 M3 黄金值不回归。
- **D 客户端关系层（W4.3）**：审计方自建 stub 宿主 + 伪 React 加载真实 `client.js`，**68/68** 通过：父节点「支线 N」徽标（badge 去重）、子节点 `data-tm-child-of`、甘特标签「支线1/↳task-X」、详情支线列表点击跳转、父任务完成子未完成 → `data-tm-relation-alert` 精确文案且**状态只读不改**、无效关系 `data-tm-relation-invalid`、拆分变更点击（回放时刻+选中父任务+高亮回调）、`0.4.0-m4` + `data-tm-state-version=3`、无网络/存储/写接口。
- **E E2E 证据核对**：`docs/m4-e2e-verification.json` ↔ `m4-e2e-run2.log` ↔ 4 张截图 ↔ 报告 ↔ 独立折叠交叉 **101 项**：24 checks/0 failed（run1 24/2 轮次已在报告 §6.5 透明说明）、真实工具调用 evidence 4 条（2 次运行 × 合法/非法；args/result 原文、seq/time 自洽、时间戳与截图回放时刻 **完全吻合**）、非法 id 拒绝、投影 relations=2、consoleErrors=[]、4 张 PNG 与描述一致。**首轮发现的 D-M4-1~7 文档数字/证据归属问题已在 `543b69f` 全部修正并经审计方复核闭环**（§9.1）。
- **F US-7/Gate M4 + M3-AUDIT §10 核销**：US-7 **通过（真实工具调用证据 + 合成补充）**；M3 遗留 O1/O2/O3-1..4/W4.1/W4.2/W4.3 全部核销；O4（降级视图 as-of）未在 M4 处理，转 M5。
- **G 环境与仓库卫生**：12 项全部通过（HEAD/工作区、`.dsh-lab` 不存在、`~/.dsh` 无插件/无 taskMap 缓存、fixtures/golden 与 M1/M2/M3 证据冻结、版本/计数一致、无凭据/构建产物）。

**计数**：A 1,090 + B 59 + C 60 + D 68 + E 101 + G 12 = **1,390 项检查通过 / 0 项阻断失败**；D-M4-1~7 已闭环；残余 P3 观察 5 项转 M5（§11）。
> 说明：本报告 `host-smoke` 计数以审计方实测 **31** 为准（实现者首轮文档写 32 属数字不实，已在 `543b69f` 修正，见 D-M4-1）。

---

## 1. 审计对象与证据基线

| 项 | 值 |
|---|---|
| 仓库/HEAD | `~/dsh-task-map` ｜ `543b69f74b99f9d12c0889459f2e87806ebd30ab` |
| 工作区 | `git status --short`：仅 `?? docs/M4-AUDIT.md`（本审计交付物，待 Lead 收口提交） |
| M4 提交 | `3ec7343` W4.1/W4.2（工具校验 + 数据层收口，STATE_VERSION 3）→ `26a037d` W4.3/W4.4（客户端关系层 + E2E + 0.4.0）→ `2801b3b`/`543b69f` 文档修正（审计 D-M4 系列） |
| 最终基线复核 | `git diff 26a037d..543b69f` 仅 **5 个文件**：`README.md`、`docs/M4-E2E-VERIFICATION.md`、`docs/进度日志.md`、`index.js`（仅 header/stateVersion 注释 + health `mode:'m1'→'m4'`）、`lib/derive.js`（仅 STATE_VERSION 注释）——**无功能行为变更**；审计在 `543b69f` 上重跑全部测试与独立脚本 |
| 版本/契约 | `package.json` **0.4.0**；host `VERSION='0.4.0-m4'`；client `CLIENT_VERSION='0.4.0-m4'`；**`STATE_VERSION=3`**；投影注册 stateVersion=3 |
| 冻结数据 | `git diff d14b015..HEAD -- test/fixtures docs/golden-values.json` 为空 → M1 黄金数据自冻结后未改 |
| M1/M2/M3 证据 | M2 证据自 `0eb8d5c` 未改；M3 证据（m3-*.png/json）自 `ed15aef` 未改；M3-E2E 报告仅 1 句措辞修正（`jsdom`→`stub 宿主+伪 React`，`233af35`，即 M3 审计建议项） |
| E2E 证据 | `docs/m4-e2e-verification.json` + 4 张 PNG + `tmp/e2e-work/m4-e2e-run2.log`；文件 mtime 均 **10:09**（同一轮 run2）；`verifiedAt=2026-11-05T02:08:54Z` 为脚本启动时刻 |
| 审计限制 | 未运行 `dsh plugin`/`dsh web`（隔离实例已删、无凭据副本）；未重跑 `make-fixtures`；未联网、未 npm install、未写 `~/.dsh`、未 git commit；一次性脚本 `/tmp/m4-audit-{b,c,d}.mjs`、`/tmp/m4-audit-e.py` |

---

## 2. A. 测试全绿 + M1/M2/M3 不回归 + STATE_VERSION 契约（PASS，1,090/1,090）

命令与结果（`543b69f`，仓库根目录，Node v26.8.1）：

```bash
npm test exit 0
node test/derive.test.mjs        # [derive-test] 286 checks passed, 0 failed → PASS
node test/host-smoke.mjs         # 31 项 ✓ → PASS（README/进度日志已在 543b69f 修正为 31）
node test/client-smoke.mjs       # [client-smoke] PASS (513 checks)
node test/client-logic.test.mjs  # [client-logic] PASS (260 checks)
```

- **断言数**：286 + 31 + 513 + 260 = **1,090，0 失败**；与最终 README / 进度日志一致（host 计数修正后）。
- **M4 增量核对**：derive +16（270→286，M4 边界 6.1~6.5 共 16 条新断言）；host +8（23→31：+9 新场景断言 −1 旧「relation tool records split」被更强的 validated 版替换）；client-smoke +49（464→513：组件断言 +29、内含 client-logic 测试同步 +20）；client-logic +20（240→260：关系归一化/索引/stateVersion/chips 口径）。
- **3 会话黄金值不回归**（derive 测试实际输出）：
  - `baklib-feishu-sso`：8 tasks / 313 spans / 49.1KB view / 队列 39.2min / 执行 80.4min / waitAgent 13.7min
  - `p2p-athena-port`：9 tasks / 410 spans / 59.5KB view / 队列 5.6min / 执行 118.0min / waitAgent 38.3min
  - `athena-plan-board`：6 tasks / 230 spans / 37.7KB view / 队列 18.7min / 执行 71.3min / waitAgent 23.2min
  - 200 任务压测 view **172.0KB < 200KB**、fold 0.0030ms/事件、`buildClientView` 4.6ms。
- **M2 回放语义 / M3 基线变更断言保留**：`test/derive.test.mjs` M3 段（[5]）与 M2/M1 断言未被删除（M4 仅追加 [6] 段）；`test/client-logic.test.mjs` M2 段（布局/状态推导/二分/回放 store/容错）保留并通过；`test/client-smoke.mjs` M3 段的变更流/Ghost/NEW/as-of/详情历史/键盘/reduced-motion 断言保留，M4 在其后追加关系层断言。
- **STATE_VERSION=3 契约一致**（审计方独立验证）：
  - `emptyState().stateVersion=3`、`buildClientView().stateVersion=3`；host 投影 `register({stateVersion: STATE_VERSION})` 实测 **3**、`init` 状态 stateVersion=3；health 路由 `stateVersion=3`（host-smoke 断言）。
  - client `prepareView` 接受 stateVersion=3（client-logic 断言）、根节点 `data-tm-state-version="3"`、`CLIENT_VERSION='0.4.0-m4'`、marker 版本 0.4.0-m4（D 段独立验证）。
  - **旧缓存状态兼容**：审计方手工把 state.stateVersion 置 2 后 `buildClientView` 仍可构建（changes 全空数组、baseline.seq=-1，不崩）——旧缓存由宿主按 stateVersion 失效，缺新字段时降级安全。
  - 缓存失效逻辑依赖 DSH 投影 stateVersion 契约（宿主侧机制）；审计未复跑「升级已有缓存实例」场景（隔离实例已删），标注为依赖宿主契约。
- **陈旧注释已修**：`lib/derive.js`「当前 3；M1 为 2」、`index.js` header「M1~M4」/stateVersion 3/`mode:'m4'`（`2801b3b`，仅注释/元数据）。

---

## 3. B. 关系工具校验（W4.1；PASS，59/59）

> 方法：`/tmp/m4-audit-b.mjs` 自建 stub ctx（`ctx.get('sessions')` 返回冻结 session、`sessionProjections.stateOf` 返回冻结 `{tasks}`，任务板对象 **Object.freeze**）→ 加载真实 `index.js` 的 `apply(ctx)` → 从注册表取两个工具 → 逐个场景调用 `execute`。

| 组 | 断言 | 结果 |
|---|---|---|
| schema 契约 | parameters.required=[parent_task,children,kind]、kind enum=[split,subtask]、output.required=[ok,validated,reason,invalidIds,recorded]、recorded.required=[parent,children,kind,note]、描述声明不调度/不改状态 | ✅ |
| 合法路径 | parent=task-4 children=[task-9,task-10] split note → `ok:true, validated:true, reason:'', invalidIds:[]`，recorded 精确；render =「Recorded split: task-4 → task-9, task-10（只记录，不调度）」；kind=subtask 合法；note 缺省 '' | ✅ |
| 非法：parent 缺失 | task-99 → ok:false/validated:false/invalidIds=['task-99']，reason 含「任务不存在」；render=「Relation not recorded: …」 | ✅ |
| 非法：child 缺失 | [task-9,task-404] → invalidIds=['task-404']（只报缺失项） | ✅ |
| 非法：parent+children 均缺 | invalidIds 顺序 = [parent, ...children] | ✅ |
| 非法：空/全空白 children | reason 含 children；空白/非字符串被过滤后为空 → 拒绝 | ✅ |
| 非法：自引用 | children 含 parent → ok:false、invalidIds=[parent]、reason 指出 parent_task；混在多个 children 中也拒绝 | ✅ |
| 非法：kind | 'merge'/'SPLIT'（大小写敏感）/缺省 → ok:false 且 reason 含 kind | ✅ |
| 非法：parent 空白/缺省/类型错误 | 均 ok:false 且不抛错 | ✅ |
| 会话上下文降级 | 无 exec / exec.agent.id 缺失 → reason「缺少会话上下文」；会话不在进程 →「不在当前进程」；投影服务不可用 →「投影服务不可用」；state 无 tasks →「未维护任务板」；sessions 服务缺失 → 拒绝不抛错 | ✅ |
| 去重/trim/截断 | 重复 children + 前后空白 → 去重为 ['task-9','task-10']；parent trim；note 截断 200 字符 | ✅ |
| **只读无副作用** | 深冻结任务板执行前后 JSON 相同；返回 recorded 不含任务状态；仅读取 sessions/sessionProjections 两个服务；`stateOf` 参数=(sessionId,'taskMap')；**源码级**：execute 区域无宿主/投影/任务状态写调用、index.js 无 sessions 写 API、无 `session/event` 写路径 | ✅ |
| 与 host-smoke 覆盖对照 | 合法/父缺失/子缺失/空 children/自引用/kind 非法/无会话上下文/任务板未改动 8 类场景断言均在；实测 host-smoke ok()=✓=**31** | ✅ |

**审计发现（P3-m4-2，已定级 M5）**：host-smoke 的「任务板未被改动」断言较弱——仅 `relValue.validated === true && boardTasks['task-4'] !== undefined && boardTasks['task-9'] !== undefined`（同义反复，未做前后快照/冻结）。本审计已用深冻结对象 + 源码扫描独立补强该项验证。

---

## 4. C. 数据层 O3 边界与关系数据（W4.2；PASS，60/60）

> 方法：`/tmp/m4-audit-c.mjs` 用手算事件流（不读实现者测试）验证 O3-1~4 修复与关系数据语义。

| 项 | 手算期望 | 实测 |
|---|---|---|
| C1 STATE_VERSION | STATE_VERSION=3；emptyState/view stateVersion=3；旧 v2 状态可降级构建 | ✅ |
| O3-1 同毫秒封板+新增 | 封板事件与新增任务同毫秒：`changes.added=['task-4']`、log 含 added@5000、counts.added=1、记录时刻=任务 createdAt | ✅ |
| O3-1 对照（非 added 同毫秒） | 已开始任务依赖变更 @==cutoff：因严格 `>` 不显示（state.changeLog 有 1 条、view.log=0） | ✅ 符合注释口径 |
| O3-2 未封板期 | baseline.open=true 时：dependencyChanged=[]、log=[]、added=[]（新任务并入基线）；state.changeLog 仍留 1 条但视图不展示；封板后新变更才可见 | ✅ |
| O3-3 依赖两次 | 数组 `dependencyChanged` 去重为 1（取最后 from/to/at）；`counts.dependencyChanged`=log 条数 2；log 2 条@20s/21s | ✅（与客户端 chips 按 log 计一致） |
| O3-4 todo→team | 切换前 todo 基线 2+removed 1；切换后基线重置为 team 任务、变更流清空、taskOrder 只有 team 任务；封板后新增可见、无 todo: 残留 | ✅ |
| 关系数据 | 3 条关系（1 有效/1 child 缺/1 parent 缺）：`source` 全 'tool'、`valid` 标记正确、合法记录字段（parent/children/kind/note/recordedAt/seq）精确；warnings code=relation-child-missing + relation-parent-missing 且 taskId 正确；**无效关系不建 relation 边**；幂等（重复调用不增记录/log）；无效关系仍进 changes.splits（设计意图，见 P3-m4-3） | ✅ |
| 关系不改任务 | relation fold 前后 `view.tasks` **JSON 完全一致**（状态/时间/依赖/phases 全等） | ✅ |
| as-of 过滤 | 把 state.asOfTime 回拨到关系记录之前：`changes.splits=[]`、split log 被过滤；relations[] 本身保留（投影非 as-of） | ✅ |
| M1/M2/M3 不回归 | 3 会话 baseline/added/tasks、dependencyChanged=0/splits=0、无 relation、timeRange（baklib 1793803664622/1793808894961）、封板 23:42:43、task-8@1793807665978、view<200KB、Python 手算任务数 | ✅ 全等 |

---

## 5. D. 客户端关系层（W4.3；PASS，68/68）

> 方法：`/tmp/m4-audit-d.mjs` 自建 stub `__ModuleLoader__` + 伪 React + DOM 桩加载真实 `client.js`，合成视图含 8 任务 + 3 条有效关系（含重复/多子任务）+ 2 条无效关系 + 拆分变更。

| 契约 | 结果 |
|---|---|
| 版本/注册 | `__test.version='0.4.0-m4'`、HTML `data-task-map-client-version`、marker 0.4.0-m4；apply 注册 3 个 slot；根节点 `data-tm-state-version=3`、`data-tm-version=0.4.0-m4`、`role=region` | ✅ |
| 归一化/索引 | relations 5 条 source=tool；客户端存在性兜底 valid/missing 正确（缺 id 判无效）；invalidRelations=2；badge 去重（重复引用=1、多子任务=2、无效不计）；childParent；relationChildrenOf 去重；byParent 保留重复记录（详情逐条）；edges 不含无效关系 | ✅ |
| 任务图 | 父节点「支线 N」徽标（count 文案）；子节点 `data-tm-child-of` +「支线 of task-X」；无关系节点无徽标；高亮子节点 `data-tm-child-highlight=true` + class `tm-child-hl`；非高亮 false | ✅ |
| 甘特 | 父行标签 `data-tm-relation-badge/count` +「支线1」；子行 `data-tm-child-of` +「↳task-4」；高亮行 `data-tm-child-highlight=true`；**P3：初始渲染行 className 因 props 重复键丢失 `tm-child-hl`（见 P3-m4-1）** | ✅（含 P3 观察） |
| 详情 | 父任务「支线（1）」列表 + relation.note + 备注行；**父任务完成子未完成 → `data-tm-relation-alert=true`，文案精确「父任务已完成，1 个子任务未完成（仅提示，不改任务状态）」**；子任务完成/父任务未完成 → 不报警；点击支线行 → onSelect(task-8)；子任务「属于 task-4 的支线」按钮 → onSelect(task-4)；无效关系提示含缺失 id +「已忽略，不影响任务状态」且不计入支线数量 | ✅ |
| 总览/拆分点击 | 无效关系提示文案；拆分变更点击 → `currentTime===entry.at`、选中父任务、`onHighlightChildren(['task-8'])` 回调 | ✅ |
| 只读/无写 | 源码（去注释）无 fetch/XHR/WebSocket/localStorage/sessionStorage/cookie/eval/new Function/import()；不调用任务写接口/关系工具；渲染全部面板后输入 view JSON 未变、任务状态快照未变 | ✅ |

---

## 6. E. E2E 证据核对（PASS，101/101；依赖实现者证据）

> 隔离实例已删除，E2E 不可独立复跑；本审计做 JSON 内部一致性 + JSON↔run2 日志↔截图↔报告↔独立折叠交叉。

### 6.1 结构化 JSON（`docs/m4-e2e-verification.json`）

- 顶层字段/verifiedAt/instance token 脱敏/`consoleErrors=[]` ✅；`synthetic.base={tasks:8, relationCount:2}`（前一运行遗留的有效+无效 relation 各 1）。
- 合成拆分注入 parent=task-1 / child=task-8 / at=1793844510520；父节点支线徽标 count=1 task=task-1；子节点 `data-tm-child-of=task-1`；父任务提示文案精确；无效关系提示文案精确。
- **真实工具调用 evidence（4 条 = 2 次运行 × 合法/非法）**：
  - 合法：args parent=task-1 children=['task-8'] kind=split；result 原文 **「Recorded split: task-1 → task-8（只记录，不调度）」**（2 条，两次运行一致）；
  - 非法：args children=['task-404']；result 原文 **「Relation not recorded: 任务不存在于本会话任务板：task-404」**（2 条一致）；
  - seq/time 自洽：每组 `call.seq < result.seq`、结果时间 ≥ 调用时间且间隔 <60s；`isError=false`（业务 ok:false，不是传输错误）；args 可解析且结构合法。
  - **时间戳↔截图交叉**：run1 合法调用相对会话起点 = **11:20:44**（截图变更记录 +11:20:44）；run2 调用 = 11:21:23；合成注入 at = **11:20:46**（截图 +11:20:46）——三方吻合，证明 JSON 证据与截图来自同一会话/同一轮。
- 说明：`synthetic.split.relationBadges/childOf` 数组含流程图+甘特两层元素（甘特层无 data-tm-task-id → 空 id 条目），属证据提取口径，非渲染缺陷（报告 §6.6 已注明）。

### 6.2 run 日志

- `m4-e2e-run2.log`：**24 ✓ / 0 ✗ / `[m4-e2e] 24 checks, 0 failed` / PASS**，含真实工具调用 5 项断言、合成支线/父提示/无效关系/状态一致/console error 等。
- `m4-e2e-run1.log`：24 checks / **2 failed**（合成视图时序/选择器断言），报告 §6.5 已透明说明「run2 修正选择器后为最终证据，代码未因 run1 改动」——与本审计读到的两轮日志一致（§9.1 D-M4-6）。

### 6.3 截图（4/4 逐张查看）

- 文件：4 张 PNG、1680×1050、有效、mtime 10:09（=JSON/run2 同轮）。
- 逐张核对：
  - `m4-real-tool-relation.png`：真实工具调用后刷新——task-1 节点「支线 1」徽标、task-8「支线 of task-1」、紫色虚线关系边、变更记录「+11:20:44 拆分 task-1 → task-8」「+11:20:44 拆分 task-1 → task-404」、chips「拆分 2」+「数据缺失 1」、8/8 完成。
  - `m4-split-relations.png`：合成拆分——父/子徽标与归属、详情「属于 task-1 的支线」、变更记录「+11:20:46 拆分 task-1 → task-8（合成数据）」。
  - `m4-parent-hint.png`：父任务 TASK-1 详情「支线（1）」+「父任务已完成，1 个子任务未完成（仅提示，不改任务状态）」+ 备注。
  - `m4-invalid-relation.png`：总览「数据缺失 2」+「拆分 3」，无效关系提示（此时预览注入 1 条无效关系叠加真实无效关系）。
- 与报告 §2/§3 描述一致；合成场景已标注（preview 注入）。

### 6.4 报告数字/表述复核

- `24 项断言 / 0 失败`（run2）✅；`0.4.0-m4`/`STATE_VERSION=3` ✅；合法/非法结果原文 ✅；4 张截图 ✅；`consoleErrors=[]` ✅；`test/derive.test.mjs（286 checks）` ✅；宿主日志 `[task-map] host applying (0.4.0-m4)`（`tmp/.../m4-lab-web.log`，实现者临时证据）✅。
- **D-M4-1~7 闭环核对（FINAL HEAD=543b69f）**：README host-smoke 31（两处）与进度日志「23→31」✅；README M1 stateVersion=3（注明 M1 时点=2）✅；M1/M2 历史计数标注交付时点 ✅；M4-E2E §2 三路证据归属 ✅；删除「2.6s」绝对断言 + 甘特缺陷注明 ✅；run1 轮次透明说明 ✅；JSON relationBadges/childOf 提取口径 ✅；无效关系计入拆分变更流说明 ✅；陈旧注释/元数据 ✅。
- **残余 P3**：`docs/进度日志.md` W4.3 **历史行**仍含「拆分变更点击高亮子节点 2.6s」（M2 审计惯例允许历史行保留当时表述，但该断言未经测试；建议收口时标注或修正——不影响 Gate）。

### 6.5 证据限制（与报告 §6 一致）

1. **一次性证据**：隔离实例已删除不可复跑；run 日志/JSON/截图/宿主日志为实现者证据，本审计做四方交叉。
2. **真实工具调用为「隔离实例里让模型真实调用工具」**（复制 baklib 会话 + 模型 prompt），非真实用户对话拆分；但工具调用/结果来自真实会话日志（时间戳与截图吻合）。
3. **合成场景**：父任务提示/无效关系详情为 preview 注入；真实 3 会话无 relation 记录。
4. **「不改任务状态」**：真实工具调用前后未做 E2E 状态对比（脚本的 reset 对比在真实调用之前）；该结论由「工具无写路径 + fold 不改 tasks + 客户端只读」三路机制证据支撑（报告 §2 已按三路证据归属修正）。
5. 帧率/性能与本 Gate 无关（M2/M3 已覆盖）。

---

## 7. F. US-7 与 Gate M4 出口 / M3-AUDIT §10 核销

### 7.1 US-7 对照（产品方案 §3）

| 验收要点 | 结论 | 证据 / 说明 |
|---|---|---|
| 父子关系记录并渲染 | **已覆盖（真实工具调用 + 合成补充）** | 真实模型调用 `task_map_record_relation`（合法）→ result 原文记录成功 → 投影 relations=2 → 刷新后 task-1「支线 1」徽标/task-8「支线 of task-1」/紫色关系边/变更记录（`m4-real-tool-relation.png` + JSON evidence + run2 log）；数据层 fold 幂等、`source:'tool'`（C 段）；客户端徽标/子节点/详情列表/点击跳转（D 段） |
| 变更记录「拆分 parent → children」+ 时刻 | **已覆盖** | 变更流 split 记录@+11:20:44（真实调用）/合成@+11:20:46；点击拆分条目跳转回放时刻+选中父任务+高亮子节点回调（D 段）；数据层 splits as-of 过滤（C 段） |
| 父任务状态不被插件改写 | **已覆盖（机制证据）** | 工具 execute 无写路径（B 段源码+深冻结）；数据层 relation fold 前后 tasks JSON 全等（C 段）；客户端渲染后状态快照未变（D 段）；真实工具输出仅返回 JSON（不写任务板） |
| 父任务完成子未完成 → 只提示 | **已覆盖（合成/组件证据）** | 数据层不改状态；客户端 `data-tm-relation-alert` 精确文案且不写（D 段）；E2E 合成 preview 截图（报告已标注合成） |
| 非法 id 拒绝 | **已覆盖（真实工具调用）** | 真实调用 task-404 → result「Relation not recorded: 任务不存在于本会话任务板：task-404」，不记录（JSON evidence + run2 log）；B 段 59 项独立复验 |

> 结论：US-7 的**记录→投影→渲染→变更记录→不改状态**链路有真实工具调用证据支撑；**父任务提示/无效关系展示为合成/组件证据**（真实 3 会话无 relation，报告已诚实标注）。证据足以支撑 Gate M4（M4 出口未要求真实对话拆分场景自动化）。

### 7.2 Gate M4 出口（产品方案 §8：US-7 场景通过；插件不改任务状态）

| 判据 | 结果 | 证据 |
|---|---|---|
| US-7 场景通过（拆分分叉/变更记录） | **PASS** | 真实工具调用记录 + 投影渲染（JSON/run2/截图四方交叉时间戳吻合）；合成父提示/无效关系渲染（截图+D 段） |
| 插件不改任务状态 | **PASS** | 工具无写路径（源码扫描+深冻结 B）；relation fold 不改 tasks（C：前后 JSON 全等）；客户端只读（D：渲染前后 view/状态快照未变） |
| 工具校验（id 存在/kind 枚举/去重/自引用） | **PASS** | B 59/59；真实调用非法 id 被拒（JSON evidence） |
| 投影解析 tool/call → relations（幂等/source/warnings） | **PASS** | C 60/60（含无效 relation warnings/as-of/幂等） |
| 子节点渲染/变更记录/父任务提示（只提示） | **PASS** | D 68/68；E2E 合成截图 |
| 不回归 M1/M2/M3、不碰 `~/.dsh` | **PASS** | A 1,090/1,090；G 卫生 12/12 |

### 7.3 M3-AUDIT §10 的 M4 跟进项核销

| 项 | 核销结果 |
|---|---|
| O2 STATE_VERSION 2→3（+client 版本） | ✅ 已核销：STATE_VERSION=3、投影注册 3、view/client `data-tm-state-version=3`、docs/契约同步、旧 v2 状态降级不崩 |
| O1 版本标记 | ✅ package 0.4.0 / host & client 0.4.0-m4 |
| O3-1 同毫秒 added log 缺条 | ✅ 修复（C2：added 允许 `at>=cutoff`），derive 测试 6.1 覆盖 |
| O3-2 未封板期依赖变更入 log | ✅ 修复（cutoff=∞），测试 6.2 覆盖 |
| O3-3 counts 与 log 口径不一致 | ✅ 修复（counts 按 log 计；数组仍按任务去重取最后），测试 6.3 覆盖 |
| O3-4 todo→team 切换语义 | ✅ 注释 + 测试 6.4 覆盖 |
| W4.1/W4.2 关系校验 + fold | ✅ B/C 独立复验；host/derive 测试覆盖 |
| W4.3 子节点渲染/父任务提示/不改状态 | ✅ D 独立复验；E2E 合成 + 真实调用 |
| O4 降级视图详情「共 N 条」as-of 聚合 | ❌ **未在 M4 处理**（client.js `spanTotal` 逻辑未改，diff 0）→ 转 M5 观察（P3-m4-5） |

---

## 8. G. 环境与仓库卫生（12/12 通过）

| # | 项 | 结果 |
|---|---|---|
| 1 | HEAD / 工作区 | `543b69f`；`git status --short` 仅 `?? docs/M4-AUDIT.md` ✅ |
| 2 | 隔离环境 | `~/.dsh-lab` **不存在** ✅ |
| 3 | 用户 profile | `~/.dsh/profiles/{desktop,web,headless}/package.json` 均无 `@local/dsh-task-map` ✅ |
| 4 | 投影缓存 | `~/.dsh/storages/session_projcache` 无 `"taskMap"` 投影键 ✅ |
| 5 | 冻结数据 | fixtures/golden 自 M1（`d14b015`）未改 ✅ |
| 6 | M1/M2/M3 证据 | M2 证据未改；M3 截图/JSON 未改；M3-E2E 报告仅 233af35 一句措辞修正（M3 审计建议项）✅ |
| 7 | 版本/契约 | package 0.4.0；index/client VERSION `0.4.0-m4`；STATE_VERSION=3；投影注册 3 ✅ |
| 8 | 测试计数一致 | README/进度日志/执行清单：derive 286 / host 31 / client-smoke 513 / client-logic 260；E2E M3 45 / M4 24；截图 4 张 ✅（host 32→31 已修，D-M4-1） |
| 9 | 截图 | 4 张有效 PNG 1680×1050、与 JSON/run2 同轮 10:09 ✅ |
| 10 | 无凭据泄漏 | 代码/测试/文档/JSON 扫描无 `sk-*`/Bearer/password/token（JSON token 已脱敏；lab URL 仅在仓库外 tmp）✅ |
| 11 | 无构建产物 | 无 dist/build/node_modules；`npm files` 白名单仅运行必需文件；75 个跟踪文件均为源码/文档/测试/证据 ✅ |
| 12 | 文档状态 | README 链接 M4-AUDIT（待收口）、执行清单 W4.1~W4.3 勾选 + Gate M4 待审计（收口时勾选）；进度日志 W4.3 历史行「2.6s」为残余 P3 提示 ✅（不阻断） |

---

## 9. 问题清单（定级与状态）

### 9.1 已闭环（D-M4-1~7：首轮 26a037d 发现 → 543b69f 修正 → 审计复核）

| ID | 级别 | 类型 | 描述（首轮发现） | 闭环（543b69f 复核） |
|---|---|---|---|---|
| D-M4-1 | P2（文档） | 数字不实 | `host-smoke` 文档写 32 项（README×2、进度日志 W4.1「27→32」），实测 **31** | ✅ README 两处改 31、进度日志改「23→31」；无 32/27→32 残留；实测 31 复核 |
| D-M4-2 | P3（文档） | 自相矛盾 | README M1 节「stateVersion=2」与版本节「=3」矛盾 | ✅ 改为 3（注明 M1 时点=2，M4 升版） |
| D-M4-3 | P3（文档） | 历史计数易误读 | README M1/M2 节 270 / 464/240 未标注时点，与当前 286/513/260 并存 | ✅ 标注「M1/M2 交付时点」并指向当前值 |
| D-M4-4 | P3（证据） | 归属不实 | M4-E2E §2「不改状态」引用的 reset 对比发生在真实工具调用之前（合成 preview 路径） | ✅ 改为三路证据归属（工具无写路径 / fold 不改 tasks / reset 只证明 preview 不改数据） |
| D-M4-5 | P3（表述） | 过度断言 | 「高亮子节点 2.6s（组件测试断言）」未测定时清除，且甘特侧有缺陷 | ✅ 删 2.6s，注明定时未测 + 甘特缺陷记 M5 |
| D-M4-6 | P3（透明度） | 轮次披露 | 报告提「两次运行」但未说明 run1 24/2 | ✅ §6.5 透明说明 run1 失败原因、run2 为最终证据 |
| D-M4-7 | P3（证据） | 提取口径 | JSON relationBadges/childOf 含空 id 噪声未说明 | ✅ §6.6 注明流程图+甘特两层提取口径 |
| （P3-2） | P3（行为） | 行为说明 | 无效关系仍计入「拆分」变更流/计数 | ✅ §6.2 已注明截图可见，M5 决定标记/剔除 |
| （P3-3） | P3（元数据） | 陈旧注释 | lib/index 注释「当前 2」、header M1、health `mode:'m1'` | ✅ 均已修（注释/元数据，无功能变更） |

> D-M4 修正经审计方 diff 复核：`26a037d..543b69f` 仅 5 文件，其中 index.js/lib/derive.js 改动为注释/元数据，测试与审计脚本在最终 HEAD 重跑全绿。

### 9.2 残余 P3 观察（不阻断 Gate M4，转 M5）

| ID | 级别 | 描述 | 影响 / 跟进 |
|---|---|---|---|
| P3-m4-1 | P3 | **甘特高亮子行缺陷**：① `h('g', {...})` props 中 className 重复键（后者覆盖前者，初始渲染丢 `tm-child-hl`）；② `createGanttUpdater` 在 `signature` 未变时提前 `continue`，highlight 单独变化（2.6s 定时清除/仅 repaint）不会刷新 → 暂停态下甘特高亮可能不显示或不清除（Flow 节点路径正常）。组件测试用「预置 highlightRef 的初始渲染」断言，未覆盖真实路径 | 视觉细节，不影响 US-7 核心（记录/渲染/不改状态）；M5 修 + 补真实交互路径断言（Lead 已确认接受为真实缺陷） |
| P3-m4-2 | P3 | host-smoke「任务板未被改动」断言偏弱（仅检查 id 仍存在） | 测试质量问题；本审计已用深冻结/源码扫描独立补强；M5 加强断言 |
| P3-m4-3 | P3 | 无效关系仍计入「拆分」变更流与计数 chips（截图 invalid-relation 可见「拆分 3 / 数据缺失 2」） | 报告 §6.2 已注明；M5 决定标记无效/剔除计数或维持只记录口径 |
| P3-m4-4 | P3 | 进度日志 W4.3 历史行仍写「高亮子节点 2.6s」（未随 M4-E2E 修正） | 历史行惯例可接受；建议收口时标注/修正 |
| P3-m4-5 | P3 | O4 未闭环：降级视图详情「共 N 条（截至回放时刻）」仍用最终 `spanCount`（>~60 任务降级视图触发；3 会话不触发） | M5 观察/按 as-of 聚合或标注累计 |

### 9.3 不阻断但已知（M5 范围）

- M5-1：`/task-map/api/health` 无同源鉴权（P0 发布阻断，W5.1 修复）；本次顺手确认 `mode` 字段已由 'm1'→'m4'（仍属调试字段，W5.1 移除）。
- M5-2：实时事件未端到端（M4 以真实模型调用验证关系工具链路）。
- M5-4：E2E 一次性证据、rAF 代理指标。
- M5-5：fixtures/截图隐私面（仓库公开前脱敏；npm `files` 已排除 docs/fixtures）。

---

## 10. Gate M4 判定

| 判据 | 结果 | 证据 |
|---|---|---|
| US-7 场景通过（拆分分叉 + 变更记录） | **PASS** | 真实工具调用→投影→渲染链路（JSON/run2/截图时间戳吻合）；数据层/客户端独立验证 |
| 插件不改任务状态 | **PASS** | 工具无写路径（B）；fold 不改 tasks JSON（C）；客户端只读（D）；合成 reset 断言（E，归属已修正） |
| 工具校验（id/kind/去重/自引用/上下文降级） | **PASS** | B 59/59 + 真实调用非法 id 被拒（E） |
| 投影解析/幂等/无效关系 warnings | **PASS** | C 60/60 |
| 客户端关系层 UI（徽标/子节点/详情/提示/无效/高亮回调/版本） | **PASS** | D 68/68 |
| M1/M2/M3 不回归 + STATE_VERSION 契约 | **PASS** | A 1,090/1,090；STATE_VERSION=3 全链路一致；旧 v2 降级安全 |
| 环境与证据卫生 | **PASS** | G 12/12；D-M4-1~7 闭环 |

**最终判定：PASS（Gate M4 通过）。** 残余项均为 P3 视觉/测试质量/证据强度观察，转 M5。

---

## 11. 残余风险（Top5）与 M5 跟进清单

**残余风险 Top5**

1. **甘特高亮真实路径缺陷（P3-m4-1）**：暂停态下甘特子节点高亮可能不显示/不清除；不影响 US-7 核心，但属 UI 真缺陷，M5 修 + 补断言。
2. **无效关系计入变更流/计数（P3-m4-3）**：模型收到「not recorded」而 UI 变更流仍出现该拆分（chips 拆分数含无效），可能误导复盘；M5 决定口径。
3. **E2E 一次性证据**：隔离实例已删；真实工具调用/渲染为 JSON+run2+截图+宿主日志四方交叉，仍属实现者证据。
4. **「不改状态」无真实调用前后对比**：由无写路径+fold 不变+客户端只读三路机制证据支撑；真实调用未做前后状态断言。
5. **测试/断言质量**：host-smoke「任务板未被改动」断言偏弱（P3-m4-2）；甘特高亮测试未覆盖真实路径；O4 降级视图计数未闭环（P3-m4-5）。

**M5 跟进清单**

- [ ] 修甘特高亮：去掉 `h('g')` 重复 className 键；`createGanttUpdater` 将 highlighted 纳入签名或独立比较；补真实交互路径断言（点击拆分→高亮→2.6s 清除）。
- [ ] 无效关系口径：变更流标记无效/剔除计数，或文档明确维持「只记录」（与产品/用户确认）。
- [ ] 加强 host-smoke「任务板未被改动」：执行前后快照对比。
- [ ] O4 降级视图详情「共 N 条」按 as-of 聚合或标注累计（长会话）。
- [ ] W5.1 health 同源校验 + 移除调试字段（含 `mode`）；W5.2 安装/卸载文档；W5.3 可复跑 E2E（含真实 Agent Teams profile 真实对话拆分）；W5.4 3 会话验收报告；W5.5 脱敏与文档收口。
- [ ] 进度日志 W4.3 历史行「2.6s」标注/修正（收口时顺手处理）。

---

## 12. 复现命令附录

```bash
# A. 测试（仓库根目录，最终 HEAD 543b69f）
cd ~/dsh-task-map
npm test                                   # exit 0
node test/derive.test.mjs                  # 286 checks, 0 failed
node test/host-smoke.mjs                   # 31 ✓ → PASS
node test/client-smoke.mjs                 # PASS (513 checks)
node test/client-logic.test.mjs            # PASS (260 checks)

# B/C/D. 审计方独立脚本（一次性，/tmp，不写仓库；最终 HEAD 上重跑）
node /tmp/m4-audit-b.mjs    # 关系工具校验（stub ctx + 深冻结任务板）：59/59
node /tmp/m4-audit-c.mjs    # 数据层 O3 边界 + 关系数据：60/60
node /tmp/m4-audit-d.mjs    # 客户端关系层（stub 宿主+伪 React）：68/68
python3 /tmp/m4-audit-e.py  # E2E JSON↔run2↔截图↔报告↔D-M4 闭环：101/101

# E. E2E 证据交叉（只读）
git ls-files 'docs/m4-*.png' | wc -l                       # 4
grep -c '  ✓' tmp/e2e-work/m4-e2e-run2.log        # 24
grep -E '^\[m4-e2e\]' tmp/e2e-work/m4-e2e-run2.log # 24 checks, 0 failed → PASS
python3 -c "import json;d=json.load(open('docs/m4-e2e-verification.json'));print(d['synthetic'], d['realTool']['sent'], len(d['realTool']['evidence']), d['consoleErrors'])"
python3 -c "import json,struct;raw=open('docs/m4-real-tool-relation.png','rb').read(24);print(struct.unpack('>II',raw[16:24]))"   # (1680,1050)

# G. 环境与仓库卫生
git rev-parse HEAD                                            # 543b69f...
git status --short                                            # 仅 ?? docs/M4-AUDIT.md
ls ~/.dsh-lab                  # NOT EXISTS
grep -l 'dsh-task-map' ~/.dsh/profiles/*/package.json         # 无输出
git diff --stat d14b015..HEAD -- test/fixtures docs/golden-values.json   # 空
grep -rnE 'sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{10,}|password\s*[:=]' \
  --include='*.js' --include='*.mjs' --include='*.json' --include='*.md' . | grep -v test/fixtures/   # 无输出
```

> 说明：E2E 隔离实例与 `tmp/e2e-work/*`（run1/run2 日志、E2E 脚本、宿主日志）为仓库外一次性证据，可能随工作区清理消失；本报告记录审计时刻（2026-11-05 10:10~10:35 Asia/Shanghai）的只读核对结果。

---

## 附：审计执行摘要

- 审计起始基线 `26a037d`；首轮发现 D-M4-1~7（1 项数字不实 + 证据归属/表述问题）并发送 Lead；Lead 修正后 **FINAL HEAD=`543b69f`**（diff 复核：5 文件，代码仅注释/元数据）。审计方在 `543b69f` 上重跑 `npm test`（1,090/1,090）与全部独立脚本（B 59、C 60、D 68、E 101），结果与首轮一致或更强。
- 关键独立证据：深冻结任务板 + 源码扫描证明工具只读；手算事件流验证 O3-1~4 全部修复；relation fold 前后 tasks JSON 全等；客户端 68 项关系层断言；E2E evidence 时间戳与截图回放时刻（+11:20:44 / +11:21:23 / +11:20:46）三方吻合。
- 审计方未修改任何代码/测试/fixture/golden/进度日志；唯一写入为本文件 `docs/M4-AUDIT.md`。未运行 `dsh plugin`/`dsh web`/`make-fixtures`、未 npm install、未联网、未写 `~/.dsh`、未 git commit。
