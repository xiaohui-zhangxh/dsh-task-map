# Changelog

本文件格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [1.1.3] — 2026-11-05

### Fixed

- **重复启用/热更新后的插件 UI 消失**：`apply` 每次执行前先释放上一轮投影/工具/路由挂载（host 幂等），客户端 slot 注册按名称去重并释放旧注册；修复「关闭→启用」循环中工具重复注册（2→4→6）与会话页签不再出现的问题（`docs/V1.1.3-IDEMPOTENT.md`）。

## [1.1.2] — 2026-11-05

### Fixed

- **移除原生 title 提示**：流程图节点 SVG `<title>` 与各 DOM 元素的原生 `title` 属性全部移除（此前与插件自定义 tooltip 重叠，出现浏览器白色原生提示）；必要信息改用 `aria-label` / 自定义 tooltip / 详情面板展示（`docs/V1.1.2-NATIVE-TOOLTIP.md`）。

## [1.1.1] — 2026-11-05

### Fixed

- **禁用/卸载插件后的界面残留**：注入样式补 `data-plugin` 标记（client-modules 可按插件清理）；插件 fiber 销毁时清理 `<html>` 上的 `data-task-map-*` 标记、注入样式与 `window.__TASK_MAP_M2__`/`__TASK_MAP_M0__` 调试对象；slot（左侧导航/会话页签）由 DSH client-modules 正常移除。文档补充「禁用/卸载后如仍残留请刷新页面」与排查方式（`docs/V1.1.1-UNINSTALL.md`）。

## [1.1.0] — 2026-11-05

### Added

- **会话计划（todo）与团队任务并存**：数据层始终折叠 `todo/write` 计划（`state.plan`/`view.plan`，STATE_VERSION 4），总览新增「会话计划（todo）」区块（计数 chips + 清单 + 计划更新次数，只读）；解决「团队任务板出现后会话 todo 计划被忽略」的缺口。

### Fixed

- **流程图卡片浮层跑到屏幕左上角**：节点 focus 事件的 `clientX/clientY` 为 0 导致 tooltip 定位在 (0,0)；改为按节点矩形定位并做视口 clamp，鼠标 hover 同样 clamp。

## [1.0.2] — 2026-11-05

### Fixed

- **流程图单图模式顶部被遮挡**（用户反馈）：单图容器由 flex 居中改为顶部对齐 + `overflow:hidden`，SVG `max-height:100%` 防比例/取整导致的纵向裁切；进入单图/resize/relayout 后 `scrollTop` 归零；`stretchFlowLayout` 增加容器高度二次 clamp；面板头底部加安全间距。覆盖 1024×700~3440×1440 12 种尺寸 + 小窗口→最大化路径（E2E 25/25）。

## [1.0.1] — 2026-11-05

### Added

- **单图模式（大屏优化）**：流程图与甘特图面板标题栏各增加「⤢ 放大流程图 / ⤢ 放大甘特图」按钮，单图占满左栏高度、另一图折叠为仅标题栏；单图模式下按钮变「⇲ 恢复双栏」。DOM 保留、切换不丢回放时刻/选中；支持键盘 Enter/Space 与 `aria-label`/`aria-pressed`。
- 单图模式下流程图按容器高度重排（节点增高 + 行距拉开、x 轴不变）；甘特按 `rowScale` 放大行距（时间映射不变、窗口化行数随高度重算）。

### Fixed

- 窗口 resize / 大屏（如 1680×1050→2560×1440）后视图高度不重算：`useHostFitHeight` 改为结构式测量 + `window.resize` 监听（rAF + 150ms 去抖）+ layoutMode 切换时重算，根视图随宿主自适应。

## [1.0.0] — 2026-11-05（MVP）

首个可交付版本：会话内「任务地图」页签（任务图 / 甘特 / 回放 / 详情 / 总览 / 变更流 / 关系支线），Host 投影 + 2 个 Agent 工具 + 同源健康路由。

### Added

