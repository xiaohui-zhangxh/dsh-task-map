# M0 Spike 验收报告 — DSH Task Map

> 日期：2026-11-05 ｜ DSH 0.2.1-rc.5 ｜ 环境：项目内隔离 `DSH_HOME=~/.dsh-lab`（不触碰 `~/.dsh`）
> 结论：**M0 通过**。三项 seam（会话投影 / Agent 工具 / 插件 HTTP 路由）+ 客户端三个 slot + 会话页签 + 投影读取均已在真实 Web 实例验证。

---

## 1. 目标与范围

M0 只回答四个问题，不实现任务图：

| # | 问题 | 结果 |
|---|---|---|
| 1 | 插件能否作为本地 bundle 安装并被 host 加载？ | ✅ 是（`dsh plugin --profile web add link:…`，profile `bundles` 自动追加） |
| 2 | Host 能否注册 session 投影、Agent 工具、HTTP 路由？ | ✅ 是（真实宿主日志 + `/task-map/api/health` 返回全部 true） |
| 3 | Client 能否被 Web 壳加载，并注册 `main` / `sidebar.panellist` / `conversation.view`？ | ✅ 是（三个 slot 均出现在真实 DOM） |
| 4 | 第三方自定义投影 key 能否被 client 读取？ | ✅ 是（会话页签内读到 `taskMap`，`asOfSeq` 非空） |

---

## 2. 交付物

| 文件 | 说明 |
|---|---|
| `package.json` | `@local/dsh-task-map`，`dsh.bundle.patch` + `dsh.client{platform:web, immediately:true}` + `engines.dsh` |
| `cordis.patch.yml` | host 插件行 `insert: task-map` |
| `index.js` | Host：`taskMap` 投影（M0 空折叠，仅计事件）、`task_map_ping` / `task_map_record_relation` 工具、`/task-map/api/health` 路由 |
| `client.js` | Client：`main` 整页（健康面板）、`sidebar.panellist` 入口、`conversation.view` 会话页签（读投影占位） |
| `test/host-smoke.mjs` | stub ctx 调 `apply()`，断言注册、工具执行、投影折叠、健康路由 |
| `test/client-smoke.mjs` | 模拟 `__ModuleLoader__` + React + slots ctx，断言模块加载与三个 slot 注册 |
| `docs/m0-main-page.png` | 侧栏入口 + 整页健康面板（真实实例截图） |
| `docs/m0-conversation-view-tab.png` | 会话页签「对话 / 轨迹 / 任务地图」+ 投影读取（真实实例截图） |

## 3. 验证证据

### 3.1 本地 smoke

```text
[host-smoke] PASS
  ✓ session projection registered / key=taskMap / has apply()
  ✓ two agent tools registered / task_map_ping / task_map_record_relation
  ✓ health route registered /task-map/api/health
  ✓ ping returns ok+projection / relation records split
  ✓ projection fold counts events / health 200 ok

[client-smoke] PASS
  ✓ module registered via __ModuleLoader__, id=@local/dsh-task-map
  ✓ window marker + html marker m0
  ✓ main / sidebar.panellist / conversation.view 三个 slot 注册
  ✓ Page / SessionView 可渲染
```

### 3.2 真实隔离实例：Host

安装：

```bash
DSH_HOME=…/.dsh-lab dsh plugin --profile web add link:~/dsh-task-map
# → dependencies + profile dsh.profile.bundles 自动包含 @local/dsh-task-map
DSH_HOME=…/.dsh-lab dsh web --no-open --port 8088
```

宿主日志：

```text
[task-map] host applying (0.0.1-m0)
[task-map] projection "taskMap" registered
[task-map] tool "task_map_ping" registered
[task-map] tool "task_map_record_relation" registered
[task-map] route "/task-map/api/health" registered
dsh web: http://127.0.0.1:8088/?token=…
```

`GET /task-map/api/health`（实测 200）：

```json
{"ok":true,"plugin":"@local/dsh-task-map","version":"0.0.1-m0","mode":"m0",
 "projection":true,"projectionError":null,
 "tools":["task_map_ping","task_map_record_relation"],"toolErrors":[],
 "route":true,"routeError":null}
```

服务端注入的 Web 启动图（页面 HTML）中包含：

```text
plugins/??…@deepseek-ai/dsh-client-ui-trajectory/client.js,@local/dsh-task-map/client.js,…
```

