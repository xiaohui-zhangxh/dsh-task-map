/**
 * DSH Task Map — host half（M1~M4：真实事件折叠、关系工具校验、投影 v3）。
 *
 * 三条 seam（M0 已验证，继续复用）：
 *   1) session 投影：foldEvent 折叠会话事件 → buildClientView 供 client 读取；
 *   2) Agent 工具：task_map_ping / task_map_record_relation（W4.1 起校验任务 id 是否存在，
 *      只记录展示关系、不调度、不改任务状态）；
 *   3) 插件 HTTP 路由：/task-map/api/health（M5 前必须补同源校验，当前仅非敏感状态）。
 *
 * 投影纪律（见 M0-SPIKE.md §5.2）：apply 同步、无关事件返回同一引用、
 * 形状变化升 stateVersion（当前 4）、wire.view 结果保持 UI 量级。
 */
import { STATE_VERSION, buildClientView, emptyState, foldEvent } from './lib/derive.js'

export const name = '@local/dsh-task-map'
export const inject = []

const ROUTE = '/task-map/api/health'
const KEY = 'taskMap'
const VERSION = '1.2.0'

const status = {
  startedAt: Date.now(),
  projection: false,
  projectionError: null,
  tools: [],
  toolErrors: [],
  route: false,
  routeError: null,
}

// 幂等挂载：DSH 在启用/禁用/热更新时可能对同一模块重复 apply；
// 每次 apply 前先释放上一次的投影/工具/路由注册，避免重复注册（工具列表重复、路由冲突）。
const mountDisposers = []
function resetMounts() {
  const list = mountDisposers.splice(0)
  for (const dispose of list.reverse()) {
    try {
      if (typeof dispose === 'function') dispose()
    } catch (error) {
      log(`mount reset dispose failed: ${errorText(error)}`)
    }
  }
  status.projection = false
  status.route = false
  status.tools = []
}

function log(message) {
  try {
    console.log(`[task-map] ${message}`)
  } catch {
    /* logging must never break activation */
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error)
}

function registerProjection(ctx) {
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    try {
      const registry = projectionCtx.sessionProjections
      const definition = {
        key: KEY,
        stateVersion: STATE_VERSION,
        stateSchema: { parse: (value) => value },
        // init 拿到会话头（{id, createdAt, cwd, ...}）；之后 apply 折叠已提交事件。
        init: (header) => emptyState(header),
        // 投影纪律：无关/未知事件由 foldEvent 返回同一引用，宿主可跳过推送。
        apply: (state, event) => {
          if (state === undefined || state === null) return state
          try {
            return foldEvent(state, event)
          } catch (error) {
            // 折叠失败不得冒泡到宿主：保留上一个稳定状态，并记录一次。
            log(`fold failed: ${errorText(error)}`)
            return state
          }
        },
        wire: {
          viewSchema: { parse: (value) => value },
          view: (state) => buildClientView(state),
        },
      }
      const dispose = registry.register(definition)
      status.projection = true
      log(`projection "${KEY}" registered`)
      const effectDispose = projectionCtx.effect(() => () => {
        status.projection = false
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          log(`projection dispose failed: ${errorText(error)}`)
        }
      })
      mountDisposers.push(effectDispose)
    } catch (error) {
      status.projectionError = errorText(error)
      log(`projection registration failed: ${status.projectionError}`)
    }
  })
}

/**
 * 读取「调用方会话」的任务地图状态，用于关系工具的 id 校验。
 * 只读：通过 sessions + sessionProjections 服务读取，绝不修改任何会话/任务状态。
 */
