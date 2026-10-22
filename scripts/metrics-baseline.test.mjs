import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { buildBaseline, parseArgs, parseTimestamp, toCsv, writeBaseline, formatSummary } from './metrics-baseline.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let home
let jobsDb

// Build both schemas with the REAL migrations (TypeScript, loaded through tsx)
// so the script's SQL is checked against the shipped column names.
function initSchemas(desktopPath, projectPath) {
  // tsx may expose a TS module as ESM named exports or as a CommonJS namespace
  // (`default`) depending on the Node version, so resolve both shapes.
  const source = `
    const pick = (mod, name) => mod[name] ?? mod.default?.[name]
    const connection = await import('./server/db/connection.ts')
    const desktop = await import('./server/desktop-db.ts')
    pick(connection, 'initDb')(${JSON.stringify(projectPath)}).close()
    pick(desktop, 'initDesktopDb')(${JSON.stringify(desktopPath)}).close()
  `
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: root, encoding: 'utf8', timeout: 60_000 })
  assert.equal(result.status, 0, result.stderr)
}

const DAY = 86_400_000
const until = Date.parse('2026-10-21T00:00:00Z')
const since = until - 28 * DAY

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'metrics-baseline-'))
  const desktopPath = path.join(home, '.specrails', 'desktop.sqlite')
  jobsDb = path.join(home, '.specrails', 'projects', 'demo', 'jobs.sqlite')
  initSchemas(desktopPath, jobsDb)

  const desktop = new Database(desktopPath)
  desktop.prepare('INSERT INTO projects (id, slug, name, path, db_path) VALUES (?, ?, ?, ?, ?)').run('p1', 'demo', 'Demo', '/tmp/demo-repo', jobsDb)
  desktop.prepare('INSERT INTO projects (id, slug, name, path, db_path) VALUES (?, ?, ?, ?, ?)').run('p2', 'ghost', 'Ghost', '/tmp/ghost-repo', path.join(home, 'missing.sqlite'))
  desktop.close()

  const db = new Database(jobsDb)
  const run = db.prepare(`INSERT INTO loop_runs (id, project_id, loop_id, loop_name, ticket_id, status, iteration_count, started_at, finished_at)
    VALUES (?, 'p1', 'factory:implement', 'Implement', ?, 'completed', ?, ?, ?)`)
  // Loop runs own a jobs row (owner='loop'); events.job_id references it.
  const job = db.prepare("INSERT INTO jobs (id, command, started_at, status, owner) VALUES (?, 'loop: Implement', '2026-10-10T10:00:00Z', 'completed', 'loop')")
  for (const id of ['run-a', 'run-b', 'run-c', 'run-old']) job.run(id)
  run.run('run-a', 1, 2, '2026-10-10T10:00:00.000Z', '2026-10-10T10:30:00.000Z')
  run.run('run-b', 2, 1, '2026-10-12T10:00:00.000Z', '2026-10-12T10:20:00.000Z')
  run.run('run-c', 3, 1, '2026-10-14T10:00:00.000Z', '2026-10-14T10:10:00.000Z')
  run.run('run-old', 4, 1, '2026-08-01T10:00:00.000Z', '2026-08-01T10:10:00.000Z')

  const delivery = db.prepare(`INSERT INTO rail_pr_deliveries (id, rail_index, loop_id, loop_name, rail_key, ticket_ids, base_branch, decision,
      implementation_outcome, run_ids, created_at, updated_at) VALUES (?, 0, 'factory:implement', 'Implement', 'k', ?, 'main', ?, ?, ?, ?, ?)`)
  // SQLite datetime('now') format (UTC, no zone) for created_at, ISO for updated_at — both real shapes.
  delivery.run('d-merged', '[1]', 'merged', 'succeeded', '["run-a"]', '2026-10-10 09:59:00', '2026-10-10T12:30:00.000Z')
  delivery.run('d-discard', '[2]', 'discarded', 'succeeded', '["run-b"]', '2026-10-12 09:59:00', '2026-10-12T11:20:00.000Z')
  delivery.run('d-unpriced', '[3]', 'on_review', 'succeeded', '["run-c"]', '2026-10-14 09:59:00', '2026-10-14T10:10:00.000Z')
  delivery.run('d-old', '[4]', 'merged', 'succeeded', '["run-old"]', '2026-08-01 09:59:00', '2026-08-01T11:00:00.000Z')

  const inv = db.prepare(`INSERT INTO ai_invocations (id, project_id, surface, surface_ref_id, ticket_id, status, started_at, total_cost_usd,
      total_cost_usd_estimated, loop_run_id, provider) VALUES (?, 'p1', ?, ?, ?, 'success', '2026-10-10T10:00:00Z', ?, ?, ?, ?)`)
  inv.run('i1', 'loop', 'att:1', 1, 1.5, 0, 'run-a', 'claude')
  inv.run('i2', 'loop', 'att:2', 1, 0.5, 1, 'run-a', 'codex')
  inv.run('i3', 'job', 'run-a:merge:resolve', 1, 0.25, 0, null, 'claude') // merge sub-row joins by prefix
  inv.run('i4', 'loop', 'att:3', 2, 2, 0, 'run-b', 'claude')
  inv.run('i5', 'loop', 'att:4', 2, null, 0, 'run-b', 'gemini') // unknown cost, alongside a priced row
  inv.run('i6', 'loop', 'att:5', 3, null, 0, 'run-c', 'gemini') // only unknown cost
  inv.run('i7', 'loop', 'att:6', 4, 9, 0, 'run-old', 'claude')
  inv.run('i8', 'loop', 'att:7', 9, 100, 0, 'unrelated-run', 'claude') // not attributable

  const step = db.prepare("INSERT INTO events (job_id, seq, event_type, payload) VALUES (?, ?, 'loop_step', ?)")
  const nodes = ['architect', 'developer', 'reviewer', 'fixer', 'reviewer']
  nodes.forEach((node, i) => step.run('run-a', i + 1, JSON.stringify({ nodeId: node, nodePath: node })))
  step.run('run-b', 1, JSON.stringify({ nodePath: 'root/fixer' }))
  db.close()
})

