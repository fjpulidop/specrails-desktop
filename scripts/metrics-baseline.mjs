#!/usr/bin/env node
// Metrics baseline export (feedback-2026-10 program, task 0.6).
//
// Reads the project registry (`<home>/.specrails/desktop.sqlite`, home =
// SPECRAILS_REGISTRY_HOME || os.homedir(), exactly like the server) and each
// registered project's `jobs.sqlite`, strictly READ-ONLY, and reports per
// Safe-PR delivery (rail_pr_deliveries row) plus per-loop and per-ticket
// rollups over a time window:
//   - deliveries, merges, discards, supersessions, failures
//   - AI cost per delivery, attributed with the same rule as
//     sumInvocationCostForRuns (ai-invocations.ts): loop_run_id ∈ run_ids, or
//     surface_ref_id = run id, or `<runId>:merge:%`. Unknown cost stays null
//     (never 0) and the estimated (pricing-table) portion stays separate.
//   - reviewer / fixer rounds (loop_step events whose node is reviewer/fixer)
//   - build duration and an approximate on_review dwell time
// Output: baseline-<YYYY-MM-DD>.json + .csv under --out (default
// <home>/.specrails/metrics/), plus a short stdout summary.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const DAY_MS = 86_400_000
const DEFAULT_WINDOW_DAYS = 28
const REVIEW_NODES = new Set(['reviewer', 'review'])
const FIXER_NODES = new Set(['fixer', 'fix'])
const TERMINAL_DECISIONS = new Set(['merged', 'discarded', 'superseded', 'implementation_failed', 'pr_failed', 'pr_draft', 'pr_ready'])

export function registryHome(env = process.env) {
  return env.SPECRAILS_REGISTRY_HOME || os.homedir()
}

/** SQLite `datetime('now')` values carry no zone but are UTC; ISO values pass through. */
export function parseTimestamp(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const text = String(value).trim()
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text) ? `${text.replace(' ', 'T')}Z` : text
  const ms = Date.parse(normalized)
  return Number.isFinite(ms) ? ms : null
}

function parseBound(value, flag) {
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? Date.parse(`${value}T00:00:00Z`) : Date.parse(value)
  if (!Number.isFinite(ms)) throw new Error(`Invalid ${flag} value: ${value}`)
  return ms
}

export function parseArgs(argv, now = Date.now()) {
  const options = { since: null, until: null, projects: [], out: null, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const [flag, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    const value = () => {
      if (inline !== undefined) return inline
      const next = argv[++i]
      if (next === undefined) throw new Error(`Missing value for ${flag}`)
      return next
    }
    if (flag === '--since') options.since = parseBound(value(), '--since')
    else if (flag === '--until') options.until = parseBound(value(), '--until')
    else if (flag === '--project') options.projects.push(value())
    else if (flag === '--out') options.out = value()
    else if (flag === '--help' || flag === '-h') options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  options.until ??= now
  options.since ??= options.until - DEFAULT_WINDOW_DAYS * DAY_MS
  if (options.since >= options.until) throw new Error('--since must be earlier than --until')
  return options
}

function openReadOnly(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  db.pragma('query_only = ON')
  return db
}

function tableColumns(db, table) {
  return new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name))
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text ?? '[]')
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

export function listRegisteredProjects(home, filters = []) {
  const registry = path.join(home, '.specrails', 'desktop.sqlite')
  if (!fs.existsSync(registry)) throw new Error(`Project registry not found: ${registry}`)
  const db = openReadOnly(registry)
  try {
    const rows = db.prepare('SELECT id, slug, name, db_path FROM projects ORDER BY added_at ASC').all()
    if (!filters.length) return rows
    const selected = rows.filter(row => filters.includes(row.slug) || filters.includes(row.id))
    const missing = filters.filter(f => !rows.some(row => row.slug === f || row.id === f))
    if (missing.length) throw new Error(`Unknown project(s): ${missing.join(', ')}`)
    return selected
  } finally { db.close() }
}

