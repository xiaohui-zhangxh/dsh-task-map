# M1 独立验收审计报告（Gate M1）

> 审计员：**m1-verifier**（独立于实现者）｜审计时间：2026-11-05 03:40–03:47（Asia/Shanghai）
> 版本：v1.1（03:47 复核实现者文档修正，原 D-1/D-2 关闭，见 §5.8）
> 审计对象：`dsh-task-map` M1 数据核心（W1.1~W1.6，`0.1.0`）
> 审计方式：**只读 + 独立重算**。不复用实现者的测试/手算结论；能重算的一律从原始会话快照重算，不能重算的（已删除的隔离实例）明确标注「依赖实现者证据」。
> 仓库写入范围：仅本文件（`docs/M1-AUDIT.md`）；未改代码/测试/fixture/golden/进度日志，未执行 `make-fixtures`/`dsh plugin`/`dsh web`/`git init`/装包/联网。

## 0. 结论

**PASS（初版 1 项文档 FAIL 已修正闭环）**。

- M1 数据核心的**功能判据全部由审计方独立重算确认成立**（§3、§4、§5、§7）。
- 初版审计发现 **1 项 FAIL（仅文档准确性，非代码/数据缺陷）**：`docs/M1-LAB-VERIFICATION.md` 声称「91 项断言通过，0 项失败」，而最后一份隔离实例验证日志为 **91 passed / 1 failed**。
- 实现者已于 03:45 修正该报告（断言计数、失败项说明、视图体积来源区分）；审计方**直接复核文件**确认修正属实、且未触碰代码/fixture/golden（哈希与 mtime 均未变），该项**已修正闭环**（§5.8）。
- 校正后：**A / B1 / B2 / B3 / C / D 全部 PASS，0 项未闭环 FAIL**；余下为非阻断风险，已定级并转入 M2/M5 跟进（§7）。

| 审计组 | 内容 | 结论 |
|---|---|---|
| A | 测试全绿（derive / host / client） | **PASS**（171 / 23 / 13） |
| B1 | handcalc 再生成 golden 字节一致 | **PASS**（sha256 相同） |
| B2 | 从原始快照独立重算三会话黄金值 | **PASS**（0 diff） |
| B3 | DATA-NOTES「p2p 9 任务全完成 / athena 负 preTurn / 未完成态覆盖」核对 | **PASS** |
| C | 投影契约与实现审查（derive.js / index.js） | **PASS** |
| D | 数据与仓库卫生 | **PASS**（D-1/D-2 已修正闭环；D-3/D-4/D-5 非阻断） |
| E | M1 Gate 判定 | **PASS** |

审计前后仓库关键哈希不变：`golden f0168d1e…bcffa`、`MANIFEST 2ea47547…b2a56f`、三个 fixture 哈希与 §6.1 表一致（实现者 03:45 的文档修正也未触碰这些冻结工件）。

---

## 1. 审计对象与证据基线

| 工件 | 路径 | 审计基线 |
|---|---|---|
| 数据核心 | `lib/derive.js`（1403 行） | 无 import、纯函数、`STATE_VERSION=2` |
| Host 接线 | `index.js`（258 行） | 投影/工具/健康路由 |
| 黄金测试 | `test/derive.test.mjs`（348 行） | 171 checks |
| 冻结数据 | `test/fixtures/*.jsonl` + `MANIFEST.json` | 2 个哈希链 |
| 黄金值 | `docs/golden-values.json` | `sha256 f0168d1e575a707214102c973222786d863d096a6b5ac3a07d9b8ddde33bcffa` |
| 原始快照（仓库外） | `~/tmp/e2e-work/snapshots/{slug}.jsonl` | 独立重算的唯一输入 |
| 隔离实例证据 | `docs/M1-LAB-VERIFICATION.md`、`docs/m1-*.json/png`、`tmp/e2e-work/verify-full*.log` | 依赖实现者证据（实例已删） |

审计使用的临时工件（**不在仓库内**）：`/tmp/m1-audit-recompute.py`（独立重算）、`/tmp/m1-audit-contract.mjs`（契约黑盒检查）、`/tmp/m1-audit-repo/`（handcalc 临时副本）、`/tmp/m1-audit-*.log`。

---

## 2. A. 测试全绿（PASS）

