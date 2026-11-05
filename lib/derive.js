/**
 * DSH Task Map — 数据核心（M1）。
 *
 * 设计原则（见 docs/产品方案与开发计划.md §6、§7 与技术方案 §2）：
 *   · 纯函数：不读文件、不联网、不依赖宿主 API；相同事件流必得相同状态；
 *   · 只读派生：只从会话事件算数据，绝不写回会话日志或任务状态；
 *   · 投影纪律：apply 同步执行；无关/未知事件必须返回**同一引用**（Object.is 门控）；
 *     状态只包含可 JSON 序列化的普通对象/数组；
 *   · 先数据后 UI：本文件不关心渲染，只产出 client 可见视图（buildClientView）。
 *
 * 状态形状变化时必须升 STATE_VERSION（当前 3；M1 为 2，M0 空折叠为 1）。
 *
 * 数据来源事件（M1 覆盖）：
 *   session（头）、team/task、team/member、todo/write、turn/start|end、step/start|end、
 *   tool/call、tool/result、job/registered、job/settled、approval/asked、approval/decided、
 *   subagent/catalog、subagent/descriptor、assistant/message、session/title、
 *   deliverables/presented、command/run|done、session/end-seed、goal/change。
 *
 * 不在投影里存储单条 step（噪音大、体积大）：只累计计数；执行过程用 tool/job/approval span。
 */

// 状态/视图契约版本：形状变化必须 +1，旧缓存随之失效。
// v3（M4）：新增 changeLog / baseline.blockedBy / task.createdSeq / dependencyChanges /
// blockedByChangedAt / relations.source，并修正变更流 as-of/同毫秒边界口径。
// v4（v1.1）：新增 state.plan（会话 todo 计划），与团队任务并存展示。
export const STATE_VERSION = 4

// 状态体积保护：span 超过上限时丢弃最旧的（计数不受影响）。
const MAX_SPANS = 2000
// 视图体积保护（方案 §2.2/§7.3，wire.view 硬上限 200KB）：
// 按任务数/span 数选择降级档位（描述变短、只留最近 N 条 span），并给出聚合摘要；
// 估算按「中文 3 字节/字 + 每任务结构开销」保守计算，保证 200 任务也 < 200KB。
const VIEW_SOFT_LIMIT = 165 * 1024
const VIEW_LEVELS = [
  { description: 500, spans: Infinity },
  { description: 160, spans: 500 },
  { description: 60, spans: 200 },
  { description: 20, spans: 120 },
]
// 每任务固定结构开销（id/phases/指标/依赖等，按实测 750B 上限保守取 600）与每条 span 估算字节。
const VIEW_TASK_FIXED_BYTES = 600
const VIEW_SPAN_BYTES = 100

function estimateViewBytes(taskCount, spanCount, level) {
  const spanCap = Number.isFinite(level.spans) ? Math.min(spanCount, level.spans) : spanCount
  return taskCount * (level.description * 3 + VIEW_TASK_FIXED_BYTES) + spanCap * VIEW_SPAN_BYTES + 4096
}

/** 选择体积档位：优先完整视图；超软阈值则逐级降级。 */
function chooseViewLevel(taskCount, spanCount) {
  for (const level of VIEW_LEVELS) {
    if (estimateViewBytes(taskCount, spanCount, level) <= VIEW_SOFT_LIMIT) return level
  }
  return VIEW_LEVELS[VIEW_LEVELS.length - 1]
}
// 投影内部字符串上限（视图里还会再截断到更小值）。
const LIMIT_DESCRIPTION_STATE = 4000
const LIMIT_SUBJECT_STATE = 200
const LIMIT_WRITE_SCOPES_STATE = 50
const LIMIT_TITLES = 20
const LIMIT_MILESTONES = 100
const LIMIT_COMMANDS = 100
const LIMIT_CHANGELOG_STATE = 500
const LIMIT_DEPENDENCY_HISTORY = 20
const LIMIT_CHANGELOG_VIEW = 200
// 基线封板宽限期：任务板批量创建后若干毫秒内、尚未开始执行的任务的“依赖补写”
// 仍属于计划阶段（避免把初始写入的收尾 revision 误报为依赖变更）。
const BASELINE_GRACE_MS = 10_000
// 视图字段上限（wire.view 体积纪律：8 任务 < 30KB，200 任务 < 200KB）。
const LIMIT_DESCRIPTION_VIEW = 500
const LIMIT_SUBJECT_VIEW = 200
const LIMIT_WRITE_SCOPES_VIEW = 20
const LIMIT_LABEL_VIEW = 120

// 任务终态集合（用于统计/排名）。
const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'blocked']

/** 会被 fold 处理的事件类型（用于判定「首任务刷写是否结束」，以及未知事件诊断）。 */
const HANDLED_TYPES = new Set([
  'session',
  'team/task',
  'team/member',
  'todo/write',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'tool/call',
  'tool/result',
  'job/registered',
  'job/settled',
  'approval/asked',
  'approval/decided',
  'subagent/catalog',
  'subagent/descriptor',
  'assistant/message',
  'session/title',
  'deliverables/presented',
  'command/run',
  'command/done',
  'session/end-seed',
  'goal/change',
])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function text(value) {
  return typeof value === 'string' ? value : ''
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** 事件时间（毫秒）；非法时回落 null。 */
function eventTime(event) {
  return finiteNumber(event?.time)
}

/** 事件 seq；非法时回落 -1。 */
function eventSeq(event) {
  const seq = finiteNumber(event?.seq)
  return seq === null ? -1 : seq
}

function truncate(value, limit) {
  const source = text(value)
  if (source.length <= limit) return source
  return `${source.slice(0, limit - 1)}…`
}

function stringArray(value, limit) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    if (limit > 0 && out.length >= limit) break
    out.push(item)
  }
  return out
}

/** 码点序比较（与 Python 默认字符串排序一致，避免 localeCompare 的区域差异）。 */
function compareText(a, b) {
  const left = text(a)
  const right = text(b)
  if (left === right) return 0
  return left < right ? -1 : 1
}

/** 事件 data 里嵌套任务的规范化状态。 */
function taskStatus(value) {
  return TASK_STATUSES.includes(value) ? value : 'pending'
}

/** todo 状态映射到任务状态（todo 没有 blocked）。 */
function todoStatus(value) {
  if (value === 'completed') return 'completed'
  if (value === 'in_progress' || value === 'active') return 'in_progress'
  return 'pending'
}

