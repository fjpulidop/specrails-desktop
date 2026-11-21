// Per-run time attribution read from the isolated home's project databases
// (read-only): where the wall time of one run went. `attributeRun` is pure
// (rows in, summary out); `readRunTimings` opens the database with sqlite3.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/** Node id → phase bucket. Unknown ids count as `engine` (Core bookkeeping). */
export function phaseOf(nodeId) {
  const id = String(nodeId ?? '')
  if (/^architect/.test(id)) return 'plan'
  if (/^develop|^build|^implement/.test(id)) return 'develop'
  if (/^reviewer|^assess/.test(id)) return 'review'
  if (/^fixer/.test(id)) return 'fix'
  if (/^baseline|^verify|verification/.test(id)) return 'verify'
  if (/^archive|^deliver|^publish|^merge|^commit|^settle/.test(id)) return 'deliver'
  return 'engine'
}

const VERIFY_WAIT = /Verification turn acquired after (\d+) s/
const CORE_READY = /Core runtime ready \(([\d.]+) s\)/

/**
 * Summarize one run. `run` is the loop_runs row; `steps` are loop_step and
 * loop_step_end payloads in sequence order; `logs` are log lines; `limits`
 * are rate-limit events. `launchedAt` is when the harness sent the launch.
 */
export function attributeRun({ run, steps, logs, limits = [], launchedAt = null, roles = [], checks = [] }) {
  const phases = {}
  const counts = {}
  let firstStepAt = null, lastEndAt = null
  const open = new Map()
  for (const step of steps) {
    if (step.type === 'start') {
      if (firstStepAt === null || step.startedAtMs < firstStepAt) firstStepAt = step.startedAtMs
      open.set(step.attemptId ?? `${step.nodeId}:${step.index}`, step)
      const phase = phaseOf(step.nodeId)
      counts[phase] = (counts[phase] ?? 0) + 1
    } else {
      const begin = open.get(step.attemptId ?? `${step.nodeId}:${step.index}`)
      const phase = phaseOf(step.nodeId)
      phases[phase] = (phases[phase] ?? 0) + (Number(step.durationMs) || 0)
      if (begin && Number.isFinite(begin.startedAtMs)) lastEndAt = Math.max(lastEndAt ?? 0, begin.startedAtMs + (Number(step.durationMs) || 0))
    }
  }
  let verifyWaitS = 0, verifyWaits = 0, corePrepS = null
  for (const line of logs) {
    const wait = VERIFY_WAIT.exec(line)
    if (wait) { verifyWaitS += Number(wait[1]); verifyWaits++ }
    const ready = CORE_READY.exec(line)
    if (ready) corePrepS = (corePrepS ?? 0) + Number(ready[1])
  }
  const started = Date.parse(`${run.started_at}${/Z$|[+-]\d\d:?\d\d$/.test(run.started_at) ? '' : 'Z'}`)
  const finished = run.finished_at ? Date.parse(`${run.finished_at}${/Z$|[+-]\d\d:?\d\d$/.test(run.finished_at) ? '' : 'Z'}`) : null
  const utilization = limits.map(limit => limit.utilization).filter(Number.isFinite)
  // Role turns (Core's role-context efficiency events): time, tokens, cost and tool calls per phase.
  const usage = {}
  for (const role of roles) {
    const phase = phaseOf(role.nodePath)
    const u = (usage[phase] ??= { turns: 0, durationS: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, uncachedInputTokens: 0, toolCalls: 0, promptBytes: 0 })
    u.turns++
    u.durationS += (Number(role.durationMs) || 0) / 1000
    u.costUsd += Number(role.usage?.costUsd) || 0
    u.inputTokens += Number(role.usage?.inputTokens) || 0
    u.outputTokens += Number(role.usage?.outputTokens) || 0
    u.cacheReadTokens += Number(role.usage?.cacheReadInputTokens) || 0
    u.uncachedInputTokens += Number(role.usage?.uncachedInputTokens) || 0
    u.toolCalls += Number(role.toolCalls) || 0
    u.promptBytes += Number(role.promptBytes) || 0
  }
  for (const u of Object.values(usage)) { u.durationS = Math.round(u.durationS * 10) / 10; u.costUsd = Math.round(u.costUsd * 10000) / 10000 }
  // Verification commands (check-finished): how many ran and their own duration, per node.
  const verification = { runs: checks.length, commandS: Math.round(checks.reduce((sum, c) => sum + (Number(c.durationMs) || 0), 0) / 100) / 10,
    byNode: checks.reduce((acc, c) => { acc[c.nodePath] = (acc[c.nodePath] ?? 0) + 1; return acc }, {}) }
  // Idle time between consecutive steps (Core/Desktop bookkeeping between nodes) and outside the steps.
  const spans = []
  for (const step of steps) if (step.type === 'start' && Number.isFinite(step.startedAtMs)) {
    const end = steps.find(e => e.type === 'end' && (e.attemptId ?? `${e.nodeId}:${e.index}`) === (step.attemptId ?? `${step.nodeId}:${step.index}`))
    spans.push([step.startedAtMs, step.startedAtMs + (Number(end?.durationMs) || 0)])
  }
  spans.sort((a, b) => a[0] - b[0])
  let gapMs = 0
  for (let i = 1; i < spans.length; i++) gapMs += Math.max(0, spans[i][0] - Math.max(...spans.slice(0, i).map(s => s[1])))
  const startedMs = Date.parse(`${run.started_at}${/Z$|[+-]\d\d:?\d\d$/.test(run.started_at) ? '' : 'Z'}`)
  const finishedMs = run.finished_at ? Date.parse(`${run.finished_at}${/Z$|[+-]\d\d:?\d\d$/.test(run.finished_at) ? '' : 'Z'}`) : null
  const idle = { betweenStepsS: Math.round(gapMs / 100) / 10, steps: spans.length,
    headS: spans.length && Number.isFinite(startedMs) ? Math.round((spans[0][0] - startedMs) / 100) / 10 : null,
    tailS: spans.length && finishedMs ? Math.round((finishedMs - Math.max(...spans.map(s => s[1]))) / 100) / 10 : null }
  return {
    usage, verification, idle,
    runId: run.id, outcome: run.final_outcome, status: run.status, costUsd: run.total_cost_usd,
    totalS: finished && Number.isFinite(started) ? Math.round((finished - started) / 1000) : null,
    launchToFirstStepS: Number.isFinite(launchedAt) && firstStepAt !== null ? Math.round((firstStepAt - launchedAt) / 100) / 10 : null,
    corePrepS,
    phaseS: Object.fromEntries(Object.entries(phases).map(([key, ms]) => [key, Math.round(ms / 100) / 10])),
    visits: counts,
    corrections: counts.fix ?? 0,
    planRepairs: Math.max(0, (counts.plan ?? 0) - 1),
    reviewRejections: Math.max(0, (counts.review ?? 0) - 1),
    verifyWaitS, verifyWaits,
    fiveHourUtilization: utilization.length ? { first: utilization[0], last: utilization[utilization.length - 1] } : null,
    lastEndAt,
  }
}

