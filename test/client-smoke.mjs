#!/usr/bin/env node
/**
 * M2 客户端冒烟测试：stub `__ModuleLoader__` + 伪 React，验证：
 *   1) 客户端模块可被 Web 壳加载，三个 slot 正常注册，无头标记就位；
 *   2) 会话页签主视图（框架 + 任务流程图）在「8 任务真实形状」mock 视图下可渲染、无异常；
 *   3) 任务图节点数量/状态/选中回调/依赖边/关系边/NEW 标记/未来置灰正确；
 *   4) 空态、投影缺失、投影异常 → 局部提示不崩页；详情/总览/回放控件 data 属性齐全；
 *   5) 纯逻辑测试（S 形布局/状态推导/二分查找/回放 store）随冒烟一起跑。
 *
 *   node test/client-smoke.mjs
 */
const failures = []
let passed = 0
const ok = (condition, label, detail = '') => {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
    return true
  }
  failures.push(label + (detail ? ` (${detail})` : ''))
  console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
  return false
}

// ---- stub 宿主环境（必须在 import client.js 之前） ----
const attrs = {}
const injectedStyles = []
let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  innerWidth: 1440,
  innerHeight: 900,
}
globalThis.document = {
  documentElement: { setAttribute: (key, value) => { attrs[key] = value }, dataset: {} },
  head: { append: (element) => { injectedStyles.push(element) } },
  getElementById: (id) => injectedStyles.find((element) => element.id === id) || null,
  createElement: () => ({ setAttribute: () => {}, style: {}, textContent: '', id: '' }),
  activeElement: null,
  addEventListener: () => {},
  removeEventListener: () => {},
}

await import('../client.js')
const { runLogicTests, buildLogicMockView } = await import('./client-logic.test.mjs')

// ---- 伪 React：hooks 返回初值（单次渲染），memo 透传 ----
function fakeReact() {
  const element = (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) })
  return {
    createElement: element,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    // 伪 React 无调度器：effect 同步执行一次（仅用于测试 marker/DOM 副作用路径不抛错）
    useEffect: (effect) => {
      try { effect() } catch (error) { throw error }
    },
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value === undefined ? null : value }),
    useCallback: (callback) => callback,
    memo: (component) => component,
  }
}

/** 把元素树里的函数组件递归求值（伪 React 无 reconciler，测试用）。 */
function expand(node) {
  if (Array.isArray(node)) return node.map(expand)
  if (node === null || node === undefined || typeof node !== 'object') return node
  if (typeof node.type === 'function') {
    const props = Object.assign({}, node.props || {})
    if (Array.isArray(node.children) && node.children.length > 0) {
      props.children = node.children.length === 1 ? node.children[0] : node.children
    }
    return expand(node.type(props))
  }
  const children = Array.isArray(node.children) ? node.children.map(expand) : []
  return { type: node.type, props: node.props || {}, children }
}

function walk(node, visit) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  if (typeof node !== 'object') return
  if (node.type !== undefined) visit(node)
  if (node.children) walk(node.children, visit)
}

function findAll(root, predicate) {
  const out = []
  walk(root, (node) => { if (predicate(node)) out.push(node) })
  return out
}

function findOne(root, predicate) {
  return findAll(root, predicate)[0] || null
}

const isNode = (node) => node.type === 'g' && Boolean(node.props['data-tm-node'])

/** 递归收集元素树里的所有字符串（伪 React 树里文本就是 children 中的字符串）。 */
function collectText(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) {
    for (const item of node) collectText(item, out)
    return out
  }
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (typeof node === 'object' && node.children) collectText(node.children, out)
  return out
}
const hasText = (root, text) => collectText(root).some((item) => item.includes(text))

// ==================================================================
console.log('[client-smoke] M2 客户端')
// ==================================================================
ok(captured !== null, 'module registered via __ModuleLoader__')
ok(captured && captured.id === '@local/dsh-task-map', 'module id matches package name', captured && captured.id)

const plugin = captured.factory((id) => {
  if (id === 'react') return fakeReact()
  throw new Error('unexpected require: ' + id)
})
const api = plugin.__test
ok(plugin && typeof plugin.apply === 'function', 'plugin exports apply()')
ok(Array.isArray(plugin.inject) && plugin.inject.includes('slots'), 'plugin injects slots')
ok(api && api.version === '1.1.3', 'client version marker = 1.1.3', api && api.version)

const registered = []
const injections = []
const ctx = {
  slots: {
    inject: (name, callback) => { injections.push(name); callback() },
    register: (options, component) => { registered.push({ options, component }); return () => {} },
  },
  effect: (fn) => { fn(); return () => {} },
}
plugin.apply(ctx)

// ---- 无头标记 ----
ok(window.__TASK_MAP_M0__ && window.__TASK_MAP_M0__.loaded === true, 'window.__TASK_MAP_M0__ 兼容标记')
ok(Array.isArray(window.__TASK_MAP_M0__.slots) && window.__TASK_MAP_M0__.slots.length === 3, 'M0 标记 slots = 3')
ok(window.__TASK_MAP_M2__ && window.__TASK_MAP_M2__.loaded === true, 'window.__TASK_MAP_M2__ loaded')
ok(window.__TASK_MAP_M2__.version === '1.1.3', '客户端版本标记 1.1.3', window.__TASK_MAP_M2__.version)
ok(Array.isArray(window.__TASK_MAP_M2__.errors), 'M2 errors 数组')
ok(attrs['data-task-map-plugin'] === 'm2', 'html marker data-task-map-plugin=m2', attrs['data-task-map-plugin'])
ok(attrs['data-task-map-client-version'] === '1.1.3', 'html marker client version', attrs['data-task-map-client-version'])
ok(injections.includes('main') && injections.includes('sidebar.panellist') && injections.includes('conversation.view'), 'slot injections requested', injections.join(','))
ok(registered.length === 3, '三个 slot 注册', String(registered.length))
const byName = Object.fromEntries(registered.map((entry) => [entry.options.name, entry]))
ok(byName.main && byName.main.options.key === 'task-map', 'main key = task-map')
ok(byName['sidebar.panellist'] && byName['sidebar.panellist'].options.id === 'task-map', 'sidebar id = task-map')
ok(byName['conversation.view'] && byName['conversation.view'].options.id === 'task-map', 'conversation.view id = task-map')
ok(byName['conversation.view'].options.order === 11, 'conversation.view order = 11')
ok(typeof byName['conversation.view'].component === 'function', 'conversation.view 组件是函数')

// ---- 全局页占位 ----
const pageTree = expand(byName.main.component({}))
ok(pageTree && pageTree.type === 'div' && pageTree.props['data-tm-page'] === 'main', '全局页渲染 div（P1 占位）')

// ==================================================================
console.log('\n[client-smoke] 会话视图渲染（8 任务 mock 视图）')
// ==================================================================
const mock = buildLogicMockView()
const view = mock.view
const prep = api.prepareView(view)
const errorsBefore = window.__TASK_MAP_M2__.errors.length

const sessionTree = expand(api.components.SessionViewInner({
  sessionId: view.sessionId,
  useProjection: () => view,
}))
ok(sessionTree && sessionTree.type === 'div' && sessionTree.props['data-tm-view'] === 'task-map', 'SessionView 渲染根节点 data-tm-view=task-map')
ok(sessionTree.props['data-tm-tasks'] === '8', '根节点 data-tm-tasks=8', sessionTree.props['data-tm-tasks'])
ok(sessionTree.props['data-tm-completed'] === '8', '根节点 data-tm-completed=8', sessionTree.props['data-tm-completed'])
ok(sessionTree.props['data-tm-in-progress'] === '0', '根节点 data-tm-in-progress=0', sessionTree.props['data-tm-in-progress'])
ok(sessionTree.props['data-tm-empty'] === 'false', '根节点 data-tm-empty=false')
ok(sessionTree.props['data-tm-projection'] === 'ready', '根节点 data-tm-projection=ready', sessionTree.props['data-tm-projection'])
ok(sessionTree.props['data-tm-selected'] === '', '根节点 data-tm-selected 初始为空')
ok(/^\d+$/.test(String(sessionTree.props['data-tm-current-time'])), '根节点 data-tm-current-time 为毫秒数', String(sessionTree.props['data-tm-current-time']))
ok(sessionTree.props['data-tm-playing'] === 'false', '根节点 data-tm-playing=false')
ok(sessionTree.props['data-tm-speed'] === '120', '根节点 data-tm-speed=120')
ok(sessionTree.props['data-tm-session'] === view.sessionId, '根节点 data-tm-session')
ok(String(sessionTree.props['data-tm-range-start']) === String(mock.base), '根节点 data-tm-range-start', String(sessionTree.props['data-tm-range-start']))
ok(String(sessionTree.props['data-tm-range-end']) === String(mock.base + 3600000), '根节点 data-tm-range-end', String(sessionTree.props['data-tm-range-end']))
ok(String(sessionTree.props['data-tm-duration']) === '3600000', '根节点 data-tm-duration = 会话时长', String(sessionTree.props['data-tm-duration']))
ok(String(sessionTree.props['data-tm-tail-ms']) === '0', 'mock 视图 data-tm-tail-ms=0（无收尾长尾）', String(sessionTree.props['data-tm-tail-ms']))
ok(sessionTree.props['data-tm-live'] === 'false', '历史会话 data-tm-live=false')
ok(hasText(sessionTree, '已回放'), '回放时钟带「已回放」标签（区分当前值/总时长）')
ok(hasText(sessionTree, 'Mock 飞书 SSO 开发会话'), '顶栏显示会话标题')
ok(hasText(sessionTree, '执行轨迹 · 任务流程图'), '流程图 panel 标题')
ok(hasText(sessionTree, '时间轴 · 任务 / 代理 / 事件 / 热度'), '时间轴 panel 标题')
ok(hasText(sessionTree, '回放总览'), '右侧总览渲染')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-overview']), '总览容器 data-tm-overview')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-panel'] === 'flow'), '流程图 panel 容器')
ok(findOne(sessionTree, (node) => node.props && String(node.props.className || '').includes('tm-flow-fit')), '≤3 行任务图自适应铺满（tm-flow-fit，避免节点被裁）')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-panel'] === 'gantt'), '甘特 panel 容器（data-tm-panel=gantt）')

