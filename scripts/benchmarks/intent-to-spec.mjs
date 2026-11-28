#!/usr/bin/env node
/**
 * Intent → Spec benchmark (docs/internals/intent-to-spec-performance.md).
 *
 * Replays a real Intent hand-off on a fixed commit against a running Specrails
 * (dev by default: port 4300, registry ~/.specrails-dev) through its own MCP
 * server, then measures the run: duration, cost, tokens, AI turns, correction
 * rounds, review scores and whether review issues converge. Never touches the
 * source project: the case runs in a fixture clone registered as its own project.
 *
 *   node scripts/benchmarks/intent-to-spec.mjs <case.json> [--dry] [--resume <runId>]
 *     [--measure <runId>] [--provider <id>] [--model <id>] [--effort <level>] [--tag <label>] [--max-quota <percent>]
 *
 * Case file: { name, sourceRepo, baseSha, headSha, idea, sourceMission?, forkThroughMessage?,
 *   provider?, model?, effort? }. With sourceMission the real conversation up to the hand-off is
 * forked; without it (a synthetic case) the Intent starts from the idea alone. Flags override the
 * case's engine; --tag labels the variant being measured. Results: <registry>/.specrails/bench/results/.
 * Exits 3 without launching when the provider's usage is at or above --max-quota (default 70 %).
 * Spends real provider money (one full Intent → Spec run).
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const require = createRequire(path.join(root, 'package.json'))
const { Client } = require('@modelcontextprotocol/sdk/client/index.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const Database = require('better-sqlite3')

const casePath = process.argv[2]
if (!casePath) { console.error('usage: intent-to-spec.mjs <case.json> [--dry]'); process.exit(2) }
const dry = process.argv.includes('--dry')
// --resume <runId>: continue a run of this case that a provider usage limit paused (it does not resume by itself).
const resumeIndex = process.argv.indexOf('--resume')
const resumeRun = resumeIndex > 0 ? process.argv[resumeIndex + 1] : null
const flag = (name) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined }
const spec = JSON.parse(fs.readFileSync(casePath, 'utf8'))
for (const key of ['provider', 'model', 'effort']) if (flag(key)) spec[key] = flag(key)
const tag = flag('tag') ?? null
const maxQuota = Number(flag('max-quota') ?? 70)
const home = process.env.SPECRAILS_REGISTRY_HOME || path.join(os.homedir(), '.specrails-dev')
const port = Number(process.env.SPECRAILS_DEV_SERVER_PORT || 4300)
const state = path.join(home, '.specrails')
const benchDir = path.join(state, 'bench')
const fixtureDir = path.join(benchDir, 'fixtures', spec.name)
const resultsDir = path.join(benchDir, 'results')
fs.mkdirSync(resultsDir, { recursive: true })

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args)
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

// ── Fixture: a clone whose main is the case base, registered as its own project ──
function prepareFixture() {
  if (!fs.existsSync(path.join(fixtureDir, '.git'))) {
    fs.mkdirSync(path.dirname(fixtureDir), { recursive: true })
    git(['clone', '--no-hardlinks', '--quiet', spec.sourceRepo, fixtureDir], benchDir)
  }
  git(['fetch', '--quiet', spec.sourceRepo, spec.headSha], fixtureDir)
  git(['checkout', '--quiet', '-B', 'main', spec.baseSha], fixtureDir)
  git(['reset', '--quiet', '--hard', spec.baseSha], fixtureDir)
  // Earlier runs' Intent worktrees and branches stay as evidence; prune stale registrations only.
  git(['worktree', 'prune'], fixtureDir)
}

const token = fs.readFileSync(path.join(state, 'desktop.token'), 'utf8').trim()
async function api(method, url, body) {
  const res = await fetch(`http://127.0.0.1:${port}/api${url}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

async function ensureProject() {
  const list = await api('GET', '/projects')
  const projects = list.projects ?? list
  const found = projects.find((p) => path.resolve(p.path) === path.resolve(fixtureDir))
  if (found) return found
  const created = await api('POST', '/projects', { path: fixtureDir, name: `bench-${spec.name}`, provider: spec.provider ?? 'codex' })
  return created.project ?? created
}

// ── MCP: the same calls an external client makes ──
async function mcp() {
  const mcpToken = fs.readFileSync(path.join(state, 'mcp.token'), 'utf8').trim()
  const client = new Client({ name: 'intent-spec-bench', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp`), { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } }))
  const call = async (name, args) => {
    let envelope = (await client.callTool({ name, arguments: args })).structuredContent ?? {}
    if (envelope.ok === false && envelope.error?.code === 'confirmation_required') {
      envelope = (await client.callTool({ name, arguments: { ...args, confirm: envelope.error.confirmToken } })).structuredContent ?? {}
    }
    if (envelope.ok === false) throw new Error(`${name}(${args.action}): ${envelope.error?.code} ${envelope.error?.message ?? ''}`)
    return envelope
  }
  return { call, close: () => client.close() }
}

function projectDb(project) {
  return new Database(path.join(state, 'projects', project.slug, 'jobs.sqlite'), { readonly: true, fileMustExist: true })
}

// ── Measurement ──
function measure(project, runId) {
  const db = projectDb(project)
  try {
    const run = db.prepare('SELECT * FROM loop_runs WHERE id = ?').get(runId)
    const turns = db.prepare('SELECT surface_ref_id, started_at, duration_ms, tokens_in, tokens_out, tokens_cache_read, total_cost_usd FROM ai_invocations WHERE loop_run_id = ? ORDER BY started_at').all(runId)
    const store = coreStore(project, runId)
    const steps = []
    if (store) {
      const core = new Database(store, { readonly: true })
      try {
        for (const attempt of core.prepare("SELECT node_path, visit, started_at, ended_at, outcome, output_json FROM attempts WHERE node_path IN ('derive','check','review','fix','archive','verify') ORDER BY started_at").all()) {
          let output = {}
          try { output = JSON.parse(attempt.output_json || '{}') } catch { /* unreadable */ }
          const review = attempt.node_path === 'review' ? findKey(output, 'structured') ?? output : null
          steps.push({
            node: attempt.node_path, visit: attempt.visit, outcome: attempt.outcome,
            seconds: Math.round((Date.parse(attempt.ended_at) - Date.parse(attempt.started_at)) / 1000),
            ...(review ? { approved: findKey(review, 'approved'), score: findKey(review, 'score'), issues: findKey(review, 'issues') ?? [], followUps: findKey(review, 'followUps') ?? [] } : {}),
          })
        }
      } finally { core.close() }
    }
    const reviews = steps.filter((step) => step.node === 'review')
    return {
      runId, outcome: run?.final_outcome ?? run?.status ?? null, status: run?.status ?? null,
      durationMin: run?.total_duration_ms ? +(run.total_duration_ms / 60000).toFixed(1) : null,
      costUsd: run?.total_cost_usd != null ? +Number(run.total_cost_usd).toFixed(2) : null,
      tokensM: run?.total_tokens != null ? +(run.total_tokens / 1e6).toFixed(1) : null,
      aiTurns: turns.length,
      correctionRounds: steps.filter((step) => step.node === 'fix').length,
      reviews: reviews.map((review) => ({ score: review.score, approved: review.approved, issues: review.issues.length, followUps: review.followUps.length })),
      steps,
      turns: turns.map((turn) => ({ at: turn.started_at, seconds: Math.round(turn.duration_ms / 1000), inM: +((turn.tokens_in ?? 0) / 1e6).toFixed(2), costUsd: +(turn.total_cost_usd ?? 0).toFixed(2) })),
    }
  } finally { db.close() }
}