/** FNV-1a 32 位哈希：给 todo 任务生成稳定 id（内容相同 → id 相同）。 */
function stableHash(value) {
  let hash = 0x811c9dc5
  const source = text(value)
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function emptyOpen() {
  return { tools: {}, jobs: {}, approvals: {} }
}

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------
//
// TaskMapState（投影内部状态，apply 里增量维护）：
// {
//   schema: 'task-map/state', stateVersion, sessionId, sessionCreatedAt, cwd,
//   title, titles[], agentPreset, asOfSeq, asOfTime, firstEventTime,
//   hasTeamBoard, endedSeed, goal,
//   tasks: { id: TaskNode }, taskOrder: [],
//   relations: [TaskRelation], baseline, baselineOpen,
//   turns: [{turn,start,end,reason}],
//   members: { id: Member }, memberOrder: [],
//   subagents: [], milestones: [], commands: [],
//   usage: {input,output,cacheRead,cacheWrite,total},
//   counters: {toolCalls,jobs,approvals,subagents,todoWrites,teammates,
//              waitAgents,askUsers,steps,stepEnds,goalChanges,commands,deliverables},
//   spans: [Span], open: {tools:{},jobs:{},approvals:{}}
// }
//
// TaskNode（内部）：
// { id, kind:'team'|'todo', subject, description, status, ownerId,
//   blockedBy[], writeScopes[], revision, createdAt, updatedAt,
//   startedAt|null, completedAt|null, failedAt|null, phases:[{status,at}] }
//
// Span（内部，视图里再截断）：
// { id, kind:'tool'|'job'|'approval', name, label, start, end|null,
//   status:'running'|'ok'|'error'|'killed', callId, turn, step,
//   error?, jobStatus?, outcome? }

/**
 * 空状态。header 可以是真实会话头（{id,createdAt,cwd,...}），
 * 也可以是空对象/null（测试/降级场景）。
 */
export function emptyState(header) {
  const source = header && typeof header === 'object' ? header : {}
  const sessionId = text(source.id ?? source.sessionId ?? source.session?.id)
  const createdAt = finiteNumber(source.createdAt ?? source.sessionCreatedAt)
  return {
    schema: 'task-map/state',
    stateVersion: STATE_VERSION,
    sessionId,
    sessionCreatedAt: createdAt || 0,
    cwd: text(source.cwd),
    title: text(source.title),
    titles: [],
    agentPreset: text(source.agentPreset),
    asOfSeq: -1,
    asOfTime: 0,
    // 最后一条「有内容」的事件时刻（排除 session/end-seed 收尾尾巴，用于回放范围/墙钟）。
    contentEnd: 0,
    firstEventTime: 0,
    hasTeamBoard: false,
    plan: null,
    endedSeed: null,
    goal: null,
    tasks: {},
    taskOrder: [],
    relations: [],
    // 计划/执行变更流（新增/移除/依赖变更/拆分），按发生顺序追加，供回放与变更记录。
    changeLog: [],
    baseline: null,
    baselineOpen: false,
    turns: [],
    members: {},
    memberOrder: [],
    subagents: [],
    milestones: [],
    commands: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    // 等待类指标独立累加（span 被 MAX_SPANS 截断也不会少算）。
    waitsAcc: { waitAgentMs: 0, askUserMs: 0, approvalMs: 0 },
    // 打开中的等待起点（即使对应 span 被 MAX_SPANS 淘汰，关闭时仍能精确累加）。
    pendingWaits: {},
    pendingApprovals: {},
    counters: {
      toolCalls: 0,
      jobs: 0,
      approvals: 0,
      subagents: 0,
      todoWrites: 0,
      teammates: 0,
      waitAgents: 0,
      askUsers: 0,
      steps: 0,
      stepEnds: 0,
      goalChanges: 0,
      commands: 0,
      deliverables: 0,
    },
    spans: [],
    open: emptyOpen(),
  }
}

// ---------------------------------------------------------------------------
// 折叠入口
// ---------------------------------------------------------------------------

/**
 * 单事件折叠。无关/未知事件返回 state 本身（Object.is 相等），
 * 供宿主投影跳过无意义推送。
 */
export function foldEvent(state, event) {
  if (!state || typeof state !== 'object') return state
  if (!event || typeof event !== 'object') return state
  const type = event.type
  if (!HANDLED_TYPES.has(type)) return state

  let next
  switch (type) {
    case 'session':
      next = foldSessionHeader(state, event)
      break
    case 'team/task':
      next = foldTeamTask(state, event)
      break
    case 'team/member':
      next = foldTeamMember(state, event)
      break
    case 'todo/write':
      next = foldTodoWrite(state, event)
      break
    case 'turn/start':
      next = foldTurnStart(state, event)
      break
    case 'turn/end':
      next = foldTurnEnd(state, event)
      break
    case 'step/start':
      next = bumpCounters(state, ['steps'], event)
      break
    case 'step/end':
      next = bumpCounters(state, ['stepEnds'], event)
      break
    case 'tool/call':
      next = foldToolCall(state, event)
      break
    case 'tool/result':
      next = foldToolResult(state, event)
      break
    case 'job/registered':
      next = foldJobRegistered(state, event)
      break
    case 'job/settled':
      next = foldJobSettled(state, event)
      break
    case 'approval/asked':
      next = foldApprovalAsked(state, event)
      break
    case 'approval/decided':
      next = foldApprovalDecided(state, event)
      break
    case 'subagent/catalog':
      next = foldSubagentCatalog(state, event)
      break
    case 'subagent/descriptor':
      next = foldSubagentDescriptor(state, event)
      break
    case 'assistant/message':
      next = foldAssistantUsage(state, event)
      break
    case 'session/title':
      next = foldSessionTitle(state, event)
      break
    case 'deliverables/presented':
      next = foldDeliverables(state, event)
      break
    case 'command/run':
      next = foldCommandRun(state, event)
      break
    case 'command/done':
      next = foldCommandDone(state, event)
      break
    case 'session/end-seed':
      next = foldEndSeed(state, event)
      break
    case 'goal/change':
      next = foldGoalChange(state, event)
      break
    default:
      return state
  }
  if (next === state) return state
  // 统一收尾：推进水位；计划基线在「开始执行」时封板（首个非 pending 快照 / 回合结束）。
  const time = eventTime(event)
  const seq = eventSeq(event)
  const closingBaseline = next.baselineOpen === true && closesBaseline(type, event)
  const asOfSeq = seq >= 0 ? seq : next.asOfSeq
  const asOfTime = time !== null && time > 0 ? time : next.asOfTime
  if (!closingBaseline && asOfSeq === next.asOfSeq && asOfTime === next.asOfTime) return next
  const baseline = closingBaseline && next.baseline
    ? { ...next.baseline, closedAt: asOfTime, blockedBy: snapshotBaselineBlockedBy(next) }
    : next.baseline
  // session/end-seed 只是日志收尾标记（App 关闭/重开会话时追加），不是内容活动；
  // 回放范围与墙钟用 contentEnd，避免历史会话被「空转尾巴」拉长。
  const contentEnd = type === 'session/end-seed' ? next.contentEnd : asOfTime
  return {
    ...next,
    asOfSeq,
    asOfTime,
    contentEnd,
    firstEventTime: next.firstEventTime || asOfTime,
    baseline,
    baselineOpen: closingBaseline ? false : next.baselineOpen,
  }
}

/** 计划基线封板时机：任务开始执行（首个非 pending 快照）或回合结束。 */
function closesBaseline(type, event) {
  if (type === 'turn/end') return true
  if (type === 'session/end-seed') return true
  if (type === 'team/task') {
    const status = event?.data?.task?.status
    return status === 'in_progress' || status === 'completed' || status === 'failed'
  }
  return false
}

/**
 * 批量折叠。`header` 可为会话头，`events` 为事件数组；
 * 若事件数组首行是 `{type:'session'}` 头行，则以该行作为会话头。
 */
export function foldEvents(header, events) {
  const list = Array.isArray(events) ? events : []
  let state = emptyState(header)
  for (const event of list) {
    if (event && event.type === 'session') {
      state = emptyState({ ...stateToHeader(state), ...event })
      continue
    }
    state = foldEvent(state, event)
  }
  return state
}

function stateToHeader(state) {
  return {
    id: state.sessionId,
    createdAt: state.sessionCreatedAt,
    cwd: state.cwd,
    title: state.title,
    agentPreset: state.agentPreset,
  }
}

// ---------------------------------------------------------------------------
// 折叠：会话头 / 标题 / 目标 / 关键事件
// ---------------------------------------------------------------------------

function foldSessionHeader(state, event) {
  const source = event.data && typeof event.data === 'object' ? event.data : event
  const sessionId = text(source.id ?? source.sessionId) || state.sessionId
  const createdAt = finiteNumber(source.createdAt) || state.sessionCreatedAt
  const cwd = text(source.cwd) || state.cwd
  const agentPreset = text(source.agentPreset) || state.agentPreset
  if (
    sessionId === state.sessionId &&
    createdAt === state.sessionCreatedAt &&
    cwd === state.cwd &&
    agentPreset === state.agentPreset
  ) {
    return state
  }
  return { ...state, sessionId, sessionCreatedAt: createdAt, cwd, agentPreset }
}

function foldSessionTitle(state, event) {
  const title = truncate(event.data?.title, LIMIT_SUBJECT_STATE)
  if (!title) return state
  const time = eventTime(event) || 0
  const titles = state.titles.concat([{ title, at: time }]).slice(-LIMIT_TITLES)
  return { ...state, title, titles }
}

function foldGoalChange(state, event) {
  const data = event.data ?? {}
  const goal = {
    id: text(data.goal?.id),
    phase: text(data.goal?.phase),
    objective: truncate(data.goal?.objective, LIMIT_DESCRIPTION_VIEW),
    operation: text(data.operation),
    at: eventTime(event) || 0,
  }
  return {
    ...state,
    goal,
    counters: { ...state.counters, goalChanges: state.counters.goalChanges + 1 },
  }
}

function foldEndSeed(state, event) {
  return {
    ...state,
    endedSeed: { inherited: event.data?.inherited === true, at: eventTime(event) || 0 },
  }
}

function foldDeliverables(state, event) {
  const data = event.data ?? {}
  const files = Array.isArray(data.files)
    ? data.files.slice(0, 20).map((file) => ({
        path: text(file?.path),
        description: truncate(file?.description, LIMIT_LABEL_VIEW),
      }))
    : []
  const milestones = state.milestones
    .concat([
      {
        kind: 'deliverable',
        at: eventTime(event) || 0,
        turn: finiteNumber(data.turn),
        callId: text(data.callId),
        files,
      },
    ])
    .slice(-LIMIT_MILESTONES)
  return {
    ...state,
    milestones,
    counters: { ...state.counters, deliverables: state.counters.deliverables + 1 },
  }
}

function foldCommandRun(state, event) {
  const data = event.data ?? {}
  const commands = state.commands
    .concat([
      {
        id: text(data.commandId),
        name: text(data.name),
        at: eventTime(event) || 0,
        done: null,
      },
    ])
    .slice(-LIMIT_COMMANDS)
  return {
    ...state,
    commands,
    counters: { ...state.counters, commands: state.counters.commands + 1 },
  }
}

function foldCommandDone(state, event) {
  const data = event.data ?? {}
  const commands = state.commands.slice()
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    if (commands[index].done === null && !text(data.commandId)) {
      commands[index] = {
        ...commands[index],
        done: { kind: text(data.kind), text: truncate(data.text, LIMIT_LABEL_VIEW), at: eventTime(event) || 0 },
      }
      return { ...state, commands }
    }
    if (text(data.commandId) && commands[index].id === text(data.commandId)) {
      commands[index] = {
        ...commands[index],
        done: { kind: text(data.kind), text: truncate(data.text, LIMIT_LABEL_VIEW), at: eventTime(event) || 0 },
      }
      return { ...state, commands }
    }
  }
  return state
}