function query(db, sql) {
  const out = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  return out.trim() ? JSON.parse(out) : []
}

/** Project databases under an isolated home. */
export function projectDatabases(home) {
  const root = path.join(home, '.specrails', 'projects')
  if (!fs.existsSync(root)) return []
  return fs.readdirSync(root).map(slug => path.join(root, slug, 'jobs.sqlite')).filter(file => fs.existsSync(file))
}

/** Read and attribute one run (searching every project database of `home`). */
export function readRunTimings(home, runId, launchedAt = null) {
  const safe = String(runId).replace(/[^a-zA-Z0-9-]/g, '')
  for (const db of projectDatabases(home)) {
    const [run] = query(db, `select * from loop_runs where id='${safe}'`)
    if (!run) continue
    const steps = query(db, `select event_type, payload from events where job_id='${safe}' and event_type in ('loop_step','loop_step_end') order by seq`).map(row => {
      const p = JSON.parse(row.payload)
      return { type: row.event_type === 'loop_step' ? 'start' : 'end', nodeId: p.nodeId ?? p.title, index: p.index, attemptId: p.attemptId, startedAtMs: p.startedAtMs, durationMs: p.durationMs }
    })
    const logs = query(db, `select json_extract(payload,'$.line') as line from events where job_id='${safe}' and event_type='log' and (payload like '%Verification turn acquired%' or payload like '%Core runtime ready%')`).map(row => row.line ?? '')
    const limits = query(db, `select json_extract(payload,'$.event.rateLimit.utilization') as utilization from events where job_id='${safe}' and event_type='agent-event' and payload like '%"kind":"rate-limit"%' order by seq`)
    const efficiency = query(db, `select payload from events where job_id='${safe}' and event_type='runtime-efficiency-event' and (payload like '%"kind":"role-context"%' or payload like '%"kind":"check-finished"%') order by seq`).map(row => JSON.parse(row.payload))
    const roles = efficiency.filter(e => e.kind === 'role-context').map(e => ({ nodePath: e.nodePath, ...e.payload }))
    const checks = efficiency.filter(e => e.kind === 'check-finished').map(e => ({ nodePath: e.nodePath, durationMs: e.durationMs, exitCode: e.exitCode }))
    return attributeRun({ run, steps, logs, limits, launchedAt, roles, checks })
  }
  return null
}
