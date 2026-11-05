# M3 隔离实例 E2E 验证报告（W3.4）

> 日期：2026-11-05 ｜ DSH 0.2.1-rc.5 ｜ 插件版本 0.2.0（M3 客户端）
> 结论：**M3 基线与变更 E2E 通过**（45 项断言 / 0 失败）：真实 baklib 会话「计划基线 7 → 新增 1」在回放中按出现时刻正确展示（NEW 标记/Ghost/变更记录/点击跳转），拆分分叉与 19 任务长会话用合成视图补充验证，无障碍与性能断言通过。
> 环境纪律：隔离 `DSH_HOME=~/.dsh-lab`，**未修改 `~/.dsh`**；验证后已删除隔离 home（含临时复制的凭据/会话）。

---

## 1. 验证环境与命令

```bash
LAB=~/.dsh-lab
# 复制 3 个真实会话（只读源）+ 临时凭据 → 隔离 home
DSH_HOME="$LAB" dsh plugin --profile web add link:~/dsh-task-map
DSH_HOME="$LAB" dsh web --no-open --port 8089
node tmp/e2e-work/m3-e2e.cjs '<token URL>'   # 45 checks
```

---

## 2. 真实数据：计划基线 vs 实际

| 会话 | 计划基线（封板） | 新增 | 移除 | 依赖变更 | 拆分 | 断言 |
|---|---|---|---|---|---|---|
| `baklib-feishu-sso`（全部完成） | **7 任务**（23:42:43 封板） | **1（task-8, 1:06:41）** | 0 | 0 | 0 | ✅ |
| `p2p-athena-port` | 3 任务 | 6 | 0 | 0 | 0 | ✅ |
| `athena-plan-board` | 5 任务 | 1 | 0 | 0 | 0 | ✅ |

> 数据层基线口径：首次任务集合快照 + 封板宽限期（避免任务板初始批量写入的尾随 revision 被误报为依赖变更）。
> 说明：p2p/athena 为仍在增长的真实会话，其任务板在 M1 冻结快照之后仍可能被继续推进；上表为本次验证时点的真实投影值。

### 2.1 US-6：对话插入任务（8→9 / 真实 7→8）在回放中正确出现

| 回放时刻 | 变更记录可见数 | task-8 节点 | 截图 |
|---|---|---|---|
| **1:06:36**（task-8 创建前 5 秒） | **0**（另有 1 条未来变更，回放中隐藏） | `〔计划〕计划·未创建` Ghost，虚线/降透明，甘特行标「〔计划〕」 | `docs/m3-baklib-before-new.png` |
| **1:06:51**（创建后 10 秒，断言时刻） | **1**（新增 task-8） | NEW 标记出现、Ghost 消失 | 截图实际在随后「点击变更跳转」的 **1:06:41** 拍摄（`docs/m3-baklib-after-new.png`，同样处于创建后） |
| 回放终点 | 1（新增 1 / 移除 0 / 依赖变更 0 / 拆分 0） | NEW 保持 | `docs/m3-baklib-changes-end.png`、`docs/m3-baklib-changes-list.png` |

- 变更记录条目：`+1:06:41 · 新增 · 新增任务 T7a 验收预检与验收报告骨架…`；
- 点击条目 → 回放时钟精确对齐 `change.at`（`data-tm-current-time === 1793807665978`，±0ms），并选中 task-8；
- 总览「计划基线 7 个任务 · 封板 23:42」+ 计数 chips（新增 1/移除 0/依赖变更 0/拆分 0）随回放时刻过滤。

### 2.2 US-7：拆分分叉（真实会话无 relation 记录 → 合成视图补充）

真实 3 个会话的事件里没有 `task_map_record_relation` 调用，因此用客户端 **preview 注入**（仅页面内存、不落盘）构造合成视图验证渲染链路，截图标注「合成数据」：

- 任务图出现紫色虚线关系边（task-1 → task-8）；变更记录出现「拆分 task-1 → task-8（合成数据）」（真实实例 E2E 断言）；
- 点击拆分条目的「跳转时刻 + 选中父/子任务」与「拆分不改变任务状态」由 **组件测试**（`test/client-smoke.mjs`/`test/client-logic.test.mjs`）与数据层测试覆盖（E2E 未逐项断言，属证据来源分离）。
- 截图：`docs/m3-split-synthetic.png`；组件级断言见 `test/client-smoke.mjs`。

---

## 3. W3.3 打磨验证（真实实例）

- **无障碍（证据来源分列）**：
  - 真实实例 E2E 断言：任务图节点 `tabindex=0` + `aria-label`（含标题/状态/负责人）、回放按钮 `aria-label`/`aria-pressed` 初始值、根节点 `role=region`；
  - 组件测试断言（stub 宿主 + 伪 React）：Enter/Space 选中节点与甘特条（不误触全局空格播放）、播放按钮 `aria-pressed` 随播放切换、`:focus-visible` 焦点样式、`prefers-reduced-motion` 关闭动画、空格/←→/Esc 键盘行为。
- **性能**：19 任务合成视图（preview）回放 **120.1fps**（rAF 采样约 180 帧 / 1.5s，帧数由 fps×时长推算）；`getState().frameMs = 2.98ms`；任务图 **DOM 渲染 19 节点**（可视区按 5 行滚动，见「共 N 行 · 滚动查看全部」提示）、甘特按视口窗口化渲染（8 行可见 + 内部滚动）。
- **错误/降级**：`{}`/异常字段/最小任务视图在 client 测试中覆盖（局部提示不崩页、warnings chip）。
- 截图：`docs/m3-long-session-synthetic.png`（合成 19 任务）。

---

## 4. 证据文件

- 结构化摘要：`docs/m3-e2e-verification.json`（各阶段 data-tm-* 值、拆分/长会话合成结果、console errors=[]）
- 截图：`docs/m3-baklib-{before-new,after-new,changes-end,changes-list}.png`、`docs/m3-{p2p,athena}-changes.png`、`docs/m3-split-synthetic.png`、`docs/m3-long-session-synthetic.png`
- E2E 脚本（临时，不随插件发布）：`tmp/e2e-work/m3-e2e.cjs`（W5.3 沉淀为可复跑 e2e）

---

## 5. 限制与已知问题

1. **拆分场景为合成数据**：真实会话无 `task_map_record_relation` 调用；US-7 的真实对话拆分验收留待 M4（关系工具校验 + 真实对话）与 W5.3 e2e（真实 Agent Teams profile）。
2. **p2p/athena 为增长中的真实会话**：任务板内容随会话推进可能变化，本报告数字为验证时点；baklib 为稳定历史会话，是 US-6 的主证据。
3. **E2E 一次性证据**：隔离实例已删除、不可独立复跑；数据层语义由 `test/derive.test.mjs`（270 checks）与 Gate M3 独立审计交叉验证。
4. 每个历史会话被打开都会追加 `session/end-seed`，被数据层 `tailMs` 剔除（截图顶部「收尾记录已剔除」提示会随打开次数增长）。
5. 19 任务为合成视图（真实 3 会话最大 9 任务）；真实长会话验收见 M5/W5.3。
