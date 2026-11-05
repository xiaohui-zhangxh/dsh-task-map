#!/usr/bin/env node
/**
 * 可复跑的「任务地图」端到端冒烟（开发/验收用，不随插件发布、不在 npm test 中运行）。
 *
 * 依赖：
 *   · 一个正在运行的 DSH Web 实例（隔离或日常 profile 均可）及其带 token 的 URL；
 *   · 系统 Chrome；
 *   · playwright-core（本机可能来自其他工具的 node_modules，用 PLAYWRIGHT_CORE 指定路径）。
 *
 * 用法：
 *   PLAYWRIGHT_CORE=/path/to/playwright-core \
 *   node tools/e2e/task-map-e2e.mjs '<http://127.0.0.1:PORT/?token=...>' '<session-id>' [outDir]
 *
 * 输出：outDir（默认 ./tmp/e2e-out）下的截图 + result.json；全部断言通过则 exit 0。
 *
 * 限制：隔离 web profile 若未挂 Agent Teams，无法验证「对话建任务/拆分」实时链路；
 *       本脚本只做只读 UI 冒烟（任务图/甘特/回放/变更/关系渲染与 data 属性）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const require = createRequire(import.meta.url)
const url = process.argv[2]
const sessionId = process.argv[3]
const outDir = path.resolve(process.argv[4] || 'tmp/e2e-out')
if (!url || !sessionId) {
  console.error('usage: task-map-e2e.mjs <url-with-token> <session-id> [outDir]')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_CORE].filter(Boolean)
  for (const candidate of candidates) {
    try { return require(candidate) } catch { /* try next */ }
  }
  try { return require('playwright-core') } catch { /* fallthrough */ }
  throw new Error('找不到 playwright-core：请设置 PLAYWRIGHT_CORE 指向其目录')
}
const chromium = loadPlaywright().chromium
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

let checks = 0
let failures = 0
const ok = (condition, label, detail = '') => {
  checks += 1
  if (condition) { console.log(`  ✓ ${label}`); return true }
  failures += 1
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  return false
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function readStats(page) {
  return page.evaluate(() => {
    const root = document.querySelector('[data-tm-view="task-map"]')
    if (!root) return null
    const d = root.dataset
    const changes = root.querySelector('[data-tm-changes]')
    return {
      session: d.tmSession || '',
      stateVersion: Number(d.tmStateVersion || 0),
      tasks: Number(d.tmTasks || 0),
      completed: Number(d.tmCompleted || 0),
      currentTime: Number(d.tmCurrentTime || 0),
      rangeStart: Number(d.tmRangeStart || 0),
      rangeEnd: Number(d.tmRangeEnd || 0),
      duration: Number(d.tmDuration || 0),
      empty: d.tmEmpty === 'true',
      projected: d.tmProjection || '',
      taskNodes: root.querySelectorAll('[data-tm-task-id]').length,
      ganttRows: root.querySelectorAll('[data-tm-gantt-task]').length,
      visibleGanttRows: Array.from(root.querySelectorAll('[data-tm-gantt-task]')).filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.height > 4 && rect.top < window.innerHeight && rect.bottom > 0
      }).length,
      hasOverview: Boolean(root.querySelector('[data-tm-overview]')),
      hasPlay: Boolean(root.querySelector('[data-tm-play]')),
      changesVisible: Number(changes?.dataset.tmChangesVisible || 0),
      baselineCount: Number(changes?.dataset.tmBaselineCount || 0),
      relationCount: (window.__TASK_MAP_M2__?.view?.relations || []).length,
      errors: (window.__TASK_MAP_M2__?.errors || []).slice(0, 5),
      preview: d.tmPreview === 'true',
      rootHeight: Math.round(root.getBoundingClientRect().height),
      hostHeight: (() => {
        let el = root.parentElement
        while (el) {
          const style = getComputedStyle(el)
          if ((style.overflowY === 'auto' || style.overflowY === 'scroll') && el.clientHeight > 0) return el.clientHeight
          el = el.parentElement
        }
        return window.innerHeight
      })(),
    }
  })
}