const lastSegment = (nodePath) => (typeof nodePath === 'string' ? nodePath.split(/[/.>]/).filter(Boolean).pop() ?? '' : '')

function countRounds(db, runIds, hasEvents) {
  const rounds = { review: 0, fixer: 0 }
  if (!hasEvents || !runIds.length) return rounds
  const stmt = db.prepare("SELECT payload FROM events WHERE job_id = ? AND event_type = 'loop_step'")
  for (const runId of runIds) {
    for (const { payload } of stmt.all(runId)) {
      let step
      try { step = JSON.parse(payload) } catch { continue }
      const node = String(step.nodeId || lastSegment(step.nodePath) || lastSegment(step.title)).toLowerCase()
      if (REVIEW_NODES.has(node)) rounds.review++
      else if (FIXER_NODES.has(node)) rounds.fixer++
    }
  }
  return rounds
}

function invocationsForRuns(db, runIds) {
  if (!runIds.length) return []
  const placeholders = runIds.map(() => '?').join(', ')
  const merge = runIds.map(() => "surface_ref_id LIKE ? ESCAPE '\\'").join(' OR ')
  const escape = (id) => id.replace(/[\\%_]/g, ch => `\\${ch}`)
  return db.prepare(
    `SELECT id, ticket_id, total_cost_usd, total_cost_usd_estimated, status FROM ai_invocations
      WHERE loop_run_id IN (${placeholders}) OR surface_ref_id IN (${placeholders}) OR ${merge}`,
  ).all(...runIds, ...runIds, ...runIds.map(id => `${escape(id)}:merge:%`))
}

/** Sum invocation rows keeping unknown (null) cost distinguishable from $0. */
export function summarizeCost(rows) {
  let cost = 0, estimated = 0, priced = 0, unpriced = 0
  for (const row of rows) {
    if (row.total_cost_usd == null) { unpriced++; continue }
    priced++
    cost += row.total_cost_usd
    if (row.total_cost_usd_estimated === 1) estimated += row.total_cost_usd
  }
  return {
    invocations: rows.length,
    pricedInvocations: priced,
    unpricedInvocations: unpriced,
    costUsd: priced ? round(cost) : null,
    estimatedCostUsd: priced ? round(estimated) : null,
    costIncludesEstimate: estimated > 0,
    costComplete: rows.length > 0 && unpriced === 0,
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6
const iso = (ms) => (ms == null ? null : new Date(ms).toISOString())

export function collectProjectDeliveries(project, window) {
  const db = openReadOnly(project.db_path)
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name))
    if (!tables.has('rail_pr_deliveries')) return []
    const cols = tableColumns(db, 'rail_pr_deliveries')
    const opt = (name) => (cols.has(name) ? name : `NULL AS ${name}`)
    const deliveries = db.prepare(`SELECT id, loop_id, loop_name, rail_index, ticket_ids, decision, created_at, updated_at,
        ${cols.has('run_ids') ? 'run_ids' : "'[]' AS run_ids"}, ${opt('implementation_outcome')}, ${opt('delivery_outcome')},
        ${opt('is_continuation')}, ${opt('supersedes_delivery_id')}, ${opt('revision_of')}, pr_url
      FROM rail_pr_deliveries`).all()
    const runStmt = tables.has('loop_runs')
      ? db.prepare('SELECT id, iteration_count, status, final_outcome, started_at, finished_at FROM loop_runs WHERE id = ?')
      : null
    const out = []
    for (const d of deliveries) {
      const createdMs = parseTimestamp(d.created_at)
      if (createdMs == null || createdMs < window.since || createdMs >= window.until) continue
      const runIds = [...new Set(parseJsonArray(d.run_ids).filter(id => typeof id === 'string' && id))]
      const runs = runStmt ? runIds.map(id => runStmt.get(id)).filter(Boolean) : []
      const finishes = runs.map(r => parseTimestamp(r.finished_at))
      const settledMs = runs.length && finishes.every(ms => ms != null) ? Math.max(...finishes) : null
      const updatedMs = parseTimestamp(d.updated_at)
      const terminal = TERMINAL_DECISIONS.has(d.decision)
      // on_review dwell ≈ build settle → decision change. Rows never parked on
      // review (failed / superseded builds) have no dwell; open ones run to now.
      let onReviewMs = null
      let onReviewOpen = false
      if (d.decision === 'on_review' && settledMs != null) {
        onReviewMs = Math.max(0, Math.min(window.until, Date.now()) - settledMs)
        onReviewOpen = true
      } else if (terminal && d.implementation_outcome === 'succeeded' && settledMs != null && updatedMs != null) {
        onReviewMs = Math.max(0, updatedMs - settledMs)
      }
      const invocations = invocationsForRuns(db, runIds)
      const rounds = countRounds(db, runIds, tables.has('events'))
      out.push({
        projectId: project.id,
        projectSlug: project.slug,
        deliveryId: d.id,
        loopId: d.loop_id ?? null,
        loopName: d.loop_name || null,
        railIndex: d.rail_index,
        ticketIds: parseJsonArray(d.ticket_ids).filter(n => Number.isInteger(n)),
        decision: d.decision,
        implementationOutcome: d.implementation_outcome ?? null,
        deliveryOutcome: d.delivery_outcome ?? null,
        isContinuation: d.is_continuation === 1,
        supersedesDeliveryId: d.supersedes_delivery_id ?? null,
        revisionOf: d.revision_of ?? null,
        hasPr: Boolean(d.pr_url),
        createdAt: iso(createdMs),
        settledAt: iso(settledMs),
        decidedAt: terminal ? iso(updatedMs) : null,
        buildDurationMs: settledMs != null ? Math.max(0, settledMs - createdMs) : null,
        onReviewMsApprox: onReviewMs,
        onReviewOpen,
        runCount: runIds.length,
        iterations: runs.reduce((sum, r) => sum + (r.iteration_count ?? 0), 0),
        reviewRounds: rounds.review,
        fixerRounds: rounds.fixer,
        ...summarizeCost(invocations),
        _invocations: invocations,
      })
    }
    return out
  } finally { db.close() }
}