/** Refuses to start a run the provider's quota cannot finish (exit 3): the next scheduled pass retries. */
async function quotaGate() {
  const provider = spec.provider ?? 'codex'
  const quota = (await api('GET', '/provider-quota')).providers?.find((entry) => entry.providerId === provider)
  if (!quota) return
  const used = Math.max(0, ...(quota.windows ?? []).filter((window) => Date.parse(window.resetsAt ?? '') > Date.now()).map((window) => window.usedPercent ?? 0))
  const expired = (quota.windows ?? []).every((window) => Date.parse(window.resetsAt ?? '') <= Date.now())
  if (used >= maxQuota || (quota.level === 'rejected' && !expired && used >= 100)) {
    log(`skip: ${provider} usage ${used} % (limit ${maxQuota} %)`)
    process.exit(3)
  }
}

/** The run's Core store: in the Intent worktree the rail ran in (worktrees/<flow>/<ticket>), else the workspace. */
function coreStore(project, runId) {
  const base = path.join(state, 'projects', project.slug)
  const tail = path.join('.specrails', 'pipeline', runId, 'agent-workflow', 'run.sqlite')
  const candidates = [path.join(base, 'workspace', tail)]
  const worktrees = path.join(base, 'worktrees')
  if (fs.existsSync(worktrees)) for (const flow of fs.readdirSync(worktrees)) {
    const dir = path.join(worktrees, flow)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const ticket of fs.readdirSync(dir)) candidates.push(path.join(dir, ticket, tail))
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null
}

function findKey(value, key, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null
  if (Object.hasOwn(value, key)) return value[key]
  for (const child of Object.values(value)) { const found = findKey(child, key, depth + 1); if (found !== null) return found }
  return null
}

/**
 * Waits (local database, every 20 s, at most 2 h) until the run settles. A provider usage
 * limit pauses it without resuming by itself: that ends the wait with the resume hint.
 */
