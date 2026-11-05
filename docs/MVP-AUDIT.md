# MVP 独立验收审计报告（Gate MVP · v1.0.0）

> 日期：2026-11-05 ｜ 审计人：**m3-verifier**（续任 M1~MVP 独立验收审计；不参与任何实现）
> 审计基线：`dsh-task-map` git HEAD = **`37427a6`**（`fix(mvp): …`；工作区除本审计交付物 `docs/MVP-AUDIT.md` 未跟踪外干净；相对上一基线 `2dc003a` 仅 `test/host-smoke.mjs` + `docs/进度日志.md`）
> 审计方式：只读；**全部可重算项独立重算**（自写一次性脚本，位于 `/tmp`，不写入仓库），不采信实现者注释/文档结论；已删除的隔离实例 E2E 标注「依赖实现者证据」并做 JSON ↔ run 日志 ↔ 截图 ↔ 报告 ↔ 独立折叠交叉；实际安装状态在**运行中实例 127.0.0.1:55021** 做只读实测。

---

## 0. 结论

**PASS（Gate MVP 通过，v1.0.0 可交付）**。产品方案 §8 的 M5 出口（干净环境可安装、全部测试绿、M5 验收清单）与 §10.3「MVP 手工验收」在功能/安全/安装主链路上全部满足；**0 项阻断 FAIL**。审计首轮发现的 10 项收口问题（P2×4 + P3×6）已全部在 `2dc003a`/`37427a6` 修正并经审计方复核闭环。