function emptyGroup(keys) {
  return { ...keys, deliveries: 0, merged: 0, discarded: 0, superseded: 0, failed: 0, onReview: 0,
    costUsd: null, estimatedCostUsd: null, pricedDeliveries: 0, unpricedInvocations: 0,
    reviewRounds: 0, fixerRounds: 0, buildDurationMs: [], onReviewMs: [] }
}

function addToGroup(group, delivery, cost) {
  group.deliveries++
  if (delivery.decision === 'merged') group.merged++
  else if (delivery.decision === 'discarded') group.discarded++
  else if (delivery.decision === 'superseded') group.superseded++
  else if (delivery.decision === 'implementation_failed' || delivery.decision === 'pr_failed') group.failed++
  else if (delivery.decision === 'on_review') group.onReview++
  if (cost.costUsd != null) {
    group.costUsd = round((group.costUsd ?? 0) + cost.costUsd)
    group.estimatedCostUsd = round((group.estimatedCostUsd ?? 0) + (cost.estimatedCostUsd ?? 0))
    group.pricedDeliveries++
  }
  group.unpricedInvocations += cost.unpricedInvocations
  group.reviewRounds += delivery.reviewRounds
  group.fixerRounds += delivery.fixerRounds
  if (delivery.buildDurationMs != null) group.buildDurationMs.push(delivery.buildDurationMs)
  if (delivery.onReviewMsApprox != null) group.onReviewMs.push(delivery.onReviewMsApprox)
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function finalizeGroup(group) {
  const { buildDurationMs, onReviewMs, ...rest } = group
  return {
    ...rest,
    costPerDeliveryUsd: group.pricedDeliveries ? round(group.costUsd / group.pricedDeliveries) : null,
    reviewRoundsPerDelivery: group.deliveries ? round(group.reviewRounds / group.deliveries) : null,
    fixerRoundsPerDelivery: group.deliveries ? round(group.fixerRounds / group.deliveries) : null,
    medianBuildDurationMs: median(buildDurationMs),
    medianOnReviewMsApprox: median(onReviewMs),
  }
}

export function aggregate(deliveries) {
  const byLoop = new Map()
  const byTicket = new Map()
  for (const d of deliveries) {
    const loopKey = `${d.projectId}\u0000${d.loopId ?? ''}`
    if (!byLoop.has(loopKey)) byLoop.set(loopKey, emptyGroup({ projectSlug: d.projectSlug, loopId: d.loopId, loopName: d.loopName }))
    addToGroup(byLoop.get(loopKey), d, d)
    for (const ticketId of d.ticketIds) {
      const key = `${d.projectId}\u0000${ticketId}`
      if (!byTicket.has(key)) byTicket.set(key, emptyGroup({ projectSlug: d.projectSlug, ticketId }))
      // Multi-ticket launches split invocation rows per ticket (ticket_id), so
      // attribute by row; a single-ticket delivery owns every row.
      const rows = d.ticketIds.length === 1 ? d._invocations : d._invocations.filter(r => r.ticket_id === ticketId)
      addToGroup(byTicket.get(key), d, summarizeCost(rows))
    }
  }
  return { byLoop: [...byLoop.values()].map(finalizeGroup), byTicket: [...byTicket.values()].map(finalizeGroup) }
}

export const CSV_COLUMNS = ['projectSlug', 'deliveryId', 'loopId', 'loopName', 'railIndex', 'ticketIds', 'decision',
  'implementationOutcome', 'deliveryOutcome', 'isContinuation', 'supersedesDeliveryId', 'revisionOf', 'hasPr',
  'createdAt', 'settledAt', 'decidedAt', 'buildDurationMs', 'onReviewMsApprox', 'onReviewOpen', 'runCount',
  'iterations', 'reviewRounds', 'fixerRounds', 'invocations', 'pricedInvocations', 'unpricedInvocations',
  'costUsd', 'estimatedCostUsd', 'costIncludesEstimate', 'costComplete']

function csvCell(value) {
  if (value == null) return '' // unknown stays empty, never 0
  const text = Array.isArray(value) ? value.join(';') : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

export function toCsv(deliveries) {
  return [CSV_COLUMNS.join(','), ...deliveries.map(d => CSV_COLUMNS.map(c => csvCell(d[c])).join(','))].join('\n') + '\n'
}

export function buildBaseline({ home = registryHome(), since, until, projects: filters = [], now = Date.now() }) {
  const window = { since, until }
  const projects = listRegisteredProjects(home, filters)
  const deliveries = []
  const projectSummaries = []
  for (const project of projects) {
    try {
      if (!fs.existsSync(project.db_path)) throw new Error('jobs.sqlite not found')
      const rows = collectProjectDeliveries(project, window)
      deliveries.push(...rows)
      projectSummaries.push({ id: project.id, slug: project.slug, name: project.name, deliveries: rows.length, error: null })
    } catch (error) {
      projectSummaries.push({ id: project.id, slug: project.slug, name: project.name, deliveries: 0, error: error instanceof Error ? error.message : String(error) })
    }
  }
  deliveries.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const { byLoop, byTicket } = aggregate(deliveries)
  const totals = finalizeGroup(deliveries.reduce((group, d) => (addToGroup(group, d, d), group), emptyGroup({})))
  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    window: { since: iso(since), until: iso(until) },
    notes: {
      cost: 'costUsd sums priced ai_invocations rows (authoritative + estimated); estimatedCostUsd is the pricing-table portion; null = no priced rows (unknown, not $0).',
      onReview: 'onReviewMsApprox ≈ last attributed run finished_at → delivery updated_at for decided rows; open on_review rows run to the window end.',
      rounds: 'reviewRounds/fixerRounds count loop_step events whose node is reviewer/fixer.',
    },
    projects: projectSummaries,
    totals,
    byLoop,
    byTicket,
    deliveries: deliveries.map(({ _invocations, ...rest }) => rest),
  }
}

export function writeBaseline(baseline, outDir, repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')) {
  const resolved = path.resolve(outDir)
  const relative = path.relative(repoRoot, resolved)
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error(`Refusing to write metrics inside the repository: ${resolved}`)
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 })
  const stamp = baseline.generatedAt.slice(0, 10)
  const json = path.join(resolved, `baseline-${stamp}.json`)
  const csv = path.join(resolved, `baseline-${stamp}.csv`)
  fs.writeFileSync(json, JSON.stringify(baseline, null, 2) + '\n', { mode: 0o600 })
  fs.writeFileSync(csv, toCsv(baseline.deliveries), { mode: 0o600 })
  return { json, csv }
}