async function settle(project, runId) {
  let deadline = Date.now() + 2 * 3600_000
  for (;;) {
    const check = projectDb(project)
    const row = check.prepare('SELECT status, restart_reason FROM loop_runs WHERE id = ?').get(runId)
    const pause = check.prepare('SELECT value FROM queue_state WHERE key = ?').get(`limit_pause:${runId}`)
    check.close()
    if (row && row.status === 'paused' && pause) {
      let limit = {}
      try { limit = JSON.parse(pause.value) } catch { /* unreadable */ }
      // A limit pause that knows its reset resumes by itself: keep waiting past it.
      if (!limit.autoResume || !limit.resumeAt) throw new Error(`run ${runId} paused at a provider usage limit; once it resets: --resume ${runId}`)
      deadline = Math.max(deadline, Date.parse(limit.resumeAt) + 2 * 3600_000)
    }
    if (row && !['running', 'queued', 'pending', 'paused'].includes(row.status)) return
    if (Date.now() > deadline) throw new Error('run did not settle within 2 h')
    await sleep(20_000)
  }
}

function record(project, runId, extra) {
  const result = { case: spec.name, at: new Date().toISOString(), tag, commit: git(['rev-parse', '--short', 'HEAD'], root), provider: spec.provider ?? null, model: spec.model ?? null, effort: spec.effort ?? null, ...extra, ...measure(project, runId) }
  const file = path.join(resultsDir, `${result.at.replace(/[:.]/g, '-')}-${spec.name}.json`)
  fs.writeFileSync(file, JSON.stringify(result, null, 2))
  fs.appendFileSync(path.join(resultsDir, 'results.jsonl'), JSON.stringify({ ...result, steps: undefined, turns: undefined }) + '\n')
  log(`done: ${result.outcome} · ${result.durationMin} min · $${result.costUsd} · ${result.aiTurns} turns · ${result.correctionRounds} rounds · reviews ${JSON.stringify(result.reviews)}`)
  log(`result ${file}`)
}

async function main() {
  log(`case ${spec.name}: ${spec.baseSha.slice(0, 7)} → ${spec.headSha.slice(0, 7)}`)
  prepareFixture()
  const project = await ensureProject()
  log(`fixture project ${project.slug} (${project.id})`)
  if (dry) { log('dry run: fixture ready, nothing launched'); return }
  // --measure <runId>: record an already settled run again (after a measurement fix).
  if (flag('measure')) { record(project, flag('measure'), { remeasured: true }); return }
  if (!resumeRun) await quotaGate()

  const { call, close } = await mcp()
  try {
    if (resumeRun) {
      await call('specrails_runs', { action: 'resume', ref: `run:${project.slug}/${resumeRun}` })
      log(`resumed run ${resumeRun}`)
      await settle(project, resumeRun)
      record(project, resumeRun, { resumed: true })
      return
    }
    const engine = { ...(spec.provider ? { provider: spec.provider } : {}), ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) }
    let mission = null
    let started
    if (spec.sourceMission) {
      // 1. The real conversation up to the hand-off, so the reviewer sees the same requests and decisions.
      const fork = await call('specrails_missions', { action: 'branch', ref: `mission:${spec.sourceMission}`, options: { mode: 'fork', throughMessageId: spec.forkThroughMessage } })
      mission = fork.refs?.mission ?? fork.data?.ref
      await call('specrails_missions', { action: 'update', ref: mission, title: `bench ${spec.name} ${new Date().toISOString().slice(0, 16)}`, options: { pin: project.id }, ...engine })
      log(`mission ${mission}`)
      // 2. A fresh Intent on the fixture base (no seeded opening turn: started from the idea).
      started = await call('specrails_missions', { action: 'intent_start', ref: mission, message: spec.idea })
    } else {
      // 1–2. Synthetic case: a new mission in the fixture project whose Intent starts from the idea.
      started = await call('specrails_missions', { action: 'intent_start', project: project.slug, message: spec.idea, ...engine })
      mission = started.refs?.mission ?? null
    }
    const intent = started.refs?.intent ?? started.data?.ref
    const flowId = intent.split('/').pop()
    const db = projectDb(project)
    const flow = db.prepare('SELECT worktree_path, branch FROM flow_sessions WHERE id = ?').get(flowId)
    db.close()
    // 3. The Intent's code: exactly the commit the real session handed off.
    git(['fetch', '--quiet', spec.sourceRepo, spec.headSha], flow.worktree_path)
    git(['reset', '--quiet', '--hard', spec.headSha], flow.worktree_path)
    log(`intent ${intent} on ${flow.branch} @ ${spec.headSha.slice(0, 7)}`)

    // 4. Hand off to a rail: the Intent → Spec run being measured.
    const handed = await call('specrails_missions', { action: 'intent_hand_off', ref: intent })
    const runRef = (handed.data?.runs ?? [])[0]
    const runId = String(runRef ?? '').split('/').pop()
    if (!runId) throw new Error(`hand-off returned no run: ${JSON.stringify(handed.data).slice(0, 300)}`)
    log(`run ${runId}`)

    // 5. Wait for it to settle, then measure.
    await settle(project, runId)
    record(project, runId, { mission, intent })
  } finally {
    await close()
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1) })