- **M1 数据核心**：`lib/derive.js` 纯函数折叠会话事件（team/task、team/member、todo/write、turn/step、tool、job、approval、subagent、usage、title、deliverables、command、goal、end-seed、关系参数）；任务状态历史/依赖/负责人/执行耗时/排队/依赖阻塞/就绪延迟/交接/代理等待/审批等待/人工空闲/执行累计/token；无关/未知事件返回同一引用；投影 `stateVersion`（M4 起为 3）。
- **M1 黄金测试**：3 个真实会话脱敏 fixture + Python 独立手算黄金值 + `derive.test.mjs`（当前 290 checks，任务数/状态/时间/耗时/等待/负责人/依赖/排名 ±0ms）。
- **M2 可视化**：任务图（S 形执行顺序、blockedBy 依赖、关系分叉、轨迹生长、状态色、负责人色条、NEW、hover/选中）、甘特（任务/代理/事件/热度/会话前空闲带/窗口化）、回放（单时钟 + rAF、60~600×、拖动/键盘、任意时刻可复现、未来不剧透、未完成「已跑 X」）、任务详情（按回放时刻推导六态、状态区间、执行过程时间窗推断）、总览（回放时刻完成度/活跃代理/token/等待拆解/累计 vs 墙钟）、空态/错误态/暗亮主题、宿主高度自适应、键盘无障碍与 reduced-motion。
- **M3 基线与变更**：计划基线快照（封板时刻/依赖快照/宽限期）、变更流（新增/移除/依赖变更/拆分 + 计数 + 日志）、NEW 出现时刻、计划未创建 Ghost、变更记录点击跳转。
- **M4 关系记录**：`task_map_record_relation` 只读校验（id 存在/kind 枚举/去重/禁自引用，不写状态）；`task_map_ping`；关系支线渲染（父「支线 N」/子「支线 of task-X」/详情支线列表/父任务完成子未完成仅提示/无效关系提示）。
- **M5 交付**：`/task-map/api/health` 同源校验（裸请求 403、同源 200）+ 精简响应；`scripts/install.sh` / `scripts/uninstall.sh`（隔离演练无残留）；可复跑 E2E 脚本 `tools/e2e/task-map-e2e.mjs`；MVP 验收报告 `docs/MVP-ACCEPTANCE.md`。

### Changed

- `STATE_VERSION` 2→3（M4 契约：changeLog/baseline.blockedBy/createdSeq/dependencyChanges/relations.source 等；旧 v2 缓存降级不崩）。
- 变更计数与变更日志同口径（`changes.counts` 按 log 计）；无效关系不计入拆分变更流/计数，改为 `changes.invalidRelations` + warnings。
- 历史会话被打开时追加的 `session/end-seed` 不再拉长回放/墙钟（`contentEnd` / `waits.tailMs`）。
- `wire.view` 分级体积 guard：按任务/span 规模降级（描述截断、span 仅最近 N 条 + 聚合摘要），200 任务 < 200KB 硬上限；等待指标独立累加不受 span 截断影响。

### Fixed

- 插件视图高于宿主可视区导致详情/甘特底部被裁、整页滚动（无 probe 自适应高度）。
- 甘特子节点高亮在暂停态不显示/不清除（className 重复键 + updater signature）。
- 等待 span 在关闭前被 `MAX_SPANS` 淘汰导致 waitAgent/askUser/approval 少算（`pendingWaits`/`pendingApprovals`）。
- 同毫秒封板新增日志缺条、未封板期依赖变更误入变更流、依赖计数与日志口径不一致。
- Agent 工具异常/畸形事件不再冒泡到宿主（投影 apply 局部降级）。

### Security

- `/task-map/api/health` 增加同源校验（`Sec-Fetch-Site`/`Origin`+`Host`），移除调试字段；Agent 工具只做只读校验、不写任何任务/会话状态；插件不写会话日志、不联网。

### Known limitations

- US-8（全局会话目录，P1）与 US-9（跨会话只读查询 `task_map_query`，P2）未实现。
- 实时「对话建任务 → 面板实时出现」在隔离 web profile 未端到端（无 Agent Teams）；M4 已用真实模型调用验证关系工具链路。
- 超长会话（>~60 任务）视图降级后详情「共 N 条」为累计口径；后续做 as-of 聚合。
- fixtures/截图含本地路径/内网信息，公开前需脱敏（仓库 `private:true`，npm files 白名单不含 docs/test）。