const money = (n) => (n == null ? 'unknown' : `$${n.toFixed(2)}`)
const ratio = (n) => (n == null ? '-' : String(Math.round(n * 100) / 100))
const minutes = (ms) => (ms == null ? '-' : `${Math.round(ms / 60_000)}m`)

export function formatSummary(baseline) {
  const lines = [`Metrics baseline ${baseline.window.since} → ${baseline.window.until}`]
  for (const p of baseline.projects) if (p.error) lines.push(`  ! ${p.slug}: ${p.error}`)
  const header = ['project', 'loop', 'deliv', 'merged', 'disc', 'super', 'failed', 'cost', 'cost/deliv', 'rev/d', 'fix/d', 'med build', 'med review']
  const rows = baseline.byLoop.map(g => [g.projectSlug, g.loopName ?? g.loopId ?? '-', g.deliveries, g.merged, g.discarded, g.superseded, g.failed,
    money(g.costUsd) + (g.estimatedCostUsd ? '*' : ''), money(g.costPerDeliveryUsd), ratio(g.reviewRoundsPerDelivery), ratio(g.fixerRoundsPerDelivery),
    minutes(g.medianBuildDurationMs), minutes(g.medianOnReviewMsApprox)].map(String))
  const t = baseline.totals
  rows.push(['TOTAL', '', t.deliveries, t.merged, t.discarded, t.superseded, t.failed, money(t.costUsd) + (t.estimatedCostUsd ? '*' : ''),
    money(t.costPerDeliveryUsd), ratio(t.reviewRoundsPerDelivery), ratio(t.fixerRoundsPerDelivery), minutes(t.medianBuildDurationMs), minutes(t.medianOnReviewMsApprox)].map(String))
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map(r => r[i].length)))
  const fmt = (r) => r.map((c, i) => c.padEnd(widths[i])).join('  ')
  lines.push(fmt(header), widths.map(w => '-'.repeat(w)).join('  '), ...rows.map(fmt))
  if (t.estimatedCostUsd) lines.push('* includes estimated (pricing-table) cost')
  if (t.unpricedInvocations) lines.push(`${t.unpricedInvocations} invocation(s) with unknown cost are excluded from cost totals`)
  return lines.join('\n')
}

const USAGE = `Usage: npm run metrics:baseline -- [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--project <slug|id>]... [--out <dir>]
Defaults: the last ${DEFAULT_WINDOW_DAYS} days, every registered project, out = <home>/.specrails/metrics/`

export function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv)
  if (options.help) { console.log(USAGE); return 0 }
  const home = registryHome(env)
  const baseline = buildBaseline({ home, since: options.since, until: options.until, projects: options.projects })
  const files = writeBaseline(baseline, options.out ?? path.join(home, '.specrails', 'metrics'))
  console.log(formatSummary(baseline))
  console.log(`\nWrote ${files.json}\n      ${files.csv}`)
  return 0
}

const isDirectRun = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
})()
if (isDirectRun) {
  try { process.exitCode = main() } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