```bash
cd ~/dsh-task-map
node test/derive.test.mjs    # [derive-test] 171 checks passed, 0 failed / PASS
npm test                     # exit 0
node test/host-smoke.mjs     # [host-smoke] PASS（23 项 ✓）
node test/client-smoke.mjs   # [client-smoke] PASS（13 项 ✓）
```

| 套件 | 结果 | 断言数 |
|---|---|---|
| `node test/derive.test.mjs` | PASS | **171 passed / 0 failed**（审计方重跑复核一致） |
| `node test/host-smoke.mjs` | PASS | 23 |
| `node test/client-smoke.mjs` | PASS | 13（M0 占位 client，未回归） |
| `npm test` | exit 0 | 三套串行全绿 |

黄金测试覆盖核对（逐项读 `test/derive.test.mjs`，均在测试内真实断言，非注释）：

| 必查断言 | 位置 | 结论 |
|---|---|---|
| 3 会话黄金值 ±0ms（任务全字段 + turns/waits/usage/counters/taskStats/spans） | L167–202 | ✓ 深比较全部字段 |
| fixture sha256 链（MANIFEST + golden.source + 行数 + 体积 + 白名单） | L118–129 | ✓ |
| Object.is 门控（未知事件/无关事件同引用） | L216、L319–324 | ✓ |
| 未知/畸形事件（null、data=null、undefined state） | L322–324 | ✓ |
| 空状态不伪造 | L233–237 | ✓ |
| todo 降级（仅在无 team 板时） | L240–268 | ✓ |
| 未完成态（真实 p2p fixture 60s 前缀切片） | L270–283 | ✓ 真数据切片，非纯合成 |
| failed 态 | L285–294 | ✓ 合成事件（fixture 无真实失败样本） |
| 关系幂等 + 不改任务状态 | L296–308 | ✓ |
| 视图体积（<200KB 硬上限） | L210–211 | ✓ |
| 纯函数（view 不修改 state、重复折叠确定） | L218–224 | ✓ |

> `host-smoke` 23 项、`derive` 171 项与 `docs/进度日志.md` 记录一致；未发现「文档写的断言数 > 实际」的虚报。

---

## 3. B. 黄金值：可复现 + 独立重算（PASS）

### B1. handcalc 再生成 golden → 字节一致

为避免改动仓库 golden，把 `tools/handcalc.py` 与 fixture 复制到 `/tmp/m1-audit-repo` 后，用冻结快照重跑：

```bash
cp tools/handcalc.py /tmp/m1-audit-repo/tools/
cp test/fixtures/* /tmp/m1-audit-repo/test/fixtures/
cd /tmp/m1-audit-repo && python3 tools/handcalc.py \
  --snapshots ~/tmp/e2e-work/snapshots
# [exit 0] OK -> /private/tmp/m1-audit-repo/docs/golden-values.json
cmp /tmp/m1-audit-repo/docs/golden-values.json <repo>/docs/golden-values.json
# BYTE-IDENTICAL
```

| 文件 | 仓库 sha256 | 副本再生成 sha256 | 结论 |
|---|---|---|---|
| `docs/golden-values.json` | `f0168d1e…bcffa` | `f0168d1e…bcffa` | **字节一致** |

### B2. 审计方独立重算（关键）

方法：**审计方自写** Python 脚本 `/tmp/m1-audit-recompute.py`，只读原始快照 `snapshots/{baklib-feishu-sso,p2p-athena-port,athena-plan-board}.jsonl`，按产品方案 §6.2 口径从事件重算**全部**目标值，再与 `docs/golden-values.json` 逐字段对照。
**不 import `lib/derive.js`、不读 `tools/handcalc.py` 实现**（先独立实现，再对照）。

结果：**`sessions=3 diff_count=0`**。对照覆盖：任务数/顺序/status/createdAt/startedAt/completedAt/updatedAt/blockedBy/owner/ownerIsLead/startRank/doneRank/phases/queueMs/execMs/blockedWaitMs/readyAt/readyDelayMs、waits 全字段、handoffs、turns、usage、counters、spans、taskStats。

**表 1：会话级等待/耗时（审计重算 = golden，单位 ms）**