// ---------------------------------------------------------------------------
// 折叠：团队任务板 / 成员
// ---------------------------------------------------------------------------

function foldTeamTask(state, event) {
  const data = event.data ?? {}
  const snapshot = data.task
  if (!snapshot || typeof snapshot !== 'object') return state
  const id = text(snapshot.id)
  if (!id) return state
  const time = eventTime(event) || 0
  const status = taskStatus(snapshot.status)
  const blockedBy = Array.isArray(snapshot.blockedBy) ? stringArray(snapshot.blockedBy, 200) : null
  const writeScopes = Array.isArray(snapshot.writeScopes)
    ? stringArray(snapshot.writeScopes, LIMIT_WRITE_SCOPES_STATE)
    : null
  const ownerId = typeof snapshot.ownerId === 'string' && snapshot.ownerId.length > 0 ? snapshot.ownerId : null
  const revision = finiteNumber(snapshot.revision)

  const previous = state.tasks[id]
  if (!previous) {
    const node = {
      id,
      kind: 'team',
      subject: truncate(snapshot.subject, LIMIT_SUBJECT_STATE),
      description: truncate(snapshot.description, LIMIT_DESCRIPTION_STATE),
      status,
      ownerId,
      blockedBy: blockedBy ?? [],
      writeScopes: writeScopes ?? [],
      revision: revision ?? 1,
      createdSeq: eventSeq(event),
      createdAt: time,
      updatedAt: time,
      startedAt: status === 'in_progress' ? time : null,
      completedAt: status === 'completed' ? time : null,
      failedAt: status === 'failed' ? time : null,
      phases: [{ status, at: time }],
      dependencyChanges: [],
      blockedByChangedAt: null,
    }
    const firstTeamTask = state.hasTeamBoard !== true
    let tasks = { ...state.tasks, [id]: node }
    let taskOrder = state.taskOrder
    let baseline = state.baseline
    let baselineOpen = state.baselineOpen
    if (firstTeamTask) {
      // 团队任务板出现：清掉 todo 降级任务（两者不并排展示，避免重复）。
      // 语义：todo 阶段只作为降级来源；切换到 team 板时基线重置为 team 任务集合、
      // 变更流清空（todo 阶段的增删变更不再属于当前计划），避免两套任务语义混用。
      tasks = {}
      for (const existingId of state.taskOrder) {
        const existing = state.tasks[existingId]
        if (existing && existing.kind === 'team') tasks[existingId] = existing
      }
      tasks[id] = node
      taskOrder = Object.keys(tasks)
      // 首个任务快照开启「计划基线」：同一刷写批次的后续任务会并入基线，
      // 遇到非 team/task 事件时封板（见 foldEvent 收尾逻辑）。
      baseline = {
        taskIds: [id],
        at: time,
        seq: eventSeq(event),
        source: 'first-task',
        closedAt: null,
        blockedBy: { [id]: (blockedBy ?? []).slice() },
      }
      baselineOpen = true
    } else {
      taskOrder = state.taskOrder.concat([id])
      // 规划阶段（基线未封板）内创建的任务都属于计划基线。
      if (baselineOpen && baseline && !baseline.taskIds.includes(id)) {
        baseline = {
          ...baseline,
          taskIds: baseline.taskIds.concat([id]),
          blockedBy: { ...(baseline.blockedBy ?? {}), [id]: (blockedBy ?? []).slice() },
        }
      }
    }
    const outsideBaseline = !firstTeamTask && baseline && !baseline.taskIds.includes(id)
    const changeLog = outsideBaseline
      ? appendChange(state.changeLog, { at: time, seq: eventSeq(event), kind: 'added', taskId: id })
      : firstTeamTask
        ? []
        : state.changeLog
    return { ...state, tasks, taskOrder, baseline, baselineOpen, hasTeamBoard: true, changeLog }
  }

  const changedStatus = previous.status !== status
  const phases = changedStatus ? previous.phases.concat([{ status, at: time }]) : previous.phases
  const previousBlockedBy = previous.blockedBy ?? []
  const nextBlockedBy = blockedBy ?? previousBlockedBy
  const blockedByChanged = !sameStringOrder(previousBlockedBy, nextBlockedBy)
  // 计划阶段尾随依赖补写（基线段内、任务尚未开始）并入基线，不算变更。
  if (
    blockedByChanged &&
    state.baseline &&
    state.baselineOpen !== true &&
    previous.startedAt === null &&
    typeof state.baseline.closedAt === 'number' &&
    time - state.baseline.closedAt <= BASELINE_GRACE_MS &&
    (state.baseline.taskIds ?? []).includes(id)
  ) {
    const baseline = {
      ...state.baseline,
      blockedBy: { ...(state.baseline.blockedBy ?? {}), [id]: nextBlockedBy.slice() },
    }
    return { ...state, tasks: { ...state.tasks, [id]: { ...previous, blockedBy: nextBlockedBy, updatedAt: time } }, baseline }
  }
  const dependencyChanges = blockedByChanged
    ? previous.dependencyChanges.concat([{ at: time, seq: eventSeq(event), from: previousBlockedBy.slice(), to: nextBlockedBy.slice() }]).slice(-LIMIT_DEPENDENCY_HISTORY)
    : previous.dependencyChanges
  const changeLog = blockedByChanged
    ? appendChange(state.changeLog, { at: time, seq: eventSeq(event), kind: 'dependency', taskId: id, from: previousBlockedBy.slice(), to: nextBlockedBy.slice() })
    : state.changeLog
  const node = {
    ...previous,
    subject: snapshot.subject !== undefined ? truncate(snapshot.subject, LIMIT_SUBJECT_STATE) : previous.subject,
    description:
      snapshot.description !== undefined
        ? truncate(snapshot.description, LIMIT_DESCRIPTION_STATE)
        : previous.description,
    status,
    ownerId: ownerId ?? previous.ownerId,
    blockedBy: blockedBy ?? previous.blockedBy,
    writeScopes: writeScopes ?? previous.writeScopes,
    revision: revision ?? previous.revision,
    updatedAt: time,
    startedAt: previous.startedAt ?? (status === 'in_progress' ? time : null),
    completedAt: previous.completedAt ?? (status === 'completed' ? time : null),
    failedAt: previous.failedAt ?? (status === 'failed' ? time : null),
    phases,
    dependencyChanges,
    blockedByChangedAt: blockedByChanged ? time : previous.blockedByChangedAt,
  }
  return { ...state, tasks: { ...state.tasks, [id]: node }, changeLog }
}

function foldTeamMember(state, event) {
  const data = event.data ?? {}
  const member = data.member
  if (!member || typeof member !== 'object') return state
  const id = text(member.id)
  if (!id) return state
  const time = eventTime(event) || 0
  const phase = text(member.phase)
  const previous = state.members[id]
  if (!previous) {
    const node = {
      id,
      name: truncate(member.name, LIMIT_SUBJECT_STATE) || id,
      description: truncate(member.description, LIMIT_LABEL_VIEW),
      phase,
      provider: text(member.provider),
      context: text(member.context),
      createdAt: time,
      updatedAt: time,
      phases: phase ? [{ phase, at: time }] : [],
    }
    return {
      ...state,
      members: { ...state.members, [id]: node },
      memberOrder: state.memberOrder.concat([id]),
    }
  }
  const changedPhase = phase && phase !== previous.phase
  const node = {
    ...previous,
    name: truncate(member.name, LIMIT_SUBJECT_STATE) || previous.name,
    description:
      member.description !== undefined
        ? truncate(member.description, LIMIT_LABEL_VIEW)
        : previous.description,
    phase: phase || previous.phase,
    updatedAt: time,
    phases: changedPhase ? previous.phases.concat([{ phase, at: time }]) : previous.phases,
  }
  return { ...state, members: { ...state.members, [id]: node } }
}