// ---- 甘特时间轴（W2.3） ----
const ganttRows = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-task'])
ok(ganttRows.length === 8, '甘特任务行 = 8（data-tm-gantt-task）', String(ganttRows.length))
const ganttBars = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-bar'])
ok(ganttBars.length === 8, '甘特执行实段 8 条（data-tm-gantt-bar）', String(ganttBars.length))
const ganttWaits = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-wait'])
ok(ganttWaits.length === 8, '甘特排队虚段 8 条', String(ganttWaits.length))
const ganttDone = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-done'])
ok(ganttDone.length === 8, '甘特完成菱形 8 个', String(ganttDone.length))
const memberRows = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-member'])
ok(memberRows.length === 3, '甘特代理行 = 3', String(memberRows.length))
const memberPhaseBars = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-mem'])
ok(memberPhaseBars.length === 6, '代理阶段区间 6 段（3 代理 × 2 阶段）', String(memberPhaseBars.length))
const ganttEvents = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-ev'])
ok(ganttEvents.length === 5, '甘特事件行 5 个（审批/交付/代理启动）', String(ganttEvents.length))
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-gantt-idle']), '甘特会话前空闲带 data-tm-gantt-idle')
ok(hasText(sessionTree, '会话创建→开工'), '甘特空闲带文案（解释左侧空白）')
const densityNodes = findAll(sessionTree, (node) => node.props && node.props['data-tm-gantt-density'])
ok(densityNodes.length === prep.timeline.density.length && densityNodes.length >= 24, '甘特热度行分桶渲染', String(densityNodes.length))
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-playhead']), '播放头 data-tm-playhead')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-playhead-cap']), '播放头手柄 data-tm-playhead-cap')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-played']), '已回放区域 data-tm-played')
const scrubber = findOne(sessionTree, (node) => node.props && node.props['data-tm-scrubber'] === '1')
ok(scrubber && scrubber.props.min === String(prep.timeStart) && scrubber.props.max === String(prep.timeEnd), '进度条 min/max = 回放范围', scrubber && scrubber.props.min + '/' + scrubber.props.max)

// 回放中段渲染：未来任务不画实段/菱形（不剧透）
const midBase = mock.base + 100000
const midStore = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
midStore.setTime(midBase)
const midRef = { current: '' }
let ganttSelected = ''
const midGantt = expand(api.components.GanttPanel({
  prep,
  store: midStore,
  tips: api.createTooltipStore(),
  selectionRef: midRef,
  onSelect: (id) => { ganttSelected = id },
}))
const midFutureRow = findAll(midGantt, (node) => node.props && node.props['data-tm-gantt-task'] === 'task-8')[0]
const midFutureBar = findAll(midFutureRow || { children: [] }, (node) => node.props && node.props['data-tm-gantt-bar'] === 'task-8')[0]
ok(Boolean(midFutureBar) && Number(midFutureBar.props.width) === 0, '中段：未创建任务执行实段宽度 0（不剧透）', String(midFutureBar && midFutureBar.props.width))
const midStartedBar = findAll(midGantt, (node) => node.props && node.props['data-tm-gantt-bar'] === 'task-1')[0]
ok(Boolean(midStartedBar) && Number(midStartedBar.props.width) > 0, '中段：执行中任务实段有宽度', String(midStartedBar && midStartedBar.props.width))
const midGanttSvg = findOne(midGantt, (node) => node.props && typeof node.props.viewBox === 'string' && node.props.onClick)
ok(Boolean(midGanttSvg), '甘特 svg 有交互 onClick')
midGanttSvg.props.onClick({ target: { closest: (selector) => (selector === '[data-tm-gantt-task]' ? { getAttribute: () => 'task-3' } : null) } })
ok(ganttSelected === 'task-3', '点击甘特任务条 → 选中 task-3', ganttSelected)
ok(hasText(midGantt, '历史/收尾') === false && hasText(midGantt, '未来事件置灰'), '甘特底部提示（无收尾尾巴时）')

// 任务图节点（通过递归求值 FlowNode 得到真实 <g>）
const flowNodes = findAll(sessionTree, isNode)
ok(flowNodes.length === view.tasks.length, '任务图节点数量 = 8', String(flowNodes.length))
ok(findOne(sessionTree, (node) => node.props && String(node.props['data-tm-edge-dep'] || '').includes('->')), '依赖边 data-tm-edge-dep 存在')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-edge-rel']), '关系分叉边 data-tm-edge-rel 存在')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-route']), '执行轨迹 data-tm-route 存在')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-trail']), '轨迹头 data-tm-trail 存在')
const depEdges = findAll(sessionTree, (node) => node.props && node.props['data-tm-edge-dep'])
ok(depEdges.length === 6, '依赖边数量 = 6', String(depEdges.length))
const relEdges = findAll(sessionTree, (node) => node.props && node.props['data-tm-edge-rel'])
ok(relEdges.length === 1, '关系边数量 = 1', String(relEdges.length))
ok(collectText(sessionTree).filter((item) => item === 'NEW').length === 1, 'NEW 标记只出现在 changes.added 任务上')
ok(hasText(sessionTree, 'T7a 验收预检与验收报告骨架'), '任务节点渲染 subject')

// 回放控件 data 属性
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-play']), '播放按钮 data-tm-play')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-scrubber']), '进度条 data-tm-scrubber')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-speed']), '倍速控件 data-tm-speed')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-jump-start']), '跳到开始 data-tm-jump-start')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-jump-end']), '跳到结束 data-tm-jump-end')
const chips = findAll(sessionTree, (node) => node.props && node.props['data-tm-stat'])
ok(chips.length >= 4, '统计 chips 至少 4 个 data-tm-stat', String(chips.length))
ok(window.__TASK_MAP_M2__.view === view, 'window.__TASK_MAP_M2__.view 引用最近一次 view')

// ==================================================================
console.log('\n[client-smoke] 任务图交互（选中/悬停/时间推导）')
// ==================================================================
const store = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
const tips = api.createTooltipStore()
const selectionRef = { current: '' }
let selected = ''
const onSelect = (id) => { selected = id }

function renderFlow(moment, selectedId) {
  store.setTime(moment)
  selectionRef.current = selectedId || ''
  return expand(api.components.TaskFlow({ prep, store, tips, selectionRef, onSelect }))
}

const flowTree = renderFlow(prep.timeEnd, '')
const nodes = findAll(flowTree, isNode)
ok(nodes.length === 8, 'TaskFlow 渲染 8 个节点', String(nodes.length))
const nodeById = Object.fromEntries(nodes.map((node) => [node.props['data-tm-node'], node]))
ok(Boolean(nodeById['task-7']) && Boolean(nodeById['task-8']), '节点 id data-tm-node 正确')
ok(nodeById['task-1'].props['data-tm-task-id'] === 'task-1', '节点 data-tm-task-id')
ok(nodeById['task-1'].props['data-tm-task-status'] === 'completed', '终点时刻节点状态 completed', nodeById['task-1'].props['data-tm-task-status'])
ok(/tm-node/.test(nodeById['task-1'].props.className) && /tm-done/.test(nodeById['task-1'].props.className), '完成节点 class 含 tm-done', nodeById['task-1'].props.className)

// 点击回调
const clickTarget = nodeById['task-7']
ok(typeof clickTarget.props.onClick === 'function', '节点有 onClick')
clickTarget.props.onClick()
ok(selected === 'task-7', '点击节点回调 onSelect(task-7)', selected)

// hover tooltip
nodeById['task-3'].props.onMouseEnter({ clientX: 320, clientY: 240 })
const tipSnapshot = tips.get()
ok(tipSnapshot.visible === true, 'hover 节点显示 tooltip')
ok(tipSnapshot.payload && tipSnapshot.payload.kind === 'task' && tipSnapshot.payload.taskId === 'task-3', 'tooltip payload 指向 task-3')
nodeById['task-3'].props.onMouseLeave()
ok(tips.get().visible === false, '离开节点隐藏 tooltip')

// 选中态：选中任务在渲染中带 tm-sel
const selectedTree = renderFlow(prep.timeEnd, 'task-4')
const selectedNode = findAll(selectedTree, isNode).find((node) => node.props['data-tm-node'] === 'task-4')
ok(/tm-sel/.test(selectedNode.props.className), '选中节点 class 含 tm-sel', selectedNode.props.className)

// 回放时刻状态推导：t 与节点状态一致（未来任务置灰且 future class）
const midTime = mock.base + 100000
const midTree = renderFlow(midTime, '')
const midNodes = findAll(midTree, isNode)
let mismatch = ''
for (const node of midNodes) {
  const id = node.props['data-tm-node']
  const expected = api.utils.statusAtTime(prep.taskById[id], midTime)
  const actual = node.props['data-tm-task-status']
  if (expected !== actual) mismatch = id + ': expected ' + expected + ' got ' + actual
}
ok(mismatch === '', '回放中段：每个节点状态与 statusAtTime 一致', mismatch)
const midById = Object.fromEntries(midNodes.map((node) => [node.props['data-tm-node'], node]))
ok(midById['task-1'].props['data-tm-task-status'] === 'in_progress', '中段 task-1 执行中')
ok(midById['task-6'].props['data-tm-task-status'] === 'pending', '中段 task-6 待开始')
ok(midById['task-7'].props['data-tm-task-status'] === 'blocked', '中段 task-7 阻塞中')
ok(/tm-future/.test(midById['task-8'].props.className), '中段 task-8 未创建 → tm-future 置灰', midById['task-8'].props.className)
ok(hasText(midTree, '未创建'), '未来任务显示「未创建」')
ok(hasText(midTree, '已跑'), '执行中任务显示「已跑 X」')

// ==================================================================
console.log('\n[client-smoke] 侧栏 / 空态 / 错误态 / 回放控件')
// ==================================================================
store.setTime(prep.timeEnd)
const overviewTree = expand(api.components.SidePanel({ prep, store, selectedId: '', onSelect, onClear: () => {} }))
ok(findOne(overviewTree, (node) => node.props && node.props['data-tm-overview']), '无选中 → 总览 data-tm-overview')
ok(hasText(overviewTree, '任务完成度 · 回放时刻'), '总览显示回放时刻完成度')
ok(hasText(overviewTree, '等待时间拆解'), '总览显示等待拆解')
ok(hasText(overviewTree, '会话前空闲') && hasText(overviewTree, '依赖阻塞') && hasText(overviewTree, '等待代理'), '总览等待拆解覆盖 会话前空闲/依赖阻塞/等待代理')
ok(hasText(overviewTree, '计划基线 7 个任务'), '总览显示计划基线条数与封板时刻')
const changesList = findOne(overviewTree, (node) => node.props && node.props['data-tm-changes'])
ok(changesList !== null, '总览变更列表容器 data-tm-changes')
ok(changesList && changesList.props['data-tm-changes-visible'] === '3', '终点时刻 data-tm-changes-visible=3', changesList && changesList.props['data-tm-changes-visible'])
ok(changesList && changesList.props['data-tm-baseline-count'] === '7', 'data-tm-baseline-count=7')
ok(changesList && changesList.props['data-tm-added-count'] === '1', 'data-tm-added-count=1')
const changeEntries = findAll(overviewTree, (node) => node.props && node.props['data-tm-change'])
ok(changeEntries.length === 3, '变更记录 3 条（依赖变更/拆分/新增）', String(changeEntries.length))
ok(changeEntries.map((node) => node.props['data-tm-change-kind']).join(',') === 'dependency,split,added', '变更记录按 at/seq 排序', changeEntries.map((node) => node.props['data-tm-change-kind']).join(','))
ok(changeEntries.every((node) => node.props['data-tm-change-at'] && node.props['data-tm-change-jump']), '变更记录带 at/jump data 属性')
ok(changeEntries.some((node) => String(node.props['data-tm-change-task']) === 'task-4'), '拆分条目关联 task-4')
ok(hasText(overviewTree, '拆分 task-4 → task-8') && hasText(overviewTree, '依赖变更 task-7') && hasText(overviewTree, '新增任务 T7a'), '变更记录文案（拆分/依赖变更/新增）')
ok(hasText(overviewTree, '活跃代理 · 回放时刻'), '总览显示活跃代理')

