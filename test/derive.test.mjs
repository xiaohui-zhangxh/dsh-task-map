#!/usr/bin/env node
/**
 * W1.5 黄金测试（M1 Gate 主命令）。
 *
 *   node test/derive.test.mjs
 *
 * 数据链路：
 *   test/fixtures/*.jsonl（真实会话脱敏裁剪，冻结快照）
 *     → foldEvents / foldEvent（lib/derive.js）
 *     → buildClientView
 *     ↔ docs/golden-values.json（tools/handcalc.py 用 Python 独立手算，不读 derive.js）
 *
 * 断言口径：任务数/状态/开始完成时间/耗时/等待/负责人/依赖/排名/状态历史/turns/usage/counters/spans，
 * 全部为原始毫秒整数精确相等（±0ms）；外加 fixture 完整性、Object.is 门控、未知事件、
 * 空状态、todo 降级、未完成态、关系记录、视图体积等行为断言。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  STATE_VERSION,
  buildClientView,
  emptyState,
  foldEvent,
  foldEvents,
} from '../lib/derive.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const FIXTURE_DIR = path.join(ROOT, 'test', 'fixtures')
const GOLDEN_FILE = path.join(ROOT, 'docs', 'golden-values.json')
const HARD_VIEW_LIMIT = 200 * 1024 // 投影 wire.view 硬上限（产品方案 §7.3）
const FIXTURE_LIMIT = 1024 * 1024 // 单 fixture < 1MB（W1.4 验收）

const failures = []
let passed = 0

function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1
    return true
  }
  failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}

/** 键序无关的规范序列化，用于深比较（与 Python sort_keys 对齐）。 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = stable(value[key])
    return out
  }
  return value
}

const canon = (value) => JSON.stringify(stable(value))

/** 深比较：actual 与 expected 必须完全一致（数组顺序敏感）。 */
function same(label, actual, expected) {
  if (canon(actual) === canon(expected)) {
    passed += 1
    return true
  }
  failures.push(label)
  console.log(`  ✗ ${label}`)
  console.log(`      actual  = ${canon(actual)}`)
  console.log(`      expected= ${canon(expected)}`)
  return false
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) out[key] = source?.[key]
  return out
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function loadJsonl(file) {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

function sha256File(file) {
  return sha256(readFileSync(file))
}

const golden = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8'))
const manifest = JSON.parse(readFileSync(path.join(FIXTURE_DIR, 'MANIFEST.json'), 'utf8'))
const slugs = Object.keys(golden.sessions).sort()
const manifestBySlug = new Map(manifest.sessions.map((entry) => [entry.slug, entry]))

// ---------------------------------------------------------------------------
// 0. 契约版本
// ---------------------------------------------------------------------------
console.log('[0] 契约版本 / 文件完整性')
ok(STATE_VERSION === 4, `STATE_VERSION = 4（实际 ${STATE_VERSION}）`)
ok(golden.format === 1 && manifest.format === 1, 'golden / manifest format = 1')
ok(slugs.length === 3, `3 个黄金会话（实际 ${slugs.length}）: ${slugs.join(', ')}`)
for (const slug of slugs) ok(manifestBySlug.has(slug), `fixture manifest 含 ${slug}`)

// ---------------------------------------------------------------------------
// 1. fixture 完整性（sha256 链 + 体积 + 行数 + 头行）
// ---------------------------------------------------------------------------
console.log('\n[1] fixture 完整性（sha256 / 体积 / 行数）')
for (const slug of slugs) {
  const entry = manifestBySlug.get(slug)
  const file = path.join(FIXTURE_DIR, `${slug}.jsonl`)
  const bytes = statSync(file).size
  const fixtureSha = sha256File(file)
  ok(fixtureSha === entry.fixtureSha256, `${slug}: fixture sha256 与 MANIFEST 一致`, fixtureSha.slice(0, 12))
  ok(fixtureSha === golden.source.fixtureSha256[slug], `${slug}: fixture sha256 与 golden.source 一致`)
  ok(golden.source.snapshotSha256[slug] === entry.snapshotJsonlSha256, `${slug}: 快照 sha256 链一致`)
  ok(bytes === entry.bytes, `${slug}: 字节数一致 (${bytes})`)
  ok(bytes < FIXTURE_LIMIT, `${slug}: fixture < 1MB`, `${bytes} bytes`)
  const events = loadJsonl(file)
  ok(events.length === entry.keptEventCount, `${slug}: 行数 = keptEventCount (${events.length})`)
  ok(events[0]?.type === 'session' && events[0]?.id === entry.sessionId, `${slug}: 首行为 session 头`)
  const kept = new Set(entry.keptTypes)
  const unknownTypes = [...new Set(events.map((event) => event.type))].filter((type) => !kept.has(type))
  ok(unknownTypes.length === 0, `${slug}: 事件类型均在白名单`, unknownTypes.join(','))
}

// ---------------------------------------------------------------------------
// 2. 黄金值逐字段比对（±0ms）
// ---------------------------------------------------------------------------
console.log('\n[2] 黄金值比对（foldEvents → buildClientView ↔ Python 独立手算）')
const foldedBySlug = new Map()
for (const slug of slugs) {
  const entry = manifestBySlug.get(slug)
  const expected = golden.sessions[slug]
  const events = loadJsonl(path.join(FIXTURE_DIR, `${slug}.jsonl`))

  const startedAt = performance.now()
  let state = emptyState(null)
  let sameReferenceCount = 0
  for (const event of events) {
    const next = foldEvent(state, event)
    if (Object.is(next, state)) sameReferenceCount += 1
    state = next
  }
  const view = buildClientView(state)
  const elapsedMs = performance.now() - startedAt
  foldedBySlug.set(slug, { state, view, events, elapsedMs })

  console.log(
    `  · ${slug}: ${view.tasks.length} tasks, ${view.spans.length} spans, ` +
      `${(Buffer.byteLength(JSON.stringify(view)) / 1024).toFixed(1)}KB view, fold+view ${elapsedMs.toFixed(1)}ms`,
  )

  same(`${slug}: sessionId`, view.sessionId, expected.sessionId)
  same(`${slug}: sessionCreatedAt`, view.sessionCreatedAt, expected.sessionCreatedAt)
  same(`${slug}: title`, view.title, expected.title)
  same(`${slug}: cwd`, view.cwd, expected.cwd)
  same(`${slug}: taskCount`, view.tasks.length, expected.taskCount)
  same(`${slug}: 任务顺序`, view.tasks.map((task) => task.id), expected.order)
  same(`${slug}: relations`, view.relations, expected.relations ?? [])

  for (const taskId of Object.keys(expected.tasks)) {
    const actualTask = view.tasks.find((task) => task.id === taskId)
    if (!actualTask) {
      ok(false, `${slug}.${taskId}: 任务存在`)
      continue
    }
    const expectedTask = expected.tasks[taskId]
    same(`${slug}.${taskId}: 状态/时间/耗时/等待/负责人/依赖/排名`, pick(actualTask, Object.keys(expectedTask)), expectedTask)
    // 负责人精确映射的独立复核：ownerId → Lead / team/member 名字
    const expectedOwner = expectedTask.owner
    const ownerId = actualTask.ownerId
    const expectedOwnerByName = ownerId === null
      ? null
      : ownerId === view.sessionId
        ? 'Lead'
        : expected.agents[ownerId]
    if (expectedOwnerByName !== undefined) {
      same(`${slug}.${taskId}: owner 映射`, actualTask.owner, expectedOwnerByName)
    }
  }

  same(`${slug}: turns`, view.turns, expected.turns)
  same(`${slug}: waits（等待拆解 ±0ms）`, pick(view.waits, Object.keys(expected.waits)), expected.waits)
  same(`${slug}: 无 end-seed 尾巴（tailMs=0）`, view.waits.tailMs, 0)
  same(`${slug}: timeRange.rawEnd = asOfTime`, view.timeRange.rawEnd, view.asOfTime)
  same(`${slug}: timeRange.end = 墙上时钟终点`, view.timeRange.end, view.sessionCreatedAt + view.waits.wallClockMs)
  same(`${slug}: usage`, pick(view.usage, Object.keys(expected.usage)), expected.usage)
  same(`${slug}: counters`, pick(view.counters, Object.keys(expected.counters)), expected.counters)
  same(`${slug}: taskStats`, pick(view.taskStats, Object.keys(expected.taskStats)), expected.taskStats)

  const spanSummary = {
    tool: view.spans.filter((span) => span.kind === 'tool').length,
    job: view.spans.filter((span) => span.kind === 'job').length,
    approval: view.spans.filter((span) => span.kind === 'approval').length,
    openCount: view.spans.filter((span) => span.end === null).length,
    errorCount: view.spans.filter((span) => span.status === 'error').length,
    killedCount: view.spans.filter((span) => span.status === 'killed').length,
  }
  same(`${slug}: span 汇总`, spanSummary, expected.spans)
  same(`${slug}: 正常会话不截断 span`, view.spansTruncated, false)
  same(`${slug}: 正常会话不降级描述`, view.viewLevel, { description: 500, spans: null })
  same(`${slug}: spanSummary.total = 视图 span 数`, view.spanSummary.total, view.spans.length)
  same(`${slug}: 等待累加器独立于 span 视图`, {
    waitAgentMs: state.waitsAcc.waitAgentMs,
    askUserMs: state.waitsAcc.askUserMs,
    approvalMs: state.waitsAcc.approvalMs,
  }, {
    waitAgentMs: view.waits.waitAgentMs,
    askUserMs: view.waits.askUserMs,
    approvalMs: view.waits.approvalMs,
  })

  // baseline 与 changes 是 W3 的黄金值，这里只做一致性自检。
  ok(Array.isArray(view.baseline?.taskIds) && view.baseline.taskIds.length > 0, `${slug}: baseline 快照非空`)
  ok(view.baseline.open === false, `${slug}: baseline 已封板`)
  for (const addedId of view.changes.added) ok(!view.baseline.taskIds.includes(addedId), `${slug}: changes.added 不在基线内 (${addedId})`)
  // M3：计划基线 vs 实际（独立手算的期望值，见 docs/M1-DATA-NOTES.md 与黄金值时间线）
  const expectedBaseline = { 'baklib-feishu-sso': 7, 'p2p-athena-port': 3, 'athena-plan-board': 5 }[slug]
  same(`${slug}: 计划基线任务数`, view.baseline.taskIds.length, expectedBaseline)
  ok(typeof view.baseline.closedAt === 'number' && view.baseline.closedAt > view.baseline.at, `${slug}: 基线封板时间晚于建立时间`)
  same(`${slug}: 基线 open=false`, view.baseline.open, false)
  same(`${slug}: 变更计数`, pick(view.changes.counts, ['planned', 'added', 'removed', 'dependencyChanged', 'splits']), {
    planned: expectedBaseline,
    added: view.tasks.length - expectedBaseline,
    removed: 0,
    dependencyChanged: 0,
    splits: 0,
  })
  // 变更流按时间/seq 排序，且每条 added 记录时刻等于任务 createdAt
  for (let index = 0; index < view.changes.log.length; index += 1) {
    const entry = view.changes.log[index]
    ok(entry.at > view.baseline.closedAt, `${slug}: 变更记录在基线封板之后 #${index}`)
    if (entry.kind === 'added') {
      const task = view.tasks.find((item) => item.id === entry.taskId)
      same(`${slug}: 新增记录时刻 = 任务 createdAt (${entry.taskId})`, entry.at, task.createdAt)
    }
  }
  const logKeys = view.changes.log.map((entry) => `${entry.at}:${entry.seq}`)
  same(`${slug}: 变更流有序`, logKeys, logKeys.slice().sort())

  // 视图体积硬上限
  const viewBytes = Buffer.byteLength(JSON.stringify(view))
  ok(viewBytes < HARD_VIEW_LIMIT, `${slug}: wire.view < 200KB 硬上限`, `${(viewBytes / 1024).toFixed(1)}KB`)

  // 投影纪律：无关/未知事件返回同一引用（fixture 已按白名单裁剪，故此处单独注入验证）
  void sameReferenceCount
  const unknown = foldEvent(state, { type: 'mystery/never-seen', seq: 999999, time: Date.now(), data: { x: 1 } })
  ok(Object.is(unknown, state), `${slug}: 未知事件不改变状态引用`)

  // 纯函数：wire.view 不修改投影状态，重复折叠结果确定
  const before = canon(state)
  const viewAgain = buildClientView(state)
  ok(canon(state) === before, `${slug}: buildClientView 不修改投影状态`)
  same(`${slug}: 重复 buildClientView 结果一致`, canon(viewAgain), canon(view))
  const stateAgain = foldEvents(null, events)
  same(`${slug}: 重复 foldEvents 结果一致`, canon(buildClientView(stateAgain)), canon(view))
}

// ---------------------------------------------------------------------------
// 3. 行为断言（黄金 fixture 之外的边界）
// ---------------------------------------------------------------------------
console.log('\n[3] 行为断言（空状态 / todo 降级 / 未完成态 / 失败态 / 关系记录）')

// 3.1 空会话：不伪造任务
const emptyView = buildClientView(foldEvents({ id: 'session-empty', createdAt: 1000 }, []))
same('空会话: dataSource = none', emptyView.dataSource, 'none')
same('空会话: emptyReason = no-task-board', emptyView.emptyReason, 'no-task-board')
same('空会话: tasks = []', emptyView.tasks, [])
ok(emptyView.waits.preTurnMs === null, '空会话: preTurnMs = null')

// 3.2 todo 降级（无团队任务板时）
const header = { type: 'session', id: 'session-todo', createdAt: 1000, cwd: '/workspace/demo' }
let todoState = foldEvents(null, [
  header,
  { type: 'todo/write', seq: 1, time: 2000, data: { todos: [
    { content: '调研方案', status: 'in_progress' },
    { content: '写文档', status: 'pending' },
  ] } },
  { type: 'todo/write', seq: 2, time: 3000, data: { todos: [
    { content: '调研方案', status: 'completed' },
    { content: '写文档', status: 'in_progress' },
  ] } },
])
const todoView = buildClientView(todoState)
same('todo 降级: dataSource = todo', todoView.dataSource, 'todo')
same('todo 降级: 任务数', todoView.tasks.length, 2)
const todoResearch = todoView.tasks.find((task) => task.subject === '调研方案')
same('todo 降级: 状态历史', todoResearch.phases, [
  { status: 'in_progress', at: 2000 },
  { status: 'completed', at: 3000 },
])
same('todo 降级: 完成时间', todoResearch.completedAt, 3000)
// 团队任务板出现后 todo 任务退场
todoState = foldEvent(todoState, {
  type: 'team/task', seq: 3, time: 4000,
  data: { version: 2, teamId: 'session-todo', task: { id: 'task-1', revision: 1, subject: '团队任务', status: 'pending', blockedBy: [], writeScopes: [] } },
})
const teamView = buildClientView(todoState)
same('团队板出现: 只保留 team 任务', teamView.tasks.map((task) => [task.id, task.kind]), [['task-1', 'team']])
same('团队板出现: dataSource = team', teamView.dataSource, 'team')

// 3.3 未完成态（真实 p2p fixture 的前 60 秒切片：3 个 in_progress）
const p2pEvents = loadJsonl(path.join(FIXTURE_DIR, 'p2p-athena-port.jsonl'))
const p2pFirstStart = Math.min(
  ...p2pEvents
    .filter((event) => event.type === 'team/task' && event.data?.task?.status === 'in_progress')
    .map((event) => event.time),
)
const runningEvents = p2pEvents.filter((event) => event.type === 'session' || event.time <= p2pFirstStart + 60_000)
const runningView = buildClientView(foldEvents(null, runningEvents))
ok(runningView.taskStats.in_progress >= 3, `未完成态: ≥3 个 in_progress（实际 ${runningView.taskStats.in_progress}）`)
same('未完成态: 无 completed', runningView.taskStats.completed, 0)
const runningTasks = runningView.tasks.filter((task) => task.status === 'in_progress')
ok(runningTasks.every((task) => task.execMs === null), '未完成态: execMs 不虚构（null）')
ok(runningTasks.every((task) => task.startedAt !== null && task.owner !== null), '未完成态: 已开始且有负责人')

// 3.4 失败态 + 依赖阻塞（合成事件流，覆盖 fixture 中不存在的 failed 分支）
const failedState = foldEvents(null, [
  { type: 'session', id: 'session-fail', createdAt: 1000 },
  { type: 'team/task', seq: 1, time: 2000, data: { version: 2, teamId: 'session-fail', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } },
  { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-fail', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'failed', blockedBy: [], writeScopes: [] } } },
])
const failedView = buildClientView(failedState)
same('失败态: taskStats.failed = 1', failedView.taskStats.failed, 1)
same('失败态: failedAt 记录', failedView.tasks[0].failedAt, 3000)
ok(failedView.tasks[0].completedAt === null, '失败态: completedAt = null')

// 3.5 关系记录（只记录，不改任务状态）
let relationState = foldEvents(null, [
  { type: 'session', id: 'session-rel', createdAt: 1000 },
  { type: 'team/task', seq: 1, time: 2000, data: { version: 2, teamId: 'session-rel', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } },
  { type: 'team/task', seq: 2, time: 2100, data: { version: 2, teamId: 'session-rel', task: { id: 'task-2', revision: 1, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } },
])
const relationArgs = JSON.stringify({ parent_task: 'task-1', children: ['task-2'], kind: 'split', note: '拆分' })
relationState = foldEvent(relationState, { type: 'tool/call', seq: 3, time: 3000, data: { turn: 1, step: 1, callId: 'call-rel-1', name: 'task_map_record_relation', arguments: relationArgs } })
const relationStateDuplicate = foldEvent(relationState, { type: 'tool/call', seq: 4, time: 3100, data: { turn: 1, step: 1, callId: 'call-rel-2', name: 'task_map_record_relation', arguments: relationArgs } })
const relationView = buildClientView(relationStateDuplicate)
same('关系记录: 幂等（重复调用只留 1 条）', relationView.relations.length, 1)
same('关系记录: 不改变任务状态', relationView.tasks.map((task) => task.status), ['pending', 'pending'])
same('关系记录: 生成 relation 边', relationView.edges.filter((edge) => edge.kind === 'relation'), [{ from: 'task-1', to: 'task-2', kind: 'relation' }])

// 3.7 session/end-seed 尾巴：不计入回放范围/墙钟（App 关闭或重开历史会话时追加）
const seedTailMs = 3 * 60 * 60 * 1000
const seedState = foldEvents(null, [
  { type: 'session', id: 'session-seed', createdAt: 1000 },
  { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: 2500, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
  { type: 'tool/result', seq: 3, time: 3000, data: { message: { toolCallId: 'c1' } } },
  { type: 'turn/end', seq: 4, time: 4000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'session/end-seed', seq: 5, time: 4000 + seedTailMs, data: {} },
])
const seedView = buildClientView(seedState)
same('end-seed 尾巴: 回放终点 = 内容终点', seedView.timeRange.end, 4000)
same('end-seed 尾巴: rawEnd = 日志最后事件', seedView.timeRange.rawEnd, 4000 + seedTailMs)
same('end-seed 尾巴: wallClock 不受空转尾巴影响', seedView.waits.wallClockMs, 3000)
same('end-seed 尾巴: tailMs 记录尾巴长度', seedView.waits.tailMs, seedTailMs)
same('end-seed 尾巴: asOfSeq/asOfTime 仍推进', { seq: seedState.asOfSeq, time: seedState.asOfTime }, { seq: 5, time: 4000 + seedTailMs })

// 3.6 投影纪律 / 畸形事件
const solid = foldedBySlug.get(slugs[0]).state
const irrelevantBefore = solid.asOfSeq
for (const event of [
  { type: 'permission/preset', seq: 900001, time: Date.now(), data: { preset: 'standard' } },
  { type: 'session-log-deepseek/delivery-accepted', seq: 900002, time: Date.now(), data: {} },
  { type: 'user/message', seq: 900003, time: Date.now(), data: { content: 'hi' } },
]) {
  const next = foldEvent(solid, event)
  ok(Object.is(next, solid), `无关事件返回同一引用: ${event.type}`)
}
ok(solid.asOfSeq === irrelevantBefore, '无关事件不推进投影水位')
ok(Object.is(foldEvent(solid, null), solid), '畸形事件: null 返回同一引用')
ok(Object.is(foldEvent(solid, { type: 'team/task', data: null }), solid), '畸形事件: data=null 返回同一引用')
ok(Object.is(foldEvent(undefined, { type: 'team/task' }), undefined), '畸形状态: undefined 原样返回')


// ---------------------------------------------------------------------------
// 4. M2 数据层硬化：wire.view 体积 guard、截断模式、等待累加器、性能
// ---------------------------------------------------------------------------
console.log('\n[4] M2 数据层硬化（200 任务压测 / span 截断 / 等待累加器）')

/**
 * 合成 200 任务压测事件流：
 *   - team/task 全生命周期（pending→in_progress→completed，含依赖/负责人）
 *   - 每任务 wait_agent + 周期出现的 ask_user_question / approval（用于验证等待累加器）
 *   - 每任务多条 tool/call + job，确保状态 span 超过 MAX_SPANS=2000 触发截断
 * 返回 { events, expected }，expected 为独立累加出的等待总和。
 */
function makeLargeSession() {
  const taskCount = 200
  const events = []
  let seq = 0
  let time = 1_000_000
  const expected = { waitAgentMs: 0, askUserMs: 0, approvalMs: 0, toolCalls: 0, jobs: 0, approvals: 0 }
  const push = (event, deltaMs = 25) => {
    time += deltaMs
    seq += 1
    events.push({ ...event, seq, time })
  }
  push({ type: 'turn/start', data: { turn: 1 } })
  for (let i = 1; i <= taskCount; i += 1) {
    push({ type: 'team/task', data: { version: 2, teamId: 'session-large', task: { id: `task-${i}`, revision: 1, subject: `T${i} 长任务标题`, description: '详'.repeat(400), status: 'pending', blockedBy: i > 1 ? [`task-${i - 1}`] : [], writeScopes: ['a.js', 'b.tsx'] } } })
  }
  for (let i = 1; i <= taskCount; i += 1) {
    push({ type: 'team/task', data: { version: 2, teamId: 'session-large', task: { id: `task-${i}`, revision: 2, subject: `T${i} 长任务标题`, status: 'in_progress', blockedBy: i > 1 ? [`task-${i - 1}`] : [], writeScopes: ['a.js'], ownerId: `member-${i % 5}` } } })
    // 每任务 9 条工具调用（含 1 条 wait_agent），使状态 span 超过 MAX_SPANS=2000
    for (let c = 0; c < 9; c += 1) {
      const callId = `call-${i}-${c}`
      const isWait = c === 0
      const duration = isWait ? 100 + (i % 7) * 10 : 20
      push({ type: 'tool/call', data: { turn: 1, step: 1, callId, name: isWait ? 'wait_agent' : c === 1 ? 'bash' : 'read', arguments: '{}' } })
      push({ type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: callId } } }, duration)
      if (isWait) expected.waitAgentMs += duration
      expected.toolCalls += 1
    }
    if (i % 3 === 0) {
      const callId = `ask-${i}`
      push({ type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'ask_user_question', arguments: '{}' } })
      push({ type: 'tool/result', data: { turn: 1, step: 1, message: { toolCallId: callId } } }, 7)
      expected.askUserMs += 7
      expected.toolCalls += 1
    }
    if (i % 5 === 0) {
      const approvalId = `ap-${i}`
      push({ type: 'approval/asked', data: { id: approvalId, toolName: 'bash', callId: `call-${i}-1` } })
      push({ type: 'approval/decided', data: { id: approvalId, outcome: 'allowed-once' } }, 11)
      expected.approvalMs += 11
      expected.approvals += 1
    }
    const jobId = `job-${i}`
    push({ type: 'job/registered', data: { jobId, kind: 'bash', startedAt: time } })
    push({ type: 'job/settled', data: { jobId, kind: 'bash', startedAt: time, finishedAt: time + 30, status: 'completed' } }, 30)
    expected.jobs += 1
    push({ type: 'team/task', data: { version: 2, teamId: 'session-large', task: { id: `task-${i}`, revision: 3, subject: `T${i} 长任务标题`, status: 'completed', blockedBy: i > 1 ? [`task-${i - 1}`] : [], writeScopes: ['a.js'], ownerId: `member-${i % 5}` } } })
  }
  for (let i = 0; i < 5; i += 1) {
    push({ type: 'team/member', data: { version: 2, teamId: 'session-large', member: { id: `member-${i}`, name: `agent-${i}`, phase: 'active' } } })
  }
  push({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  return { events, expected }
}

{
  const { events: largeEvents, expected } = makeLargeSession()
  let largeState = emptyState({ id: 'session-large', createdAt: 1_000_000 })
  const foldStartedAt = performance.now()
  for (const event of largeEvents) largeState = foldEvent(largeState, event)
  const foldElapsed = performance.now() - foldStartedAt
  const viewStartedAt = performance.now()
  const largeView = buildClientView(largeState)
  const viewElapsed = performance.now() - viewStartedAt
  const largeBytes = Buffer.byteLength(JSON.stringify(largeView))
  const foldPerEvent = foldElapsed / largeEvents.length

  same('压测: 任务数', largeView.tasks.length, 200)
  same('压测: 全部完成', largeView.taskStats.completed, 200)
  ok(largeBytes < HARD_VIEW_LIMIT, '压测: wire.view < 200KB 硬上限', `${(largeBytes / 1024).toFixed(1)}KB`)
  same('压测: 状态 span 达 MAX_SPANS=2000 上限', largeState.spans.length, 2000)
  ok(largeView.spansTruncated === true, '压测: 触发 span 截断')
  ok(largeView.spans.length <= 200, '压测: 视图 span 数按档位受限（≤200）', String(largeView.spans.length))
  same('压测: spanSummary.total = 状态 span 数', largeView.spanSummary.total, largeState.spans.length)
  ok(largeView.viewLevel.description < 500, '压测: 描述按档位收窄', JSON.stringify(largeView.viewLevel))
  same('压测: spanSummary.kept = 视图 span 数', largeView.spanSummary.kept, largeView.spans.length)
  same('压测: spanSummary.omitted = total - kept', largeView.spanSummary.omitted, largeView.spanSummary.total - largeView.spans.length)
  // 关键：状态 span 被 2000 上限丢弃 + 视图 span 被截断，等待指标仍必须精确（独立累加器）
  same('压测: waitAgentMs 不受截断影响', largeView.waits.waitAgentMs, expected.waitAgentMs)
  same('压测: askUserMs 不受截断影响', largeView.waits.askUserMs, expected.askUserMs)
  same('压测: approvalMs 不受截断影响', largeView.waits.approvalMs, expected.approvalMs)
  same('压测: toolCalls 计数完整', largeView.counters.toolCalls, expected.toolCalls)
  same('压测: jobs 计数完整', largeView.counters.jobs, expected.jobs)
  ok(largeView.tasks.every((task) => typeof task.spanCount === 'number'), '压测: 截断模式下任务含 spanCount 聚合')
  ok(largeView.tasks.some((task) => task.spanCount > 0), '压测: spanCount 准确反映执行过程数量', JSON.stringify(largeView.tasks.slice(0, 3).map((task) => task.spanCount)))
  ok(foldPerEvent < 2, '压测: apply 单事件 < 2ms', `${foldPerEvent.toFixed(4)}ms`)
  ok(viewElapsed < 50, '压测: buildClientView < 50ms', `${viewElapsed.toFixed(1)}ms`)
  console.log(`  · 压测: ${largeEvents.length} 事件 / 200 任务 / state spans ${largeState.spans.length} / view ${(largeBytes / 1024).toFixed(1)}KB / fold ${foldElapsed.toFixed(1)}ms（${foldPerEvent.toFixed(4)}ms/事件）/ view ${viewElapsed.toFixed(1)}ms`)
}

// 4.2 P2 边缘：打开中的 wait/approval 对应 span 被 MAX_SPANS 淘汰后，关闭时仍精确累加
{
  let edge = foldEvents(null, [
    { type: 'session', id: 'session-edge', createdAt: 1 },
    { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  ])
  edge = foldEvent(edge, { type: 'tool/call', seq: 2, time: 2000, data: { turn: 1, step: 1, callId: 'lost-wait', name: 'wait_agent', arguments: '{}' } })
  edge = foldEvent(edge, { type: 'approval/asked', seq: 3, time: 2100, data: { id: 'lost-approval', toolName: 'bash', callId: 'call-x' } })
  let edgeSeq = 3
  let edgeTime = 2200
  for (let i = 0; i < 2100; i += 1) {
    const callId = `bulk-${i}`
    edgeTime += 1
    edgeSeq += 1
    edge = foldEvent(edge, { type: 'tool/call', seq: edgeSeq, time: edgeTime, data: { turn: 1, step: 1, callId, name: 'read', arguments: '{}' } })
    edgeTime += 1
    edgeSeq += 1
    edge = foldEvent(edge, { type: 'tool/result', seq: edgeSeq, time: edgeTime, data: { turn: 1, step: 1, message: { toolCallId: callId } } })
  }
  edge = foldEvent(edge, { type: 'tool/result', seq: edgeSeq + 1, time: 2000 + 4201, data: { turn: 1, step: 1, message: { toolCallId: 'lost-wait' } } })
  edge = foldEvent(edge, { type: 'approval/decided', seq: edgeSeq + 2, time: 2100 + 2500, data: { id: 'lost-approval', outcome: 'allowed-once' } })
  const edgeView = buildClientView(edge)
  same('边缘: wait span 被淘汰后 waitAgentMs 仍精确', edgeView.waits.waitAgentMs, 4201)
  same('边缘: approval span 被淘汰后 approvalMs 仍精确', edgeView.waits.approvalMs, 2500)
  same('边缘: pending 等待表已清理', Object.keys(edge.pendingWaits).length + Object.keys(edge.pendingApprovals).length, 0)
}


// ---------------------------------------------------------------------------
// 5. M3 基线与变更流：8→9 插入、依赖变更、拆分、todo 移除、基线宽限期
// ---------------------------------------------------------------------------
console.log('\n[5] M3 基线与变更流（计划基线 / 新增 / 依赖变更 / 拆分 / 移除）')

function buildBaselineEvents(taskCount) {
  const events = [
    { type: 'session', id: 'session-m3', createdAt: 1000 },
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
  ]
  let seq = 1
  for (let index = 1; index <= taskCount; index += 1) {
    seq += 1
    events.push({ type: 'team/task', seq, time: 3000 + index, data: { version: 2, teamId: 'session-m3', task: { id: `task-${index}`, revision: 1, subject: `T${index}`, status: 'pending', blockedBy: [], writeScopes: [] } } })
  }
  // 开始执行第一个任务 → 基线封板
  seq += 1
  events.push({ type: 'team/task', seq, time: 5000, data: { version: 2, teamId: 'session-m3', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } })
  return { events, nextSeq: seq, closeAt: 5000 }
}

{
  // 5.1 基线 8 → 插入第 9 个任务：diff +1，变更流有「新增」且时刻正确
  const { events, nextSeq } = buildBaselineEvents(8)
  let state = foldEvents(null, events)
  let view = buildClientView(state)
  same('M3 8→9: 基线 = 8', view.baseline.taskIds.length, 8)
  same('M3 8→9: 初始无新增', view.changes.added, [])
  state = foldEvent(state, { type: 'team/task', seq: nextSeq + 1, time: 20_000, data: { version: 2, teamId: 'session-m3', task: { id: 'task-9', revision: 1, subject: 'T9 插入任务', status: 'pending', blockedBy: ['task-1'], writeScopes: [] } } })
  view = buildClientView(state)
  same('M3 8→9: diff 新增 1 个', view.changes.added, ['task-9'])
  same('M3 8→9: counts', pick(view.changes.counts, ['planned', 'added']), { planned: 8, added: 1 })
  same('M3 8→9: 变更流含新增', view.changes.log.map((entry) => [entry.kind, entry.taskId, entry.at]), [['added', 'task-9', 20_000]])
  ok(view.changes.log[0].text.includes('T9 插入任务'), 'M3 8→9: 变更文案含任务标题', view.changes.log[0].text)

  // 5.2 基线后依赖变更（超过宽限期）→ dependencyChanged + 日志
  state = foldEvent(state, { type: 'team/task', seq: nextSeq + 2, time: 30_000, data: { version: 2, teamId: 'session-m3', task: { id: 'task-2', revision: 2, subject: 'T2', status: 'pending', blockedBy: ['task-1'], writeScopes: [] } } })
  view = buildClientView(state)
  same('M3 依赖变更: dependencyChanged', view.changes.dependencyChanged, [{ id: 'task-2', from: [], to: ['task-1'], at: 30_000 }])
  ok(view.changes.log.some((entry) => entry.kind === 'dependency' && entry.taskId === 'task-2'), 'M3 依赖变更: 日志含 dependency')
  ok(view.changes.log.filter((entry) => entry.kind === 'dependency').every((entry) => !view.baseline.taskIds.includes(entry.taskId) || entry.at > view.baseline.closedAt), 'M3 依赖变更: 均晚于基线封板')

  // 5.3 关系记录 → 拆分分叉 + 日志（只记录，不改任务状态）
  const beforeStatuses = JSON.stringify(view.tasks.map((task) => task.status))
  state = foldEvent(state, { type: 'tool/call', seq: nextSeq + 3, time: 40_000, data: { turn: 1, step: 1, callId: 'rel-1', name: 'task_map_record_relation', arguments: JSON.stringify({ parent_task: 'task-1', children: ['task-9'], kind: 'split', note: '拆出验收任务' }) } })
  view = buildClientView(state)
  same('M3 拆分: splits', view.changes.splits.map((split) => [split.parent, split.children, split.kind, split.at]), [['task-1', ['task-9'], 'split', 40_000]])
  ok(view.changes.log.some((entry) => entry.kind === 'split' && entry.taskId === 'task-1'), 'M3 拆分: 日志含 split')
  same('M3 拆分: 不改变任务状态', JSON.stringify(view.tasks.map((task) => task.status)), beforeStatuses)
  same('M3 拆分: relation 边', view.edges.filter((edge) => edge.kind === 'relation'), [{ from: 'task-1', to: 'task-9', kind: 'relation' }])

  // 5.4 宽限期内的依赖补写不算变更（模拟任务板批量写入尾随 revision）
  const { events: graceEvents, nextSeq: graceSeq } = buildBaselineEvents(3)
  let graceState = foldEvents(null, graceEvents)
  graceState = foldEvent(graceState, { type: 'team/task', seq: graceSeq + 1, time: 5000 + 300, data: { version: 2, teamId: 'session-m3', task: { id: 'task-3', revision: 2, subject: 'T3', status: 'pending', blockedBy: ['task-1', 'task-2'], writeScopes: [] } } })
  const graceView = buildClientView(graceState)
  same('M3 宽限期: 不产生依赖变更', graceView.changes.dependencyChanged, [])
  same('M3 宽限期: 基线 blockedBy 已并入', graceView.changes.counts.planned, 3)
}

{
  // 5.5 todo 降级模式：首次清单为基线，删除条目 → removed + 日志（真实数据无此场景，合成覆盖）
  let state = foldEvents(null, [
    { type: 'session', id: 'session-m3-todo', createdAt: 1000 },
    { type: 'todo/write', seq: 1, time: 2000, data: { todos: [ { content: '写方案', status: 'pending' }, { content: '做验收', status: 'pending' } ] } },
  ])
  let view = buildClientView(state)
  same('M3 todo: 基线 = 首次清单 2 项', view.baseline.taskIds.length, 2)
  same('M3 todo: 初始无新增/删除', [view.changes.added, view.changes.removed], [[], []])
  state = foldEvent(state, { type: 'todo/write', seq: 2, time: 3000, data: { todos: [ { content: '写方案', status: 'completed' } ] } })
  view = buildClientView(state)
  same('M3 todo: 删除 1 项', view.changes.removed.length, 1)
  same('M3 todo: 日志含移除', view.changes.log.filter((entry) => entry.kind === 'removed').map((entry) => entry.at), [3000])
  same('M3 todo: counts', pick(view.changes.counts, ['planned', 'removed']), { planned: 2, removed: 1 })
}


// ---------------------------------------------------------------------------
// 6. M4 边界修复：同毫秒封板/未封板期/计数口径/todo→team/无效关系
// ---------------------------------------------------------------------------
console.log('\n[6] M4 边界：同毫秒 / 未封板 / 计数口径 / todo→team / 无效关系')

{
  // 6.1 同毫秒封板 + 新增：added 记录允许 at >= cutoff
  let sameMs = foldEvents(null, [
    { type: 'session', id: 'session-m4a', createdAt: 1000 },
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
  ])
  let seq = 1
  for (let index = 1; index <= 3; index += 1) {
    seq += 1
    sameMs = foldEvent(sameMs, { type: 'team/task', seq, time: 3000, data: { version: 2, teamId: 'session-m4a', task: { id: `task-${index}`, revision: 1, subject: `T${index}`, status: 'pending', blockedBy: [], writeScopes: [] } } })
  }
  seq += 1
  sameMs = foldEvent(sameMs, { type: 'team/task', seq, time: 5000, data: { version: 2, teamId: 'session-m4a', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } })
  seq += 1
  sameMs = foldEvent(sameMs, { type: 'team/task', seq, time: 5000, data: { version: 2, teamId: 'session-m4a', task: { id: 'task-4', revision: 1, subject: 'T4 同毫秒插入', status: 'pending', blockedBy: [], writeScopes: [] } } })
  const sameMsView = buildClientView(sameMs)
  same('M4 同毫秒: 新增可见', sameMsView.changes.added, ['task-4'])
  same('M4 同毫秒: log 含新增（at >= cutoff）', sameMsView.changes.log.filter((entry) => entry.kind === 'added').map((entry) => entry.taskId), ['task-4'])
  same('M4 同毫秒: counts.added = log 条数', sameMsView.changes.counts.added, 1)

  // 6.2 未封板期的依赖变更不算变更（cutoff=Infinity）
  let openState = foldEvents(null, [
    { type: 'session', id: 'session-m4b', createdAt: 1000 },
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
    { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-m4b', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 3, time: 3100, data: { version: 2, teamId: 'session-m4b', task: { id: 'task-2', revision: 1, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } },
  ])
  openState = foldEvent(openState, { type: 'team/task', seq: 4, time: 4000, data: { version: 2, teamId: 'session-m4b', task: { id: 'task-2', revision: 2, subject: 'T2', status: 'pending', blockedBy: ['task-1'], writeScopes: [] } } })
  const openView = buildClientView(openState)
  same('M4 未封板期: 依赖变更不进 view.changes', openView.changes.dependencyChanged, [])
  same('M4 未封板期: 变更流为空', openView.changes.log, [])

  // 6.3 同一任务依赖变更两次：dependencyChanged 去重但 counts 按 log 计
  let depTwice = foldEvents(null, [
    { type: 'session', id: 'session-m4c', createdAt: 1000 },
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
    { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-m4c', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 3, time: 3100, data: { version: 2, teamId: 'session-m4c', task: { id: 'task-2', revision: 1, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 4, time: 5000, data: { version: 2, teamId: 'session-m4c', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } },
  ])
  depTwice = foldEvent(depTwice, { type: 'team/task', seq: 5, time: 20_000, data: { version: 2, teamId: 'session-m4c', task: { id: 'task-2', revision: 2, subject: 'T2', status: 'pending', blockedBy: ['task-1'], writeScopes: [] } } })
  depTwice = foldEvent(depTwice, { type: 'team/task', seq: 6, time: 21_000, data: { version: 2, teamId: 'session-m4c', task: { id: 'task-2', revision: 3, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } })
  const depTwiceView = buildClientView(depTwice)
  same('M4 依赖两次: dependencyChanged 去重为 1', depTwiceView.changes.dependencyChanged.length, 1)
  same('M4 依赖两次: counts 按 log 计为 2', depTwiceView.changes.counts.dependencyChanged, 2)
}

{
  // 6.4 todo 降级 → team 板切换：基线重置、todo 阶段变更流清空
  let switchState = foldEvents(null, [
    { type: 'session', id: 'session-m4d', createdAt: 1000 },
    { type: 'todo/write', seq: 1, time: 2000, data: { todos: [ { content: '待办 A', status: 'pending' } ] } },
  ])
  const todoView = buildClientView(switchState)
  same('M4 todo 基线: 1 项', todoView.baseline.taskIds.length, 1)
  switchState = foldEvent(switchState, { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-m4d', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } })
  switchState = foldEvent(switchState, { type: 'turn/start', seq: 3, time: 3100, data: { turn: 1 } })
  switchState = foldEvent(switchState, { type: 'team/task', seq: 4, time: 5000, data: { version: 2, teamId: 'session-m4d', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } })
  switchState = foldEvent(switchState, { type: 'team/task', seq: 5, time: 20_000, data: { version: 2, teamId: 'session-m4d', task: { id: 'task-2', revision: 1, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } })
  const switchView = buildClientView(switchState)
  same('M4 todo→team: 基线重置为 team 任务', switchView.baseline.taskIds, ['task-1'])
  same('M4 todo→team: 只有切换后的新增', switchView.changes.added, ['task-2'])
  same('M4 todo→team: 变更流无 todo 阶段残留', switchView.changes.log.filter((entry) => entry.taskId.startsWith('todo:')).length, 0)
}

{
  // 6.5 无效关系：valid=false + warnings（只记录，不伪造）
  let invalidRel = foldEvents(null, [
    { type: 'session', id: 'session-m4e', createdAt: 1000 },
    { type: 'turn/start', seq: 1, time: 2000, data: { turn: 1 } },
    { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-m4e', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 3, time: 5000, data: { version: 2, teamId: 'session-m4e', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } },
    { type: 'tool/call', seq: 4, time: 6000, data: { turn: 1, step: 1, callId: 'rel-x', name: 'task_map_record_relation', arguments: JSON.stringify({ parent_task: 'task-1', children: ['task-404'], kind: 'split' }) } },
  ])
  const invalidView = buildClientView(invalidRel)
  same('M4 无效关系: valid=false', invalidView.relations.map((relation) => relation.valid), [false])
  same('M4 无效关系: source=tool', invalidView.relations.map((relation) => relation.source), ['tool'])
  ok(invalidView.warnings.some((warning) => warning.code === 'relation-child-missing'), 'M4 无效关系: warnings 含 child-missing', JSON.stringify(invalidView.warnings))
  same('M4 无效关系: 不计入有效拆分', invalidView.changes.splits.length, 0)
  same('M4 无效关系: 单独列在 invalidRelations', invalidView.changes.invalidRelations.map((item) => [item.parent, item.children, item.missing]), [['task-1', ['task-404'], ['task-404']]])
  same('M4 无效关系: counts.splits=0 / counts.invalidRelations=1', [invalidView.changes.counts.splits, invalidView.changes.counts.invalidRelations], [0, 1])
  same('M4 无效关系: 变更流无拆分条目', invalidView.changes.log.filter((entry) => entry.kind === 'split').length, 0)
  ok(invalidView.relations.some((relation) => relation.valid === false), 'M4 无效关系: relations 仍保留记录（可审计）')
  same('M4 无效关系: 不改变任务状态', invalidView.tasks.map((task) => task.status), ['in_progress'])
}


// ---------------------------------------------------------------------------
// 7. v1.1：会话 todo 计划（plan）与团队任务并存
// ---------------------------------------------------------------------------
console.log('\n[7] v1.1 会话计划：todo 计划与团队任务并存')

{
  const todoEvents = [
    { type: 'session', id: 'session-plan', createdAt: 1000 },
    { type: 'todo/write', seq: 1, time: 2000, data: { todos: [
      { content: '盘点现状', status: 'completed' },
      { content: '定义目标目录树', status: 'in_progress' },
      { content: '写迁移脚本', status: 'pending' },
    ] } },
  ]
  let planState = foldEvents(null, todoEvents)
  const todoView = buildClientView(planState)
  same('plan: 无团队任务时为 todo 降级视图', todoView.dataSource, 'todo')
  same('plan: 折叠 3 项', todoView.plan.items.length, 3)
  same('plan: counts', [todoView.plan.counts.completed, todoView.plan.counts.inProgress, todoView.plan.counts.pending], [1, 1, 1])
  same('plan: 无团队任务时 active=false（客户端不重复展示）', todoView.plan.active, false)
  same('plan: 序号 1..n', todoView.plan.items.map((item) => item.index), [1, 2, 3])

  // 团队任务板出现：任务图切到 team，但 todo 计划保留（这就是用户反馈的缺口）
  let bothState = foldEvent(planState, { type: 'team/task', seq: 2, time: 3000, data: { version: 2, teamId: 'session-plan', task: { id: 'task-1', revision: 1, subject: 'T1', status: 'pending', blockedBy: [], writeScopes: [] } } })
  bothState = foldEvent(bothState, { type: 'team/task', seq: 3, time: 3100, data: { version: 2, teamId: 'session-plan', task: { id: 'task-2', revision: 1, subject: 'T2', status: 'pending', blockedBy: [], writeScopes: [] } } })
  const bothView = buildClientView(bothState)
  same('plan: team 出现后 dataSource=team', bothView.dataSource, 'team')
  same('plan: team 出现后任务图仍是团队任务', bothView.tasks.map((task) => task.id), ['task-1', 'task-2'])
  same('plan: team 出现后 todo 计划仍保留 3 项', bothView.plan.items.length, 3)
  same('plan: team 出现后 active=true', bothView.plan.active, true)
  same('plan: 计划不再生成降级 task-* 任务（不重复）', bothView.tasks.filter((task) => task.kind === 'todo').length, 0)

  // todo 更新状态/内容：plan 计数与项更新时间更新，直到封板
  let updated = foldEvent(bothState, { type: 'turn/start', seq: 4, time: 3200, data: { turn: 1 } })
  updated = foldEvent(updated, { type: 'team/task', seq: 5, time: 5000, data: { version: 2, teamId: 'session-plan', task: { id: 'task-1', revision: 2, subject: 'T1', status: 'in_progress', blockedBy: [], writeScopes: [] } } })
  updated = foldEvent(updated, { type: 'todo/write', seq: 6, time: 6000, data: { todos: [
    { content: '盘点现状', status: 'completed' },
    { content: '定义目标目录树', status: 'completed' },
    { content: '写迁移脚本', status: 'in_progress' },
    { content: '跑验证', status: 'pending' },
  ] } })
  const updatedView = buildClientView(updated)
  same('plan: 更新后 4 项', updatedView.plan.items.length, 4)
  same('plan: 更新后 counts', [updatedView.plan.counts.completed, updatedView.plan.counts.inProgress, updatedView.plan.counts.pending], [2, 1, 1])
  same('plan: writeCount=2', updatedView.plan.writeCount, 2)
  same('plan: 任务图不受 todo 更新影响', updatedView.tasks.map((task) => task.id), ['task-1', 'task-2'])
  same('plan: 已存在项 updatedAt 仅在变化时更新', updatedView.plan.items[0].updatedAt, 2000)
  same('plan: 状态变化的项 updatedAt=6000', updatedView.plan.items[1].updatedAt, 6000)
}

{
  // 空 todo：plan 为 null，不影响任务
  let empty = foldEvents(null, [
    { type: 'session', id: 'session-plan-empty', createdAt: 1000 },
    { type: 'todo/write', seq: 1, time: 2000, data: { todos: [] } },
  ])
  same('plan: 空 todo → view.plan=null', buildClientView(empty).plan, null)
}

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log(`\n[derive-test] ${passed} checks passed, ${failures.length} failed`)
for (const slug of slugs) {
  const { view, elapsedMs } = foldedBySlug.get(slug)
  const byStatus = view.tasks.reduce((acc, task) => {
    acc[task.status] = (acc[task.status] ?? 0) + 1
    return acc
  }, {})
  console.log(
    `  · ${slug}: tasks=${view.tasks.length} ${JSON.stringify(byStatus)} ` +
      `queue=${(view.waits.queueMs / 60000).toFixed(1)}min exec=${(view.waits.taskExecMs / 60000).toFixed(1)}min ` +
      `waitAgent=${(view.waits.waitAgentMs / 60000).toFixed(1)}min fold+view=${elapsedMs.toFixed(1)}ms`,
  )
}

if (failures.length > 0) {
  console.error(`\n[derive-test] FAILED: ${failures.length} 项`)
  for (const failure of failures) console.error(` - ${failure}`)
  process.exit(1)
}
console.log('\n[derive-test] PASS')