| 指标 | baklib-feishu-sso | p2p-athena-port | athena-plan-board |
|---|---|---|---|
| taskCount | 8 | 9 | 6 |
| turns | 1 | 6 | 2 |
| wallClockMs | 5,230,339 | 6,954,750 | 68,161 |
| preTurnMs | 2,867,304 | 247,968 | **−2,815,140** |
| humanIdleMs | 0 | 984,934 | 696,653 |
| queueMs | 2,354,635 | 334,297 | 1,121,170 |
| blockedMs | 1,351,134 | 0 | 0 |
| readyDelayMs | 36,699 | 0 | 0 |
| taskExecMs | 4,823,466 | 7,078,754 | 4,280,334 |
| waitAgentMs | 824,680 | 2,298,402 | 1,394,517 |
| askUserMs | 128,139 | 0 | 0 |
| approvalMs | 8,638 | 0 | 0 |
| maxHandoffMs | 456,218 | 655,508 | 23,563 |

**表 2：usage / counters / spans（审计重算 = golden）**

| 项 | baklib | p2p | athena |
|---|---|---|---|
| usage input/output/cacheRead/total | 211,337 / 135,313 / 23,146,624 / 23,493,274 | 165,425 / 295,714 / 49,146,496 / 49,607,635 | 191,564 / 120,812 / 19,708,416 / 20,020,792 |
| counters（toolCalls/jobs/approvals/subagents/todoWrites/teammates/waitAgents/askUsers） | 203/109/1/5/3/7/8/2 | 246/164/0/8/4/3/21/0 | 146/84/0/6/0/8/16/0 |
| spans（tool/job/approval/open/error/killed） | 203/109/1/0/3/0 | 246/164/0/0/1/2 | 146/84/0/0/3/0 |

**表 3：交接文档 §10.2 验收重点 `baklib/task-7`（审计重算）**

| 字段 | 审计值 | golden |
|---|---|---|
| status / owner / ownerIsLead | completed / qa-verifier / false | 同 |
| createdAt / startedAt / completedAt | 1793806924142 / 1793808311975 / 1793808620749 | 同 |
| blockedBy | task-1..task-6 | 同 |
| blockedWaitMs | **1,351,134（22.52min）** | 同 |
| readyAt / readyDelayMs | 1793808275276 / **36,699** | 同 |
| queueMs / execMs / startRank / doneRank | 1,387,833 / 308,774 / 8 / 8 | 同 |

补充独立核对：baklib 8 任务全部 completed，`ownerIsLead=true` 恰为 task-1、task-6（ownerId=会话 id），其余 6 名为成员精确映射；p2p 9 任务全部 completed、startRank/doneRank 连续 1..9；athena 6 任务 owner 全为继承成员名、`ownerIsLead` 全 false。**均与 golden 一致。**

### B3. DATA-NOTES 三项说法核对（PASS）

| DATA-NOTES 说法 | 审计核对（原始快照） | 结论 |
|---|---|---|
| p2p 实际 9 任务全完成、6 回合（非交接文档「5 任务 2 未完成」） | 去重 taskCount=9，9/9 completed；turn/start=6 个 | **与快照一致**，如实记录 |
| athena `preTurnMs=-2,815,140`、`isSeeded=true`、任务板属父会话 | header.isSeeded=true；首 turn/start 1793810366355 < createdAt 1793813181495；teamId 属父会话 | **与快照一致**，合法非 bug |
| 「未完成态」真实样本已不存在，由前缀切片/合成事件覆盖 | 测试用真实 p2p fixture 的 60s 前缀切片；审计独立复算该切片：`3 in_progress / 0 completed`；failed 与 relation 用合成事件 | **覆盖诚实**，未伪称真实样本 |

> 结论：测试没有掩盖「三会话全 completed」的事实；`docs/进度日志.md` 的「决策变更」记录与真实数据一致。

---

## 4. C. 投影契约与实现审查（PASS）

### 4.1 `lib/derive.js`（纯函数/无副作用）