// ---------------------------------------------------------------------------
// 折叠：todo 降级（仅无团队任务板时）
// ---------------------------------------------------------------------------

function foldTodoWrite(state, event) {
  const data = event.data ?? {}
  const time = eventTime(event) || 0
  const todos = Array.isArray(data.todos) ? data.todos : []
  const counters = { ...state.counters, todoWrites: state.counters.todoWrites + 1 }

  // 会话计划（todo）：无论是否已有团队任务板都折叠保存，供「会话计划」区块展示；
  // 团队任务板存在时 todo 不再生成降级任务（图/甘特仍以团队任务为主）。
  const previousPlan = state.plan && Array.isArray(state.plan.items) ? state.plan : null
  const previousById = new Map()
  if (previousPlan) {
    for (const item of previousPlan.items) previousById.set(item.id, item)
  }
  const planItems = []
  const counts = { completed: 0, inProgress: 0, pending: 0 }
  for (const todo of todos) {
    const content = truncate(todo?.content, LIMIT_SUBJECT_STATE)
    if (!content) continue
    const status = todoStatus(todo?.status)
    const id = `todo:${stableHash(content)}`
    const previous = previousById.get(id)
    const same = previous && previous.content === content && previous.status === status
    const updatedAt = same ? previous.updatedAt : time
    const item = {
      id,
      index: planItems.length + 1,
      content,
      status,
      updatedAt,
      ...(same ? { createdAt: previous.createdAt } : { createdAt: time }),
    }
    planItems.push(item)
    if (status === 'completed') counts.completed += 1
    else if (status === 'in_progress') counts.inProgress += 1
    else counts.pending += 1
  }
  const plan = {
    items: planItems,
    counts,
    updatedAt: time,
    writeCount: (previousPlan ? previousPlan.writeCount : 0) + 1,
    createdAt: previousPlan ? previousPlan.createdAt : time,
  }

  // 团队任务板优先：todo 只保留计划快照，不生成降级任务（避免两套任务并排）。
  if (state.hasTeamBoard) return { ...state, counters, plan }

  // 无团队任务板：todo 作为降级任务来源，同时保留计划快照。
  const nextTasks = {}
  const nextOrder = []
  for (const todo of todos) {
    const content = truncate(todo?.content, LIMIT_SUBJECT_STATE)
    if (!content) continue
    const id = `todo:${stableHash(content)}`
    const status = todoStatus(todo?.status)
    const previous = state.tasks[id]
    if (!previous) {
      nextTasks[id] = {
        id,
        kind: 'todo',
        subject: content,
        description: '',
        status,
        ownerId: null,
        blockedBy: [],
        writeScopes: [],
        revision: 1,
        createdAt: time,
        updatedAt: time,
        startedAt: status === 'in_progress' ? time : null,
        completedAt: status === 'completed' ? time : null,
        failedAt: null,
        phases: [{ status, at: time }],
        createdSeq: eventSeq(event),
        dependencyChanges: [],
        blockedByChangedAt: null,
      }
    } else {
      const changedStatus = previous.status !== status
      nextTasks[id] = {
        ...previous,
        status,
        updatedAt: time,
        startedAt: previous.startedAt ?? (status === 'in_progress' ? time : null),
        completedAt: previous.completedAt ?? (status === 'completed' ? time : null),
        phases: changedStatus ? previous.phases.concat([{ status, at: time }]) : previous.phases,
      }
    }
    nextOrder.push(id)
  }
  // todo 降级模式也维护计划基线（首次清单快照）与增删变更流。
  const previousOrder = state.taskOrder ?? []
  let changeLog = state.changeLog
  for (const removedId of previousOrder) {
    if (!nextOrder.includes(removedId)) {
      changeLog = appendChange(changeLog, { at: time, seq: eventSeq(event), kind: 'removed', taskId: removedId })
    }
  }
  let baseline = state.baseline
  let baselineOpen = state.baselineOpen
  if (!baseline && nextOrder.length > 0) {
    baseline = { taskIds: nextOrder.slice(), at: time, seq: eventSeq(event), source: 'first-task', closedAt: time, blockedBy: {} }
    baselineOpen = false
  } else if (baseline) {
    for (const addedId of nextOrder) {
      if (!previousOrder.includes(addedId) && !baseline.taskIds.includes(addedId)) {
        changeLog = appendChange(changeLog, { at: time, seq: eventSeq(event), kind: 'added', taskId: addedId })
      }
    }
  }
  return { ...state, counters, plan, tasks: nextTasks, taskOrder: nextOrder, hasTeamBoard: false, baseline, baselineOpen, changeLog }
}

function foldTurnStart(state, event) {
  const turn = finiteNumber(event.data?.turn)
  if (turn === null) return state
  if (state.turns.some((item) => item.turn === turn)) return state
  return { ...state, turns: state.turns.concat([{ turn, start: eventTime(event) || 0, end: null, reason: '' }]) }
}

function foldTurnEnd(state, event) {
  const data = event.data ?? {}
  const turn = finiteNumber(data.turn)
  if (turn === null) return state
  const reason = text(data.reason?.kind)
  let changed = false
  const turns = state.turns.map((item) => {
    if (item.turn !== turn || item.end !== null) return item
    changed = true
    return { ...item, end: eventTime(event) || 0, reason }
  })
  if (!changed) return state
  return { ...state, turns }
}

// ---------------------------------------------------------------------------
// 折叠：工具 / 后台任务 / 审批（span）
// ---------------------------------------------------------------------------

function bumpCounters(state, keys, event) {
  const counters = { ...state.counters }
  for (const key of keys) counters[key] = (counters[key] ?? 0) + 1
  return { ...state, counters }
}

/** 追加 span；超过上限时丢弃最旧条目（open 标记悬挂无碍，关闭时会清理）。 */
function appendSpan(state, span) {
  let spans = state.spans.concat([span])
  let open = state.open
  if (spans.length > MAX_SPANS) {
    spans = spans.slice(spans.length - MAX_SPANS)
    open = emptyOpen()
    for (const item of spans) {
      if (item.end !== null) continue
      if (item.kind === 'tool') open.tools[item.callId] = true
      else if (item.kind === 'job') open.jobs[item.jobId] = true
      else if (item.kind === 'approval') open.approvals[item.approvalId] = true
    }
  }
  return { spans, open }
}

function markOpen(open, kind, key) {
  const current = open[kind]
  if (current[key] === true) return open
  return { ...open, [kind]: { ...current, [key]: true } }
}

function markClosed(open, kind, key) {
  const current = open[kind]
  if (!(key in current)) return open
  const next = { ...current }
  delete next[key]
  return { ...open, [kind]: next }
}

/** 追加一条变更记录（带容量上限）。 */
function appendChange(log, entry) {
  const next = (log ?? []).concat([entry])
  return next.length > LIMIT_CHANGELOG_STATE ? next.slice(next.length - LIMIT_CHANGELOG_STATE) : next
}