;(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true })
  const page = await browser.newPage({ viewport: { width: 1680, height: 1050 } })
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 300)) })
  page.on('pageerror', (error) => consoleErrors.push('pageerror: ' + error.message.slice(0, 300)))

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3500)
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('button')) {
      if (['继续', '知道了'].includes((button.innerText || '').trim())) button.click()
    }
  })
  ok(await page.evaluate(() => Boolean(window.__TASK_MAP_M2__?.loaded)), 'client bundle 已加载')

  // 侧栏会话行：若不可见先尝试展开工作区分组
  if (!(await page.evaluate((id) => Boolean(document.querySelector(`[data-row-key="session:${id}"]`)), sessionId))) {
    await page.evaluate(() => {
      for (const row of document.querySelectorAll('[data-row-key^="workspace:"]')) row.click()
    })
    await sleep(1200)
  }
  const clicked = await page.evaluate((id) => {
    const row = document.querySelector(`[data-row-key="session:${id}"]`)
    if (!row) return false
    row.click()
    return true
  }, sessionId)
  if (!ok(clicked, '侧栏会话行可点击')) throw new Error('session row missing')
  await page.waitForFunction(() => Array.from(document.querySelectorAll('[role="tab"]')).some((el) => (el.innerText || '').trim() === '任务地图'), undefined, { timeout: 30000 })
  await page.evaluate(() => {
    const tab = Array.from(document.querySelectorAll('[role="tab"]')).find((el) => (el.innerText || '').trim() === '任务地图')
    tab?.click()
  })
  await page.waitForFunction((id) => {
    const root = document.querySelector('[data-tm-view="task-map"]')
    return Boolean(root && root.dataset.tmSession === id && root.dataset.tmProjection === 'ready')
  }, sessionId, { timeout: 30000 })
  await sleep(900)

  let stats = await readStats(page)
  ok(Boolean(stats), '任务地图视图渲染')
  ok(stats.tasks > 0 || stats.empty, '有一任务板或空态', JSON.stringify({ tasks: stats?.tasks }))
  ok(stats.taskNodes >= Math.min(stats.tasks, 1), '任务图节点渲染', String(stats.taskNodes))
  ok(stats.ganttRows >= Math.min(stats.tasks, 1), '甘特任务行渲染', String(stats.ganttRows))
  ok(stats.visibleGanttRows >= Math.min(stats.tasks, 1), '甘特行真实可见', String(stats.visibleGanttRows))
  ok(stats.hasOverview, '总览渲染')
  ok(stats.hasPlay, '回放控件渲染')
  ok(stats.rangeEnd > stats.rangeStart, '回放范围有效', JSON.stringify({ start: stats.rangeStart, end: stats.rangeEnd }))
  ok(stats.rootHeight <= stats.hostHeight + 2, '视图高度适配宿主', JSON.stringify({ root: stats.rootHeight, host: stats.hostHeight }))
  ok(stats.stateVersion >= 3, 'stateVersion >= 3', String(stats.stateVersion))
  ok(stats.errors.length === 0, 'client 无运行错误', JSON.stringify(stats.errors))
  await page.screenshot({ path: path.join(outDir, 'overview.png') })

  // 回放：拖到中段 + 播放 1.5s 采样帧率
  await page.evaluate(() => {
    const scrubber = document.querySelector('[data-tm-scrubber]')
    if (!scrubber) return
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    const mid = String(scrubber.min && scrubber.max ? Math.round((Number(scrubber.min) + Number(scrubber.max)) / 2) : 0)
    if (setter) setter.call(scrubber, mid); else scrubber.value = mid
    scrubber.dispatchEvent(new Event('input', { bubbles: true }))
    scrubber.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await sleep(700)
  const midStats = await readStats(page)
  ok(midStats.currentTime > midStats.rangeStart, '回放拖动生效', JSON.stringify({ currentTime: midStats.currentTime }))
  await page.evaluate(() => document.querySelector('[data-tm-play]')?.click())
  const fps = await page.evaluate(async () => {
    const t0 = performance.now()
    let frames = 0
    let last = t0
    await new Promise((resolve) => {
      const loop = (now) => { frames += 1; last = now; if (now - t0 >= 1500) resolve(); else requestAnimationFrame(loop) }
      requestAnimationFrame(loop)
    })
    document.querySelector('[data-tm-play]')?.click()
    return +((frames * 1000) / (last - t0)).toFixed(1)
  })
  ok(fps >= 30, '回放帧率 ≥30fps（目标 55+）', `${fps}fps`)
  await page.screenshot({ path: path.join(outDir, 'replay-mid.png') })

  const taskMapErrors = consoleErrors.filter((message) => /task-map|TaskMap|\[task-map\]/.test(message) && !/client\.js/.test(message))
  const otherErrors = consoleErrors.filter((message) => !/Session reference .* is released|Sidebar Session opening failed|Failed to load resource/.test(message))
  ok(taskMapErrors.length === 0, '无 task-map console error', JSON.stringify(taskMapErrors.slice(0, 3)))
  ok(otherErrors.length === 0, '无非导航类 console error', JSON.stringify(otherErrors.slice(0, 3)))

  const result = { verifiedAt: new Date().toISOString(), url: url.replace(/token=[^&]+/, 'token=***'), sessionId, stats, midStats, fps, checks, failures, consoleErrors: consoleErrors.slice(0, 20) }
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  await browser.close()
  console.log(`\n[task-map-e2e] ${checks} checks, ${failures} failed — 输出目录 ${outDir}`)
  if (failures > 0) process.exit(1)
  console.log('[task-map-e2e] PASS')
})().catch((error) => { console.error('[task-map-e2e] FAILED', error); process.exit(1) })