| 检查项 | 证据 | 结论 |
|---|---|---|
| 无 import、无 fs/网络 | `grep -nE "^(import|const .*require\()" lib/derive.js` → 0 命中；全文件无 `fs.`/`fetch` | ✓ |
| 无关/未知事件返回**同一引用** | `derive.js:238–242`（`HANDLED_TYPES` 门控 + `default: return state`）；测试 L216/L319–324；审计方 26 项黑盒检查 | ✓ |
| `emptyState`/`buildClientView` 纯函数、不改输入 | 审计脚本：fold 后 state 规范串在 view 前后不变；重复 build 结果一致 | ✓ |
| 状态/视图 JSON 可序列化 | 审计脚本递归检查 state/view：仅 string/number/boolean/null/array/object | ✓ |
| `STATE_VERSION===2` | `derive.js:23`；host-smoke 断言 | ✓ |
| `description` 视图截断 | `LIMIT_DESCRIPTION_VIEW=500`（`derive.js:35,1095`）；审计检查 8 任务全部 ≤500 | ✓ |
| span 上限 | `MAX_SPANS=2000`（`:26`，`:728–737`）；审计注入 2100 个 tool/call → state.spans=2000、counters.toolCalls=2100 | ✓ |
| todo 降级仅在无 team 板时 | `foldTodoWrite` 在 `hasTeamBoard` 时只计数（`:631–638`）；team 板出现时清 todo 任务（`:539–551`）；审计黑盒验证 | ✓ |
| 关系「只记录、不改状态」 | `foldToolCall` 仅追加 relations（`:786–796`），幂等去重（`:822–830`）；审计验证重复调用只 1 条、任务 status 不变 | ✓ |

### 4.2 `index.js`（Host 接线）

| 检查项 | 证据 | 结论 |
|---|---|---|
| `stateVersion=STATE_VERSION` | `index.js:49` | ✓ |
| `init=emptyState(header)`、`apply=foldEvent`、`wire.view=buildClientView` | `index.js:52–67` | ✓ |
| apply 异常不冒泡 | `index.js:54–62` try/catch 返回上一稳定 state | ✓ |
| 不写会话日志/不改任务状态 | `grep -nE "team_task_\|writeFile\|appendFile\|createWriteStream\|session/event" lib/derive.js index.js client.js` → **0 命中**；工具 `execute` 仅 return 值 | ✓ |
| health 路由不返回敏感内容 | `index.js:221–233` 仅 ok/plugin/version/mode/projection/errors/stateVersion/tools/route，无任务描述/凭据 | ✓ |
| 注册均包在 effect 内可清理 | `index.js:72–79,188,238–245` | ✓ |

### 4.3 打包

`package.json` 的 `files` = `["index.js","client.js","lib/","cordis.patch.yml","locale/*.json"]` → **含 `lib/`**，打包不会缺文件。`engines.dsh` 与交接一致。

### 4.4 审计方独立契约脚本结果

`/tmp/m1-audit-contract.mjs`：**26 passed / 0 failed**（STATE_VERSION、JSON 可序列化、未知/畸形事件同引用、view 不改 state、截断、span 上限、todo 门控、关系幂等/不改状态、空会话不伪造、8 任务 view 48,804B <200KB）。

**非阻断观察（供 M2）**：`preTurnRestored` 仅由 `preTurnMs < 0` 推导（`derive.js:1334`），state 未保存 `header.isSeeded`；对这三个会话恰好与恢复语义一致，但 M2 展示「会话从历史恢复」文案前建议显式核对，或把 `isSeeded` 纳入 state（需升 stateVersion）。

---

## 5. D. 数据与仓库卫生（PASS，附问题清单）

### 5.1 fixture 体积/行数/类型

| fixture | 字节 | 行数（keptEventCount） | 事件类型数 | 体积上限 |
|---|---|---|---|---|
| baklib-feishu-sso.jsonl | 191,406 | 984 | 19 | <1MB ✓ |
| p2p-athena-port.jsonl | 257,899 | 1,449 | 17 | <1MB ✓ |
| athena-plan-board.jsonl | 149,095 | 813 | 18 | <1MB ✓ |

- 三文件事件类型**全部**在 DATA-NOTES §4.1 白名单内（并集 22 类；`subagent/descriptor` 白名单允许但本 3 会话未出现，属正常）。
- **无 `/Users/` 绝对路径**（3 文件均 0 处，`grep -c`）；**无 `xiaohui` 用户名**（0 处）。

### 5.2 凭据扫描（人工判断）

