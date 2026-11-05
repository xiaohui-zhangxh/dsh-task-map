# M1 数据说明：真实会话 fixture 与黄金值（W1.4a / W1.4b）

> 负责人：data-fixtures（数据与黄金值）｜生成时间：2026-11-05 03:22（Asia/Shanghai）
> 产物：`tools/make-fixtures.mjs`、`test/fixtures/*.jsonl` + `MANIFEST.json`、`tools/handcalc.py`、`docs/golden-values.json`
> 原则：**真实数据是唯一真相**。本文件所有数值均由脚本从真实会话事件计算得出，没有手填；与交接文档不一致处如实记录在 §3.2。

---

## 1. 目的与数据流

任务地图 M1 需要 3 个真实 DSH 会话做「脱敏冻结 fixture」与「独立手算黄金值」：

```text
~/.dsh/sessions/<proj>/<session>/session.v4.jsonl.zstd     （真实会话，只读）
        │ ① 复制（不直接读源文件，避免会话仍在追加时读到撕裂数据）
        ▼
$TASK_MAP_SNAPSHOT_DIR/<slug>.session.v4.jsonl.zstd         （字节级快照，仓库外，不提交）
        │ ② zstd -dc 解压（追加式多帧 zstd；Node zlib 只解第一帧，不能用）
        ▼
$TASK_MAP_SNAPSHOT_DIR/<slug>.jsonl                         （解压快照，golden 的唯一输入）
        │ ③ 白名单过滤 + 逐类型裁剪/脱敏/截断
        ▼
test/fixtures/<slug>.jsonl + MANIFEST.json                  （提交进仓库，单文件 < 1MB）
        │ ④ Python 独立实现重算同一口径
        ▼
docs/golden-values.json                                     （黄金值，±0ms 基准）
```

哈希链（`MANIFEST.json` 记录、`handcalc.py` 校验）：

`sourceZstdSha256`（复制后的 zstd 字节）→ `snapshotJsonlSha256`（解压后的 `.jsonl`）→ `fixtureSha256`（裁剪后的 fixture）。
`handcalc.py` 读取快照后先比对 `snapshotJsonlSha256`，再比对 `fixtureSha256`，任一不符即退出非 0。

- 快照目录默认：`~/tmp/e2e-work/snapshots`（仓库外，**不提交**）；
  可用 `TASK_MAP_SNAPSHOT_DIR` 覆盖。源会话根默认 `$DSH_SESSIONS_ROOT`（= `~/.dsh/sessions`）。
- 本文件所述快照对应 `MANIFEST.json` 中 `sessions[]` 条目内的 `parsedAt`：`2026-11-04T19:22:42Z`（= 2026-11-05 03:22 +08:00）。
- 会话源文件全程只读；`~/.dsh` 未被修改（只做了 `fs.copyFileSync` 读取复制）。

---

## 2. 三个会话与 fixture 现状

| slug | sessionId | 标题（最后一次 `session/title`） | cwd（脱敏） | 源事件 | 保留事件 | fixture 大小 | fixture sha256（前 16） |
|---|---|---|---|---|---|---|---|
| `baklib-feishu-sso` | `session-a1c3d78d-eaa0-405e-807d-3c037524a987` | 开发飞书 SSO 功能分支 | `/workspace/baklib` | 1157 | 984 | 191,406 B（186.9 KB） | `2045c8bfc177e62d` |
| `p2p-athena-port` | `session-886d1772-1e3c-4283-8703-58d74949bf8a` | Rust 实现 P2P 打洞与中控平台 | `/workspace/hermes-workspaces` | 1782 | 1449 | 257,899 B（251.9 KB） | `efb75f42bbd728ae` |
| `athena-plan-board` | `session-7959b49b-7cde-41fa-8cf1-8156e91ae060` | # Athena 重构 分析 - 衍生项目计划看板 | `/workspace/hermes-workspaces` | 1007 | 813 | 149,095 B（145.6 KB） | `4823a72ab05eb318` |

