# MVP 验收报告 — DSH 任务地图（Task Map）1.0.0

> 日期：2026-11-05 ｜ 版本：1.0.0 ｜ 目标 DSH：0.2.1-rc.5 ｜ 契约：`stateVersion=3`
> 验收方式：产品方案 §10.3 手工验收清单 + 用户故事 US-1~US-9 + 各里程碑独立审计（`docs/M1-AUDIT.md`~`docs/M4-AUDIT.md`）
> 结论：**MVP 功能验收通过，可交付安装**。P1（全局页等）/ P2（跨会话查询）按计划留在后续版本。

---

## 0. 安装状态（2026-11-05 10:27）

- 已通过 `plugin_manager install_bundle` 安装到本机 **desktop profile**（`~/.dsh/profiles/desktop`）：
  - `dsh.profile.bundles` 末尾已含 `@local/dsh-task-map`；
  - `dependencies` = `link:~/dsh-task-map`（版本 1.0.0），`node_modules/@local/dsh-task-map` 符号链接已创建；
  - **运行中实例（127.0.0.1:55021）已热加载 host 插件**：同源请求 `/task-map/api/health` → 200 `{version:"1.0.0", stateVersion:3}`；裸 curl → 403；本会话 Agent 工具列表已出现 `task_map_ping` / `task_map_record_relation`。
  - 客户端页签需**刷新页面**后加载新 client bundle（客户端资源在页面启动时注入）。
- 卸载：`./scripts/uninstall.sh` 或从 profile 插件管理器移除；隔离演练见 `docs/W5-INSTALL-DRILL.md`。

## 1. 用户故事验收（产品方案 §3）

| ID | 用户故事 | 状态 | 证据 |
|---|---|---|---|
| **US-1** | 执行前看计划（任务数/标题/负责人/依赖/状态；空板提示） | ✅ | `docs/m2-*-overview.png`、M2 E2E；空态 `docs/m2-empty-state.png`（「本会话未维护任务清单」） |
| **US-2** | 执行中看进度（状态/计时，无需刷新） | ✅ | host 投影实时折叠（M1 验证）、回放时钟/状态 chips；`docs/m2-*-replay-*.png` |
| **US-3** | 结束后复盘（播放/暂停/倍速/拖动/任意时刻还原/未来不剧透） | ✅ | M2 E2E 60~600×、拖动/键盘；E2E 断言 `currentTime` 可复现、未来不剧透（`docs/M2-E2E-VERIFICATION.md`） |
| **US-4** | 每个任务花了多久、任务间等了多久（等待拆解） | ✅ | 详情/总览等待拆解（M1 黄金值 ±0ms：queue 39.2min、blocked 22.52min、waitAgent 13.7min 等）；`docs/m2-*-detail.png` |
| **US-5** | 点击任务看具体干了什么（状态区间/依赖/写入范围/执行过程/跳转） | ✅ | 详情面板：phases 时间线、执行过程（时间窗推断，标注）、跳到开始/完成；M2/M3 E2E |
| **US-6** | 对话插入任务后面板体现（8→9、NEW、基线 diff、回放出现时刻） | ✅ | 真实 baklib：计划基线 7 → 新增 task-8；回放 1:06:36 前隐藏/1:06:51 后 NEW；变更记录点击跳转（`docs/M3-E2E-VERIFICATION.md`） |
| **US-7** | 对话拆分任务 → 图上有分叉（关系记录/变更登记/不改父任务状态） | ✅ | 工具校验（真实模型调用合法/非法 id，`docs/M4-E2E-VERIFICATION.md`）；客户端支线渲染/父任务完成子未完成仅提示不改状态（M4 审计 68/68） |
| **US-8** | 全局页（P1） | ⬜ 未实现（P1） | 计划 P1；项目内已预留 `main`/`sidebar.panellist` 入口（M0 验证） |
| **US-9** | 跨会话 AI 只读查询（P2） | ⬜ 未实现（P2） | 计划 P2（`task_map_query`）；产品口径已确认 |

## 2. 手工验收清单（执行清单「MVP 手工验收」逐项）