| 模式 | 命中 | 判定 |
|---|---|---|
| `token` | 1,965 | 全部为 `inputTokens/outputTokens/cacheReadTokens` 字段名，或任务描述中的「token 校验」等业务语义名；无 token 值 |
| `sk-` | 90 | 全部是 `task-N` 的子串（`ta`**`sk-`**`4`），误报 |
| `secret` | 6 | 全部为任务描述里的字段名 `app_secret`（OAuth2 模型字段清单），无值 |
| `api_key` / `Bearer` / `password` / `Authorization` / `PRIVATE KEY` | 0 | 无 |
| 高熵长串（≥28 字符） | — | 仅工具调用 id（`call_00_…`）、session id、文件路径；无密钥形态 |
| 内网地址 | 9 处 IP | **已知风险**：p2p 任务/交付物描述含内网地址，DATA-NOTES §4.4 已记录「仅本地测试 fixture，不随插件公开分发」 |

### 5.3 哈希链（独立重算，非抽验）

审计方直接对快照目录与仓库文件重算 sha256：

| 链路 | baklib | p2p | athena |
|---|---|---|---|
| `sourceZstdSha256`（快照 zstd） | OK | OK | OK |
| `snapshotJsonlSha256`（解压快照） | OK | OK | OK |
| `golden.source.snapshotSha256` | OK | OK | OK |
| `fixtureSha256`（MANIFEST） | OK | OK | OK |
| `golden.source.fixtureSha256` | OK | OK | OK |

结论：**快照 zstd → 解压 jsonl → 裁剪 fixture → golden 全链一致**（zstd 前缀：baklib `12bd2c06…`，p2p `9ae43a40…`，athena `5bdea94b…`）。

### 5.4 隔离实例证据与环境清理

| 检查 | 结果 |
|---|---|
| `docs/M1-LAB-VERIFICATION.md`、`m1-lab-verification.json`、`m1-live-verification.json` | 存在，内部数字与 golden 一致（tasks 8/9/6；queue/exec/waitAgent 与 §3 表 1 相同；asOfSeq 1156/1781/1006 = fixture 末 seq +1，与「打开历史会话追加 `session/end-seed`」解释自洽） |
| `docs/m1-real-*.png`（5 张） | 存在；审计员实际打开 baklib/p2p/athena/live/empty 五张：sessionId 正确、「任务地图」页签存在、「已读到投影值」；**但 M0 占位 UI 的 projection 黑底 `<pre>` 不可读 → 截图只能证明页签/投影可读，不能目视证明任务数值**（任务数值证据依赖 `m1-lab-verification.json` + 验证日志，标注「依赖实现者证据」） |
| `tmp/e2e-work/verify-lab.cjs` | 存在；比对脚本逐任务全字段 + waits（除 wallClock）+ usage/turns/counters/taskStats/changes.added，比较口径足够强 |
| `.dsh-lab` | **不存在**（已清理 ✓） |
| `~/.dsh/profiles/{desktop,web}/package.json` | 无 `@local/dsh-task-map` 引用（grep 0）✓ |
| 残留进程/端口 | 无 `dsh web` 进程；8088 无监听 ✓ |

### 5.5 文档 vs 事实（实现者记录核对）

| 文档声明 | 实际 | 结论 |
|---|---|---|
| `derive.test.mjs` 171 checks | 171 passed / 0 failed | ✓ |
| `host-smoke` 23 项 | 23 ✓ | ✓ |
| fixture 984/1449/813 行、187/252/146KB | 一致 | ✓ |
| 视图体积（本地口径）8/9/6 任务 48.6/58.1/37.2KB | 审计实算 49,804 / 59,492 / 38,136 B = 48.6/58.1/37.2KB | ✓ |
| W1.3 记录「9 任务 58.1KB」 | 58.1KB | ✓ |
| 进度日志「压测发现：200 任务 view 387KB > 200KB 硬上限，apply 0.002ms/事件、view 2.4ms」 | 审计方独立合成 200 任务/4602 事件/2000 span：fold 0.0021ms/事件、view 2.31ms、`wire.view` **369.1KB > 200KB** | ✓ 结论一致（数值因合成参数略异） |
| 隔离实例「91 项断言通过，0 项失败」 | 初版审计时不符：最后验证日志 **91 passed / 1 failed**；实现者已修正为「91 项断言通过，1 项失败」并补失败项说明 | **初版 FAIL（D-1）→ 已修正闭环（§5.8）** |

### 5.6 问题清单（含定级）