- 3 个快照解析时**均无坏行**：`incompleteTailLines = 0`；末行不完整容错逻辑已实现并记录在 `MANIFEST.sessions[].incompleteTailLines`。
- 源事件 → 保留事件之间的差集全部是白名单外事件类型，逐类型计数在 `MANIFEST.sessions[].droppedTypes`。
- fixture 三文件均远小于 1MB 上限（脚本内置硬校验，超限即失败）。

### 2.1 各会话业务概况（来自事件，非描述）

| 指标 | baklib-feishu-sso | p2p-athena-port | athena-plan-board |
|---|---|---|---|
| 会话创建时间（header.createdAt） | 2026-11-04 22:47:44 | 2026-11-05 01:08:05 | 2026-11-05 01:26:21 |
| 标题事件数 | 2 | 2 | 3 |
| 回合（turn） | 1 | 6 | 2（其中 turn 1 为继承历史） |
| isSeeded / parentSession | `false` / 无 | `false` / 无 | `true` / `session-3e3b5b23-…` |
| 任务板 teamId | 本会话 id | 本会话 id | **父会话 id**（`session-3e3b5b23-…`，继承任务板） |
| team/task 快照数 | 27 | 27 | 18 |
| 任务数（去重后） | **8** | **9** | **6** |
| 任务最终状态 | 8 completed | 9 completed | 6 completed |
| 成员（team/member 去重） | 6（含 1 个注册失败 docs-qa） | 3 | 7（含 failed/provisioning 成员） |
| 子代理（subagent/catalog） | 5 | 8 | 6 |
| spawn_teammate 工具调用 | 7 | 3 | 8 |
| tool/call | 203 | 246 | 146 |
| job/registered | 109 | 164 | 84 |
| 审批 asked/decided | 1 / 1 | 0 / 0 | 0 / 0 |
| wait_agent / ask_user_question | 8 / 2 | 21 / 0 | 16 / 0 |
| todo/write | 3 | 4 | 0 |
| tool 错误（tool/result error/isError） | 3 | 1 | 3 |
| job killed | 0 | 2 | 0 |
| Token 输入 / 输出 / 缓存读 / total | 211,337 / 135,313 / 23,146,624 / 23,493,274 | 165,425 / 295,714 / 49,146,496 / 49,607,635 | 191,564 / 120,812 / 19,708,416 / 20,020,792 |

---

## 3. 与交接文档 / 调研文档的差异（如实记录）

### 3.1 一致项

- `baklib-feishu-sso`：与交接文件 §6 / 调研文档 03 §3.1 **完全一致**（1157 事件、8 任务全完成、6 成员、5 子代理、1 审批 8.6s、1 回合、87.2min；token 各项一致）。
- `athena-plan-board`：任务数 6、全部完成，与交接文件一致。

### 3.2 不一致项（以真实快照为准）

1. **`p2p-athena-port` 的任务数/完成度已过期**：交接文件 §6 写「P2P 打洞，5 任务（2 未完成）」，但快照实际是 **9 个任务、全部 completed、6 个回合、wallClock 115.9min**。
   原因：该会话在交接时点之后继续推进（会话源文件最后写入时间晚于交接时间），「5 任务 2 未完成」是旧快照真相，不是编造；本 fixture 冻结的是 2026-11-05 03:22 的快照。
   → **黄金值以 9 任务全完成为准**；M1 的「未完成态」验收样本在本快照中不再存在（见 §7 风险）。
