#!/usr/bin/env node
/**
 * M2 客户端纯逻辑测试（W2.1/W2.2 的核心算法）。
 *
 *   node test/client-logic.test.mjs
 *
 * 被 test/client-smoke.mjs import 时执行 `runLogicTests(api, ok)`；
 * 直接运行时自己搭 stub 环境加载 client.js。
 *
 * 覆盖：S 形布局 / 状态随时间推导 / 任意时刻统计 / 二分查找 / 等待与执行窗推断 /
 *       负责人稳定配色 / 中文时长格式 / 回放 store 语义 / 视图容错。
 */

import { pathToFileURL } from 'node:url'

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href
  } catch (error) {
    return false
  }
})()

/* eslint-disable no-undef */
function fakeEnv() {
  const attrs = {}
  const captured = { definition: null }
  globalThis.window = {
    __ModuleLoader__: { load: (definition) => { captured.definition = definition } },
    innerWidth: 1440,
    innerHeight: 900,
  }
  globalThis.document = {
    documentElement: { setAttribute: (key, value) => { attrs[key] = value }, dataset: {} },
    head: { append: () => {} },
    getElementById: () => null,
    createElement: () => ({ setAttribute: () => {}, style: {}, textContent: '' }),
    activeElement: null,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  return { captured, attrs }
}

function fakeReact() {
  const element = (type, props, ...children) => ({
    type,
    props: props || {},
    children: children.flat(Infinity),
  })
  return {
    createElement: element,
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useMemo: (factory) => factory(),
    useRef: (value) => ({ current: value === undefined ? null : value }),
    useCallback: (callback) => callback,
    memo: (component) => component,
  }
}

/* ================================================================== */
/* 纯逻辑断言主体（不依赖 DOM）                                         */
/* ================================================================== */
export function runLogicTests(api, ok) {
  const u = api.utils
  const mock = buildLogicMockView()
  const base = mock.base
  const prep = api.prepareView(mock.view)

  // ---------- 1. 中文时长格式 ----------
  ok(u.fmtDur(0) === '0 毫秒', 'fmtDur(0) = 0 毫秒', u.fmtDur(0))
  ok(u.fmtDur(500) === '500 毫秒', 'fmtDur(500) = 500 毫秒', u.fmtDur(500))
  ok(u.fmtDur(1500) === '1.5 秒', 'fmtDur(1500) = 1.5 秒', u.fmtDur(1500))
  ok(u.fmtDur(15000) === '15 秒', 'fmtDur(15000) = 15 秒', u.fmtDur(15000))
  ok(u.fmtDur(90000) === '1.5 分', 'fmtDur(90000) = 1.5 分', u.fmtDur(90000))
  ok(u.fmtDur(1500000) === '25 分', 'fmtDur(1500000) = 25 分', u.fmtDur(1500000))
  ok(u.fmtDur(3600000) === '1.0 时', 'fmtDur(3600000) = 1.0 时', u.fmtDur(3600000))
  ok(u.fmtDur(null) === '—', 'fmtDur(null) = —')
  ok(u.fmtDurCn(0) === '0 秒', 'fmtDurCn(0) = 0 秒', u.fmtDurCn(0))
  ok(u.fmtDurCn(65000) === '1 分 5 秒', 'fmtDurCn(65000) = 1 分 5 秒', u.fmtDurCn(65000))
  ok(u.fmtDurCn(3600000) === '1 时', 'fmtDurCn(1h) = 1 时', u.fmtDurCn(3600000))
  ok(u.fmtDurCn(5400000) === '1 时 30 分', 'fmtDurCn(1.5h) = 1 时 30 分', u.fmtDurCn(5400000))
  ok(u.fmtClock(0) === '00:00', 'fmtClock(0) = 00:00', u.fmtClock(0))
  ok(u.fmtClock(65432) === '01:05', 'fmtClock(65432) = 01:05', u.fmtClock(65432))
  ok(u.fmtClock(3725000) === '1:02:05', 'fmtClock(3725000) = 1:02:05', u.fmtClock(3725000))
  ok(u.truncateText('abcdefghij', 5) === 'abcd…', 'truncateText 截断加省略号', u.truncateText('abcdefghij', 5))
  ok(u.shortPath('~/Codes/a') === '~/Codes/a', 'shortPath 压缩 home', u.shortPath('~/Codes/a'))

  // ---------- 2. 负责人稳定配色 ----------
  ok(u.ownerColorFor('Lead') === '#f59e0b', 'Lead 固定色')
  ok(u.ownerColorFor('auth-ui') === u.ownerColorFor('auth-ui'), 'owner 配色稳定（同名同色）')
  ok(/^#[0-9a-f]{6}$/.test(u.ownerColorFor('some-agent')), 'owner 配色为 hex', u.ownerColorFor('some-agent'))
  ok(u.ownerColorFor('') === '#94a3b8', '空 owner 用默认灰')
  const colorMap = u.buildOwnerColorMap(prep.tasks)
  ok(colorMap.Lead === '#f59e0b' && /^#[0-9a-f]{6}$/.test(colorMap['auth-ui']), 'buildOwnerColorMap 含任务负责人')

  // ---------- 3. S 形任务图布局 ----------
  const flow1 = api.computeFlowLayout(1)
  ok(flow1.rows === 1 && flow1.positions.length === 1, '1 任务：1 行 1 节点')
  ok(flow1.positions[0].x === 40 && flow1.positions[0].y === 46, '1 任务：首节点坐标 = (40,46)', JSON.stringify(flow1.positions[0]))
  ok(flow1.height === 46 + 62 + 26, '1 任务：高度公式', String(flow1.height))
  const flow8 = api.computeFlowLayout(8)
  ok(flow8.rows === 2, '8 任务：2 行', String(flow8.rows))
  ok(flow8.width === 944, '流程图宽度 944（4 列）', String(flow8.width))
  ok(flow8.height === 46 + 2 * 62 + 58 + 26, '8 任务：高度 = 254（保持原型尺寸）', String(flow8.height))
  ok(flow8.nodeHeight === 62 && flow8.gapY === 58, '8 任务（2 行）：原型行高 62 / 行距 58')
  // 偶数行左→右：index 0..3 的 x 递增
  ok(flow8.positions[0].x < flow8.positions[1].x && flow8.positions[1].x < flow8.positions[2].x && flow8.positions[2].x < flow8.positions[3].x, '偶数行左→右')
  // 奇数行右→左（S 形）：index 4 在最右侧，index 7 在最左侧
  ok(flow8.positions[4].x === 40 + 3 * (180 + 48), '奇数行首节点在最右（S 形）', String(flow8.positions[4].x))
  ok(flow8.positions[7].x === 40, '奇数行末节点回到最左', String(flow8.positions[7].x))
  ok(flow8.positions[4].row === 1 && flow8.positions[7].row === 1, '第 5/8 个节点在第二行')
  const flow19 = api.computeFlowLayout(19)
  ok(flow19.rows === 5, '19 任务：5 行', String(flow19.rows))
  ok(flow19.height === 46 + flow19.rows * flow19.nodeHeight + (flow19.rows - 1) * flow19.gapY + 26, '19 任务：高度按压缩行高公式', String(flow19.height))
  ok(flow19.nodeHeight === 50 && flow19.gapY === 32, '19 任务（5 行）：压缩行高 50 / 行距 32', flow19.nodeHeight + '/' + flow19.gapY)
  const flow0 = api.computeFlowLayout(0)
  ok(flow0.rows === 1 && flow0.positions.length === 0, '0 任务：仍返回 1 行空布局')
  const route = api.buildFlowPath(flow8, 8)
  ok(route.startsWith('M') && route.split(' L').length === 8, '执行轨迹路径含 8 个节点', route.slice(0, 40))
  const depPath = api.buildDependencyPath(flow8.positions[0], flow8.positions[7], 180, 62)
  ok(depPath.startsWith('M') && depPath.includes('Q'), '依赖边是二次曲线', depPath)
  const relPath = api.buildRelationPath(flow8.positions[3], flow8.positions[7], 180, 62, 'left')
  ok(relPath.startsWith('M') && relPath.includes('Q'), '关系边是二次曲线', relPath)

  // ---------- 4. 任意时刻状态推导（phases 权威） ----------
  const b = (offset) => base + offset
  const fixtureTasks = [
    { id: 'a', createdAt: b(1000), phases: [{ status: 'pending', at: b(1000) }, { status: 'in_progress', at: b(2000) }, { status: 'completed', at: b(5000) }] },
    { id: 'b', createdAt: b(1200), phases: [{ status: 'pending', at: b(1200) }, { status: 'in_progress', at: b(3000) }, { status: 'failed', at: b(6000) }] },
    { id: 'c', createdAt: b(1000), phases: [{ status: 'pending', at: b(1000) }] },
  ]
  ok(u.statusAtTime(fixtureTasks[0], b(499)) === 'pending', 't=before create → pending')
  ok(u.statusAtTime(fixtureTasks[0], b(1000)) === 'pending', 't=createdAt → pending')
  ok(u.statusAtTime(fixtureTasks[0], b(1999)) === 'pending', 't=before start → pending')
  ok(u.statusAtTime(fixtureTasks[0], b(2000)) === 'in_progress', 't=startedAt → in_progress')
  ok(u.statusAtTime(fixtureTasks[0], b(4999)) === 'in_progress', 't=before done → in_progress')
  ok(u.statusAtTime(fixtureTasks[0], b(5000)) === 'completed', 't=completedAt → completed')
  ok(u.statusAtTime(fixtureTasks[0], b(9000)) === 'completed', 't=after done → completed')
  ok(u.statusAtTime(fixtureTasks[1], b(6000)) === 'failed', '失败任务在 failed 阶段后为 failed')
  ok(u.statusAtTime(null, base) === 'pending', 'null task 容错 pending')
  ok(u.isCreatedAtTime(fixtureTasks[0], b(999)) === false, 'isCreatedAtTime 未来任务 false')
  ok(u.isCreatedAtTime(fixtureTasks[0], b(1000)) === true, 'isCreatedAtTime 创建时刻 true')

  // 任意时刻统计 vs 手算期望（3 任务小样本，独立于实现）
  const counts = (time) => u.countsAtTime(fixtureTasks, time)
  const c0 = counts(b(500))
  ok(c0.created === 0 && c0.pending === 3 && c0.completed === 0, 't=500：未创建 0 / 待开始 3 / 完成 0', JSON.stringify(c0))
  const c1500 = counts(b(1500))
  ok(c1500.created === 3 && c1500.pending === 3 && c1500.in_progress === 0, 't=1500：全部待开始', JSON.stringify(c1500))
  const c2500 = counts(b(2500))
  ok(c2500.in_progress === 1 && c2500.pending === 2 && c2500.completed === 0, 't=2500：1 执行中 2 待开始', JSON.stringify(c2500))
  const c3500 = counts(b(3500))
  ok(c3500.in_progress === 2 && c3500.pending === 1, 't=3500：2 执行中 1 待开始', JSON.stringify(c3500))
  const c5500 = counts(b(5500))
  ok(c5500.completed === 1 && c5500.in_progress === 1 && c5500.pending === 1, 't=5500：1 完成 1 执行中 1 待开始', JSON.stringify(c5500))
  const c6500 = counts(b(6500))
  ok(c6500.completed === 1 && c6500.failed === 1 && c6500.pending === 1, 't=6500：1 完成 1 失败 1 待开始', JSON.stringify(c6500))
  const cEnd = counts(b(9000))
  ok(cEnd.completed === 1 && cEnd.failed === 1 && cEnd.pending === 1 && cEnd.total === 3, 't=end：总览一致', JSON.stringify(cEnd))

  // 任务图节点 class 纯函数
  ok(u.flowNodeClass('completed', {}) === 'tm-node tm-done', 'flowNodeClass completed')
  ok(u.flowNodeClass('in_progress', { selected: true }) === 'tm-node tm-running tm-sel', 'flowNodeClass selected')
  ok(u.flowNodeClass('pending', { future: true }) === 'tm-node tm-pending tm-future', 'flowNodeClass future')
  ok(u.flowNodeClass('failed', {}) === 'tm-node tm-failed', 'flowNodeClass failed')
  ok(u.flowNodeClass('blocked', {}) === 'tm-node tm-blocked', 'flowNodeClass blocked')

  // ---------- 5. 二分查找 ----------
  const times = [1, 3, 5, 7]
  ok(u.lastIndexAtOrBefore(times, 0) === -1, '二分：小于全部 → -1')
  ok(u.lastIndexAtOrBefore(times, 3) === 1, '二分：命中边界 → 1')
  ok(u.lastIndexAtOrBefore(times, 7) === 3, '二分：命中末尾 → 3')
  ok(u.lastIndexAtOrBefore(times, 9) === 3, '二分：大于全部 → 3')
  ok(u.lastIndexAtOrBefore([], 5) === -1, '二分：空数组 → -1')
  ok(u.countAtOrBefore(times, 4) === 2, '二分：<=4 元素数 = 2')
  ok(u.countAtOrBefore(times, 5) === 3, '二分：<=5 元素数 = 3')
  ok(u.countAtOrBefore(times, 0) === 0, '二分：<=0 元素数 = 0')

  // ---------- 6. 执行过程按时间窗推断 ----------
  const windowSpans = u.taskSpansInWindow(
    { startedAt: 1000, completedAt: 5000 },
    [
      { start: 500, end: 1500 },
      { start: 4999, end: 6000 },
      { start: 6000, end: 7000 },
      { start: 2000, end: null },
    ],
    9000,
  )
  ok(windowSpans.length === 3, '时间窗重叠推断：3 条', String(windowSpans.length))
  ok(u.taskSpansInWindow({ startedAt: null }, [{ start: 1, end: 2 }], 3).length === 0, '未开始任务无执行过程')

  // ---------- 7. 回放 store 语义 ----------
  const created = []
  const originalRaf = globalThis.requestAnimationFrame
  const originalCaf = globalThis.cancelAnimationFrame
  let frameQueue = []
  globalThis.requestAnimationFrame = (callback) => { frameQueue.push(callback); return frameQueue.length }
  globalThis.cancelAnimationFrame = () => {}
  try {
    const store = api.createReplayStore({ start: 0, end: 100000 })
    ok(store.getTime() === 100000, 'store 初始时间为 end（最终状态）')
    ok(store.isAtEnd() === true, 'store 初始 isAtEnd')
    created.push(0)
    store.onFrame((moment) => created.push(moment))
    store.setTime(1000)
    ok(store.getTime() === 1000 && created.indexOf(1000) >= 0, 'setTime 触发帧监听', String(created.length))
    ok(store.isAtEnd() === false, 'setTime 到中间后 isAtEnd=false')
    store.setTime(999999)
    ok(store.getTime() === 100000, 'setTime 上限夹紧到 end')
    store.setTime(-50)
    ok(store.getTime() === 0, 'setTime 下限夹紧到 start')
    let throttledCount = 0
    store.onTimeThrottled(() => { throttledCount += 1 }, 200)
    store.setTime(5000)
    ok(throttledCount === 1, '暂停时 onTimeThrottled 立即回调', String(throttledCount))
    store.setSpeed(300)
    ok(store.getSpeed() === 300, 'setSpeed 接受 300×')
    store.setSpeed(777)
    ok(store.getSpeed() === 300, 'setSpeed 拒绝非法倍速（保持 300）')
    store.step(30000)
    ok(store.getTime() === 35000, 'step(+30s) 正确', String(store.getTime()))
    store.step(-30000)
    ok(store.getTime() === 5000, 'step(-30s) 正确', String(store.getTime()))
    store.play()
    ok(store.isPlaying() === true, 'play 后 playing=true')
    ok(frameQueue.length === 1, 'play 调度了 rAF', String(frameQueue.length))
    const tick1 = frameQueue.shift()
    tick1(1000)
    ok(store.getTime() > 5000 && store.getTime() < 100000, 'rAF 推进 currentTime', String(store.getTime()))
    store.pause()
    ok(store.isPlaying() === false, 'pause 后 playing=false')
    // updateRange：followEnd=true 时自动跟到新 end
    const followStore = api.createReplayStore({ start: 0, end: 1000 })
    followStore.updateRange(0, 2000)
    ok(followStore.getTime() === 2000, 'followEnd：投影更新后跟到新 end')
    followStore.setTime(500)
    followStore.updateRange(0, 3000)
    ok(followStore.getTime() === 500, '非 followEnd：投影更新后保持用户时刻')
    followStore.updateRange(0, 200)
    ok(followStore.getTime() === 200, '非 followEnd：时刻超出新范围时夹紧')
    followStore.dispose()
    store.dispose()
  } finally {
    globalThis.requestAnimationFrame = originalRaf
    globalThis.cancelAnimationFrame = originalCaf
  }

  // ---------- 8. prepareView 容错 / 降级字段 ----------
  const emptyPrep = api.prepareView(null)
  ok(emptyPrep.ok === true && emptyPrep.empty === true, 'null view → 空视图不抛错')
  ok(emptyPrep.dataSource === 'none' && emptyPrep.emptyReason === 'no-task-board', 'null view → dataSource=none')
  ok(emptyPrep.timeEnd > emptyPrep.timeStart, 'null view → 时间范围有效')
  ok(emptyPrep.tasks.length === 0 && emptyPrep.flow.height > 0, 'null view → 空任务与合法布局')

  const degraded = api.prepareView(Object.assign({}, mock.view, {
    spansTruncated: true,
    spanSummary: { total: 900, kept: 120, omitted: 780, tool: 800, job: 90, approval: 10, open: 2, error: 3, killed: 0 },
    viewLevel: { description: 60, spans: 120 },
    warnings: [{ code: 'blocker-missing', taskId: 'task-4', blocker: 'task-x' }],
  }))
  ok(degraded.spansTruncated === true, 'prepareView 保留 spansTruncated')
  ok(degraded.spanSummary.total === 900 && degraded.spanSummary.omitted === 780, 'prepareView 保留 spanSummary')
  ok(degraded.viewLevel.spans === 120 && degraded.viewLevel.description === 60, 'prepareView 保留 viewLevel')
  ok(degraded.warnings.length === 1, 'prepareView 保留 warnings')

  const todoView = api.prepareView({
    dataSource: 'todo',
    hasTeamBoard: false,
    tasks: [{ id: 'todo-1', subject: 'TODO 1', status: 'pending', createdAt: base + 10 }],
    timeRange: { start: base, end: base + 1000 },
    asOfTime: base + 1000,
  })
  ok(todoView.dataSource === 'todo' && todoView.empty === false, 'todo 降级：有任务不算空')
  ok(todoView.stats.total === 1, 'todo 降级：stats 由任务重算')
  ok(todoView.flow.rows === 1, 'todo 降级：单任务单行')

  const missingRange = api.prepareView({
    tasks: [
      { id: 'a', createdAt: base + 500, startedAt: base + 800, completedAt: base + 1200, status: 'completed', phases: [{ status: 'pending', at: base + 500 }, { status: 'completed', at: base + 1200 }] },
    ],
  })
  ok(missingRange.timeStart === base + 500, '缺 timeRange：start 回退到最早任务时间', String(missingRange.timeStart))
  ok(missingRange.timeEnd === base + 1200, '缺 timeRange：end 回退到最晚任务时间', String(missingRange.timeEnd))

  const big = api.prepareView({ tasks: Array.from({ length: 19 }, (_, index) => ({ id: 't' + index, subject: 'T' + index, status: 'pending', createdAt: base + index })) })
  ok(big.flow.rows === 5, '19 任务视图：5 行', String(big.flow.rows))

  // ---------- 8.5 尾部「收尾记录」剔除（真实历史会话的 session/end-seed 长尾） ----------
  const tailView = {
    tasks: [{
      id: 't1', status: 'completed', createdAt: base + 1000, startedAt: base + 2000, completedAt: base + 3000,
      phases: [{ status: 'pending', at: base + 1000 }, { status: 'in_progress', at: base + 2000 }, { status: 'completed', at: base + 3000 }],
    }],
    turns: [{ turn: 1, start: base + 900, end: base + 4000 }],
    timeRange: { start: base, end: base + 600000 },
    asOfTime: base + 600000,
  }
  const tailPrep = api.prepareView(tailView)
  ok(tailPrep.tailTrimmed === true, '尾部收尾记录 >5min → tailTrimmed=true')
  ok(tailPrep.timeEnd === base + 4000, '回放终点回退到最后活动时刻（600s→4s）', String(tailPrep.timeEnd - base))
  ok(tailPrep.rawTimeEnd === base + 600000, '原始投影结束时间保留在 rawTimeEnd', String(tailPrep.rawTimeEnd - base))
  ok(tailPrep.tailMs === 596000, 'tailMs = 原始终点 - 最后活动', String(tailPrep.tailMs))
  ok(tailPrep.durationMs === 4000, '内容时长 = 最后活动 - start', String(tailPrep.durationMs))
  ok(tailPrep.rawDurationMs === 600000, '原始时长仍可读', String(tailPrep.rawDurationMs))

  const smallTailView = Object.assign({}, tailView, { timeRange: { start: base, end: base + 200000 }, asOfTime: base + 200000 })
  const smallTailPrep = api.prepareView(smallTailView)
  ok(smallTailPrep.tailTrimmed === false, '尾部 <5min → 不剔除')
  ok(smallTailPrep.timeEnd === base + 200000, '尾部 <5min → 回放终点保留投影 end')
  ok(smallTailPrep.durationMs === 200000, '尾部 <5min → 内容时长 = 投影跨度')

  const noActivityPrep = api.prepareView({ tasks: [], asOfTime: base + 900000, timeRange: { start: base, end: base + 900000 } })
  ok(noActivityPrep.tailTrimmed === false && noActivityPrep.timeEnd === base + 900000, '无活动数据 → 不误判收尾长尾')

  // liveMode：投影结束时间接近当前时刻 → 实时（已跑 X 用 Date.now 计时）
  ok(prep.liveMode === false, '历史会话（mock）liveMode=false')
  const livePrep = api.prepareView({
    tasks: [{ id: 'x', status: 'in_progress', createdAt: Date.now() - 9000, startedAt: Date.now() - 8000, phases: [{ status: 'pending', at: Date.now() - 9000 }, { status: 'in_progress', at: Date.now() - 8000 }] }],
    timeRange: { start: Date.now() - 10000, end: Date.now() - 1000 },
    asOfTime: Date.now() - 1000,
  })
  ok(livePrep.liveMode === true, '近期会话 liveMode=true')

  // ---------- 8.6 甘特时间轴布局（W2.3） ----------
  const tlApi = api.timeline
  ok(tlApi.TIMELINE.W === 960 && tlApi.TIMELINE.X0 === 132 && tlApi.TIMELINE.X1 === 944, '甘特画布常量（960 / 132–944）')
  ok(tlApi.chooseTickStep(5000) === 1000, '5s 会话：1s 刻度', String(tlApi.chooseTickStep(5000)))
  ok(tlApi.chooseTickStep(42000) === 5000, '42s 会话：5s 刻度', String(tlApi.chooseTickStep(42000)))
  ok(tlApi.chooseTickStep(5 * 60 * 1000) === 60000, '5min 会话：1min 刻度', String(tlApi.chooseTickStep(300000)))
  ok(tlApi.chooseTickStep(5.22e6) === 600000, '87min 会话：10min 刻度', String(tlApi.chooseTickStep(5220000)))
  ok(tlApi.chooseTickStep(1.26e7) === 1800000, '3.5h 会话：30min 刻度', String(tlApi.chooseTickStep(12600000)))
  const tickData = tlApi.buildTimelineTicks(base, base + 60000)
  ok(tickData.step === 10000 && tickData.ticks.length === 7, '1min 范围 → 7 个 10s 刻度（含 0:00）', tickData.ticks.length + '@' + tickData.step)
  ok(tickData.ticks[0].label === '00:00' && tickData.ticks[6].label === '01:00', '刻度标签为相对会话开始时间', tickData.ticks[0].label)

  const layout = tlApi.computeTimelineLayout({
    tasks: prep.tasks,
    members: prep.members,
    spans: prep.spans,
    milestones: prep.milestones,
    start: prep.timeStart,
    end: prep.timeEnd,
  })
  ok(layout.start === prep.timeStart && layout.end === prep.timeEnd, '甘特时间范围 = 投影回放范围')
  ok(layout.taskRows.length === 8 && layout.memberRows.length === 3, '甘特行数：任务 8 / 代理 3', layout.taskRows.length + '/' + layout.memberRows.length)
  ok(layout.groups.tasks.label === '任务 8' && layout.groups.members.label === '代理 3', '甘特分组标题', layout.groups.tasks.label)
  let yMonotonic = true
  for (let index = 1; index < layout.taskRows.length; index += 1) {
    if (!(layout.taskRows[index].y > layout.taskRows[index - 1].y)) yMonotonic = false
  }
  ok(yMonotonic, '任务行 y 单调递增')
  ok(layout.taskRows[0].y === layout.tasksY0 && layout.taskRows[7].y === layout.tasksY0 + 7 * layout.rowH, '任务行 y = tasksY0 + index*rowH')
  ok(layout.membersY0 > layout.taskRows[7].y && layout.groups.events.y > layout.membersY0 && layout.groups.density.y > layout.groups.events.y, '甘特分组纵向顺序：任务→代理→事件→热度')
  ok(layout.height > layout.densityY0 + 6, '甘特总高度覆盖热度行')
  ok(layout.memberRows[0].member.name === 'auth-ui', '代理行保持投影顺序')
  ok(tlApi.timelineX(layout, layout.start) === layout.x0, 'timelineX(start) = x0')
  ok(Math.abs(tlApi.timelineX(layout, layout.end) - layout.x1) < 0.001, 'timelineX(end) = x1')
  ok(layout.ticks.length > 0 && layout.ticks.every((tick) => tick.x >= layout.x0 - 1 && tick.x <= layout.x1 + 1), '刻度 x 落在画布内')
  ok(layout.events.length === 5, '事件行：审批 1 + 交付 1 + 启动代理 3 = 5', String(layout.events.length))
  const kinds = layout.events.map((event) => event.kind)
  ok(kinds.indexOf('approval') >= 0 && kinds.indexOf('deliverable') >= 0 && kinds.indexOf('spawn') >= 0, '事件行包含审批/交付/启动三类', kinds.join(','))
  ok(layout.events.every((event, index) => index === 0 || layout.events[index - 1].at <= event.at), '事件按时间升序')
  ok(layout.density.length >= 24 && layout.density.length <= 64, '热度桶数量 24~64', String(layout.density.length))
  ok(layout.density.some((bucket) => bucket.ratio > 0), '热度桶有覆盖')
  ok(layout.density.some((bucket) => bucket.ratio === 1), '热度桶归一化峰值 = 1')

  // 会话前空闲带（会话创建→首轮开工）
  ok(prep.timeline.idle !== null && prep.timeline.idle.width > 0, 'mock 视图：会话前空闲带有宽度', String(prep.timeline.idle && prep.timeline.idle.width))
  ok(prep.timeline.idle && prep.timeline.idle.label.indexOf('会话创建→开工') === 0, '空闲带文案「会话创建→开工 X」', prep.timeline.idle && prep.timeline.idle.label)
  const noIdleLayout = tlApi.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, spans: prep.spans, milestones: prep.milestones, start: prep.timeStart, end: prep.timeEnd, idleLeadMs: 0 })
  ok(noIdleLayout.idle === null, 'idleLeadMs=0 → 不渲染空闲带')
  const shortIdleLayout = tlApi.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, spans: prep.spans, milestones: prep.milestones, start: prep.timeStart, end: prep.timeEnd, idleLeadMs: 30000 })
  ok(shortIdleLayout.idle === null, '空闲 <1min → 不渲染空闲带（避免噪音）')

  // 甘特任务几何（任意时刻）
  const gTask = prep.taskById['task-5'] // start 100000, done 700000
  const geomMid = tlApi.ganttTaskGeometry(gTask, layout, mock.base + 300000)
  ok(geomMid.barVisible && geomMid.barW > 0 && geomMid.waitW > 0, '执行中任务：排队段 + 执行段都有宽度')
  ok(geomMid.doneVisible === false, '未完成时刻不显示完成菱形')
  const geomDone = tlApi.ganttTaskGeometry(gTask, layout, mock.base + 800000)
  ok(geomDone.doneVisible === true && geomDone.barW > geomMid.barW, '完成时刻显示菱形且执行段更长')
  const geomPending = tlApi.ganttTaskGeometry(prep.taskById['task-6'], layout, mock.base + 300000)
  ok(geomPending.barVisible === false && geomPending.barW === 0, '未开始任务：无执行实段')
  const geomFuture = tlApi.ganttTaskGeometry(prep.taskById['task-8'], layout, mock.base + 300000)
  ok(geomFuture.waitW === 0, '未创建任务：排队段宽度 0（不剧透）')

  // ---------- 8.9 200 任务降级/性能形状 ----------
  const bigTasks = Array.from({ length: 200 }, (_, index) => ({
    id: 'big-' + index,
    subject: '大任务 ' + index,
    status: index < 120 ? 'completed' : 'pending',
    owner: 'agent-' + (index % 7),
    createdAt: base + index * 1000,
    startedAt: index < 120 ? base + index * 1000 + 500 : null,
    completedAt: index < 120 ? base + index * 1000 + 900 : null,
    phases: index < 120
      ? [{ status: 'pending', at: base + index * 1000 }, { status: 'in_progress', at: base + index * 1000 + 500 }, { status: 'completed', at: base + index * 1000 + 900 }]
      : [{ status: 'pending', at: base + index * 1000 }],
  }))
  const bigView = { tasks: bigTasks, timeRange: { start: base, end: base + 200000 }, asOfTime: base + 200000, turns: [{ turn: 1, start: base, end: base + 199000 }] }
  const bigStart = Date.now()
  const bigPrep = api.prepareView(bigView)
  const bigElapsed = Date.now() - bigStart
  ok(bigPrep.tasks.length === 200, '200 任务视图：任务数 200', String(bigPrep.tasks.length))
  ok(bigPrep.flow.rows === 50, '200 任务视图：流程图 50 行（滚动/降级）', String(bigPrep.flow.rows))
  ok(bigPrep.timeline.taskRows.length === 200 && bigPrep.timeline.height > 3000, '200 任务视图：甘特 200 行、总高度可控', String(bigPrep.timeline.height))
  ok(api.constants.GANTT_WINDOW_THRESHOLD === 80, '甘特窗口化阈值 = 80 行')
  ok(bigElapsed < 300, '200 任务视图 prepareView < 300ms（实测 ' + bigElapsed + 'ms）')
  // 任意时刻统计 O(n) 循环 200 任务仍为微秒级
  const countsStart = Date.now()
  for (let index = 0; index < 500; index += 1) api.utils.countsAtTime(bigPrep.tasks, base + (index % 200) * 1000)
  const countsElapsed = Date.now() - countsStart
  ok(countsElapsed < 200, '200 任务 × 500 次任意时刻统计 < 200ms（实测 ' + countsElapsed + 'ms）')

  // ---------- 8.7 详情/总览纯函数（状态区间截断、交接、活跃代理） ----------
  const phaseTask = {
    id: 'p1',
    createdAt: base,
    phases: [
      { status: 'pending', at: base + 1000 },
      { status: 'in_progress', at: base + 5000 },
      { status: 'completed', at: base + 9000 },
    ],
  }
  const intervalsMid = u.buildPhaseIntervals(phaseTask, base + 7000)
  ok(intervalsMid.length === 2, '回放中段只返回已发生的阶段区间', String(intervalsMid.length))
  ok(intervalsMid[0].status === 'pending' && intervalsMid[0].to === base + 5000, '已关闭区间保留真实结束时间')
  ok(intervalsMid[1].status === 'in_progress' && intervalsMid[1].open === true, '跨回放时刻的区间标记为 open')
  ok(intervalsMid[1].ms === 2000, 'open 区间时长 = currentTime - from（截至回放时刻）', String(intervalsMid[1].ms))
  const intervalsEnd = u.buildPhaseIntervals(phaseTask, base + 20000)
  ok(intervalsEnd.length === 3 && intervalsEnd[2].status === 'completed', '终点时刻返回全部 3 个阶段区间')
  ok(intervalsEnd[2].from === base + 9000 && intervalsEnd[2].to === null, '最后状态区间从 completed 时刻起 open 到回放终点')
  const intervalsEarly = u.buildPhaseIntervals(phaseTask, base + 500)
  ok(intervalsEarly.length === 0, '创建前无状态区间（不剧透）')

  const handoffWaits = { handoffs: [{ from: 'a', to: 't', gapMs: 9000 }, { from: 'b', to: 't', gapMs: 2000 }, { from: 'c', to: 'x', gapMs: 1000 }] }
  const handoff = u.handoffForTask(handoffWaits, 't')
  ok(handoff && handoff.from === 'b' && handoff.gapMs === 2000, '交接间隔取最近一次（最小 gap）', JSON.stringify(handoff))
  ok(u.handoffForTask(handoffWaits, 'nope') === null, '无交接记录返回 null')

  const membersFixture = [
    { id: 'm1', name: 'a', phase: 'active', phases: [{ phase: 'provisioning', at: base + 1000 }, { phase: 'active', at: base + 2000 }], createdAt: base + 1000 },
    { id: 'm2', name: 'b', phase: 'failed', phases: [{ phase: 'provisioning', at: base + 1000 }, { phase: 'failed', at: base + 3000 }], createdAt: base + 1000 },
  ]
  ok(u.activeMembersAt(membersFixture, base + 1500).length === 0, '回放早期无活跃代理')
  ok(u.activeMembersAt(membersFixture, base + 4000).length === 1 && u.activeMembersAt(membersFixture, base + 4000)[0].name === 'a', '回放后期活跃代理 = a')
  ok(u.memberPhaseAt(membersFixture[1], base + 4000).phase === 'failed', 'memberPhaseAt 返回最后阶段')
  ok(u.memberPhaseAt(membersFixture[0], base + 500) === null, 'memberPhaseAt 创建前返回 null')

  // ---------- 8.8 宿主可视高度（client.js useHostFitHeight 结构式测量的纯函数不变量） ----------
  // 结构式：H = scrollBody clientHeight - 根节点顶部偏移 - 根节点之后兄弟内容（composer 等）。
  // 真实宿主几何（1680×1050）：scrollBody clientHeight=974、topOffset=0、下方 composer=180 → 794。
  const fit1 = u.computeFitHeight(974, 0, 180, 1050)
  ok(fit1 === 794, 'fit height = clientHeight - topOffset - below', String(fit1))
  ok(fit1 >= 360 && fit1 <= 1050 - 60, 'fit height 落在 [360, innerHeight-60]', String(fit1))
  // 同一页面 resize 到 2560×1440（新 clientHeight=1364、composer≈180）→ 1184，随窗口增大而增大（修复「resize 后根高不变」）
  const fitBig = u.computeFitHeight(1364, 0, 180, 1440)
  ok(fitBig === 1184, 'resize 放大后 fit height 重算为 1184', String(fitBig))
  ok(fitBig > fit1 + 300, 'resize 后 fit height 明显增大（>300px）', String(fitBig - fit1))
  ok(u.computeFitHeight(974, 0, 180, 1050) === 794, '重复测量结果稳定（无抖动）')
  // 顶部偏移（滚动容器内 root 上方有内容）也参与计算
  const fitOffset = u.computeFitHeight(800, 60, 100, 900)
  ok(fitOffset === 640, 'fit height 扣除顶部偏移/下方内容', String(fitOffset))
  // 下限保护：可用空间不足 360 时仍给 360（交给宿主滚动）
  const fit3 = u.computeFitHeight(300, 0, 0, 900)
  ok(fit3 === 360, 'fit height 下限 360', String(fit3))
  // 上限保护：极端小窗口不超过 innerHeight-60
  const fit4 = u.computeFitHeight(900, 0, 0, 500)
  ok(fit4 === 440, 'fit height 上限 innerHeight-60', String(fit4))
  // 字段缺失/NaN 容错
  const fit5 = u.computeFitHeight(undefined, undefined, undefined, undefined)
  ok(fit5 === 360, 'fit height 字段缺失时保底 360（不抛错）', String(fit5))

  // ---------- 8.10 变更流：基线/日志排序/as-of 过滤/NEW/计划 Ghost ----------
  ok(prep.baseline && prep.baseline.closedAt === base + 80000 && prep.baseline.seq === 7, 'baseline 归一化：closedAt/seq 保留')
  ok(prep.baseline.taskIds.length === 7 && prep.baseline.open === false, 'baseline 归一化：计划 7 个任务')
  ok(prep.changes.log.length === 3, '变更日志 3 条', String(prep.changes.log.length))
  ok(prep.changes.log[0].kind === 'dependency' && prep.changes.log[1].kind === 'split' && prep.changes.log[2].kind === 'added',
    '变更日志按 at/seq 升序（dependency 605s → split/added 610s）', prep.changes.log.map((e) => e.kind).join(','))
  ok(prep.changes.counts.planned === 7 && prep.changes.counts.added === 1 && prep.changes.counts.splits === 1,
    'changes.counts 归一化', JSON.stringify(prep.changes.counts))
  ok(prep.changes.splits[0].parent === 'task-4' && prep.changes.splits[0].children[0] === 'task-8', 'splits 归一化')

  // 未排序输入 → 归一化后按 at/seq 排序
  const unsorted = u.normalizeChanges({
    log: [
      { at: base + 3000, seq: 2, kind: 'added', taskId: 'x' },
      { at: base + 1000, seq: 5, kind: 'split', taskId: 'p', children: ['c'] },
      { at: base + 1000, seq: 1, kind: 'dependency', taskId: 'd', from: ['a'], to: ['b'] },
    ],
  }, { taskIds: ['a', 'b'] })
  ok(unsorted.log.length === 3 && unsorted.log[0].seq === 1 && unsorted.log[1].seq === 5 && unsorted.log[2].seq === 2,
    'normalizeChanges 对乱序日志按 at/seq 重排', unsorted.log.map((e) => e.seq).join(','))
  ok(unsorted.counts.planned === 2, 'normalizeChanges 无 counts 时用 baseline 计划数兜底', String(unsorted.counts.planned))
  ok(unsorted.log[0].from[0] === 'a' && unsorted.log[0].to[0] === 'b', 'dependency 条目保留 from/to')
  ok(unsorted.log[1].children[0] === 'c', 'split 条目保留 children')

  // as-of 过滤（严格 > currentTime 才是未来）
  const middle = base + 100000
  ok(u.visibleChangeLog(prep.changes, middle).length === 0, '回放早期（100s）：可见变更 0 条')
  ok(u.visibleChangeLog(prep.changes, base + 604999).length === 0, '边界前 1ms：可见变更 0 条')
  ok(u.visibleChangeLog(prep.changes, base + 605000).length === 1, '边界 = dependency.at：可见 1 条')
  ok(u.visibleChangeLog(prep.changes, base + 609999).length === 1, 'split/added 之前：可见 1 条')
  ok(u.visibleChangeLog(prep.changes, base + 610000).length === 3, '边界 = split/added.at：可见 3 条（含 at==currentTime）')
  ok(u.visibleChangeLog(prep.changes, prep.timeEnd).length === 3, '终点：可见 3 条')

  const countsEarly = u.asOfChangeCounts(prep, middle)
  ok(countsEarly.visible === 0 && countsEarly.hidden === 3, 'as-of 计数（早期）：visible 0 / hidden 3', JSON.stringify(countsEarly))
  ok(countsEarly.added === 0 && countsEarly.splits === 0 && countsEarly.dependencyChanged === 0, 'as-of 计数（早期）：各分类 0')
  ok(countsEarly.planned === 7, 'as-of 计数：planned 恒为基线数 7')
  const countsDep = u.asOfChangeCounts(prep, base + 605000)
  ok(countsDep.visible === 1 && countsDep.dependencyChanged === 1 && countsDep.added === 0, 'as-of 计数（605s）：依赖变更 1')
  const countsFull = u.asOfChangeCounts(prep, prep.timeEnd)
  ok(countsFull.visible === 3 && countsFull.hidden === 0 && countsFull.added === 1 && countsFull.splits === 1 && countsFull.dependencyChanged === 1,
    'as-of 计数（终点）：3 条 / 新增 1 / 拆分 1 / 依赖 1', JSON.stringify(countsFull))

  // task 变更历史
  ok(u.taskChangeEntries(prep, 'task-8', prep.timeEnd).length === 2, 'task-8 变更历史 = 新增 + 被拆分 2 条',
    String(u.taskChangeEntries(prep, 'task-8', prep.timeEnd).length))
  ok(u.taskChangeEntries(prep, 'task-8', middle).length === 0, 'task-8 回放早期无变更历史（不剧透）')
  ok(u.taskChangeEntries(prep, 'task-7', prep.timeEnd).length === 1, 'task-7 变更历史 = 依赖变更 1 条')
  ok(u.taskChangeEntries(prep, 'task-1', prep.timeEnd).length === 0, '无变更任务历史为空')

  // NEW 标记出现时刻 / 计划 Ghost
  const newTask = prep.taskById['task-8'] // createdAt = 610000
  ok(u.isNewBadgeVisible(newTask, base + 609999) === false, 'NEW：createdAt 前一帧不显示')
  ok(u.isNewBadgeVisible(newTask, base + 610000) === true, 'NEW：createdAt 当帧显示')
  ok(u.isNewBadgeVisible(newTask, prep.timeEnd) === true, 'NEW：之后持续显示')
  ok(u.isNewBadgeVisible(prep.taskById['task-1'], prep.timeEnd) === false, 'NEW：非新增任务不显示')
  ok(u.isPlannedTask(newTask, base + 609999) === true, 'Ghost：createdAt 前为计划未创建')
  ok(u.isPlannedTask(newTask, base + 610000) === false, 'Ghost：createdAt 当帧不再计划')
  ok(u.isPlannedTask(prep.taskById['task-1'], base + 500) === true, 'Ghost：早于创建的任务标记计划')
  ok(u.isPlannedTask(prep.taskById['task-1'], base + 1000) === false, 'Ghost：创建当帧不再计划')

  // 变更条目文案/跳转目标
  ok(u.changeKindLabel('added') === '新增' && u.changeKindLabel('split') === '拆分' && u.changeKindLabel('dependency') === '依赖变更' && u.changeKindLabel('removed') === '移除', '变更类型中文标签')
  ok(u.changeTargetTaskId({ kind: 'split', taskId: 'task-4', children: ['task-8'] }, prep.taskById) === 'task-4', '拆分条目跳转父任务')
  ok(u.changeTargetTaskId({ kind: 'split', taskId: 'missing', children: ['task-8'] }, prep.taskById) === 'task-8', '拆分父任务缺失时跳转子任务')
  ok(u.changeTargetTaskId({ kind: 'added', taskId: 'task-8' }, prep.taskById) === 'task-8', '新增条目跳转新任务')
  ok(u.changeTargetTaskId({ kind: 'removed', taskId: 'task-x' }, prep.taskById) === '', '移除条目无跳转目标')

  // ---------- 8.11 W3.3：19 任务性能/帧预算、异常字段容错、长文案 ----------
  const perfBase = base
  const perfTasks = Array.from({ length: 19 }, (_, index) => ({
    id: 'p-' + index,
    subject: '长会话任务 ' + index + '（合成性能样本）',
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
    timeRange: { start: perfBase, end: perfBase + 60000 },
    asOfTime: perfBase + 60000,
    turns: [{ turn: 1, start: perfBase, end: perfBase + 59000 }],
    spans: Array.from({ length: 120 }, (_, index) => ({ kind: index % 3 === 0 ? 'job' : 'tool', name: 'bash', label: 'bash', start: perfBase + index * 400, end: perfBase + index * 400 + 220, status: 'ok' })),
  }
  const perfStartAt = Date.now()
  const perfPrep2 = api.prepareView(perfView)
  const perfPrepMs = Date.now() - perfStartAt
  ok(perfPrep2.tasks.length === 19 && perfPrep2.flow.rows === 5, '19 任务视图：19 任务 / 5 行')
  ok(perfPrep2.timeline.taskRows.length === 19, '19 任务视图：甘特 19 行')
  ok(perfPrepMs < 200, '19 任务 prepareView < 200ms（实测 ' + perfPrepMs + 'ms）')

  // 回放帧预算：一帧 = 19 任务状态推导 + 甘特几何（不含 React 渲染）
  const frameCount = 500
  const frameStartAt = Date.now()
  let frameChecksum = 0
  for (let frame = 0; frame < frameCount; frame += 1) {
    const moment = perfBase + (frame % 60) * 1000
    frameChecksum += u.countsAtTime(perfPrep2.tasks, moment).completed
    for (const task of perfPrep2.tasks) {
      frameChecksum += u.statusAtTime(task, moment).length
      const geometry = api.timeline.ganttTaskGeometry(task, perfPrep2.timeline, moment)
      frameChecksum += geometry.waitW > 0 ? 1 : 0
    }
  }
  const frameMsPerFrame = (Date.now() - frameStartAt) / frameCount
  ok(frameMsPerFrame < 2, '19 任务单帧纯计算 < 2ms（实测 ' + frameMsPerFrame.toFixed(3) + 'ms/帧，可支撑 55fps）')
  ok(frameChecksum > 0, '帧预算模拟顺利完成（checksum 非空）')

  // 200 任务降级后的帧预算
  const bigForFrame = Array.from({ length: 200 }, (_, index) => ({
    id: 'bf-' + index,
    status: index < 150 ? 'completed' : 'pending',
    createdAt: perfBase + index * 100,
    startedAt: index < 150 ? perfBase + index * 100 + 20 : null,
    completedAt: index < 150 ? perfBase + index * 100 + 80 : null,
    phases: index < 150
      ? [{ status: 'pending', at: perfBase + index * 100 }, { status: 'completed', at: perfBase + index * 100 + 80 }]
      : [{ status: 'pending', at: perfBase + index * 100 }],
  }))
  const bigPrep2 = api.prepareView({ tasks: bigForFrame, timeRange: { start: perfBase, end: perfBase + 30000 }, asOfTime: perfBase + 30000 })
  const bigFrameStart = Date.now()
  for (let frame = 0; frame < 100; frame += 1) {
    const moment = perfBase + (frame % 30) * 1000
    u.countsAtTime(bigPrep2.tasks, moment)
    for (const task of bigPrep2.tasks) api.timeline.ganttTaskGeometry(task, bigPrep2.timeline, moment)
  }
  const bigFrameMs = (Date.now() - bigFrameStart) / 100
  ok(bigFrameMs < 6, '200 任务降级单帧纯计算 < 6ms（实测 ' + bigFrameMs.toFixed(3) + 'ms/帧）')

  // 异常字段容错（纯函数）
  const blankPrep = api.prepareView({})
  ok(blankPrep.empty === true && blankPrep.tasks.length === 0 && blankPrep.changes.log.length === 0, '空对象视图：空态 + 空变更流')
  const typeBadPrep = api.prepareView({ tasks: 'nope', taskStats: 42, timeRange: null, waits: 'x', changes: 'y', baseline: 7 })
  ok(typeBadPrep.empty === true && typeBadPrep.baseline === null && typeBadPrep.changes.added.length === 0, '类型异常字段：全部降级为默认值')
  const partialPrep = api.prepareView({
    tasks: [{ id: 'partial-1' }, null, 7],
    asOfTime: base + 1000,
    timeRange: { start: base, end: base + 1000 },
    changes: { log: [{ at: base + 500, kind: 'added', taskId: 'partial-1', text: '新增 partial-1' }] },
  })
  ok(partialPrep.tasks.length === 1 && partialPrep.tasks[0].status === 'pending', '最小任务字段（无 phases/时间）：归一化为 pending')
  ok(partialPrep.flow.positions.length === 1 && partialPrep.timeline.taskRows.length === 1, '最小任务视图：图/甘特均有 1 行')
  ok(partialPrep.changes.log.length === 1 && partialPrep.changes.log[0].kind === 'added', '仅 log 的变更流可归一化')
  ok(u.visibleChangeLog(partialPrep.changes, base + 400).length === 0 && u.visibleChangeLog(partialPrep.changes, base + 500).length === 1, '最小变更流 as-of 边界正确')
  ok(partialPrep.warnings.length === 0, '最小视图 warnings 为空数组（不崩）')

  // 长文案：截断与原始数据保留
  const longSubject = '很长的任务标题'.repeat(40)
  ok(u.truncateText(longSubject, 16).length <= 16, '长标题截断到 ≤16 字符（含省略号）')
  ok(u.truncateText(longSubject, 16).endsWith('…'), '长标题截断带省略号')
  const longPrep2 = api.prepareView({
    tasks: [{ id: 'long-1', subject: longSubject, createdAt: base, phases: [{ status: 'pending', at: base }] }],
    timeRange: { start: base, end: base + 1000 },
    asOfTime: base + 1000,
  })
  ok(longPrep2.tasks[0].subject.length > 100, '视图保留原始长标题（渲染层截断，<title>/tooltip 可读全量）', String(longPrep2.tasks[0].subject.length))

  // 帧耗时采样（store）
  const timingStore = api.createReplayStore({ start: 0, end: 1000 })
  timingStore.onFrame(() => {})
  timingStore.setTime(500)
  ok(Number.isFinite(timingStore.getFrameMs()) && timingStore.getFrameMs() >= 0, 'store.getFrameMs() 可采样帧耗时', String(timingStore.getFrameMs()))
  timingStore.dispose()

  // ---------- 8.12 W4.3 关系层：父/子视图、有效性、计数口径 ----------
  ok(prep.stateVersion === 4, 'v1.1 视图 stateVersion=4 被接受（STATE_VERSION 4）', String(prep.stateVersion))
  ok(prep.relations.length === 1 && prep.relations[0].source === 'tool', 'relations 归一化保留 source=tool')
  ok(prep.relations[0].valid === true && prep.relations[0].missing.length === 0, '有效关系 valid=true / missing 为空')
  ok(prep.relations[0].kind === 'split' && prep.relations[0].note.length > 0, '关系 kind/note 保留')
  ok(u.relationBadgeCount(prep, 'task-4') === 1, '父任务 task-4 支线数 = 1', String(u.relationBadgeCount(prep, 'task-4')))
  ok(u.relationBadgeCount(prep, 'task-1') === 0, '无支线任务 badge = 0')
  ok(u.relationParentOf(prep, 'task-8') === 'task-4', '子任务 task-8 的父任务 = task-4')
  ok(u.relationParentOf(prep, 'task-1') === '', '无关系任务 parent = 空')
  const kidsOf4 = u.relationChildrenOf(prep, 'task-4')
  ok(kidsOf4.length === 1 && kidsOf4[0].id === 'task-8', 'relationChildrenOf 返回子任务对象')
  ok(prep.relation.childRelations['task-8'][0].parent === 'task-4', 'childRelations 保留父任务与 note')

  // 无效关系（valid=false + 存在性兜底）
  const invalidView = {
    tasks: [{ id: 'task-1', subject: 'A', status: 'completed', createdAt: base + 1000, phases: [{ status: 'pending', at: base + 1000 }, { status: 'completed', at: base + 2000 }] }],
    relations: [
      { parent: 'task-1', children: ['task-404'], kind: 'split', note: '坏引用', recordedAt: base + 3000, seq: 1, source: 'tool', valid: false },
      { parent: 'task-404', children: ['task-1'], kind: 'subtask', note: '父不存在', recordedAt: base + 4000, seq: 2, source: 'tool', valid: false },
      { parent: 'task-1', children: ['task-404'], kind: 'split', note: 'valid 标记为 true 但子任务不存在', recordedAt: base + 5000, seq: 3, source: 'tool', valid: true },
    ],
    timeRange: { start: base, end: base + 10000 },
    asOfTime: base + 10000,
  }
  const invalidPrep = api.prepareView(invalidView)
  ok(invalidPrep.relations.length === 3 && invalidPrep.relations.every((relation) => relation.valid === false), '存在性兜底：3 条关系均判为无效')
  ok(invalidPrep.relation.invalidRelations.length === 3, 'invalidRelations 收集 3 条（供 warnings/局部提示）', String(invalidPrep.relation.invalidRelations.length))
  ok(invalidPrep.relation.parentChildCount['task-1'] === undefined, '无效关系不计入支线 badge 数')
  ok(invalidPrep.relation.childParent['task-1'] === undefined, '无效关系不建立父子映射')
  ok(invalidPrep.relation.invalidRelations[0].missing.indexOf('task-404') >= 0, 'invalidRelations 记录缺失 id')

  // 重复 relation 去重（badge 计数不重复）
  const dupView = {
    tasks: [
      { id: 'p', subject: 'P', createdAt: base + 1000, phases: [{ status: 'pending', at: base + 1000 }] },
      { id: 'c1', subject: 'C1', createdAt: base + 2000, phases: [{ status: 'pending', at: base + 2000 }] },
    ],
    relations: [
      { parent: 'p', children: ['c1'], kind: 'split', recordedAt: base + 3000, seq: 1, source: 'tool', valid: true },
      { parent: 'p', children: ['c1'], kind: 'subtask', recordedAt: base + 4000, seq: 2, source: 'tool', valid: true },
    ],
    timeRange: { start: base, end: base + 10000 },
    asOfTime: base + 10000,
  }
  const dupPrep = api.prepareView(dupView)
  ok(u.relationBadgeCount(dupPrep, 'p') === 1, '重复引用同一子任务：badge 去重为 1')
  ok(u.relationChildrenOf(dupPrep, 'p').length === 1, 'relationChildrenOf 去重')
  ok(dupPrep.relation.byParent['p'].length === 2, 'byParent 保留 2 条关系记录（详情逐条展示）')

  // 计数口径：chips 按 log（dependencyChanged 数组可能按任务去重）
  const countView = {
    tasks: [{ id: 't1', createdAt: base + 1000, phases: [{ status: 'pending', at: base + 1000 }] }],
    changes: {
      added: [], removed: [],
      dependencyChanged: [{ id: 't1', from: [], to: ['x'], at: base + 2000 }],
      counts: { planned: 0, added: 0, removed: 0, dependencyChanged: 2, splits: 0 },
      log: [{ at: base + 2000, seq: 1, kind: 'dependency', taskId: 't1', text: '依赖变更 t1' }],
    },
    timeRange: { start: base, end: base + 10000 },
    asOfTime: base + 10000,
  }
  const countPrep = api.prepareView(countView)
  ok(u.asOfChangeCounts(countPrep, base + 9000).dependencyChanged === 1, 'chips 依赖变更按 log 计（1），不按 counts 数组口径（2）')
  ok(countPrep.changes.counts.dependencyChanged === 2, '原始 counts.dependencyChanged=2 仍保留')

  // ---------- 8.13 M5：无效关系单列口径 / 甘特高亮修复辅助 ----------
  ok(Array.isArray(prep.changes.invalidRelations) && prep.changes.invalidRelations.length === 0, 'changes.invalidRelations 归一化为空数组（无无效关系）')
  ok(prep.changes.counts.invalidRelations === 0, 'changes.counts.invalidRelations=0')
  const m5View = {
    tasks: [
      { id: 'task-1', subject: '父任务', status: 'completed', createdAt: base + 1000, startedAt: base + 2000, completedAt: base + 3000, phases: [{ status: 'pending', at: base + 1000 }, { status: 'completed', at: base + 3000 }], startRank: 1, doneRank: 1, blockedBy: [], writeScopes: [] },
      { id: 'task-2', subject: '有效子任务', status: 'in_progress', createdAt: base + 1500, startedAt: base + 4000, completedAt: null, phases: [{ status: 'pending', at: base + 1500 }, { status: 'in_progress', at: base + 4000 }], startRank: 2, doneRank: null, blockedBy: [], writeScopes: [] },
    ],
    relations: [
      { parent: 'task-1', children: ['task-2'], kind: 'split', note: '有效', recordedAt: base + 5000, seq: 10, source: 'tool', valid: true },
      { parent: 'task-1', children: ['task-404'], kind: 'split', note: '无效', recordedAt: base + 6000, seq: 11, source: 'tool', valid: false },
    ],
    changes: {
      added: [], removed: [], dependencyChanged: [],
      splits: [{ parent: 'task-1', children: ['task-2'], kind: 'split', note: '有效', at: base + 5000, seq: 10, valid: true }],
      invalidRelations: [{ parent: 'task-1', children: ['task-404'], kind: 'split', note: '无效', at: base + 6000, seq: 11, missing: ['task-404'] }],
      counts: { planned: 2, added: 0, removed: 0, dependencyChanged: 0, splits: 1, invalidRelations: 1 },
      log: [{ at: base + 5000, seq: 10, kind: 'split', taskId: 'task-1', text: '拆分 task-1 → task-2', children: ['task-2'] }],
    },
    timeRange: { start: base, end: base + 10000 },
    asOfTime: base + 10000,
  }
  const m5Prep = api.prepareView(m5View)
  ok(m5Prep.changes.splits.length === 1 && m5Prep.changes.splits[0].children[0] === 'task-2', 'changes.splits 只含有效拆分')
  ok(m5Prep.changes.invalidRelations.length === 1 && m5Prep.changes.invalidRelations[0].missing[0] === 'task-404', 'changes.invalidRelations 单列无效关系并保留 missing')
  ok(m5Prep.changes.counts.splits === 1 && m5Prep.changes.counts.invalidRelations === 1, 'counts.splits=1 / invalidRelations=1', JSON.stringify(m5Prep.changes.counts))
  ok(m5Prep.changes.log.length === 1 && m5Prep.changes.log[0].kind === 'split', 'log 只含有效拆分条目')
  const m5Counts = u.asOfChangeCounts(m5Prep, base + 9000)
  ok(m5Counts.splits === 1, '拆分计数只统计有效拆分（1）', String(m5Counts.splits))
  const invalidList = u.invalidRelationsOf(m5Prep)
  ok(invalidList.length === 1 && invalidList[0].missing[0] === 'task-404', 'invalidRelationsOf 返回无效关系（changes 优先）', String(invalidList.length))
  // 新旧字段同时存在时去重（不重复计数）
  const dupInvalid = api.prepareView(Object.assign({}, m5View, {
    changes: Object.assign({}, m5View.changes, { invalidRelations: m5View.changes.invalidRelations }),
  }))
  ok(u.invalidRelationsOf(dupInvalid).length === 1, '无效关系去重（changes 与 relation 不重复）', String(u.invalidRelationsOf(dupInvalid).length))
  // 无效关系父任务详情：支线列表只含有效子任务
  ok(u.relationChildrenOf(m5Prep, 'task-1').length === 1, '父任务支线列表只含有效子任务（无效关系不进支线）')
  ok(u.relationBadgeCount(m5Prep, 'task-1') === 1, '支线徽标数只统计有效关系')
  // 甘特高亮的 DOM 路径由开发期临时 jsdom+React harness 验证（不随仓库提交），此处仅断言纯函数可用。
  ok(typeof api.timeline.ganttTaskGeometry === 'function', '甘特几何纯函数可用（DOM 高亮路径由临时浏览器/jsdom harness 验证，不随仓库）')

  // ---------- 8.14 v1.1.2 单图模式：布局纯函数 + 甘特行距放大 ----------
  ok(api.constants.LAYOUT_MODES.length === 3 && api.constants.LAYOUT_MODES.indexOf('flow') >= 0, 'LAYOUT_MODES = both/flow/gantt')
  ok(u.normalizeLayoutMode('flow') === 'flow' && u.normalizeLayoutMode('gantt') === 'gantt' && u.normalizeLayoutMode('both') === 'both', 'normalizeLayoutMode 合法值')
  ok(u.normalizeLayoutMode('FLOW') === 'both' && u.normalizeLayoutMode(null) === 'both' && u.normalizeLayoutMode('x') === 'both', 'normalizeLayoutMode 非法值回退 both')
  ok(u.isPanelCollapsed('both', 'flow') === false && u.isPanelCollapsed('both', 'gantt') === false, 'both：两个面板都不折叠')
  ok(u.isPanelCollapsed('flow', 'gantt') === true && u.isPanelCollapsed('flow', 'flow') === false, 'flow：甘特折叠、流程图展开')
  ok(u.isPanelCollapsed('gantt', 'flow') === true && u.isPanelCollapsed('gantt', 'gantt') === false, 'gantt：流程图折叠、甘特展开')
  ok(u.flowShareForRows(2) === 40 && u.flowShareForRows(3) === 46, 'flowShareForRows 保持既有 40/46')
  ok(u.layoutGridTemplate('flow', 2) === 'minmax(0,1fr) auto', 'layoutGridTemplate(flow) 行模板')
  ok(u.layoutGridTemplate('gantt', 2) === 'auto minmax(0,1fr)', 'layoutGridTemplate(gantt) 行模板')
  ok(u.layoutGridTemplate('both', 2).indexOf('40%') > 0 && u.layoutGridTemplate('both', 3).indexOf('46%') > 0, 'layoutGridTemplate(both) 使用分栏占比')
  ok(u.layoutActionToMode('maximize-flow') === 'flow' && u.layoutActionToMode('maximize-gantt') === 'gantt' && u.layoutActionToMode('restore-both') === 'both', '面板动作 → 布局模式映射')

  // 甘特行距放大（单图模式填充）：rowScale=1.5 时高度/行高按比例增长，x 轴不变
  const layoutBase = api.timeline.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, spans: prep.spans, milestones: prep.milestones, start: prep.timeStart, end: prep.timeEnd })
  const layoutScaled = api.timeline.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, spans: prep.spans, milestones: prep.milestones, start: prep.timeStart, end: prep.timeEnd, rowScale: 1.5 })
  ok(layoutBase.rowScale === 1 && layoutScaled.rowScale === 1.5, 'rowScale 写入布局结果')
  ok(Math.abs(layoutScaled.rowH - layoutBase.rowH * 1.5) < 0.001, 'rowScale=1.5 → 甘特行高 ×1.5', layoutScaled.rowH + ' vs ' + layoutBase.rowH)
  ok(layoutScaled.height > layoutBase.height, 'rowScale=1.5 → 画布总高度增加', layoutBase.height + '→' + layoutScaled.height)
  ok(layoutScaled.x0 === layoutBase.x0 && layoutScaled.x1 === layoutBase.x1, 'rowScale 不改变 x 轴时间映射')
  ok(layoutScaled.taskRows[1].y - layoutScaled.taskRows[0].y === layoutScaled.rowH, '任务行间距 = rowH')
  ok(layoutScaled.memberRows[1].y - layoutScaled.memberRows[0].y === layoutScaled.memH, '代理行间距 = memH')
  const layoutClampedLow = api.timeline.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, start: prep.timeStart, end: prep.timeEnd, rowScale: 0.2 })
  ok(layoutClampedLow.rowScale === 1, 'rowScale 下限 clamp 到 1')
  const layoutClampedHigh = api.timeline.computeTimelineLayout({ tasks: prep.tasks, members: prep.members, start: prep.timeStart, end: prep.timeEnd, rowScale: 9 })
  ok(layoutClampedHigh.rowScale === 2.6, 'rowScale 上限 clamp 到 2.6')
  // layoutStore：模块级保存当前布局（切换不丢回放状态由 smoke/runtime 覆盖）
  api.layoutStore.set('flow')
  ok(api.layoutStore.get() === 'flow', 'layoutStore 持久化 flow')
  api.layoutStore.set('bogus')
  ok(api.layoutStore.get() === 'both', 'layoutStore 非法值回退 both')
  api.layoutStore.set('both')

  // 单图（流程图）纵向拉伸：节点尺寸/列不变，行距撑满目标高度
  const baseFlow8 = api.computeFlowLayout(8)
  const stretched = api.timeline.stretchFlowLayout(baseFlow8, 520)
  ok(stretched.height === 520, 'stretchFlowLayout：高度精确等于目标（520）', String(stretched.height))
  ok(stretched.nodeWidth === baseFlow8.nodeWidth, 'stretchFlowLayout：节点宽度不变（不横向溢出）')
  ok(stretched.nodeHeight > baseFlow8.nodeHeight && stretched.nodeHeight <= baseFlow8.nodeHeight + 96, 'stretchFlowLayout：节点高度适度放大（大卡片）', String(stretched.nodeHeight))
  ok(stretched.positions[0].y === baseFlow8.positions[0].y, 'stretchFlowLayout：首行位置不变')
  ok(stretched.positions[4].y > baseFlow8.positions[4].y, 'stretchFlowLayout：第二行下移')
  ok(stretched.positions[4].y - stretched.positions[0].y === stretched.nodeHeight + stretched.gapY, 'stretchFlowLayout：行距 = nodeHeight + gapY')
  const lastRowBottom = stretched.positions[7].y + stretched.nodeHeight + 26
  ok(lastRowBottom <= 520 + 0.001 && lastRowBottom >= 520 - 1.2, 'stretchFlowLayout：最后一行底部接近目标高度（≤1.2px 误差）', String(lastRowBottom))
  ok(stretched.positions.every((position, index) => position.x === baseFlow8.positions[index].x), 'stretchFlowLayout：x 坐标不变（不横向溢出）')
  const tiny = api.computeFlowLayout(4)
  ok(api.timeline.stretchFlowLayout(tiny, 900) === tiny, 'stretchFlowLayout：单行不拉伸（保持居中）')
  ok(api.timeline.stretchFlowLayout(baseFlow8, 100) === baseFlow8, 'stretchFlowLayout：目标更小则保持原布局')
  const routeStretched = api.buildFlowPath(stretched, 8)
  ok(routeStretched.split(' L').length === 8, '拉伸后可重建执行轨迹路径')
  ok(api.buildDependencyPath(stretched.positions[0], stretched.positions[7], stretched.nodeWidth, stretched.nodeHeight).includes('Q'), '拉伸后可重建依赖曲线')

  // stretchFlowLayout 二次 clamp：目标超过容器换算高度时严格不超过容器上限，y 不为负
  const clampedFlow = api.timeline.stretchFlowLayout(baseFlow8, 5000, { width: 1000, height: 600 }) // cap = 600*944/1000 = 566.4
  const capHeight = 600 * (baseFlow8.width / 1000)
  ok(clampedFlow.height <= capHeight + 0.001, 'stretchFlowLayout 二次 clamp：viewBox 高度 ≤ 容器换算上限', String(clampedFlow.height))
  ok(clampedFlow.height > baseFlow8.height, 'stretchFlowLayout 二次 clamp：仍大于原始高度')
  ok(clampedFlow.positions.every((position) => position.y >= 0), 'stretchFlowLayout 二次 clamp：节点 y 不为负')
  ok(clampedFlow.positions[7].y + clampedFlow.nodeHeight + 26 <= capHeight + 1.2, '二次 clamp：最后一行仍在容器内')
  const roomyFlow = api.timeline.stretchFlowLayout(baseFlow8, 500, { width: 2000, height: 2000 }) // cap = 944 > 500
  ok(roomyFlow.height === 500, 'stretchFlowLayout：容器足够大时目标高度不被额外收缩', String(roomyFlow.height))
  const fallbackFlow = api.timeline.stretchFlowLayout(baseFlow8, 5000, { width: 0, height: 0 })
  ok(fallbackFlow.height === 5000, 'stretchFlowLayout：无容器尺寸时不 clamp（保持调用方目标）', String(fallbackFlow.height))
  const noArgFlow = api.timeline.stretchFlowLayout(baseFlow8, 520)
  ok(noArgFlow.height === 520, 'stretchFlowLayout：不传容器时行为不变')

  // ---------- 8.15 v1.1 会话计划（todo）归一化：active/计数/状态/隐藏 ----------
  ok(prep.plan !== null, '有 todo 计划时 prep.plan 存在')
  ok(prep.plan.items.length === 7, 'athena 式计划 7 项', String(prep.plan.items.length))
  ok(prep.plan.counts.completed === 1 && prep.plan.counts.inProgress === 1 && prep.plan.counts.pending === 5, '计划计数 1/1/5', JSON.stringify(prep.plan.counts))
  ok(prep.plan.active === true && prep.plan.source === 'todo', 'plan.active=true / source=todo')
  ok(prep.plan.writeCount === 3 && prep.plan.updatedAt === base + 120000, 'plan.writeCount / updatedAt 保留')
  ok(prep.plan.items[0].status === 'completed' && prep.plan.items[1].status === 'in_progress', '计划项状态保留')
  ok(prep.plan.items.every((item) => item.id && item.content && item.index >= 1), '计划项 id/index/content 齐全')
  // 无 plan → null（区块隐藏）
  const noPlanView = Object.assign({}, mock.view)
  delete noPlanView.plan
  ok(api.prepareView(noPlanView).plan === null, '无 plan 时 prep.plan=null（区块隐藏）')
  // active=false（只有 todo、图/甘特已降级展示）→ 保留数据但 UI 隐藏
  const inactivePlanView = Object.assign({}, mock.view, { plan: Object.assign({}, mock.view.plan, { active: false }) })
  const inactivePrep = api.prepareView(inactivePlanView)
  ok(inactivePrep.plan !== null && inactivePrep.plan.active === false, 'plan.active=false 保留数据（UI 层隐藏）')
  // 计数缺失 → 由 items 推导；未知状态归入 pending；空 items → null
  const fallbackPlanView = Object.assign({}, mock.view, {
    plan: {
      items: [
        { id: 'a', content: '完成 A', status: 'completed' },
        { id: 'b', content: '进行 B', status: 'in_progress' },
        { id: 'c', content: '待办 C', status: 'cancelled' },
      ],
    },
  })
  const fallbackPlan = api.prepareView(fallbackPlanView).plan
  ok(fallbackPlan.counts.completed === 1 && fallbackPlan.counts.inProgress === 1 && fallbackPlan.counts.pending === 1, 'counts 缺失时按 items 推导（未知状态→pending）', JSON.stringify(fallbackPlan.counts))
  ok(fallbackPlan.writeCount === 0 && fallbackPlan.active === true, 'writeCount 缺失默认 0 / active 缺失默认 true')
  ok(api.prepareView(Object.assign({}, mock.view, { plan: { items: [] } })).plan === null, '空 items → null（区块隐藏）')
  ok(api.prepareView(Object.assign({}, mock.view, { plan: { items: [{ content: '   ' }] } })).plan === null, '无有效内容 → null')
  // 只读：normalizePlan 不修改输入
  const frozenPlan = JSON.parse(JSON.stringify(mock.view.plan))
  api.prepareView(Object.assign({}, mock.view, { plan: frozenPlan }))
  ok(JSON.stringify(frozenPlan) === JSON.stringify(mock.view.plan), 'normalizePlan 不修改输入（只读投影）')

  // ---------- 9. 真实 8 任务视图（mock，对照 prototype 语义） ----------
  ok(prep.stats.total === 8 && prep.stats.completed === 8, 'mock 视图：8 任务全完成', JSON.stringify(prep.stats))
  ok(prep.flowDepEdges.length === 6, 'mock 视图：6 条 blockedBy 依赖边', String(prep.flowDepEdges.length))
  ok(prep.flowRelationEdges.length === 1, 'mock 视图：1 条关系分叉边', String(prep.flowRelationEdges.length))
  ok(prep.flowRoute.split(' L').length === 8, 'mock 视图：执行轨迹经过 8 个节点')
  ok(prep.tasks[0].id === 'task-1' && prep.tasks[6].id === 'task-8', 'mock 视图：按 startRank 排序', prep.tasks.map((task) => task.id).join(','))
  ok(prep.taskById['task-8'].isNew === true, 'mock 视图：changes.added → NEW 标记')
  ok(prep.changes.added.length === 1, 'mock 视图：changes.added 保留')
  ok(prep.tasks.find((task) => task.id === 'task-8').spanCount === 4, '降级字段 spanCount 保留')
  ok(prep.spans.length > 0 && prep.spans[0].kind === 'tool', 'mock 视图：spans 归一化')

}