| ID | 定级 | 问题 | 证据/复现 |
|---|---|---|---|
| **D-1** | ~~FAIL~~ **已修正闭环**（初版为文档准确性 FAIL，非代码缺陷） | 初版：`M1-LAB-VERIFICATION.md` §2 写「**91 项断言通过，0 项失败**」、§4 表「空任务状态不伪造 ✅」；实际最后一次隔离验证 `verify-full8.log` 为「**91 checks passed, 1 failed**」，失败项 =「空会话: 任务地图视图已渲染」，报告未记录该项失败。**修正后**：§2 改为「91 项断言通过，1 项失败」并说明失败原因（新建草稿会话停在 hero 页、官方不挂载 `conversation.view`）；§3 增加数据层空态证据与「未覆盖草稿会话 UI、留 M2/W2.6」说明；§4 同步。审计方复核通过（§5.8）。附注：旁证 `docs/m1-real-empty-state.png` 显示新建会话停 hero 页、无「任务地图」页签，与「UI 层预期行为」解释一致；该失败**不影响数据核心**（同次运行中「空会话不伪造任务」断言因 projection=null 空泛通过，真正空态证据在 `m1-live-verification.json` 的 tasks=[]/dataSource=none 与 derive 测试） | 初版复现：`tail -3 tmp/e2e-work/verify-full8.log` → `91 checks passed, 1 failed` / ` - 空会话: 任务地图视图已渲染`。修正复核：`sed -n '52,54p;87,92p;104,113p' docs/M1-LAB-VERIFICATION.md`；原始日志未改动，仍为 91/1 |
| D-2 | ~~非阻断~~ **已修正闭环**（初版为文档来源混用） | §4 表视图体积原写「8/9/6 任务约 48.6/58.1/37.2KB」用的是**本地 fixture 口径**；实例实测为 52,175 / 62,769 / 40,711 B（≈51.0/61.3/39.8KB，见 `m1-lab-verification.json`）。已修正为「**实例实测** 51.0/61.3/39.8KB；本地 fixture 口径 48.6/58.1/37.2KB，均 <200KB」（第 111 行） | `sed -n '111p' docs/M1-LAB-VERIFICATION.md`；`python3 -c "import json;print(json.load(open('docs/m1-lab-verification.json'))['sessions'])"` |
| D-3 | 非阻断（隐私面） | `test/fixtures/MANIFEST.json` 的 `sourceProject`/`sourcePath` 含本地用户名 `xiaohui`（7 处）；fixture 正文内为 0 处。非凭据，但属个人标识，发布前建议脱敏或注明 | `grep -c xiaohui test/fixtures/MANIFEST.json` → 7 |
| D-4 | 非阻断（证据强度） | 隔离实例已删除 → 冷读/实时证据**不可独立复现**；截图仅证明页签/投影可读，不能目视任务数值。本审计按「依赖实现者证据」处理，但其结构化数字与审计方独立 golden 重算一致 | 见 §5.4 |
| D-5 | 非阻断（表述） | DATA-NOTES §1 写「`MANIFEST.json` 的 `parsedAt`」，实际 `parsedAt` 位于 `sessions[]` 条目内（顶层无该字段），表述略有歧义 | `python3 -c "import json;print(list(json.load(open('test/fixtures/MANIFEST.json')).keys()))"` |

### 5.7 未复跑项（遵守禁止项）

- **未运行 `node tools/make-fixtures.mjs`**（会按当前真实会话重新冻结并覆盖 fixture/golden，不可逆；审计约束禁止）。因此 DATA-NOTES §5「重复运行 fixture sha256 稳定」仍**依赖实现者证据**，本审计未推翻也未独立验证。
- 未执行 `dsh plugin`/`dsh web`/`git init`/装包/联网；隔离实例无法重建，故实例侧只做「已有证据一致性 + 环境残留检查」。

### 5.8 实现者文档修正的复核（v1.1）

初版审计的 FAIL 已由实现者修正。审计方**不采信说明、直接复核文件**（`docs/M1-LAB-VERIFICATION.md`，mtime 03:45，初版 03:39）：

