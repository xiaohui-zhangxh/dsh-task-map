# M4 隔离实例 E2E 验证报告（W4.4）

> 日期：2026-11-05 ｜ DSH 0.2.1-rc.5 ｜ 插件版本 0.4.0-m4（STATE_VERSION=3）
> 结论：**M4 关系记录 E2E 通过**（24 项断言 / 0 失败）。关键：在隔离实例的 baklib 真实会话中，模型**真实调用** `task_map_record_relation`——合法 id 返回「Recorded split: task-1 → task-8（只记录，不调度）」并进入投影渲染；非法 id 返回「Relation not recorded: 任务不存在于本会话任务板：task-404」且不记录。合成视图补充验证父任务提示与无效关系展示。
> 环境纪律：隔离 `DSH_HOME=~/.dsh-lab`（复制会话/临时凭据），**未修改 `~/.dsh`**；验证后已停止实例并删除隔离 home。

---

## 1. 验证环境与命令

```bash
LAB=~/.dsh-lab
# 复制 3 个真实会话（只读源）+ 临时凭据 → 隔离 home
DSH_HOME="$LAB" dsh plugin --profile web add link:~/dsh-task-map
DSH_HOME="$LAB" dsh web --no-open --port 8089
node tmp/e2e-work/m4-e2e.cjs '<token URL>' '<lab baklib session.v4.jsonl.zstd>'
```

宿主日志：`[task-map] host applying (0.4.0-m4)`，投影/工具/路由注册成功。

---

## 2. 真实工具调用（W4.1 校验，真实模型 + 真实会话日志）

在隔离实例中打开 baklib 会话副本（8 任务全完成），把模型提示为「只调用两次 task_map_record_relation」：

| # | 调用参数 | 工具结果（会话日志原文） | 结论 |
|---|---|---|---|
| 1 | parent=task-1, children=[task-8], kind=split, note=「M4 E2E 合法示例」 | `Recorded split: task-1 → task-8（只记录，不调度）` | ✅ 合法记录 |
| 2 | parent=task-1, children=[task-404], kind=split, note=「M4 E2E 非法示例」 | `Relation not recorded: 任务不存在于本会话任务板：task-404` | ✅ 拒绝且不记录 |

- 证据来源：会话日志 `tool/call` + `tool/result`（脚本 `readToolEvidence()` 用 `zstd -dc` 读取，seq/time/文本见 `docs/m4-e2e-verification.json` 的 `realTool.evidence`）；两次 E2E 运行各出现一对（合法/非法），结果一致。
- 投影验证：刷新后任务地图中 `relations ≥ 1`，task-1 节点出现「支线 1」徽标、task-8 显示「支线 of task-1」；真实关系边渲染成功（截图 4）。
- **只记录、不改状态（证据归属）**：① `index.js` 关系工具只做只读查询并返回 JSON，无任何写路径；② 数据层 fold `task_map_record_relation` 只追加 `relations/changeLog`，不改 `tasks` 节点（独立审计对任务节点 JSON 前后全等验证）；③ E2E 脚本的「reset 前后真实投影任务状态一致」发生在合成 preview 注入与 reset 之间，用于证明 UI 预览不改数据；三者合起来支撑「插件不改任务状态」。

---

## 3. 合成视图验证（真实 3 会话无 relation 调用，标注合成数据）

| 场景 | 断言结果 | 截图 |
|---|---|---|
| 拆分分叉 + 父/子节点视觉 | 父节点「支线 N」徽标（`data-tm-relation-badge/count`）、子节点 `data-tm-child-of="task-1"`、relation 紫色虚线边；点击子任务行 → `data-tm-selected=task-8`，详情显示「属于 task-1 的支线」 | `docs/m4-split-relations.png` |
| 父任务已完成但子任务未完成 | 详情显示 `data-tm-relation-alert`：「父任务已完成，1 个子任务未完成（仅提示，不改任务状态）」；reset 后真实投影任务状态与初始完全一致 | `docs/m4-parent-hint.png` |
| 无效关系（valid=false / id 不存在） | 显示 `data-tm-relation-invalid`：「关系记录引用了不存在的任务：task-404（已忽略，不影响任务状态）」；真实会话中该无效调用也会在总览显示「数据缺失 1」警告 chip | `docs/m4-invalid-relation.png` |
| 真实关系渲染（上一节真实工具调用后） | task-1「支线 1」徽标 + task-8「支线 of task-1」+ 紫色关系边 + 变更记录「拆分 task-1 → task-8」 | `docs/m4-real-tool-relation.png` |

补充：拆分变更记录点击后将回放时钟设为拆分时刻、选中父任务并高亮子节点（组件测试覆盖回调/高亮标志；定时清除未测，且甘特侧高亮刷新存在已知缺陷，已记 M5 跟进）。

---

## 4. 版本 / 契约

- `package.json` 0.4.0；client 版本标记 `0.4.0-m4`；`data-tm-state-version="3"`（STATE_VERSION 3，含 changeLog/baseline.blockedBy/relation.source 等 M3/M4 契约）。
- 关系工具输出 schema：`{ok, validated, reason, invalidIds, recorded}`；不改变任何任务状态/会话日志。

## 5. 证据文件

- 结构化摘要：`docs/m4-e2e-verification.json`（含真实工具调用的 args/result 原文、合成断言、console errors=[]）
- 截图：`docs/m4-split-relations.png`、`docs/m4-parent-hint.png`、`docs/m4-invalid-relation.png`、`docs/m4-real-tool-relation.png`
- E2E 脚本（临时，不随插件发布）：`tmp/e2e-work/m4-e2e.cjs`

## 6. 限制与已知问题

1. **合成关系场景**：父任务提示/无效关系详情为 preview 注入（真实 3 会话无 relation 调用）；真实工具调用已在 §2 端到端验证，二者互补。
2. **无效调用的副作用**：真实 E2E 特意调用了 task-404，该 tool/call 会落日志并在投影中留下一条 `valid=false` 的 relation（渲染为警告 chip「数据缺失 1」）——这是「只记录」设计的预期行为，不影响任务状态；生产使用中 AI 不应传入不存在的 id。注意：无效关系当前仍计入「拆分」变更流与计数 chips（截图可见「拆分 3 / 数据缺失 2」），M5 将决定是否在变更流标记无效/剔除计数。
3. **E2E 一次性证据**：隔离实例已删除不可复跑；数据层边界由 `test/derive.test.mjs`（286 checks）与 Gate M4 独立审计交叉验证。
4. 每次打开历史会话仍会追加 `session/end-seed`（已由 `tailMs` 剔除，截图顶部提示会随打开次数增长）。
5. **E2E 轮次透明说明**：run1（24 checks / 2 failed）因合成视图时序/选择器断言问题失败，run2 修正脚本选择器后为 24 checks / 0 failed（最终证据）；代码与数据未因 run1 改动。
6. `docs/m4-e2e-verification.json` 中 `synthetic.split.relationBadges/childOf` 含流程图 + 甘特两层元素（甘特层无 `data-tm-task-id`，故部分条目 id 为空），属证据提取口径而非渲染缺陷。