after(() => { if (home) fs.rmSync(home, { recursive: true, force: true }) })

const baseline = () => buildBaseline({ home, since, until, now: until })

test('joins deliveries to their runs, merge sub-rows and loop_step rounds', () => {
  const b = baseline()
  const merged = b.deliveries.find(d => d.deliveryId === 'd-merged')
  assert.equal(merged.invocations, 3)
  assert.equal(merged.costUsd, 2.25)
  assert.equal(merged.reviewRounds, 2)
  assert.equal(merged.fixerRounds, 1)
  assert.equal(merged.iterations, 2)
  assert.equal(merged.buildDurationMs, 31 * 60_000)
  assert.equal(merged.onReviewMsApprox, 2 * 3_600_000)
  assert.equal(b.deliveries.find(d => d.deliveryId === 'd-discard').fixerRounds, 1)
  const loop = b.byLoop[0]
  assert.equal(loop.deliveries, 3)
  assert.equal(loop.merged, 1)
  assert.equal(loop.discarded, 1)
  assert.equal(loop.onReview, 1)
  assert.equal(loop.costUsd, 4.25)
  assert.equal(loop.pricedDeliveries, 2)
  assert.equal(loop.costPerDeliveryUsd, 2.125)
  assert.deepEqual(b.byTicket.map(t => t.ticketId).sort(), [1, 2, 3])
})