| 修正点 | 复核结果 |
|---|---|
| §2 断言计数 | 已改为「**结果：91 项断言通过，1 项失败**」，并写明失败项与原因（第 52–54 行） |
| §3 空态证据 | 已补「数据层空态证据 = `m1-live-verification.json` + derive 测试」「草稿会话 UI 渲染未覆盖，留 M2/W2.6，如实记为 1 项失败，不计入数据核心 Gate」（第 88–91 行） |
| §4 结论表 | 已同步「该轮 91 passed / 1 failed」（第 107 行） |
| §4 视图体积 | 已区分来源：「实例实测 51.0/61.3/39.8KB；本地 fixture 口径 48.6/58.1/37.2KB」（第 111 行），与审计实测 52,175/62,769/40,711B 及 49,804/59,492/38,136B 一致 |

- **冻结工件未被修正波及**：`docs/golden-values.json`、`test/fixtures/MANIFEST.json`、3 个 fixture 的 sha256 与审计开始时完全一致；`lib/derive.js`、`index.js`、`test/*.mjs` 的 mtime 仍为 03:22–03:25（未改代码/测试）。
- **结论：D-1、D-2 关闭。** 唯一残留小笔误：§2 写「见 §3.1」，实际说明在 §3（不是独立小节编号），不影响结论，可随手改。

---

## 6. E. M1 Gate 判定（对照交接文件 §8 与产品方案 §8）

| # | 出口标准 | 审计结论 | 依据 |
|---|---|---|---|
| 1 | 3 个真实会话任务数/状态/开始完成/耗时/等待/负责人/依赖与手算一致（±0ms） | **PASS** | §3 B2：审计方从原始快照独立重算，**0 diff**；黄金测试 171/0 |
| 2 | 未知事件不破坏状态（Object.is 门控） | **PASS** | §2/§4：测试 + 审计方 26 项黑盒检查（未知/畸形/无关事件均返回同一引用、水位不推进） |
| 3 | 投影值含真实任务（隔离实例冷读） | **PASS（依赖实现者证据）** | `verify-full8.log` 记录实例 tasks=8/9/6、asOfSeq=1156/1781/1006，91 项与 golden 比对通过；`m1-lab-verification.json` 数字与审计 golden 一致；实例已删，无法复跑。截图仅证明页签/投影可读 |
| 4 | 不回归 M0 smoke；不改用户环境 | **PASS** | host-smoke 23 / client-smoke 13 全绿；`.dsh-lab` 不存在；`~/.dsh/profiles/{desktop,web}` 无插件引用、无残留进程 |

**判定：PASS。** 数据核心 Gate 判据经独立重算全部满足；初版唯一 FAIL（D-1 文档断言计数）已由实现者修正并经审计方复核闭环（§5.8）；D-2 一并关闭。残余风险见 §7，均不阻断 M1。

---

## 7. 残余风险与 M2/M5 跟进建议

| 优先级 | 风险 | 影响 | 建议跟进 |
|---|---|---|---|
| P0 | `/task-map/api/health` 无鉴权/无同源校验（插件路由不过 DSH 鉴权） | 安全，发布阻断 | M5/W5.1：`Origin`/`Sec-Fetch-Site` 校验 + 403 + 移除调试字段（交接 §5.3 已列） |
| P1 | 实时任务事件未端到端：隔离 web profile 未挂 Agent Teams，`toolCalls=0`，无法自然产生 `team_task_*`/`todo_write` 事件 | 实时折叠路径只有 host-smoke apply 序列覆盖 | M2/W5.3：在装 Agent Teams 的真实 profile 补「对话建任务 → 面板实时出现」E2E |
| P1 | `wire.view` 8 任务 48.6KB，高于方案 §10.4「8 任务 <30KB」估算 | 体积/性能指标未达标（但 <200KB 硬上限） | M2 虚拟化 + 详情走 HTTP；M5 用 19 任务长会话压测；已作为决策变更记录 |
| P1 | **200 任务合成压测 `wire.view` 369KB（实现者记录 387KB）> 200KB 硬上限**；apply 0.0021ms/事件、view 2.31ms 达标 | 长会话投影超限（当前 3 个真实会话 6~9 任务不触发） | M2/M5：按方案 §7.3 实现截断 guard（只留最近 N 条 span + 按任务聚合摘要 + 详情走 HTTP），并补 200 任务回归。审计方已独立复算确认 |
| P1 | `MAX_SPANS=2000` 丢弃最旧 span，而 `waitAgent/askUser/approval` 等待由 spans 汇总（`derive.js:1354–1360`） | 超长会话（>2000 span）这些等待指标会少算；当前最大 410 未触发 | M2/M5：等待指标改为独立累加器（state 内 counters 化），spans 只用于渲染 |
| P2 | fixture 冻结于 2026-11-05 03:22，p2p 会话历史上仍在增长 | 重跑 `make-fixtures` 会改变 golden | CI 只读仓库内 fixture；禁止在 CI/日常测试重跑 make-fixtures |
| P2 | 无 git 仓库，无版本管理/回滚 | 变更不可追溯 | 待用户确认后 `git init` + 首次提交（交接 §10 待确认项） |
| P2 | M0 client 仍占位（`data-task-map-plugin=m0`）；空会话 hero 页无「任务地图」页签（D-1 失败项根因） | M1 不做 UI，但空状态组件验收未闭环 | M2/W2.6 + W5.3：用「有事件但无任务板」会话验收空状态；D-1 报告已修正（§5.8） |
| P2 | fixture/MANIFEST 隐私面：真实任务描述/项目名、内网地址、本地用户名 | 仅本地测试可接受 | 发布前（W5.5/W7.5）脱敏复审；公开制品不放 fixture |
| P3 | `preTurnRestored` 仅按 `preTurnMs<0` 推导，未用 `isSeeded` 语义 | 极端情况下文案可能误标「会话从历史恢复」 | M2 展示前核对；如需精确，把 isSeeded 纳入 state（升 stateVersion） |
| P3 | 黄金值只覆盖真实 completed 态；in_progress/failed 靠切片与合成事件 | 未完成态无真实端到端样本 | 可选：另挑一个真实未完成会话补 fixture（需 Lead 决定，不扩大 M1） |