2. **`athena-plan-board` 是历史恢复会话**：`isSeeded=true`、有 `parentSession`，`header.createdAt`（01:26:21）**晚于**首个事件 `turn/start`（00:39:26），因此 `preTurnMs` 为**负数**（−2,815,140ms ≈ −46.9min），`preTurnRestored=true`。交接文件未提到该会话是恢复会话。
3. **athena 的任务板来自父会话**：`team/task.teamId = session-3e3b5b23-…`（≠ 本会话 header.id）。6 个任务的 `ownerId` 全部是继承的 teammate id（product-designer/tech-architect/ai-architect/delivery-planner/researcher/reviewer），**没有** ownerId 等于本会话 id，也没有等于父会话 id 的，所以按口径 `ownerIsLead` 全为 `false`；`agents` 里包含 7 个继承成员（含 `dev-planner` 等注册失败/未使用的成员）。
4. **p2p 的 agent 命名与工具用法**：该会话用 `subagent` 工具 5 次（而非 `spawn_teammate`）做只读子代理，`spawn_teammate` 仅 3 次；`counters.teammates` 口径是 `spawn_teammate`，故为 3；`subagents`（catalog）为 8。UI 展示时不要混用这两个口径。
5. **交接文件 §6 说 baklib「8 任务全完成（87min）」** 与快照一致；`§3` 里「P2P 5 任务」「task-7 阻塞 22.5min」这两个描述前者的任务数已过期（后者 baklib 仍然成立）。

---

## 4. 裁剪与脱敏规则

### 4.1 保留事件类型（白名单，其余丢弃并计入 `droppedTypes`）

`session`（仅头行）、`session/title`、`turn/start`、`turn/end`、`step/start`、`step/end`、`team/task`、`team/member`、`todo/write`、`tool/call`、`tool/result`、`job/registered`、`job/settled`、`approval/asked`、`approval/decided`、`subagent/catalog`、`subagent/descriptor`、`assistant/message`、`deliverables/presented`、`command/run`、`command/done`、`session/end-seed`、`goal/change`。

被丢弃的主要类型（以 baklib 为例）：`session-log-deepseek/delivery-accepted`(102)、`agent/inbox/spliced`(34)、`user/message`(24)、`web/deepseek-search-llm-request`(3)、`request/header`/`request/context`/`system/message`/`agent-preset/selected`/`model/selection`/`approval/policy`/`permission/preset`/`sandbox/mode`/`workspace/changes`/`session/title-llm-request`(各 1)。

**为什么这些不保留**：`user/message`、`assistant/message.message/stream`、`tool/call.arguments`、`tool/result.message.content` 是正文/参数/输出，可能含真实业务代码、凭据线索、外部页面内容；fixture 只需要「任务/时间/等待/成本/过程骨架」，不需要正文。同理 `request/*`、`web/*`、`*llm-request` 是模型请求体，直接丢弃。

### 4.2 逐类型字段

所有事件输出顶层 `{type, seq, time, data}`（`session` 头行保留原始字段，`cwd` 替换）。逐类型保留字段：

| 事件 | 保留 data | 明确删除 |
|---|---|---|
| `session`（头） | `type,version,id,createdAt,cwd(脱敏),agentPreset,isSeeded,delegationDepth` | `parentSession` 等其它 |
| `team/task` | `version, teamId, task{id,revision,subject≤200,description≤300(脱敏),status,blockedBy,writeScopes(≤20 项),ownerId}` | 任务其它字段 |
| `team/member` | `version, teamId, member{id,name,description≤120,provider,context,phase}` | `member.error` |
| `todo/write` | `todos[{content≤120,status}]` | — |
| `turn/start` / `turn/end` | `{turn[,reason.kind]}` | — |
| `step/start` / `step/end` | `{turn,step}` | — |
| `tool/call` | `{turn,step,callId,name}`；**仅 `task_map_record_relation` 保留 `arguments` 原串** | 其余工具 `arguments` |
| `tool/result` | `{turn,step,message{toolCallId,isError?},error?}` | `message.content/source/meta/id`、`data.meta` |
| `job/registered` | `{jobId,kind,startedAt,toolCall{callId,rootCallId}}` | `label/owner` |
| `job/settled` | 同上 + `finishedAt,status` | `label/owner/detail/cause/producerReported` |
| `approval/asked` | `{id,toolName,callId}` | `reason` |
| `approval/decided` | `{id,outcome}` | — |
| `subagent/catalog` | `{version,childId,childCreatedAt,mode,label≤120}` | — |
| `subagent/descriptor` | `{version,childId?,mode,provider,label≤120,agentModel,agentProvider}`（有就留） | — |
| `assistant/message` | `{turn,step,usage{5 个 token 字段}}` | `message/stream/source` |
| `session/title` | `{title≤120}` | `messageSeqs/source` |
| `deliverables/presented` | `{turn,callId,files[{path(相对化),description≤120}]}` | — |
| `command/run` / `command/done` | `{commandId,name}` / `{kind,text≤120}` | `args/source` |
| `session/end-seed` | `{inherited}` | — |
| `goal/change` | `{operation,goal{id,phase}}` | objective 等 |