function taskStateOfSession(ctx, agentId) {
  try {
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return { error: '缺少会话上下文，无法校验任务 id（请在该会话内调用）' }
    }
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined
    const session = sessions && typeof sessions.get === 'function' ? sessions.get(agentId) : undefined
    if (!session) return { error: `会话 ${agentId} 不在当前进程中（历史会话需先打开）` }
    const projections = typeof ctx.get === 'function' ? ctx.get('sessionProjections') : undefined
    if (!projections || typeof projections.stateOf !== 'function') return { error: '会话投影服务不可用' }
    const state = projections.stateOf(session, KEY)
    if (!state || typeof state !== 'object' || !state.tasks) {
      return { error: '任务地图投影不可用（本会话未维护任务板）' }
    }
    return { state }
  } catch (error) {
    return { error: `读取任务地图失败：${errorText(error)}` }
  }
}

function registerTools(ctx) {
  ctx.inject(['tools'], (toolCtx) => {
    const definitions = [
      {
        name: 'task_map_ping',
        description:
          'Task Map M0 health check. Returns plugin status. Use when the user asks whether the Task Map plugin is loaded.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              plugin: { type: 'string' },
              version: { type: 'string' },
              projection: { type: 'boolean' },
              at: { type: 'number' },
            },
            required: ['ok', 'plugin', 'version', 'projection', 'at'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            { type: 'text', text: `Task Map ${value.version}: projection=${value.projection}` },
          ],
        },
        async execute() {
          return {
            ok: true,
            plugin: name,
            version: VERSION,
            projection: status.projection,
            at: Date.now(),
          }
        },
      },
      {
        name: 'task_map_record_relation',
        description:
          'Record a display-only parent/children relation for the Task Map (e.g. after the user asks to split a task). ' +
          'Validates that every id exists on the current session task board and that kind is split/subtask. ' +
          'Does NOT create tasks, change statuses, assign owners, or schedule work; parent status is never rewritten. ' +
          'The relation is carried by this tool-call event, so it is replayable from the session log.',
        parameters: {
          type: 'object',
          properties: {
            parent_task: { type: 'string', description: 'Existing task id on this session task board (e.g. task-4)' },
            children: {
              type: 'array',
              items: { type: 'string' },
              description: 'Existing shared task ids (e.g. ["task-9","task-10"])',
            },
            kind: { type: 'string', enum: ['split', 'subtask'], description: 'Relation kind' },
            note: { type: 'string', description: 'Optional reason shown in the Task Map' },
          },
          required: ['parent_task', 'children', 'kind'],
          additionalProperties: false,
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              validated: { type: 'boolean', description: 'Whether ids were verified against the session task board' },
              reason: { type: 'string', description: 'Rejection reason when ok=false (empty when ok=true)' },
              invalidIds: { type: 'array', items: { type: 'string' } },
              recorded: {
                type: 'object',
                properties: {
                  parent: { type: 'string' },
                  children: { type: 'array', items: { type: 'string' } },
                  kind: { type: 'string' },
                  note: { type: 'string' },
                },
                required: ['parent', 'children', 'kind', 'note'],
                additionalProperties: false,
              },
            },
            required: ['ok', 'validated', 'reason', 'invalidIds', 'recorded'],
            additionalProperties: false,
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.ok
                ? `Recorded ${value.recorded.kind}: ${value.recorded.parent} → ${value.recorded.children.join(', ')}（只记录，不调度）`
                : `Relation not recorded: ${value.reason}`,
            },
          ],
        },
        async execute(args, exec) {
          const parent = typeof args?.parent_task === 'string' ? args.parent_task.trim() : ''
          const rawChildren = Array.isArray(args?.children) ? args.children : []
          const seen = new Set()
          const children = []
          for (const item of rawChildren) {
            if (typeof item !== 'string') continue
            const id = item.trim()
            if (id.length === 0 || seen.has(id)) continue
            seen.add(id)
            children.push(id)
          }
          const kind = args?.kind === 'split' ? 'split' : args?.kind === 'subtask' ? 'subtask' : ''
          const note = typeof args?.note === 'string' ? args.note.slice(0, 200) : ''
          const reject = (reason, invalidIds = []) => ({
            ok: false,
            validated: false,
            reason,
            invalidIds,
            recorded: { parent, children, kind: kind || 'subtask', note },
          })
          if (parent.length === 0) return reject('parent_task 不能为空')
          if (children.length === 0) return reject('children 不能为空（至少一个已存在的任务 id）')
          if (kind === '') return reject('kind 只支持 split 或 subtask')
          if (seen.has(parent)) return reject('parent_task 不能出现在 children 中', [parent])

          // 只读校验：ids 必须存在于「调用方会话」的任务地图投影里。
          const lookup = taskStateOfSession(ctx, exec && exec.agent && exec.agent.id)
          if (lookup.error) return reject(lookup.error)
          const tasks = lookup.state.tasks || {}
          const invalidIds = [parent, ...children].filter((id) => !tasks[id])
          if (invalidIds.length > 0) {
            return reject(`任务不存在于本会话任务板：${invalidIds.join(', ')}`, invalidIds)
          }
          return {
            ok: true,
            validated: true,
            reason: '',
            invalidIds: [],
            recorded: { parent, children, kind, note },
          }
        },
      },
    ]
    for (const definition of definitions) {
      if (status.tools.includes(definition.name)) continue
      try {
        const effectDispose = toolCtx.effect(() => toolCtx.tools.register(definition), `task-map:${definition.name}`)
        mountDisposers.push(effectDispose)
        status.tools.push(definition.name)
        log(`tool "${definition.name}" registered`)
      } catch (error) {
        status.toolErrors.push(`${definition.name}: ${errorText(error)}`)
        log(`tool "${definition.name}" registration failed: ${errorText(error)}`)
      }
    }
  })
}