说明 client bundle 被纳入 boot graph 并被 `/plugins` 提供。

### 3.3 真实隔离实例：Client（CDP 无头驱动）

- `window.__TASK_MAP_M0__ = { loaded:true, slots:['main','sidebar.panellist','conversation.view'], errors:[] }`
- `<html data-task-map-plugin="m0">`
- 侧栏全局面板出现 **「任务地图」** 入口（`aria-label="任务地图"`，`panelRow`）
- 点击后整页渲染 M0 健康面板：插件装载 / Host 健康路由 / 会话投影 / Agent 工具 / HTTP 路由 全部绿；原始 JSON 与上面一致
- 打开真实会话（`session-886d1772-…`）后，会话头部出现 **视图页签：对话 / 轨迹 / 任务地图**
- 点击「任务地图」页签后渲染占位视图：

```text
sessionId: session-886d1772-1e3c-4283-8703-58d74949bf8a
projection taskMap: 已读到投影值
projection value: { sessionId:"session-886d1772-…", asOfSeq:1620, tasks:[], relations:[], counters:{events:…} … }
```

- 整个会话页签验证过程无 console error / 未捕获异常。

## 4. 关键发现（更新原「未验证项」）

| 原未验证项 | M0 结论 |
|---|---|
| #1 第三方插件只注册 `conversation.view` slot 是否足够 | ✅ **足够**：真实会话页签正常出现并可切换；无需 M0 复刻 trajectory 的 `uiConversation.views.register` ViewMap 注册 |
| #2 `useProjection('taskMap')` 第三方自定义 key 是否可用 | ✅ **可用**：会话页签读到投影值（`asOfSeq=1620`），说明 host 投影注册 + tail page/控制流下发链路通 |
| #3 `ctx.sessionQuery` 权限 | 未测（M1 历史回放时验证） |
| #5 桌面运行中 CLI 安装 | 未测（本次用隔离 `dsh web`，不碰桌面 profile） |
| #6 HMR 回路 | 未测（本次为一次性启动；M1 验证改 client.js 热替换） |
| #11 自定义工具对模型可见性 | 未测（M0 只验证 host 注册；M1 发一次真实 prompt 验证 request header） |

**新发现（M1 必须处理）**：

1. **插件自注册 HTTP 路由不过 DSH 鉴权**：未带 token 的 `curl` 也能拿到 `200 + 健康信息`。M1 必须加 `Origin` / `Sec-Fetch-Site` 同源校验，并禁止生产环境暴露调试字段。
2. **hero（未选中会话）页曾出现一次 `SlotAssemblyError: scope 'session-maybe' rendered without an installed adapter`**；进入会话后 console errors 为空。疑似官方在 onboarding 页的组合问题（与 trajectory/plan 等包有关），M1 用「禁用本插件 A/B」确认归因。
3. `main` 整页是无会话上下文的（root 作用域），只能显示全局数据；会话内视图必须走 `conversation.view`（M0 已验证）。

## 5. 与 MVP 的差距（M1 起点）

- 投影还是空折叠（只计事件），未解析 `team/task` / `todo/write` / `job/*` / `approval/*`；
- 没有任务图/甘特/回放/详情组件（原型的 SVG 逻辑待移植）；
- `task_map_record_relation` 尚未校验 task id 是否真实存在（只记录工具参数，M4 补）；
- 没有全局页数据接口（P1）与 `task_map_query`（P2）；
- 没有设置项、没有导出、没有卸载脚本之外的清理逻辑。

## 6. 复现步骤（隔离）

```bash
# 1) 安装到隔离 home
LAB=~/.dsh-lab
DSH_HOME="$LAB" dsh plugin --profile web add link:~/dsh-task-map

# 2) 启动（打印带 token URL）
DSH_HOME="$LAB" dsh web --no-open --port 8088

# 3) 本地 smoke
node ~/dsh-task-map/test/host-smoke.mjs
node ~/dsh-task-map/test/client-smoke.mjs

# 4) 清理
# kill web 进程；删除 .dsh-lab（含复制的凭据/会话，一次性验证用）
```

> 本次验证用隔离 home 内**复制的真实凭据/会话**做 UI 驱动；验证后已停止实例并删除该目录，未改动 `~/.dsh` 与桌面 profile。