> 实现者已确认接受上述风险，不要求在 M1 修复；其中「span 上限 2000 → 超长会话 waitAgent/askUser/approval 等待少算」将作为 **M2 独立累加器修复项**（不改 M1 冻结数据），「200 任务 wire.view 超 200KB」将作为 **M2 截断 guard + 200 任务回归项**。P2「M0 client 占位/草稿会话 hero 页」的空状态验收顺延至 **M2/W2.6**，与本审计 §5.8 的 D-1 修正说明一致。

---

## 8. 复现命令附录

```bash
cd ~/dsh-task-map

# A. 测试
npm test
node test/derive.test.mjs

# B1. golden 可复现（副本运行，避免覆盖仓库 golden）
cp tools/handcalc.py /tmp/m1-audit-repo/tools/
cp test/fixtures/* /tmp/m1-audit-repo/test/fixtures/
cd /tmp/m1-audit-repo && python3 tools/handcalc.py \
  --snapshots ~/tmp/e2e-work/snapshots
cmp /tmp/m1-audit-repo/docs/golden-values.json ~/dsh-task-map/docs/golden-values.json

# B2. 独立重算（审计脚本，只读原始快照；不在仓库内）
python3 /tmp/m1-audit-recompute.py     # → sessions=3 diff_count=0

# C. 契约黑盒检查（审计脚本）
node /tmp/m1-audit-contract.mjs        # → 26 passed, 0 failed

# D. 哈希链 / 卫生
shasum -a 256 docs/golden-values.json test/fixtures/MANIFEST.json test/fixtures/*.jsonl
grep -c '/Users/' test/fixtures/*.jsonl   # 0
grep -c 'xiaohui' test/fixtures/*.jsonl   # 0
ls -d ~/.dsh-lab 2>&1   # No such file
grep -c 'dsh-task-map' ~/.dsh/profiles/desktop/package.json ~/.dsh/profiles/web/package.json   # 0 / 0

# D-1. 初版 FAIL 的复现与修正复核
tail -3 ~/tmp/e2e-work/verify-full8.log   # 91 passed, 1 failed（原始日志，未改动）
grep -n '91 项断言通过，1 项失败' docs/M1-LAB-VERIFICATION.md                     # 修正后第 52 行
sed -n '111p' docs/M1-LAB-VERIFICATION.md                                        # 视图体积已区分实例/本地口径
shasum -a 256 docs/golden-values.json test/fixtures/*.jsonl                      # 与审计开始时一致（修正未波及冻结工件）
```

> 审计方结论仅代表 2026-11-05 时点的只读审计结果；隔离实例证据为「依赖实现者证据」。本文件是审计员对仓库的**唯一写入**。