function sameStringOrder(left, right) {
  const a = Array.isArray(left) ? left : []
  const b = Array.isArray(right) ? right : []
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

/** 计划基线封板时快照每个计划任务的 blockedBy（用于依赖变更 diff）。 */
function snapshotBaselineBlockedBy(state) {
  const snapshot = {}
  const baseline = state && state.baseline
  if (!baseline || !Array.isArray(baseline.taskIds) || !state.tasks) return snapshot
  for (const id of baseline.taskIds) {
    const task = state.tasks[id]
    snapshot[id] = task && Array.isArray(task.blockedBy) ? task.blockedBy.slice() : []
  }
  return snapshot
}

/** 浅拷贝对象并删除一个键。 */
function omitKey(source, key) {
  if (!source || !(key in source)) return source
  const next = { ...source }
  delete next[key]
  return next
}

/** 等待类 span 关闭时累加（独立于 spans 上限，避免超长会话少算）。 */
function accumulateWaits(accumulator, toolName, durationMs) {
  const base = accumulator && typeof accumulator === 'object' ? accumulator : { waitAgentMs: 0, askUserMs: 0, approvalMs: 0 }
  const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 0
  if (toolName === 'wait_agent') return { ...base, waitAgentMs: base.waitAgentMs + duration }
  if (toolName === 'ask_user_question') return { ...base, askUserMs: base.askUserMs + duration }
  return base
}

const SPECIAL_TOOL_COUNTERS = {
  wait_agent: 'waitAgents',
  ask_user_question: 'askUsers',
  spawn_teammate: 'teammates',
}

function foldToolCall(state, event) {
  const data = event.data ?? {}
  const callId = text(data.callId)
  if (!callId) return state
  const name = text(data.name) || 'tool'
  const time = eventTime(event) || 0
  const span = {
    id: callId,
    kind: 'tool',
    name,
    label: truncate(name, LIMIT_LABEL_VIEW),
    start: time,
    end: null,
    status: 'running',
    callId,
    turn: finiteNumber(data.turn),
    step: finiteNumber(data.step),
    error: null,
  }
  const appended = appendSpan(state, span)
  const counters = { ...state.counters, toolCalls: state.counters.toolCalls + 1 }
  const special = SPECIAL_TOOL_COUNTERS[name]
  if (special) counters[special] = (counters[special] ?? 0) + 1
  const isWaitTool = name === 'wait_agent' || name === 'ask_user_question'
  const pendingWaits = isWaitTool
    ? { ...state.pendingWaits, [callId]: { name, start: time } }
    : state.pendingWaits

  let relations = state.relations
  let changeLog = state.changeLog
  if (name === 'task_map_record_relation') {
    const relation = parseRelationCall(data.arguments, time, eventSeq(event))
    if (relation) {
      const nextRelations = addRelation(state.relations, relation)
      if (nextRelations !== relations) {
        // 关系是「拆分/支线」的唯一来源；只记录，不修改任何任务状态。
        changeLog = appendChange(changeLog, {
          at: time,
          seq: eventSeq(event),
          kind: 'split',
          taskId: relation.parent,
          children: relation.children.slice(),
          relationKind: relation.kind,
        })
        relations = nextRelations
      }
    }
  }
  return {
    ...state,
    spans: appended.spans,
    open: markOpen(appended.open, 'tools', callId),
    counters,
    relations,
    pendingWaits,
    changeLog,
  }
}

/** 解析关系记录工具的 arguments（JSON 串），非法参数返回 null。 */
function parseRelationCall(rawArguments, time, seq) {
  if (typeof rawArguments !== 'string' || rawArguments.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return null
  }
  const parent = text(parsed?.parent_task)
  const children = stringArray(parsed?.children, 50)
  if (!parent || children.length === 0) return null
  const kind = parsed?.kind === 'split' ? 'split' : 'subtask'
  return {
    parent,
    children,
    kind,
    note: truncate(parsed?.note, LIMIT_LABEL_VIEW),
    recordedAt: time,
    seq,
    source: 'tool',
  }
}

/** 关系追加（按 parent+children+kind 幂等去重）。 */
function addRelation(relations, relation) {
  const key = `${relation.parent}|${relation.children.join(',')}|${relation.kind}`
  for (const existing of relations) {
    const existingKey = `${existing.parent}|${existing.children.join(',')}|${existing.kind}`
    if (existingKey === key) return relations
  }
  return relations.concat([relation])
}

function foldToolResult(state, event) {
  const data = event.data ?? {}
  const callId = text(data.message?.toolCallId ?? data.message?.source?.callId ?? data.callId)
  if (!callId) return state
  const time = eventTime(event) || 0
  const isError = data.error !== undefined && data.error !== null ? true : data.message?.isError === true
  const spans = state.spans
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    if (span.kind !== 'tool' || span.callId !== callId || span.end !== null) continue
    const next = spans.slice()
    next[index] = {
      ...span,
      end: time,
      status: isError ? 'error' : 'ok',
      error: isError ? text(data.error?.code ?? data.error?.name) || 'error' : null,
    }
    const pendingWaits = state.pendingWaits && state.pendingWaits[callId]
      ? omitKey(state.pendingWaits, callId)
      : state.pendingWaits
    return {
      ...state,
      spans: next,
      open: markClosed(state.open, 'tools', callId),
      waitsAcc: accumulateWaits(state.waitsAcc, span.name, time - span.start),
      pendingWaits,
    }
  }
  // span 已被 MAX_SPANS 淘汰，但打开时记录了等待起点 → 仍精确累加（P2 边缘修复）。
  const pending = state.pendingWaits ? state.pendingWaits[callId] : undefined
  if (pending) {
    return {
      ...state,
      waitsAcc: accumulateWaits(state.waitsAcc, pending.name, time - pending.start),
      pendingWaits: omitKey(state.pendingWaits, callId),
      open: markClosed(state.open, 'tools', callId),
    }
  }
  return state
}

function foldJobRegistered(state, event) {
  const data = event.data ?? {}
  const jobId = text(data.jobId)
  if (!jobId) return state
  const startedAt = finiteNumber(data.startedAt)
  const span = {
    id: jobId,
    kind: 'job',
    jobId,
    name: text(data.kind) || 'job',
    label: truncate(data.kind, LIMIT_LABEL_VIEW) || 'job',
    start: startedAt ?? eventTime(event) ?? 0,
    end: null,
    status: 'running',
    callId: text(data.toolCall?.callId),
    turn: null,
    step: null,
    error: null,
  }
  const appended = appendSpan(state, span)
  return {
    ...state,
    spans: appended.spans,
    open: markOpen(appended.open, 'jobs', jobId),
    counters: { ...state.counters, jobs: state.counters.jobs + 1 },
  }
}

function foldJobSettled(state, event) {
  const data = event.data ?? {}
  const jobId = text(data.jobId)
  if (!jobId) return state
  const time = eventTime(event) || 0
  const spans = state.spans
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    if (span.kind !== 'job' || span.jobId !== jobId || span.end !== null) continue
    const rawStatus = text(data.status)
    const status = rawStatus === 'completed' ? 'ok' : rawStatus === 'killed' ? 'killed' : 'error'
    const next = spans.slice()
    next[index] = {
      ...span,
      end: finiteNumber(data.finishedAt) ?? time,
      status,
      jobStatus: rawStatus,
      error: status === 'error' ? rawStatus || 'error' : null,
    }
    return { ...state, spans: next, open: markClosed(state.open, 'jobs', jobId) }
  }
  return state
}

function foldApprovalAsked(state, event) {
  const data = event.data ?? {}
  const approvalId = text(data.id)
  if (!approvalId) return state
  const span = {
    id: `approval:${approvalId}`,
    kind: 'approval',
    approvalId,
    name: text(data.toolName) || 'approval',
    label: truncate(data.toolName, LIMIT_LABEL_VIEW) || 'approval',
    start: eventTime(event) || 0,
    end: null,
    status: 'running',
    callId: text(data.callId),
    turn: null,
    step: null,
    error: null,
  }
  const appended = appendSpan(state, span)
  return {
    ...state,
    spans: appended.spans,
    open: markOpen(appended.open, 'approvals', approvalId),
    counters: { ...state.counters, approvals: state.counters.approvals + 1 },
    pendingApprovals: { ...state.pendingApprovals, [approvalId]: span.start },
  }
}

function foldApprovalDecided(state, event) {
  const data = event.data ?? {}
  const approvalId = text(data.id)
  if (!approvalId) return state
  const spans = state.spans
  for (let index = spans.length - 1; index >= 0; index -= 1) {
    const span = spans[index]
    if (span.kind !== 'approval' || span.approvalId !== approvalId || span.end !== null) continue
    const outcome = text(data.outcome)
    const denied = /denied|rejected|deny/i.test(outcome)
    const end = eventTime(event) || 0
    const next = spans.slice()
    next[index] = {
      ...span,
      end,
      status: denied ? 'error' : 'ok',
      outcome,
    }
    const waitsAcc = state.waitsAcc && typeof state.waitsAcc.approvalMs === 'number'
      ? { ...state.waitsAcc, approvalMs: state.waitsAcc.approvalMs + (end - span.start) }
      : state.waitsAcc
    const pendingApprovals = state.pendingApprovals && state.pendingApprovals[approvalId] !== undefined
      ? omitKey(state.pendingApprovals, approvalId)
      : state.pendingApprovals
    return { ...state, spans: next, open: markClosed(state.open, 'approvals', approvalId), waitsAcc, pendingApprovals }
  }
  const pendingStart = state.pendingApprovals ? state.pendingApprovals[approvalId] : undefined
  if (pendingStart !== undefined) {
    const end = eventTime(event) || 0
    const waitsAcc = state.waitsAcc && typeof state.waitsAcc.approvalMs === 'number'
      ? { ...state.waitsAcc, approvalMs: state.waitsAcc.approvalMs + (end - pendingStart) }
      : state.waitsAcc
    return { ...state, waitsAcc, pendingApprovals: omitKey(state.pendingApprovals, approvalId), open: markClosed(state.open, 'approvals', approvalId) }
  }
  return state
}