补充约定（实现细节，供 derive/test 参考）：

- `tool/result.message.isError` **只在为 `true` 时保留**（false 是默认值，不落盘）；`error` 对象（`{name,code}`）原样保留。
- 截断规则：`len > max` 时取前 `max` 个字符再追加 `…`（不改变字符编码）。
- 缺失字段不补（原事件没有的字段，fixture 也不造）。
- 交付物路径：若以会话 `cwd + "/"` 开头则转成相对路径；否则退化为脱敏后的绝对路径。3 个会话的交付物均可相对化。

### 4.3 脱敏

1. 会话 `cwd` 前缀整体替换：`<cwd>` → `/workspace/<basename(cwd)>`，例如 `~/Codes/baklib` → `/workspace/baklib`、`~/hermes-workspaces` → `/workspace/hermes-workspaces`；
2. 其余 `/Users/<username>/...` 绝对路径兜底替换为 `/workspace/<top>/...`；只剩裸用户名时 → `/workspace`；
3. 用户名 `xiaohui`、`/Users/` 绝对路径在 3 个 fixture 中的残留数均为 **0**（已用 grep 验证）。

### 4.4 不保留的内容（泄漏面）

fixture 中**没有**：工具参数（`task_map_record_relation` 除外，本 3 会话实际为 0 条）、工具输出正文、assistant 正文/思考、用户消息、模型请求体、审批理由、job label/detail（含命令原文）。
fixture 中**仍有**：任务标题/描述（截断后）、成员名/描述、todo 内容、命令名、交付物描述、标题。这些是 M1 derive 与 M2 UI 展示所需的最小语义数据；其中 p2p 的任务/交付物描述包含内网地址（如 `https://172.22.2.2:60109`）与真实需求描述，**仅作本地测试 fixture，不要随插件发布到公开制品**（如需公开再评估）。

---

## 5. 复现命令

```bash
cd ~/dsh-task-map

# 1) 生成 fixture + MANIFEST（需要系统 zstd：brew install zstd）
node tools/make-fixtures.mjs
#   可选：TASK_MAP_SNAPSHOT_DIR=/tmp/task-map-snap node tools/make-fixtures.mjs
#   可选：DSH_SESSIONS_ROOT=/path/to/sessions node tools/make-fixtures.mjs

# 2) 独立手算黄金值（会校验快照/fixture sha256 与 MANIFEST 一致）
python3 tools/handcalc.py
#   可选：python3 tools/handcalc.py --snapshots /tmp/task-map-snap

# 3) 自检（golden 已随仓库提交；重跑应字节级一致）
shasum -a 256 docs/golden-values.json test/fixtures/*.jsonl

# 4) 手工核对某个任务的依赖阻塞（可选）
python3 - <<'PY'
import json
g = json.load(open('docs/golden-values.json'))
t = g['sessions']['baklib-feishu-sso']['tasks']['task-7']
print(t['blockedWaitMs'], t['readyDelayMs'])  # 1351134 36699
PY
```

已验证：