const detailTree = expand(api.components.SidePanel({ prep, store, selectedId: 'task-7', onSelect, onClear: () => {} }))
const detailContainer = findOne(detailTree, (node) => node.props && node.props['data-tm-detail'])
ok(detailContainer && detailContainer.props['data-tm-detail'] === 'task-7', '选中 → 详情容器 data-tm-detail=task-7')
ok(hasText(detailTree, 'T7 全链路验收：跑测试/静态检查/对照契约审查'), '详情显示任务标题')
ok(hasText(detailTree, '依赖（blockedBy）'), '详情显示依赖')
ok(hasText(detailTree, '写入范围'), '详情显示写入范围')
ok(findOne(detailTree, (node) => node.props && node.props['data-tm-jump-start']), '详情「跳到开始」按钮')
ok(findOne(detailTree, (node) => node.props && node.props['data-tm-jump-end']), '详情「跳到完成」按钮')

const replayTree = expand(api.components.ReplayControls({ store, prep }))
ok(findOne(replayTree, (node) => node.props && node.props['data-tm-play']), 'ReplayControls 播放按钮')
ok(findOne(replayTree, (node) => node.props && String(node.props['data-tm-speed'] || '').match(/^(60|120|300|600)$/)), 'ReplayControls 倍速 data-tm-speed')
const playingButton = findOne(replayTree, (node) => node.props && node.props['data-tm-play'])
ok(playingButton.props['data-tm-playing'] === 'false', '播放按钮 data-tm-playing=false')

// ==================================================================
console.log('\n[client-smoke] 变更流 UI（W3.2）：跳转/计划 Ghost/NEW 时刻/拆分/预览注入')
// ==================================================================
// 变更条目点击：回放时钟 = entry.at，并选中相关任务
const changeStore = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
const jumpSpy = { selected: '' }
const jumpOverview = expand(api.components.Overview({
  prep,
  store: changeStore,
  onSelect: (id) => { jumpSpy.selected = id },
}))
const jumpEntries = findAll(jumpOverview, (node) => node.props && node.props['data-tm-change'])
const splitEntry = jumpEntries.find((node) => node.props['data-tm-change-kind'] === 'split')
ok(Boolean(splitEntry), '变更列表包含拆分条目')
splitEntry.props.onClick()
ok(changeStore.getTime() === Number(splitEntry.props['data-tm-change-at']), '点击拆分变更 → currentTime = entry.at', String(changeStore.getTime()))
ok(jumpSpy.selected === 'task-4', '点击拆分变更 → 选中父任务 task-4', jumpSpy.selected)