test('unknown cost stays null, never 0, and is counted separately', () => {
  const b = baseline()
  const unpriced = b.deliveries.find(d => d.deliveryId === 'd-unpriced')
  assert.equal(unpriced.costUsd, null)
  assert.equal(unpriced.estimatedCostUsd, null)
  assert.equal(unpriced.unpricedInvocations, 1)
  assert.equal(unpriced.costComplete, false)
  assert.equal(unpriced.onReviewOpen, true)
  const partial = b.deliveries.find(d => d.deliveryId === 'd-discard')
  assert.equal(partial.costUsd, 2)
  assert.equal(partial.costComplete, false)
  assert.equal(b.byTicket.find(t => t.ticketId === 3).costUsd, null)
  assert.equal(b.byTicket.find(t => t.ticketId === 3).costPerDeliveryUsd, null)
  const csvRow = toCsv(b.deliveries).split('\n').find(line => line.includes('d-unpriced')).split(',')
  const header = toCsv([]).trim().split(',')
  assert.equal(csvRow[header.indexOf('costUsd')], '')
})

test('estimated cost is flagged and kept distinguishable', () => {
  const b = baseline()
  const merged = b.deliveries.find(d => d.deliveryId === 'd-merged')
  assert.equal(merged.estimatedCostUsd, 0.5)
  assert.equal(merged.costIncludesEstimate, true)
  assert.equal(b.deliveries.find(d => d.deliveryId === 'd-discard').costIncludesEstimate, false)
  assert.equal(b.totals.estimatedCostUsd, 0.5)
  assert.match(formatSummary(b), /includes estimated/)
})

test('window filter excludes deliveries created outside [since, until)', () => {
  const ids = baseline().deliveries.map(d => d.deliveryId)
  assert.deepEqual(ids, ['d-merged', 'd-discard', 'd-unpriced'])
  const wide = buildBaseline({ home, since: Date.parse('2026-07-01T00:00:00Z'), until, now: until })
  assert.ok(wide.deliveries.some(d => d.deliveryId === 'd-old'))
  const narrow = buildBaseline({ home, since: Date.parse('2026-10-11T00:00:00Z'), until: Date.parse('2026-10-13T00:00:00Z'), now: until })
  assert.deepEqual(narrow.deliveries.map(d => d.deliveryId), ['d-discard'])
})

test('project filter, missing project DBs and read-only access', () => {
  const b = baseline()
  assert.match(b.projects.find(p => p.slug === 'ghost').error, /not found/)
  assert.equal(buildBaseline({ home, since, until, projects: ['p1'] }).projects.length, 1)
  assert.throws(() => buildBaseline({ home, since, until, projects: ['nope'] }), /Unknown project/)
  const before = fs.statSync(jobsDb).mtimeMs
  baseline()
  assert.equal(fs.statSync(jobsDb).mtimeMs, before)
})

test('writes json + csv outside the repository only', () => {
  const b = baseline()
  const out = path.join(home, 'out')
  const files = writeBaseline(b, out)
  assert.equal(path.basename(files.json), 'baseline-2026-10-21.json')
  assert.equal(JSON.parse(fs.readFileSync(files.json, 'utf8')).deliveries.length, 3)
  assert.equal(fs.readFileSync(files.csv, 'utf8').trim().split('\n').length, 4)
  assert.throws(() => writeBaseline(b, path.join(root, 'tmp-metrics')), /inside the repository/)
})

test('argument parsing and timestamp normalisation', () => {
  const parsed = parseArgs(['--since', '2026-10-01', '--until=2026-10-15', '--project', 'demo', '--out', '/x'])
  assert.equal(parsed.since, Date.parse('2026-10-01T00:00:00Z'))
  assert.equal(parsed.until, Date.parse('2026-10-15T00:00:00Z'))
  assert.deepEqual(parsed.projects, ['demo'])
  assert.equal(parseArgs([], until).since, until - 28 * DAY)
  assert.throws(() => parseArgs(['--bogus']), /Unknown argument/)
  assert.throws(() => parseArgs(['--since', '2026-10-15', '--until', '2026-10-01']), /earlier/)
  assert.equal(parseTimestamp('2026-10-10 09:59:00'), Date.parse('2026-10-10T09:59:00Z'))
  assert.equal(parseTimestamp(null), null)
})