/* ================================================================== */
/* 直接运行：自己搭环境加载 client.js                                   */
/* ================================================================== */
if (isMain) {
  const failures = []
  let passed = 0
  const ok = (condition, label, detail) => {
    if (condition) {
      passed += 1
      return true
    }
    failures.push(label + (detail ? ` — ${detail}` : ''))
    console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`)
    return false
  }
  const { captured } = fakeEnv()
  await import('../client.js')
  if (!captured.definition) {
    console.error('[client-logic] FAILED: client module not registered')
    process.exit(1)
  }
  const plugin = captured.definition.factory((id) => {
    if (id === 'react') return fakeReact()
    throw new Error('unexpected require: ' + id)
  })
  console.log(`[client-logic] module id=${captured.definition.id} version=${plugin.__test.version}`)
  runLogicTests(plugin.__test, ok)
  if (failures.length > 0) {
    console.error(`\n[client-logic] FAILED: ${failures.length} check(s)`)
    for (const failure of failures) console.error(' - ' + failure)
    process.exit(1)
  }
  console.log(`\n[client-logic] PASS (${passed} checks)`)
}

/* ================================================================== */
/* 测试用 mock 视图（8 任务真实形状；时间确定、不依赖本地时区）          */
/* ================================================================== */
export function buildLogicMockView() {
  const base = 1700000000000
  const t = (offset) => base + offset
  const task = (config) => ({
    kind: 'team',
    description: config.subject + ' 的验收说明（mock description，用于详情与截断场景）。',
    ownerId: config.owner === 'Lead' ? 'session-mock' : 'member-' + config.owner,
    ownerIsLead: config.owner === 'Lead',
    failedAt: null,
    updatedAt: config.completedAt,
    writeScopes: config.writeScopes || [],
    blockedBy: config.blockedBy || [],
    revision: 3,
    ...config,
  })
  const tasks = [
    task({
      id: 'task-1', subject: 'T1 飞书集成模型 + OmniAuth 策略 + OAuth 接线', status: 'completed',
      owner: 'Lead', createdAt: t(1000), startedAt: t(60000), completedAt: t(300000),
      phases: [{ status: 'pending', at: t(1000) }, { status: 'in_progress', at: t(60000) }, { status: 'completed', at: t(300000) }],
      execMs: 240000, queueMs: 59000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 1, doneRank: 1, writeScopes: ['app/models/integration/feishu_oauth2.rb', 'lib/omni_auth/strategies/feishu.rb'],
    }),
    task({
      id: 'task-2', subject: 'T2 后台配置 UI + 登录页飞书入口', status: 'completed',
      owner: 'auth-ui', createdAt: t(2000), startedAt: t(70000), completedAt: t(400000),
      phases: [{ status: 'pending', at: t(2000) }, { status: 'in_progress', at: t(70000) }, { status: 'completed', at: t(400000) }],
      execMs: 330000, queueMs: 68000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 2, doneRank: 2, writeScopes: ['app/javascript/desk/feishu_login.tsx'],
    }),
    task({
      id: 'task-3', subject: 'T3 飞书 OpenAPI 客户端 + 部门映射', status: 'completed',
      owner: 'feishu-service', createdAt: t(3000), startedAt: t(80000), completedAt: t(500000),
      phases: [{ status: 'pending', at: t(3000) }, { status: 'in_progress', at: t(80000) }, { status: 'completed', at: t(500000) }],
      execMs: 420000, queueMs: 77000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 3, doneRank: 3, writeScopes: ['app/services/feishu/open_api.rb'],
    }),
    task({
      id: 'task-4', subject: 'T4 通讯录全量导入任务 + 员工导入 UI', status: 'completed',
      owner: 'contact-import', createdAt: t(4000), startedAt: t(90000), completedAt: t(600000),
      phases: [{ status: 'pending', at: t(4000) }, { status: 'in_progress', at: t(90000) }, { status: 'completed', at: t(600000) }],
      execMs: 510000, queueMs: 86000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 4, doneRank: 4, writeScopes: ['app/jobs/contact_import_job.rb'],
    }),
    task({
      id: 'task-5', subject: 'T5 事件回调（加密/校验/幂等/增量同步）', status: 'completed',
      owner: 'feishu-events', createdAt: t(5000), startedAt: t(100000), completedAt: t(700000),
      phases: [{ status: 'pending', at: t(5000) }, { status: 'in_progress', at: t(100000) }, { status: 'completed', at: t(700000) }],
      execMs: 600000, queueMs: 95000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 5, doneRank: 6, writeScopes: ['app/controllers/api/feishu/events_controller.rb'],
    }),
    task({
      id: 'task-6', subject: 'T6 飞书登录帮助文档 + 客户管理员 SOP', status: 'completed',
      owner: 'Lead', createdAt: t(6000), startedAt: t(650000), completedAt: t(680000),
      phases: [{ status: 'pending', at: t(6000) }, { status: 'in_progress', at: t(650000) }, { status: 'completed', at: t(680000) }],
      execMs: 30000, queueMs: 644000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 6, doneRank: 5, writeScopes: ['docs/help/integrations/feishu-login.md'],
    }),
    task({
      id: 'task-7', subject: 'T7 全链路验收：跑测试/静态检查/对照契约审查', status: 'completed',
      owner: 'qa-verifier', createdAt: t(7000), startedAt: t(900000), completedAt: t(1200000),
      phases: [{ status: 'pending', at: t(7000) }, { status: 'blocked', at: t(50000) }, { status: 'in_progress', at: t(900000) }, { status: 'completed', at: t(1200000) }],
      execMs: 300000, queueMs: 893000, readyAt: t(680000), blockedWaitMs: t(680000) - t(7000), readyDelayMs: t(900000) - t(680000),
      startRank: 8, doneRank: 8,
      blockedBy: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6'],
      writeScopes: ['docs/analysis/2026-11-04-feishu-sso-acceptance-report.md'],
    }),
    task({
      id: 'task-8', subject: 'T7a 验收预检与验收报告骨架', status: 'completed',
      owner: 'qa-verifier', createdAt: t(610000), startedAt: t(700000), completedAt: t(800000),
      phases: [{ status: 'pending', at: t(610000) }, { status: 'in_progress', at: t(700000) }, { status: 'completed', at: t(800000) }],
      execMs: 100000, queueMs: 90000, readyAt: null, blockedWaitMs: null, readyDelayMs: null,
      startRank: 7, doneRank: 7, spanCount: 4,
    }),
  ]
  const startOrder = ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-8', 'task-7']
  const edges = []
  for (const blocker of ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6']) edges.push({ from: blocker, to: 'task-7', kind: 'blockedBy' })
  for (let index = 1; index < startOrder.length; index += 1) edges.push({ from: startOrder[index - 1], to: startOrder[index], kind: 'sequence' })
  edges.push({ from: 'task-4', to: 'task-8', kind: 'relation' })
  return {
    base,
    view: {
      schema: 'task-map/view',
      stateVersion: 4,
      sessionId: 'session-mock-11111111-2222-3333-4444-555555555555',
      title: 'Mock 飞书 SSO 开发会话',
      cwd: '/Users/mock/Codes/baklib',
      agentPreset: 'cordis',
      sessionCreatedAt: base,
      asOfSeq: 1156,
      asOfTime: t(3600000),
      timeRange: { start: base, end: t(3600000) },
      hasTeamBoard: true,
      dataSource: 'team',
      emptyReason: null,
      tasks,
      taskStats: { total: 8, pending: 0, in_progress: 0, completed: 8, failed: 0, blocked: 0, other: 0 },
      relations: [{ parent: 'task-4', children: ['task-8'], kind: 'split', note: '把 T4 拆成数据导入与员工导入 UI 两条支线', recordedAt: t(610000), seq: 900, source: 'tool', valid: true }],
      plan: {
        items: [
          { id: 'todo:1', index: 1, content: '重构 contracts 包：按领域拆分目录（billing/payment/refund）', status: 'completed', updatedAt: t(90000) },
          { id: 'todo:2', index: 2, content: '迁移 contracts 现有模型与序列化逻辑，补齐 rails zeitwerk 约定', status: 'in_progress', updatedAt: t(120000) },
          { id: 'todo:3', index: 3, content: '更新 billing 引擎引用并跑通回归测试', status: 'pending', updatedAt: t(90000) },
          { id: 'todo:4', index: 4, content: '处理 refund 领域事件与状态机', status: 'pending', updatedAt: t(90000) },
          { id: 'todo:5', index: 5, content: '梳理 payment 网关适配层与幂等键', status: 'pending', updatedAt: t(90000) },
          { id: 'todo:6', index: 6, content: '补充 contracts 层单元测试与类型约束', status: 'pending', updatedAt: t(90000) },
          { id: 'todo:7', index: 7, content: '清理旧目录与遗留 TODO，更新文档', status: 'pending', updatedAt: t(90000) },
        ],
        counts: { completed: 1, inProgress: 1, pending: 5 },
        updatedAt: t(120000),
        writeCount: 3,
        source: 'todo',
        active: true,
      },
      edges,
      baseline: {
        taskIds: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-7'],
        at: t(1000),
        seq: 7,
        source: 'first-task',
        closedAt: t(80000),
        open: false,
      },
      changes: {
        added: ['task-8'],
        removed: [],
        dependencyChanged: [{ id: 'task-7', from: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6'], to: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-8'], at: t(605000) }],
        splits: [{ parent: 'task-4', children: ['task-8'], kind: 'split', note: '把 T4 拆成数据导入与员工导入 UI 两条支线', at: t(610000), seq: 900, valid: true }],
        invalidRelations: [],
        counts: { planned: 7, added: 1, removed: 0, dependencyChanged: 1, splits: 1, invalidRelations: 0 },
        log: [
          { at: t(610000), seq: 901, kind: 'added', taskId: 'task-8', text: '新增任务 T7a 验收预检与验收报告骨架（T1/T3/T6 已完成部分）' },
          { at: t(605000), seq: 902, kind: 'dependency', taskId: 'task-7', from: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6'], to: ['task-1', 'task-2', 'task-3', 'task-4', 'task-5', 'task-6', 'task-8'], text: '依赖变更 task-7' },
          { at: t(610000), seq: 900, kind: 'split', taskId: 'task-4', text: '拆分 task-4 → task-8', children: ['task-8'] },
        ],
      },
      members: [
        { id: 'member-auth-ui', name: 'auth-ui', description: 'P0 后台配置 UI 与登录页飞书入口', phase: 'active', phases: [{ phase: 'provisioning', at: t(60000) }, { phase: 'active', at: t(61000) }], createdAt: t(60000), updatedAt: t(700000) },
        { id: 'member-feishu-service', name: 'feishu-service', description: '飞书 OpenAPI 客户端与部门同步', phase: 'active', phases: [{ phase: 'provisioning', at: t(61000) }, { phase: 'active', at: t(62000) }], createdAt: t(61000), updatedAt: t(700000) },
        { id: 'member-qa-verifier', name: 'qa-verifier', description: '验收预检、验收报告与最终全链路验收', phase: 'active', phases: [{ phase: 'provisioning', at: t(620000) }, { phase: 'active', at: t(630000) }], createdAt: t(620000), updatedAt: t(1200000) },
      ],
      subagents: [{ childId: 'member-auth-ui', label: 'P0 后台配置 UI 与登录页飞书入口', mode: 'continuable', createdAt: t(60500), at: t(60500) }],
      turns: [{ turn: 1, start: t(5000), end: t(3600000) }],
      spans: [
        { kind: 'tool', name: 'read', label: 'read', start: t(5001), end: t(5140), status: 'ok' },
        { kind: 'tool', name: 'bash', label: 'bash', start: t(5200), end: t(6000), status: 'ok' },
        { kind: 'job', name: 'bash', label: 'bash', start: t(5300), end: t(6000), status: 'ok' },
        { kind: 'tool', name: 'wait_agent', label: 'wait_agent', start: t(800000), end: t(850000), status: 'ok' },
        { kind: 'approval', name: 'bash', label: 'bash', start: t(900000), end: t(910000), status: 'ok', outcome: 'approved' },
        { kind: 'tool', name: 'bash', label: 'bash', start: t(1200000), end: t(1210000), status: 'error', error: 'exit code 1' },
      ],
      usage: { input: 211337, output: 135313, cacheRead: 23146624, cacheWrite: 0, total: 23493274 },
      counters: { toolCalls: 203, jobs: 109, approvals: 1, subagents: 5, todoWrites: 3, teammates: 7, waitAgents: 8, askUsers: 2, steps: 101, stepEnds: 101, goalChanges: 2, commands: 0, deliverables: 1 },
      waits: {
        preTurnMs: 2867304, preTurnRestored: false, humanIdleMs: 0, idleSegments: [],
        queueMs: 2354635, blockedMs: 1351134, readyDelayMs: 36699, taskExecMs: 4823466,
        waitAgentMs: 824680, askUserMs: 128139, approvalMs: 8638, wallClockMs: 5230339,
        maxHandoffMs: 456218, handoffs: [{ from: 'task-4', to: 'task-7', gapMs: 456218 }],
      },
      milestones: [{ kind: 'deliverable', at: t(3500000), turn: 1, callId: 'call-1', files: [{ path: 'docs/analysis/acceptance-report.md', description: '验收报告' }] }],
      goal: { id: 'goal-1', phase: 'complete', objective: '', operation: 'complete', at: t(3500000) },
      endedSeed: null,
      warnings: [],
    },
  }
}
