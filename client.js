/**
 * DSH Task Map — client half（M2 可视化）。
 *
 * 单文件 CJS factory；仅 `require('react')`；无构建链、无 JSX；SVG 手绘；只读派生。
 *
 * 视图数据契约：宿主投影 `taskMap`（lib/derive.js 的 buildClientView 输出，v1.1 起 stateVersion=4）。
 * 结构：
 *   · 顶栏：会话标题 / 统计 chips（随回放时刻变化）/ 回放控制（播放、倍速、进度、时钟）；
 *   · 左上：任务流程图（S 形执行顺序 + blockedBy 依赖曲线 + 关系分叉 + 轨迹生长 + 状态色 + 负责人色条）；
 *   · 左下：甘特时间轴（W2.3）；
 *   · 右侧：总览 / 任务详情（W2.5）。
 *
 * 性能策略：
 *   · 单一回放时钟 store：rAF 推进，帧监听器直接改 DOM/属性；只有离散状态（播放中/倍速/选中）走 React state；
 *   · 任意时刻状态 = 用 task.phases 推导（phase.at <= t 的最后状态），不重建 React 树；
 *   · 每帧只更新播放头/时间文本/状态确实变化的节点（lastSig 缓存）；
 *   · 200 任务时甘特行窗口化、阈值内降级。
 *
 * 无头验证标记：
 *   - <html data-task-map-plugin="m2" data-task-map-client-version="..." data-task-map-slots="...">
 *   - window.__TASK_MAP_M0__ = { loaded, slots, errors }（兼容 M0）
 *   - window.__TASK_MAP_M2__ = { loaded, version, errors, view, lastRenderMs, fps, viewStats, actions, getState }
 *   - 根节点 data-tm-view / data-tm-tasks / data-tm-completed / data-tm-in-progress / data-tm-empty /
 *     data-tm-projection / data-tm-current-time / data-tm-selected / data-tm-playing / data-tm-speed
 *
 * 只读：不写 localStorage / 会话日志 / 任务状态；不 fetch；不引入外部依赖。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-task-map',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const PLUGIN_ID = '@local/dsh-task-map'
    const CLIENT_VERSION = '1.1.3'
    const CLIENT_SCHEMA = 'task-map/client'
    const STYLE_ID = 'task-map-m2-style'
    const SESSION_SLOT_ORDER = 11
    const memo = typeof React.memo === 'function' ? React.memo : (component) => component
    const errors = []
    const registered = []
    // 同一 slot 只保留最后一次注册（插件重复 apply / 重新启用时先释放旧的，避免重复注册）。
    const slotDisposers = new Map()

    // ------------------------------------------------------------------
    // 标记 / 错误记录
    // ------------------------------------------------------------------
    function str(error) {
      if (error == null) return 'unknown error'
      if (typeof error === 'string') return error
      return String((error && error.message) || error)
    }

    function recordError(scope, error) {
      const line = scope + ': ' + str(error)
      if (errors.length < 80) errors.push(line)
      try {
        if (typeof console !== 'undefined' && console.warn) console.warn('[task-map]', line)
      } catch (ignored) { /* noop */ }
    }

    const markerM0 = { loaded: true, slots: registered, errors }
    const markerM2 = { loaded: true, version: CLIENT_VERSION, errors, view: null, lastRenderMs: 0, fps: 0, viewStats: {} }
    try {
      if (typeof window !== 'undefined') {
        window.__TASK_MAP_M0__ = markerM0
        window.__TASK_MAP_M2__ = markerM2
      }
    } catch (error) {
      errors.push('marker: ' + str(error))
    }

    /**
     * 无头 E2E 预览注入：允许 page.evaluate 注入一份合成 view（仅当前页面内存渲染），
     * 用于真实数据里不存在的场景（拆分分叉/19 任务/未来变更）；不落盘、不影响真实投影。
     */
    const previewStore = (() => {
      let current = null
      const listeners = new Set()
      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { recordError('preview', error) }
        }
      }
      return {
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        get() { return current },
        set(nextView) { current = isObject(nextView) ? nextView : null; emit(); return current },
        reset() { current = null; emit() },
        active() { return current !== null },
      }
    })()
    try {
      markerM2.preview = {
        setView: (nextView) => previewStore.set(nextView),
        reset: () => previewStore.reset(),
        active: () => previewStore.active(),
      }
    } catch (error) {
      errors.push('preview: ' + str(error))
    }

    // ------------------------------------------------------------------
    // 单图模式（v1.0.1）：layoutMode = both | flow | gantt（页面内存 store，不写投影）
    // ------------------------------------------------------------------
    const LAYOUT_MODES = ['both', 'flow', 'gantt']

    function normalizeLayoutMode(value) {
      return value === 'flow' || value === 'gantt' ? value : 'both'
    }

    /** 面板在给定布局模式下是否折叠（flow 模式折叠甘特；gantt 模式折叠流程图）。 */
    function isPanelCollapsed(layoutMode, panel) {
      if (layoutMode === 'flow' && panel === 'gantt') return true
      if (layoutMode === 'gantt' && panel === 'flow') return true
      return false
    }

    /** both 模式下流程图分栏高度占比（3 行任务图给多一点）。 */
    function flowShareForRows(flowRows) {
      return flowRows === 3 ? 46 : 40
    }

    /** Grid 行模板（与 CSS 类等价，供测试断言/文档）。 */
    function layoutGridTemplate(layoutMode, flowRows) {
      if (layoutMode === 'flow') return 'minmax(0,1fr) auto'
      if (layoutMode === 'gantt') return 'auto minmax(0,1fr)'
      return 'minmax(220px,' + flowShareForRows(flowRows) + '%) minmax(0,1fr)'
    }

    const layoutStore = (() => {
      let mode = 'both'
      const listeners = new Set()
      return {
        get: () => mode,
        set(next) {
          const normalized = normalizeLayoutMode(next)
          if (normalized === mode) return mode
          mode = normalized
          for (const listener of Array.from(listeners)) {
            try { listener(mode) } catch (error) { recordError('layoutMode', error) }
          }
          return mode
        },
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    })()

    function nowMs() {
      try {
        if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now()
      } catch (ignored) { /* noop */ }
      return Date.now()
    }

    // ------------------------------------------------------------------
    // 常量
    // ------------------------------------------------------------------
    const TASK_STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'blocked']
    const STATUS_LABEL = {
      pending: '待开始',
      in_progress: '执行中',
      completed: '已完成',
      failed: '已失败',
      blocked: '已阻塞',
    }
    const STATUS_CLASS = {
      pending: 'tm-pending',
      in_progress: 'tm-running',
      completed: 'tm-done',
      failed: 'tm-failed',
      blocked: 'tm-blocked',
    }
    const SPEEDS = [60, 120, 300, 600]
    const STEP_MS = 30 * 1000
    const OWNER_PALETTE = [
      '#f59e0b', '#38bdf8', '#a78bfa', '#34d399', '#f472b6', '#22d3ee',
      '#fb923c', '#a3e635', '#2dd4bf', '#60a5fa', '#f87171', '#c084fc',
    ]
    const KNOWN_OWNER_COLORS = { Lead: '#f59e0b', 未指派: '#94a3b8' }
    // 任务图布局常量（与 research prototype 的 S 形布局一致：4 个/行、蛇形换行）
    const FLOW = { COLS: 4, NW: 180, NH: 62, X0: 40, Y0: 46, GAPX: 48, GAPY: 58, BOTTOM: 26 }

    // ------------------------------------------------------------------
    // 通用小工具（纯函数）
    // ------------------------------------------------------------------
    function isObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }
    function text(value) { return typeof value === 'string' ? value : '' }
    function finite(value) { return typeof value === 'number' && Number.isFinite(value) ? value : null }
    function clamp(value, min, max) { return Math.max(min, Math.min(max, value)) }
    function pad2(value) { return String(value).padStart(2, '0') }
    function round2(value) { return Math.round(value * 100) / 100 }

    function truncateText(value, limit) {
      const source = text(value)
      if (!limit || source.length <= limit) return source
      return source.slice(0, Math.max(0, limit - 1)) + '…'
    }

    /** 中文 human-time：毫秒 → 「x 毫秒 / x.x 秒 / x 分 / x.x 时 / x.x 天」。 */
    function fmtDur(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
      const value = Math.max(0, Math.round(ms))
      if (value < 1000) return value + ' 毫秒'
      const seconds = value / 1000
      if (seconds < 60) return (seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds))) + ' 秒'
      const minutes = seconds / 60
      if (minutes < 60) return (minutes < 10 ? minutes.toFixed(1) : String(Math.round(minutes))) + ' 分'
      const hours = minutes / 60
      if (hours < 24) return hours.toFixed(1) + ' 时'
      return (hours / 24).toFixed(1) + ' 天'
    }

    /** 中文 human-time（分秒式，用于等待拆解）：1 时 23 分 / 12 分 5 秒。 */
    function fmtDurCn(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
      const total = Math.max(0, Math.round(ms / 1000))
      if (total < 60) return total + ' 秒'
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes < 60) return minutes + ' 分' + (seconds ? ' ' + seconds + ' 秒' : '')
      const hours = Math.floor(minutes / 60)
      const rest = minutes % 60
      if (hours < 24) return hours + ' 时' + (rest ? ' ' + rest + ' 分' : '')
      const days = Math.floor(hours / 24)
      return days + ' 天 ' + (hours % 24) + ' 时'
    }

    /** 回放时钟：mm:ss；超过 1 小时 h:mm:ss。 */
    function fmtClock(ms) {
      const total = Math.max(0, Math.round((finite(ms) || 0) / 1000))
      const hours = Math.floor(total / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      const seconds = total % 60
      if (hours > 0) return hours + ':' + pad2(minutes) + ':' + pad2(seconds)
      return pad2(minutes) + ':' + pad2(seconds)
    }

    function fmtHm(value) {
      const timestamp = finite(value)
      if (timestamp === null || timestamp <= 0) return '—'
      const date = new Date(timestamp)
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes())
    }

    function fmtHmSec(value) {
      const timestamp = finite(value)
      if (timestamp === null || timestamp <= 0) return '—'
      const date = new Date(timestamp)
      return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds())
    }

    function fmtInt(value) {
      const number = finite(value) || 0
      if (number >= 1e6) return (number / 1e6).toFixed(1) + 'M'
      if (number >= 1e3) return (number / 1e3).toFixed(1) + 'k'
      return String(number)
    }

    function shortPath(value) {
      const source = text(value)
      if (!source) return ''
      return source.replace(/^\/Users\/[^/]+/, '~')
    }

    /** 稳定的负责人配色：已知名字固定色，其余按名字哈希落入调色板（与会话顺序/数据更新无关）。 */
    function ownerColorFor(name) {
      const key = text(name)
      if (!key) return '#94a3b8'
      if (KNOWN_OWNER_COLORS[key]) return KNOWN_OWNER_COLORS[key]
      let hash = 5381
      for (let index = 0; index < key.length; index += 1) {
        hash = ((hash << 5) + hash + key.charCodeAt(index)) & 0x7fffffff
      }
      return OWNER_PALETTE[hash % OWNER_PALETTE.length]
    }

    function buildOwnerColorMap(tasks) {
      const map = Object.assign({}, KNOWN_OWNER_COLORS)
      const seen = new Set()
      for (const task of tasks || []) {
        const name = text(task && task.owner)
        if (!name || seen.has(name)) continue
        seen.add(name)
        map[name] = ownerColorFor(name)
      }
      return map
    }

    /** 二分：返回「最后一个 <= value 的下标」，全部大于时返回 -1（times 必须升序）。 */
    function lastIndexAtOrBefore(times, value) {
      let low = 0
      let high = (times ? times.length : 0) - 1
      let found = -1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (times[mid] <= value) {
          found = mid
          low = mid + 1
        } else {
          high = mid - 1
        }
      }
      return found
    }

    /** 二分：返回 <= value 的元素个数。 */
    function countAtOrBefore(times, value) {
      return lastIndexAtOrBefore(times, value) + 1
    }

    // ------------------------------------------------------------------
    // 视图准备（纯函数）：把 buildClientView 输出整理成渲染用结构
    // ------------------------------------------------------------------
    function normalizePhase(raw) {
      const phase = isObject(raw) ? raw : {}
      return {
        status: TASK_STATUSES.indexOf(phase.status) >= 0 ? phase.status : 'pending',
        at: finite(phase.at) === null ? 0 : phase.at,
      }
    }

    function normalizeTask(raw, index) {
      const task = isObject(raw) ? raw : {}
      const id = text(task.id) || 'task-' + (index + 1)
      const phases = Array.isArray(task.phases)
        ? task.phases.filter(isObject).map(normalizePhase).sort((left, right) => left.at - right.at)
        : []
      return {
        id,
        kind: text(task.kind) || 'team',
        subject: text(task.subject) || '（未命名任务）',
        description: text(task.description),
        status: TASK_STATUSES.indexOf(task.status) >= 0 ? task.status : 'pending',
        owner: text(task.owner),
        ownerId: text(task.ownerId) || null,
        ownerIsLead: task.ownerIsLead === true,
        createdAt: finite(task.createdAt) === null ? 0 : task.createdAt,
        startedAt: finite(task.startedAt),
        completedAt: finite(task.completedAt),
        failedAt: finite(task.failedAt),
        updatedAt: finite(task.updatedAt) === null ? 0 : task.updatedAt,
        blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map((item) => String(item)) : [],
        writeScopes: Array.isArray(task.writeScopes) ? task.writeScopes.map((item) => String(item)) : [],
        phases,
        execMs: finite(task.execMs),
        queueMs: finite(task.queueMs),
        readyAt: finite(task.readyAt),
        blockedWaitMs: finite(task.blockedWaitMs),
        readyDelayMs: finite(task.readyDelayMs),
        startRank: finite(task.startRank),
        doneRank: finite(task.doneRank),
        revision: finite(task.revision) === null ? 1 : task.revision,
        spanCount: finite(task.spanCount),
        isNew: false,
        order: index,
      }
    }

    function normalizeSpan(raw, index) {
      const span = isObject(raw) ? raw : {}
      const start = finite(span.start)
      if (start === null) return null
      return {
        kind: span.kind === 'job' || span.kind === 'approval' ? span.kind : 'tool',
        name: text(span.name),
        label: text(span.label),
        start,
        end: finite(span.end),
        status: text(span.status) || (finite(span.end) === null ? 'running' : 'ok'),
        error: text(span.error),
        outcome: text(span.outcome),
        order: index,
      }
    }

    function normalizeMember(raw, index) {
      const member = isObject(raw) ? raw : {}
      const phases = Array.isArray(member.phases)
        ? member.phases
          .filter(isObject)
          .map((phase) => ({ phase: text(phase.phase) || 'unknown', at: finite(phase.at) === null ? 0 : phase.at }))
          .sort((left, right) => left.at - right.at)
        : []
      return {
        id: text(member.id) || 'member-' + (index + 1),
        name: text(member.name) || '未命名代理',
        description: text(member.description),
        phase: text(member.phase) || 'unknown',
        phases,
        createdAt: finite(member.createdAt) === null ? (phases[0] ? phases[0].at : 0) : member.createdAt,
        updatedAt: finite(member.updatedAt) === null ? 0 : member.updatedAt,
      }
    }

    const EMPTY_TASK_STATS = { total: 0, pending: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, other: 0 }

    function compareTasks(left, right) {
      const leftRank = left.startRank === null ? Number.MAX_SAFE_INTEGER : left.startRank
      const rightRank = right.startRank === null ? Number.MAX_SAFE_INTEGER : right.startRank
      if (leftRank !== rightRank) return leftRank - rightRank
      if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
    }

    /**
     * 任务图布局（W2.1，与 prototype 一致）：
     *   · 每行 4 个节点；偶数行左→右、奇数行右→左（S 形蛇形），执行顺序连续；
     *   · 返回总宽高与每个节点左上角坐标。
     */
    function computeFlowLayout(taskCount) {
      const count = Math.max(0, Math.floor(finite(taskCount) || 0))
      const cols = FLOW.COLS
      const rows = Math.max(1, Math.ceil(count / cols))
      // 行数多时压缩行高：2 行内保持原型尺寸；3 行与 4+ 行逐级压缩（配合面板自适应/滚动）。
      const nodeHeight = rows <= 2 ? FLOW.NH : (rows <= 4 ? 54 : 50)
      const gapY = rows <= 2 ? FLOW.GAPY : (rows <= 4 ? 40 : 32)
      const width = FLOW.X0 * 2 + cols * FLOW.NW + (cols - 1) * FLOW.GAPX
      const height = FLOW.Y0 + rows * nodeHeight + (rows - 1) * gapY + FLOW.BOTTOM
      const positions = []
      for (let index = 0; index < count; index += 1) {
        const row = Math.floor(index / cols)
        const colInRow = index % cols
        const col = row % 2 === 0 ? colInRow : cols - 1 - colInRow
        positions.push({
          x: FLOW.X0 + col * (FLOW.NW + FLOW.GAPX),
          y: FLOW.Y0 + row * (nodeHeight + gapY),
          row,
          col,
        })
      }
      return { cols, rows, width, height, positions, nodeWidth: FLOW.NW, nodeHeight, gapY }
    }

    function flowNodeCenter(flow, index) {
      const position = flow.positions[index]
      if (!position) return { x: 0, y: 0 }
      return { x: position.x + flow.nodeWidth / 2, y: position.y + flow.nodeHeight / 2 }
    }

    /**
     * 单图（流程图）模式：保持节点尺寸不变，把额外垂直空间均匀分配到行间距，
     * 使 viewBox 高度与容器可视高度匹配（不横向溢出、不拉伸图形）。
     */
    function stretchFlowLayout(baseFlow, targetHeight, maxViewport) {
      const flow = baseFlow
      let target = finite(targetHeight)
      if (!flow || target === null || flow.rows < 2) return flow
      // 二次保险：目标 viewBox 高度不超过「按容器高度换算出的上限」，避免比例/取整误差造成纵向溢出。
      if (maxViewport && maxViewport.width > 0 && maxViewport.height > 0) {
        const cap = maxViewport.height * (flow.width / maxViewport.width)
        if (Number.isFinite(cap) && cap > 0) target = Math.min(target, cap)
      }
      const extra = Math.max(0, target - flow.height)
      if (extra <= 0.5) return flow
      // 额外空间：45% 给节点高度（大卡片），55% 给行间距（避免行与行贴太近/太空）。
      const nodeExtra = Math.min((extra * 0.45) / flow.rows, 96)
      let gapExtra = 0
      if (flow.rows > 1) {
        const consumedByNodes = nodeExtra * flow.rows
        gapExtra = Math.max(0, (extra - consumedByNodes) / (flow.rows - 1))
      }
      const nodeHeight = flow.nodeHeight + nodeExtra
      const gapY = flow.gapY + gapExtra
      const rowStep = nodeHeight + gapY
      return {
        ...flow,
        nodeHeight,
        gapY,
        height: flow.height + nodeExtra * flow.rows + gapExtra * (flow.rows - 1),
        positions: flow.positions.map((position) => ({
          ...position,
          y: FLOW.Y0 + position.row * rowStep,
        })),
      }
    }

    function buildFlowPath(flow, taskCount) {
      if (taskCount < 2) return ''
      let path = ''
      for (let index = 0; index < taskCount; index += 1) {
        const center = flowNodeCenter(flow, index)
        path += (index === 0 ? 'M' : ' L') + center.x + ',' + center.y
      }
      return path
    }

    /** 依赖边（blockedBy）曲线：从阻塞任务底部到被阻塞任务顶部。 */
    function buildDependencyPath(fromPosition, toPosition, nodeWidth, nodeHeight) {
      const sx = fromPosition.x + nodeWidth / 2
      const sy = fromPosition.y + nodeHeight - 6
      const ex = toPosition.x + nodeWidth / 2
      const ey = toPosition.y + 6
      const mx = (sx + ex) / 2
      const curve = Math.min(90, Math.max(28, Math.abs(ey - sy) * 0.55))
      const my = (sy + ey) / 2 + (ey >= sy ? curve : -curve)
      return 'M' + round2(sx) + ',' + round2(sy) + ' Q' + round2(mx) + ',' + round2(my) + ' ' + round2(ex) + ',' + round2(ey)
    }

    /** 关系边（父子/分叉）曲线：横向偏移，避免与依赖曲线重叠。 */
    function buildRelationPath(fromPosition, toPosition, nodeWidth, nodeHeight, side) {
      const direction = side === 'right' ? 1 : -1
      const sx = fromPosition.x + nodeWidth / 2 + direction * (nodeWidth / 2 - 6)
      const sy = fromPosition.y + nodeHeight / 2
      const ex = toPosition.x + nodeWidth / 2 + direction * (nodeWidth / 2 - 6)
      const ey = toPosition.y + nodeHeight / 2
      const mx = (sx + ex) / 2 + direction * 46
      const my = (sy + ey) / 2
      return 'M' + round2(sx) + ',' + round2(sy) + ' Q' + round2(mx) + ',' + round2(my) + ' ' + round2(ex) + ',' + round2(ey)
    }

    /**
     * 任意回放时刻的任务状态：以 phases（状态历史，按 at 升序）为准；
     * 没有 phases 时按 startedAt/completedAt/failedAt 时间戳兜底。
     */
    function statusAtTime(task, time) {
      if (!isObject(task)) return 'pending'
      const moment = finite(time)
      if (moment === null) return task.status || 'pending'
      const phases = Array.isArray(task.phases) ? task.phases : []
      let current = null
      for (let index = 0; index < phases.length; index += 1) {
        const phase = phases[index]
        if (!isObject(phase)) continue
        const at = finite(phase.at)
        if (at === null) continue
        if (at <= moment) current = TASK_STATUSES.indexOf(phase.status) >= 0 ? phase.status : current
        else if (current !== null) break
      }
      if (current !== null) return current
      if (finite(task.completedAt) !== null && task.completedAt <= moment) return 'completed'
      if (finite(task.failedAt) !== null && task.failedAt <= moment) return 'failed'
      if (finite(task.startedAt) !== null && task.startedAt <= moment) return 'in_progress'
      return 'pending'
    }

    function isCreatedAtTime(task, time) {
      if (!isObject(task)) return false
      const createdAt = finite(task.createdAt)
      const moment = finite(time)
      if (createdAt === null || moment === null) return true
      return createdAt <= moment
    }

    /** 任意时刻的统计快照（状态 chips / 进度条；与 statusAtTime 完全一致）。 */
    function countsAtTime(tasks, time) {
      const counts = { total: 0, created: 0, pending: 0, in_progress: 0, completed: 0, failed: 0, blocked: 0, other: 0 }
      const list = Array.isArray(tasks) ? tasks : []
      counts.total = list.length
      for (const task of list) {
        if (isCreatedAtTime(task, time)) counts.created += 1
        const status = statusAtTime(task, time)
        if (counts[status] !== undefined) counts[status] += 1
        else counts.other += 1
      }
      return counts
    }

    /** 节点 class（纯函数，便于测试）：状态/未来/选中。 */
    function flowNodeClass(status, options) {
      const opts = options || {}
      const classes = ['tm-node', STATUS_CLASS[status] || STATUS_CLASS.pending]
      if (opts.future) classes.push('tm-future')
      if (opts.selected) classes.push('tm-sel')
      return classes.join(' ')
    }

    /** 执行过程归属：按任务 [startedAt, completedAt|now] 时间窗与 span 区间重叠推断（非精确归属）。 */
    function taskSpansInWindow(task, spans, now) {
      if (!isObject(task)) return []
      const list = Array.isArray(spans) ? spans : []
      const start = finite(task.startedAt)
      if (start === null) return []
      const end = finite(task.completedAt) !== null ? task.completedAt : (finite(now) !== null ? now : start)
      const out = []
      for (const span of list) {
        if (!isObject(span)) continue
        const spanStart = finite(span.start)
        if (spanStart === null) continue
        const spanEnd = finite(span.end) === null ? Number.MAX_SAFE_INTEGER : span.end
        if (spanStart < end && spanEnd > start) out.push(span)
      }
      return out
    }

    // ------------------------------------------------------------------
    // 关系层（W4.3，纯函数）：父/子视图、有效性与支线计数
    // ------------------------------------------------------------------
    /** 归一化 relations（M4：source='tool'；valid 以数据层为准并做存在性兜底）。 */
    function normalizeRelations(rawRelations, taskById) {
      const list = Array.isArray(rawRelations) ? rawRelations.filter(isObject) : []
      return list.map((relation) => {
        const parent = text(relation.parent)
        const children = Array.isArray(relation.children)
          ? relation.children.map((item) => String(item)).filter(Boolean)
          : []
        const missing = []
        if (!taskById[parent]) missing.push(parent)
        for (const child of children) {
          if (!taskById[child]) missing.push(child)
        }
        return {
          parent,
          children,
          kind: text(relation.kind) || 'subtask',
          note: text(relation.note),
          recordedAt: finite(relation.recordedAt),
          seq: finite(relation.seq) === null ? -1 : relation.seq,
          source: text(relation.source) || 'tool',
          valid: relation.valid !== false && missing.length === 0,
          missing,
        }
      })
    }

    /** 由 relations 派生：父任务→子任务、子任务→父任务、无效关系。 */
    function buildRelationIndex(relations) {
      const byParent = {}
      const childParent = {}
      const childRelations = {}
      const parentChildCount = {}
      const invalidRelations = []
      for (const relation of relations) {
        if (!relation.valid) {
          invalidRelations.push(relation)
          continue
        }
        if (!byParent[relation.parent]) byParent[relation.parent] = []
        const existing = new Set()
        for (const rel of byParent[relation.parent]) for (const child of rel.children) existing.add(child)
        const freshChildren = []
        for (const child of relation.children) {
          if (existing.has(child)) continue
          existing.add(child)
          freshChildren.push(child)
          parentChildCount[relation.parent] = (parentChildCount[relation.parent] || 0) + 1
          if (!childParent[child]) childParent[child] = relation.parent
          if (!childRelations[child]) childRelations[child] = []
          childRelations[child].push({ parent: relation.parent, kind: relation.kind, note: relation.note })
        }
        // 保留每条 relation 的原始 children（含重复引用），用于详情逐条展示
        byParent[relation.parent].push({
          parent: relation.parent,
          children: relation.children.slice(),
          kind: relation.kind,
          note: relation.note,
          at: relation.recordedAt,
          seq: relation.seq,
          source: relation.source,
        })
      }
      return { byParent, childParent, childRelations, parentChildCount, invalidRelations }
    }

    /** 父任务的支线子任务列表（去重、按 relation 记录顺序）。 */
    function relationChildrenOf(prep, parentId) {
      if (!prep || !prep.relation) return []
      const relations = prep.relation.byParent[parentId] || []
      const seen = new Set()
      const out = []
      for (const relation of relations) {
        for (const childId of relation.children) {
          if (seen.has(childId)) continue
          seen.add(childId)
          const task = prep.taskById[childId]
          if (task) out.push(task)
        }
      }
      return out
    }

    /** 子任务所属的父任务 id（无关系返回 ''）。 */
    function relationParentOf(prep, childId) {
      if (!prep || !prep.relation) return ''
      return prep.relation.childParent[childId] || ''
    }

    /** 父任务的支线数量（E2E badge 用）。 */
    function relationBadgeCount(prep, parentId) {
      if (!prep || !prep.relation) return 0
      return prep.relation.parentChildCount[parentId] || 0
    }

    // ------------------------------------------------------------------
    // 甘特时间轴布局（W2.3，纯函数）：刻度 / 行 / 事件 / 热度
    // ------------------------------------------------------------------
    const TIMELINE = {
      W: 960, LABEL: 124, X0: 132, X1: 944,
      TOP: 20, ROW_H: 18, MEM_H: 16, EV_H: 14, DEN_H: 22, GAP: 9, BOTTOM: 10,
    }
    // 时间刻度候选步长：1s / 5s / 10s / 30s / 1min / 5min / 10min / 30min / 1h / 6h
    const TICK_STEPS = [1000, 5000, 10000, 30000, 60000, 300000, 600000, 1800000, 3600000, 21600000]

    /** 自适应刻度步长：让刻度数量落在 4~9 个之间。 */
    function chooseTickStep(spanMs) {
      const span = Math.max(1, finite(spanMs) || 1)
      for (const step of TICK_STEPS) {
        if (span / step <= 9) return step
      }
      return TICK_STEPS[TICK_STEPS.length - 1]
    }

    /** 时间 → 甘特 x 坐标（viewBox 单位）。 */
    function timelineX(timeline, timestamp) {
      const value = finite(timestamp)
      if (!timeline || value === null) return timeline ? timeline.x0 : 0
      const ratio = (value - timeline.start) / timeline.span
      return timeline.x0 + clamp(ratio, -0.02, 1.02) * (timeline.x1 - timeline.x0)
    }

    function buildTimelineTicks(start, end) {
      const span = Math.max(1, end - start)
      const step = chooseTickStep(span)
      const ticks = []
      for (let offset = 0; offset <= span && ticks.length < 24; offset += step) {
        ticks.push({ ts: start + offset, label: fmtClock(offset) })
      }
      return { step, ticks }
    }

    function baseName(filePath) {
      const source = text(filePath)
      if (!source) return ''
      const parts = source.split('/')
      return parts[parts.length - 1] || source
    }

    /** 事件行：审批等待 / 交付 / 代理启动（全部来自投影时间戳）。 */
    function buildTimelineEvents(input) {
      const data = input || {}
      const spans = Array.isArray(data.spans) ? data.spans : []
      const milestones = Array.isArray(data.milestones) ? data.milestones : []
      const members = Array.isArray(data.members) ? data.members : []
      const events = []
      for (const span of spans) {
        if (span && span.kind === 'approval') {
          events.push({
            kind: 'approval',
            at: span.start,
            label: '等待审批 ' + (span.name || span.label || '工具'),
            detail: span.outcome ? '结果：' + span.outcome : (span.status === 'running' ? '进行中' : ''),
          })
        }
      }
      for (const milestone of milestones) {
        if (!milestone || milestone.kind !== 'deliverable') continue
        const files = Array.isArray(milestone.files) ? milestone.files : []
        const first = files[0] || {}
        events.push({
          kind: 'deliverable',
          at: finite(milestone.at) || 0,
          label: '交付 ' + (baseName(first.path) || 'deliverable'),
          detail: truncateText(first.description || '', 90),
        })
      }
      for (const member of members) {
        if (!member) continue
        events.push({
          kind: 'spawn',
          at: finite(member.createdAt) || 0,
          label: '启动代理 ' + (member.name || ''),
          detail: truncateText(member.description || '', 90),
        })
      }
      return events
        .filter((event) => event.at > 0)
        .sort((left, right) => left.at - right.at)
        .slice(0, 80)
    }

    /** 热度行：tool/job span 的时间覆盖率分桶（approval 不计热度）。 */
    function buildDensityBuckets(input) {
      const data = input || {}
      const spans = Array.isArray(data.spans) ? data.spans : []
      const start = finite(data.start) || 0
      const end = Math.max(start + 1, finite(data.end) || start + 1)
      const chartWidth = Math.max(1, finite(data.chartWidth) || 800)
      const count = clamp(Math.round(chartWidth / 16), 24, 64)
      const bucketMs = (end - start) / count
      const values = new Array(count).fill(0)
      for (const span of spans) {
        if (!span || span.kind === 'approval') continue
        const spanStart = finite(span.start)
        if (spanStart === null) continue
        const spanEnd = finite(span.end) === null ? end : span.end
        const clippedStart = clamp(spanStart, start, end)
        const clippedEnd = clamp(spanEnd, start, end)
        if (clippedEnd <= clippedStart) continue
        const first = clamp(Math.floor((clippedStart - start) / bucketMs), 0, count - 1)
        const last = clamp(Math.floor((clippedEnd - start) / bucketMs), 0, count - 1)
        for (let index = first; index <= last; index += 1) {
          const bucketStart = start + index * bucketMs
          const bucketEnd = bucketStart + bucketMs
          values[index] += Math.max(0, Math.min(clippedEnd, bucketEnd) - Math.max(clippedStart, bucketStart))
        }
      }
      let maxValue = 0
      for (const value of values) if (value > maxValue) maxValue = value
      if (maxValue <= 0) maxValue = 1
      const width = chartWidth / count
      return values.map((value, index) => ({
        index,
        x: TIMELINE.X0 + index * width,
        width: Math.max(1, width - 1),
        ratio: value / maxValue,
        end: start + (index + 1) * bucketMs,
      }))
    }

    /** 甘特布局：所有行的 y 坐标、刻度、事件、热度桶。 */
    function computeTimelineLayout(input) {
      const data = input || {}
      const tasks = Array.isArray(data.tasks) ? data.tasks : []
      const members = Array.isArray(data.members) ? data.members : []
      const start = finite(data.start) === null ? 0 : data.start
      const end = Math.max(start + 1, finite(data.end) === null ? start + 1 : data.end)
      const span = end - start
      const chartWidth = TIMELINE.X1 - TIMELINE.X0

      // 单图模式（甘特占满左栏）时按可视高度纵向放大行高，避免下方大片空白。
      const rowScale = clamp(finite(data.rowScale) === null ? 1 : data.rowScale, 1, 2.6)
      const rowH = TIMELINE.ROW_H * rowScale
      const memH = TIMELINE.MEM_H * rowScale
      const evH = TIMELINE.EV_H * rowScale
      const denH = TIMELINE.DEN_H * rowScale
      const gap = TIMELINE.GAP * rowScale
      const tasksGroupY = TIMELINE.TOP + 14
      const tasksY0 = tasksGroupY + 7
      let cursor = tasksY0 + tasks.length * rowH
      const membersGroupY = cursor + gap
      const membersY0 = membersGroupY + 7
      cursor = membersY0 + members.length * memH
      const eventsGroupY = cursor + gap
      const eventsY = eventsGroupY + 12
      cursor = eventsGroupY + 7 + evH
      const densityGroupY = cursor + gap
      const densityY0 = densityGroupY + 8
      const height = densityY0 + denH + TIMELINE.BOTTOM

      const tickData = buildTimelineTicks(start, end)
      const leadMs = clamp(finite(data.idleLeadMs) || 0, 0, span * 0.9)
      const timeline = {
        width: TIMELINE.W,
        labelRight: TIMELINE.LABEL - 10,
        labelWidth: TIMELINE.LABEL,
        x0: TIMELINE.X0,
        x1: TIMELINE.X1,
        top: TIMELINE.TOP,
        start,
        end,
        span,
        rowH,
        memH,
        evH,
        denH,
        rowScale,
        height,
        tasksY0,
        membersY0,
        eventsY,
        densityY0,
        groups: {
          tasks: { y: tasksGroupY, label: '任务 ' + tasks.length },
          members: { y: membersGroupY, label: '代理 ' + members.length },
          events: { y: eventsGroupY, label: '事件' },
          density: { y: densityGroupY, label: '热度' },
        },
        ticks: tickData.ticks,
        tickStep: tickData.step,
        taskRows: tasks.map((task, index) => ({ task, index, y: tasksY0 + index * rowH })),
        memberRows: members.map((member, index) => ({ member, index, y: membersY0 + index * memH })),
        events: buildTimelineEvents(data),
        density: buildDensityBuckets({ spans: data.spans, start, end, chartWidth }),
        spansTruncated: data.spansTruncated === true,
        spanSummary: data.spanSummary || null,
        idleLeadMs: leadMs,
        idle: null,
      }
      for (const tick of timeline.ticks) tick.x = timelineX(timeline, tick.ts)
      if (leadMs >= 60000) {
        const idleX = timelineX(timeline, start)
        const idleEndX = timelineX(timeline, start + leadMs)
        timeline.idle = {
          x: idleX,
          width: Math.max(0, idleEndX - idleX),
          label: '会话创建→开工 ' + fmtDurCn(leadMs),
        }
      }
      for (const event of timeline.events) event.x = timelineX(timeline, event.at)
      return timeline
    }

    /**
     * 任务阶段区间（状态历史 → 可读区间）：返回 [{status, from, to|null, ms, open}]。
     * 传入 moment 时按回放时刻截断：from > moment 的未来区间不返回；跨越 moment 的区间 open 到 moment。
     */
    function buildPhaseIntervals(task, moment) {
      if (!isObject(task)) return []
      const phases = Array.isArray(task.phases) ? task.phases : []
      const now = finite(moment)
      const intervals = []
      for (let index = 0; index < phases.length; index += 1) {
        const phase = isObject(phases[index]) ? phases[index] : null
        if (!phase || !TASK_STATUSES.includes(phase.status)) continue
        const from = finite(phase.at)
        if (from === null) continue
        if (now !== null && from > now) continue
        const next = phases[index + 1]
        const rawTo = next ? finite(next.at) : null
        const cappedTo = rawTo !== null && now !== null ? Math.min(rawTo, now) : rawTo
        const open = rawTo === null || (now !== null && rawTo > now)
        intervals.push({
          status: phase.status,
          from,
          to: open ? null : cappedTo,
          ms: open ? (now !== null ? Math.max(0, now - from) : null) : Math.max(0, cappedTo - from),
          open,
        })
      }
      return intervals
    }

    /** 代理在给定时刻的阶段（用于活跃代理统计与代理行提示）。 */
    function memberPhaseAt(member, moment) {
      if (!isObject(member)) return null
      const phases = Array.isArray(member.phases) ? member.phases : []
      let current = null
      for (const phase of phases) {
        if (!isObject(phase)) continue
        const at = finite(phase.at)
        if (at === null) continue
        if (at <= moment) current = phase
        else break
      }
      return current
    }

    /** 给定时刻处于 active 的代理数量（回放时刻的「活跃代理」）。 */
    function activeMembersAt(members, moment) {
      const list = Array.isArray(members) ? members : []
      const active = []
      for (const member of list) {
        const phase = memberPhaseAt(member, moment)
        if (phase && phase.phase === 'active') active.push(member)
      }
      return active
    }

    /**
     * 该任务的「最近一次交接」（上一任务完成 → 本任务开始）：
     * 并行任务可能有多个候选，取间隔最小（即最贴近本任务开始）的一次；无记录返回 null。
     */
    function handoffForTask(waits, taskId) {
      const handoffs = waits && Array.isArray(waits.handoffs) ? waits.handoffs : []
      let best = null
      for (const handoff of handoffs) {
        if (!isObject(handoff) || handoff.to !== taskId) continue
        if (best === null || handoff.gapMs < best.gapMs) best = handoff
      }
      return best
    }

    // ------------------------------------------------------------------
    // 计划基线 / 变更流（W3.2，纯函数）：归一化、as-of 过滤、变更历史
    // ------------------------------------------------------------------
    const CHANGE_KIND_LABEL = { added: '新增', removed: '移除', dependency: '依赖变更', split: '拆分' }

    function changeKindLabel(kind) {
      return CHANGE_KIND_LABEL[kind] || '变更'
    }

    /** 归一化变更流：排序（at/seq 升序）、去重保护、字段容错；上限 200 条与数据层一致。 */
    function normalizeChanges(rawChanges, baseline) {
      const raw = isObject(rawChanges) ? rawChanges : {}
      const toIds = (list) => (Array.isArray(list) ? list.map((item) => String(item)).filter(Boolean) : [])
      const added = toIds(raw.added)
      const removed = toIds(raw.removed)
      const dependencyChanged = (Array.isArray(raw.dependencyChanged) ? raw.dependencyChanged : [])
        .filter(isObject)
        .map((item) => ({
          id: text(item.id) || text(item.taskId),
          from: toIds(item.from),
          to: toIds(item.to),
          at: finite(item.at),
        }))
        .filter((item) => item.id)
        .sort((left, right) => (finite(left.at) === null ? 0 : left.at) - (finite(right.at) === null ? 0 : right.at))
      const splits = (Array.isArray(raw.splits) ? raw.splits : [])
        .filter(isObject)
        // 拆分计数只统计有效关系（无效关系走 invalidRelations / warnings，不进计划变更流）
        .filter((item) => item.valid !== false)
        .map((item) => ({
          parent: text(item.parent),
          children: toIds(item.children),
          kind: text(item.kind) || 'split',
          note: text(item.note),
          at: finite(item.at),
          seq: finite(item.seq) === null ? -1 : item.seq,
          valid: item.valid !== false,
        }))
        .filter((item) => item.parent)
        .sort((left, right) => (finite(left.at) === null ? 0 : left.at) - (finite(right.at) === null ? 0 : right.at) || left.seq - right.seq)
      const invalidRelations = (Array.isArray(raw.invalidRelations) ? raw.invalidRelations : [])
        .filter(isObject)
        .map((item) => ({
          parent: text(item.parent),
          children: toIds(item.children),
          kind: text(item.kind) || 'split',
          note: text(item.note),
          at: finite(item.at) === null ? 0 : item.at,
          seq: finite(item.seq) === null ? -1 : item.seq,
          missing: toIds(item.missing),
        }))
        .filter((item) => item.parent)
        .sort((left, right) => left.at - right.at || left.seq - right.seq)
      const log = (Array.isArray(raw.log) ? raw.log : [])
        .filter(isObject)
        .map((entry) => {
          const kind = text(entry.kind)
          const node = {
            at: finite(entry.at) === null ? 0 : entry.at,
            seq: finite(entry.seq) === null ? -1 : entry.seq,
            kind,
            taskId: text(entry.taskId),
            text: text(entry.text) || (changeKindLabel(kind) + ' ' + text(entry.taskId)),
          }
          if (kind === 'dependency') {
            node.from = toIds(entry.from)
            node.to = toIds(entry.to)
          }
          if (kind === 'split') node.children = toIds(entry.children)
          return node
        })
        .sort((left, right) => left.at - right.at || left.seq - right.seq)
        .slice(0, 200)
      const rawCounts = isObject(raw.counts) ? raw.counts : null
      const counts = {
        planned: rawCounts && finite(rawCounts.planned) !== null ? rawCounts.planned : (baseline ? baseline.taskIds.length : 0),
        added: rawCounts && finite(rawCounts.added) !== null ? rawCounts.added : added.length,
        removed: rawCounts && finite(rawCounts.removed) !== null ? rawCounts.removed : removed.length,
        dependencyChanged: rawCounts && finite(rawCounts.dependencyChanged) !== null ? rawCounts.dependencyChanged : dependencyChanged.length,
        splits: rawCounts && finite(rawCounts.splits) !== null ? rawCounts.splits : splits.length,
        invalidRelations: rawCounts && finite(rawCounts.invalidRelations) !== null
          ? rawCounts.invalidRelations
          : invalidRelations.length,
      }
      return { added, removed, dependencyChanged, splits, invalidRelations, counts, log }
    }

    /**
     * 会话计划（todo，v1.1 / STATE_VERSION 4）：只读快照。
     * active=true 表示同会话还存在团队任务（图/甘特展示团队任务，计划清单单独展示）；
     * active=false 表示无团队任务、图/甘特本身就是 todo 降级任务 → 计划区块隐藏避免重复。
     */
    function normalizePlan(raw) {
      if (!isObject(raw)) return null
      const items = (Array.isArray(raw.items) ? raw.items : [])
        .filter(isObject)
        .map((item, index) => {
          const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending'
          return {
            id: text(item.id) || ('todo-' + index),
            index: finite(item.index) === null ? index + 1 : item.index,
            content: text(item.content).trim(),
            status,
            updatedAt: finite(item.updatedAt),
          }
        })
        .filter((item) => item.content)
      if (items.length === 0) return null
      const derived = {
        completed: items.filter((item) => item.status === 'completed').length,
        inProgress: items.filter((item) => item.status === 'in_progress').length,
        pending: items.filter((item) => item.status === 'pending').length,
      }
      const rawCounts = isObject(raw.counts) ? raw.counts : {}
      return {
        items,
        counts: {
          completed: finite(rawCounts.completed) === null ? derived.completed : rawCounts.completed,
          inProgress: finite(rawCounts.inProgress) === null ? derived.inProgress : rawCounts.inProgress,
          pending: finite(rawCounts.pending) === null ? derived.pending : rawCounts.pending,
        },
        updatedAt: finite(raw.updatedAt),
        writeCount: finite(raw.writeCount) === null ? 0 : raw.writeCount,
        source: text(raw.source) || 'todo',
        active: raw.active !== false,
      }
    }

    /**
     * 无效关系统一列表：M5 数据层把无效关系放进 changes.invalidRelations（不计入拆分变更流）；
     * 老视图只有 relations(valid=false) / relation.invalidRelations，这里做兜底与去重。
     */
    function invalidRelationsOf(prep) {
      const fromChanges = prep && prep.changes && Array.isArray(prep.changes.invalidRelations)
        ? prep.changes.invalidRelations
        : []
      const fromRelations = prep && prep.relation && Array.isArray(prep.relation.invalidRelations)
        ? prep.relation.invalidRelations
        : []
      const pool = fromChanges.length > 0 ? fromChanges : fromRelations
      const out = []
      const seen = new Set()
      for (const relation of pool) {
        if (!relation) continue
        const parent = text(relation.parent)
        const children = Array.isArray(relation.children) ? relation.children.map((item) => String(item)) : []
        const missing = Array.isArray(relation.missing) && relation.missing.length > 0
          ? relation.missing.map((item) => String(item))
          : children.concat(parent ? [] : [parent])
        const key = parent + '|' + children.join(',') + '|' + String(finite(relation.at) === null ? 0 : relation.at)
        if (seen.has(key)) continue
        seen.add(key)
        out.push({
          parent,
          children,
          kind: text(relation.kind) || 'split',
          note: text(relation.note),
          at: finite(relation.at),
          seq: finite(relation.seq) === null ? -1 : relation.seq,
          missing,
        })
      }
      return out
    }

    /** as-of 回放时刻的变更过滤：entry.at > moment 属于「未来变更」，不展示。 */
    function visibleChangeLog(changes, moment) {
      const log = changes && Array.isArray(changes.log) ? changes.log : []
      const now = finite(moment)
      if (now === null) return log.slice()
      return log.filter((entry) => finite(entry.at) === null || entry.at <= now)
    }

    /** 变更计数（按回放时刻过滤）：新增/移除/依赖变更/拆分 + 可见/隐藏条数。 */
    function asOfChangeCounts(prep, moment) {
      const changes = prep && prep.changes ? prep.changes : {}
      const log = Array.isArray(changes.log) ? changes.log : []
      const result = {
        planned: changes.counts && finite(changes.counts.planned) !== null
          ? changes.counts.planned
          : (prep && prep.baseline ? prep.baseline.taskIds.length : 0),
        added: 0,
        removed: 0,
        dependencyChanged: 0,
        splits: 0,
        visible: 0,
        hidden: 0,
      }
      const now = finite(moment)
      if (log.length > 0) {
        for (const entry of log) {
          const at = finite(entry.at)
          if (now !== null && at !== null && at > now) {
            result.hidden += 1
            continue
          }
          result.visible += 1
          if (entry.kind === 'added') result.added += 1
          else if (entry.kind === 'removed') result.removed += 1
          else if (entry.kind === 'dependency') result.dependencyChanged += 1
          else if (entry.kind === 'split') result.splits += 1
        }
        return result
      }
      // 旧投影兜底（无 log）：按任务 createdAt 判断新增，其余按总数展示。
      const addedIds = Array.isArray(changes.added) ? changes.added : []
      result.added = addedIds.filter((id) => {
        const task = prep && prep.taskById ? prep.taskById[id] : null
        return task ? isCreatedAtTime(task, moment) : true
      }).length
      result.removed = Array.isArray(changes.removed) ? changes.removed.length : 0
      result.dependencyChanged = Array.isArray(changes.dependencyChanged) ? changes.dependencyChanged.length : 0
      result.splits = Array.isArray(changes.splits) ? changes.splits.length : 0
      result.visible = result.added + result.removed + result.dependencyChanged + result.splits
      return result
    }

    /** 某任务的变更历史（新增/改依赖/被拆分等），按回放时刻过滤。 */
    function taskChangeEntries(prep, taskId, moment) {
      const changes = prep && prep.changes ? prep.changes : {}
      const log = Array.isArray(changes.log) ? changes.log : []
      const now = finite(moment)
      return log.filter((entry) => {
        const related = entry.taskId === taskId || (Array.isArray(entry.children) && entry.children.indexOf(taskId) >= 0)
        if (!related) return false
        if (now !== null && finite(entry.at) !== null && entry.at > now) return false
        return true
      })
    }

    /** 计划未创建（Ghost）：createdAt > currentTime，仅展示计划信息。 */
    function isPlannedTask(task, moment) {
      return !isCreatedAtTime(task, moment)
    }

    /** NEW 标记是否可见：任务在 changes.added 且回放时刻已跨过 createdAt。 */
    function isNewBadgeVisible(task, moment) {
      return Boolean(task && task.isNew && isCreatedAtTime(task, moment))
    }

    /** 变更条目点击时应选中的任务：拆分优先父任务（不存在时取首个存在的子任务），移除类无目标。 */
    function changeTargetTaskId(entry, taskById) {
      if (!entry || !taskById) return ''
      if (entry.kind === 'split') {
        if (taskById[entry.taskId]) return entry.taskId
        const children = Array.isArray(entry.children) ? entry.children : []
        for (const child of children) if (taskById[child]) return child
        return ''
      }
      if (entry.kind === 'removed') return ''
      return taskById[entry.taskId] ? entry.taskId : ''
    }

    /** 视图准备：容错地把投影视图整理成渲染结构。 */
    function prepareView(rawView) {
      const view = isObject(rawView) ? rawView : {}
      const rawTasks = Array.isArray(view.tasks) ? view.tasks.filter(isObject) : []
      const tasks = rawTasks.map(normalizeTask).sort(compareTasks)
      const taskById = {}
      for (const task of tasks) taskById[task.id] = task

      const changes = isObject(view.changes) ? view.changes : {}
      const added = Array.isArray(changes.added) ? changes.added.map((item) => String(item)) : []
      for (const task of tasks) task.isNew = added.indexOf(task.id) >= 0

      const rawEdges = Array.isArray(view.edges) ? view.edges.filter(isObject) : []
      const edges = rawEdges
        .map((edge) => ({
          from: text(edge.from),
          to: text(edge.to),
          kind: edge.kind === 'blockedBy' || edge.kind === 'relation' ? edge.kind : 'sequence',
        }))
        .filter((edge) => edge.from && edge.to)

      const stats = Object.assign({}, EMPTY_TASK_STATS)
      const rawStats = isObject(view.taskStats) ? view.taskStats : null
      if (rawStats) {
        for (const key of Object.keys(EMPTY_TASK_STATS)) {
          const value = finite(rawStats[key])
          if (value !== null) stats[key] = value
        }
      } else {
        stats.total = tasks.length
        for (const task of tasks) {
          if (stats[task.status] !== undefined) stats[task.status] += 1
          else stats.other += 1
        }
      }

      // 时间范围：投影 timeRange 优先；缺失时从任务/成员/turn/span 时间兜底（防御宿主字段缺失）。
      let timeStart = finite(view.timeRange && view.timeRange.start)
      let timeEnd = finite(view.timeRange && view.timeRange.end)
      if (timeEnd === null) timeEnd = finite(view.asOfTime)
      const allTimes = []
      const consider = (value) => {
        const timestamp = finite(value)
        if (timestamp !== null && timestamp > 0) allTimes.push(timestamp)
      }
      // 「内容活动」时间戳：用于识别「会话收尾记录（session/end-seed）」造成的空转长尾。
      // 真实历史会话的最后事件可能是数小时后的 session/end-seed（无内容），
      // 若直接拿 asOfTime 当回放终点，回放会出现几小时的空转尾巴、墙钟也被放大。
      const activityTimes = []
      const markActivity = (value) => {
        const timestamp = finite(value)
        if (timestamp !== null && timestamp > 0) activityTimes.push(timestamp)
      }
      for (const task of tasks) {
        consider(task.createdAt)
        consider(task.startedAt)
        consider(task.completedAt)
        consider(task.failedAt)
        markActivity(task.createdAt)
        markActivity(task.startedAt)
        markActivity(task.completedAt)
        markActivity(task.failedAt)
      }
      const rawMembers = Array.isArray(view.members) ? view.members.filter(isObject) : []
      const members = rawMembers.map(normalizeMember)
      for (const member of members) {
        consider(member.createdAt)
        markActivity(member.createdAt)
        for (const phase of member.phases) {
          consider(phase.at)
          markActivity(phase.at)
        }
      }
      const rawTurns = Array.isArray(view.turns) ? view.turns.filter(isObject) : []
      const turns = rawTurns.map((turn) => ({
        turn: finite(turn.turn) === null ? 0 : turn.turn,
        start: finite(turn.start),
        end: finite(turn.end),
      }))
      for (const turn of turns) {
        consider(turn.start)
        consider(turn.end)
        markActivity(turn.start)
        markActivity(turn.end)
      }
      const rawSpans = Array.isArray(view.spans) ? view.spans : []
      const spans = []
      for (let index = 0; index < rawSpans.length; index += 1) {
        const span = normalizeSpan(rawSpans[index], index)
        if (span) {
          spans.push(span)
          consider(span.start)
          consider(span.end)
          markActivity(span.start)
          markActivity(span.end)
        }
      }
      for (const milestone of Array.isArray(view.milestones) ? view.milestones : []) {
        if (isObject(milestone)) markActivity(milestone.at)
      }
      for (const subagent of Array.isArray(view.subagents) ? view.subagents : []) {
        if (isObject(subagent)) {
          markActivity(subagent.createdAt)
          markActivity(subagent.at)
        }
      }
      if (timeStart === null) timeStart = allTimes.length > 0 ? Math.min.apply(null, allTimes) : 0
      if (timeEnd === null || timeEnd <= timeStart) {
        const maxTime = allTimes.length > 0 ? Math.max.apply(null, allTimes) : timeStart + 1000
        timeEnd = maxTime > timeStart ? maxTime : timeStart + 1000
      }
      // 活动结束时刻：数据层缺字段时的兜底判定依据（新契约优先 timeRange.end/rawEnd + waits.tailMs）。
      let activityEnd = 0
      for (const timestamp of activityTimes) {
        if (timestamp > activityEnd) activityEnd = timestamp
      }
      const rawEndFromView = finite(view.timeRange && view.timeRange.rawEnd)
      const tailFromView = finite(view.waits && view.waits.tailMs)
      const asOfFromView = finite(view.asOfTime)
      let rawTimeEnd
      let contentEnd
      let tailMs
      if (rawEndFromView !== null) {
        // 新契约：end = 内容终点，rawEnd = 日志末事件时刻（可能含 session/end-seed 尾巴）。
        rawTimeEnd = Math.max(rawEndFromView, timeEnd)
        contentEnd = timeEnd
        tailMs = tailFromView !== null ? Math.max(0, tailFromView) : Math.max(0, rawTimeEnd - contentEnd)
      } else if (tailFromView !== null) {
        rawTimeEnd = asOfFromView !== null ? Math.max(asOfFromView, timeEnd) : timeEnd + tailFromView
        contentEnd = timeEnd
        tailMs = Math.max(0, tailFromView)
      } else {
        // 旧投影（无 rawEnd/tailMs）：用「最后内容活动时刻」推断，剔除 >5min 的空转尾巴。
        rawTimeEnd = asOfFromView !== null ? Math.max(asOfFromView, timeEnd) : timeEnd
        if (activityEnd <= 0 || activityEnd > rawTimeEnd) activityEnd = rawTimeEnd
        const inferredTail = Math.max(0, rawTimeEnd - activityEnd)
        contentEnd = inferredTail > 5 * 60 * 1000 ? activityEnd : rawTimeEnd
        tailMs = Math.max(0, rawTimeEnd - contentEnd)
      }
      timeEnd = contentEnd

      const dataSource = view.dataSource === 'team' || view.dataSource === 'todo' ? view.dataSource : (tasks.length > 0 ? 'todo' : 'none')
      const emptyReason = text(view.emptyReason) || (tasks.length > 0 ? null : 'no-task-board')
      const empty = tasks.length === 0

      const flow = computeFlowLayout(tasks.length)
      const flowDepEdges = []
      const flowRelationEdges = []
      for (const edge of edges) {
        const fromIndex = tasks.findIndex((task) => task.id === edge.from)
        const toIndex = tasks.findIndex((task) => task.id === edge.to)
        if (fromIndex < 0 || toIndex < 0) continue
        if (edge.kind === 'blockedBy') {
          flowDepEdges.push({
            from: edge.from,
            to: edge.to,
            path: buildDependencyPath(flow.positions[fromIndex], flow.positions[toIndex], flow.nodeWidth, flow.nodeHeight),
          })
        } else if (edge.kind === 'relation') {
          const side = flow.positions[toIndex].x >= flow.positions[fromIndex].x ? 'right' : 'left'
          flowRelationEdges.push({
            from: edge.from,
            to: edge.to,
            path: buildRelationPath(flow.positions[fromIndex], flow.positions[toIndex], flow.nodeWidth, flow.nodeHeight, side),
          })
        }
      }

      const waits = isObject(view.waits) ? view.waits : {}
      const usage = isObject(view.usage) ? view.usage : {}
      const counters = isObject(view.counters) ? view.counters : {}
      const warnings = Array.isArray(view.warnings) ? view.warnings.filter(isObject) : []
      const milestones = Array.isArray(view.milestones) ? view.milestones.filter(isObject) : []
      const subagents = Array.isArray(view.subagents) ? view.subagents.filter(isObject) : []
      const plan = normalizePlan(view.plan)
      const relations = normalizeRelations(view.relations, taskById)
      const relation = buildRelationIndex(relations)
      const rawBaseline = isObject(view.baseline) ? view.baseline : null
      const baseline = rawBaseline
        ? {
            taskIds: Array.isArray(rawBaseline.taskIds) ? rawBaseline.taskIds.map((item) => String(item)) : [],
            at: finite(rawBaseline.at) === null ? 0 : rawBaseline.at,
            seq: finite(rawBaseline.seq) === null ? -1 : rawBaseline.seq,
            source: text(rawBaseline.source) || 'first-task',
            closedAt: finite(rawBaseline.closedAt),
            open: rawBaseline.open === true,
          }
        : null
      const normalizedChanges = normalizeChanges(view.changes, baseline)
      const viewLevel = isObject(view.viewLevel) ? view.viewLevel : null
      const spanSummary = isObject(view.spanSummary) ? view.spanSummary : null
      const timeline = computeTimelineLayout({
        tasks,
        members,
        spans,
        milestones,
        start: timeStart,
        end: timeEnd,
        spansTruncated: view.spansTruncated === true,
        spanSummary,
        idleLeadMs: finite(waits.preTurnMs) === null ? 0 : waits.preTurnMs,
      })


      return {
        ok: true,
        schema: text(view.schema) || 'task-map/view',
        stateVersion: finite(view.stateVersion),
        sessionId: text(view.sessionId),
        title: text(view.title) || '未命名会话',
        cwd: text(view.cwd),
        agentPreset: text(view.agentPreset),
        sessionCreatedAt: finite(view.sessionCreatedAt),
        asOfSeq: finite(view.asOfSeq),
        asOfTime: finite(view.asOfTime),
        hasTeamBoard: view.hasTeamBoard === true,
        dataSource,
        emptyReason,
        empty,
        tasks,
        taskById,
        stats,
        edges,
        relations,
        relation,
        plan,
        baseline,
        changes: normalizedChanges,
        members,
        subagents: subagents.map((item) => ({
          childId: text(item.childId),
          label: text(item.label),
          mode: text(item.mode),
          createdAt: finite(item.createdAt),
          at: finite(item.at),
        })),
        turns,
        spans,
        spansTruncated: view.spansTruncated === true,
        spanSummary,
        viewLevel,
        usage: {
          input: finite(usage.input) || 0,
          output: finite(usage.output) || 0,
          cacheRead: finite(usage.cacheRead) || 0,
          cacheWrite: finite(usage.cacheWrite) || 0,
          total: finite(usage.total) || 0,
        },
        counters,
        waits,
        milestones,
        goal: isObject(view.goal) ? view.goal : null,
        endedSeed: isObject(view.endedSeed) ? view.endedSeed : null,
        warnings,
        timeStart,
        timeEnd,
        rawTimeEnd,
        tailMs,
        tailTrimmed: tailMs > 0,
        activityEnd: activityEnd > 0 && activityEnd <= timeEnd ? activityEnd : timeEnd,
        liveMode: Date.now() - (rawTimeEnd || timeEnd) < 60 * 60 * 1000,
        durationMs: timeEnd - timeStart,
        rawDurationMs: Math.max(0, rawTimeEnd - timeStart),
        timeline,
        flow,
        flowDepEdges,
        flowRelationEdges,
        flowRoute: buildFlowPath(flow, tasks.length),
        ownerColors: buildOwnerColorMap(tasks),
      }
    }

    // ------------------------------------------------------------------
    // 回放时钟 store（单一 currentTime；rAF 推进；帧监听器直接更新 DOM）
    // ------------------------------------------------------------------
    function createReplayStore(options) {
      const opts = options || {}
      let rangeStart = finite(opts.start) === null ? 0 : opts.start
      let rangeEnd = finite(opts.end) === null ? rangeStart + 1 : opts.end
      if (rangeEnd <= rangeStart) rangeEnd = rangeStart + 1
      let speed = SPEEDS.indexOf(finite(opts.speed)) >= 0 ? opts.speed : 120
      let playing = false
      let followEnd = true
      let time = rangeEnd
      let rafId = null
      let lastTimestamp = 0
      let lastFrameAt = 0
      let fps = 0
      let frameMs = 0

      const discreteListeners = new Set()
      const frameListeners = new Set()
      const throttled = new Set()

      const scheduleFrame = (callback) => {
        if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback)
        return setTimeout(() => callback(nowMs()), 16)
      }
      const cancelFrame = (identifier) => {
        if (identifier === null || identifier === undefined) return
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(identifier)
        else clearTimeout(identifier)
      }
      const clampTime = (value) => clamp(finite(value) === null ? rangeStart : value, rangeStart, rangeEnd)
      const emitDiscrete = () => {
        for (const listener of Array.from(discreteListeners)) {
          try { listener() } catch (error) { recordError('store.discrete', error) }
        }
      }
      const emitFrame = () => {
        const startedAt = nowMs()
        for (const listener of Array.from(frameListeners)) {
          try { listener(time) } catch (error) { recordError('store.frame', error) }
        }
        for (const entry of Array.from(throttled)) {
          try { entry.listener(time) } catch (error) { recordError('store.throttled', error) }
        }
        const elapsed = nowMs() - startedAt
        frameMs = frameMs > 0 ? frameMs * 0.9 + elapsed * 0.1 : elapsed
      }
      const stopLoop = () => {
        if (rafId !== null) cancelFrame(rafId)
        rafId = null
      }
      const finishPlayback = () => {
        playing = false
        followEnd = true
        stopLoop()
        emitFrame()
        emitDiscrete()
      }
      const tick = (timestamp) => {
        if (!playing) return
        const current = finite(timestamp) === null ? nowMs() : timestamp
        const delta = lastTimestamp > 0 ? Math.max(0, Math.min(1000, current - lastTimestamp)) : 16
        lastTimestamp = current
        if (lastFrameAt > 0) {
          const frameDelta = current - lastFrameAt
          if (frameDelta > 0) fps = fps > 0 ? fps * 0.9 + (1000 / frameDelta) * 0.1 : 1000 / frameDelta
        }
        lastFrameAt = current
        const next = time + delta * speed
        if (next >= rangeEnd) {
          time = rangeEnd
          finishPlayback()
          return
        }
        time = next
        emitFrame()
        rafId = scheduleFrame(tick)
      }

      const api = {
        getTime: () => time,
        getStart: () => rangeStart,
        getEnd: () => rangeEnd,
        getSpeed: () => speed,
        isPlaying: () => playing,
        isAtEnd: () => time >= rangeEnd,
        getFps: () => Math.round(fps),
        getFrameMs: () => Math.round(frameMs * 100) / 100,
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          discreteListeners.add(listener)
          return () => { discreteListeners.delete(listener) }
        },
        onFrame(listener) {
          if (typeof listener !== 'function') return () => {}
          frameListeners.add(listener)
          return () => { frameListeners.delete(listener) }
        },
        onTimeThrottled(listener, minInterval) {
          if (typeof listener !== 'function') return () => {}
          const entry = { listener: null, minMs: Math.max(50, finite(minInterval) || 200), last: 0, timer: null }
          entry.listener = (moment) => {
            if (!playing) {
              entry.last = nowMs()
              listener(moment)
              return
            }
            const elapsed = nowMs() - entry.last
            if (elapsed >= entry.minMs) {
              entry.last = nowMs()
              listener(moment)
              return
            }
            if (entry.timer) return
            entry.timer = setTimeout(() => {
              entry.timer = null
              if (!throttled.has(entry)) return
              entry.last = nowMs()
              try { listener(time) } catch (error) { recordError('store.throttle', error) }
            }, entry.minMs - elapsed)
          }
          throttled.add(entry)
          return () => {
            throttled.delete(entry)
            if (entry.timer) clearTimeout(entry.timer)
          }
        },
        setTime(value) {
          time = clampTime(value)
          followEnd = time >= rangeEnd
          emitFrame()
          return time
        },
        repaint() { emitFrame() },
        step(deltaMs) {
          playing = false
          stopLoop()
          api.setTime(time + (finite(deltaMs) || 0))
          emitDiscrete()
          return time
        },
        play() {
          if (playing) return
          if (time >= rangeEnd) {
            time = rangeStart
            followEnd = false
            emitFrame()
          }
          playing = true
          lastTimestamp = 0
          lastFrameAt = 0
          rafId = scheduleFrame(tick)
          emitDiscrete()
        },
        pause() {
          if (!playing && rafId === null) return
          playing = false
          stopLoop()
          emitDiscrete()
        },
        toggle() {
          if (playing) api.pause()
          else api.play()
        },
        setSpeed(value) {
          const next = finite(value)
          if (next === null) return speed
          if (SPEEDS.indexOf(next) >= 0) speed = next
          emitDiscrete()
          return speed
        },
        /** 投影更新后同步时间范围：跟随最新时刻时自动跟到 end，否则把当前时间夹回范围内。 */
        updateRange(start, end) {
          rangeStart = finite(start) === null ? rangeStart : start
          const nextEnd = finite(end) === null ? rangeEnd : end
          rangeEnd = nextEnd <= rangeStart ? rangeStart + 1 : nextEnd
          time = followEnd ? rangeEnd : clampTime(time)
          emitFrame()
          return time
        },
        dispose() {
          playing = false
          stopLoop()
          frameListeners.clear()
          discreteListeners.clear()
          for (const entry of throttled) {
            if (entry.timer) clearTimeout(entry.timer)
          }
          throttled.clear()
        },
      }
      return api
    }

    // ------------------------------------------------------------------
    // tooltip store（hover 浮层；只重渲染 tooltip 自身）
    // ------------------------------------------------------------------
    function createTooltipStore() {
      let snapshot = { visible: false, x: 0, y: 0, payload: null }
      const listeners = new Set()
      const emit = () => {
        for (const listener of Array.from(listeners)) {
          try { listener() } catch (error) { recordError('tooltip', error) }
        }
      }
      return {
        subscribe(listener) {
          if (typeof listener !== 'function') return () => {}
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        get: () => snapshot,
        show(event, payload) {
          try {
            const hasPoint = event && finite(event.clientX) !== null && finite(event.clientY) !== null
            if (hasPoint) {
              this.showAtPoint(event.clientX, event.clientY, payload)
              return
            }
            // FocusEvent 等没有 clientX/clientY：退回当前元素矩形，绝不落到 (0,0)。
            const target = event && (event.currentTarget || event.target)
            const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null
            if (rect && (rect.width || rect.height || rect.left || rect.top)) {
              this.showAtRect(rect, payload)
              return
            }
            const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1200
            const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800
            this.showAtPoint(Math.round(viewportWidth / 2), Math.round(viewportHeight / 3), payload)
          } catch (error) {
            recordError('tooltip.show', error)
          }
        },
        showAtPoint(x, y, payload) {
          const viewportWidth = (typeof window !== 'undefined' && window.innerWidth) || 1200
          const viewportHeight = (typeof window !== 'undefined' && window.innerHeight) || 800
          snapshot = {
            visible: true,
            x: clamp(finite(x) === null ? viewportWidth / 2 : x, 8, viewportWidth - 8),
            y: clamp(finite(y) === null ? viewportHeight / 3 : y, 8, viewportHeight - 8),
            payload: payload || null,
          }
          emit()
        },
        /** 以元素矩形为锚点：x=矩形水平中心、y=矩形顶部（供 FocusEvent/键盘焦点使用）。 */
        showAtRect(rect, payload) {
          try {
            if (!rect) {
              this.showAtPoint(undefined, undefined, payload)
              return
            }
            const left = finite(rect.left) === null ? 0 : rect.left
            const width = finite(rect.width) === null ? 0 : rect.width
            const top = finite(rect.top) === null ? 0 : rect.top
            this.showAtPoint(left + width / 2, top, payload)
          } catch (error) {
            recordError('tooltip.showAtRect', error)
          }
        },
        hide() {
          if (!snapshot.visible) return
          snapshot = { visible: false, x: 0, y: 0, payload: null }
          emit()
        },
      }
    }

    let instanceSeq = 0
    function useInstanceId(prefix) {
      const ref = React.useRef(null)
      if (!ref.current) {
        instanceSeq += 1
        ref.current = (prefix || 'tm') + '-' + instanceSeq
      }
      return ref.current
    }

    const useLayoutEffect = typeof React.useLayoutEffect === 'function' ? React.useLayoutEffect : React.useEffect

    /**
     * 宿主可视高度（纯函数，便于测试）：H = clientHeight - 顶部偏移 - 根节点下方内容，再 clamp。
     * 通过 DOM 结构直接量出「滚动容器内、根节点上方偏移」与「根节点之后兄弟内容高度（宿主 composer 等）」，
     * 对内容长短/窗口 resize 都成立（旧的 scrollHeight+currentHeight 公式在内容不溢出时会退化为不增长）。
     * clamp 到 [360, viewportHeight - 60]，避免极端窗口下不可用。
     */
    function computeFitHeight(clientHeight, topOffset, belowHeight, viewportHeight) {
      const client = finite(clientHeight) || 0
      const offset = finite(topOffset) || 0
      const below = finite(belowHeight) || 0
      const viewport = finite(viewportHeight) || 0
      let height = client - offset - below
      if (!Number.isFinite(height)) height = 640
      const maxHeight = viewport > 0 ? Math.max(360, viewport - 60) : 1200
      return Math.max(360, Math.min(height, maxHeight))
    }

    /**
     * 宿主高度自适应：DSH 的 conversation.view 容器是 auto 高度的 flex 子项，
     * 百分比/grid 行在 auto 高度下会退化为内容高度，导致面板超出可视区。
     * 这里测量最近滚动容器的「可见剩余高度」并显式设置根节点高度（**不做 probe**，
     * 即不临时改动根节点尺寸，避免子组件按错误尺寸布局）：
     *   H = clientHeight - scrollHeight + root 当前高度（推导见 computeFitHeight 注释），
     *   clamp 到 [360, innerHeight - 60]。
     * SSR/测试（无 DOM）时不动，回退 CSS height:100%。
     */
    function useHostFitHeight(rootRef) {
      const remeasureRef = React.useRef(() => {})
      useLayoutEffect(() => {
        const root = rootRef.current
        if (!root || typeof document === 'undefined' || !document.body) return undefined
        let target = null
        const findTarget = () => {
          let ancestor = root.parentElement
          while (ancestor && ancestor !== document.body) {
            try {
              const style = window.getComputedStyle(ancestor)
              if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && ancestor.clientHeight > 0) return ancestor
            } catch (ignored) { /* noop */ }
            ancestor = ancestor.parentElement
          }
          return null
        }
        target = findTarget()
        // 量出「根节点相对滚动容器的顶部偏移」与「根节点之后兄弟内容高度（composer/footer 等）」。
        const findLayoutContext = () => {
          const element = rootRef.current
          if (!element || !target) return null
          let child = element
          while (child && child.parentElement && child.parentElement !== target) {
            child = child.parentElement
          }
          if (!child || child.parentElement !== target) return null
          const targetRect = target.getBoundingClientRect()
          const childRect = child.getBoundingClientRect()
          const topOffset = Math.max(0, childRect.top - targetRect.top + (target.scrollTop || 0))
          let below = 0
          let sibling = child.nextElementSibling
          while (sibling) {
            try { below += sibling.getBoundingClientRect().height || 0 } catch (ignored) { /* noop */ }
            sibling = sibling.nextElementSibling
          }
          return { topOffset, below }
        }
        const measure = () => {
          try {
            const element = rootRef.current
            if (!element) return
            if (!target || !target.isConnected) target = findTarget()
            element.style.minHeight = '0px'
            const rect = element.getBoundingClientRect()
            let height = 0
            const context = findLayoutContext()
            if (target && context) {
              height = computeFitHeight(target.clientHeight, context.topOffset, context.below, window.innerHeight)
            } else if (target) {
              // 结构兜底：用 scrollHeight + 当前高度（内容溢出时有效）
              height = computeFitHeight(target.clientHeight, 0, Math.max(0, target.scrollHeight - Math.max(0, rect.height)), window.innerHeight)
            } else {
              // 没有滚动容器（如独立预览页）：直接用视口剩余高度。
              const available = Math.max(0, window.innerHeight - Math.max(0, rect.top) - 16)
              height = Math.max(360, Math.min(available, window.innerHeight - 60))
            }
            element.style.height = Math.round(height) + 'px'
            element.setAttribute('data-tm-height', String(Math.round(height)))
          } catch (error) {
            recordError('fitHeight', error)
          }
        }
        measure()
        // 字体/宿主 chrome 可能在首帧后变化（composer 高度、滚动条出现等），补一次延迟测量。
        const settleTimer = setTimeout(() => { try { measure() } catch (ignored) { /* noop */ } }, 400)
        let pending = 0
        let resizeTimer = null
        const schedule = () => {
          if (pending) return
          const raf = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (callback) => setTimeout(callback, 16)
          pending = raf(() => { pending = 0; measure() })
        }
        // 窗口 resize（含大屏/副屏切换）：立即测一次 + 150ms 去抖重测（等宿主布局稳定）。
        const onWindowResize = () => {
          schedule()
          if (resizeTimer) clearTimeout(resizeTimer)
          resizeTimer = setTimeout(() => { resizeTimer = null; schedule() }, 150)
        }
        window.addEventListener('resize', onWindowResize)
        let observer = null
        try {
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(schedule)
            if (target) observer.observe(target)
            if (root.parentElement) observer.observe(root.parentElement)
          }
        } catch (ignored) { /* noop */ }
        remeasureRef.current = () => { schedule() }
        return () => {
          clearTimeout(settleTimer)
          if (resizeTimer) clearTimeout(resizeTimer)
          window.removeEventListener('resize', onWindowResize)
          if (observer) observer.disconnect()
          if (pending && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending)
          remeasureRef.current = () => {}
        }
      }, [rootRef])
      return remeasureRef
    }

    function useDiscrete(store) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (!store) return undefined
        return store.subscribe(() => force((value) => value + 1))
      }, [store])
      return store
    }

    function useThrottledTime(store, minInterval) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        if (!store) return undefined
        return store.onTimeThrottled(() => force((value) => value + 1), minInterval || 200)
      }, [store, minInterval])
      return store
    }

    // ------------------------------------------------------------------
    // 样式（注入 <style id="task-map-m2-style">；与宿主同 document；tm- 前缀）
    // ------------------------------------------------------------------
    function styleText() {
      return [
        '.tm-root{height:100%;min-height:360px;display:flex;flex-direction:column;overflow:hidden;',
        '  --tm-text:var(--dsw-alias-label-primary,#e6edf8);',
        '  --tm-dim:var(--dsw-alias-label-secondary,#8fa3c0);',
        '  --tm-dim2:var(--dsw-alias-label-tertiary,#6b7f9e);',
        '  --tm-caption:var(--dsw-alias-label-caption,#6b7f9e);',
        '  --tm-bg:var(--dsw-alias-bg-layer-1,#101a2e);',
        '  --tm-bg2:var(--dsw-alias-bg-layer-2,#13203a);',
        '  --tm-bg3:var(--dsw-alias-bg-layer-3,#182643);',
        '  --tm-line:var(--dsw-alias-border-l1,#1e2c48);',
        '  --tm-line2:var(--dsw-alias-border-l2,#2a3c5f);',
        '  --tm-accent:var(--dsw-alias-link,#4d9fff);',
        '  --tm-route:var(--dsw-alias-state-warn-primary,#f59e0b);',
        '  --tm-done:var(--dsw-alias-state-success-primary,#34d399);',
        '  --tm-run:var(--dsw-alias-state-warn-primary,#fbbf24);',
        '  --tm-fail:var(--dsw-alias-state-error-primary,#f87171);',
        '  --tm-pend:var(--dsw-alias-state-idle-primary,#94a3b8);',
        '  --tm-blocked:#fb7185;',
        '  --tm-rel:#a78bfa;',
        '  color:var(--tm-text);background:transparent;font-size:12.5px;line-height:1.45;',
        '  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}',
        '.tm-root *{box-sizing:border-box}',
        '.tm-root button,.tm-root select,.tm-root input{font-family:inherit;color:inherit}',
        /* ---------- 顶栏 ---------- */
        '.tm-top{flex:none;display:flex;align-items:center;gap:14px;padding:8px 14px;border-bottom:1px solid var(--tm-line);flex-wrap:wrap}',
        '.tm-sess{flex:1;min-width:180px;overflow:hidden}',
        '.tm-sess-title{font-size:13.5px;font-weight:650;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.tm-sess-sub{font-size:10.5px;color:var(--tm-dim2);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.tm-sess-sub code{background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:4px;padding:0 4px;font-size:10px}',
        '.tm-chips{display:flex;align-items:center;gap:6px;flex-wrap:wrap;flex:none}',
        '.tm-chip{display:inline-flex;align-items:center;gap:4px;border-radius:999px;padding:2px 8px;font-size:10.5px;',
        '  background:var(--tm-bg2);border:1px solid var(--tm-line);color:var(--tm-dim);white-space:nowrap}',
        '.tm-chip b{font-weight:700;color:var(--tm-text);font-variant-numeric:tabular-nums}',
        '.tm-chip.tm-done{color:var(--tm-done);border-color:color-mix(in srgb,var(--tm-done) 32%,transparent)}',
        '.tm-chip.tm-running{color:var(--tm-run);border-color:color-mix(in srgb,var(--tm-run) 32%,transparent)}',
        '.tm-chip.tm-fail{color:var(--tm-fail);border-color:color-mix(in srgb,var(--tm-fail) 32%,transparent)}',
        '.tm-chip.tm-todo{color:var(--tm-route);border-style:dashed}',
        '.tm-replay{display:flex;align-items:center;gap:7px;flex:none}',
        '.tm-btn{background:var(--tm-bg2);border:1px solid var(--tm-line2);border-radius:8px;height:28px;min-width:28px;',
        '  padding:0 9px;cursor:pointer;color:var(--tm-text);font-size:12px;display:inline-flex;align-items:center;justify-content:center;gap:5px;transition:background .15s,border-color .15s}',
        '.tm-btn:hover{background:var(--tm-bg3);border-color:var(--tm-dim2)}',
        '.tm-btn:disabled{opacity:.45;cursor:default}',
        '.tm-btn.tm-primary{background:var(--tm-route);border-color:var(--tm-route);color:#20150a;font-weight:700;min-width:64px}',
        '.tm-btn.tm-primary:hover{filter:brightness(1.08)}',
        '.tm-select{background:var(--tm-bg2);border:1px solid var(--tm-line2);border-radius:8px;height:28px;padding:0 6px;font-size:11.5px;cursor:pointer}',
        '.tm-clock{font-variant-numeric:tabular-nums;font-size:11.5px;background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:7px;padding:5px 8px;min-width:150px;text-align:center;white-space:nowrap}',
        '.tm-clock .tm-clock-label{font-size:9.5px;color:var(--tm-dim2);margin-right:4px}',
        '.tm-clock b{color:var(--tm-route);font-weight:700}',
        '.tm-clock .tm-sep{color:var(--tm-dim2);margin:0 3px}',
        '.tm-progress{width:120px;height:20px;display:flex;align-items:center;flex:none}',
        '.tm-progress input{width:100%;accent-color:var(--tm-route);cursor:pointer}',
        /* ---------- 主布局 ---------- */
        '.tm-main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 336px;',
        '  grid-template-rows:minmax(220px,var(--tm-flow-share,40%)) minmax(0,1fr);gap:10px;padding:10px 12px 4px}',
        '.tm-main.tm-layout-flow{grid-template-rows:minmax(0,1fr) auto}',
        '.tm-main.tm-layout-gantt{grid-template-rows:auto minmax(0,1fr)}',
        // 单图（flow）模式：顶部对齐 + 不滚动（绝不裁掉顶部）；SVG 超高度时 max-height 内部 letterbox 保证完整可见。
        '.tm-layout-flow .tm-map-scroll{display:block;overflow:hidden}',
        '.tm-layout-flow .tm-flow-svg{display:block;width:100%;height:auto;max-height:100%}',
        '.tm-layout-flow .tm-map .tm-panel-head{padding-bottom:10px}',
        '.tm-panel[data-tm-panel-collapsed="true"]{flex:none}',
        '.tm-panel[data-tm-panel-collapsed="true"]{min-height:0}',
        '.tm-panel[data-tm-panel-collapsed="true"] .tm-map-scroll,',
        '.tm-panel[data-tm-panel-collapsed="true"] .tm-map-foot,',
        '.tm-panel[data-tm-panel-collapsed="true"] > .tm-tl-scroll{display:none}',
        '.tm-panel[data-tm-panel-collapsed="true"] .tm-panel-head{border-bottom:0}',
        '.tm-panel{background:var(--tm-bg);border:1px solid var(--tm-line);border-radius:12px;min-height:0;display:flex;flex-direction:column;overflow:hidden}',
        '.tm-panel-head{flex:none;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 12px;border-bottom:1px solid var(--tm-line)}',
        '.tm-panel-title{font-size:12px;font-weight:700;letter-spacing:.04em;color:var(--tm-text);margin:0;white-space:nowrap}',
        '.tm-panel-head-right{display:flex;align-items:center;gap:12px;min-width:0}',
        '.tm-hint{font-size:10.5px;color:var(--tm-dim2);white-space:nowrap}',
        '.tm-toggle{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:var(--tm-dim);cursor:pointer;user-select:none;white-space:nowrap}',
        '.tm-toggle input{accent-color:var(--tm-route);width:11px;height:11px}',
        '.tm-map{grid-column:1;grid-row:1}',
        '.tm-timeline{grid-column:1;grid-row:2}',
        '.tm-side{grid-column:2;grid-row:1/span 2;overflow:auto}',
        '.tm-map-scroll{flex:1;min-height:0;overflow:auto;padding:2px 6px}',
        '.tm-map-scroll.tm-flow-fit{overflow:hidden;display:flex;align-items:center;justify-content:center}',
        '.tm-map-scroll.tm-flow-fit .tm-flow-svg{width:100%;height:100%;}',
        '.tm-flow-svg{display:block;width:100%;height:auto;min-height:110px}',
        '.tm-map-foot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 12px 7px;border-top:1px solid var(--tm-line)}',
        '.tm-legend{display:flex;align-items:center;gap:11px;flex-wrap:wrap;font-size:10px;color:var(--tm-dim);pointer-events:none;min-width:0}',
        '.tm-legend span{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}',
        '.tm-legend i{display:inline-block;width:8px;height:8px;border-radius:50%}',
        '.tm-legend .tm-legend-line i{width:14px;height:0;border-top:2px dashed var(--tm-dim2);border-radius:0}',
        '.tm-legend .tm-legend-route i{border-top:2px solid var(--tm-route)}',
        /* ---------- 流程图 ---------- */
        '.tm-node{cursor:pointer}',
        '.tm-node .tm-node-box{fill:var(--tm-bg2);stroke:var(--tm-line2);stroke-width:1.2;transition:fill .15s,stroke .15s}',
        '.tm-node:hover .tm-node-box{stroke:var(--tm-accent);fill:var(--tm-bg3)}',
        '.tm-node.tm-sel .tm-node-box{stroke:var(--tm-route);stroke-width:2}',
        '.tm-node.tm-future{opacity:.42}',
        '.tm-node.tm-running .tm-node-box{stroke:var(--tm-run);stroke-width:1.8}',
        '.tm-node.tm-done .tm-node-box{stroke:color-mix(in srgb,var(--tm-done) 72%,transparent)}',
        '.tm-node.tm-failed .tm-node-box{stroke:var(--tm-fail);stroke-width:1.8}',
        '.tm-node.tm-blocked .tm-node-box{stroke:var(--tm-blocked);stroke-width:1.6}',
        '.tm-node .tm-node-rank{font-size:10px;font-weight:700;fill:#0b1220;pointer-events:none}',
        '.tm-node .tm-node-id{font-size:9.5px;fill:var(--tm-dim);letter-spacing:.06em;pointer-events:none}',
        '.tm-node .tm-node-subject{font-size:11.5px;font-weight:600;fill:var(--tm-text);pointer-events:none}',
        '.tm-node .tm-node-owner{font-size:9.5px;fill:var(--tm-dim);pointer-events:none}',
        '.tm-node .tm-node-meta{font-size:9.5px;fill:var(--tm-dim2);font-variant-numeric:tabular-nums;pointer-events:none}',
        '.tm-node .tm-node-status{font-size:9px;font-weight:700;pointer-events:none}',
        '.tm-node .tm-node-pulse{fill:var(--tm-run);opacity:0;pointer-events:none}',
        '.tm-node.tm-running .tm-node-pulse{opacity:1;animation:tm-pulse 1.1s ease-in-out infinite}',
        '@keyframes tm-pulse{0%,100%{opacity:.3;r:2.6}50%{opacity:1;r:4.6}}',
        '.tm-node .tm-node-new-bg{fill:var(--tm-bg);stroke:var(--tm-route);stroke-width:.8}',
        '.tm-node .tm-node-new-text{font-size:8px;font-weight:700;fill:var(--tm-route);pointer-events:none}',
        '.tm-edge-dep{fill:none;stroke:var(--tm-dim2);stroke-width:1.15;stroke-dasharray:3 4;opacity:.62}',
        '.tm-edge-dep.tm-ready{stroke:var(--tm-route);opacity:.9;stroke-dasharray:none;stroke-width:1.5}',
        '.tm-edge-hidden{display:none}',
        '.tm-edge-rel{fill:none;stroke:var(--tm-rel);stroke-width:1.4;stroke-dasharray:5 3;opacity:.85}',
        '.tm-route-base{fill:none;stroke:var(--tm-line2);stroke-width:1.6;stroke-dasharray:2 6;stroke-linecap:round;opacity:.55}',
        '.tm-route{fill:none;stroke:var(--tm-route);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;opacity:.9}',
        '.tm-trail-head{fill:var(--tm-route)}',
        /* ---------- 甘特 ---------- */
        '.tm-tl-scroll{flex:1;min-height:0;overflow:auto;padding:0 4px 4px}',
        '.tm-tl-svg{display:block;width:100%;height:auto}',
        '.tm-tl-grid{stroke:var(--tm-line);stroke-width:1}',
        '.tm-tl-tick{fill:var(--tm-dim2);font-size:9.5px;font-variant-numeric:tabular-nums}',
        '.tm-tl-group{fill:var(--tm-dim);font-size:9.5px;font-weight:700;letter-spacing:.08em}',
        '.tm-tl-label{fill:var(--tm-dim);font-size:10.5px}',
        '.tm-tl-label.tm-dim{fill:var(--tm-dim2)}',
        '.tm-tl-rowbg{fill:transparent}',
        '.tm-tl-rowbg:hover{fill:var(--tm-bg2)}',
        '.tm-tl-wait{fill:color-mix(in srgb,var(--tm-pend) 14%,transparent);stroke:var(--tm-line2);stroke-width:.8;stroke-dasharray:2 3}',
        '.tm-tl-bar{cursor:pointer}',
        '.tm-tl-bar:hover{filter:brightness(1.18)}',
        '.tm-tl-bar.tm-sel{stroke:var(--tm-text);stroke-width:1.3}',
        '.tm-tl-done{fill:var(--tm-bg);stroke:var(--tm-done);stroke-width:1.2}',
        '.tm-tl-mem{opacity:.85}',
        '.tm-tl-ev{cursor:pointer}',
        '.tm-tl-density{fill:color-mix(in srgb,var(--tm-dim2) 55%,transparent)}',
        '.tm-tl-density.tm-hot{fill:color-mix(in srgb,var(--tm-dim) 85%,transparent)}',
        '.tm-tl-playhead{stroke:#ffd48a;stroke-width:1.5;pointer-events:none}',
        '.tm-tl-playhead-cap{fill:#ffd48a;pointer-events:none}',
        '.tm-tl-played{fill:color-mix(in srgb,var(--tm-route) 6%,transparent);pointer-events:none}',
        '.tm-tl-idle{fill:color-mix(in srgb,var(--tm-pend) 7%,transparent);stroke:var(--tm-line2);stroke-width:.8;stroke-dasharray:4 4;pointer-events:none}',
        '.tm-tl-idle-label{fill:var(--tm-dim2);font-size:9.5px;pointer-events:none}',
        /* ---------- 侧栏 / 详情 / 总览 ---------- */
        '.tm-side-inner{padding:11px 12px 14px;display:flex;flex-direction:column;gap:11px;min-height:100%}',
        '.tm-side-head{display:flex;align-items:center;justify-content:space-between;gap:8px}',
        '.tm-sec-title{font-size:9.5px;font-weight:700;letter-spacing:.12em;color:var(--tm-dim2);text-transform:uppercase;margin:2px 0 0}',
        '.tm-title-h3{font-size:13px;font-weight:700;line-height:1.35;margin:0;word-break:break-word}',
        '.tm-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:1px 8px;font-size:10px;font-weight:600;border:1px solid var(--tm-line2);color:var(--tm-dim);white-space:nowrap}',
        '.tm-pill.tm-done{color:var(--tm-done);border-color:color-mix(in srgb,var(--tm-done) 34%,transparent);background:color-mix(in srgb,var(--tm-done) 10%,transparent)}',
        '.tm-pill.tm-running{color:var(--tm-run);border-color:color-mix(in srgb,var(--tm-run) 34%,transparent);background:color-mix(in srgb,var(--tm-run) 10%,transparent)}',
        '.tm-pill.tm-fail{color:var(--tm-fail);border-color:color-mix(in srgb,var(--tm-fail) 34%,transparent);background:color-mix(in srgb,var(--tm-fail) 10%,transparent)}',
        '.tm-pill.tm-blocked{color:var(--tm-blocked);border-color:color-mix(in srgb,var(--tm-blocked) 34%,transparent);background:color-mix(in srgb,var(--tm-blocked) 10%,transparent)}',
        '.tm-pill i{display:inline-block;width:7px;height:7px;border-radius:50%}',
        '.tm-kv{display:grid;grid-template-columns:1fr 1fr;gap:8px}',
        '.tm-kv-card{background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:9px;padding:7px 9px;min-width:0}',
        '.tm-kv-k{font-size:9.5px;color:var(--tm-dim2);letter-spacing:.04em;margin-bottom:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.tm-kv-v{font-size:13.5px;font-weight:700;color:var(--tm-text);font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.tm-kv-v small{font-size:10px;color:var(--tm-dim);font-weight:500}',
        '.tm-rows{display:flex;flex-direction:column;gap:4px}',
        '.tm-row{display:flex;align-items:center;gap:8px;font-size:11px;min-width:0}',
        '.tm-row .tm-rl{flex:1;color:var(--tm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}',
        '.tm-row .tm-rv{color:var(--tm-dim);font-variant-numeric:tabular-nums;font-size:10.5px;white-space:nowrap;flex:none}',
        '.tm-chipsline{display:flex;flex-wrap:wrap;gap:5px}',
        '.tm-chipbtn{background:var(--tm-bg2);border:1px solid var(--tm-line2);border-radius:7px;padding:3px 7px;font-size:10.5px;color:var(--tm-text);cursor:pointer;transition:border-color .15s}',
        '.tm-pill.tm-future{color:var(--tm-dim2);border-style:dashed}',
        '.tm-visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
        '.tm-plan-section{margin-top:9px}',
        '.tm-plan-section .tm-sec-title{text-transform:none;letter-spacing:.03em;font-size:10px}',
        '.tm-plan-list{display:flex;flex-direction:column;gap:3px;margin-top:5px;max-height:190px;overflow:auto}',
        '.tm-plan-item{display:flex;align-items:center;gap:6px;font-size:10.5px;color:var(--tm-dim);padding:1px 0}',
        '.tm-plan-item .tm-plan-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text);opacity:.86}',
        '.tm-plan-item .tm-plan-time{flex:none;font-size:9.5px;color:var(--tm-dim2);font-variant-numeric:tabular-nums}',
        '.tm-plan-item .tm-plan-icon{flex:none;width:12px;text-align:center;font-weight:700}',
        '.tm-plan-item.tm-plan-completed .tm-plan-icon{color:var(--tm-done)}',
        '.tm-plan-item.tm-plan-in_progress .tm-plan-icon{color:var(--tm-run)}',
        '.tm-plan-item.tm-plan-pending .tm-plan-icon{color:var(--tm-pend)}',
        '.tm-plan-section .tm-sec-title .tm-plan-write{color:var(--tm-dim2);font-weight:400;font-size:9.5px;margin-left:6px}',
        '.tm-relation-children{display:flex;flex-direction:column;gap:4px;margin-top:4px}',
        '.tm-relation-child{display:flex;align-items:center;gap:6px;width:100%;background:var(--tm-bg2);border:1px solid var(--tm-line2);border-radius:7px;padding:4px 7px;cursor:pointer;text-align:left;font-size:10.5px;color:var(--tm-text);transition:border-color .15s}',
        '.tm-relation-child:hover{border-color:var(--tm-rel)}',
        '.tm-relation-child .tm-rc-id{color:var(--tm-rel);font-weight:600;flex:none}',
        '.tm-relation-child .tm-rc-subject{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-text)}',
        '.tm-relation-child .tm-rc-owner{color:var(--tm-dim);flex:none;font-size:9.5px}',
        '.tm-changes{display:flex;flex-direction:column;gap:2px;margin-top:5px;max-height:190px;overflow:auto}',
        '.tm-change{display:flex;align-items:center;gap:6px;width:100%;background:transparent;border:0;border-radius:6px;padding:3px 5px;cursor:pointer;text-align:left;font-size:10.5px;color:var(--tm-text);transition:background .15s}',
        '.tm-change:hover{background:var(--tm-bg2)}',
        '.tm-change-time{color:var(--tm-route);font-variant-numeric:tabular-nums;flex:none;width:46px}',
        '.tm-change-kind{flex:none;border-radius:4px;padding:0 4px;font-size:9px;border:1px solid var(--tm-line2);color:var(--tm-dim)}',
        '.tm-change-kind.tm-kind-added{color:var(--tm-done);border-color:color-mix(in srgb,var(--tm-done) 40%,transparent)}',
        '.tm-change-kind.tm-kind-removed{color:var(--tm-fail);border-color:color-mix(in srgb,var(--tm-fail) 40%,transparent)}',
        '.tm-change-kind.tm-kind-dependency{color:var(--tm-run);border-color:color-mix(in srgb,var(--tm-run) 40%,transparent)}',
        '.tm-change-kind.tm-kind-split{color:var(--tm-rel);border-color:color-mix(in srgb,var(--tm-rel) 45%,transparent)}',
        '.tm-change-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--tm-dim)}',
        '.tm-node .tm-node-childof{fill:var(--tm-rel);font-size:8.5px;pointer-events:none}',
        '.tm-node .tm-node-relbadge-bg{fill:var(--tm-bg);stroke:var(--tm-rel);stroke-width:.8;opacity:.95}',
        '.tm-node .tm-node-relbadge-text{fill:var(--tm-rel);font-size:8px;font-weight:700;pointer-events:none}',
        '.tm-node.tm-child-hl .tm-node-box{stroke:var(--tm-rel);stroke-width:2;stroke-dasharray:7 3}',
        '.tm-tl-taskrow.tm-child-hl .tm-tl-rowbg{fill:color-mix(in srgb,var(--tm-rel) 12%,transparent)}',
        '.tm-tl-taskrow.tm-child-hl .tm-tl-label{fill:var(--tm-rel)}',
        '.tm-node[data-tm-planned="true"] .tm-node-box{stroke-dasharray:5 4}',
        '.tm-node[data-tm-planned="true"] .tm-node-new-bg{display:none}',
        '.tm-tl-taskrow[data-tm-planned="true"] .tm-tl-label{opacity:.62;font-style:italic}',

        '.tm-phase{display:flex;align-items:center;gap:7px;font-size:11px;padding:3px 0;border-bottom:1px dashed var(--tm-line)}',
        '.tm-phase:last-child{border-bottom:0}',
        '.tm-phase .tm-pdot{width:7px;height:7px;border-radius:2px;flex:none}',
        '.tm-phase .tm-pn{width:64px;flex:none;color:var(--tm-text)}',
        '.tm-phase .tm-pd{flex:1;text-align:right;color:var(--tm-dim);font-variant-numeric:tabular-nums;font-size:10.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.tm-act{display:flex;gap:7px;align-items:center;padding:4px 5px;border-radius:6px;cursor:pointer}',
        '.tm-act:hover{background:var(--tm-bg2)}',
        '.tm-act .tm-ic{width:18px;height:18px;border-radius:5px;background:var(--tm-bg2);display:flex;align-items:center;justify-content:center;font-size:10px;flex:none;color:var(--tm-dim)}',
        '.tm-act .tm-al{flex:1;min-width:0}',
        '.tm-act .tm-an{font-size:10.5px;color:var(--tm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.tm-act .tm-at{font-size:9.5px;color:var(--tm-dim2);font-variant-numeric:tabular-nums}',
        '.tm-act .tm-ad{font-size:9.5px;color:var(--tm-dim);white-space:nowrap;flex:none}',
        '.tm-desc{font-size:11px;color:var(--tm-dim);line-height:1.6;max-height:120px;overflow:auto;word-break:break-word}',

        '.tm-chipbtn:hover{border-color:var(--tm-route);color:var(--tm-route)}',
        '.tm-chipbtn.tm-dep-off{border-style:dashed;color:var(--tm-dim2)}',
        '.tm-progressbar{height:5px;background:var(--tm-bg3);border-radius:3px;overflow:hidden;flex:none}',
        '.tm-progressbar i{display:block;height:100%;background:linear-gradient(90deg,var(--tm-done),var(--tm-accent));border-radius:3px}',
        '.tm-btnrow{display:flex;gap:7px}',
        '.tm-btnrow .tm-btn{flex:1;height:26px;font-size:11px}',
        '.tm-footnote{font-size:9.5px;color:var(--tm-dim2);line-height:1.5;border-top:1px dashed var(--tm-line);padding-top:7px}',
        '.tm-wcard{background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:10px;padding:9px 10px}',
        '.tm-wcard-t{font-size:9.5px;color:var(--tm-dim2);letter-spacing:.05em;margin-bottom:4px}',
        '.tm-wcard-v{font-size:18px;font-weight:800;color:var(--tm-text);font-variant-numeric:tabular-nums;line-height:1.2}',
        '.tm-wcard-v small{font-size:10.5px;color:var(--tm-dim);font-weight:500}',
        '.tm-live-line{margin-top:6px;font-size:10.5px;color:var(--tm-dim);min-height:15px}',
        '.tm-live-line b{color:var(--tm-route);font-weight:600}',
        '.tm-bar-track{display:flex;align-items:stretch;height:5px;background:var(--tm-bg3);border-radius:3px;overflow:hidden;flex:none;width:56px}',
        '.tm-bar-fill{display:block;height:100%;background:linear-gradient(90deg,var(--tm-route),#f97316);border-radius:3px}',
        '.tm-bar-fill.tm-blue{background:linear-gradient(90deg,#38bdf8,#22d3ee)}',
        '.tm-bar-fill.tm-rose{background:linear-gradient(90deg,#f472b6,#fb7185)}',
        '.tm-bar-fill.tm-slate{background:linear-gradient(90deg,var(--tm-dim2),var(--tm-pend))}',
        '.tm-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:40px 24px;text-align:center;flex:1;min-height:0;overflow:auto}',
        '.tm-empty-icon{width:44px;height:44px;border-radius:12px;background:var(--tm-bg2);border:1px solid var(--tm-line2);display:flex;align-items:center;justify-content:center;color:var(--tm-dim);font-size:20px}',
        '.tm-empty-title{font-size:14px;font-weight:700;margin:0}',
        '.tm-empty-sub{font-size:11.5px;color:var(--tm-dim);max-width:520px;line-height:1.6}',
        '.tm-empty-actions{display:flex;flex-direction:column;gap:5px;text-align:left;font-size:11px;color:var(--tm-dim);background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:10px;padding:10px 14px;max-width:520px;line-height:1.6}',
        '.tm-empty-actions code{background:var(--tm-bg3);border:1px solid var(--tm-line);border-radius:4px;padding:0 4px;font-size:10.5px}',
        '.tm-empty-meta{font-size:10.5px;color:var(--tm-dim2);max-width:520px;line-height:1.6}',
        '.tm-error{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:36px 24px;text-align:center;min-height:0;overflow:auto}',
        '.tm-error-title{font-size:13.5px;font-weight:700;color:var(--tm-fail);margin:0}',
        '.tm-error-sub{font-size:11.5px;color:var(--tm-dim);max-width:520px;line-height:1.6;word-break:break-word}',
        '.tm-error-detail{font-size:10px;color:var(--tm-dim2);max-width:560px;background:var(--tm-bg2);border:1px solid var(--tm-line);border-radius:8px;padding:8px 10px;text-align:left;word-break:break-all;max-height:120px;overflow:auto;font-family:ui-monospace,Menlo,monospace}',
        '.tm-placeholder{flex:1;min-height:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;padding:20px;text-align:center;color:var(--tm-dim2);font-size:11px;overflow:auto}',
        '.tm-placeholder-title{font-size:12px;font-weight:600;color:var(--tm-dim)}',
        '.tm-placeholder-sub{max-width:560px;line-height:1.6}',
        '.tm-note{font-size:10.5px;color:var(--tm-route);background:color-mix(in srgb,var(--tm-route) 9%,transparent);border:1px solid color-mix(in srgb,var(--tm-route) 28%,transparent);border-radius:7px;padding:5px 8px;line-height:1.5}',
        '.tm-tooltip{position:fixed;z-index:50;max-width:330px;background:var(--tm-bg2,#0b1526);border:1px solid var(--tm-line2);border-radius:9px;padding:7px 10px;font-size:11px;color:var(--tm-text);box-shadow:0 12px 30px rgba(0,0,0,.35);pointer-events:none;line-height:1.5}',
        '.tm-tooltip .tm-tt-h{font-weight:700;color:var(--tm-text);margin-bottom:2px;font-size:11.5px;word-break:break-word}',
        '.tm-tooltip .tm-tt-r{color:var(--tm-dim);font-size:10.5px}',
        '.tm-tooltip b{color:var(--tm-route);font-weight:600}',
        '.tm-tooltip .tm-tt-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:4px}',
        /* ---------- 全局页（P1 占位） ---------- */
        '.tm-page{height:100%;overflow:auto;padding:26px 30px;color:var(--tm-text);font-size:13px;background:transparent}',
        '.tm-card{max-width:760px;background:var(--tm-bg);border:1px solid var(--tm-line);border-radius:14px;padding:16px 18px;margin-bottom:12px}',
        '.tm-card-title{font-size:17px;font-weight:700;margin:0 0 4px}',
        '.tm-card-sub{color:var(--tm-dim);font-size:11.5px;line-height:1.65;margin-bottom:10px}',
        '.tm-card-row{display:flex;gap:10px;align-items:baseline;padding:6px 0;border-bottom:1px dashed var(--tm-line);font-size:12px}',
        '.tm-card-row:last-child{border-bottom:0}',
        '.tm-card-k{width:150px;color:var(--tm-dim);font-size:11px;flex:none}',
        '.tm-card-v{flex:1;word-break:break-word;font-size:11.5px}',
        /* ---------- 无障碍：键盘焦点 / reduced-motion ---------- */
        '.tm-root :focus-visible{outline:2px solid var(--tm-route);outline-offset:2px;border-radius:5px}',
        '.tm-node:focus-visible{outline:none}',
        '.tm-node:focus-visible .tm-node-box{stroke:var(--tm-accent);stroke-width:2.4}',
        '.tm-tl-bar:focus-visible{outline:none;stroke:var(--tm-route);stroke-width:2.4}',
        '.tm-change:focus-visible{outline-offset:1px}',
        '@media (prefers-reduced-motion: reduce){',
        '  .tm-root *{transition:none!important;animation:none!important}',
        '  .tm-node .tm-node-pulse{display:none}',
        '}',
        /* ---------- 响应式 ---------- */
        '@media (max-width:1080px){.tm-main{grid-template-columns:minmax(0,1fr) 300px}}',
        '@media (max-width:900px){',
        '  .tm-main{grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(210px,40%) minmax(190px,30%) minmax(180px,1fr);overflow:auto}',
        '  .tm-main.tm-layout-flow{grid-template-rows:minmax(0,1fr) auto minmax(180px,30%)}',
        '  .tm-main.tm-layout-gantt{grid-template-rows:auto minmax(0,1fr) minmax(180px,30%)}',
        '  .tm-side{grid-column:1;grid-row:3;max-height:none}',
        '  .tm-top{gap:8px}',
        '  .tm-progress{display:none}',
        '}',
      ].join('\n')
    }

    function injectStyle() {
      try {
        if (typeof document === 'undefined') return
        let element = document.getElementById(STYLE_ID)
        if (!element) {
          element = document.createElement('style')
          element.id = STYLE_ID
          // 供 client-modules 在禁用/卸载插件时按 data-plugin 清理样式（removeOwnedStyles）。
          element.setAttribute('data-plugin', PLUGIN_ID)
          element.textContent = styleText()
          if (document.head && document.head.append) document.head.append(element)
          else if (document.head && document.head.appendChild) document.head.appendChild(element)
          return
        }
        try { element.setAttribute('data-plugin', PLUGIN_ID) } catch (ignored) { /* noop */ }
        const next = styleText()
        if (element.textContent !== next) element.textContent = next
      } catch (error) {
        recordError('style', error)
      }
    }

    // ------------------------------------------------------------------
    // 顶栏小部件
    // ------------------------------------------------------------------
    function PanelHead(props) {
      return h('div', { className: 'tm-panel-head' },
        h('h2', { className: 'tm-panel-title' }, props.title || ''),
        h('div', { className: 'tm-panel-head-right' }, props.children || null))
    }

    const LAYOUT_ACTION_LABEL = {
      'maximize-flow': { text: '⤢ 放大流程图', aria: '放大流程图（单图模式）' },
      'maximize-gantt': { text: '⤢ 放大甘特图', aria: '放大甘特图（单图模式）' },
      'restore-both': { text: '⇲ 恢复双栏', aria: '恢复双栏布局' },
    }

    function layoutActionToMode(action) {
      if (action === 'maximize-flow') return 'flow'
      if (action === 'maximize-gantt') return 'gantt'
      return 'both'
    }

    function LayoutModeButton(props) {
      const action = props.action || 'restore-both'
      const meta = LAYOUT_ACTION_LABEL[action] || LAYOUT_ACTION_LABEL['restore-both']
      return h('button', {
        className: 'tm-btn tm-layout-btn',
        type: 'button',
        'data-tm-panel-action': action,
        'aria-label': meta.aria,
        'aria-pressed': action === 'restore-both' ? 'true' : 'false',
        onClick: (event) => {
          try {
            if (event && typeof event.stopPropagation === 'function') event.stopPropagation()
            if (typeof props.onAction === 'function') props.onAction(action)
          } catch (error) { recordError('layoutAction', error) }
        },
        onKeyDown: (event) => {
          const key = event && event.key
          const code = event && event.code
          if (key === 'Enter' || key === ' ' || code === 'Space' || code === 'Enter') {
            try {
              if (typeof event.preventDefault === 'function') event.preventDefault()
              if (typeof event.stopPropagation === 'function') event.stopPropagation()
              if (typeof props.onAction === 'function') props.onAction(action)
            } catch (error) { recordError('layoutAction.key', error) }
          }
        },
      }, meta.text)
    }

    function StatChips(props) {
      const prep = props.prep
      const store = useThrottledTime(props.store, 150)
      const moment = store ? store.getTime() : prep.timeEnd
      const counts = countsAtTime(prep.tasks, moment)
      const waiting = counts.pending + counts.blocked
      const chips = [
        h('span', { className: 'tm-chip', key: 'total' }, '任务 ', h('b', { 'data-tm-stat': 'total' }, String(counts.total))),
        h('span', { className: 'tm-chip tm-done', key: 'done' }, '完成 ', h('b', { 'data-tm-stat': 'completed' }, String(counts.completed))),
        h('span', { className: 'tm-chip tm-running', key: 'run' }, '进行中 ', h('b', { 'data-tm-stat': 'in_progress' }, String(counts.in_progress))),
        h('span', { className: 'tm-chip', key: 'wait' }, '等待 ', h('b', { 'data-tm-stat': 'waiting' }, String(waiting))),
      ]
      if (counts.failed > 0) {
        chips.push(h('span', { className: 'tm-chip tm-fail', key: 'failed' }, '失败 ', h('b', { 'data-tm-stat': 'failed' }, String(counts.failed))))
      }
      if (prep.dataSource === 'todo') {
        chips.push(h('span', { className: 'tm-chip tm-todo', key: 'src' }, '来自 todo 清单'))
      }
      if (prep.warnings.length > 0) {
        chips.push(h('span', {
          className: 'tm-chip tm-fail',
          key: 'warnings',
        }, '数据缺失 ', h('b', { 'data-tm-warnings': String(prep.warnings.length) }, String(prep.warnings.length))))
      }
      return h('div', { className: 'tm-chips', 'aria-label': '任务统计' }, chips)
    }

    function Clock(props) {
      const ref = React.useRef(null)
      const store = props.store
      const prep = props.prep
      React.useEffect(() => {
        if (!store || !ref.current) return undefined
        const update = (moment) => {
          try {
            const el = ref.current
            if (!el) return
            const current = el.querySelector('[data-tm-clock-current]')
            const total = el.querySelector('[data-tm-clock-total]')
            if (current) current.textContent = fmtClock(moment - prep.timeStart)
            if (total) total.textContent = fmtClock(prep.durationMs)
          } catch (error) { recordError('clock', error) }
        }
        update(store.getTime())
        return store.onFrame(update)
      }, [store, prep])
      const initialMoment = store ? store.getTime() : prep.timeEnd
      return h('div', {
        className: 'tm-clock',
        ref,
      },
        h('span', { className: 'tm-clock-label' }, '已回放'),
        h('b', { 'data-tm-clock-current': '1' }, fmtClock(initialMoment - prep.timeStart)),
        h('span', { className: 'tm-sep' }, '/'),
        h('span', { 'data-tm-clock-total': '1' }, fmtClock(prep.durationMs)))
    }

    function ProgressBar(props) {
      const ref = React.useRef(null)
      const store = props.store
      React.useEffect(() => {
        if (!store || !ref.current) return undefined
        const update = (moment) => {
          const el = ref.current
          if (!el) return
          if (typeof document !== 'undefined' && document.activeElement === el) return
          el.value = String(Math.round(moment))
        }
        update(store.getTime())
        return store.onFrame(update)
      }, [store])
      return h('div', { className: 'tm-progress' },
        h('input', {
          ref,
          type: 'range',
          min: String(store.getStart()),
          max: String(store.getEnd()),
          step: '100',
          defaultValue: String(Math.round(store.getTime())),
          'data-tm-scrubber': '1',
          'aria-label': '回放进度',
          onPointerDown: () => { try { store.pause() } catch (error) { recordError('scrub', error) } },
          onChange: (event) => store.setTime(Number(event.target.value)),
        }))
    }

    function ReplayControls(props) {
      const store = useDiscrete(props.store)
      const playing = store.isPlaying()
      const speed = store.getSpeed()
      const atEnd = store.isAtEnd()
      return h('div', { className: 'tm-replay' },
        h('button', {
          className: 'tm-btn',
          type: 'button',
          'aria-label': '跳到回放开始',
          'data-tm-jump-start': '1',
          onClick: () => { store.pause(); store.setTime(store.getStart()) },
        }, '⏮'),
        h('button', {
          className: 'tm-btn tm-primary',
          type: 'button',
          'aria-label': playing ? '暂停回放' : '播放回放',
          'aria-pressed': playing ? 'true' : 'false',
          'data-tm-play': '1',
          'data-tm-playing': playing ? 'true' : 'false',
          onClick: () => store.toggle(),
        }, playing ? '⏸ 暂停' : '▶ 回放'),
        h('select', {
          className: 'tm-select',
          'aria-label': '回放倍速',
          'data-tm-speed': String(speed),
          value: String(speed),
          onChange: (event) => store.setSpeed(Number(event.target.value)),
        }, SPEEDS.map((value) => h('option', { value: String(value), key: String(value) }, value + '×'))),
        h(Clock, { store, prep: props.prep }),
        h(ProgressBar, { store }),
        h('button', {
          className: 'tm-btn',
          type: 'button',
          'aria-label': atEnd ? '已是最新时刻' : '跳到最新时刻',
          'data-tm-jump-end': '1',
          disabled: atEnd,
          onClick: () => { store.pause(); store.setTime(store.getEnd()) },
        }, '⏭'))
    }

    function Legend() {
      const item = (color, label) => h('span', { key: label }, h('i', { style: { background: color } }), label)
      return h('div', { className: 'tm-legend' },
        item('var(--tm-pend)', '待开始'),
        item('var(--tm-run)', '执行中'),
        item('var(--tm-done)', '已完成'),
        item('var(--tm-fail)', '已失败'),
        h('span', { className: 'tm-legend-line', key: 'dep' }, h('i'), '依赖（blockedBy）'),
        h('span', { className: 'tm-legend-route', key: 'route' }, h('i'), '执行轨迹'),
        h('span', { key: 's' }, 'S 形 = 执行顺序'))
    }

    // ------------------------------------------------------------------
    // 任务流程图（W2.1 + W2.2）
    // ------------------------------------------------------------------
    function flowStatusText(status, task, moment) {
      if (status === 'in_progress') {
        const startedAt = finite(task.startedAt)
        if (startedAt !== null) return '已跑 ' + fmtDur(moment - startedAt)
        return '执行中'
      }
      if (status === 'completed') return '用时 ' + fmtDur(task.execMs)
      if (status === 'failed') return '失败'
      if (status === 'blocked') return '已阻塞'
      if (isCreatedAtTime(task, moment)) return '排队中'
      return ''
    }

    /** 展示用时刻：历史回放用 currentTime；实时会话停在最新时刻时，用 Date.now() 给「已跑 X」走秒。 */
    function displayMomentFor(prep, moment) {
      const value = finite(moment)
      if (value === null) return 0
      if (!prep || prep.liveMode !== true) return value
      if (value < prep.timeEnd) return value
      const now = Date.now()
      return now > value ? now : value
    }

    function statusColorVar(status) {
      if (status === 'completed') return 'var(--tm-done)'
      if (status === 'in_progress') return 'var(--tm-run)'
      if (status === 'failed') return 'var(--tm-fail)'
      if (status === 'blocked') return 'var(--tm-blocked)'
      return 'var(--tm-dim)'
    }

    function flowNodeAriaLabel(task, status, future) {
      const statusLabel = future ? '计划未创建' : (STATUS_LABEL[status] || status)
      return task.id + ' ' + task.subject + '，' + statusLabel +
        '，负责人 ' + (task.owner || '未指派') +
        (task.isNew && !future ? '，新增任务' : '')
    }

    function FlowNode(props) {
      const task = props.task
      const position = props.position
      const flow = props.flow
      const color = props.color
      const moment = props.moment
      const prep = props.prep
      const relation = props.relation || { badgeCount: 0, childOf: '', highlighted: false }
      const status = statusAtTime(task, moment)
      const future = !isCreatedAtTime(task, moment)
      const selected = props.selectedId === task.id
      const meta = flowStatusText(status, task, displayMomentFor(props.prep, moment))
      const titleLines = [
        task.id + ' · ' + task.subject,
        '负责人：' + (task.owner || '未指派') + (task.ownerIsLead ? '（Lead）' : '') +
        '｜开始第 ' + (task.startRank === null ? '—' : task.startRank) +
        ' / 完成第 ' + (task.doneRank === null ? '—' : task.doneRank),
        '创建 ' + fmtHm(task.createdAt) + '｜开始 ' + fmtHm(task.startedAt) + '｜完成 ' + fmtHm(task.completedAt),
        '执行 ' + fmtDur(task.execMs) + '｜排队 ' + fmtDur(task.queueMs) +
        (task.blockedWaitMs !== null ? '｜阻塞 ' + fmtDur(task.blockedWaitMs) : ''),
      ].join('\n')
      // 行高压缩时（3+ 行）使用更紧凑的节点内部排版；单图模式放大节点时内容按比例纵向分布。
      const compact = flow.nodeHeight < 58
      const tall = flow.nodeHeight > 92
      const headerCy = compact ? 14 : 17
      const headerTextY = compact ? 17 : 20.4
      const subjectY = tall ? Math.round(flow.nodeHeight * 0.5) : (compact ? flow.nodeHeight - 24 : flow.nodeHeight - 29)
      const ownerY = tall ? Math.round(flow.nodeHeight * 0.76) : (compact ? flow.nodeHeight - 9 : flow.nodeHeight - 14)
      const barY = compact ? 7 : 9
      return h('g', {
        className: flowNodeClass(status, { future, selected }) + (relation.highlighted ? ' tm-child-hl' : ''),
        transform: 'translate(' + position.x + ',' + position.y + ')',
        'data-tm-node': task.id,
        'data-tm-task-id': task.id,
        'data-tm-task-status': status,
        'data-tm-planned': future ? 'true' : 'false',
        'data-tm-new': task.isNew && !future ? 'true' : 'false',
        'data-tm-child-of': relation.childOf || undefined,
        'data-tm-child-highlight': relation.highlighted ? 'true' : 'false',
        tabIndex: 0,
        focusable: 'true',
        role: 'button',
        'aria-label': flowNodeAriaLabel(task, status, future),
        'aria-pressed': selected ? 'true' : 'false',
        onClick: () => props.onSelect(task.id),
        onKeyDown: (event) => {
          const key = event && event.key
          const code = event && event.code
          if (key === 'Enter' || key === ' ' || code === 'Space' || code === 'Enter') {
            event.preventDefault()
            event.stopPropagation()
            props.onSelect(task.id)
          }
        },
        onMouseEnter: (event) => props.tips.show(event, { kind: 'task', taskId: task.id }),
        onMouseLeave: () => props.tips.hide(),
        onFocus: (event) => {
          try {
            const target = event && (event.currentTarget || event.target)
            const rect = target && typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null
            if (rect && props.tips && typeof props.tips.showAtRect === 'function') {
              props.tips.showAtRect(rect, { kind: 'task', taskId: task.id })
            } else {
              props.tips.show(event, { kind: 'task', taskId: task.id })
            }
          } catch (error) { recordError('tooltip.focus', error) }
        },
        onBlur: () => props.tips.hide(),
      },
        h('rect', { className: 'tm-node-box', x: 0, y: 0, width: flow.nodeWidth, height: flow.nodeHeight, rx: 11 }),
        h('rect', { className: 'tm-node-bar', x: 0, y: barY, width: 3.5, height: flow.nodeHeight - barY * 2, rx: 2, fill: color }),
        h('circle', { className: 'tm-node-rank-bg', cx: 17, cy: headerCy, r: compact ? 7.5 : 8.5, fill: color }),
        h('text', { className: 'tm-node-rank', x: 17, y: headerTextY, textAnchor: 'middle' },
          String(task.startRank === null ? task.order + 1 : task.startRank)),
        h('text', { className: 'tm-node-id', x: compact ? 28 : 31, y: headerCy }, task.id.toUpperCase()),
        h('circle', { className: 'tm-node-pulse', cx: flow.nodeWidth - 17, cy: headerCy, r: 3 }),
        h('text', {
          className: 'tm-node-status',
          x: flow.nodeWidth - 25,
          y: headerTextY,
          textAnchor: 'end',
          'data-tm-node-status': '1',
          style: { fill: statusColorVar(status) },
        }, future ? '计划·未创建' : (STATUS_LABEL[status] || status)),
        relation.childOf
          ? h('text', {
            className: 'tm-node-childof',
            'data-tm-child-of': relation.childOf,
            x: 0,
            y: compact ? -20 : -21,
          }, '支线 of ' + relation.childOf)
          : null,
        relation.badgeCount > 0
          ? h('g', {
            className: 'tm-node-relbadge',
            'data-tm-relation-badge': '1',
            'data-tm-relation-count': String(relation.badgeCount),
            transform: 'translate(0,' + (compact ? -7 : -8) + ')',
          },
            h('rect', { className: 'tm-node-relbadge-bg', x: 0, y: 0, width: 28 + String(relation.badgeCount).length * 5, height: 12, rx: 6 }),
            h('text', { className: 'tm-node-relbadge-text', x: (28 + String(relation.badgeCount).length * 5) / 2, y: 9, textAnchor: 'middle' }, '支线 ' + relation.badgeCount))
          : null,
        task.isNew
          ? h('rect', {
            className: 'tm-node-new-bg',
            'data-tm-node-new': task.id,
            x: flow.nodeWidth - 36,
            y: compact ? -7 : -8,
            width: 30,
            height: 12,
            rx: 6,
            style: future ? { display: 'none' } : undefined,
          })
          : null,
        task.isNew
          ? h('text', {
            className: 'tm-node-new-text',
            'data-tm-node-new-text': task.id,
            x: flow.nodeWidth - 21,
            y: compact ? 1.6 : 1.2,
            textAnchor: 'middle',
            style: future ? { display: 'none' } : undefined,
          }, 'NEW')
          : null,
        h('text', { className: 'tm-node-subject', x: 13, y: subjectY }, truncateText(task.subject, 16)),
        h('text', { className: 'tm-node-owner', x: 13, y: ownerY, style: { fill: color } },
          truncateText(task.owner || '未指派', 15) + (task.ownerIsLead && task.owner !== 'Lead' ? ' · Lead' : '')),
        h('text', {
          className: 'tm-node-meta',
          x: flow.nodeWidth - 11,
          y: ownerY,
          textAnchor: 'end',
          'data-tm-node-meta': '1',
        }, meta))
    }

    /**
     * 流程图帧更新器：只写「值真正变化」的 DOM 属性，避免每帧整树重渲染。
     * 返回 apply(moment, selectedId)。
     */
    function createFlowUpdater(svg, prep, uid, highlightRef) {
      const nodeEls = new Map()
      const nodeCache = new Map()
      const found = svg.querySelectorAll('[data-tm-node]')
      for (let index = 0; index < found.length; index += 1) {
        const element = found[index]
        const id = element.getAttribute('data-tm-node')
        if (id) nodeEls.set(id, element)
      }
      const edgeEls = []
      const depFound = svg.querySelectorAll('[data-tm-edge-dep]')
      for (let index = 0; index < depFound.length; index += 1) {
        const element = depFound[index]
        const pair = String(element.getAttribute('data-tm-edge-dep') || '').split('->')
        edgeEls.push({ element, from: pair[0], to: pair[1], ready: null, dimmed: null })
      }
      const newEls = []
      const newFound = svg.querySelectorAll('[data-tm-node-new], [data-tm-node-new-text]')
      for (let index = 0; index < newFound.length; index += 1) {
        const element = newFound[index]
        const id = element.getAttribute('data-tm-node-new') || element.getAttribute('data-tm-node-new-text')
        newEls.push({ element, id, hidden: null })
      }
      const routeEl = svg.querySelector('[data-tm-route]')
      const trailEl = svg.querySelector('[data-tm-trail]')
      let routeLength = 0
      try {
        if (routeEl && typeof routeEl.getTotalLength === 'function') routeLength = routeEl.getTotalLength()
      } catch (ignored) { routeLength = 0 }
      const startedTimes = []
      for (const task of prep.tasks) {
        if (finite(task.startedAt) !== null) startedTimes.push(task.startedAt)
      }
      startedTimes.sort((left, right) => left - right)
      const total = Math.max(1, prep.tasks.length)

      return function applyFlowState(moment, selectedId) {
        const time = finite(moment) === null ? prep.timeEnd : moment
        if (routeEl && routeLength > 0) {
          const started = countAtOrBefore(startedTimes, time)
          const fraction = prep.tasks.length <= 1 ? 0 : clamp(started / total, 0, 1)
          routeEl.style.strokeDasharray = String(routeLength)
          routeEl.style.strokeDashoffset = String(routeLength * (1 - fraction))
          if (trailEl) {
            if (fraction <= 0) {
              trailEl.setAttribute('r', '0')
            } else {
              try {
                const point = routeEl.getPointAtLength(routeLength * fraction)
                trailEl.setAttribute('cx', String(round2(point.x)))
                trailEl.setAttribute('cy', String(round2(point.y)))
                trailEl.setAttribute('r', '5')
              } catch (ignored) { trailEl.setAttribute('r', '0') }
            }
          }
        }
        for (const task of prep.tasks) {
          const element = nodeEls.get(task.id)
          if (!element) continue
          const status = statusAtTime(task, time)
          const future = !isCreatedAtTime(task, time)
          const selected = task.id === selectedId
          const highlighted = Boolean(
            highlightRef && highlightRef.current && Array.isArray(highlightRef.current.children) &&
            highlightRef.current.children.indexOf(task.id) >= 0,
          )
          let cache = nodeCache.get(task.id)
          if (!cache) {
            cache = { status: null, future: null, selected: null, meta: null, className: '', newVisible: null, highlighted: null }
            nodeCache.set(task.id, cache)
          }

          const newVisible = isNewBadgeVisible(task, time)
          if (cache.newVisible !== newVisible) {
            cache.newVisible = newVisible
            element.setAttribute('data-tm-new', newVisible ? 'true' : 'false')
          }
          if (cache.status !== status || cache.future !== future || cache.selected !== selected || cache.highlighted !== highlighted) {
            const className = flowNodeClass(status, { future, selected }) + (highlighted ? ' tm-child-hl' : '')
            if (cache.className !== className) {
              element.setAttribute('class', className)
              cache.className = className
            }
            element.setAttribute('data-tm-task-status', status)
            element.setAttribute('data-tm-planned', future ? 'true' : 'false')
            const statusEl = element.querySelector('[data-tm-node-status]')
            if (statusEl) {
              statusEl.textContent = future ? '计划·未创建' : (STATUS_LABEL[status] || status)
              statusEl.style.fill = statusColorVar(status)
            }
            element.setAttribute('aria-pressed', selected ? 'true' : 'false')
            element.setAttribute('aria-label', flowNodeAriaLabel(task, status, future))
            element.setAttribute('data-tm-child-highlight', highlighted ? 'true' : 'false')
            cache.status = status
            cache.future = future
            cache.selected = selected
            cache.highlighted = highlighted
          }
          const metaText = flowStatusText(status, task, displayMomentFor(prep, time))
          const metaKey = status === 'in_progress'
            ? Math.floor(Math.max(0, time - (finite(task.startedAt) || time)) / 1000)
            : metaText
          if (cache.meta !== metaKey) {
            const metaEl = element.querySelector('[data-tm-node-meta]')
            if (metaEl) metaEl.textContent = metaText
            cache.meta = metaKey
          }
        }
        for (const entry of newEls) {
          const task = prep.taskById[entry.id]
          const hidden = !task || !isCreatedAtTime(task, time)
          if (entry.hidden !== hidden) {
            entry.hidden = hidden
            entry.element.style.display = hidden ? 'none' : ''
          }
        }
        for (const edge of edgeEls) {
          const blocker = prep.taskById[edge.from]
          const dependent = prep.taskById[edge.to]
          const ready = blocker ? statusAtTime(blocker, time) === 'completed' : false
          if (edge.ready !== ready) {
            edge.ready = ready
            edge.element.classList.toggle('tm-ready', ready)
            edge.element.setAttribute('marker-end', 'url(#tm-arrow-dep' + (ready ? '-on' : '') + (uid ? '-' + uid : '') + ')')
          }
          const dimmed = dependent ? !isCreatedAtTime(dependent, time) : false
          if (edge.dimmed !== dimmed) {
            edge.dimmed = dimmed
            edge.element.style.opacity = dimmed ? '0.18' : ''
          }
        }
      }
    }

    const TaskFlowInner = function TaskFlowInner(props) {
      const prep = props.prep
      const uid = useInstanceId('flow')
      const svgRef = React.useRef(null)
      const applyRef = React.useRef(() => {})
      const store = props.store
      const tips = props.tips
      const selectionRef = props.selectionRef
      const highlightRef = props.highlightRef
      const layoutMode = normalizeLayoutMode(props.layoutMode)
      const mapScrollRef = React.useRef(null)
      const [mapViewport, setMapViewport] = React.useState({ width: 0, height: 0 })
      const [showDeps, setShowDeps] = React.useState(true)
      const [showTrail, setShowTrail] = React.useState(true)
      const moment = store ? store.getTime() : prep.timeEnd
      const selectedId = selectionRef ? selectionRef.current : ''
      const settleRef = React.useRef(null)

      React.useEffect(() => {
        const element = mapScrollRef.current
        if (!element) return undefined
        const measure = () => {
          const width = element.clientWidth || 0
          const height = element.clientHeight || 0
          setMapViewport((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
        }
        measure()
        let observer = null
        try {
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(measure)
            observer.observe(element)
          }
        } catch (ignored) { /* noop */ }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure)
        }
        return () => {
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure)
          } catch (ignored) { /* noop */ }
          if (observer) observer.disconnect()
        }
      }, [])

      // 单图（流程图）模式：模式切换/窗口 resize/stretch relayout 后把滚动位置归零，避免放大后顶部仍在视口外。
      const resetMapScroll = React.useCallback(() => {
        const element = mapScrollRef.current
        if (!element) return
        try { element.scrollTop = 0 } catch (ignored) { /* noop */ }
      }, [])
      React.useEffect(() => {
        if (layoutMode !== 'flow') return undefined
        resetMapScroll()
        if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return undefined
        const onResize = () => resetMapScroll()
        window.addEventListener('resize', onResize)
        return () => {
          try { window.removeEventListener('resize', onResize) } catch (ignored) { /* noop */ }
        }
      }, [layoutMode, resetMapScroll])
      React.useEffect(() => {
        if (layoutMode !== 'flow') return
        resetMapScroll()
      }, [layoutMode, mapViewport.width, mapViewport.height, resetMapScroll])

      // 单图（流程图）模式：按可视高度纵向拉伸行距后重算边/轨迹（节点尺寸不变）。
      const localLayout = React.useMemo(() => {
        const baseFlow = prep.flow
        if (layoutMode !== 'flow' || !mapViewport.width || !mapViewport.height) {
          return {
            flow: baseFlow,
            route: prep.flowRoute,
            depEdges: prep.flowDepEdges,
            relEdges: prep.flowRelationEdges,
          }
        }
        const targetViewHeight = mapViewport.height * (baseFlow.width / Math.max(1, mapViewport.width))
        const flow = stretchFlowLayout(baseFlow, targetViewHeight, mapViewport)
        if (flow === baseFlow) {
          return {
            flow: baseFlow,
            route: prep.flowRoute,
            depEdges: prep.flowDepEdges,
            relEdges: prep.flowRelationEdges,
          }
        }
        const positionsByIndex = new Map()
        prep.tasks.forEach((task, index) => positionsByIndex.set(task.id, flow.positions[index]))
        const depEdges = []
        const relEdges = []
        for (const edge of prep.edges) {
          const fromPosition = positionsByIndex.get(edge.from)
          const toPosition = positionsByIndex.get(edge.to)
          if (!fromPosition || !toPosition) continue
          if (edge.kind === 'blockedBy') {
            depEdges.push({
              from: edge.from,
              to: edge.to,
              path: buildDependencyPath(fromPosition, toPosition, flow.nodeWidth, flow.nodeHeight),
            })
          } else if (edge.kind === 'relation') {
            const side = toPosition.x >= fromPosition.x ? 'right' : 'left'
            relEdges.push({
              from: edge.from,
              to: edge.to,
              path: buildRelationPath(fromPosition, toPosition, flow.nodeWidth, flow.nodeHeight, side),
            })
          }
        }
        return { flow, route: buildFlowPath(flow, prep.tasks.length), depEdges, relEdges }
      }, [layoutMode, prep, mapViewport.width, mapViewport.height])
      const flow = localLayout.flow

      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const updater = createFlowUpdater(svg, prep, uid, highlightRef)
        settleRef.current = updater
        updater(store.getTime(), selectionRef ? selectionRef.current : '')
        if (!store) return undefined
        return store.onFrame((momentNow) => updater(momentNow, selectionRef ? selectionRef.current : ''))
      }, [prep, store, selectionRef, uid, highlightRef])

      React.useEffect(() => {
        if (settleRef.current) {
          settleRef.current(store ? store.getTime() : prep.timeEnd, selectionRef ? selectionRef.current : '')
        }
      }, [selectedId, selectionRef, store, prep.timeEnd])

      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const deps = svg.querySelectorAll('.tm-edge-dep')
        for (let index = 0; index < deps.length; index += 1) deps[index].classList.toggle('tm-edge-hidden', !showDeps)
        return undefined
      }, [showDeps])

      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const base = svg.querySelector('[data-tm-route-base]')
        const route = svg.querySelector('[data-tm-route]')
        const trail = svg.querySelector('[data-tm-trail]')
        if (base) base.classList.toggle('tm-edge-hidden', !showTrail)
        if (route) route.classList.toggle('tm-edge-hidden', !showTrail)
        if (trail) trail.style.display = showTrail ? '' : 'none'
        return undefined
      }, [showTrail])

      const collapsed = isPanelCollapsed(layoutMode, 'flow')
      const onLayoutAction = (action) => {
        if (typeof props.onLayoutMode === 'function') props.onLayoutMode(layoutActionToMode(action))
      }
      const flowAction = collapsed || layoutMode === 'flow' ? 'restore-both' : 'maximize-flow'
      return h('section', {
        className: 'tm-panel tm-map' + (collapsed ? ' tm-panel-collapsed' : ''),
        'data-tm-panel': 'flow',
        'data-tm-panel-collapsed': collapsed ? 'true' : 'false',
      },
        h(PanelHead, {
          title: '执行轨迹 · 任务流程图',
          children: h('div', { style: { display: 'flex', alignItems: 'center', gap: 12 } },
            collapsed
              ? null
              : h('label', { className: 'tm-toggle' },
                h('input', { type: 'checkbox', checked: showDeps, onChange: (event) => setShowDeps(event.target.checked) }),
                '依赖边'),
            collapsed
              ? null
              : h('label', { className: 'tm-toggle' },
                h('input', { type: 'checkbox', checked: showTrail, onChange: (event) => setShowTrail(event.target.checked) }),
                '执行轨迹'),
            collapsed
              ? null
              : h('span', { className: 'tm-hint' }, '点击任务查看详情'),
            h(LayoutModeButton, { action: flowAction, onAction: onLayoutAction })),
        }),
        h('div', { className: 'tm-map-scroll' + (flow.rows <= 3 && layoutMode !== 'flow' ? ' tm-flow-fit' : ''), ref: mapScrollRef },
          h('svg', {
            className: 'tm-flow-svg',
            ref: svgRef,
            viewBox: '0 0 ' + flow.width + ' ' + flow.height,
            preserveAspectRatio: 'xMidYMin meet',
            role: 'group',
            'aria-label': '任务流程图（可用 Tab 聚焦节点，Enter/空格选中）',
          },
            h('defs', null,
              h('marker', { id: 'tm-arrow-dep-' + uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                h('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--tm-dim2)' })),
              h('marker', { id: 'tm-arrow-dep-on-' + uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                h('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--tm-route)' })),
              h('marker', { id: 'tm-arrow-rel-' + uid, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' },
                h('path', { d: 'M0,0 L10,5 L0,10 z', fill: 'var(--tm-rel)' }))),
            h('text', { x: FLOW.X0, y: 20, fill: 'var(--tm-dim2)', fontSize: 10, letterSpacing: 1.4 },
              '执行顺序 = 编号顺序 · 虚线 = 阻塞依赖 · 紫色 = 关系分叉'),
            localLayout.depEdges.map((edge) => h('path', {
              key: 'dep-' + edge.from + '->' + edge.to,
              className: 'tm-edge-dep' + (showDeps ? '' : ' tm-edge-hidden'),
              d: edge.path,
              'data-tm-edge-dep': edge.from + '->' + edge.to,
              markerEnd: 'url(#tm-arrow-dep-' + uid + ')',
            })),
            localLayout.relEdges.map((edge) => h('path', {
              key: 'rel-' + edge.from + '->' + edge.to,
              className: 'tm-edge-rel',
              d: edge.path,
              'data-tm-edge-rel': edge.from + '->' + edge.to,
              markerEnd: 'url(#tm-arrow-rel-' + uid + ')',
            })),
            localLayout.route
              ? h('path', { className: 'tm-route-base', d: localLayout.route, 'data-tm-route-base': '1' })
              : null,
            localLayout.route
              ? h('path', {
                className: 'tm-route',
                d: localLayout.route,
                'data-tm-route': '1',
                style: { display: showTrail ? '' : 'none' },
              })
              : null,
            h('circle', { className: 'tm-trail-head', r: 0, cx: 0, cy: 0, 'data-tm-trail': '1', style: { display: showTrail ? '' : 'none' } }),
            prep.tasks.map((task, index) => {
              const highlightedChildren = highlightRef && highlightRef.current && Array.isArray(highlightRef.current.children)
                ? highlightRef.current.children
                : []
              return h(FlowNode, {
                key: task.id,
                task,
                position: flow.positions[index],
                flow,
                color: prep.ownerColors[task.owner] || '#94a3b8',
                moment,
                prep,
                selectedId,
                onSelect: props.onSelect,
                tips,
                relation: {
                  badgeCount: relationBadgeCount(prep, task.id),
                  childOf: relationParentOf(prep, task.id),
                  highlighted: highlightedChildren.indexOf(task.id) >= 0,
                },
              })
            })),
          prep.tasks.length === 0
            ? h('div', { className: 'tm-placeholder' }, h('div', { className: 'tm-placeholder-title' }, '暂无任务节点'))
            : null),
        h('div', { className: 'tm-map-foot' },
          h(Legend),
          h('span', { className: 'tm-hint' },
            flow.rows > 3
              ? ('共 ' + flow.rows + ' 行 / ' + prep.tasks.length + ' 个任务 · 滚动查看全部 · ① 执行顺序 → ③ 关系分叉')
              : '① 执行顺序 → ② 依赖 → ③ 关系分叉')))
    }
    const TaskFlow = memo(TaskFlowInner)

    // ------------------------------------------------------------------
    // 甘特时间轴（W2.3）：任务行 / 代理行 / 事件行 / 热度行 + 播放头 + 拖拽
    // ------------------------------------------------------------------
    const GANTT_WINDOW_THRESHOLD = 80

    /** 甘特行标签：关系前缀（支线 N / ↳父任务）+ 计划前缀 + id · 标题（截断）。 */
    function ganttRowLabel(prep, task, planned) {
      const childOf = relationParentOf(prep, task.id)
      const badgeCount = relationBadgeCount(prep, task.id)
      let label = task.id + ' · ' + task.subject
      if (childOf) label = '↳' + childOf + ' · ' + label
      if (badgeCount > 0) label = '支线' + badgeCount + ' · ' + label
      label = truncateText(label, 16)
      return planned ? '〔计划〕' + label : label
    }

    function memberPhaseColor(phase) {
      if (phase === 'active') return '#38bdf8'
      if (phase === 'provisioning') return '#64748b'
      if (phase === 'failed') return '#f87171'
      if (phase === 'completed') return '#34d399'
      return '#475569'
    }

    /** 单任务在给定时刻的甘特几何：排队虚段（createdAt→startedAt）+ 执行实段（startedAt→completedAt|now）。 */
    function ganttTaskGeometry(task, timeline, moment) {
      const tl = timeline
      const createdAt = finite(task.createdAt) === null ? tl.start : task.createdAt
      const startedAt = finite(task.startedAt)
      const completedAt = finite(task.completedAt)
      const safeMoment = clamp(moment, tl.start, tl.end)
      let waitEnd = startedAt !== null ? Math.min(startedAt, safeMoment) : safeMoment
      if (waitEnd < createdAt) waitEnd = createdAt
      const createdX = timelineX(tl, createdAt)
      const waitX = createdX
      const waitW = Math.max(0, timelineX(tl, waitEnd) - createdX)
      let barX = createdX
      let barW = 0
      let barVisible = false
      if (startedAt !== null && startedAt <= safeMoment) {
        barX = timelineX(tl, startedAt)
        const barEnd = completedAt !== null ? Math.min(completedAt, safeMoment) : safeMoment
        barW = Math.max(0, timelineX(tl, barEnd) - barX)
        barVisible = true
      }
      return {
        waitX,
        waitW,
        barX,
        barW,
        barVisible,
        doneVisible: completedAt !== null && completedAt <= safeMoment,
        doneX: completedAt !== null ? timelineX(tl, completedAt) : 0,
      }
    }

    /**
     * 甘特帧更新器：播放头 / 已回放区域 / 每行段宽 / 未来置灰，全部直接改 DOM 属性。
     * 虚拟化时行数有限，逐帧成本可控；带 lastSig 缓存避免同值写入。
     */
    function createGanttUpdater(svg, prep, highlightRef, timeline) {
      const tl = timeline || prep.timeline
      const rows = new Map()
      const rowNodes = svg.querySelectorAll('[data-tm-gantt-task]')
      for (let index = 0; index < rowNodes.length; index += 1) {
        const group = rowNodes[index]
        const id = group.getAttribute('data-tm-gantt-task')
        if (!id) continue
        rows.set(id, {
          group,
          wait: group.querySelector('[data-tm-gantt-wait]'),
          bar: group.querySelector('[data-tm-gantt-bar]'),
          done: group.querySelector('[data-tm-gantt-done]'),
          label: group.querySelector('[data-tm-gantt-label]'),
          rowY: Number(group.getAttribute('data-row-y') || 0),
          cache: '',
          planned: null,
          highlighted: null,
          selected: null,
        })
      }
      const memberBars = []
      const memberNodes = svg.querySelectorAll('[data-tm-gantt-mem]')
      for (let index = 0; index < memberNodes.length; index += 1) {
        const element = memberNodes[index]
        memberBars.push({
          element,
          memberIndex: Number(element.getAttribute('data-mem-i') || 0),
          phaseIndex: Number(element.getAttribute('data-phase-i') || 0),
          cache: '',
        })
      }
      const eventNodes = []
      const evNodes = svg.querySelectorAll('[data-tm-gantt-ev]')
      for (let index = 0; index < evNodes.length; index += 1) {
        const element = evNodes[index]
        eventNodes.push({ element, at: Number(element.getAttribute('data-at') || 0), cache: null })
      }
      const densityNodes = []
      const denNodes = svg.querySelectorAll('[data-tm-gantt-density]')
      for (let index = 0; index < denNodes.length; index += 1) {
        const element = denNodes[index]
        densityNodes.push({ element, end: Number(element.getAttribute('data-bucket-end') || 0), cache: null })
      }
      const playhead = svg.querySelector('[data-tm-playhead]')
      const playheadCap = svg.querySelector('[data-tm-playhead-cap]')
      const played = svg.querySelector('[data-tm-played]')

      return function applyGanttState(momentRaw, selectedId) {
        const moment = clamp(finite(momentRaw) === null ? tl.end : momentRaw, tl.start, tl.end)
        const x = timelineX(tl, moment)
        if (playhead) {
          playhead.setAttribute('x1', String(round2(x)))
          playhead.setAttribute('x2', String(round2(x)))
        }
        if (playheadCap) playheadCap.setAttribute('transform', 'translate(' + round2(x) + ',' + tl.top + ')')
        if (played) played.setAttribute('width', String(Math.max(0, round2(x - tl.x0))))
        for (const task of prep.tasks) {
          const row = rows.get(task.id)
          if (!row) continue
          const geometry = ganttTaskGeometry(task, tl, moment)
          const selected = task.id === selectedId
          const planned = !isCreatedAtTime(task, moment)
          const highlighted = Boolean(
            highlightRef && highlightRef.current && Array.isArray(highlightRef.current.children) &&
            highlightRef.current.children.indexOf(task.id) >= 0,
          )
          const signature = round2(geometry.waitW) + '|' + round2(geometry.barW) + '|' + geometry.barVisible +
            '|' + geometry.doneVisible + '|' + selected + '|' + planned + '|' + highlighted
          if (row.cache === signature) continue
          row.cache = signature
          if (row.planned !== planned || row.highlighted !== highlighted || row.selected !== selected) {
            row.planned = planned
            row.highlighted = highlighted
            row.selected = selected
            row.group.setAttribute('data-tm-planned', planned ? 'true' : 'false')
            row.group.setAttribute('data-tm-child-highlight', highlighted ? 'true' : 'false')
            row.group.setAttribute('class', 'tm-tl-taskrow' + (selected ? ' tm-sel' : '') + (highlighted ? ' tm-child-hl' : ''))
            if (row.label) row.label.textContent = ganttRowLabel(prep, task, planned)
          }
          if (row.wait) {
            row.wait.setAttribute('x', String(round2(geometry.waitX)))
            row.wait.setAttribute('width', String(round2(geometry.waitW)))
          }
          if (row.bar) {
            if (geometry.barVisible) {
              row.bar.setAttribute('x', String(round2(geometry.barX)))
              row.bar.setAttribute('width', String(round2(geometry.barW)))
              row.bar.setAttribute('opacity', '0.92')
            } else {
              row.bar.setAttribute('width', '0')
              row.bar.setAttribute('opacity', '0')
            }
            row.bar.setAttribute('class', 'tm-tl-bar' + (selected ? ' tm-sel' : ''))
            row.bar.setAttribute('aria-pressed', selected ? 'true' : 'false')
          }
          if (row.done) {
            if (geometry.doneVisible) {
              const cy = row.rowY + tl.rowH / 2
              row.done.setAttribute('x', String(round2(geometry.doneX - 3.6)))
              row.done.setAttribute('y', String(round2(cy - 3.6)))
              row.done.setAttribute('width', '7.2')
              row.done.setAttribute('height', '7.2')
              row.done.setAttribute('transform', 'rotate(45 ' + round2(geometry.doneX) + ' ' + round2(cy) + ')')
              row.done.style.display = ''
            } else {
              row.done.style.display = 'none'
            }
          }
        }
        for (const entry of memberBars) {
          const member = prep.members[entry.memberIndex]
          if (!member) continue
          const phase = member.phases[entry.phaseIndex]
          if (!phase) continue
          const next = member.phases[entry.phaseIndex + 1]
          const phaseStart = phase.at
          const phaseEnd = next ? next.at : tl.end
          const signature = moment < phaseStart ? 'idle' : round2(timelineX(tl, Math.min(phaseEnd, moment))) + '|' + String(phaseStart)
          if (entry.cache === signature) continue
          entry.cache = signature
          if (moment < phaseStart) {
            entry.element.setAttribute('width', '0')
            entry.element.style.opacity = '0'
          } else {
            const startX = timelineX(tl, phaseStart)
            const endX = timelineX(tl, Math.min(phaseEnd, moment))
            entry.element.setAttribute('x', String(round2(startX)))
            entry.element.setAttribute('width', String(Math.max(0, round2(endX - startX))))
            entry.element.style.opacity = ''
          }
        }
        for (const entry of eventNodes) {
          const hidden = entry.at > moment
          if (entry.cache !== hidden) {
            entry.cache = hidden
            entry.element.style.opacity = hidden ? '0.16' : ''
          }
        }
        for (const entry of densityNodes) {
          const hidden = entry.end > moment
          if (entry.cache !== hidden) {
            entry.cache = hidden
            entry.element.style.opacity = hidden ? '0.14' : ''
          }
        }
      }
    }

    const GanttInner = function GanttInner(props) {
      const prep = props.prep
      const layoutMode = normalizeLayoutMode(props.layoutMode)
      const collapsed = isPanelCollapsed(layoutMode, 'gantt')
      const store = props.store
      const tips = props.tips
      const selectionRef = props.selectionRef
      const highlightRef = props.highlightRef
      const onSelect = props.onSelect
      const uid = useInstanceId('gantt')
      const svgRef = React.useRef(null)
      const scrollRef = React.useRef(null)
      const applyRef = React.useRef(() => {})
      const draggingRef = React.useRef(false)
      const [rowWindow, setRowWindow] = React.useState({ first: 0, last: prep.timeline.taskRows.length })
      const [viewport, setViewport] = React.useState({ width: 0, height: 0 })
      const moment = store ? store.getTime() : prep.timeline.end
      const selectedId = selectionRef ? selectionRef.current : ''
      // 单图（甘特）模式：按可视高度放大行距，避免下方空白；其它模式用投影预计算布局。
      const tl = React.useMemo(() => {
        const base = prep.timeline
        if (layoutMode !== 'gantt') return base
        const width = viewport.width
        const height = viewport.height
        if (!width || !height) return base
        const targetViewHeight = height * (TIMELINE.W / Math.max(1, width))
        const scale = clamp((targetViewHeight - TIMELINE.TOP) / Math.max(1, base.height - TIMELINE.TOP), 1, 2.6)
        if (scale <= 1.02) return base
        return computeTimelineLayout({
          tasks: prep.tasks,
          members: prep.members,
          spans: prep.spans,
          milestones: prep.milestones,
          start: prep.timeStart,
          end: prep.timeEnd,
          spansTruncated: prep.spansTruncated,
          spanSummary: prep.spanSummary,
          idleLeadMs: base.idleLeadMs || 0,
          rowScale: scale,
        })
      }, [layoutMode, prep, viewport.width, viewport.height])

      React.useEffect(() => {
        const element = scrollRef.current
        if (!element) return undefined
        const measure = () => {
          const width = element.clientWidth || 0
          const height = element.clientHeight || 0
          setViewport((previous) => (previous.width === width && previous.height === height ? previous : { width, height }))
        }
        measure()
        let observer = null
        try {
          if (typeof ResizeObserver === 'function') {
            observer = new ResizeObserver(measure)
            observer.observe(element)
          }
        } catch (ignored) { /* noop */ }
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('resize', measure)
        }
        return () => {
          try {
            if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('resize', measure)
          } catch (ignored) { /* noop */ }
          if (observer) observer.disconnect()
        }
      }, [])

      React.useEffect(() => {
        const svg = svgRef.current
        if (!svg) return undefined
        const updater = createGanttUpdater(svg, prep, highlightRef, tl)
        applyRef.current = updater
        updater(store.getTime(), selectionRef ? selectionRef.current : '')
        if (!store) return undefined
        return store.onFrame((now) => updater(now, selectionRef ? selectionRef.current : ''))
      }, [prep, tl, rowWindow.first, rowWindow.last, store, selectionRef, highlightRef])

      React.useEffect(() => {
        const element = scrollRef.current
        if (!element || tl.taskRows.length <= GANTT_WINDOW_THRESHOLD) return undefined
        const schedule = typeof requestAnimationFrame === 'function'
          ? (callback) => requestAnimationFrame(callback)
          : (callback) => setTimeout(callback, 16)
        const cancel = typeof cancelAnimationFrame === 'function' ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id)
        let pending = 0
        const compute = () => {
          pending = 0
          const el = scrollRef.current
          if (!el) return
          const scrollTop = el.scrollTop || 0
          const viewHeight = el.clientHeight || 260
          const first = clamp(Math.floor((scrollTop - tl.tasksY0) / tl.rowH) - 2, 0, Math.max(0, tl.taskRows.length - 1))
          const last = clamp(Math.ceil((scrollTop + viewHeight - tl.tasksY0) / tl.rowH) + 5, first + 1, tl.taskRows.length)
          setRowWindow((previous) => (previous.first === first && previous.last === last ? previous : { first, last }))
        }
        const onScroll = () => {
          if (pending) return
          pending = schedule(compute)
        }
        element.addEventListener('scroll', onScroll, { passive: true })
        compute()
        return () => {
          element.removeEventListener('scroll', onScroll)
          if (pending) cancel(pending)
        }
      }, [tl, prep])

      const timeFromClientX = (clientX) => {
        const svg = svgRef.current
        if (!svg || typeof svg.getBoundingClientRect !== 'function') return store.getTime()
        const rect = svg.getBoundingClientRect()
        if (!rect || !rect.width) return store.getTime()
        const viewX = ((clientX - rect.left) / rect.width) * tl.width
        const ratio = clamp((viewX - tl.x0) / (tl.x1 - tl.x0), 0, 1)
        return tl.start + ratio * tl.span
      }
      const onPointerDown = (event) => {
        try {
          const target = event.target
          if (target && target.closest && (target.closest('[data-tm-gantt-task]') || target.closest('[data-tm-gantt-ev]'))) return
          draggingRef.current = true
          store.pause()
          store.setTime(timeFromClientX(event.clientX))
          if (event.currentTarget && event.currentTarget.setPointerCapture && event.pointerId !== undefined) {
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        } catch (error) { recordError('gantt.scrub', error) }
      }
      const onPointerMove = (event) => {
        if (!draggingRef.current) return
        try { store.setTime(timeFromClientX(event.clientX)) } catch (error) { recordError('gantt.move', error) }
      }
      const onPointerUp = () => { draggingRef.current = false }
      const onClick = (event) => {
        try {
          const target = event.target
          if (!target || !target.closest) return
          const taskNode = target.closest('[data-tm-gantt-task]')
          if (taskNode) {
            onSelect(taskNode.getAttribute('data-tm-gantt-task'))
            return
          }
          const eventNode = target.closest('[data-tm-gantt-ev]')
          if (eventNode) {
            const at = Number(eventNode.getAttribute('data-at') || 0)
            if (at > 0) store.setTime(at)
          }
        } catch (error) { recordError('gantt.click', error) }
      }
      const showTaskTip = (event, taskId) => tips.show(event, { kind: 'task', taskId })
      const showMemberTip = (event, memberIndex) => {
        const member = prep.members[memberIndex]
        if (member) tips.show(event, { kind: 'member', memberId: member.id })
      }
      const showEventTip = (event, item) => tips.show(event, { kind: 'event', title: item.label, detail: item.detail })

      const rows = []
      const firstRow = rowWindow.first
      const lastRow = Math.min(tl.taskRows.length, rowWindow.last)
      for (let index = firstRow; index < lastRow; index += 1) {
        const row = tl.taskRows[index]
        const task = row.task
        const geometry = ganttTaskGeometry(task, tl, moment)
        const ownerColor = prep.ownerColors[task.owner] || '#94a3b8'
        const selected = task.id === selectedId
        const planned = !isCreatedAtTime(task, moment)
        const childOf = relationParentOf(prep, task.id)
        const badgeCount = relationBadgeCount(prep, task.id)
        const highlightedChildren = highlightRef && highlightRef.current && Array.isArray(highlightRef.current.children)
          ? highlightRef.current.children
          : []
        const highlighted = highlightedChildren.indexOf(task.id) >= 0
        rows.push(h('g', {
          key: task.id,
          'data-tm-gantt-task': task.id,
          'data-tm-planned': planned ? 'true' : 'false',
          'data-tm-child-of': childOf || undefined,
          'data-tm-child-highlight': highlighted ? 'true' : 'false',
          className: 'tm-tl-taskrow' + (selected ? ' tm-sel' : '') + (highlighted ? ' tm-child-hl' : ''),
          'data-row-y': String(row.y),
          onMouseEnter: (event) => showTaskTip(event, task.id),
          onMouseLeave: () => tips.hide(),
        },
          h('rect', { className: 'tm-tl-rowbg', x: 0, y: row.y, width: tl.width, height: tl.rowH }),
          h('circle', { cx: tl.labelRight + 2, cy: row.y + tl.rowH / 2, r: 3, fill: ownerColor }),
          h('text', {
            className: 'tm-tl-label',
            'data-tm-gantt-label': task.id,
            'data-tm-relation-badge': badgeCount > 0 ? '1' : undefined,
            'data-tm-relation-count': badgeCount > 0 ? String(badgeCount) : undefined,
            'data-tm-child-of': childOf || undefined,
            x: tl.labelRight - 7,
            y: row.y + tl.rowH / 2 + 3.6,
            textAnchor: 'end',
          }, ganttRowLabel(prep, task, planned)),
          h('rect', {
            className: 'tm-tl-wait',
            'data-tm-gantt-wait': task.id,
            x: geometry.waitX,
            y: row.y + 5,
            width: geometry.waitW,
            height: tl.rowH - 10,
            rx: 3,
          }),
          h('rect', {
            className: 'tm-tl-bar' + (selected ? ' tm-sel' : ''),
            'data-tm-gantt-bar': task.id,
            x: geometry.barVisible ? geometry.barX : geometry.waitX,
            y: row.y + 4,
            width: geometry.barW,
            height: tl.rowH - 8,
            rx: 4,
            fill: ownerColor,
            opacity: geometry.barVisible ? 0.92 : 0,
            tabIndex: 0,
            focusable: 'true',
            role: 'button',
            'aria-label': '时间轴 ' + flowNodeAriaLabel(task, statusAtTime(task, moment), planned),
            'aria-pressed': selected ? 'true' : 'false',
            onKeyDown: (event) => {
              const key = event && event.key
              const code = event && event.code
              if (key === 'Enter' || key === ' ' || code === 'Space' || code === 'Enter') {
                event.preventDefault()
                event.stopPropagation()
                onSelect(task.id)
              }
            },
          }),
          h('rect', {
            className: 'tm-tl-done',
            'data-tm-gantt-done': task.id,
            x: geometry.doneVisible ? geometry.doneX - 3.6 : 0,
            y: row.y + tl.rowH / 2 - 3.6,
            width: 7.2,
            height: 7.2,
            rx: 1.5,
            transform: geometry.doneVisible ? 'rotate(45 ' + geometry.doneX + ' ' + (row.y + tl.rowH / 2) + ')' : '',
            style: geometry.doneVisible ? undefined : { display: 'none' },
          })))
      }

      const memberRows = tl.memberRows.map((row) => {
        const member = row.member
        return h('g', {
          key: 'member-' + member.id,
          'data-tm-gantt-member': member.name,
          className: 'tm-tl-memberrow',
          onMouseEnter: (event) => showMemberTip(event, row.index),
          onMouseLeave: () => tips.hide(),
        },
          h('rect', { className: 'tm-tl-rowbg', x: 0, y: row.y, width: tl.width, height: tl.memH }),
          h('text', {
            className: 'tm-tl-label tm-dim',
            x: tl.labelRight - 7,
            y: row.y + tl.memH / 2 + 3.4,
            textAnchor: 'end',
          }, truncateText(member.name, 13)),
          member.phases.map((phase, phaseIndex) => {
            const next = member.phases[phaseIndex + 1]
            const phaseStart = phase.at
            const phaseEnd = next ? next.at : tl.end
            const visible = moment >= phaseStart
            const startX = timelineX(tl, phaseStart)
            const endX = visible ? timelineX(tl, Math.min(phaseEnd, moment)) : startX
            return h('rect', {
              key: 'phase-' + phaseIndex,
              className: 'tm-tl-mem',
              'data-tm-gantt-mem': member.name,
              'data-mem-i': String(row.index),
              'data-phase-i': String(phaseIndex),
              x: startX,
              y: row.y + 5,
              width: visible ? Math.max(0, endX - startX) : 0,
              height: tl.memH - 10,
              rx: 3,
              fill: memberPhaseColor(phase.phase),
              opacity: visible ? (phase.phase === 'active' ? 0.85 : 0.5) : 0,
            })
          }))
      })

      const eventNodes = tl.events.map((item, index) => {
        const x = item.x
        const y = tl.eventsY
        let shape = null
        if (item.kind === 'approval') {
          shape = h('rect', {
            className: 'tm-tl-ev-mark',
            x: x - 3.6,
            y: y - 3.6,
            width: 7.2,
            height: 7.2,
            fill: '#fbbf24',
            transform: 'rotate(45 ' + round2(x) + ' ' + round2(y) + ')',
          })
        } else if (item.kind === 'deliverable') {
          shape = h('rect', { className: 'tm-tl-ev-mark', x: x - 3.6, y: y - 3.6, width: 7.2, height: 7.2, rx: 1.5, fill: '#34d399' })
        } else {
          shape = h('circle', { className: 'tm-tl-ev-mark', cx: x, cy: y, r: 3.4, fill: '#38bdf8' })
        }
        return h('g', {
          key: 'ev-' + index + '-' + item.at,
          className: 'tm-tl-ev',
          'data-tm-gantt-ev': item.kind,
          'data-at': String(item.at),
          onMouseEnter: (event) => showEventTip(event, item),
          onMouseLeave: () => tips.hide(),
        }, shape)
      })

      const densityNodes = tl.density.map((bucket) => h('rect', {
        key: 'den-' + bucket.index,
        className: 'tm-tl-density' + (bucket.ratio > 0.66 ? ' tm-hot' : ''),
        'data-tm-gantt-density': '1',
        'data-bucket-end': String(Math.round(bucket.end)),
        x: bucket.x,
        y: tl.densityY0 + 18 - Math.max(1.5, bucket.ratio * 18),
        width: bucket.width,
        height: Math.max(1.5, bucket.ratio * 18),
        rx: 1.5,
      }))

      const totalSpans = tl.spanSummary ? tl.spanSummary.total : prep.spans.length
      const onLayoutAction = (action) => {
        if (typeof props.onLayoutMode === 'function') props.onLayoutMode(layoutActionToMode(action))
      }
      const ganttAction = collapsed || layoutMode === 'gantt' ? 'restore-both' : 'maximize-gantt'
      return h('section', {
        className: 'tm-panel tm-timeline' + (collapsed ? ' tm-panel-collapsed' : ''),
        'data-tm-panel': 'gantt',
        'data-tm-panel-collapsed': collapsed ? 'true' : 'false',
        'data-tm-gantt': '1',
      },
        h(PanelHead, {
          title: '时间轴 · 任务 / 代理 / 事件 / 热度',
          children: h('div', { className: 'tm-panel-head-right' },
            collapsed
              ? null
              : h('span', { className: 'tm-hint' }, '拖动播放头定位 · 点击任务条选中'),
            collapsed
              ? null
              : h('span', { className: 'tm-hint' },
                tl.spansTruncated
                  ? ('明细已截断（共 ' + fmtInt(totalSpans) + ' 条，热度为聚合近似）')
                  : ('工具/后台 ' + fmtInt(totalSpans) + ' 条')),
            h(LayoutModeButton, { action: ganttAction, onAction: onLayoutAction })),
        }),
        h('div', { className: 'tm-tl-scroll', ref: scrollRef },
          h('svg', {
            className: 'tm-tl-svg',
            ref: svgRef,
            viewBox: '0 0 ' + tl.width + ' ' + tl.height,
            preserveAspectRatio: 'xMinYMin meet',
            role: 'group',
            'aria-label': '任务时间轴（可用 Tab 聚焦任务条，Enter/空格选中）',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerLeave: onPointerUp,
            onClick,
          },
            h('rect', { className: 'tm-tl-played', 'data-tm-played': '1', x: tl.x0, y: tl.top - 4, width: 0, height: tl.height - tl.top }),
            tl.idle
              ? h('g', { key: 'idle', 'data-tm-gantt-idle': '1' },
                h('rect', {
                  className: 'tm-tl-idle',
                  x: tl.idle.x,
                  y: tl.top - 2,
                  width: tl.idle.width,
                  height: tl.height - tl.top - 4,
                  rx: 4,
                }),
                tl.idle.width > 70
                  ? h('text', {
                    className: 'tm-tl-idle-label',
                    x: tl.idle.x + Math.min(10, tl.idle.width / 2),
                    y: tl.top + 12,
                  }, tl.idle.label)
                  : null)
              : null,
            tl.ticks.map((tick) => {
              const anchor = tick.x <= tl.x0 + 18 ? 'start' : (tick.x >= tl.x1 - 18 ? 'end' : 'middle')
              return h('g', { key: 'tick-' + tick.ts },
                h('line', { className: 'tm-tl-grid', x1: tick.x, y1: tl.top - 2, x2: tick.x, y2: tl.height - 6 }),
                h('text', { className: 'tm-tl-tick', x: tick.x, y: tl.top - 8, textAnchor: anchor }, tick.label))
            }),
            h('text', { className: 'tm-tl-tick', x: tl.x0 - 8, y: tl.top - 8, textAnchor: 'end' }, '相对'),
            h('text', { className: 'tm-tl-group', x: 8, y: tl.groups.tasks.y }, tl.groups.tasks.label),
            rows,
            tl.memberRows.length > 0
              ? h('text', { className: 'tm-tl-group', x: 8, y: tl.groups.members.y }, tl.groups.members.label)
              : null,
            memberRows,
            h('text', { className: 'tm-tl-group', x: 8, y: tl.groups.events.y }, tl.groups.events.label),
            h('line', { className: 'tm-tl-grid', x1: tl.x0, y1: tl.eventsY, x2: tl.x1, y2: tl.eventsY }),
            eventNodes,
            h('text', { className: 'tm-tl-group', x: 8, y: tl.groups.density.y }, tl.groups.density.label),
            densityNodes,
            h('line', { className: 'tm-tl-playhead', 'data-tm-playhead': '1', x1: tl.x0, y1: tl.top - 2, x2: tl.x0, y2: tl.height - 6 }),
            h('path', {
              className: 'tm-tl-playhead-cap',
              'data-tm-playhead-cap': '1',
              d: 'M0,0 L-5,-8 L5,-8 Z',
              transform: 'translate(' + tl.x0 + ',' + tl.top + ')',
            }))),
        h('div', { className: 'tm-map-foot' },
          h('div', { className: 'tm-legend' },
            h('span', { key: 'wait' }, h('i', { style: { background: 'transparent', border: '1px dashed var(--tm-dim2)', borderRadius: 2 } }), '排队/阻塞'),
            h('span', { key: 'bar' }, h('i', { style: { background: 'var(--tm-route)', borderRadius: 2 } }), '执行中'),
            h('span', { key: 'done' }, h('i', { style: { background: 'transparent', border: '1.5px solid var(--tm-done)', borderRadius: 1, transform: 'rotate(45deg)' } }), '完成'),
            h('span', { key: 'ev' }, h('i', { style: { background: 'var(--tm-dim)' } }), '审批/交付/启动'),
            tl.idle ? h('span', { key: 'idle' }, h('i', { style: { background: 'transparent', border: '1px dashed var(--tm-line2)', borderRadius: 2 } }), '会话前空闲') : null),
          h('span', { className: 'tm-hint' }, prep.tailTrimmed ? ('已剔除收尾记录 ' + fmtDurCn(prep.tailMs)) : '未来事件置灰')))
    }
    const GanttPanel = memo(GanttInner)

    // ------------------------------------------------------------------
    // 侧栏：任务详情 / 总览（完整版在 W2.5；此处先给可用骨架）
    // ------------------------------------------------------------------
    function StatusPill(props) {
      const status = props.status
      return h('span', { className: 'tm-pill ' + (STATUS_CLASS[status] || '') },
        status === 'in_progress' ? h('i', { style: { background: 'var(--tm-run)' } }) : null,
        props.label || STATUS_LABEL[status] || status)
    }

    function KVCard(props) {
      return h('div', { className: 'tm-kv-card' },
        h('div', { className: 'tm-kv-k' }, props.label),
        h('div', { className: 'tm-kv-v' }, props.value, props.sub ? h('small', null, props.sub) : null))
    }

    function TaskDetail(props) {
      const task = props.task
      const prep = props.prep
      const store = useThrottledTime(props.store, 200)
      const moment = store.getTime()
      // 「未来不剧透」：所有派生数据都以 replay currentTime 为准，未来的事件/指标不展示。
      const createdAt = finite(task.createdAt) === null ? 0 : task.createdAt
      const startedAt = finite(task.startedAt)
      const completedAt = finite(task.completedAt)
      const failedAt = finite(task.failedAt)
      const created = createdAt <= moment
      const started = startedAt !== null && startedAt <= moment
      const completed = completedAt !== null && completedAt <= moment
      const failed = failedAt !== null && failedAt <= moment
      const futureCreated = !created
      const status = statusAtTime(task, moment)
      const detailState = futureCreated
        ? 'future'
        : (!started
          ? (status === 'blocked' ? 'blocked' : 'pending')
          : (completed ? 'done' : (failed ? 'failed' : 'running')))
      const color = prep.ownerColors[task.owner] || '#94a3b8'
      const displayMoment = displayMomentFor(prep, moment)
      const elapsedMs = started ? Math.max(0, (completed ? completedAt : displayMoment) - startedAt) : null
      const queueMs = started ? Math.max(0, startedAt - createdAt) : (created ? Math.max(0, moment - createdAt) : null)
      const queueOpen = !started && created
      const totalCycle = futureCreated ? null : Math.max(0, (completed ? completedAt : displayMoment) - createdAt)
      const readyAt = finite(task.readyAt)
      const readyReached = readyAt !== null && readyAt <= moment
      const blockersRemaining = task.blockedBy.filter((blockerId) => {
        const blocker = prep.taskById[blockerId]
        return !blocker || statusAtTime(blocker, moment) !== 'completed'
      }).length
      const phaseIntervals = buildPhaseIntervals(task, moment)
      const taskHistory = taskChangeEntries(prep, task.id, moment)
      const relationChildTasks = relationChildrenOf(prep, task.id)
      const relationParentId = relationParentOf(prep, task.id)
      const relationParentTask = relationParentId ? prep.taskById[relationParentId] : null
      const relationNotes = ((prep.relation && prep.relation.byParent[task.id]) || [])
        .map((relation) => relation.note)
        .filter(Boolean)
      const unfinishedChildren = relationChildTasks.filter((child) => statusAtTime(child, moment) !== 'completed')
      const relationAlert = statusAtTime(task, moment) === 'completed' && unfinishedChildren.length > 0
      const invalidRelationRefs = invalidRelationsOf(prep).filter(
        (relation) => relation.parent === task.id || relation.children.indexOf(task.id) >= 0,
      )
      const handoff = started ? handoffForTask(prep.waits, task.id) : null
      const activityEnd = started ? (completed ? completedAt : displayMoment) : null
      const inferredSpans = activityEnd === null
        ? []
        : taskSpansInWindow(task, prep.spans, activityEnd).filter((span) => finite(span.start) !== null && span.start <= moment)
      inferredSpans.sort((left, right) => left.start - right.start)
      // tool/job 可能对同一次调用各记一条（如 bash，结束时间略有差异），
      // 展示时按 name + 起始时间（≤2s 内）去重，避免重复行。
      const toolStarts = new Map()
      for (const span of inferredSpans) {
        if (span.kind !== 'tool') continue
        const name = span.name || span.label
        if (!toolStarts.has(name)) toolStarts.set(name, [])
        toolStarts.get(name).push(span.start)
      }
      const visibleSpans = inferredSpans.filter((span) => {
        if (span.kind !== 'job') return true
        const starts = toolStarts.get(span.name || span.label)
        if (!starts) return true
        return !starts.some((start) => Math.abs(start - span.start) <= 2000)
      })
      const spanTotal = finite(task.spanCount) !== null
        ? (started ? task.spanCount : 0)
        : visibleSpans.length
      const spansShown = visibleSpans.slice(0, 10)
      const descriptionLimit = prep.viewLevel && finite(prep.viewLevel.description) !== null
        ? prep.viewLevel.description
        : 500
      const truncatedDetail = prep.spansTruncated || (prep.viewLevel && prep.viewLevel.spans !== null)
      const phaseColor = (phaseStatus) => {
        if (phaseStatus === 'completed') return 'var(--tm-done)'
        if (phaseStatus === 'in_progress') return 'var(--tm-run)'
        if (phaseStatus === 'failed') return 'var(--tm-fail)'
        if (phaseStatus === 'blocked') return 'var(--tm-blocked)'
        return 'var(--tm-pend)'
      }
      const spanIcon = (span) => (span.kind === 'job' ? '⚙' : (span.kind === 'approval' ? '⏸' : '⚡'))
      return h('div', {
        className: 'tm-side-inner',
        'data-tm-detail': task.id,
        'data-tm-detail-state': detailState,
      },
        h('div', { className: 'tm-side-head' },
          h('span', { className: 'tm-sec-title' }, '任务详情'),
          h('button', {
            className: 'tm-btn',
            type: 'button',
            style: { height: 22, minWidth: 22, fontSize: 11 },
            'aria-label': '返回总览（Esc）',
            onClick: props.onClear,
          }, '✕ 返回')),
        h('div', null, h('h3', { className: 'tm-title-h3' }, task.id.toUpperCase() + ' · ' + task.subject)),
        h('div', { className: 'tm-chipsline' },
          h(StatusPill, {
            status: futureCreated ? 'future' : status,
            label: futureCreated ? '未创建（计划）' : undefined,
          }),
          h('span', { className: 'tm-pill' },
            h('i', { style: { background: color } }),
            task.owner || '未指派',
            task.ownerIsLead ? ' · Lead' : ''),
          started ? h('span', { className: 'tm-pill' }, '开始第 ' + (task.startRank === null ? '—' : task.startRank)) : null,
          completed ? h('span', { className: 'tm-pill' }, '完成第 ' + (task.doneRank === null ? '—' : task.doneRank)) : null,
          task.isNew && !futureCreated ? h('span', { className: 'tm-pill tm-running' }, 'NEW') : null),
        futureCreated
          ? h('div', { className: 'tm-note' },
            '该任务在回放时刻尚未创建。标题/负责人/依赖来自计划快照；完成时间与耗时在创建前不展示。')
          : (started && !completed && !failed
            ? h('div', { className: 'tm-note' }, '执行中：耗时与状态截至回放时刻（非最终结果）。')
            : null),
        h('div', { className: 'tm-kv' },
          h(KVCard, {
            label: '执行耗时',
            value: futureCreated || !started
              ? '—'
              : (completed || failed ? fmtDur(task.execMs !== null ? task.execMs : elapsedMs) : '已跑 ' + fmtDur(elapsedMs)),
          }),
          h(KVCard, {
            label: '排队等待',
            value: queueOpen ? '排队中 ' + fmtDur(queueMs) : (started ? fmtDur(task.queueMs !== null ? task.queueMs : queueMs) : '—'),
          }),
          h(KVCard, {
            label: '依赖阻塞',
            value: readyReached
              ? fmtDur(task.blockedWaitMs)
              : (task.blockedBy.length > 0 && !futureCreated ? '等待依赖（剩 ' + blockersRemaining + '）' : '—'),
          }),
          h(KVCard, {
            label: '就绪后延迟',
            value: readyReached && started && task.readyDelayMs !== null ? fmtDur(task.readyDelayMs) : '—',
          }),
          h(KVCard, {
            label: handoff ? '交接间隔（' + handoff.from + '→本任务）' : '交接间隔',
            value: handoff ? fmtDur(handoff.gapMs) : '—',
          }),
          h(KVCard, { label: '总周期', value: totalCycle === null ? '—' : fmtDur(totalCycle) })),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '时间'),
          h('div', { className: 'tm-rows', style: { marginTop: 5 } },
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '创建'),
              h('span', { className: 'tm-rv' }, futureCreated ? '计划任务（尚未创建）' : fmtHmSec(createdAt))),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '开始执行'),
              h('span', { className: 'tm-rv' }, started ? fmtHmSec(startedAt) : '—')),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '完成'),
              h('span', { className: 'tm-rv' }, completed ? fmtHmSec(completedAt) : (failed ? '失败 · ' + fmtHmSec(failedAt) : '未完成'))),
            readyReached
              ? h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '依赖全部就绪'), h('span', { className: 'tm-rv' }, fmtHmSec(readyAt)))
              : null)),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '状态区间（截至回放时刻）'),
          phaseIntervals.length > 0
            ? h('div', { style: { marginTop: 4 } },
              phaseIntervals.map((interval, index) => h('div', { className: 'tm-phase', key: 'phase-' + index },
                h('span', { className: 'tm-pdot', style: { background: phaseColor(interval.status) } }),
                h('span', { className: 'tm-pn' }, STATUS_LABEL[interval.status] || interval.status),
                h('span', { className: 'tm-pd' },
                  interval.to !== null
                    ? fmtDur(interval.ms) + ' · ' + fmtHm(interval.from) + '→' + fmtHm(interval.to)
                    : (interval.status === 'completed' ? '已完成'
                      : interval.status === 'failed' ? '失败'
                        : interval.status === 'blocked' ? '已阻塞'
                          : '进行中') + ' · ' + fmtHm(interval.from) + ' 起（已 ' + fmtDur(interval.ms) + '）'))))
            : h('div', { className: 'tm-live-line', style: { marginTop: 2 } },
              futureCreated ? '回放时刻尚未创建，无状态区间。' : '暂无状态记录。')),
        task.blockedBy.length > 0
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, '依赖（blockedBy）'),
            h('div', { className: 'tm-chipsline', style: { marginTop: 5 } },
              task.blockedBy.map((blockerId) => {
                const blocker = prep.taskById[blockerId]
                const done = blocker ? statusAtTime(blocker, moment) === 'completed' : false
                return h('button', {
                  key: blockerId,
                  className: 'tm-chipbtn' + (done ? '' : ' tm-dep-off'),
                  type: 'button',
                  onClick: () => props.onSelect(blockerId),
                }, blockerId + (blocker ? ' · ' + truncateText(blocker.subject, 12) : '') + (done ? ' ✓' : ' ○'))
              })))
          : null,
        relationParentId
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, '支线归属'),
            h('div', { className: 'tm-chipsline', style: { marginTop: 4 } },
              h('button', {
                className: 'tm-chipbtn',
                type: 'button',
                'data-tm-relation-parent': relationParentId,
                onClick: () => props.onSelect(relationParentId),
              }, '属于 ' + relationParentId + ' 的支线', relationParentTask ? ' · ' + truncateText(relationParentTask.subject, 14) : '')))
          : null,
        relationChildTasks.length > 0
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, '支线（' + relationChildTasks.length + '）'),
            h('div', { className: 'tm-relation-children' },
              relationChildTasks.map((child) => h('button', {
                key: 'rel-child-' + child.id,
                className: 'tm-relation-child',
                type: 'button',
                'data-tm-relation-child': child.id,
                onClick: () => props.onSelect(child.id),
              },
                h('span', { className: 'tm-rc-id' }, child.id),
                h('span', { className: 'tm-rc-subject' }, truncateText(child.subject, 18)),
                h(StatusPill, { status: statusAtTime(child, moment) }),
                h('span', { className: 'tm-rc-owner' }, child.owner || '未指派')))),
            relationAlert
              ? h('div', { className: 'tm-note', 'data-tm-relation-alert': 'true' },
                '父任务已完成，' + unfinishedChildren.length + ' 个子任务未完成（仅提示，不改任务状态）')
              : null,
            relationNotes.map((note) => h('div', { className: 'tm-live-line', key: 'rel-note-' + note }, '备注：' + note)))
          : null,
        invalidRelationRefs.length > 0
          ? h('div', {
            className: 'tm-note',
            'data-tm-relation-invalid': 'true',
            'data-tm-invalid-relations': String(invalidRelationRefs.length),
          },
            '关系记录引用了不存在的任务：' +
            invalidRelationRefs.map((relation) => relation.missing.join('、')).join('；') +
            '（已忽略，不影响任务状态）')
          : null,
        taskHistory.length > 0
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, '变更历史'),
            h('div', { className: 'tm-changes', 'data-tm-task-changes': task.id },
              taskHistory.map((entry, index) => h('button', {
                key: 'task-change-' + index + '-' + entry.at,
                className: 'tm-change',
                type: 'button',
                'data-tm-change': '1',
                'data-tm-change-kind': entry.kind,
                'data-tm-change-at': String(entry.at),
                'data-tm-change-task': entry.taskId || '',
                'data-tm-change-jump': '1',
                onClick: () => {
                  try {
                    props.store.pause()
                    props.store.setTime(entry.at)
                  } catch (error) { recordError('detail.changeJump', error) }
                },
              },
                h('span', { className: 'tm-change-time' }, '+' + fmtClock(entry.at - prep.timeStart)),
                h('span', { className: 'tm-change-kind tm-kind-' + (entry.kind || 'other') }, changeKindLabel(entry.kind)),
                h('span', { className: 'tm-change-text' }, entry.text || entry.taskId)))))
          : null,
        task.writeScopes.length > 0 && !futureCreated
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, '写入范围 ' + task.writeScopes.length),
            h('div', { className: 'tm-rows', style: { marginTop: 5 } },
              task.writeScopes.slice(0, 6).map((scope) => h('div', { className: 'tm-row', key: scope },
                h('span', { className: 'tm-rl', style: { fontFamily: 'ui-monospace,Menlo,monospace', fontSize: 10 } }, scope))),
              task.writeScopes.length > 6
                ? h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl', style: { color: 'var(--tm-dim2)' } }, '… 其余 ' + (task.writeScopes.length - 6) + ' 项'))
                : null))
          : null,
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '执行过程（按时间窗推断）'),
          h('div', { className: 'tm-live-line', style: { marginTop: 2 } },
            futureCreated || !started
              ? (futureCreated ? '回放时刻尚未创建，无执行过程。' : '回放时刻尚未开始，无执行过程。')
              : '共 ' + spanTotal + ' 条（截至回放时刻，按时间窗推断）',
            started && truncatedDetail ? '（大会话下明细已截断，仅展示最近 ' + Math.min(spanTotal, spansShown.length) + ' 条）' : ''),
          spansShown.length > 0
            ? h('div', { style: { marginTop: 2 } },
              spansShown.map((span, index) => h('div', {
                className: 'tm-act',
                key: 'act-' + index + '-' + span.start,
                onClick: () => { try { props.store.setTime(span.start) } catch (error) { recordError('detail.jump', error) } },
              },
                h('div', { className: 'tm-ic' }, spanIcon(span)),
                h('div', { className: 'tm-al' },
                  h('div', { className: 'tm-an' },
                    truncateText(span.name || span.label || span.kind, 26),
                    span.status === 'error' ? h('span', { style: { color: 'var(--tm-fail)' } }, ' · 失败') : null),
                  h('div', { className: 'tm-at' }, fmtHmSec(span.start) + ' → ' + (finite(span.end) !== null ? fmtHmSec(span.end) : '进行中'))),
                h('div', { className: 'tm-ad' }, finite(span.end) !== null ? fmtDur(span.end - span.start) : '—'))))
            : (started
              ? h('div', { className: 'tm-placeholder', style: { padding: '10px 4px', minHeight: 36 } },
                h('div', { className: 'tm-placeholder-sub' },
                  truncatedDetail && spanTotal > 0
                    ? '大会话下执行过程明细已截断（共 ' + spanTotal + ' 条），当前视图未保留该时间窗明细；可按时间窗推断归属。'
                    : '该任务的执行活动未被事件流单独标记（归属按时间窗推断，可能与并行任务重复）。'))
              : null)),
        task.description
          ? h('div', null,
            h('div', { className: 'tm-sec-title' }, futureCreated ? '任务描述（计划）' : '任务描述'),
            h('div', { className: 'tm-desc' },
              truncateText(task.description, 240),
              descriptionLimit < 500 ? h('div', { className: 'tm-live-line' }, '（大会话下降级：描述已截断至 ' + descriptionLimit + ' 字符）') : null))
          : null,
        h('div', { className: 'tm-btnrow' },
          h('button', {
            className: 'tm-btn',
            type: 'button',
            'data-tm-jump-start': '1',
            onClick: () => props.store.setTime(finite(task.startedAt) !== null ? task.startedAt : task.createdAt),
          }, '跳到开始'),
          h('button', {
            className: 'tm-btn',
            type: 'button',
            'data-tm-jump-end': '1',
            onClick: () => props.store.setTime(finite(task.completedAt) !== null ? task.completedAt : moment),
          }, '跳到完成')),
        h('div', { className: 'tm-footnote' },
          '负责人 / 依赖来自 team/task 事件；执行过程是把「执行中」时间窗内的工具调用与后台任务按时间重叠推断的，不是精确归属（并行任务可能重复归因）。'))
    }

    function Overview(props) {
      const prep = props.prep
      const store = useDiscrete(props.store)
      useThrottledTime(props.store, 400)
      const playing = store.isPlaying()
      const atEnd = store.isAtEnd()
      const moment = store.getTime()
      const counts = countsAtTime(prep.tasks, moment)
      const stats = prep.stats
      const waits = prep.waits || {}
      const usage = prep.usage
      const activeAgents = activeMembersAt(prep.members, moment)
      const changeLog = visibleChangeLog(prep.changes, moment)
      const changeCounts = asOfChangeCounts(prep, moment)
      const donePercent = counts.total > 0 ? Math.min(100, Math.round((counts.completed / counts.total) * 100)) : 0
      const waitRows = [
        { label: '会话前空闲', value: waits.preTurnMs, note: waits.preTurnRestored ? '会话从历史恢复（无创建→开工等待）' : '会话创建到首轮开工', cls: 'tm-slate' },
        { label: '任务排队', value: waits.queueMs, note: '创建后等待开始执行', cls: '' },
        { label: '依赖阻塞', value: waits.blockedMs, note: 'blockedBy 未完成导致无法开始', cls: 'tm-rose' },
        { label: '就绪后延迟', value: waits.readyDelayMs, note: '依赖就绪后到实际开始', cls: '' },
        { label: '任务执行累计', value: waits.taskExecMs, note: '各任务执行耗时之和（并行时 > 墙钟）', cls: '' },
        { label: '等待代理', value: waits.waitAgentMs, note: 'wait_agent 工具等待团队成员', cls: 'tm-blue' },
        { label: '用户问答', value: waits.askUserMs, note: 'ask_user_question 等待用户回答', cls: 'tm-blue' },
        { label: '审批等待', value: waits.approvalMs, note: 'approval asked → decided', cls: 'tm-slate' },
        { label: '人工闲置', value: waits.humanIdleMs, note: '轮次之间的人工空闲', cls: 'tm-slate' },
      ].filter((row) => finite(row.value) !== null)
      const plan = prep.plan && prep.plan.active ? prep.plan : null
      const planStatusLabel = { completed: '已完成', in_progress: '进行中', pending: '待处理' }
      const planStatusIcon = { completed: '✓', in_progress: '●', pending: '○' }
      let waitMax = 1
      for (const row of waitRows) if (row.value > waitMax) waitMax = row.value
      const wallClock = finite(waits.wallClockMs) !== null ? waits.wallClockMs : prep.durationMs
      const execTotal = finite(waits.taskExecMs) !== null ? waits.taskExecMs : 0
      return h('div', { className: 'tm-side-inner', 'data-tm-overview': '1' },
        h('div', { className: 'tm-side-head' },
          h('span', { className: 'tm-sec-title' }, '回放总览'),
          h('span', { className: 'tm-pill' + (playing ? ' tm-running' : '') },
            playing ? '回放中' : (atEnd ? '停在最新' : '已暂停'))),
        h('div', null, h('h3', { className: 'tm-title-h3' }, prep.title)),
        h('div', { className: 'tm-chipsline' },
          h('span', { className: 'tm-pill' }, stats.total + ' 个任务'),
          h('span', { className: 'tm-pill' }, prep.members.length + ' 个代理'),
          h('span', { className: 'tm-pill' }, fmtInt(prep.counters.toolCalls || 0) + ' 次工具调用'),
          prep.spansTruncated ? h('span', { className: 'tm-pill tm-fail' }, '明细已截断') : null),
        h('div', { className: 'tm-wcard' },
          h('div', { className: 'tm-wcard-t' }, '任务完成度 · 回放时刻'),
          h('div', { className: 'tm-wcard-v', 'data-tm-ov-completed': String(counts.completed) },
            String(counts.completed), h('small', null, ' / ' + counts.total)),
          h('div', { className: 'tm-progressbar', style: { marginTop: 7 } },
            h('i', { style: { width: donePercent + '%' } })),
          h('div', { className: 'tm-live-line' },
            '已完成 ', h('b', null, String(counts.completed)),
            ' · 进行中 ', h('b', null, String(counts.in_progress)),
            ' · 待开始 ', h('b', null, String(counts.pending + counts.blocked))),
          h('div', { className: 'tm-live-line' },
            '活跃代理 ', h('b', { 'data-tm-ov-agents': String(activeAgents.length) }, String(activeAgents.length)),
            ' · Token 累计 ', h('b', null, fmtInt(usage.total)))),
        h('div', { className: 'tm-kv' },
          h(KVCard, { label: '任务执行累计', value: fmtDur(execTotal) }),
          h(KVCard, { label: prep.tailTrimmed ? '墙钟（已剔除收尾）' : '墙钟时长', value: fmtDur(wallClock) }),
          h(KVCard, { label: '队列等待累计', value: fmtDur(waits.queueMs) }),
          h(KVCard, { label: '最长交接', value: fmtDur(waits.maxHandoffMs) })),
        prep.tailTrimmed
          ? h('div', { className: 'tm-note' },
            '会话末尾有 ' + fmtDurCn(prep.tailMs) + ' 的收尾记录（无任务/工具活动），已从回放范围与墙钟统计中剔除。')
          : null,
        plan
          ? h('div', { className: 'tm-plan-section', 'data-tm-plan': '1', 'data-tm-plan-counts': plan.counts.completed + '/' + plan.counts.inProgress + '/' + plan.counts.pending, role: 'region', 'aria-label': '会话计划（todo）' },
            h('div', { className: 'tm-sec-title' },
              '会话计划（todo）',
              h('span', { className: 'tm-plan-write' }, plan.writeCount + ' 次计划更新')),
            h('div', { className: 'tm-chipsline', style: { marginTop: 4 } },
              h('span', { className: 'tm-pill tm-done', 'data-tm-plan-count': 'completed' }, '已完成 ' + plan.counts.completed),
              h('span', { className: 'tm-pill tm-running', 'data-tm-plan-count': 'in-progress' }, '进行中 ' + plan.counts.inProgress),
              h('span', { className: 'tm-pill', 'data-tm-plan-count': 'pending' }, '待处理 ' + plan.counts.pending)),
            h('div', { className: 'tm-plan-list', role: 'list' },
              plan.items.map((item) => h('div', {
                key: 'plan-' + item.id,
                className: 'tm-plan-item tm-plan-' + item.status,
                role: 'listitem',
                'data-tm-plan-item': '1',
                'data-tm-plan-status': item.status,
                'data-tm-plan-id': item.id,
              },
                h('span', { className: 'tm-plan-icon', 'aria-hidden': 'true' }, planStatusIcon[item.status] || '○'),
                h('span', { className: 'tm-plan-text' }, truncateText(item.content, 42)),
                item.updatedAt !== null ? h('span', { className: 'tm-plan-time' }, fmtHm(item.updatedAt)) : null))),
            h('div', { className: 'tm-live-line' }, '计划来自会话 todo；执行任务见左侧任务图。'),
            h('span', { className: 'tm-visually-hidden' }, '计划状态：' + plan.items.map((item) => planStatusLabel[item.status] + ' ' + item.content).join('；')))
          : null,
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '等待时间拆解'),
          h('div', { style: { marginTop: 6 } },
            waitRows.map((row) => h('div', { key: row.label, style: { marginBottom: 4 } },
              h('div', { className: 'tm-row' },
                h('span', { className: 'tm-rl', style: { flex: 'none', width: 82, fontSize: 10.5 } }, row.label),
                h('span', { className: 'tm-bar-track' },
                  h('span', { className: 'tm-bar-fill ' + row.cls, style: { width: Math.max(2, Math.round((row.value / waitMax) * 100)) + '%' } })),
                h('span', { className: 'tm-rv', style: { width: 64, textAlign: 'right' } }, fmtDur(row.value))))),
            waits.preTurnRestored
              ? h('div', { className: 'tm-live-line' }, '· 本会话从历史恢复，无「创建→首轮开工」等待')
              : null)),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '累计执行 vs 墙钟'),
          h('div', { className: 'tm-rows', style: { marginTop: 5 } },
            h('div', { className: 'tm-row' },
              h('span', { className: 'tm-rl' }, '任务执行累计（Σ 任务耗时）'),
              h('span', { className: 'tm-rv' }, fmtDur(execTotal))),
            h('div', { className: 'tm-row' },
              h('span', { className: 'tm-rl' }, '会话墙钟（创建→内容结束）'),
              h('span', { className: 'tm-rv' }, fmtDur(wallClock))),
            h('div', { className: 'tm-row' },
              h('span', { className: 'tm-rl' }, '累计 / 墙钟'),
              h('span', { className: 'tm-rv' }, wallClock > 0 ? (execTotal / wallClock).toFixed(2) + '×' : '—'))),
          h('div', { className: 'tm-live-line' }, '并行执行时累计会大于墙钟，两者不可直接比较。')),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '计划基线 / 变更'),
          prep.baseline
            ? h('div', { className: 'tm-live-line', style: { marginTop: 2 } },
              '计划基线 ' + prep.baseline.taskIds.length + ' 个任务 · 封板 ' + fmtHm(prep.baseline.closedAt !== null ? prep.baseline.closedAt : prep.baseline.at) +
              (prep.baseline.open ? '（记录中）' : ''))
            : h('div', { className: 'tm-live-line', style: { marginTop: 2 } }, '未记录计划基线（会话没有任务集合快照）'),
          h('div', { className: 'tm-chipsline', style: { marginTop: 4 } },
            h('span', { className: 'tm-pill tm-running' }, '新增 ', h('b', { 'data-tm-change-added': String(changeCounts.added) }, String(changeCounts.added))),
            h('span', { className: 'tm-pill tm-fail' }, '移除 ', h('b', null, String(changeCounts.removed))),
            h('span', { className: 'tm-pill' }, '依赖变更 ', h('b', null, String(changeCounts.dependencyChanged))),
            h('span', { className: 'tm-pill' }, '拆分 ', h('b', null, String(changeCounts.splits)))),
          h('div', {
            className: 'tm-changes',
            'data-tm-changes': '1',
            'data-tm-changes-visible': String(changeCounts.visible),
            'data-tm-baseline-count': String(prep.baseline ? prep.baseline.taskIds.length : 0),
            'data-tm-added-count': String(changeCounts.added),
          },
            changeLog.length > 0
              ? changeLog.map((entry, index) => h('button', {
                key: 'change-' + index + '-' + entry.at + '-' + entry.seq,
                className: 'tm-change',
                type: 'button',
                'data-tm-change': '1',
                'data-tm-change-kind': entry.kind,
                'data-tm-change-at': String(entry.at),
                'data-tm-change-task': entry.taskId || '',
                'data-tm-change-jump': '1',
                onClick: () => {
                  try {
                    store.pause()
                    store.setTime(entry.at)
                    const target = changeTargetTaskId(entry, prep.taskById)
                    if (target && typeof props.onSelect === 'function') props.onSelect(target)
                    if (entry.kind === 'split' && Array.isArray(entry.children) && typeof props.onHighlightChildren === 'function') {
                      props.onHighlightChildren(entry.children)
                    }
                  } catch (error) { recordError('change.jump', error) }
                },
              },
                h('span', { className: 'tm-change-time' }, '+' + fmtClock(entry.at - prep.timeStart)),
                h('span', { className: 'tm-change-kind tm-kind-' + (entry.kind || 'other') }, changeKindLabel(entry.kind)),
                h('span', { className: 'tm-change-text' }, entry.text || entry.taskId)))
              : h('div', { className: 'tm-live-line', style: { marginTop: 2 } },
                prep.changes.log.length > 0 ? '回放时刻暂无计划变更（未来变更尚未发生）' : '未检测到基线后变更')),
          changeCounts.hidden > 0
            ? h('div', { className: 'tm-live-line' }, '另有 ' + changeCounts.hidden + ' 条未来变更（回放中隐藏）')
            : null,
          prep.changes.removed.length > 0
            ? h('div', { className: 'tm-chipsline', style: { marginTop: 4 } },
              prep.changes.removed.map((id) => h('span', { key: 'rm-' + id, className: 'tm-pill tm-fail' }, '已移除 ' + id)))
            : null,
          (() => {
            const invalidRelations = invalidRelationsOf(prep)
            if (invalidRelations.length === 0) return null
            return h('div', {
              className: 'tm-note',
              style: { marginTop: 5 },
              'data-tm-relation-invalid': 'true',
              'data-tm-invalid-relations': String(invalidRelations.length),
            },
              '关系记录引用了不存在的任务：' +
              invalidRelations.map((relation) => relation.missing.join('、')).join('；') +
              '（已忽略，不计入拆分变更，不影响任务状态）')
          })()),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, '活跃代理 · 回放时刻'),
          prep.members.length > 0
            ? h('div', { className: 'tm-chipsline', style: { marginTop: 4 } },
              prep.members.map((member) => {
                const phase = memberPhaseAt(member, moment)
                const active = phase && phase.phase === 'active'
                const color = active ? 'var(--tm-done)' : (phase && phase.phase === 'failed' ? 'var(--tm-fail)' : 'var(--tm-dim2)')
                return h('span', {
                  key: member.id,
                  className: 'tm-pill',
                  style: { opacity: active ? 1 : 0.72 },
                },
                  h('i', { style: { background: color } }),
                  member.name,
                  active ? '' : '（' + (phase ? (phase.phase === 'failed' ? '失败' : (phase.phase === 'provisioning' ? '创建中' : phase.phase)) : '未创建') + '）')
              }))
            : h('div', { className: 'tm-live-line' }, '本会话没有记录代理成员')),
        h('div', null,
          h('div', { className: 'tm-sec-title' }, 'Token'),
          h('div', { className: 'tm-rows', style: { marginTop: 5 } },
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '输入'), h('span', { className: 'tm-rv' }, fmtInt(usage.input))),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '输出'), h('span', { className: 'tm-rv' }, fmtInt(usage.output))),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '缓存读'), h('span', { className: 'tm-rv' }, fmtInt(usage.cacheRead))),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '缓存写'), h('span', { className: 'tm-rv' }, fmtInt(usage.cacheWrite))),
            h('div', { className: 'tm-row' }, h('span', { className: 'tm-rl' }, '合计'), h('span', { className: 'tm-rv' }, fmtInt(usage.total))))),
        prep.warnings.length > 0
          ? h('div', { className: 'tm-note' }, '数据提示：' + prep.warnings.length + ' 条引用缺失（如 blockedBy/关系指向不存在的任务），已忽略缺失项。')
          : null,
        h('div', { className: 'tm-footnote' },
          '等待拆解来自会话事件时间戳（team/task、turn、tool、approval、wait_agent）；执行过程为按时间窗推断。',
          '点击流程图节点或甘特任务条查看任务详情（Esc 返回总览）。'))
    }

    function SidePanel(props) {
      const prep = props.prep
      const selected = props.selectedId ? prep.taskById[props.selectedId] : null
      return h('aside', { className: 'tm-panel tm-side', 'data-tm-panel': 'side' },
        selected
          ? h(TaskDetail, {
            task: selected,
            prep,
            store: props.store,
            onClear: props.onClear,
            onSelect: props.onSelect,
          })
          : h(Overview, {
            prep,
            store: props.store,
            onSelect: props.onSelect,
            onHighlightChildren: props.onHighlightChildren,
          }))
    }

    // ------------------------------------------------------------------
    // 空状态 / 错误状态
    // ------------------------------------------------------------------
    function EmptyState(props) {
      const prep = props.prep
      const counters = prep.counters || {}
      const hasEvents = (finite(prep.asOfSeq) || 0) > 0 || (finite(counters.toolCalls) || 0) > 0
      return h('div', { className: 'tm-empty', 'data-tm-empty-state': prep.emptyReason || 'no-task-board' },
        h('div', { className: 'tm-empty-icon' }, '🗺'),
        h('h3', { className: 'tm-empty-title' }, '本会话未维护任务清单'),
        h('div', { className: 'tm-empty-sub' },
          'AI 没有使用 Agent Teams 任务板（team/task）或 todo_write 清单，因此没有可展示的任务。插件只读派生，不会伪造任务。'),
        h('div', { className: 'tm-empty-actions' },
          h('div', null, '想看到任务地图，可以在对话里让 AI：'),
          h('div', null, '· 使用 Agent Teams 任务板：', h('code', null, '创建任务 / 领取任务 / 更新任务状态')),
          h('div', null, '· 或使用 todo 清单：', h('code', null, 'todo_write')),
          h('div', null, '然后回到本页签，任务会随会话事件实时出现。')),
        h('div', { className: 'tm-empty-meta' },
          hasEvents
            ? '本会话已有 ' + fmtInt(counters.toolCalls || 0) + ' 次工具调用 / ' +
              fmtInt(counters.steps || 0) + ' 个执行步骤 / ' + prep.turns.length + ' 轮对话，但未记录任务清单。'
            : '该会话还没有事件记录。',
          prep.emptyReason ? '（' + prep.emptyReason + '）' : ''))
    }

    function ErrorCard(props) {
      return h('div', { className: 'tm-error', 'data-tm-error': '1' },
        h('h3', { className: 'tm-error-title' }, props.title || '任务地图暂时不可用'),
        h('div', { className: 'tm-error-sub' }, props.message || '读取会话投影失败。可以切到对话页签再切回来重试；若持续出现，请在插件问题中附上下方信息。'),
        props.detail ? h('div', { className: 'tm-error-detail' }, props.detail) : null)
    }

    // ------------------------------------------------------------------
    // 根视图
    // ------------------------------------------------------------------
    function readProjection(props) {
      let projection = null
      let projectionError = ''
      try {
        if (props && typeof props.useProjection === 'function') projection = props.useProjection('taskMap')
        else projectionError = '宿主未提供会话投影能力（useProjection 缺失）'
      } catch (error) {
        projectionError = '读取投影失败：' + str(error)
      }
      return { projection, projectionError }
    }

    function SessionViewInner(props) {
      const renderStart = nowMs()
      const sessionId = text(props && props.sessionId)
      const projectionState = readProjection(props)
      const [, forcePreview] = React.useState(0)
      React.useEffect(() => previewStore.subscribe(() => forcePreview((value) => value + 1)), [])
      const previewView = previewStore.get()
      const projection = previewView !== null ? previewView : projectionState.projection
      const projectionError = previewView !== null ? '' : projectionState.projectionError

      const prepMemo = React.useMemo(() => {
        try {
          if (projection == null) return { prep: null, error: '' }
          if (!isObject(projection)) return { prep: null, error: '投影值不是对象（' + typeof projection + '）' }
          return { prep: prepareView(projection), error: '' }
        } catch (error) {
          recordError('prepareView', error)
          return { prep: null, error: str(error) }
        }
      }, [projection])
      const prep = prepMemo.prep
      const prepareError = prepMemo.error

      const storeRef = React.useRef(null)
      if (!storeRef.current) {
        storeRef.current = createReplayStore({ start: prep ? prep.timeStart : 0, end: prep ? prep.timeEnd : 1 })
      }
      const store = storeRef.current
      const rootRef = React.useRef(null)
      const pointerInsideRef = React.useRef(false)
      const selectionRef = React.useRef('')
      const highlightRef = React.useRef({ children: [] })
      const highlightTimerRef = React.useRef(null)
      const fitRemeasureRef = useHostFitHeight(rootRef)
      const tipsRef = React.useRef(null)
      if (!tipsRef.current) tipsRef.current = createTooltipStore()
      const tips = tipsRef.current
      const [selectedId, setSelectedId] = React.useState('')
      const [layoutMode, setLayoutModeState] = React.useState(layoutStore.get())
      React.useEffect(() => layoutStore.subscribe((mode) => setLayoutModeState(mode)), [])
      const setLayoutMode = React.useCallback((mode) => {
        try {
          layoutStore.set(mode)
          // 切换单图/双栏后按最新宿主高度重算，避免沿用旧高度
          if (fitRemeasureRef && typeof fitRemeasureRef.current === 'function') fitRemeasureRef.current()
        } catch (error) { recordError('setLayoutMode', error) }
      }, [])

      const selectTask = React.useCallback((id) => {
        try {
          const next = text(id)
          selectionRef.current = next
          setSelectedId(next)
          store.repaint()
        } catch (error) { recordError('selectTask', error) }
      }, [store])

      const clearSelection = React.useCallback(() => {
        try {
          selectionRef.current = ''
          setSelectedId('')
          store.repaint()
        } catch (error) { recordError('clearSelection', error) }
      }, [store])

      const toggleSelect = React.useCallback((id) => {
        if (selectionRef.current === id) clearSelection()
        else selectTask(id)
      }, [selectTask, clearSelection])

      React.useEffect(() => {
        if (!prep) return
        store.updateRange(prep.timeStart, prep.timeEnd)
      }, [prep, store])

      const highlightChildren = React.useCallback((children) => {
        try {
          highlightRef.current = { children: Array.isArray(children) ? children.slice() : [] }
          store.repaint()
          if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
          highlightTimerRef.current = setTimeout(() => {
            highlightTimerRef.current = null
            highlightRef.current = { children: [] }
            store.repaint()
          }, 2600)
        } catch (error) { recordError('highlightChildren', error) }
      }, [store])

      React.useEffect(() => {
        const marker = typeof window !== 'undefined' ? window.__TASK_MAP_M2__ : null
        if (!marker) return
        marker.view = projection || null
        if (!prep) {
          marker.viewStats = { empty: true, error: projectionError || prepareError || 'projection-unavailable' }
          return
        }
        marker.viewStats = {
          sessionId: prep.sessionId || sessionId,
          title: prep.title,
          stateVersion: prep.stateVersion,
          dataSource: prep.dataSource,
          hasTeamBoard: prep.hasTeamBoard,
          tasks: prep.stats.total,
          completed: prep.stats.completed,
          inProgress: prep.stats.in_progress,
          pending: prep.stats.pending,
          failed: prep.stats.failed,
          blocked: prep.stats.blocked,
          spans: prep.spanSummary ? prep.spanSummary.total : prep.spans.length,
          spansTruncated: prep.spansTruncated,
          viewLevel: prep.viewLevel,
          members: prep.members.length,
          turns: prep.turns.length,
          warnings: prep.warnings.length,
          empty: prep.empty,
          timeRange: { start: prep.timeStart, end: prep.timeEnd },
          rawTimeRange: { start: prep.timeStart, end: prep.rawTimeEnd },
          durationMs: prep.durationMs,
          tailMs: prep.tailMs,
          tailTrimmed: prep.tailTrimmed,
          liveMode: prep.liveMode,
        }
      }, [prep, projection, sessionId, projectionError, prepareError])

      React.useEffect(() => {
        const marker = typeof window !== 'undefined' ? window.__TASK_MAP_M2__ : null
        if (!marker) return undefined
        marker.actions = {
          setTime: (value) => store.setTime(value),
          setCurrentTime: (value) => store.setTime(value),
          setLayoutMode: (mode) => { layoutStore.set(mode); return layoutStore.get() },
          play: () => store.play(),
          pause: () => store.pause(),
          toggle: () => store.toggle(),
          setSpeed: (value) => store.setSpeed(value),
          setSelection: (id) => selectTask(id),
          selectTask: (id) => selectTask(id),
          clearSelection: () => clearSelection(),
          getState: () => {
            const counts = prep ? countsAtTime(prep.tasks, store.getTime()) : null
            return {
              currentTime: store.getTime(),
              start: store.getStart(),
              end: store.getEnd(),
              playing: store.isPlaying(),
              speed: store.getSpeed(),
              fps: store.getFps(),
              frameMs: store.getFrameMs(),
              selected: selectionRef.current,
            layoutMode: layoutStore.get(),
              tasks: prep ? prep.stats.total : 0,
              completedAtTime: counts ? counts.completed : 0,
              inProgressAtTime: counts ? counts.in_progress : 0,
              dataSource: prep ? prep.dataSource : null,
              empty: prep ? prep.empty : true,
            }
          },
        }
        marker.getState = () => (marker.actions ? marker.actions.getState() : null)
        return () => {
          marker.actions = null
          marker.getState = null
        }
      }, [store, selectTask, clearSelection, prep])

      React.useEffect(() => {
        const root = rootRef.current
        if (!root) return undefined
        const update = (moment) => {
          try {
            root.setAttribute('data-tm-current-time', String(Math.round(moment)))
            root.setAttribute('data-tm-time', fmtClock(moment - (prep ? prep.timeStart : 0)))
            if (prep) root.setAttribute('data-tm-completed-at', String(countsAtTime(prep.tasks, moment).completed))
            const marker = typeof window !== 'undefined' ? window.__TASK_MAP_M2__ : null
            if (marker) {
              marker.currentTime = Math.round(moment)
              marker.fps = store.getFps()
            }
          } catch (error) { recordError('rootAttrs', error) }
        }
        update(store.getTime())
        return store.onFrame(update)
      }, [store, prep])

      React.useEffect(() => {
        const root = rootRef.current
        if (!root) return undefined
        const sync = () => {
          try {
            root.setAttribute('data-tm-playing', store.isPlaying() ? 'true' : 'false')
            root.setAttribute('data-tm-speed', String(store.getSpeed()))
            const marker = typeof window !== 'undefined' ? window.__TASK_MAP_M2__ : null
            if (marker) {
              marker.playing = store.isPlaying()
              marker.speed = store.getSpeed()
            }
          } catch (error) { recordError('rootDiscrete', error) }
        }
        sync()
        return store.subscribe(sync)
      }, [store])

      React.useEffect(() => {
        const marker = typeof window !== 'undefined' ? window.__TASK_MAP_M2__ : null
        if (marker) {
          marker.selected = selectedId
          marker.lastRenderMs = Math.round((nowMs() - renderStart) * 10) / 10
        }
      })

      React.useEffect(() => {
        if (typeof document === 'undefined') return undefined
        const onKeyDown = (event) => {
          try {
            const target = event.target
            const tag = target && target.tagName ? String(target.tagName).toLowerCase() : ''
            const editable = tag === 'input' || tag === 'textarea' || tag === 'select' ||
              tag === 'button' || tag === 'a' || (target && target.isContentEditable === true)
            if (editable) return
            const active = document.activeElement
            const inside = rootRef.current && active ? rootRef.current.contains(active) : false
            const neutral = !active || active === document.body || active === document.documentElement
            if (!inside && !neutral) return
            if (event.code === 'Space' || event.key === ' ') {
              event.preventDefault()
              store.toggle()
            } else if (event.code === 'ArrowRight') {
              event.preventDefault()
              store.step(STEP_MS)
            } else if (event.code === 'ArrowLeft') {
              event.preventDefault()
              store.step(-STEP_MS)
            } else if (event.code === 'Escape' || event.key === 'Escape') {
              if (selectionRef.current) {
                event.preventDefault()
                clearSelection()
              }
            }
          } catch (error) { recordError('keydown', error) }
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [store, clearSelection])

      React.useEffect(() => {
        if (!selectedId || !prep) return
        if (!prep.taskById[selectedId]) {
          selectionRef.current = ''
          setSelectedId('')
          store.repaint()
        }
      }, [prep, selectedId, store])

      React.useEffect(() => () => {
        try {
          if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current)
          store.dispose()
        } catch (ignored) { /* noop */ }
      }, [store])

      // ---- 渲染 ----
      let body = null
      let isEmpty = false
      if (projectionError) {
        body = h(ErrorCard, {
          title: '任务地图暂时不可用',
          message: projectionError,
          detail: sessionId ? 'sessionId: ' + sessionId : '',
        })
      } else if (projection == null) {
        body = h('div', { className: 'tm-placeholder' },
          h('div', { className: 'tm-placeholder-title' }, '等待会话投影…'),
          h('div', { className: 'tm-placeholder-sub' }, '投影为空（会话可能还没有事件）。任务出现后本页会自动更新。'))
      } else if (prepareError) {
        body = h(ErrorCard, {
          title: '任务地图数据无法解析',
          message: 'buildClientView 输出不符合预期，已降级为局部提示，不影响会话。',
          detail: prepareError,
        })
      } else if (prep.empty) {
        isEmpty = true
        body = h(EmptyState, { prep })
      } else {
        body = h('div', {
          className: 'tm-main tm-layout-' + layoutMode,
          style: { '--tm-flow-share': flowShareForRows(prep.flow.rows) + '%' },
        },
          h(TaskFlow, {
            prep,
            store,
            tips,
            selectionRef,
            highlightRef,
            layoutMode,
            onLayoutMode: setLayoutMode,
            onSelect: toggleSelect,
          }),
          h(GanttPanel, {
            prep,
            store,
            tips,
            selectionRef,
            highlightRef,
            layoutMode,
            onLayoutMode: setLayoutMode,
            onSelect: toggleSelect,
          }),
          h(SidePanel, {
            prep,
            store,
            selectedId,
            onSelect: selectTask,
            onClear: clearSelection,
            onHighlightChildren: highlightChildren,
          }))
      }

      const topbar = !prep
        ? h('div', { className: 'tm-top' },
          h('div', { className: 'tm-sess' },
            h('div', { className: 'tm-sess-title' }, '任务地图'),
            h('div', { className: 'tm-sess-sub' }, sessionId ? h('code', null, sessionId) : '会话页签')))
        : h('div', { className: 'tm-top' },
          h('div', { className: 'tm-sess' },
            h('div', { className: 'tm-sess-title' }, prep.title),
            h('div', {
              className: 'tm-sess-sub',
            },
              prep.cwd ? h('span', null, shortPath(prep.cwd), ' · ') : null,
              h('span', null, fmtHm(prep.timeStart) + '–' + fmtHm(prep.timeEnd)),
              ' · 跨度 ' + fmtDurCn(prep.durationMs),
              ' · ' + prep.turns.length + ' 轮 · ' + prep.members.length + ' 代理')),
          h(StatChips, { prep, store }),
          prep.empty ? null : h(ReplayControls, { store, prep }))

      const projectionStateName = projectionError || prepareError ? 'error' : (projection == null ? 'pending' : 'ready')
      const stats = prep ? prep.stats : EMPTY_TASK_STATS
      return h('div', {
        className: 'tm-root',
        ref: rootRef,
        role: 'region',
        'aria-label': '任务地图',
        onMouseEnter: () => { pointerInsideRef.current = true },
        onMouseLeave: () => { pointerInsideRef.current = false },
        'data-tm-view': 'task-map',
        'data-tm-tasks': String(stats.total),
        'data-tm-completed': String(stats.completed),
        'data-tm-in-progress': String(stats.in_progress),
        'data-tm-selected': selectedId || '',
        'data-tm-empty': isEmpty ? 'true' : 'false',
        'data-tm-preview': previewView !== null ? 'true' : 'false',
        'data-tm-projection': projectionStateName,
        'data-tm-schema': CLIENT_SCHEMA,
        'data-tm-version': CLIENT_VERSION,
        'data-tm-state-version': String(prep ? prep.stateVersion : ''),
        'data-tm-layout-mode': layoutMode,
        'data-tm-invalid-relations': String(prep ? invalidRelationsOf(prep).length : 0),
        'data-tm-session': prep ? prep.sessionId : sessionId,
        'data-tm-current-time': String(Math.round(store.getTime())),
        'data-tm-playing': store.isPlaying() ? 'true' : 'false',
        'data-tm-speed': String(store.getSpeed()),
        'data-tm-range-start': String(Math.round(store.getStart())),
        'data-tm-range-end': String(Math.round(store.getEnd())),
        'data-tm-duration': String(Math.round(prep ? prep.durationMs : 0)),
        'data-tm-tail-ms': String(Math.round(prep ? prep.tailMs : 0)),
        'data-tm-raw-end': String(Math.round(prep ? prep.rawTimeEnd : 0)),
        'data-tm-live': prep && prep.liveMode ? 'true' : 'false',
      },
        topbar,
        h(TmErrorBoundary, null, body),
        h(TooltipLayer, { tips, prep, clock: store }))
    }

    function TooltipLayer(props) {
      const tips = props.tips
      const [, force] = React.useState(0)
      React.useEffect(() => tips.subscribe(() => force((value) => value + 1)), [tips])
      const snapshot = tips.get()
      if (!snapshot.visible || !snapshot.payload || typeof window === 'undefined') return null
      const payload = snapshot.payload
      const prep = props.prep
      const clock = props.clock
      let header = ''
      let lines = []
      if (payload.kind === 'task' && prep) {
        const task = prep.taskById[payload.taskId]
        if (!task) return null
        const moment = clock ? clock.getTime() : prep.timeEnd
        const displayMoment = displayMomentFor(prep, moment)
        const status = statusAtTime(task, moment)
        const color = prep.ownerColors[task.owner] || '#94a3b8'
        header = task.id + ' · ' + truncateText(task.subject, 34)
        lines = [
          h('div', { className: 'tm-tt-r', key: 'owner' },
            h('i', { className: 'tm-tt-dot', style: { background: color } }),
            '负责人 ', h('b', null, task.owner || '未指派'), task.ownerIsLead ? '（Lead）' : '',
            ' · 开始第 ' + (task.startRank === null ? '—' : task.startRank) +
            ' / 完成第 ' + (task.doneRank === null ? '—' : task.doneRank)),
          h('div', { className: 'tm-tt-r', key: 'time' },
            '创建 ' + fmtHm(task.createdAt) + ' · 开始 ' + fmtHm(task.startedAt) + ' · 完成 ' + fmtHm(task.completedAt)),
          h('div', { className: 'tm-tt-r', key: 'metric' },
            '执行耗时 ', h('b', null, fmtDur(task.execMs)), ' · 排队 ', h('b', null, fmtDur(task.queueMs)),
            task.blockedWaitMs !== null ? h('span', null, ' · 阻塞 ', h('b', null, fmtDur(task.blockedWaitMs))) : null),
          h('div', { className: 'tm-tt-r', key: 'status' },
            '回放时刻状态：' + (STATUS_LABEL[status] || status),
            task.startedAt !== null && status === 'in_progress' ? ' · 已跑 ' + fmtDur(displayMoment - task.startedAt) : ''),
        ]
      } else if (payload.kind === 'member' && prep) {
        const member = prep.members.find((item) => item.id === payload.memberId || item.name === payload.memberId)
        if (!member) return null
        header = '代理 · ' + member.name
        lines = [
          h('div', { className: 'tm-tt-r', key: 'desc' }, truncateText(member.description, 90)),
          h('div', { className: 'tm-tt-r', key: 'phase' },
            '阶段：' + member.phases.map((phase) => phase.phase + ' ' + fmtHm(phase.at)).join(' · ')),
        ]
      } else {
        header = text(payload.title)
        lines = payload.detail ? [h('div', { className: 'tm-tt-r', key: 'd' }, payload.detail)] : []
      }
      const widthEstimate = 300
      const heightEstimate = 120
      const viewportWidth = window.innerWidth || 1200
      const viewportHeight = window.innerHeight || 800
      const anchorX = clamp(finite(snapshot.x) === null ? viewportWidth / 2 : snapshot.x, 8, Math.max(8, viewportWidth - 8))
      const anchorY = clamp(finite(snapshot.y) === null ? viewportHeight / 3 : snapshot.y, 8, Math.max(8, viewportHeight - 8))
      let left = anchorX + 14
      let top = anchorY + 14
      if (left + widthEstimate > viewportWidth - 8) left = anchorX - widthEstimate - 14
      if (top + heightEstimate > viewportHeight - 8) top = anchorY - heightEstimate - 14
      // 最终视口 clamp：任何情况下不落到 (0,0)、不溢出右/下边缘。
      left = clamp(left, 8, Math.max(8, viewportWidth - 40))
      top = clamp(top, 8, Math.max(8, viewportHeight - 40))
      return h('div', {
        className: 'tm-tooltip',
        'data-tm-tooltip': payload.kind || 'info',
        'data-tm-tooltip-x': String(Math.round(anchorX)),
        'data-tm-tooltip-y': String(Math.round(anchorY)),
        style: { left: Math.round(left) + 'px', top: Math.round(top) + 'px' },
      },
        h('div', { className: 'tm-tt-h' }, header),
        lines)
    }

    // 错误边界：单个子树渲染异常不崩整个页签（真实 React 中为类组件；测试桩环境降级为直接渲染）
    let TmErrorBoundary = function TmErrorBoundaryFallback(props) { return props.children || null }
    try {
      const ComponentBase = React.Component
      if (typeof ComponentBase === 'function') {
        TmErrorBoundary = class TmErrorBoundaryClass extends ComponentBase {
          constructor(props) {
            super(props)
            this.state = { message: '' }
          }
          static getDerivedStateFromError(error) {
            return { message: str(error) }
          }
          componentDidCatch(error) {
            recordError('boundary', error)
          }
          render() {
            if (this.state.message) {
              return h(ErrorCard, {
                title: '任务地图局部渲染失败',
                message: '该区域渲染出错，已隔离，不影响会话与其它区域。',
                detail: this.state.message,
              })
            }
            return this.props.children || null
          }
        }
      }
    } catch (error) {
      recordError('boundary-init', error)
    }

    const SessionView = function SessionView(props) {
      try {
        return h(SessionViewInner, props)
      } catch (error) {
        recordError('SessionView', error)
        return h(ErrorCard, {
          title: '任务地图渲染失败',
          message: '视图初始化出错，已降级为局部提示，不影响会话。',
          detail: str(error),
        })
      }
    }

    // ------------------------------------------------------------------
    // 全局页（P1 范围；保留 M0 的 slot seam，不再请求调试路由）
    // ------------------------------------------------------------------
    function Page() {
      return h('div', { className: 'tm-page', 'data-tm-page': 'main' },
        h('div', { className: 'tm-card' },
          h('h1', { className: 'tm-card-title' }, '任务地图'),
          h('div', { className: 'tm-card-sub' },
            '单会话任务地图在任意会话的「任务地图」页签中查看：执行轨迹、甘特时间轴、回放、任务详情与等待拆解。',
            '全局多会话目录（会话列表 + 单会话统计 + 跳转，不合并任务）属于 P1 范围，尚未在本版本提供。')),
        h('div', { className: 'tm-card' },
          h('div', { className: 'tm-card-sub' }, '使用方式：打开一个会话 → 顶部页签选择「任务地图」。'),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, '数据来源'),
            h('div', { className: 'tm-card-v' }, '本会话事件（team/task 团队任务板，或降级 todo_write 清单）')),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, '只读派生'),
            h('div', { className: 'tm-card-v' }, '插件不修改任务状态、不写会话日志，仅按事件时间戳重建')),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, '无任务会话'),
            h('div', { className: 'tm-card-v' }, '显示空状态与引导，不伪造任务')),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, '客户端版本'),
            h('div', { className: 'tm-card-v' }, CLIENT_VERSION))),
        h('div', { className: 'tm-card' },
          h('div', { className: 'tm-card-sub' }, '无头验证标记：'),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, 'html'),
            h('div', { className: 'tm-card-v' }, 'data-task-map-plugin="m2"')),
          h('div', { className: 'tm-card-row' },
            h('div', { className: 'tm-card-k' }, 'window'),
            h('div', { className: 'tm-card-v' }, '__TASK_MAP_M0__（兼容）/ __TASK_MAP_M2__（view、errors、viewStats、actions、getState）'))))
    }

    function SidebarIcon() {
      return h('svg', { width: 18, height: 18, viewBox: '0 0 18 18', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M3 4.5 7 3l4 1.5L15 3v10.5L11 15l-4-1.5L3 15V4.5Z', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' }),
        h('path', { d: 'M7 3v10.5M11 4.5V15', stroke: 'currentColor', strokeWidth: 1.1, opacity: 0.7 }),
        h('circle', { cx: 7, cy: 8.2, r: 1.4, fill: 'currentColor' }),
        h('circle', { cx: 11, cy: 10.2, r: 1.4, fill: 'currentColor' }))
    }

    // ------------------------------------------------------------------
    // slot 注册 / 启动
    // ------------------------------------------------------------------
    function bootMarker() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.setAttribute('data-task-map-plugin', 'm2')
          document.documentElement.setAttribute('data-task-map-client-version', CLIENT_VERSION)
          document.documentElement.setAttribute('data-task-map-slots', registered.join(','))
        }
      } catch (error) {
        recordError('marker', error)
      }
    }

    /**
     * 插件被禁用/卸载（client-modules 销毁插件 fiber）时清理全局副作用：
     * html 标记属性、注入样式、window 调试标记。slot 注册由 slots.inject 的 effect 负责，
     * 组件内 rAF/ResizeObserver/事件监听随 React 卸载自动释放。
     */
    function cleanupDom() {
      try {
        if (typeof document !== 'undefined' && document.documentElement) {
          document.documentElement.removeAttribute('data-task-map-plugin')
          document.documentElement.removeAttribute('data-task-map-client-version')
          document.documentElement.removeAttribute('data-task-map-slots')
        }
        const element = typeof document !== 'undefined' ? document.getElementById(STYLE_ID) : null
        if (element && element.parentNode) element.parentNode.removeChild(element)
      } catch (error) {
        recordError('cleanup', error)
      }
      try {
        for (const dispose of Array.from(slotDisposers.values())) {
          try { dispose() } catch (ignored) { /* noop */ }
        }
        slotDisposers.clear()
      } catch (ignored) { /* noop */ }
      try {
        if (typeof window !== 'undefined') {
          if (window.__TASK_MAP_M2__) delete window.__TASK_MAP_M2__
          if (window.__TASK_MAP_M0__) delete window.__TASK_MAP_M0__
        }
      } catch (ignored) { /* noop */ }
    }

    function registerSlot(ctx, slotName, options, Component) {
      try {
        ctx.slots.inject(slotName, () => {
          try {
            const previous = slotDisposers.get(slotName)
            if (typeof previous === 'function') {
              try { previous() } catch (ignored) { /* noop */ }
            }
            const dispose = ctx.slots.register(options, Component)
            slotDisposers.set(slotName, dispose)
            if (!registered.includes(slotName)) registered.push(slotName)
            return () => {
              try { dispose() } catch (ignored) { /* noop */ }
              if (slotDisposers.get(slotName) === dispose) slotDisposers.delete(slotName)
            }
          } catch (error) {
            recordError(slotName, error)
            return () => {}
          }
        })
      } catch (error) {
        recordError(slotName + '.inject', error)
      }
    }

    const plugin = {
      inject: ['slots'],
      apply(ctx) {
        try {
          bootMarker()
          injectStyle()
          registerSlot(ctx, 'main', { name: 'main', key: 'task-map' }, Page)
          registerSlot(ctx, 'sidebar.panellist', {
            name: 'sidebar.panellist',
            id: 'task-map',
            order: 40,
            label: () => '任务地图',
          }, SidebarIcon)
          registerSlot(ctx, 'conversation.view', {
            name: 'conversation.view',
            id: 'task-map',
            order: SESSION_SLOT_ORDER,
            label: () => '任务地图',
          }, SessionView)
          bootMarker()
          // 禁用/卸载清理：插件 fiber 销毁时移除全局 DOM 副作用（slot 由 slots.inject 自动清理）。
          try {
            if (typeof ctx.effect === 'function') ctx.effect(() => () => cleanupDom())
            else if (typeof ctx.on === 'function') ctx.on('dispose', () => cleanupDom())
          } catch (error) {
            recordError('cleanup-register', error)
          }
        } catch (error) {
          recordError('apply', error)
        }
      },
      __test: {
        version: CLIENT_VERSION,
        schema: CLIENT_SCHEMA,
        styleText,
        constants: {
          FLOW,
          TIMELINE,
          SPEEDS,
          OWNER_PALETTE,
          STATUS_LABEL,
          STATUS_CLASS,
          STEP_MS,
          GANTT_WINDOW_THRESHOLD,
          LAYOUT_MODES,
          LAYOUT_ACTION_LABEL,
        },
        utils: {
          fmtDur,
          fmtDurCn,
          fmtClock,
          fmtHm,
          fmtHmSec,
          fmtInt,
          truncateText,
          shortPath,
          clamp,
          finite,
          lastIndexAtOrBefore,
          countAtOrBefore,
          ownerColorFor,
          buildOwnerColorMap,
          statusAtTime,
          isCreatedAtTime,
          countsAtTime,
          flowNodeClass,
          taskSpansInWindow,
          buildPhaseIntervals,
          memberPhaseAt,
          activeMembersAt,
          handoffForTask,
          computeFitHeight,
          CHANGE_KIND_LABEL,
          changeKindLabel,
          normalizeChanges,
          visibleChangeLog,
          asOfChangeCounts,
          taskChangeEntries,
          isPlannedTask,
          isNewBadgeVisible,
          changeTargetTaskId,
          normalizeRelations,
          buildRelationIndex,
          invalidRelationsOf,
          normalizePlan,
          normalizeLayoutMode,
          isPanelCollapsed,
          flowShareForRows,
          layoutGridTemplate,
          layoutActionToMode,
          relationChildrenOf,
          relationParentOf,
          relationBadgeCount,
        },
        layoutStore,
        prepareView,
        timeline: {
          TIMELINE,
          TICK_STEPS,
          chooseTickStep,
          timelineX,
          buildTimelineTicks,
          buildTimelineEvents,
          buildDensityBuckets,
          computeTimelineLayout,
          ganttTaskGeometry,
          stretchFlowLayout,
        },
        computeFlowLayout,
        buildFlowPath,
        buildDependencyPath,
        buildRelationPath,
        createReplayStore,
        createTooltipStore,
        components: {
          SessionView,
          SessionViewInner,
          TaskFlow: TaskFlowInner,
          TaskFlowMemo: TaskFlow,
          GanttPanel,
          GanttInner,
          SidePanel,
          TaskDetail,
          Overview,
          EmptyState,
          ErrorCard,
          StatChips,
          ReplayControls,
          Clock,
          ProgressBar,
          TooltipLayer,
          Page,
        },
      },
    }
    return plugin
  },
})
