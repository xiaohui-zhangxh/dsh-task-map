#!/usr/bin/env node
/**
 * M1 host smoke：用 stub ctx 调 apply(ctx)，断言投影/工具/路由注册，
 * 并验证投影折叠真实形状（team/task → 任务视图）与 Object.is 门控。
 * 真实实例验证见 docs/进度日志.md 的隔离 DSH_HOME 步骤（W1.6）。
 */
import { apply, inject, name } from '../index.js'
import { STATE_VERSION } from '../lib/derive.js'

const failures = []
const ok = (condition, label, detail = '') => {
  if (condition) console.log(`  ✓ ${label}`)
  else { failures.push(label + (detail ? ` (${detail})` : '')); console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`) }
}

// W4.1：关系工具会通过 ctx.get('sessions')/ctx.get('sessionProjections') 校验任务 id，这里提供只读 stub。
const boardTasks = {
  'task-1': { id: 'task-1' },
  'task-2': { id: 'task-2' },
  'task-3': { id: 'task-3' },
  'task-4': { id: 'task-4' },
  'task-9': { id: 'task-9' },
  'task-10': { id: 'task-10' },
}
const state = {
  projections: [],
  tools: [],
  routes: [],
  services: {
    sessions: { get: (id) => (id === 'session-test' ? { id } : undefined) },
    sessionProjections: {
      stateOf: (session, key) => (key === 'taskMap' ? { sessionId: 'session-test', tasks: boardTasks } : undefined),
    },
  },
}
function childContext(services) {
  const child = {
    effect: (fn) => { fn(); return () => {} },
    get: (key) => state.services[key],
  }
  if (services.includes('sessionProjections')) child.sessionProjections = {
    register: (definition) => { state.projections.push(definition); return () => {} },
  }
  if (services.includes('tools')) child.tools = {
    register: (definition) => { state.tools.push(definition); return () => {} },
  }
  if (services.includes('webServer')) child.webServer = {
    register: (route) => { state.routes.push(route); return () => {} },
  }
  return child
}
const ctx = {
  inject: (services, callback) => callback(childContext(services)),
  get: (key) => state.services[key],
}

console.log(`[host-smoke] plugin=${name} inject=${JSON.stringify(inject)}`)
apply(ctx)

ok(state.projections.length === 1, 'session projection registered', `got ${state.projections.length}`)
const definition = state.projections[0]
ok(definition?.key === 'taskMap', 'projection key = taskMap', definition?.key)
ok(definition?.stateVersion === STATE_VERSION, `projection stateVersion = ${STATE_VERSION}`, String(definition?.stateVersion))
ok(typeof definition?.apply === 'function' && typeof definition?.init === 'function', 'projection has init() + apply()')
ok(state.tools.length === 2, 'two agent tools registered', `got ${state.tools.length}`)
ok(state.tools.some((tool) => tool.name === 'task_map_ping'), 'tool task_map_ping present')
ok(state.tools.some((tool) => tool.name === 'task_map_record_relation'), 'tool task_map_record_relation present')
ok(state.routes.length === 1 && state.routes[0].path === '/task-map/api/health', 'health route registered', JSON.stringify(state.routes.map((route) => route.path)))

// ---- 工具执行 ----
const ping = state.tools.find((tool) => tool.name === 'task_map_ping')
const rel = state.tools.find((tool) => tool.name === 'task_map_record_relation')
const pingValue = await ping.execute({})
ok(pingValue.ok === true && pingValue.projection === true, 'ping tool returns ok + projection=true', JSON.stringify(pingValue))
const execCtx = { agent: { id: 'session-test' } }
const boardSnapshotBefore = JSON.stringify(boardTasks)
const relValue = await rel.execute({ parent_task: 'task-4', children: ['task-9', 'task-10'], kind: 'split', note: '拆分验收' }, execCtx)
ok(relValue.ok === true && relValue.validated === true && relValue.recorded.children.length === 2, 'relation tool records split (validated)', JSON.stringify(relValue))
ok(relValue.recorded.note === '拆分验收', 'relation tool keeps note')
const missingParent = await rel.execute({ parent_task: 'task-99', children: ['task-9'], kind: 'split' }, execCtx)
ok(missingParent.ok === false && missingParent.validated === false && missingParent.invalidIds.includes('task-99'), 'relation tool rejects missing parent', JSON.stringify(missingParent))
const missingChild = await rel.execute({ parent_task: 'task-4', children: ['task-9', 'task-404'], kind: 'split' }, execCtx)
ok(missingChild.ok === false && missingChild.invalidIds.includes('task-404'), 'relation tool rejects missing child', JSON.stringify(missingChild))
const emptyChildren = await rel.execute({ parent_task: 'task-4', children: [], kind: 'split' }, execCtx)
ok(emptyChildren.ok === false && /children/.test(emptyChildren.reason), 'relation tool rejects empty children', JSON.stringify(emptyChildren))
const selfRef = await rel.execute({ parent_task: 'task-4', children: ['task-4'], kind: 'split' }, execCtx)
ok(selfRef.ok === false && /parent_task/.test(selfRef.reason), 'relation tool rejects self reference', JSON.stringify(selfRef))
const badKind = await rel.execute({ parent_task: 'task-4', children: ['task-9'], kind: 'merge' }, execCtx)
ok(badKind.ok === false && /kind/.test(badKind.reason), 'relation tool rejects invalid kind', JSON.stringify(badKind))
const noAgent = await rel.execute({ parent_task: 'task-4', children: ['task-9'], kind: 'split' }, {})
ok(noAgent.ok === false && /会话上下文/.test(noAgent.reason), 'relation tool degrades without session context', JSON.stringify(noAgent))
ok(relValue.validated === true && JSON.stringify(boardTasks) === boardSnapshotBefore, 'relation tool validates ids and only records (task board JSON unchanged after all calls)')

// ---- 投影 init / 折叠 ----
let value = definition.init({ id: 'session-test', createdAt: 1000, cwd: '/workspace/demo' })
ok(value.sessionId === 'session-test' && value.stateVersion === STATE_VERSION, 'projection init from session header')
ok(value.counters.toolCalls === 0 && value.hasTeamBoard === false, 'projection init has empty task state')

// 无关事件：同一引用（宿主据此跳过推送）
const ignored = definition.apply(value, { type: 'user/message', seq: 1, time: 1100, data: { content: 'hi' } })
ok(Object.is(ignored, value), 'irrelevant event returns the same reference')

value = definition.apply(value, { type: 'turn/start', seq: 2, time: 2000, data: { turn: 1 } })
value = definition.apply(value, {
  type: 'team/task', seq: 3, time: 3000,
  data: { version: 2, teamId: 'session-test', task: { id: 'task-1', revision: 1, subject: 'T1 实现', status: 'pending', blockedBy: [], writeScopes: ['a.js'] } },
})
value = definition.apply(value, {
  type: 'team/member', seq: 4, time: 3100,
  data: { version: 2, teamId: 'session-test', member: { id: 'member-1', name: 'alice', phase: 'active' } },
})
value = definition.apply(value, {
  type: 'team/task', seq: 5, time: 4000,
  data: { version: 2, teamId: 'session-test', task: { id: 'task-1', revision: 2, subject: 'T1 实现', status: 'in_progress', blockedBy: [], writeScopes: ['a.js'], ownerId: 'member-1' } },
})
value = definition.apply(value, {
  type: 'team/task', seq: 6, time: 5000,
  data: { version: 2, teamId: 'session-test', task: { id: 'task-1', revision: 3, subject: 'T1 实现', status: 'completed', blockedBy: [], writeScopes: ['a.js'], ownerId: 'member-1' } },
})
value = definition.apply(value, {
  type: 'assistant/message', seq: 7, time: 5100,
  data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 0, totalTokens: 60 } },
})
ok(value.asOfSeq === 7 && value.tasks['task-1']?.status === 'completed', 'projection folds team/task revisions', JSON.stringify({ asOfSeq: value.asOfSeq, status: value.tasks['task-1']?.status }))
ok(value.tasks['task-1']?.startedAt === 4000 && value.tasks['task-1']?.completedAt === 5000, 'projection records start/finish timestamps')
ok(value.usage.total === 60, 'projection sums token usage', JSON.stringify(value.usage))

// 畸形事件不得抛错
const malformed = definition.apply(value, { type: 'team/task', seq: 8, time: 5200, data: null })
ok(Object.is(malformed, value), 'malformed event is ignored without throwing')

const view = definition.wire.view(value)
definition.wire.viewSchema.parse(view)
ok(view.stateVersion === STATE_VERSION && view.hasTeamBoard === true, 'wire.view exposes client view')
ok(view.tasks.length === 1 && view.tasks[0].owner === 'alice' && view.tasks[0].execMs === 1000, 'client view has task/owner/metrics', JSON.stringify(view.tasks[0]))
ok(view.waits.preTurnMs === 1000 && view.waits.wallClockMs === 4100, 'client view computes waits', JSON.stringify(view.waits))
ok(JSON.stringify(view).length < 200 * 1024, 'wire.view under 200KB hard limit', `${JSON.stringify(view).length} bytes`)

// ---- 健康路由 ----
const callHealth = (headers) => {
  let responseBody = ''
  const response = { writeHead: (code) => { response.code = code }, end: (body) => { responseBody = body } }
  state.routes[0].handler({ url: '/task-map/api/health', headers }, response)
  return { code: response.code, body: responseBody ? JSON.parse(responseBody) : null }
}
const sameOrigin = callHealth({ 'sec-fetch-site': 'same-origin', host: '127.0.0.1:8088' })
ok(sameOrigin.code === 200 && sameOrigin.body.ok === true, 'health route allows same-origin (Sec-Fetch-Site)', JSON.stringify(sameOrigin))
ok(sameOrigin.body.projection === true && sameOrigin.body.stateVersion === STATE_VERSION && sameOrigin.body.tools.length === 2 && sameOrigin.body.route === true, 'health reports projection/stateVersion/tools/route', JSON.stringify(sameOrigin.body))
const byOrigin = callHealth({ origin: 'http://127.0.0.1:8088', host: '127.0.0.1:8088' })
ok(byOrigin.code === 200 && byOrigin.body.ok === true, 'health route allows matching Origin+Host', JSON.stringify(byOrigin))
const bare = callHealth({})
ok(bare.code === 403 && bare.body.ok === false, 'health route rejects bare requests (403)', JSON.stringify(bare))
const crossOrigin = callHealth({ origin: 'http://evil.example', host: '127.0.0.1:8088' })
ok(crossOrigin.code === 403 && crossOrigin.body.ok === false, 'health route rejects cross-origin (403)', JSON.stringify(crossOrigin))
const debugKeys = ['projectionError', 'toolErrors', 'routeError', 'mode', 'startedAt']
ok(debugKeys.every((key) => !(key in sameOrigin.body)), 'health response has no debug fields', JSON.stringify(Object.keys(sameOrigin.body)))

if (failures.length > 0) {
  console.error(`\n[host-smoke] FAILED: ${failures.length} check(s)`)
  for (const failure of failures) console.error(' - ' + failure)
  process.exit(1)
}
console.log('\n[host-smoke] PASS')