// ---------------------------------------------------------------------------
// 折叠：子代理 / token
// ---------------------------------------------------------------------------

function foldSubagentCatalog(state, event) {
  const data = event.data ?? {}
  const childId = text(data.childId)
  if (!childId) return state
  const time = eventTime(event) || 0
  const entry = {
    childId,
    label: truncate(data.label, LIMIT_LABEL_VIEW),
    mode: text(data.mode),
    createdAt: finiteNumber(data.childCreatedAt) ?? time,
    at: time,
  }
  const subagents = state.subagents.slice()
  const index = subagents.findIndex((item) => item.childId === childId)
  if (index >= 0) subagents[index] = { ...subagents[index], ...entry }
  else subagents.push(entry)
  return {
    ...state,
    subagents,
    counters: { ...state.counters, subagents: state.counters.subagents + 1 },
  }
}

function foldSubagentDescriptor(state, event) {
  const data = event.data ?? {}
  const childId = text(data.childId ?? data.label)
  if (!childId) return state
  const time = eventTime(event) || 0
  const descriptor = {
    mode: text(data.mode),
    provider: text(data.provider),
    label: truncate(data.label, LIMIT_LABEL_VIEW),
    agentModel: text(data.agentModel),
    agentProvider: text(data.agentProvider),
  }
  const subagents = state.subagents.slice()
  const index = subagents.findIndex((item) => item.childId === childId)
  if (index >= 0) {
    subagents[index] = { ...subagents[index], descriptor, at: time }
  } else {
    subagents.push({
      childId,
      label: descriptor.label,
      mode: descriptor.mode,
      createdAt: time,
      at: time,
      descriptor,
    })
  }
  return { ...state, subagents }
}

function foldAssistantUsage(state, event) {
  const usage = event.data?.usage
  if (!usage || typeof usage !== 'object') return state
  const input = finiteNumber(usage.inputTokens) ?? 0
  const output = finiteNumber(usage.outputTokens) ?? 0
  const cacheRead = finiteNumber(usage.cacheReadTokens) ?? 0
  const cacheWrite = finiteNumber(usage.cacheWriteTokens) ?? 0
  const total = finiteNumber(usage.totalTokens)
  const next = {
    input: state.usage.input + input,
    output: state.usage.output + output,
    cacheRead: state.usage.cacheRead + cacheRead,
    cacheWrite: state.usage.cacheWrite + cacheWrite,
    total: state.usage.total + (total === null ? input + output + cacheRead + cacheWrite : total),
  }
  return { ...state, usage: next }
}

// ---------------------------------------------------------------------------
// 客户端视图（wire.view）
// ---------------------------------------------------------------------------

/**
 * 把投影状态重算为客户端视图。只读、纯函数；cost = O(tasks + spans)。
 * 用户可见指标口径见产品方案 §6.2；执行过程归属按时间窗推断（UI 需标注）。
 */