- **A 测试与不回归（PASS，1,126/1,126）**：`npm test` exit 0；derive **290** / host-smoke **35** / client-smoke **529** / client-logic **272**（合计 **1,126 断言，0 失败**），与 README/MVP-ACCEPTANCE/进度日志一致；M1~M4 的黄金值/回放/变更/关系断言无删减弱化；`STATE_VERSION=3`、版本 `1.0.0` 全链路一致。
- **B W5.1 安全（PASS，72/72 + 实机）**：自写请求直调 handler：`Sec-Fetch-Site: same-origin`→200、`Origin`+`Host` 精确匹配（http/https）→200；裸请求/仅 Host/cross-site/same-site/none/Origin 不匹配/同主机异端口/协议非法/缺 Host → 全部 **403** 且固定通用错误体；200 响应字段恰为 `{ok,plugin,version,projection,stateVersion,tools,route}`，**无 projectionError/toolErrors/routeError/mode/startedAt/token/路径/会话内容**；无 CORS 放行。**实机 55021**：裸 curl→403；`Sec-Fetch-Site: same-origin`+Host→**200**（version 1.0.0 / stateVersion 3 / 2 tools / projection true）；跨源 Origin→403；`task_map_ping` 工具经宿主真实调用返回「Task Map 1.0.0: projection=true」。
- **C W5.2 安装/卸载（PASS，隔离演练 16/16）**：`scripts/install.sh`/`uninstall.sh` 逻辑审查 + **审计方在隔离 `DSH_HOME=/tmp/…` 独立演练**：install → `+ @local/dsh-task-map 1.0.0`（bundles 追加、dependencies link、node_modules 链接有效）→ uninstall → **bundles/dependencies/pnpm-lock/node_modules 链接全部清理**（含审计发现的 node_modules 残留修复）、脚本幂等、临时 home 删除后无残留；演练前后 `~/.dsh/profiles/desktop/package.json` hash/ mtime 未变。desktop 实机安装：bundles 含插件、dependencies link 本仓库、node_modules 链接有效、版本 1.0.0；官方安装证据 `~/.dsh/profiles/desktop/.plugin-manager/logs/operation-fWdb89/pnpm.log`（10:27，`+ @local/dsh-task-map 1.0.0`）。
- **D W5.3 E2E 脚本（PASS）**：`tools/e2e/task-map-e2e.mjs` 静态审查 18 项通过：参数校验（缺参 exit 2）、token 输出脱敏、失败 exit 1、PLAYWRIGHT_CORE/CHROME_PATH 可配、**17 条 `ok()` 断言与 `docs/m5-e2e-result.json` 的 17 checks/0 failed 完全对应**；结果 JSON 与 `tmp/.../m5-e2e-out/result.json` **完全相同**、`docs/m5-mvp-e2e.png` 与 tmp `overview.png` **sha256 相同**；`docs/M5-E2E.md` 的使用/限制说明（实时链路、token、end-seed）属实。**限制**：运行中 55021 的 token 不可得（会话由用户浏览器持有），未能对实机独立复跑 → 标注「依赖实现者证据 + 数值交叉」。
- **E W5.4/W5.5 验收与收口（PASS，114/114）**：US-1~US-7 逐条证据引用存在且属实（US-8/US-9 已按 P1/P2 标注未实现）；3 会话数据与 Python 手算 golden 一致（baklib queue 39.24min/exec 80.39min/blocked 22.52min/waitAgent 13.74min/墙钟 1:27:10；p2p 6 回合/115.9min/38.3min；athena preTurn -46.92min、回放时长 48:03、wallClockMs 68,161ms）；CHANGELOG 1.0.0 覆盖 M1~M5（Added/Changed/Fixed/Security/Known limitations）；README 安装/使用/安全/限制/版本准确（首轮 4 处陈旧数字已修）；隐私复审已记录（`private:true`、`files` 白名单不含 docs/test、fixtures/截图内部信息发布前脱敏）；全仓文档数字复核无残留不实。
- **F P3 收尾核销（PASS，44/44）**：①甘特高亮代码已修（updater signature 含 `highlighted`、render/updater class 合并 selected+highlighted、无重复 className 键）——静态核验通过；测试中「jsdom harness」不实标签已改为「开发期临时 harness、不随仓库」；②无效关系口径已改并独立验证（`changes.splits`/`log`/`counts.splits` 只含有效关系，无效关系进 `changes.invalidRelations`+warnings，relations 保留可审计；`invalidRelations` 的 asOfTime 过滤已与 validSplits 一致）；客户端 `invalidRelationsOf`/`data-tm-invalid-relations`/「不计入拆分变更」文案正确；③host-smoke「任务板未被改动」已真正守护（快照移到首个 `rel.execute` 之前、全部调用后对比，单条断言合并保持 35 项）。
- **G 环境与仓库卫生（PASS，12/12）**：HEAD 正确、`git status` 仅待提交的审计文档；`.dsh-lab*` 不存在；仓库无凭据/lab token/构建产物；85 个跟踪文件；`.gitignore` 覆盖 node_modules/.dsh-lab/tmp/*.log；版本一致；**唯一 `~/.dsh` 变更 = 用户要求的 desktop profile 官方安装（plugin_manager 流程，记录在案，不算违规）**。

**计数**：A 1,126 + B 72 + C 16 + D 18 + E 114 + F 44 + G 12 = **1,402 项检查通过 / 0 项阻断失败**；另有实机/安装状态人工核对 9 项（见 §3/§8）。审计发现的 10 项问题全部闭环（§9.1）。

---

## 1. 审计对象与证据基线

| 项 | 值 |
|---|---|
| 仓库/HEAD | `~/dsh-task-map` ｜ `37427a6db2a4034c9180212d2a09654b9d474876` |
| 工作区 | `git status --short`：仅 `?? docs/MVP-AUDIT.md`（本审计交付物，待 Lead 收口提交） |
| MVP 提交 | `8143f56` M5 交付主体（安全/脚本/E2E/验收/1.0.0）→ `85a7c67` 最终隔离实例 E2E 证据（17/17、health 403/200）→ `2795e59` W5 记录+实机安装证据 → `2dc003a`/`37427a6` 审计收口修正（README 数字、uninstall node_modules 清理、甘特措辞、执行清单、as-of、host-smoke 快照位置） |
| 版本/契约 | `package.json` **1.0.0**（`private:true`）；host `VERSION='1.0.0'`；client `CLIENT_VERSION='1.0.0'`；**`STATE_VERSION=3`**；运行中 health 实测 `version=1.0.0, stateVersion=3` |
| 安装状态 | `~/.dsh/profiles/desktop`：bundles 含 `@local/dsh-task-map`、dependencies=link 本仓库、`node_modules/@local/dsh-task-map` 链接有效（版本 1.0.0）；官方流程日志见 §3；运行中实例 127.0.0.1:55021 已热加载 host（health + Agent 工具实测） |
| 冻结证据 | M1~M4 审计报告与 E2E 证据自各自基线未改（`git diff 543b69f..HEAD -- docs/m1-* docs/M1-* docs/m2-* docs/M2-* docs/m3-* docs/M3-* docs/m4-*.png docs/m4-e2e-verification.json docs/M4-E2E-VERIFICATION.md` 为空）；M5 证据 `docs/m5-e2e-result.json`/`docs/m5-mvp-e2e.png` 与 tmp 原始产物一致 |
| 审计限制 | 未重装/卸载 desktop 插件；未运行 `dsh web` 新实例；未联网/未 npm install；未跑 `make-fixtures`；E2E 脚本因 token 不可得未对 55021 实跑；`npm pack --dry-run` 因本机 npm cache 权限（EPERM，环境问题）未执行（files 白名单改为静态核对） |

---

## 2. A. 测试全绿 + M1~M4 不回归 + 版本/契约（PASS，1,126/1,126）

```bash
cd ~/dsh-task-map
npm test exit 0
node test/derive.test.mjs        # [derive-test] 290 checks passed, 0 failed → PASS
node test/host-smoke.mjs         # 35 项 ✓ → PASS
node test/client-smoke.mjs       # [client-smoke] PASS (529 checks)
node test/client-logic.test.mjs  # [client-logic] PASS (272 checks)
```

- **断言数**：290 + 35 + 529 + 272 = **1,126，0 失败**；与 README（测试节/命令节）、`docs/MVP-ACCEPTANCE.md` §4、`docs/进度日志.md` W5.1 完全一致（首轮 host 35/36 不一致已在 `37427a6` 合并回 35 并复核）。
- **M5 增量**：derive +4（286→290：无效关系口径断言更新/新增）、host +4（31→35：health 同源 5 项替换旧 2 项 + 任务板快照）、client-smoke +16（513→529：含 client-logic 同步 +12、组件 +4）、client-logic +12（260→272：无效关系单列/版本/口径）。
- **M1~M4 不回归的结构性证据**：`git diff 543b69f..HEAD -- test/` 中**无被删弱的黄金/回放/变更/关系断言**——仅版本标记（0.4.0-m4→1.0.0）、health 断言（→更强同源矩阵）、M4 无效关系断言（→更严格的新口径）被替换；`derive.test.mjs` 3 会话黄金值断言、M3 [5] 段、M4 [6] 段保留并通过；client-logic 的 M2（布局/状态/二分/回放 store/容错）、M3（变更流 as-of/未来不剧透）+ M4（关系层）断言保留；client-smoke 的 M3 变更流/Ghost/NEW/无障碍/性能 + M4 关系层断言保留。
- **3 会话黄金值**（derive 实测输出）：baklib 8 tasks / 313 spans / 49.1KB / queue 39.2min / exec 80.4min / waitAgent 13.7min；p2p 9 / 410 / 59.6KB / waitAgent 38.3min；athena 6 / 230 / 37.9KB / waitAgent 23.2min；200 任务压测 view 172.0KB < 200KB、fold 0.0027ms/事件。
- **契约**：`STATE_VERSION=3` 全链路（state/view/投影注册/client `data-tm-state-version=3`/health）；旧 v2 状态降级构建不崩（M4 审计已验证，逻辑未变）；host `stateVersion` 与 client 契约同步。

---

## 3. B. W5.1 安全：health 同源校验 + 响应精简（PASS，72/72 + 实机）

> 方法：`/tmp/mvp-audit-security.mjs` 用 stub ctx 加载真实 `index.js` 的 `apply`，捕获唯一路由后**直接以各种 headers 调用 handler**（不经过网关），并做源码级审查。

| 场景（headers） | 结果 |
|---|---|
| `sec-fetch-site: same-origin` | **200**（content-type JSON；`cache-control: no-store`） |
| `sec-fetch-site: SAME-ORIGIN`（大小写） | 200（handler 小写归一） |
| `origin=http://H` + `host=H` / `origin=https://H` + `host=H` | 200 |
| 裸请求 `{}` / 仅 Host / `sec-fetch-site: cross-site` / `same-site` / `none` / Origin 不匹配 / 同主机异端口 / Origin 带尾斜杠 / Origin 缺 Host / `ftp://` 协议 | **全部 403**，响应体恒为 `{"ok":false,"error":"forbidden（仅同源可访问）"}`（无内部信息） |
| 403 响应不泄漏 | 与固定结构逐字节一致（无 error 堆栈/路径/会话/环境信息） |
| 200 响应字段 | 恰为 `{ok,plugin,version,projection,stateVersion,tools,route}`；**无** `projectionError/toolErrors/routeError/mode/startedAt/sessionId/tasks/token/cwd/hostname/username/stack` |
| 值 | `version=1.0.0`、`stateVersion=3`、`tools=['task_map_ping','task_map_record_relation']`、`projection/route` 布尔 |
| 源码级 | 无 CORS 通配/CORS 中间件；不读取 token 查询参数；路由不打印请求头/Origin；`ping` 工具输出不含本地路径/会话内容；投影注册 `stateVersion=3` |
| 实机 55021（运行中 desktop 实例） | 裸 curl → **403**；`-H 'Sec-Fetch-Site: same-origin' -H 'Host: 127.0.0.1:55021'` → **200**（version 1.0.0 / stateVersion 3 / tools 2 / projection true / route true）；`-H 'Origin: http://evil.example'` → 403；匹配 `Origin`+`Host` → 200 |
| 工具只读 | 关系工具校验/拒绝路径无写 API（M4 审计 59 项 + 源码扫描，本次未变；宿主工具 `task_map_ping` 实测返回 `projection=true`） |

> 威胁模型说明：浏览器侧无法伪造 `Sec-Fetch-Site`（forbidden header），跨站请求被拒；本机任意进程可伪造任意 header，属本地信任边界之外（README 已说明「无头 curl 等 403」的定位）。响应仍暴露 `projection/route/tools` 等**非敏感运行状态**（README 明示「只返回非敏感运行状态」），不构成数据泄漏。

---

## 4. C. W5.2 安装/卸载脚本 + 隔离演练 + 实机安装（PASS，16/16）

**脚本审查**：`install.sh` 校验 `dsh`/`node`/`package.json`，`dsh plugin --profile ${PROFILE:-desktop} add link:<repo>`，`DSH_HOME` 可覆盖；`uninstall.sh` 执行 `dsh plugin remove` + **清理 profile bundles 残留** + **清理 `node_modules/@local/dsh-task-map` 链接与空 `@local` 目录**，全程 set -euo pipefail。

**审计方独立隔离演练**（`DSH_HOME=/tmp/mvp-audit-dsh2`，未触碰 `~/.dsh`）：

| 步骤/检查 | 结果 |
|---|---|
| install.sh（PROFILE=web） | exit 0；`+ @local/dsh-task-map 1.0.0 <- ../../…/dsh-task-map`；bundles 追加插件；dependencies=link；`node_modules/@local/dsh-task-map` 链接存在 |
| uninstall.sh | exit 0；bundles 恢复为 2 个基础 bundle；dependencies=None；pnpm-lock 无插件引用；**node_modules 链接已删除、`@local` 空目录已删除** |
| 幂等 | 重复 install / uninstall 均 exit 0 |
| 临时 home 清理 | `rm -rf` 后不存在 |
| `~/.dsh` 隔离性 | 演练前后 `~/.dsh/profiles/desktop/package.json` hash 与 mtime **完全一致**；仓库/工作区无 `.dsh-lab*` |

> 首轮审计发现「uninstall 后 `node_modules/@local/dsh-task-map` 符号链接残留」→ `uninstall.sh` 已在 `2dc003a` 补清理逻辑；审计方在含修复的基线 `2dc003a` 重新演练复核通过（`37427a6` 只改 host-smoke/进度日志，该脚本未再变动；`docs/W5-INSTALL-DRILL.md` §2.1 已补记录）。

**实机安装状态（用户要求的最终安装，记录不违规）**：

- `~/.dsh/profiles/desktop/package.json`：bundles 末尾含 `@local/dsh-task-map`；dependencies=`link:~/dsh-task-map`；`node_modules/@local/dsh-task-map` 链接有效且版本 **1.0.0**。
- 官方流程证据：`~/.dsh/profiles/desktop/.plugin-manager/logs/operation-fWdb89/pnpm.log`（10:27）`+ @local/dsh-task-map 1.0.0 <- ../../../hermes-workspaces/dsh-task-map`，LOCKFILE 通过 supply-chain 校验。
- 运行中 55021：health 同源 200/裸 403、`stateVersion=3`；本会话 Agent 工具 `task_map_ping` 实测返回「Task Map 1.0.0: projection=true」→ host 已热加载；客户端页签需刷新页面加载新 bundle（README/MVP 报告已注明）。

---

## 5. D. W5.3 可复跑 E2E 脚本（PASS，18/18；实跑依赖 token）

- **脚本可用性（静态 + 运行）**：`tools/e2e/task-map-e2e.mjs`：缺参时打印 usage 并 **exit 2**（实测）；失败 exit 1；URL/token 脱敏（`token=***`）；`PLAYWRIGHT_CORE`/`CHROME_PATH` 可配置，本机 playwright-core 与系统 Chrome 路径均存在；默认输出 `tmp/e2e-out`（仓库 `.gitignore` 已忽略 `tmp/`）。
- **断言真实性**：源码 **17 条 `ok()`** 与 `docs/m5-e2e-result.json` 的 `checks:17 / failures:0` 完全对应；断言覆盖 client bundle、会话页签、任务图节点、甘特行真实可见、总览、回放控件/范围/拖动、帧率 ≥30、视图高度适配、stateVersion≥3、无 task-map/其它 console error。
- **证据一致性**：`docs/m5-e2e-result.json` 与 `tmp/e2e-work/m5-e2e-out/result.json` **完全相同**；`docs/m5-mvp-e2e.png` 与同目录 `overview.png` **sha256 相同**（1680×1050）；result：tasks 8、completed 8、taskNodes/ganttRows/visible=8、fps **120.7**、changesVisible 1、baseline 7、rootHeight 804 ≤ host 974、consoleErrors=[]。
- **说明诚实性**：`docs/M5-E2E.md` 明确「不在 npm test 中运行、依赖真实实例+Chrome+playwright-core」「隔离 web profile 无 Agent Teams → 实时任务链路不可测」「token 脱敏」「end-seed 尾巴」限制，与脚本行为一致。
- **限制**：运行中 55021 的 token 不可得（浏览器会话持有，不落盘可读处），**未对实机独立复跑**；E2E 属一次性实现者证据 + JSON/截图/脚本/文档交叉核对（结果与 tmp 原始产物字节一致，可信度高）。

---

## 6. E. W5.4/W5.5 验收报告与文档收口（PASS，114/114）

### 6.1 US-1~US-9 对照（`docs/MVP-ACCEPTANCE.md`）

| US | 状态 | 审计核验 |
|---|---|---|
| US-1 计划可见 | ✅ | 3 会话 M2 截图/任务数/负责人/依赖存在；空态截图「本会话未维护任务清单」存在 |
| US-2 执行中看进度 | ✅（回放/投影；实时链路见限制） | 回放时钟/状态 chips/「已跑」断言在 M2/M3 证据；宿主投影实时折叠为 M1 验证，**实时「对话建任务→面板实时出现」仍未端到端**（README/MVP §6 已列为已知限制） |
| US-3 复盘回放 | ✅ | M2 E2E 60~600×、拖动、键盘、任意时刻可复现、未来不剧透 |
| US-4 耗时/等待 | ✅ | 3 会话 golden ±0ms；task-7 blocked 22.52min 等 |
| US-5 任务过程 | ✅ | 详情状态区间/执行过程（时间窗推断标注）/跳转；M2 截图 |
| US-6 插入任务 | ✅ | 真实 baklib 7→8（M3 证据）；NEW/基线 diff/出现时刻 |
| US-7 拆分分叉 | ✅（真实工具调用 + 合成视觉） | M4：真实模型调用记录关系→投影→渲染；父任务提示/无效关系为合成 preview（报告已标注） |
| US-8 全局页 | ⬜ 未实现（P1） | 边界标注正确；M0 已预留 main/sidebar slot |
| US-9 跨会话查询 | ⬜ 未实现（P2） | 边界标注正确 |

### 6.2 手工验收清单（§10.3 / 执行清单）：10 项全部 `[x]`（含证据类型注释：3 秒项注明「组件预算 + E2E 加载，非精确计时」、拆分项注明「真实工具调用 + 合成视觉证据」、19 任务注明「合成 120fps，真实长会话待后续观察」）；`Gate MVP` 保持未勾选，待本审计 PASS 后由 Lead 勾选（符合流程）。

### 6.3 数据验证（3 会话 vs golden，审计方独立复算）

| 会话 | 审计核验 |
|---|---|
| baklib 飞书 SSO | 8 tasks；queue 2,354,635ms=39.24min、exec 4,823,466ms=80.39min、blocked 1,351,134ms=22.52min、waitAgent 824,680ms=13.74min、wallClock 5,230,339ms=1:27:10（与 MVP 报告数字一致） |
| P2P/Athena Port | 9 tasks、6 turns、wallClock 6,954,750ms=115.9min、waitAgent 38.3min |
| Athena 计划看板 | 6 tasks、preTurn -2,815,140ms=-46.92min（`preTurnRestored`）、**回放时长 2,883,301ms=48:03**、golden wallClockMs=68,161ms≈1:08（首轮审计发现「wallClock 48:03」术语误用，已修正） |

### 6.4 CHANGELOG / README / 版本 / 隐私

- `CHANGELOG.md`：`[1.0.0]` 覆盖 M1~M5 全部 Added 条目 + Changed/Fixed/Security/Known limitations（Keep a Changelog 结构）；health 同源校验、无效关系口径、安装脚本、甘特高亮修复均有记录。
- README：v1.0.0、安装（desktop/隔离演练/卸载）、使用、安全（同源 403/200）、已知限制（实时链路/体积降级/主题/长会话）、后续 P1/P2 均准确；首轮审计发现的 4 处陈旧数字（M5 未开始、286、513/260、0.4.0）已全部修正并复核。
- 版本：package/host/client/**运行中 health** 均 1.0.0；STATE_VERSION=3。
- 隐私复审：README/MVP/CHANGELOG 均记录 `private:true`、`files` 白名单不含 docs/test/scripts/tools（静态核对通过）、fixtures/截图含本地路径/内网信息需发布前脱敏；`package.json` `files` 仅 `index.js/client.js/lib//cordis.patch.yml/locale/*.json`。

### 6.5 文档数字复核（重点，历次审计均抓到不实）

- 290/35/529/272 与 1,126 断言在 README（2 处）、MVP-ACCEPTANCE、进度日志一致；M5 E2E 17/0、截图 1 张（M5）/8（M3）/4（M4）/19（M2）与文件系统一致；E2E 脚本 17 条断言与结果 JSON 一致；`M1（derive 171 起逐步增长）`表述已修正（首轮「171→216」不准确）；athena wallClock 已修正；**审计未再发现文档数字不实**。

---

## 7. F. P3 收尾核销（PASS，44/44）

### 7.1 甘特子节点高亮（M4-AUDIT P3-m4-1）

- **代码修复（静态核验通过）**：`createGanttUpdater` 的 `signature` 已包含 `highlighted`（暂停态 highlight 变化会刷新）；`row.group.setAttribute('class', 'tm-tl-taskrow' + (selected ? ' tm-sel' : '') + (highlighted ? ' tm-child-hl' : ''))`；render 行 `h('g')` 只有一个 `className` 键（重复键旧缺陷已消除）。
- **测试表述**：首轮发现 client-logic 标签声称「DOM 路径在 jsdom harness 验证」但仓库无 jsdom 依赖/无该断言 → 已在 `2dc003a` 改为「开发期临时 jsdom+React harness 验证（不随仓库提交），此处仅断言纯函数可用」——表述已诚实；**残余 P3**：仓库内仍无真实 DOM 路径自动断言（无法独立复核临时 harness），已记 M5/后续。
- **修复正确性**：代码级静态确认（上述两处）+ 原缺陷逻辑（signature 不含 highlighted / className 重复键）已不存在。

### 7.2 无效关系口径（M4-AUDIT P3-m4-3）

独立重算（`/tmp/mvp-audit-data.mjs`，手算事件流）全部通过：
- 有效+无效关系混合：`changes.splits` 只含有效（valid=true）、`changes.log` 拆分只含有效、`counts.splits` 只计有效；无效关系进 `changes.invalidRelations`（含 `missing`）与 `counts.invalidRelations`，仍进 `warnings`；`view.relations` 保留全部（`valid=false`）可审计；无效关系不建 relation 边。
- 全部无效：`splits=[]`、`counts.splits=0`、`invalidRelations=1`、log 无 split；重复无效记录幂等去重。
- **asOfTime 过滤**：首轮发现 `invalidRelations` 未按 asOfTime 过滤（与 validSplits 不一致），已在 `2dc003a` 修复；独立复验回拨 asOfTime 后两者均为 0。
- 客户端：`prepareView` 归一化 `changes.invalidRelations/counts.invalidRelations`、`invalidRelationsOf` 去重（changes 优先、relation 兜底）、`asOfChangeCounts.splits` 只计有效、徽标/支线列表只含有效、Overview/详情「不计入拆分变更」「已忽略，不影响任务状态」文案与 `data-tm-invalid-relations` 标记正确；3 会话真实数据无 relation 不回归。

### 7.3 host-smoke「任务板未被改动」（M4-AUDIT P3-m4-2）

- `37427a6`：`boardSnapshotBefore = JSON.stringify(boardTasks)` 已移到**首个 `rel.execute` 之前**；全部合法+6 类非法调用后执行 `ok(relValue.validated === true && JSON.stringify(boardTasks) === boardSnapshotBefore, 'relation tool validates ids and only records (task board JSON unchanged after all calls)')` → **真正守护写路径**（审计方独立深冻结验证亦通过）；单条断言使 host-smoke 保持 **35 项**（与文档一致）。
- 审计方额外以 **深冻结任务板 + 源码扫描**独立验证工具无写路径（M4 B 段 59 项 + 本审计复核）。

### 7.4 其余 M4 遗留项

- O4（降级视图详情「共 N 条」as-of 聚合）：M5 **未处理**（client.js `spanTotal` 逻辑未变，diff 0）→ 仍为已知限制/后续优化（MVP-ACCEPTANCE §6 已列「超长会话…详情共 N 条为累计口径」）。
- 实时任务链路未端到端：MVP 报告/README 已诚实列为已知限制（隔离 web profile 无 Agent Teams）。

---

## 8. G. 环境与仓库卫生（PASS，12/12）

| # | 项 | 结果 |
|---|---|---|
| 1 | HEAD/工作区 | `37427a6`；`git status --short` 仅 `?? docs/MVP-AUDIT.md`（审计交付物） ✅ |
| 2 | 隔离环境 | `~/.dsh-lab*` **不存在**；演练临时 home 已删除 ✅ |
| 3 | 用户环境 | `~/.dsh` 唯一变更 = 用户要求的 desktop profile 官方安装（bundles/dependencies/node_modules 链接，版本 1.0.0）；web/headless profile 无插件 ✅ |
| 4 | 安装方式 | 仅 plugin_manager 官方流程（`.plugin-manager/logs/operation-fWdb89/pnpm.log` + profile package.json/lockfile 证据）；审计期间未重装/卸载 desktop 插件 ✅ |
| 5 | 仓库卫生 | 85 个跟踪文件（源码/脚本/测试/文档/证据）；无 `dist/`/`build/`/`node_modules/`；`.gitignore` 覆盖 node_modules/.dsh-lab/tmp/*.log ✅ |
| 6 | 凭据 | 仓库无 `sk-*`/Bearer/password/lab token 片段（fixtures 例外已记录）；E2E JSON token 脱敏 ✅ |
| 7 | 冻结证据 | M1~M4 审计报告/E2E JSON/截图自各自基线未改；M5 结果 JSON/截图与 tmp 原始产物字节一致 ✅ |
| 8 | 版本一致 | package/host/client/health 均 1.0.0；STATE_VERSION=3；`engines.dsh` 未变 ✅ |
| 9 | 测试计数一致 | 290/35/529/272=1,126；README（2 处）/MVP-ACCEPTANCE/进度日志一致 ✅ |
| 10 | 文档状态 | README/MVP-ACCEPTANCE/CHANGELOG/W5-INSTALL-DRILL/M5-E2E 均已收口；执行清单 W5/MVP 手工验收已勾选、Gate MVP 待审计 PASS 后勾选（收口流程正确）✅ |
| 11 | 脚本权限/健壮性 | install.sh/uninstall.sh 可执行、set -euo pipefail、幂等；DSH_HOME/PROFILE 可覆盖 ✅ |
| 12 | 桌面安装可用 | profile 链接有效（指向本仓库，版本 1.0.0）；运行中实例 host 已加载（health 200/403、Agent 工具实测）；客户端需刷新页面加载新 bundle（已知/文档化）✅ |

---

## 9. 问题清单（定级与闭环）

### 9.1 已闭环（首轮 `2795e59` 发现 → `2dc003a`/`37427a6` 修正 → 最终 HEAD 复核）

| ID | 级别 | 问题（首轮发现） | 闭环复核 |
|---|---|---|---|
| MVP-D1 | P2（文档） | README 收口数字/状态不实：M5 仍「⬜ 未开始」、M1「当前 286」、M2「当前 513/260」、M3+M4「0.4.0/0.4.0-m4」 | ✅ 已改为 M5 ✅ 完成并安装、290、529/272、1.0.0；复核无残留 |
| MVP-D2 | P2（行为/文档） | 隔离演练 uninstall 后 `node_modules/@local/dsh-task-map` 符号链接残留；W5 演练「无残留」与 MVP 手工验收「卸载无残留 ✅」过乐观 | ✅ `uninstall.sh` 已补删除链接+空 @local；审计方最终 HEAD 重演练：链接/@local/包配置/lockfile 全部清理，幂等；W5-INSTALL-DRILL §2.1 已补记录 |
| MVP-D3 | P2（测试/文档） | 甘特高亮「DOM 路径在 jsdom harness 验证」不实（仓库无 jsdom/无该断言）；M4-AUDIT F 要求「补真实路径断言」未闭环 | ✅ 表述改为「开发期临时 harness、不随仓库」；代码修复静态核验通过；**残余**：仍无仓库内真实 DOM 断言（P3，记后续） |
| MVP-D4 | P2（收口） | 执行清单 M5 5 项 + MVP 手工验收 10 项全部未勾选（README 已写 M5 完成） | ✅ W5.1~W5.5 与 10 项手工验收均已勾选并注明证据类型；Gate MVP 留待本审计 PASS 后勾选（流程正确） |
| MVP-D5 | P3（数据表述） | MVP-ACCEPTANCE athena 行「wallClock 48:03」术语错误（48:03 是回放时长；wallClockMs=68,161ms≈1:08） | ✅ 已改为「回放时长 48:03；golden wallClockMs=68,161ms（≈1:08，历史恢复语义）」 |
| MVP-D6 | P3（文档） | 「M1（171→216 checks）」不准确（216 为 M2 中间轮次计数，M1 审计基线 171） | ✅ 已改为「M1（derive 171 checks 起逐步增长）」并注明当前 290 |
| MVP-D7 | P3（证据强度） | 「3 秒内看到完成度」标 ✅ 但 E2E 无 3 秒计时断言（仅组件预算） | ✅ 已注明「组件预算 + E2E 加载，非精确 3s 计时」 |
| MVP-D8 | P3（文档） | W5 演练记录的依赖版本 0.4.0（历史演练时刻）与最终 1.0.0 易混淆 | ✅ 已注明「演练版本 0.4.0 为历史快照，最终交付/实机安装 1.0.0」 |
| MVP-D9 | P3（数据一致性） | `changes.invalidRelations` 未按 asOfTime 过滤（与 validSplits 不一致，live 不触发） | ✅ 已加 `recordedAt <= asOfTime`；独立复验回拨 asOfTime 后一致为 0 |
| MVP-D10 | P3（测试质量） | host-smoke「任务板未被改动」快照对比放在全部调用之后（恒真）；首轮修正拆分后 host 变 36 项与文档 35 不一致 | ✅ `37427a6` 快照移到首个 execute 之前 + 单条合并断言（35 项/1,126 断言），真正守护写路径 |

### 9.2 残余 P3（不阻断 Gate MVP，后续跟进）

| ID | 描述 | 跟进 |
|---|---|---|
| R1 | 甘特高亮无仓库内真实 DOM 自动断言（依赖开发期临时 harness，不可独立复核；代码已静态核验修复正确） | 后续可补 DOM harness 或真实浏览器断言 |
| R2 | O4：超长会话（>~60 任务）降级视图详情「共 N 条」为累计口径（非 as-of） | 后续 as-of 聚合或标注 |
| R3 | E2E 为一次性实现者证据；运行中 55021 token 不可得，未对实机独立复跑（已做 JSON/截图/脚本/文档四方交叉） | 已沉淀可复跑脚本；后续可加 token 获取方式或 CI |
| R4 | 无 `US-2` 实时「对话建任务→面板实时出现」端到端（隔离 profile 无 Agent Teams） | M2/M5 已知限制 |
| R5 | 暗/亮主题仅暗色截图证据（亮色为变量/模拟）；「3 秒首屏」无精确计时 | 后续手工复核/计时断言 |
| R6 | 安装为 `link:` 开发式安装（依赖本仓库路径）；桌面实例客户端页签需刷新页面加载新 bundle | README 已注明；后续可考虑打包发布（P2） |

### 9.3 不阻断但已知（按计划 P1/P2）

- US-8 全局页（P1）、US-9 `task_map_query` 跨会话查询（P2）未实现，产品方案 §8/§9 与 README/MVP 报告均已按计划标注。
- health 路由已加同源校验（原 M5-1 P0 已关闭）；插件只读派生、不写会话日志/任务状态。

---

## 10. Gate MVP 判定（对照产品方案 §8 / §10.3、交接文件 §8）

| 判据 | 结果 | 证据 |
|---|---|---|
| 干净环境可安装（15 分钟） | **PASS**（隔离演练秒级完成；caveat：本机已有 dsh/pnpm 依赖） | §4 隔离演练 + 实机安装证据 |
| 全部测试绿 | **PASS** | `npm test` exit 0，1,126/1,126 |
| M5 验收清单 | **PASS** | MVP-ACCEPTANCE + 执行清单 W5/手工验收勾选；Gate MVP 待 Lead 按本审计勾选 |
| 3 会话数据与手算一致 | **PASS** | golden 复算（§6.3） |
| 回放/详情/等待拆解/空态/暗色 | **PASS** | M1~M4 审计 + M2 E2E + 截图 |
| 插入 8→9、NEW、基线 diff | **PASS** | M3 审计 + E2E |
| 拆分分叉 + 不改状态 | **PASS**（真实工具调用 + 合成视觉） | M4 审计 + 真实调用 evidence |
| 无 token health → 403 | **PASS** | §3 handler 72/72 + 实机 55021 |
| 安装→使用→卸载→无残留 | **PASS** | §4 隔离演练（含 node_modules 清理） |
| 长会话（19 任务）不卡 | **PASS（合成）** | 19 任务合成 120fps、200 任务降级 <200KB；真实长会话待后续 |
| 不碰用户环境 | **PASS** | `.dsh-lab*` 不存在；唯一 `~/.dsh` 变更为用户要求的官方安装 |
| US-1~US-7 | **PASS**（US-2 实时链路为已知限制） | §6.1 |
| US-8/US-9 | 未实现（P1/P2），已标注 | §6.1 |

**最终判定：PASS（Gate MVP 通过）**。v1.0.0 功能、安全、安装/卸载、文档与证据收口均满足交付标准；残余项为 P3/后续版本范围，不阻断交付。

---

## 11. 残余风险 Top5 与后续（P1/P2）

**残余风险 Top5**

1. **实时任务链路未端到端**（US-2 的「对话建任务→面板实时出现」；隔离 web profile 无 Agent Teams）——插件核心数据链路（投影实时折叠）已由 M1 验证，但完整 UI 实时链路未在真实 Agent Teams profile 复跑。
2. **E2E 一次性证据**：隔离实例已删除；M5 结果 JSON/截图与 tmp 原始产物一致、脚本可复跑，但本审计无法用 55021 实机 token 独立重跑。
3. **甘特高亮无仓库内真实 DOM 断言**（代码已修，静态核验通过；回归保护弱）。
4. **超长会话降级视图「共 N 条」非 as-of**（>~60 任务才触发；3 真实会话不触发）。
5. **安装为 link 开发式安装**：依赖仓库路径；桌面实例客户端需刷新页面加载新 bundle；未做打包发布（P2 范围）。

**P1 / P2 边界（已按计划标注）**

- **P1（未实现）**：US-8 全局会话目录页（`main` + `sidebar.panellist`，不合并任务）、输入框小条、导出 PNG/HTML、子代理会话合并、本地备注/关系修正、流式动画。
- **P2（未实现）**：US-9 `task_map_query` 跨会话只读查询、LLM 自动复盘、趋势看板、市场发布（npm + 静态索引）、发布前隐私复审。

**后续建议（非阻断）**：补甘特高亮 DOM 断言；O4 as-of 聚合；实时链路真实 profile e2e；打包发布（脱敏 fixture/截图后）。

---

## 12. 复现命令附录

```bash
# A. 测试（仓库根目录，最终 HEAD 37427a6）
cd ~/dsh-task-map
npm test                                   # exit 0
node test/derive.test.mjs                  # 290 checks, 0 failed
node test/host-smoke.mjs                   # 35 ✓ → PASS
node test/client-smoke.mjs                 # PASS (529 checks)
node test/client-logic.test.mjs            # PASS (272 checks)

# B/F. 审计方独立脚本（一次性，/tmp，不写仓库；最终 HEAD 上重跑）
node /tmp/mvp-audit-security.mjs   # health 同源校验/响应字段/源码审查：72/72
node /tmp/mvp-audit-data.mjs       # 无效关系口径/甘特高亮代码/host-smoke 快照/as-of：44/44
python3 /tmp/mvp-audit-docs.py     # 测试/版本/验收报告/CHANGELOG/隐私/收口：114/114

# C. 隔离安装/卸载演练（审计方已执行；可复跑）
TMPLAB=$(mktemp -d /tmp/mvp-lab.XXXXXX)
DSH_HOME="$TMPLAB" PROFILE=web bash scripts/install.sh
test -L "$TMPLAB/profiles/web/node_modules/@local/dsh-task-map" && echo 'link ok'
DSH_HOME="$TMPLAB" PROFILE=web bash scripts/uninstall.sh
test -e "$TMPLAB/profiles/web/node_modules/@local/dsh-task-map" && echo 'RESIDUE' || echo 'link removed'
rm -rf "$TMPLAB"

# D. E2E 证据交叉（只读；实跑需带 token 的实例 URL）
grep -c 'ok(' tools/e2e/task-map-e2e.mjs                      # 17
python3 -c "import json;d=json.load(open('docs/m5-e2e-result.json'));print(d['checks'],d['failures'],d['fps'],d['stats']['stateVersion'],d['consoleErrors'])"
shasum -a 256 docs/m5-mvp-e2e.png tmp/e2e-work/m5-e2e-out/overview.png   # 相同
diff <(python3 -m json.tool docs/m5-e2e-result.json) <(python3 -m json.tool tmp/e2e-work/m5-e2e-out/result.json) && echo identical

# B/G. 运行中实机（只读）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:55021/task-map/api/health                       # 403
curl -s -H 'Sec-Fetch-Site: same-origin' -H 'Host: 127.0.0.1:55021' http://127.0.0.1:55021/task-map/api/health   # 200 + version 1.0.0/stateVersion 3
curl -s -H 'Origin: http://evil.example' -H 'Host: 127.0.0.1:55021' http://127.0.0.1:55021/task-map/api/health  # 403

# G. 环境与仓库卫生
git rev-parse HEAD                                            # 37427a6...
git status --short                                            # 仅 ?? docs/MVP-AUDIT.md
ls ~/.dsh-lab*                 # NOT EXISTS
grep -c 'dsh-task-map' ~/.dsh/profiles/desktop/package.json   # 2（bundle+dependency）
grep -l 'dsh-task-map' ~/.dsh/profiles/{web,headless}/package.json   # 无输出
ls ~/.dsh/profiles/desktop/.plugin-manager/logs/operation-fWdb89/pnpm.log   # 官方安装证据
grep -rnE 'sk-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9._-]{10,}|password\s*[:=]' \
  --include='*.js' --include='*.mjs' --include='*.json' --include='*.md' . | grep -v test/fixtures/   # 无输出
```

> 说明：E2E 隔离实例（8088）已删除；`tmp/e2e-work/*`（M5 原始 result/截图/日志）与 `/tmp/mvp-audit-*` 均为仓库外一次性证据，可能随工作区清理消失；本报告记录审计时刻（2026-11-05 10:28~10:52 Asia/Shanghai）的只读核对结果。

---

## 附：审计执行摘要（基线演进与闭环记录）

- 审计起始基线 `2795e59`：首轮发现 10 项收口问题（README 数字/状态、uninstall node_modules 残留、jsdom 不实表述、执行清单未勾选、athena wallClock 术语、M1 计数表述、3 秒证据、演练版本、invalidRelations as-of、host-smoke 快照空操作/计数不一致）→ 发送 Lead。
- Lead 修正 → `2dc003a`（P2/P3 收口 + 两处小逻辑）；审计方复核发现「host-smoke 拆分后 36 项/1,127 与文档 35/1,126 不一致 + 快照位置仍空操作」→ 再报。
- Lead 修正 → **FINAL `37427a6`**（host-smoke 合并回 35 项/1,126、快照移到首个 execute 前；仅 2 文件）。审计方在 `37427a6` 上重跑：`npm test` 1,126/1,126、B 72/72、C 16/16（隔离演练）、D 18/18、E 114/114、F 44/44、G 12/12；运行中 55021 实机 health 200/403 与 tools 复核通过。
- 审计方未修改任何代码/脚本/测试/fixture/golden/进度日志/环境；唯一写入为本文件 `docs/MVP-AUDIT.md`。未重装/卸载 desktop 插件、未联网、未 npm install、未 git commit。