function sendJson(response, code, value) {
  try {
    const body = JSON.stringify(value)
    response.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    response.end(body)
  } catch (error) {
    log(`sendJson failed: ${errorText(error)}`)
  }
}

function registerRoute(ctx) {
  ctx.inject(['webServer'], (webCtx) => {
    try {
      const dispose = webCtx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (request, response) => {
          // 安全（W5.1）：插件自注册路由不过 DSH 网关鉴权，因此这里自行做同源校验：
          //  · 浏览器同源 fetch 会带 `Sec-Fetch-Site: same-origin`；
          //  · 带 Origin 的请求要求 Origin 与 Host 完全一致；
          //  · 无上述头部的裸请求（curl/脚本）一律 403，避免本地进程信息被任意读取。
          const headers = request && request.headers ? request.headers : {}
          const site = String(headers['sec-fetch-site'] || '').toLowerCase()
          const origin = String(headers.origin || '')
          const host = String(headers.host || '')
          const sameOriginBySite = site === 'same-origin'
          const sameOriginByOrigin = origin.length > 0 && host.length > 0 &&
            (origin === `http://${host}` || origin === `https://${host}`)
          if (!sameOriginBySite && !sameOriginByOrigin) {
            sendJson(response, 403, { ok: false, error: 'forbidden（仅同源可访问）' })
            return
          }
          // 只返回非敏感运行状态；不返回错误堆栈/调试字段。
          sendJson(response, 200, {
            ok: true,
            plugin: name,
            version: VERSION,
            projection: status.projection,
            stateVersion: STATE_VERSION,
            tools: status.tools,
            route: status.route,
          })
        },
      })
      status.route = true
      log(`route "${ROUTE}" registered`)
      const effectDispose = webCtx.effect(() => () => {
        status.route = false
        try {
          if (typeof dispose === 'function') dispose()
        } catch (error) {
          log(`route dispose failed: ${errorText(error)}`)
        }
      })
      mountDisposers.push(effectDispose)
    } catch (error) {
      status.routeError = errorText(error)
      log(`route registration failed: ${status.routeError}`)
    }
  })
}

export function apply(ctx) {
  log(`host applying (${VERSION})`)
  // 同一模块可能被重复 apply（启用/禁用/热更新），先清理上一次挂载，保证幂等。
  resetMounts()
  status.toolErrors = []
  registerProjection(ctx)
  registerTools(ctx)
  registerRoute(ctx)
}