export function buildClientView(state) {
  const source = state && typeof state === 'object' ? state : emptyState(null)
  const members = source.members ?? {}
  const leadId = source.sessionId

  // ---- 任务排序（createdAt, id 码点序）与视图节点 ----
  const order = []
  const viewById = {}
  for (const id of source.taskOrder ?? []) {
    const task = source.tasks?.[id]
    if (task) order.push(task)
  }
  order.sort((left, right) => {
    if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
    return compareText(left.id, right.id)
  })

  const completedAtById = {}
  for (const task of order) {
    if (task.completedAt !== null) completedAtById[task.id] = task.completedAt
  }

  // ---- 排名：开始顺序 / 完成顺序 ----
  const startedTasks = order.filter((task) => task.startedAt !== null)
  const startOrder = startedTasks.slice().sort((left, right) => {
    return (
      left.startedAt - right.startedAt ||
      left.createdAt - right.createdAt ||
      compareText(left.id, right.id)
    )
  })
  const startRankById = {}
  startOrder.forEach((task, index) => {
    startRankById[task.id] = index + 1
  })

  const doneTasks = order.filter((task) => task.completedAt !== null)
  const doneOrder = doneTasks.slice().sort((left, right) => {
    return (
      left.completedAt - right.completedAt ||
      left.createdAt - right.createdAt ||
      compareText(left.id, right.id)
    )
  })
  const doneRankById = {}
  doneOrder.forEach((task, index) => {
    doneRankById[task.id] = index + 1
  })

  // ---- 视图体积 guard（方案 §2.2/§7.3）：按规模选择降级档位 ----
  const totalSpanCount = Array.isArray(source.spans) ? source.spans.length : 0
  const viewLevel = chooseViewLevel(order.length, totalSpanCount)
  const compactMode = viewLevel !== VIEW_LEVELS[0]
  const spansTruncated = totalSpanCount > viewLevel.spans
  const descriptionLimit = viewLevel.description

  // ---- 逐任务指标与负责人映射 ----
  const tasks = []
  for (const task of order) {
    const owner = resolveOwner(task.ownerId, leadId, members)
    const metrics = taskMetrics(task, completedAtById)
    const node = {
      id: task.id,
      kind: task.kind,
      subject: truncate(task.subject, LIMIT_SUBJECT_VIEW),
      description: truncate(task.description, descriptionLimit),
      status: task.status,
      ownerId: task.ownerId ?? null,
      owner: owner.name,
      ownerIsLead: owner.isLead,
      ownerResolved: owner.resolved,
      createdAt: task.createdAt,
      startedAt: task.startedAt ?? null,
      completedAt: task.completedAt ?? null,
      failedAt: task.failedAt ?? null,
      updatedAt: task.updatedAt,
      blockedBy: (task.blockedBy ?? []).slice(),
      writeScopes: (task.writeScopes ?? []).slice(0, LIMIT_WRITE_SCOPES_VIEW),
      phases: (task.phases ?? []).map((phase) => ({ status: phase.status, at: phase.at })),
      revision: task.revision ?? 1,
      execMs: metrics.execMs,
      queueMs: metrics.queueMs,
      readyAt: metrics.readyAt,
      blockedWaitMs: metrics.blockedWaitMs,
      readyDelayMs: metrics.readyDelayMs,
      startRank: startRankById[task.id] ?? null,
      doneRank: doneRankById[task.id] ?? null,
    }
    tasks.push(node)
    viewById[node.id] = node
  }

  // ---- 关系 / 边 ----
  const warnings = []
  const relations = (source.relations ?? []).map((relation) => {
    const parentExists = Boolean(viewById[relation.parent])
    const missing = relation.children.filter((child) => !viewById[child])
    if (!parentExists) warnings.push({ code: 'relation-parent-missing', taskId: relation.parent })
    for (const child of missing) warnings.push({ code: 'relation-child-missing', taskId: child })
    return {
      parent: relation.parent,
      children: relation.children.slice(),
      kind: relation.kind,
      note: relation.note ?? '',
      recordedAt: relation.recordedAt,
      seq: relation.seq,
      valid: parentExists && missing.length === 0,
      source: relation.source ?? 'tool',
    }
  })

  const edges = []
  for (const task of tasks) {
    for (const blocker of task.blockedBy) {
      if (!viewById[blocker]) {
        warnings.push({ code: 'blocker-missing', taskId: task.id, blocker })
        continue
      }
      edges.push({ from: blocker, to: task.id, kind: 'blockedBy' })
    }
  }
  for (let index = 1; index < startOrder.length; index += 1) {
    edges.push({ from: startOrder[index - 1].id, to: startOrder[index].id, kind: 'sequence' })
  }
  for (const relation of relations) {
    for (const child of relation.children) {
      if (viewById[child] && viewById[relation.parent]) {
        edges.push({ from: relation.parent, to: child, kind: 'relation' })
      }
    }
  }

  // ---- 计划基线 vs 实际（M3：新增/移除/依赖变更/拆分 + 变更流）----
  const baseline = source.baseline
    ? {
        taskIds: (source.baseline.taskIds ?? []).slice(),
        at: source.baseline.at ?? 0,
        seq: source.baseline.seq ?? -1,
        source: source.baseline.source ?? 'first-task',
        closedAt: source.baseline.closedAt ?? null,
        open: source.baselineOpen === true,
      }
    : null
  const baselineIds = new Set(baseline?.taskIds ?? [])
  const currentIds = new Set(tasks.map((task) => task.id))
  const addedTasks = tasks.filter((task) => baselineIds.size > 0 && !baselineIds.has(task.id))
  const removedIds = (baseline?.taskIds ?? []).filter((id) => !currentIds.has(id))
  // 变更流只展示「基线封板之后」发生的变更：
  //  · 未封板（仍在规划）时 cutoff=Infinity，规划期的依赖/关系变化属于基线本身，不算变更；
  //  · 同毫秒边界：新增任务允许 at >= cutoff（封板同一毫秒插入也可见），其余类型要求严格 >。
  const changeCutoff = baseline
    ? baseline.closedAt === null || baseline.closedAt === undefined
      ? Number.POSITIVE_INFINITY
      : baseline.closedAt
    : 0
  const rawChangeLog = (Array.isArray(source.changeLog) ? source.changeLog : [])
    .filter((entry) => {
      const at = Number(entry.at)
      if (!Number.isFinite(at)) return false
      if (entry.kind === 'added') return at >= changeCutoff
      return at > changeCutoff
    })
    .filter((entry) => Number(entry.at) <= (source.asOfTime > 0 ? source.asOfTime : Number.POSITIVE_INFINITY))
  const asOfLimit = source.asOfTime > 0 ? source.asOfTime : Number.POSITIVE_INFINITY
  const relationInWindow = (relation) => Number(relation.recordedAt) > changeCutoff && Number(relation.recordedAt) <= asOfLimit
  const validSplits = relations
    .filter((relation) => relation.valid === true && relationInWindow(relation))
    .map((relation) => ({
      parent: relation.parent,
      children: relation.children.slice(),
      kind: relation.kind,
      note: relation.note,
      at: relation.recordedAt,
      seq: relation.seq,
      valid: true,
    }))
  // 无效关系仍被记录（可审计），但不计入“计划变更”：单独给出并只影响 warnings。
  const invalidRelations = relations
    .filter((relation) => relation.valid !== true && Number(relation.recordedAt) > changeCutoff && Number(relation.recordedAt) <= asOfLimit)
    .map((relation) => ({
      parent: relation.parent,
      children: relation.children.slice(),
      kind: relation.kind,
      note: relation.note,
      at: relation.recordedAt,
      seq: relation.seq,
      missing: relation.children.filter((child) => !viewById[child]),
    }))
  const validRelationKeys = new Set(validSplits.map((split) => `${split.parent}>${split.children.join(',')}`))
  const filteredChangeLog = rawChangeLog.filter((entry) => {
    if (entry.kind !== 'split') return true
    return validRelationKeys.has(`${entry.taskId}>${(entry.children ?? []).join(',')}`)
  })
  const dependencyById = new Map()
  for (const entry of filteredChangeLog) {
    if (entry.kind === 'dependency') dependencyById.set(entry.taskId, entry)
  }
  const dependencyChanged = [...dependencyById.values()].map((entry) => ({
    id: entry.taskId,
    from: (entry.from ?? []).slice(),
    to: (entry.to ?? []).slice(),
    at: entry.at,
  }))
  const changeText = (entry) => {
    if (entry.kind === 'added') {
      const task = viewById[entry.taskId]
      return `新增任务 ${task ? task.subject : entry.taskId}`
    }
    if (entry.kind === 'removed') return `移除任务 ${entry.taskId}`
    if (entry.kind === 'dependency') return `依赖变更 ${entry.taskId}`
    if (entry.kind === 'split') return `拆分 ${entry.taskId} → ${(entry.children ?? []).join(', ')}`
    return String(entry.kind)
  }
  const changes = {
    // 兼容 M2：added/removed 仍为 task id 数组（NEW 标记用）。
    added: addedTasks.map((task) => task.id),
    removed: removedIds,
    dependencyChanged,
    splits: validSplits,
    invalidRelations,
    counts: (() => {
      // 计数与变更记录同口径（log 条数），保证客户端 chips（按 log 计）与数据一致；
      // log 缺失（降级/旧状态）时回落任务 diff。
      const counted = { added: 0, removed: 0, dependency: 0, split: 0 }
      for (const entry of filteredChangeLog) {
        if (entry.kind === 'added') counted.added += 1
        else if (entry.kind === 'removed') counted.removed += 1
        else if (entry.kind === 'dependency') counted.dependency += 1
        else if (entry.kind === 'split') counted.split += 1
      }
      return {
        planned: baseline ? baseline.taskIds.length : 0,
        added: filteredChangeLog.length > 0 ? counted.added : addedTasks.length,
        removed: filteredChangeLog.length > 0 ? counted.removed : removedIds.length,
        dependencyChanged: filteredChangeLog.length > 0 ? counted.dependency : dependencyChanged.length,
        splits: filteredChangeLog.length > 0 ? counted.split : validSplits.length,
        invalidRelations: invalidRelations.length,
      }
    })(),
    log: filteredChangeLog.slice(-LIMIT_CHANGELOG_VIEW).map((entry) => ({
      at: entry.at,
      seq: entry.seq ?? -1,
      kind: entry.kind,
      taskId: entry.taskId,
      text: changeText(entry),
      ...(entry.kind === 'dependency' ? { from: (entry.from ?? []).slice(), to: (entry.to ?? []).slice() } : {}),
      ...(entry.kind === 'split' ? { children: (entry.children ?? []).slice() } : {}),
    })),
  }

  // ---- 成员 / 子代理 / 回放骨架 ----
  const membersView = (source.memberOrder ?? [])
    .map((id) => members[id])
    .filter(Boolean)
    .map((member) => ({
      id: member.id,
      name: member.name,
      description: member.description,
      phase: member.phase,
      phases: (member.phases ?? []).map((phase) => ({ phase: phase.phase, at: phase.at })),
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
    }))

  const turns = (source.turns ?? []).map((turn) => ({ turn: turn.turn, start: turn.start, end: turn.end ?? null }))

  const sortedSpans = (source.spans ?? [])
    .slice()
    .sort((left, right) => left.start - right.start || compareText(left.id, right.id))
  const visibleSpans = spansTruncated
    ? sortedSpans.slice(Math.max(0, sortedSpans.length - viewLevel.spans))
    : sortedSpans
  const spans = visibleSpans.map((span) => {
    // 视图只带渲染必需字段（回放/甘特）；详情文本走 HTTP（P1），控制投影体积。
    const node = {
      kind: span.kind,
      name: span.name,
      label: truncate(span.label, LIMIT_LABEL_VIEW),
      start: span.start,
      end: span.end ?? null,
      status: span.status,
    }
    if (span.error) node.error = truncate(span.error, LIMIT_LABEL_VIEW)
    if (span.outcome) node.outcome = truncate(span.outcome, LIMIT_LABEL_VIEW)
    return node
  })
  // 聚合摘要：即使 span 被截断，客户端仍能展示各类数量/状态（不虚构明细）。
  const spanSummary = {
    total: sortedSpans.length,
    kept: spans.length,
    omitted: sortedSpans.length - spans.length,
    tool: 0,
    job: 0,
    approval: 0,
    open: 0,
    error: 0,
    killed: 0,
  }
  for (const span of sortedSpans) {
    if (span.kind === 'tool') spanSummary.tool += 1
    else if (span.kind === 'job') spanSummary.job += 1
    else if (span.kind === 'approval') spanSummary.approval += 1
    if (span.end === null) spanSummary.open += 1
    if (span.status === 'error') spanSummary.error += 1
    else if (span.status === 'killed') spanSummary.killed += 1
  }
  // 降级模式下给每个任务补「执行过程 span 数量」（按时间窗重叠计数，仅聚合，不含明细）。
  if (compactMode) {
    const now = source.asOfTime || 0
    for (const node of tasks) {
      const windowStart = node.startedAt ?? node.createdAt
      const windowEnd = node.completedAt ?? now
      let count = 0
      if (windowEnd > windowStart) {
        for (const span of sortedSpans) {
          const spanEnd = span.end ?? now
          if (span.start < windowEnd && spanEnd > windowStart) count += 1
        }
      }
      node.spanCount = count
    }
  }

  // ---- 等待拆解（产品方案 §6.2）----
  const waits = buildWaits(source, tasks, turns, spans)

  // ---- 统计 / 计数 / token ----
  const taskStats = { total: tasks.length, pending: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, other: 0 }
  for (const task of tasks) {
    if (taskStats[task.status] !== undefined) taskStats[task.status] += 1
    else taskStats.other += 1
  }

  const firstTime = source.firstEventTime || 0
  const startCandidate = source.sessionCreatedAt > 0 ? source.sessionCreatedAt : firstTime
  const timeStart = firstTime > 0 ? Math.min(startCandidate || firstTime, firstTime) : startCandidate
  const contentEnd = source.contentEnd > 0 ? source.contentEnd : source.asOfTime

  return {
    schema: 'task-map/view',
    stateVersion: source.stateVersion ?? STATE_VERSION,
    sessionId: source.sessionId,
    title: truncate(source.title, LIMIT_LABEL_VIEW),
    cwd: source.cwd,
    agentPreset: source.agentPreset,
    sessionCreatedAt: source.sessionCreatedAt,
    asOfSeq: source.asOfSeq,
    asOfTime: source.asOfTime,
    // end = 内容活动终点（排除 end-seed 尾巴）；rawEnd = 日志最后事件时刻。
    timeRange: { start: timeStart, end: contentEnd, rawEnd: source.asOfTime },
    hasTeamBoard: source.hasTeamBoard === true,
    // 数据完整度（F9）：team 板 → todo 降级 → 空；空时明确提示，不伪造任务。
    dataSource: source.hasTeamBoard === true ? 'team' : tasks.length > 0 ? 'todo' : 'none',
    emptyReason: tasks.length > 0 ? null : 'no-task-board',
    // v1.1：会话 todo 计划（与团队任务并存；无团队任务时仅作数据保留，客户端不重复展示）。
    plan: (() => {
      const plan = source.plan
      if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return null
      return {
        items: plan.items.map((item) => ({
          id: item.id,
          index: item.index,
          content: truncate(item.content, LIMIT_SUBJECT_VIEW),
          status: item.status,
          updatedAt: item.updatedAt,
        })),
        counts: {
          completed: plan.counts?.completed ?? 0,
          inProgress: plan.counts?.inProgress ?? 0,
          pending: plan.counts?.pending ?? 0,
        },
        updatedAt: plan.updatedAt ?? 0,
        writeCount: plan.writeCount ?? 0,
        source: 'todo',
        active: source.hasTeamBoard === true,
      }
    })(),
    tasks,
    taskStats,
    relations,
    edges,
    baseline,
    changes,
    members: membersView,
    subagents: (source.subagents ?? []).map((item) => ({
      childId: item.childId,
      label: truncate(item.label, LIMIT_LABEL_VIEW),
      mode: item.mode ?? '',
      createdAt: item.createdAt,
      at: item.at,
    })),
    turns,
    spans,
    spansTruncated,
    spanSummary,
    viewLevel: {
      description: viewLevel.description,
      spans: Number.isFinite(viewLevel.spans) ? viewLevel.spans : null,
    },
    usage: { ...source.usage },
    counters: { ...source.counters },
    waits,
    milestones: (source.milestones ?? []).slice(-50).map((item) => ({
      kind: item.kind,
      at: item.at,
      turn: item.turn ?? null,
      callId: item.callId ?? '',
      files: (item.files ?? []).map((file) => ({
        path: file.path,
        description: truncate(file.description, LIMIT_LABEL_VIEW),
      })),
    })),
    goal: source.goal ? { ...source.goal } : null,
    endedSeed: source.endedSeed ? { ...source.endedSeed } : null,
    warnings,
  }
}