- `node tools/make-fixtures.mjs` 重复运行 → 3 个 fixture 的 sha256 **完全稳定**；`MANIFEST` 只有 `parsedAt` 变化（符合预期）。
- `python3 tools/handcalc.py` 重复运行 → `docs/golden-values.json` 字节级一致（sha256 `f0168d1e575a70…`）。
- 故意改坏快照 → `handcalc.py` 以非 0 退出并打印 hash 不一致（自校验有效）。

---

## 6. 黄金值速览（`docs/golden-values.json`）

时间单位：除特别标注外均为**原始毫秒整数**；下表为方便阅读换算为分钟/秒（换算不写回 golden）。

### 6.1 会话级速览

| 指标 | baklib-feishu-sso | p2p-athena-port | athena-plan-board |
|---|---|---|---|
| `taskCount` | 8 | 9 | 6 |
| `order` | task-1..task-8 | task-1..task-9 | task-1..task-6 |
| `taskStats` | completed 8 | completed 9 | completed 6 |
| `turns` 数 | 1 | 6 | 2 |
| `wallClockMs` | 5,230,339（87.17min） | 6,954,750（115.91min） | 68,161（1.14min） |
| `preTurnMs` | 2,867,304（47.79min） | 247,968（4.13min） | **−2,815,140（−46.92min）** |
| `preTurnRestored` | false | false | **true** |
| `humanIdleMs` | 0 | 984,934（16.42min） | 696,653（11.61min） |
| `queueMs` | 2,354,635（39.24min） | 334,297（5.57min） | 1,121,170（18.69min） |
| `blockedMs` | 1,351,134（22.52min） | 0 | 0 |
| `readyDelayMs` | 36,699（36.7s） | 0 | 0 |
| `taskExecMs` | 4,823,466（80.39min） | 7,078,754（117.98min） | 4,280,334（71.34min） |
| `waitAgentMs` | 824,680（13.74min） | 2,298,402（38.31min） | 1,394,517（23.24min） |
| `askUserMs` | 128,139（2.14min） | 0 | 0 |
| `approvalMs` | 8,638（8.64s） | 0 | 0 |
| `maxHandoffMs` | 456,218（task-4→task-7） | 655,508（task-6→task-9） | 23,563（task-1→task-4） |
| `counters.spans.openCount` | 0 | 0 | 0 |
| `spans.errorCount` | 3 | 1 | 3 |
| `spans.killedCount` | 0 | 2 | 0 |
| `usage` input/output/cacheRead/total | 211,337 / 135,313 / 23,146,624 / 23,493,274 | 165,425 / 295,714 / 49,146,496 / 49,607,635 | 191,564 / 120,812 / 19,708,416 / 20,020,792 |

> `taskExecMs > wallClockMs` 不是错误：并行任务区间重叠（baklib 峰值 5 个任务同时 in_progress）。UI 必须同时展示「累计」与「墙钟」，并标注并行。
> `humanIdleMs` 按 Lead 口径只统计「相邻 turn 之间的正间隔」，不包含会话创建→首轮（那部分在 `preTurnMs`）。产品方案 §6.2 的「人工空闲」措辞含创建→首轮，M1 拆成两个字段，UI 汇总时把两者相加即可。

### 6.2 关键任务逐项核对（交接文档 §10.2 验收点）

- `baklib-feishu-sso` / `task-7`（全链路验收，依赖 task-1~6）：
  - `createdAt=1793806924142`、`startedAt=1793808311975`、`completedAt=1793808620749`
  - `blockedWaitMs=1,351,134`（**22.52min**，≈交接文档 22.5min）
  - `readyAt=1793808275276`（= task-5 completedAt，6 个 blocker 中最晚者）、`readyDelayMs=36,699`（**36.7s**）
  - `queueMs=1,387,833`、`execMs=308,774`、`doneRank=8`、`owner=qa-verifier`