// 任务图：计划 Ghost + NEW 出现时刻
const midStore2 = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
midStore2.setTime(mock.base + 100000)
const midFlowTree = expand(api.components.TaskFlow({
  prep,
  store: midStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const midNode8 = findAll(midFlowTree, isNode).find((node) => node.props['data-tm-node'] === 'task-8')
ok(midNode8 && midNode8.props['data-tm-planned'] === 'true', '回放早期 task-8 节点 data-tm-planned=true（Ghost）', midNode8 && midNode8.props['data-tm-planned'])
ok(midNode8 && midNode8.props['data-tm-new'] === 'false', '回放早期 task-8 节点 data-tm-new=false（NEW 未出现）')
ok(midNode8 && collectText(midNode8).some((text) => text.includes('计划·未创建')), '回放早期节点显示「计划·未创建」')
ok(midNode8 && String(midNode8.props.className).includes('tm-future'), '回放早期节点保留 tm-future（虚线 Ghost 样式）')
const endStore2 = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
const endFlowTree = expand(api.components.TaskFlow({
  prep,
  store: endStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const endNode8 = findAll(endFlowTree, isNode).find((node) => node.props['data-tm-node'] === 'task-8')
ok(endNode8 && endNode8.props['data-tm-planned'] === 'false', '终点 task-8 不再是计划 Ghost')
ok(endNode8 && endNode8.props['data-tm-new'] === 'true', '终点 task-8 data-tm-new=true（NEW 已出现）')
const beforeNew = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
beforeNew.setTime(mock.base + 609999)
const beforeTree = expand(api.components.TaskFlow({ prep, store: beforeNew, tips: api.createTooltipStore(), selectionRef: { current: '' }, onSelect: () => {} }))
const beforeNode8 = findAll(beforeTree, isNode).find((node) => node.props['data-tm-node'] === 'task-8')
ok(beforeNode8.props['data-tm-new'] === 'false' && beforeNode8.props['data-tm-planned'] === 'true', 'NEW 出现前一毫秒：new=false / planned=true')

// 甘特：计划行 Ghost 样式 + 「〔计划〕」标签
const midGantt2 = expand(api.components.GanttPanel({
  prep,
  store: midStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const midGanttRow8 = findAll(midGantt2, (node) => node.props && node.props['data-tm-gantt-task'] === 'task-8')[0]
ok(midGanttRow8 && midGanttRow8.props['data-tm-planned'] === 'true', '甘特计划任务行 data-tm-planned=true')
ok(hasText(midGantt2, '〔计划〕'), '甘特计划任务标签带「〔计划〕」前缀')
const endGanttRow8 = findAll(expand(api.components.GanttPanel({ prep, store: endStore2, tips: api.createTooltipStore(), selectionRef: { current: '' }, onSelect: () => {} })), (node) => node.props && node.props['data-tm-gantt-task'] === 'task-8')[0]
ok(endGanttRow8 && endGanttRow8.props['data-tm-planned'] === 'false', '甘特终点任务行不再 planned')

// 详情：任务变更历史
const task8Detail = expand(api.components.TaskDetail({
  task: prep.taskById['task-8'],
  prep,
  store: endStore2,
  onClear: () => {},
  onSelect: () => {},
}))
ok(hasText(task8Detail, '变更历史'), '详情显示该任务变更历史')
ok(hasText(task8Detail, '拆分 task-4 → task-8') && hasText(task8Detail, '新增任务 T7a'), '详情变更历史含「被拆分 + 新增」')
const degradedPrep = api.prepareView(Object.assign({}, mock.view, {
  spansTruncated: true,
  spanSummary: { total: 900, kept: 120, omitted: 780, tool: 800, job: 90, approval: 10, open: 2, error: 3, killed: 0 },
  viewLevel: { description: 160, spans: 120 },
}))
const degradedDetail = expand(api.components.TaskDetail({
  task: degradedPrep.taskById['task-8'],
  prep: degradedPrep,
  store: endStore2,
  onClear: () => {},
  onSelect: () => {},
}))
ok(hasText(degradedDetail, '明细已截断'), '降级视图下执行过程显示「明细已截断」而不是误报未标记')
ok(hasText(degradedDetail, '描述已截断至 160 字符') || hasText(degradedDetail, '大会话下降级'), '降级视图下描述截断有提示')
const task8DetailMid = expand(api.components.TaskDetail({
  task: prep.taskById['task-8'],
  prep,
  store: midStore2,
  onClear: () => {},
  onSelect: () => {},
}))
ok(!hasText(task8DetailMid, '变更历史'), '回放早期详情不显示未来变更历史')
const task7Detail = expand(api.components.TaskDetail({
  task: prep.taskById['task-7'],
  prep,
  store: endStore2,
  onClear: () => {},
  onSelect: () => {},
}))
ok(hasText(task7Detail, '依赖变更 task-7'), '被改依赖任务详情显示依赖变更历史')

// 预览注入（E2E 合成 view）：仅当前页面内存
ok(window.__TASK_MAP_M2__.preview && typeof window.__TASK_MAP_M2__.preview.setView === 'function', 'window.__TASK_MAP_M2__.preview.setView 存在')
ok(typeof window.__TASK_MAP_M2__.actions.setCurrentTime === 'function', 'actions.setCurrentTime 存在')
const previewMock = Object.assign({}, mock.view, { sessionId: 'session-preview', title: '预览会话（合成）' })
window.__TASK_MAP_M2__.preview.setView(previewMock)
ok(window.__TASK_MAP_M2__.preview.active() === true, 'preview.active() = true')
const previewTree = expand(api.components.SessionViewInner({ sessionId: 'session-preview', useProjection: () => null }))
ok(previewTree.props['data-tm-preview'] === 'true', '预览模式根节点 data-tm-preview=true')
ok(previewTree.props['data-tm-tasks'] === '8' && previewTree.props['data-tm-projection'] === 'ready', '预览模式渲染 mock view（8 任务/ready）')
window.__TASK_MAP_M2__.preview.reset()
ok(window.__TASK_MAP_M2__.preview.active() === false, 'preview.reset() 恢复真实投影')
const afterResetTree = expand(api.components.SessionViewInner({ sessionId: 'session-preview', useProjection: () => null }))
ok(afterResetTree.props['data-tm-preview'] === 'false' && afterResetTree.props['data-tm-projection'] === 'pending', 'reset 后回到真实投影（pending）')

// ==================================================================
console.log('\n[client-smoke] W4.3 关系层：支线徽标/父子跳转/父任务只提示/无效关系/高亮')
// ==================================================================
ok(sessionTree.props['data-tm-state-version'] === '4', '根节点 data-tm-state-version=4')

// 任务图：父节点「支线 N」徽标 + 子节点「支线 of task-X」
const relationFlow = expand(api.components.TaskFlow({
  prep,
  store: endStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const relationNodes = findAll(relationFlow, isNode)
const parentNode = relationNodes.find((node) => node.props['data-tm-node'] === 'task-4')
const childNode = relationNodes.find((node) => node.props['data-tm-node'] === 'task-8')
const badgeNode = findOne(parentNode, (node) => node.props && node.props['data-tm-relation-badge'])
ok(Boolean(badgeNode), '父节点渲染支线徽标 [data-tm-relation-badge]')
ok(badgeNode && badgeNode.props['data-tm-relation-count'] === '1', '徽标 data-tm-relation-count=1')
ok(collectText(parentNode).some((text) => text.includes('支线 1')), '父节点显示「支线 1」文案')
ok(childNode.props['data-tm-child-of'] === 'task-4', '子节点 [data-tm-task-id][data-tm-child-of]=task-4')
ok(collectText(childNode).some((text) => text.includes('支线 of task-4')), '子节点显示「支线 of task-4」小字')

// 甘特：父行徽标属性 + 子行 child-of + 标签前缀
const relationGantt = expand(api.components.GanttPanel({
  prep,
  store: endStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const ganttParentRow = findAll(relationGantt, (node) => node.props && node.props['data-tm-gantt-task'] === 'task-4')[0]
const ganttChildRow = findAll(relationGantt, (node) => node.props && node.props['data-tm-gantt-task'] === 'task-8')[0]
const ganttParentLabel = findOne(ganttParentRow, (node) => node.props && node.props['data-tm-gantt-label'])
ok(ganttParentLabel && ganttParentLabel.props['data-tm-relation-badge'] === '1', '甘特父行标签 data-tm-relation-badge=1')
ok(ganttParentLabel && ganttParentLabel.props['data-tm-relation-count'] === '1', '甘特父行 data-tm-relation-count=1')
ok(ganttChildRow.props['data-tm-child-of'] === 'task-4', '甘特子行 data-tm-child-of=task-4')
ok(hasText(relationGantt, '支线1') && hasText(relationGantt, '↳task-4'), '甘特标签带「支线1」/「↳task-4」前缀')

// 详情：父任务支线列表 + note + 子任务点击跳转
const parentDetailStore = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
let relationSelected = ''
const parentDetail = expand(api.components.TaskDetail({
  task: prep.taskById['task-4'],
  prep,
  store: parentDetailStore,
  onClear: () => {},
  onSelect: (id) => { relationSelected = id },
}))
ok(hasText(parentDetail, '支线（1）'), '父任务详情显示「支线（1）」')
ok(hasText(parentDetail, '把 T4 拆成数据导入与员工导入 UI 两条支线'), '父任务详情显示 relation.note')
const relationChildBtn = findOne(parentDetail, (node) => node.props && node.props['data-tm-relation-child'] === 'task-8')
ok(Boolean(relationChildBtn), '父任务详情子任务行 data-tm-relation-child=task-8')
relationChildBtn.props.onClick()
ok(relationSelected === 'task-8', '点击支线子任务 → 选中 task-8', relationSelected)
ok(!findOne(parentDetail, (node) => node.props && node.props['data-tm-relation-alert']), '子任务已完成（终点）→ 不显示父任务未完成提示')

// 父任务已完成但子任务未完成 → 只提示、不改状态
const alertStore = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
alertStore.setTime(mock.base + 710000) // task-4 completed@600000；task-8 completed@800000
const parentAlertDetail = expand(api.components.TaskDetail({
  task: prep.taskById['task-4'],
  prep,
  store: alertStore,
  onClear: () => {},
  onSelect: () => {},
}))
const relationAlert = findOne(parentAlertDetail, (node) => node.props && node.props['data-tm-relation-alert'])
ok(relationAlert && relationAlert.props['data-tm-relation-alert'] === 'true', '父任务完成 + 子任务未完成 → data-tm-relation-alert=true')
ok(hasText(parentAlertDetail, '父任务已完成，1 个子任务未完成（仅提示，不改任务状态）'), '提示文案仅提示不改状态')
ok(prep.taskById['task-8'].status === 'completed' && prep.taskById['task-4'].status === 'completed', '渲染提示后任务状态未被修改（只读派生）')

// 详情：子任务显示归属并可跳父任务
const childDetail = expand(api.components.TaskDetail({
  task: prep.taskById['task-8'],
  prep,
  store: parentDetailStore,
  onClear: () => {},
  onSelect: (id) => { relationSelected = id },
}))
ok(hasText(childDetail, '属于 task-4 的支线'), '子任务详情显示「属于 task-4 的支线」')
relationSelected = ''
const parentJumpBtn = findOne(childDetail, (node) => node.props && node.props['data-tm-relation-parent'] === 'task-4')
ok(Boolean(parentJumpBtn), '子任务详情父任务跳转按钮 data-tm-relation-parent=task-4')
parentJumpBtn.props.onClick()
ok(relationSelected === 'task-4', '点击「属于 task-4 的支线」→ 选中父任务 task-4', relationSelected)

// 无效关系：局部提示（Overview + 详情）
const invalidView = {
  schema: 'task-map/view', stateVersion: 3, sessionId: 'session-invalid-rel', title: '无效关系示例',
  tasks: [
    { id: 'task-1', subject: '父任务 A', status: 'completed', owner: 'Lead', createdAt: mock.base + 1000, startedAt: mock.base + 2000, completedAt: mock.base + 3000, phases: [{ status: 'pending', at: mock.base + 1000 }, { status: 'completed', at: mock.base + 3000 }], startRank: 1, doneRank: 1, writeScopes: [], blockedBy: [] },
    { id: 'task-2', subject: '子任务 B', status: 'in_progress', owner: 'qa-verifier', createdAt: mock.base + 1500, startedAt: mock.base + 4000, completedAt: null, phases: [{ status: 'pending', at: mock.base + 1500 }, { status: 'in_progress', at: mock.base + 4000 }], startRank: 2, doneRank: null, writeScopes: [], blockedBy: [] },
  ],
  taskStats: { total: 2, pending: 0, in_progress: 1, completed: 1, failed: 0, blocked: 0, other: 0 },
  relations: [
    { parent: 'task-1', children: ['task-2'], kind: 'split', note: '有效拆分', recordedAt: mock.base + 5000, seq: 10, source: 'tool', valid: true },
    { parent: 'task-1', children: ['task-404'], kind: 'split', note: '坏引用', recordedAt: mock.base + 6000, seq: 11, source: 'tool', valid: false },
  ],
  changes: {
    added: [], removed: [], dependencyChanged: [],
    splits: [{ parent: 'task-1', children: ['task-2'], kind: 'split', note: '有效拆分', at: mock.base + 5000, seq: 10, valid: true }],
    invalidRelations: [{ parent: 'task-1', children: ['task-404'], kind: 'split', note: '坏引用', at: mock.base + 6000, seq: 11, missing: ['task-404'] }],
    counts: { planned: 2, added: 0, removed: 0, dependencyChanged: 0, splits: 1, invalidRelations: 1 },
    log: [{ at: mock.base + 5000, seq: 10, kind: 'split', taskId: 'task-1', text: '拆分 task-1 → task-2', children: ['task-2'] }],
  },
  warnings: [{ code: 'relation-child-missing', taskId: 'task-404' }],
  timeRange: { start: mock.base, end: mock.base + 10000 },
  asOfTime: mock.base + 10000,
  turns: [{ turn: 1, start: mock.base, end: mock.base + 9000 }],
}
const invalidPrep = api.prepareView(invalidView)
const invalidStore = api.createReplayStore({ start: invalidPrep.timeStart, end: invalidPrep.timeEnd })
const invalidOverview = expand(api.components.Overview({ prep: invalidPrep, store: invalidStore, onSelect: () => {} }))
const invalidNote = findOne(invalidOverview, (node) => node.props && node.props['data-tm-relation-invalid'])
ok(Boolean(invalidNote), '总览显示无效关系局部提示 data-tm-relation-invalid')
ok(invalidNote && invalidNote.props['data-tm-invalid-relations'] === '1', 'data-tm-invalid-relations=1（无效关系单列）', invalidNote && invalidNote.props['data-tm-invalid-relations'])
ok(hasText(invalidOverview, 'task-404'), '无效关系提示包含缺失任务 id')
ok(hasText(invalidOverview, '不计入拆分变更'), '无效关系文案注明不计入拆分变更')
const invalidSessionTree = expand(api.components.SessionViewInner({ sessionId: 'session-invalid-rel', useProjection: () => invalidView }))
ok(invalidSessionTree.props['data-tm-invalid-relations'] === '1', '根节点 data-tm-invalid-relations=1（无效关系单列）')
const invalidSplitChips = api.utils.asOfChangeCounts(invalidPrep, mock.base + 9000)
ok(invalidSplitChips.splits === 1, '拆分计数只统计有效拆分（1），不含无效关系', String(invalidSplitChips.splits))
const invalidParentDetail = expand(api.components.TaskDetail({
  task: invalidPrep.taskById['task-1'],
  prep: invalidPrep,
  store: invalidStore,
  onClear: () => {},
  onSelect: () => {},
}))
ok(hasText(invalidParentDetail, '支线（1）'), '无效关系不计入支线数量（仍显示有效子任务 1 个）')
ok(findOne(invalidParentDetail, (node) => node.props && node.props['data-tm-relation-invalid']), '父任务详情显示无效关系提示')

// 变更记录拆分点击：选中父任务 + 高亮子节点
let highlightedChildren = null
const highlightOverview = expand(api.components.Overview({
  prep,
  store: (() => { const s = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd }); s.setTime(prep.timeEnd); return s })(),
  onSelect: () => {},
  onHighlightChildren: (children) => { highlightedChildren = children },
}))
const splitChangeEntry = findAll(highlightOverview, (node) => node.props && node.props['data-tm-change']).find((node) => node.props['data-tm-change-kind'] === 'split')
splitChangeEntry.props.onClick()
ok(Array.isArray(highlightedChildren) && highlightedChildren.join(',') === 'task-8', '点击拆分变更 → 高亮子节点 task-8', String(highlightedChildren))
const highlightFlow = expand(api.components.TaskFlow({
  prep,
  store: endStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: ['task-8'] } },
  onSelect: () => {},
}))
const highlightedNode = findAll(highlightFlow, isNode).find((node) => node.props['data-tm-node'] === 'task-8')
ok(highlightedNode.props['data-tm-child-highlight'] === 'true', '高亮子节点 data-tm-child-highlight=true')
ok(String(highlightedNode.props.className).includes('tm-child-hl'), '高亮子节点 class 含 tm-child-hl')
const highlightGantt = expand(api.components.GanttPanel({
  prep,
  store: endStore2,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: ['task-8'] } },
  onSelect: () => {},
}))
const highlightedRow = findAll(highlightGantt, (node) => node.props && node.props['data-tm-gantt-task'] === 'task-8')[0]
ok(highlightedRow.props['data-tm-child-highlight'] === 'true', '甘特高亮子行 data-tm-child-highlight=true')

// ==================================================================
console.log('\n[client-smoke] v1.1.3 单图模式：flow/gantt/restore+both、折叠保留 DOM、aria、状态不丢')
// ==================================================================
ok(sessionTree.props['data-tm-layout-mode'] === 'both', '默认布局 data-tm-layout-mode=both')
const bothFlowPanel = findOne(sessionTree, (node) => node.props && node.props['data-tm-panel'] === 'flow')
const bothGanttPanel = findOne(sessionTree, (node) => node.props && node.props['data-tm-panel'] === 'gantt')
ok(bothFlowPanel && bothFlowPanel.props['data-tm-panel-collapsed'] === 'false', 'both：流程图面板未折叠')
ok(bothGanttPanel && bothGanttPanel.props['data-tm-panel-collapsed'] === 'false', 'both：甘特面板未折叠')
const maximizeFlowBtn = findOne(bothFlowPanel, (node) => node.props && node.props['data-tm-panel-action'] === 'maximize-flow')
const maximizeGanttBtn = findOne(bothGanttPanel, (node) => node.props && node.props['data-tm-panel-action'] === 'maximize-gantt')
ok(Boolean(maximizeFlowBtn) && maximizeFlowBtn.props['aria-label'] === '放大流程图（单图模式）', 'both：流程图面板有「放大流程图」按钮 + aria-label')
ok(Boolean(maximizeGanttBtn) && maximizeGanttBtn.props['aria-label'] === '放大甘特图（单图模式）', 'both：甘特面板有「放大甘特图」按钮 + aria-label')
ok(maximizeFlowBtn && maximizeFlowBtn.props['aria-pressed'] === 'false', '放大按钮 aria-pressed=false（未处于单图模式）')
ok(findOne(sessionTree, (node) => node.props && node.props['data-tm-panel-action'] === 'restore-both') === null, 'both 模式无「恢复双栏」按钮')
ok(maximizeFlowBtn && maximizeFlowBtn.type === 'button' && typeof maximizeFlowBtn.props.onClick === 'function', '放大按钮为原生 button 且有点击处理')

// flow 模式：流程图展开、甘特折叠为标题栏（内容 DOM 保留）
let lastLayoutAction = ''
const layoutFlowTree = expand(api.components.TaskFlow({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: [] } },
  layoutMode: 'flow',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutFlowPanel = findOne(layoutFlowTree, (node) => node.props && node.props['data-tm-panel'] === 'flow')
ok(layoutFlowPanel && layoutFlowPanel.props['data-tm-panel-collapsed'] === 'false', 'flow 模式：流程图面板展开')
const layoutFlowRestore = findOne(layoutFlowPanel, (node) => node.props && node.props['data-tm-panel-action'] === 'restore-both')
ok(Boolean(layoutFlowRestore) && layoutFlowRestore.props['aria-pressed'] === 'true', 'flow 模式：流程图显示「恢复双栏」且 aria-pressed=true')
ok(hasText(layoutFlowTree, '恢复双栏'), 'flow 模式：按钮文案「恢复双栏」')
const layoutFlowCheckboxes = findAll(layoutFlowTree, (node) => node.type === 'input' && node.props.type === 'checkbox')
ok(layoutFlowCheckboxes.length === 2, 'flow 模式：图例开关仍在（DOM 未卸载）')
const layoutCollapsedGanttTree = expand(api.components.GanttPanel({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  layoutMode: 'flow',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutCollapsedGantt = findOne(layoutCollapsedGanttTree, (node) => node.props && node.props['data-tm-panel'] === 'gantt')
ok(layoutCollapsedGantt && layoutCollapsedGantt.props['data-tm-panel-collapsed'] === 'true', 'flow 模式：甘特面板 data-tm-panel-collapsed=true')
ok(Boolean(findOne(layoutCollapsedGantt, (node) => node.props && node.props['data-tm-panel-action'] === 'restore-both')), 'flow 模式：折叠甘特标题栏保留「恢复双栏」')
ok(Boolean(findOne(layoutCollapsedGantt, (node) => node.props && node.props['data-tm-gantt'])), 'flow 模式：甘特面板仍存在（未卸载）')
ok(findAll(layoutCollapsedGantt, (node) => node.props && node.props['data-tm-gantt-task']).length === 8, 'flow 模式：甘特任务行 DOM 仍保留（CSS 隐藏而非卸载）')

// gantt 模式：对称
const layoutGanttModeFlowTree = expand(api.components.TaskFlow({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: [] } },
  layoutMode: 'gantt',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutCollapsedFlow = findOne(layoutGanttModeFlowTree, (node) => node.props && node.props['data-tm-panel'] === 'flow')
ok(layoutCollapsedFlow && layoutCollapsedFlow.props['data-tm-panel-collapsed'] === 'true', 'gantt 模式：流程图面板折叠')
ok(findAll(layoutCollapsedFlow, isNode).length === 8, 'gantt 模式：流程图节点 DOM 仍保留（未卸载）')
const layoutGanttModeGanttTree = expand(api.components.GanttPanel({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  layoutMode: 'gantt',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutExpandedGantt = findOne(layoutGanttModeGanttTree, (node) => node.props && node.props['data-tm-panel'] === 'gantt')
ok(layoutExpandedGantt && layoutExpandedGantt.props['data-tm-panel-collapsed'] === 'false', 'gantt 模式：甘特面板展开')
ok(Boolean(findOne(layoutExpandedGantt, (node) => node.props && node.props['data-tm-panel-action'] === 'restore-both')), 'gantt 模式：甘特显示「恢复双栏」')

// 点击动作映射 + 键盘（用带 spy 的独立渲染验证 onLayoutMode 取值）
lastLayoutAction = ''
const layoutBothFlowTree = expand(api.components.TaskFlow({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: [] } },
  layoutMode: 'both',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutBothFlowBtn = findOne(layoutBothFlowTree, (node) => node.props && node.props['data-tm-panel-action'] === 'maximize-flow')
layoutBothFlowBtn.props.onClick({ stopPropagation: () => {} })
ok(lastLayoutAction === 'flow', '点击「放大流程图」→ onLayoutMode(flow)', lastLayoutAction)
lastLayoutAction = ''
layoutFlowRestore.props.onKeyDown({
  key: 'Enter',
  code: 'Enter',
  preventDefault: () => {},
  stopPropagation: () => {},
})
ok(lastLayoutAction === 'both', '「恢复双栏」键盘 Enter → onLayoutMode(both)', lastLayoutAction)
lastLayoutAction = ''
const layoutBothGanttTree = expand(api.components.GanttPanel({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  layoutMode: 'both',
  onLayoutMode: (mode) => { lastLayoutAction = mode },
  onSelect: () => {},
}))
const layoutBothGanttBtn = findOne(layoutBothGanttTree, (node) => node.props && node.props['data-tm-panel-action'] === 'maximize-gantt')
layoutBothGanttBtn.props.onKeyDown({
  key: ' ',
  code: 'Space',
  preventDefault: () => {},
  stopPropagation: () => {},
})
ok(lastLayoutAction === 'gantt', '「放大甘特图」键盘 Space → onLayoutMode(gantt)', lastLayoutAction)

// 布局 CSS/纯函数契约
const layoutCss = (injectedStyles.find((element) => element.id === 'task-map-m2-style') || {}).textContent || ''
ok(layoutCss.includes('.tm-main.tm-layout-flow') && layoutCss.includes('.tm-main.tm-layout-gantt'), 'CSS 提供单图模式 grid 规则')
ok(layoutCss.includes('[data-tm-panel-collapsed="true"]'), 'CSS 折叠隐藏规则（DOM 保留 + display:none）')
ok(api.utils.normalizeLayoutMode('flow') === 'flow' && api.utils.normalizeLayoutMode('both') === 'both' && api.utils.normalizeLayoutMode('xxx') === 'both', 'normalizeLayoutMode 容错')
ok(api.utils.isPanelCollapsed('flow', 'gantt') === true && api.utils.isPanelCollapsed('flow', 'flow') === false && api.utils.isPanelCollapsed('gantt', 'flow') === true && api.utils.isPanelCollapsed('both', 'flow') === false, 'isPanelCollapsed 矩阵正确')
ok(api.utils.layoutGridTemplate('flow', 2) === 'minmax(0,1fr) auto' && api.utils.layoutGridTemplate('gantt', 2) === 'auto minmax(0,1fr)' && api.utils.layoutGridTemplate('both', 3).indexOf('46%') > 0, 'layoutGridTemplate 行模板正确')

// SessionView 级：layoutStore 决定根节点/面板折叠（E2E 路径）
api.layoutStore.set('gantt')
const layoutGanttSession = expand(api.components.SessionViewInner({ sessionId: view.sessionId, useProjection: () => view }))
ok(layoutGanttSession.props['data-tm-layout-mode'] === 'gantt', 'SessionView 渲染 gantt 模式根节点属性')
const layoutGanttMain = findOne(layoutGanttSession, (node) => node.props && String(node.props.className || '').includes('tm-layout-gantt'))
ok(Boolean(layoutGanttMain), 'SessionView 主容器 class 含 tm-layout-gantt')
ok(findOne(layoutGanttSession, (node) => node.props && node.props['data-tm-panel'] === 'flow').props['data-tm-panel-collapsed'] === 'true', 'SessionView gantt 模式：流程图折叠')
ok(findOne(layoutGanttSession, (node) => node.props && node.props['data-tm-panel'] === 'gantt').props['data-tm-panel-collapsed'] === 'false', 'SessionView gantt 模式：甘特展开')
api.layoutStore.set('flow')
const layoutFlowSession = expand(api.components.SessionViewInner({ sessionId: view.sessionId, useProjection: () => view }))
ok(layoutFlowSession.props['data-tm-layout-mode'] === 'flow', 'SessionView 渲染 flow 模式根节点属性')
ok(findOne(layoutFlowSession, (node) => node.props && node.props['data-tm-panel'] === 'gantt').props['data-tm-panel-collapsed'] === 'true', 'SessionView flow 模式：甘特折叠')
api.layoutStore.set('both')

// flow 单图模式防御性布局（顶部绝不被裁）
const defensiveCss = (injectedStyles.find((element) => element.id === 'task-map-m2-style') || {}).textContent || ''
ok(defensiveCss.includes('.tm-layout-flow .tm-map-scroll{display:block;overflow:hidden}'), 'flow 单图：map 容器 display:block + overflow:hidden（顶部不裁）')
ok(defensiveCss.includes('.tm-layout-flow .tm-flow-svg{display:block;width:100%;height:auto;max-height:100%}'), 'flow 单图：SVG max-height:100%（内部 letterbox 保证完整）')
ok(defensiveCss.indexOf('.tm-layout-flow .tm-map-scroll{display:flex') < 0, 'flow 单图不再使用 flex 居中（避免顶部溢出不可达）')
ok(defensiveCss.includes('.tm-layout-flow .tm-map .tm-panel-head{padding-bottom:10px}'), 'flow 单图：面板头下方 3px 安全间距')
const layoutFlowModeTree = expand(api.components.TaskFlow({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  highlightRef: { current: { children: [] } },
  layoutMode: 'flow',
  onSelect: () => {},
}))
const layoutFlowScroll = findOne(layoutFlowModeTree, (node) => node.props && String(node.props.className || '').includes('tm-map-scroll'))
ok(layoutFlowScroll && String(layoutFlowScroll.props.className).indexOf('tm-flow-fit') < 0, 'flow 单图：不加 tm-flow-fit（走本地拉伸而非 fit 居中）')
ok(layoutFlowScroll && layoutFlowScroll.props.ref !== undefined, 'flow 单图：map 容器带 ref（用于 scrollTop 归零）')
// both 模式仍保留原 fit 行为（不受影响）
const bothFitScroll = findOne(sessionTree, (node) => node.props && String(node.props.className || '').includes('tm-map-scroll'))
ok(bothFitScroll && String(bothFitScroll.props.className).includes('tm-flow-fit'), 'both 模式：仍使用 tm-flow-fit（原行为不变）')

// 切换不丢回放状态/选中（marker.actions）
const stateBefore = window.__TASK_MAP_M2__.actions.getState()
window.__TASK_MAP_M2__.actions.setCurrentTime(mock.base + 700000)
const beforeLayout = window.__TASK_MAP_M2__.actions.getState()
window.__TASK_MAP_M2__.actions.selectTask('task-4')
window.__TASK_MAP_M2__.actions.setLayoutMode('flow')
const afterLayout = window.__TASK_MAP_M2__.actions.getState()
ok(afterLayout.layoutMode === 'flow', 'actions.setLayoutMode(flow) 生效（store）', afterLayout.layoutMode)
ok(afterLayout.currentTime === beforeLayout.currentTime, '切换布局不丢 currentTime', String(afterLayout.currentTime))
ok(afterLayout.selected === 'task-4', '切换布局不丢选中任务', afterLayout.selected)
window.__TASK_MAP_M2__.actions.setLayoutMode('gantt')
ok(window.__TASK_MAP_M2__.actions.getState().layoutMode === 'gantt', 'actions.setLayoutMode(gantt) 生效')
window.__TASK_MAP_M2__.actions.setLayoutMode('both')
ok(window.__TASK_MAP_M2__.actions.getState().layoutMode === 'both', 'actions.setLayoutMode(both) 恢复')
window.__TASK_MAP_M2__.actions.clearSelection()
void stateBefore

// ==================================================================
console.log('\n[client-smoke] v1.1 会话计划（todo）区块：7 项/计数/只读/隐藏')
// ==================================================================
const planNode = findOne(sessionTree, (node) => node.props && node.props['data-tm-plan'] === '1')
ok(Boolean(planNode), '总览渲染会话计划区块 data-tm-plan=1')
ok(planNode && planNode.props['data-tm-plan-counts'] === '1/1/5', '计划计数 data-tm-plan-counts=1/1/5', planNode && planNode.props['data-tm-plan-counts'])
ok(planNode && planNode.props.role === 'region' && planNode.props['aria-label'] === '会话计划（todo）', '计划区块 role=region + aria-label')
ok(hasText(sessionTree, '会话计划（todo）'), '区块标题「会话计划（todo）」')
const planItems = findAll(planNode, (node) => node.props && node.props['data-tm-plan-item'] === '1')
ok(planItems.length === 7, '计划清单 7 项', String(planItems.length))
const planStatuses = planItems.map((item) => item.props['data-tm-plan-status'])
ok(planStatuses.filter((status) => status === 'completed').length === 1, '状态图标：已完成 1 项')
ok(planStatuses.filter((status) => status === 'in_progress').length === 1, '状态图标：进行中 1 项')
ok(planStatuses.filter((status) => status === 'pending').length === 5, '状态图标：待处理 5 项')
ok(hasText(planNode, '已完成 1') && hasText(planNode, '进行中 1') && hasText(planNode, '待处理 5'), '计数 chips 文案')
ok(hasText(sessionTree, '计划来自会话 todo；执行任务见左侧任务图。'), '说明文案「计划来自会话 todo；执行任务见左侧任务图」')
ok(planItems.length > 0 && planItems.every((item) => item.props.title === undefined), '计划项不使用原生 title（依赖截断+详情）')
ok(planItems.every((item) => typeof item.props.onClick !== 'function' && item.props.role !== 'button'), '计划项只读（无 onClick/非按钮）')
ok(planItems.every((item) => item.props['data-tm-plan-id']), '计划项带 data-tm-plan-id')
ok(planNode && findOne(planNode, (node) => node.props && node.props['data-tm-plan-count'] === 'completed'), '计数 chip data-tm-plan-count=completed')

// 无 plan / active=false → 区块隐藏（图/甘特降级展示时不重复）
const noPlanView = Object.assign({}, view)
delete noPlanView.plan
const noPlanTree = expand(api.components.SessionViewInner({ sessionId: 'session-no-plan', useProjection: () => noPlanView }))
ok(findOne(noPlanTree, (node) => node.props && node.props['data-tm-plan'] === '1') === null, '无 plan 时会话计划区块隐藏')
const inactivePlanView = Object.assign({}, view, { plan: Object.assign({}, view.plan, { active: false }) })
const inactivePlanTree = expand(api.components.SessionViewInner({ sessionId: 'session-inactive-plan', useProjection: () => inactivePlanView }))
ok(findOne(inactivePlanTree, (node) => node.props && node.props['data-tm-plan'] === '1') === null, 'plan.active=false（仅 todo 降级）时区块隐藏')
ok(findAll(inactivePlanTree, isNode).length === 8, 'active=false 时左侧任务图仍正常渲染（不回归）')

// ==================================================================
console.log('\n[client-smoke] v1.1 tooltip 定位：focus 事件无坐标不出现在 (0,0)、clamp 视口内')
// ==================================================================
const v11TooltipStore = api.createTooltipStore()
const v11TooltipStoreTree = expand(api.components.TaskFlow({
  prep,
  store: endStore2,
  tips: v11TooltipStore,
  selectionRef: { current: '' },
  highlightRef: { current: { children: [] } },
  onSelect: () => {},
}))
const v11TooltipNode = findOne(v11TooltipStoreTree, (node) => node.props && node.props['data-tm-node'] === 'task-1')
const v11NodeRect = { left: 300, top: 220, width: 160, height: 62, right: 460, bottom: 282 }
v11TooltipNode.props.onFocus({ currentTarget: { getBoundingClientRect: () => v11NodeRect } })
let v11TipSnapshot = v11TooltipStore.get()
ok(v11TipSnapshot.visible === true, 'focus 后 tooltip 可见')
ok(v11TipSnapshot.x === 380 && v11TipSnapshot.y === 220, 'focus（无 clientX/Y）→ 锚点为节点矩形中心/顶部（380,220）', v11TipSnapshot.x + ',' + v11TipSnapshot.y)
ok(!(v11TipSnapshot.x === 0 && v11TipSnapshot.y === 0), 'focus 后 tooltip 不落在 (0,0)')
const v11TooltipClock = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
v11TooltipClock.setTime(prep.timeEnd)
const v11TooltipTree = expand(api.components.TooltipLayer({ tips: v11TooltipStore, prep, clock: v11TooltipClock }))
const v11TooltipEl = findOne(v11TooltipTree, (node) => node.props && node.props['data-tm-tooltip'])
ok(Boolean(v11TooltipEl), 'TooltipLayer 渲染浮层 data-tm-tooltip')
const v11TipLeft = parseFloat(v11TooltipEl.props.style.left)
const v11TipTop = parseFloat(v11TooltipEl.props.style.top)
ok(v11TipLeft > 8 && v11TipTop > 8, 'tooltip 坐标非 (0,0) 且大于安全间距', v11TipLeft + ',' + v11TipTop)
ok(v11TipLeft >= 380 - 8 && v11TipLeft <= 380 + 320, 'tooltip 出现在节点附近（x）', String(v11TipLeft))
ok(v11TipLeft >= 8 && v11TipTop >= 8 && v11TipLeft <= 1440 - 40 && v11TipTop <= 900 - 40, 'tooltip clamp 在视口内')
ok(v11TooltipEl.props['data-tm-tooltip-x'] === '380' && v11TooltipEl.props['data-tm-tooltip-y'] === '220', 'data-tm-tooltip-x/y 记录锚点')
// mouse 正常路径不回归
v11TooltipStore.show({ clientX: 120, clientY: 80 }, { kind: 'task', taskId: 'task-1' })
v11TipSnapshot = v11TooltipStore.get()
ok(v11TipSnapshot.x === 120 && v11TipSnapshot.y === 80, 'mouse 事件坐标路径保持（120,80）')
// 右/下边缘 clamp：渲染不溢出视口
v11TooltipStore.showAtRect({ left: 1430, top: 890, width: 200, height: 60 }, { kind: 'task', taskId: 'task-1' })
const v11EdgeTipTree = expand(api.components.TooltipLayer({ tips: v11TooltipStore, prep, clock: v11TooltipClock }))
const v11EdgeTip = findOne(v11EdgeTipTree, (node) => node.props && node.props['data-tm-tooltip'])
const v11EdgeLeft = parseFloat(v11EdgeTip.props.style.left)
const v11EdgeTop = parseFloat(v11EdgeTip.props.style.top)
ok(v11EdgeLeft >= 8 && v11EdgeLeft <= 1440 - 40 && v11EdgeTop >= 8 && v11EdgeTop <= 900 - 40, '边缘锚点 wrap 后仍 clamp 在视口内', v11EdgeLeft + ',' + v11EdgeTop)
// blur 收起浮层
v11TooltipNode.props.onBlur()
ok(v11TooltipStore.get().visible === false, 'blur 后 tooltip 隐藏（不残留）')
ok(findOne(expand(api.components.TooltipLayer({ tips: v11TooltipStore, prep, clock: v11TooltipClock })), (node) => node.props && node.props['data-tm-tooltip']) === null, '隐藏后不渲染浮层节点')

// 空状态：dataSource=none
const emptyView = {
  schema: 'task-map/view',
  stateVersion: 3,
  sessionId: 'session-empty',
  title: '空会话',
  cwd: '/Users/mock/Codes/empty',
  asOfTime: mock.base + 1000,
  timeRange: { start: mock.base, end: mock.base + 1000 },
  hasTeamBoard: false,
  dataSource: 'none',
  emptyReason: 'no-task-board',
  tasks: [],
  taskStats: { total: 0, pending: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, other: 0 },
  counters: { toolCalls: 12, steps: 20 },
  turns: [{ turn: 1, start: mock.base + 10, end: mock.base + 900 }],
}
const emptyTree = expand(api.components.SessionViewInner({
  sessionId: 'session-empty',
  useProjection: () => emptyView,
}))
ok(emptyTree.props['data-tm-empty'] === 'true', '空会话根节点 data-tm-empty=true')
ok(emptyTree.props['data-tm-tasks'] === '0', '空会话 data-tm-tasks=0')
ok(findOne(emptyTree, (node) => node.props && node.props['data-tm-empty-state']), '空状态容器 data-tm-empty-state')
ok(hasText(emptyTree, '本会话未维护任务清单'), '空状态文案正确')
ok(hasText(emptyTree, 'AI 没有使用 Agent Teams 任务板'), '空状态引导语')

// todo 降级视图
const todoView = Object.assign({}, emptyView, {
  dataSource: 'todo',
  hasTeamBoard: false,
  emptyReason: null,
  tasks: [{ id: 'todo-1', kind: 'todo', subject: 'TODO 事项 1', status: 'completed', owner: 'Lead', createdAt: mock.base + 10, startedAt: mock.base + 20, completedAt: mock.base + 900, phases: [{ status: 'pending', at: mock.base + 10 }, { status: 'in_progress', at: mock.base + 20 }, { status: 'completed', at: mock.base + 900 }], startRank: 1, doneRank: 1, writeScopes: [], blockedBy: [] }],
  taskStats: { total: 1, pending: 0, in_progress: 0, completed: 1, failed: 0, blocked: 0, other: 0 },
})
const todoTree = expand(api.components.SessionViewInner({ sessionId: 'session-todo', useProjection: () => todoView }))
ok(todoTree.props['data-tm-empty'] === 'false' && todoTree.props['data-tm-tasks'] === '1', 'todo 降级：有任务、非空态')
ok(hasText(todoTree, '来自 todo 清单'), 'todo 降级：顶栏标注「来自 todo 清单」')

// 投影异常：useProjection 抛错 → 局部错误卡片
const errorTree = expand(api.components.SessionViewInner({
  sessionId: 'session-error',
  useProjection: () => { throw new Error('projection exploded') },
}))
ok(errorTree.props['data-tm-projection'] === 'error', '投影异常 → data-tm-projection=error')
ok(findOne(errorTree, (node) => node.props && node.props['data-tm-error']), '投影异常 → 错误卡片 data-tm-error')
ok(hasText(errorTree, '任务地图暂时不可用'), '投影异常 → 局部提示文案')

// 投影缺失（null）→ 等待态
const pendingTree = expand(api.components.SessionViewInner({ sessionId: 'session-pending', useProjection: () => null }))
ok(pendingTree.props['data-tm-projection'] === 'pending', '投影为 null → data-tm-projection=pending')
ok(pendingTree.props['data-tm-tasks'] === '0', '投影为 null → data-tm-tasks=0')

// 组件单独渲染容错
ok(expand(api.components.EmptyState({ prep: api.prepareView(emptyView) })), 'EmptyState 单独渲染不抛错')
ok(expand(api.components.ErrorCard({ message: 'x' })), 'ErrorCard 单独渲染不抛错')
ok(api.components.GanttPanel({ prep, store, tips }), 'GanttPanel 单独渲染不抛错')

// ==================================================================
console.log('\n[client-smoke] 回放时刻「未来不剧透」（详情/总览按 currentTime 推导）')
// ==================================================================
const replayStore = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd })
const mid2 = mock.base + 100000
replayStore.setTime(mid2)
const futureTask = prep.taskById['task-8'] // createdAt = 610000（mid 时刻尚未创建）
const futureDetail = expand(api.components.TaskDetail({
  task: futureTask,
  prep,
  store: replayStore,
  onClear: () => {},
  onSelect: () => {},
}))
const futureDetailRoot = findOne(futureDetail, (node) => node.props && node.props['data-tm-detail'])
ok(futureDetailRoot && futureDetailRoot.props['data-tm-detail-state'] === 'future', '未创建任务详情 data-tm-detail-state=future', futureDetailRoot && futureDetailRoot.props['data-tm-detail-state'])
ok(hasText(futureDetail, '该任务在回放时刻尚未创建'), '未创建任务显示「尚未创建」提示')
ok(hasText(futureDetail, '计划任务（尚未创建）'), '未创建任务创建时间显示「计划任务」')
ok(hasText(futureDetail, '未完成'), '未创建任务完成时间显示「未完成」')
ok(hasText(futureDetail, '已跑') === false, '未创建任务不显示「已跑」/最终耗时')
const futureCompletedText = api.utils.fmtHmSec(futureTask.completedAt)
ok(!hasText(futureDetail, futureCompletedText), '未创建任务不泄露 completedAt 文本', futureCompletedText)

const runningTask = prep.taskById['task-1'] // start 60000, done 300000
const runningDetail = expand(api.components.TaskDetail({
  task: runningTask,
  prep,
  store: replayStore,
  onClear: () => {},
  onSelect: () => {},
}))
const runningRoot = findOne(runningDetail, (node) => node.props && node.props['data-tm-detail'])
ok(runningRoot.props['data-tm-detail-state'] === 'running', '执行中任务详情 data-tm-detail-state=running')
ok(hasText(runningDetail, '已跑'), '执行中任务显示「已跑 X（截至回放时刻）」')
ok(!hasText(runningDetail, api.utils.fmtHmSec(runningTask.completedAt)), '执行中任务不泄露完成时间')
ok(hasText(runningDetail, '未完成'), '执行中任务完成行显示「未完成」')
ok(hasText(runningDetail, '执行中：耗时与状态截至回放时刻'), '执行中任务详情提示「截至回放时刻」')

const blockedTask = prep.taskById['task-7'] // phases: pending@7000 → blocked@50000 → in_progress@900000
const blockedDetail = expand(api.components.TaskDetail({
  task: blockedTask,
  prep,
  store: replayStore,
  onClear: () => {},
  onSelect: () => {},
}))
const blockedRoot = findOne(blockedDetail, (node) => node.props && node.props['data-tm-detail'])
ok(blockedRoot.props['data-tm-detail-state'] === 'blocked', '阻塞任务详情 data-tm-detail-state=blocked', blockedRoot.props['data-tm-detail-state'])
ok(hasText(blockedDetail, '等待依赖（剩 6）') || hasText(blockedDetail, '等待依赖（剩'), '阻塞任务显示「等待依赖（剩 N）」')
ok(hasText(blockedDetail, '已阻塞'), '状态区间包含「已阻塞」')

const pendingTask = prep.taskById['task-6'] // createdAt 6000, startedAt 650000
const pendingDetail = expand(api.components.TaskDetail({
  task: pendingTask,
  prep,
  store: replayStore,
  onClear: () => {},
  onSelect: () => {},
}))
const pendingRoot = findOne(pendingDetail, (node) => node.props && node.props['data-tm-detail'])
ok(pendingRoot.props['data-tm-detail-state'] === 'pending', '待开始任务详情 data-tm-detail-state=pending')
ok(hasText(pendingDetail, '回放时刻尚未开始，无执行过程'), '未开始任务执行过程显示占位说明')
ok(hasText(pendingDetail, '排队中'), '未开始任务显示「排队中」而非最终排队耗时')

const doneDetail = expand(api.components.TaskDetail({
  task: prep.taskById['task-1'],
  prep,
  store: (() => { const s = api.createReplayStore({ start: prep.timeStart, end: prep.timeEnd }); s.setTime(prep.timeEnd); return s })(),
  onClear: () => {},
  onSelect: () => {},
}))
const doneRoot = findOne(doneDetail, (node) => node.props && node.props['data-tm-detail'])
ok(doneRoot.props['data-tm-detail-state'] === 'done', '终点时刻已完成任务 data-tm-detail-state=done')
ok(hasText(doneDetail, '共 ') && hasText(doneDetail, '按时间窗推断'), '执行过程显示真实 span 条数并标注推断')
ok(hasText(doneDetail, '状态区间（截至回放时刻）'), '详情显示状态区间（按回放时刻截断）')

// 总览回放态：完成度按 currentTime，而非最终值
const midOverview = expand(api.components.Overview({ prep, store: replayStore }))
const midCounts = api.utils.countsAtTime(prep.tasks, mid2)
const ovCompleted = findOne(midOverview, (node) => node.props && node.props['data-tm-ov-completed'] !== undefined)
ok(ovCompleted && ovCompleted.props['data-tm-ov-completed'] === String(midCounts.completed), '总览完成度按回放时刻（mid 已完成 0/8）', ovCompleted && ovCompleted.props['data-tm-ov-completed'])
ok(hasText(midOverview, '任务完成度 · 回放时刻'), '总览标题标注「回放时刻」')
const midChanges = findOne(midOverview, (node) => node.props && node.props['data-tm-changes'])
ok(midChanges && midChanges.props['data-tm-changes-visible'] === '0', '回放早期 data-tm-changes-visible=0（未来变更隐藏）', midChanges && midChanges.props['data-tm-changes-visible'])
ok(midChanges && midChanges.props['data-tm-added-count'] === '0', '回放早期 data-tm-added-count=0')
ok(hasText(midOverview, '另有 3 条未来变更（回放中隐藏）'), '回放早期提示「另有 3 条未来变更」')
ok(!hasText(midOverview, '拆分 task-4 → task-8'), '回放早期不泄露未来拆分文案')
ok(hasText(midOverview, '累计执行 vs 墙钟'), '总览显示累计执行 vs 墙钟')

// 无异常泄漏到 marker.errors（读投影异常被局部捕获，不写入全局 errors）
const newErrors = window.__TASK_MAP_M2__.errors.slice(errorsBefore)
ok(newErrors.length === 0, '渲染过程中无未捕获客户端错误', newErrors.join(' | '))

// ==================================================================
// ==================================================================
console.log('\n[client-smoke] W3.3 打磨：无障碍/错误容错/长文案/CSS 契约/首屏性能')
// ==================================================================
// ---- 无障碍：任务节点键盘与 ARIA ----
const a11yTree = expand(api.components.TaskFlow({ prep, store, tips: api.createTooltipStore(), selectionRef: { current: '' }, onSelect: () => {} }))
const a11yFlowNodes = findAll(a11yTree, isNode)
ok(a11yFlowNodes.length === 8 && a11yFlowNodes.every((node) => node.props.tabIndex === 0), '任务节点可 Tab 聚焦（tabIndex=0）')
ok(a11yFlowNodes.every((node) => node.props.role === 'button'), '任务节点 role=button')
const a11yLabel = String(a11yFlowNodes[0].props['aria-label'] || '')
ok(a11yLabel.includes('task-1') && a11yLabel.includes('已完成') && a11yLabel.includes('负责人'), '任务节点 aria-label 含 id/状态/负责人', a11yLabel)
ok(a11yFlowNodes.every((node) => node.props['aria-pressed'] === 'false'), '未选中节点 aria-pressed=false')
let a11ySelected = ''
const keyTree = expand(api.components.TaskFlow({
  prep,
  store,
  tips: api.createTooltipStore(),
  selectionRef: { current: 'task-1' },
  onSelect: (id) => { a11ySelected = id },
}))
const keyNode = findAll(keyTree, isNode).find((node) => node.props['data-tm-node'] === 'task-1')
ok(keyNode.props['aria-pressed'] === 'true', '选中节点 aria-pressed=true')
let prevented = 0
let stopped = 0
keyNode.props.onKeyDown({
  key: ' ',
  code: 'Space',
  preventDefault: () => { prevented += 1 },
  stopPropagation: () => { stopped += 1 },
})
ok(a11ySelected === 'task-1' && prevented === 1 && stopped === 1, '节点空格键：选中且阻止冒泡（避免触发全局播放）')
ok(keyNode.props['aria-label'].includes('task-1'), '选中节点 aria-label 有效')

// ---- 无障碍：甘特任务条键盘 ----
let ganttKeySelected = ''
const ganttA11y = expand(api.components.GanttPanel({ prep, store, tips: api.createTooltipStore(), selectionRef: { current: '' }, onSelect: (id) => { ganttKeySelected = id } }))
const a11yGanttBars = findAll(ganttA11y, (node) => node.props && node.props['data-tm-gantt-bar'])
ok(a11yGanttBars.length === 8 && a11yGanttBars.every((node) => node.props.tabIndex === 0 && node.props.role === 'button'), '甘特任务条可 Tab 聚焦且 role=button')
ok(a11yGanttBars.every((node) => String(node.props['aria-label'] || '').includes('时间轴')), '甘特任务条 aria-label')
const ganttBar1 = a11yGanttBars.find((node) => node.props['data-tm-gantt-bar'] === 'task-1')
ganttBar1.props.onKeyDown({ key: 'Enter', code: 'Enter', preventDefault: () => {}, stopPropagation: () => {} })
ok(ganttKeySelected === 'task-1', '甘特条 Enter → 选中 task-1', ganttKeySelected)

// ---- 无障碍：回放控件/根节点 ----
const a11yReplay = expand(api.components.ReplayControls({ store, prep }))
const playBtn = findOne(a11yReplay, (node) => node.props && node.props['data-tm-play'])
ok(playBtn.props['aria-label'] === '播放回放' && playBtn.props['aria-pressed'] === 'false', '播放按钮 aria-label/aria-pressed')
const speedSelect = findOne(a11yReplay, (node) => node.props && node.props['data-tm-speed'] !== undefined && node.type === 'select')
ok(speedSelect && speedSelect.props['aria-label'] === '回放倍速', '倍速 select aria-label')
ok(findOne(a11yReplay, (node) => node.props && node.props['data-tm-jump-start'] && node.props['aria-label']), '跳到开始按钮 aria-label')
ok(sessionTree.props.role === 'region' && sessionTree.props['aria-label'] === '任务地图', '根节点 role=region + aria-label')
const flowSvgA11y = findOne(sessionTree, (node) => node.type === 'svg' && String(node.props['aria-label'] || '').includes('任务流程图'))
ok(flowSvgA11y && flowSvgA11y.props.role === 'group', '任务图 svg role=group + aria-label')

// ---- CSS 契约：样式注入/前缀/主题变量/reduced-motion ----
const styleElement = injectedStyles.find((element) => element.id === 'task-map-m2-style')
ok(Boolean(styleElement), '注入 <style id="task-map-m2-style">')
const css = styleElement ? styleElement.textContent : ''
ok(css.includes('--dsw-alias-label-primary') && css.includes('--dsw-alias-bg-layer-1'), 'CSS 使用 --dsw-alias-* 主题变量')
ok(css.includes('.tm-root') && css.includes('.tm-node') && css.includes('.tm-tl-bar'), 'CSS 类名 tm- 前缀')
ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'CSS 支持 prefers-reduced-motion')
ok(!css.includes('@import'), 'CSS 无外部 @import')
ok(css.includes(':focus-visible'), 'CSS 提供键盘焦点可见样式')

// ---- 错误容错：投影对象但字段缺失/异常 ----
const emptyObjectTree = expand(api.components.SessionViewInner({ sessionId: 'session-blank', useProjection: () => ({}) }))
ok(emptyObjectTree.props['data-tm-projection'] === 'ready' && emptyObjectTree.props['data-tm-empty'] === 'true', '空对象投影 → 空态（不崩）')
const minimalTree = expand(api.components.SessionViewInner({
  sessionId: 'session-min',
  useProjection: () => ({ tasks: [{ id: 'only-1' }, null, { id: '' }], asOfTime: mock.base + 1000, timeRange: { start: mock.base, end: mock.base + 1000 } }),
}))
ok(Number(minimalTree.props['data-tm-tasks']) >= 1 && minimalTree.props['data-tm-empty'] === 'false', '字段缺失的最小任务视图可渲染（规范化兜底）', minimalTree.props['data-tm-tasks'])
const badDataTree = expand(api.components.SessionViewInner({
  sessionId: 'session-bad',
  useProjection: () => ({ tasks: 'not-an-array', taskStats: 'nope', timeRange: null, waits: 5, changes: 7 }),
}))
ok(badDataTree.props['data-tm-tasks'] === '0' && badDataTree.props['data-tm-empty'] === 'true', '类型异常字段 → 降级空态（不崩）')
// warnings 展示
const warnView = Object.assign({}, view, { warnings: [{ code: 'blocker-missing', taskId: 'task-4' }, { code: 'relation-child-missing', taskId: 'task-x' }] })
const warnTree = expand(api.components.SessionViewInner({ sessionId: view.sessionId, useProjection: () => warnView }))
const warnChip = findOne(warnTree, (node) => node.props && node.props['data-tm-warnings'])
ok(warnChip && warnChip.props['data-tm-warnings'] === '2' && hasText(warnTree, '数据缺失'), 'warnings 数量 chip 展示')
ok(hasText(warnTree, '数据提示'), '总览 warnings 提示文案')

// ---- 长文案截断（节点文本截断 + title 全量）----
const longSubject = '这是一个非常非常长的任务标题用于验证节点文字截断与 hover 提示不应该撑破布局'.repeat(3)
const longView = Object.assign({}, view, {
  tasks: [{ id: 'long-1', subject: longSubject, status: 'completed', owner: 'Lead', createdAt: mock.base + 1000, startedAt: mock.base + 2000, completedAt: mock.base + 3000, phases: [{ status: 'pending', at: mock.base + 1000 }, { status: 'completed', at: mock.base + 3000 }], startRank: 1, doneRank: 1, writeScopes: [], blockedBy: [] }],
  taskStats: { total: 1, pending: 0, in_progress: 0, completed: 1, failed: 0, blocked: 0, other: 0 },
  timeRange: { start: mock.base, end: mock.base + 10000 },
  asOfTime: mock.base + 10000,
})
const longPrep = api.prepareView(longView)
const longFlow = expand(api.components.TaskFlow({
  prep: longPrep,
  store: api.createReplayStore({ start: longPrep.timeStart, end: longPrep.timeEnd }),
  tips: api.createTooltipStore(),
  selectionRef: { current: '' },
  onSelect: () => {},
}))
const longNodeTexts = collectText(longFlow)
ok(longNodeTexts.some((text) => text.length <= 17 && text.endsWith('…')), '长标题节点文本截断为 ≤17 字 + 省略号')
const longTitle = findOne(longFlow, (node) => node.type === 'title' && collectText(node).some((text) => text.includes('验证节点文字截断')))
ok(!longTitle, '节点不渲染 SVG <title>（原生提示已移除，改用自定义 tooltip）；aria-label 提供完整标题', longTitle ? 'still present' : '')

// ---- 首屏性能：19 任务合成视图 prepare + 渲染预算 ----
const perfBase = mock.base
const perfTasks = Array.from({ length: 19 }, (_, index) => ({
  id: 'perf-' + index,
  subject: '长会话任务 ' + index + '：合成数据用于 19 任务性能断言',
  status: index < 10 ? 'completed' : 'pending',
  owner: 'agent-' + (index % 5),
  createdAt: perfBase + index * 1000,
  startedAt: index < 10 ? perfBase + index * 1000 + 500 : null,
  completedAt: index < 10 ? perfBase + index * 1000 + 900 : null,
  phases: index < 10
    ? [{ status: 'pending', at: perfBase + index * 1000 }, { status: 'in_progress', at: perfBase + index * 1000 + 500 }, { status: 'completed', at: perfBase + index * 1000 + 900 }]
    : [{ status: 'pending', at: perfBase + index * 1000 }],
}))
const perfView = {
  tasks: perfTasks,
  timeRange: { start: perfBase, end: perfBase + 30000 },
  asOfTime: perfBase + 30000,
  turns: [{ turn: 1, start: perfBase, end: perfBase + 29000 }],
  spans: Array.from({ length: 60 }, (_, index) => ({ kind: 'tool', name: 'bash', label: 'bash', start: perfBase + index * 400, end: perfBase + index * 400 + 200, status: 'ok' })),
}
const perfStart = Date.now()
const perfPrep = api.prepareView(perfView)
const prepElapsed = Date.now() - perfStart
ok(perfPrep.tasks.length === 19 && perfPrep.flow.rows === 5, '19 任务视图：19 任务 / 5 行任务图')
ok(prepElapsed < 200, '19 任务首屏 prepareView < 200ms（实测 ' + prepElapsed + 'ms）')
const renderStart = Date.now()
const perfTree = expand(api.components.SessionViewInner({ sessionId: 'perf-19', useProjection: () => perfView }))
const renderElapsed = Date.now() - renderStart
ok(Boolean(perfTree) && renderElapsed < 500, '19 任务首屏组件渲染 < 500ms（实测 ' + renderElapsed + 'ms）')
ok(findAll(perfTree, isNode).length === 19, '19 任务流图节点全部渲染')
ok(hasText(perfTree, '滚动查看全部'), '长会话（>3 行）任务图提示「滚动查看全部」')

console.log('\n[client-smoke] 纯逻辑（S 形布局 / 状态推导 / 二分 / 回放 store / 容错）')
// ==================================================================
runLogicTests(api, ok)

// ==================================================================
if (failures.length > 0) {
  console.error(`\n[client-smoke] FAILED: ${failures.length} check(s)`)
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log(`\n[client-smoke] PASS (${passed} checks)`)