| 验收项 | 结果 | 证据 |
|---|---|---|
| 有任务板会话 3 秒内看到完成度/依赖/负责人 | ✅（组件预算 + E2E 加载；未做精确 3s 计时） | 首屏组件预算断言（prepare<200ms、首屏渲染<500ms）+ E2E 页面加载 |
| 回放 0→end 无报错、状态与时间轴同步 | ✅ | M2/E2E：0→end、任意 t 可复现 |
| task-7 详情：阻塞 22.5min、依赖 T1~T6、执行过程 | ✅ | 黄金值：blockedWaitMs=1,351,134ms（22.52min）、依赖 6 项、执行过程 67 条；M2 截图 |
| 对话插入任务 → NEW + diff +1 | ✅ | 真实 baklib 7→8（M3） |
| 对话拆分任务 → 子节点 + 变更时间 | ✅（合成补充） | 真实工具调用已记录关系（M4）；客户端支线渲染/变更记录为合成视图（真实 3 会话无 relation 调用，M4 报告已标注） |
| 无任务会话 → 空状态不伪造 | ✅ | M2 E2E 空态断言 |
| 安装→使用→卸载→无残留 | ✅ | `scripts/install.sh`/`uninstall.sh` 隔离演练：**package.json bundles/dependencies + node_modules 链接**均清理（`docs/W5-INSTALL-DRILL.md`） |
| 无 token 访问 `/task-map/api/health` → 403 | ✅ | W5.1 同源校验：裸请求 403、同源 200（host-smoke + 实例验证） |
| 暗/亮主题可读 | ✅ | `docs/m2-*-dark.png` + 组件主题断言 |
| 19 任务长会话不卡 | ✅（合成） | 19 任务合成 120fps、200 任务降级 <200KB；真实长会话留 M5 后续观察 |

## 3. 数据验证（3 个真实会话）

| 会话 | 任务 | 关键黄金值（与 Python 独立手算 ±0ms） | 证据 |
|---|---|---|---|
| baklib 飞书 SSO | 8（全完成） | queue 39.24min / exec 80.39min / blocked 22.52min / waitAgent 13.74min / 墙钟 1:27:10 | `docs/golden-values.json`、`test/derive.test.mjs` 290 checks |
| P2P/Athena Port | 9（全完成） | 6 回合、wallClock 115.9min、waitAgent 38.3min | 同上 |
| Athena 计划看板 | 6（历史恢复） | preTurn=-46.92min（`preTurnRestored`）；回放时长 48:03；golden wallClockMs=68,161ms（≈1:08，历史恢复语义） | 同上 |

## 4. 质量证据

- 测试：`derive.test.mjs` **290 checks**、`host-smoke.mjs` **35 项**、`client-smoke.mjs` **529 checks**、`client-logic.test.mjs` **272 checks**（`npm test` 全绿，1,126 项断言）。
- 独立审计：M1（derive 171 checks 起逐步增长）、M2（963 项）、M3（1,399 项）、M4（1,390 项）全部 PASS，0 阻断失败；当前 derive 290 checks。
- E2E：M2 81 checks / M3 45 / M4 24（含真实模型调用关系工具）；通用可复跑脚本 `tools/e2e/task-map-e2e.mjs`。
- 版本：`package.json` 1.0.0 ｜ host/client `1.0.0` ｜ `STATE_VERSION=3`。

## 5. 最终实例验证（隔离 DSH_HOME，2026-11-05）

| 项 | 结果 |
|---|---|
| 插件加载 | `[task-map] host applying (1.0.0)`，投影/2 工具/路由注册 |
| health 安全 | 裸 `curl` → **403**；同源（`Sec-Fetch-Site: same-origin` / 页面内 fetch）→ **200** 且响应无调试字段 |
| 可复跑 E2E（`tools/e2e/task-map-e2e.mjs`） | **17 checks / 0 failed**：任务图/甘特（真实可见）/总览/回放（拖动、120fps）/视图适配/stateVersion=3/无 console error |
| 版本标记 | `window.__TASK_MAP_M2__.version = "1.0.0"`、health `version=1.0.0`、`stateVersion=3` |
| 证据 | `docs/m5-mvp-e2e.png`、`docs/m5-e2e-result.json` |

> 该实例为一次性验证（含临时会话副本/凭据），验证后已删除；日常安装使用 `scripts/install.sh`（默认 desktop profile）。

## 6. 已知限制与后续计划

| 项 | 说明 | 计划 |
|---|---|---|
| 实时任务链路 | 隔离 `dsh web` 无 Agent Teams；M4 已真实验证关系工具，实时「对话建任务→面板实时出现」未端到端 | P1/P2 或后续 e2e |
| 全局页 / 跨会话查询 | US-8（P1）、US-9（P2）未实现 | 按计划后续 |
| 超长会话（>~60 任务） | 视图自动降级（描述/span 截断），详情「共 N 条」为累计口径 | 后续 as-of 聚合优化 |
| 甘特子节点高亮 | 真实交互路径缺陷已在 M5 修复（className 重复键 + updater signature） | 已修 |
| 无效关系 | 不再计入拆分变更流/计数，改为 `changes.invalidRelations` + warnings（「只记录可审计」保持） | 已修 |
| 隐私 | fixtures/截图含本地路径/内网信息；`package.json` `files` 白名单不含 docs/test，`private:true` | 发布前脱敏复审 |
| health 路由 | 已加同源校验；不再返回调试字段 | 已修 |