/** ownerId → 负责人名字。等于 Lead 会话 id 时表示 Lead 亲自执行（精确数据）。 */
function resolveOwner(ownerId, leadId, members) {
  if (!ownerId) return { name: null, isLead: false, resolved: true }
  if (ownerId === leadId) return { name: 'Lead', isLead: true, resolved: true }
  const member = members[ownerId]
  if (member && member.name) return { name: member.name, isLead: false, resolved: true }
  return { name: ownerId, isLead: false, resolved: false }
}

/** 单任务指标：执行耗时 / 排队 / 依赖阻塞 / 就绪后延迟。 */
function taskMetrics(task, completedAtById) {
  const queueMs = task.startedAt !== null ? task.startedAt - task.createdAt : null
  const execMs = task.completedAt !== null && task.startedAt !== null ? task.completedAt - task.startedAt : null
  let readyAt = null
  let blockedWaitMs = null
  let readyDelayMs = null
  const blockers = task.blockedBy ?? []
  if (blockers.length > 0) {
    let maxCompleted = null
    let allDone = true
    for (const blocker of blockers) {
      const completedAt = completedAtById[blocker]
      if (completedAt === undefined || completedAt === null) {
        allDone = false
        break
      }
      if (maxCompleted === null || completedAt > maxCompleted) maxCompleted = completedAt
    }
    if (allDone && maxCompleted !== null) {
      readyAt = maxCompleted
      blockedWaitMs = readyAt - task.createdAt
      readyDelayMs = task.startedAt !== null ? task.startedAt - readyAt : null
    }
  }
  return { execMs, queueMs, readyAt, blockedWaitMs, readyDelayMs }
}

/** 等待拆解汇总。所有时间单位为毫秒整数；无数据时用 null / 0。 */
function buildWaits(state, tasks, turns, spans) {
  const waits = {
    preTurnMs: null,
    preTurnRestored: false,
    humanIdleMs: 0,
    idleSegments: [],
    queueMs: 0,
    blockedMs: 0,
    readyDelayMs: 0,
    taskExecMs: 0,
    waitAgentMs: 0,
    askUserMs: 0,
    approvalMs: 0,
    wallClockMs: null,
    maxHandoffMs: null,
    handoffs: [],
  }

  if (state.sessionCreatedAt > 0 && turns.length > 0) {
    waits.preTurnMs = turns[0].start - state.sessionCreatedAt
    waits.preTurnRestored = waits.preTurnMs < 0
  }

  for (let index = 1; index < turns.length; index += 1) {
    const previous = turns[index - 1]
    const next = turns[index]
    if (previous.end === null || next.start === null) continue
    const ms = next.start - previous.end
    if (ms <= 0) continue
    waits.idleSegments.push({ afterTurn: previous.turn, start: previous.end, end: next.start, ms })
    waits.humanIdleMs += ms
  }

  for (const task of tasks) {
    if (task.queueMs !== null) waits.queueMs += task.queueMs
    if (task.blockedWaitMs !== null) waits.blockedMs += task.blockedWaitMs
    if (task.readyDelayMs !== null) waits.readyDelayMs += task.readyDelayMs
    if (task.execMs !== null) waits.taskExecMs += task.execMs
  }

  const accumulator = state.waitsAcc
  if (
    accumulator &&
    typeof accumulator.waitAgentMs === 'number' &&
    typeof accumulator.askUserMs === 'number' &&
    typeof accumulator.approvalMs === 'number'
  ) {
    // 正常路径：fold 时独立累加，不受 MAX_SPANS/视图截断影响。
    waits.waitAgentMs = accumulator.waitAgentMs
    waits.askUserMs = accumulator.askUserMs
    waits.approvalMs = accumulator.approvalMs
  } else {
    // 兼容旧缓存状态（无 waitsAcc）：从 spans 求和。
    for (const span of spans) {
      if (span.end === null) continue
      const duration = span.end - span.start
      if (span.kind === 'tool' && span.name === 'wait_agent') waits.waitAgentMs += duration
      else if (span.kind === 'tool' && span.name === 'ask_user_question') waits.askUserMs += duration
      else if (span.kind === 'approval') waits.approvalMs += duration
    }
  }

  const contentEnd = state.contentEnd > 0 ? state.contentEnd : state.asOfTime
  if (state.sessionCreatedAt > 0 && contentEnd > 0) {
    waits.wallClockMs = contentEnd - state.sessionCreatedAt
  }
  // 日志收尾尾巴（end-seed 等无内容事件把 asOfTime 推后的部分），供 UI 提示「已从回放剔除」。
  waits.tailMs = state.asOfTime > contentEnd ? state.asOfTime - contentEnd : 0

  // 任务交接间隔：每个已完成任务 → 其后最早开始的任务。
  const started = tasks
    .filter((task) => task.startedAt !== null)
    .sort(
      (left, right) =>
        left.startedAt - right.startedAt ||
        left.createdAt - right.createdAt ||
        compareText(left.id, right.id),
    )
  const completed = tasks.filter((task) => task.completedAt !== null)
  const handoffs = []
  for (const done of completed) {
    let best = null
    for (const candidate of started) {
      if (candidate.startedAt <= done.completedAt) continue
      if (best === null) {
        best = candidate
        continue
      }
      if (
        candidate.startedAt < best.startedAt ||
        (candidate.startedAt === best.startedAt &&
          (candidate.createdAt < best.createdAt ||
            (candidate.createdAt === best.createdAt && compareText(candidate.id, best.id) < 0)))
      ) {
        best = candidate
      }
    }
    if (best) handoffs.push({ from: done.id, to: best.id, gapMs: best.startedAt - done.completedAt })
  }
  handoffs.sort(
    (left, right) =>
      left.gapMs - right.gapMs || compareText(left.from, right.from) || compareText(left.to, right.to),
  )
  waits.handoffs = handoffs
  waits.maxHandoffMs = handoffs.length > 0 ? handoffs[handoffs.length - 1].gapMs : null
  return waits
}