- `baklib-feishu-sso` 中 `ownerIsLead=true` 的任务：`task-1`、`task-6`（ownerId = 本会话 id）；其余 6 个由 teammate 认领。
- `athena-plan-board`：6 个任务的 `owner` 全部映射到继承成员名，`ownerIsLead=false`；`phases` 均为 `pending → in_progress → completed` 三段，无重复状态。
- `p2p-athena-port`：9 个任务 `phases` 均为三段；`startRank/doneRank` 1..9 连续；`owner` 分布 controller-dev×4 / agent-dev×3 / web-dev×2。
- 三个会话 `relations` 均为 `[]`（本 3 个会话没有调用过 `task_map_record_relation`；关系层需要 M4 用合成事件测）。

---

## 7. 风险与未决

1. **会话仍在增长**：`p2p-athena-port` 快照时间 03:22，源会话历史上出现过交接后继续追加任务的情况（§3.2）。本 fixture 是**冻结快照**；若之后重新运行 `make-fixtures.mjs`，`sourceZstdSha256`/事件计数/黄金值都可能变化。M1 黄金测试必须使用仓库内提交的 fixture，**不要在 CI 里读真实会话**。
2. **未完成态样本缺失**：交接文档计划用 p2p 会话做「2 个 in_progress」验收，实测该会话已全部完成。M1 golden 三会话全 completed；「未完成/进行中」状态由测试合成事件覆盖（W1.5/W1.2 的单测负责），或在后续再挑一个真实会话补 fixture（需 Lead 决定，不建议现在扩大范围）。
3. **`taskExecMs`/`waitAgentMs` 取事件时间而非调度真值**：`tool/result` 时间包含排队；`wait_agent` 等待与任务执行可能重叠（调研文档 03 §5.4），UI 仍要标注「事件口径」。
4. **执行过程归属仍是推断**：fixture 不含 tool→task 外键；M1 只保证任务级指标精确，M2 的「某工具属于某任务」必须标「按时间窗推断」。
5. **fixture 含真实任务描述**：截断到 300 字，但仍含真实项目名/内网地址；只作本地测试，不要随插件公开分发（发布前复核）。
6. **`trailing incomplete line` 当前为 0**：容错逻辑已实现（丢弃并记录）；但快照是复制后解压的完整文件，正常不会触发。
7. **athena 的负数 preTurn**：这是历史恢复会话的合法数据（不是 bug）；`preTurnRestored` 为 true 时 UI 文案应显示「会话从历史恢复」，不能显示负数等待。
8. **口径待 Lead 确认**：p2p 的 `teammates=3` 只统计 `spawn_teammate`，而它用 `subagent` 工具起了 5 个只读子代理；如果产品口径把两类都算「子代理」，需要另加计数（golden 已按 SPEC 只提供两者分散字段：`counters.teammates`、`counters.subagents`、`spans.tool`）。

---

## 8. 产物清单

| 路径 | 说明 | 是否提交 |
|---|---|---|
| `tools/make-fixtures.mjs` | fixture 生成器（Node ESM、零外部依赖、`zstd -dc`） | 是 |
| `tools/handcalc.py` | 独立手算（Python 标准库，不读 `lib/derive.js`） | 是 |
| `test/fixtures/baklib-feishu-sso.jsonl` | 飞书 SSO 会话（8 任务全完成） | 是 |
| `test/fixtures/p2p-athena-port.jsonl` | P2P/Athena 会话（9 任务全完成，含 6 回合） | 是 |
| `test/fixtures/athena-plan-board.jsonl` | Athena 计划看板（6 任务，恢复会话） | 是 |
| `test/fixtures/MANIFEST.json` | 哈希链 + 事件计数 + 丢弃类型统计 | 是 |
| `docs/golden-values.json` | 黄金值（M1 测试基准） | 是 |
| `docs/M1-DATA-NOTES.md` | 本文件 | 是 |
| `$TASK_MAP_SNAPSHOT_DIR/*.zstd`、`*.jsonl` | 源 zstd 副本 + 解压快照 | **否**（仓库外，禁止提交） |
