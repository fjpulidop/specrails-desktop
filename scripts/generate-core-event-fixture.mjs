/** Regenerate committed transport evidence with real Core/LangGraph and a local,
 * deterministic executor. No network, credentials or billable provider calls.
 * Run after building Core: SPECRAILS_CORE_SOURCE_DIR=/path/to/core node this-file.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

const coreRoot = process.env.SPECRAILS_CORE_SOURCE_DIR
if (!coreRoot) throw new Error('SPECRAILS_CORE_SOURCE_DIR must select the built Core checkout')
const load = name => import(pathToFileURL(path.join(coreRoot, 'dist/agent-runtime', name)).href)
const [{ ExecutorRegistry }, { configuredRoles }, { validateWorkflowDefinition }, { validationPieceRegistry }, { createRun, resumeRun, definitionRunDirectory }] = await Promise.all([
  load('executors.js'), load('engine/preflight.js'), load('engine/definition-validator.js'), load('engine/pieces/index.js'), load('engine/runs.js'),
])
const root = mkdtempSync(path.join(tmpdir(), 'core-event-fixture-'))
try {
  const repository = path.join(root, 'repo'), backlogRoot = path.join(root, 'backlog')
  mkdirSync(repository); mkdirSync(backlogRoot)
  execFileSync('git', ['init', '-q', repository])
  const role = { provider: 'fixture' }
  const config = { schemaVersion: 1, enabled: true, providers: [], agents: { architect: role, developer: role, reviewer: role }, verification: [] }
  const context = { schemaVersion: 1, runId: 'recorded-core-v2', backlogRoot, artifactRoot: repository, artifactRepositoryId: 'repo', repositories: [{ id: 'repo', name: 'Fixture', path: repository }], ownership: { git: 'host', backlog: 'host', worktrees: 'host' }, specs: [1, 2].map(id => ({ id, title: `Ticket ${id}`, description: 'Transport fixture' })) }
  const done = { kind: 'end', params: { outcome: 'success' }, ends: {} }
  const published = validateWorkflowDefinition({ schemaVersion: 1, id: 'desktop-event-fixture', title: 'Desktop event contract', journal: 'ledger-only', change: 'none', roles: [], maxTransitions: 30, entry: 'reviews', nodes: {
    reviews: { kind: 'map', params: { over: 'tickets', body: 'review', concurrency: 2 }, ends: { next: 'join' } },
    join: { kind: 'join', params: { reduce: 'all-ok' }, ends: { next: 'ask', fail: null } },
    ask: { kind: 'question', params: { text: 'Accept fixture?' }, ends: { next: 'done' } }, done,
  }, components: { review: { entry: 'read', nodes: {
    read: { kind: 'prompt', params: { engine: { provider: 'fixture' }, text: 'Read fixture {{run.index}}', access: 'read' }, ends: { next: 'done', failed: null } }, done,
  } } } }, validationPieceRegistry(), configuredRoles(config))
  assert.equal(published.ok, true, JSON.stringify(published.errors))
  let calls = 0
  const registry = new ExecutorRegistry().register('fixture', { async execute() {
    calls += 1
    return { text: 'Fixture review complete', usage: { inputTokens: 5, outputTokens: 3, costUsd: calls === 1 ? 0.02 : null, cacheReadInputTokens: 1, cacheWriteInputTokens: null } }
  } })
  const events = [], onEvent = event => events.push(event)
  const first = await createRun({ context, config, definition: published.definition, registry, onEvent })
  assert.equal(first.state.status, 'paused')
  const pausedCount = events.length
  const resumed = await resumeRun(definitionRunDirectory(context), { registry, onEvent, answers: { [first.state.pendingInterrupts[0].id]: { answer: 'Accepted' } } })
  assert.equal(resumed.state.status, 'succeeded')
  assert.equal(calls, 2)
  const output = fileURLToPath(new URL('../server/modules/loops/runtime/__fixtures__/core-v2-events.jsonl', import.meta.url))
  mkdirSync(path.dirname(output), { recursive: true })
  // Only replace the machine-specific temporary root. IDs, usage, topology and
  // event timestamps remain exactly as emitted, including resume replay.
  writeFileSync(output, events.map(event => JSON.stringify(event).split(root).join('<fixture-root>')).join('\n') + '\n')
  writeFileSync(output.replace('.jsonl', '.meta.json'), JSON.stringify({ coreCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: coreRoot, encoding: 'utf8' }).trim(), provider: 'deterministic local executor; not billed telemetry', physicalCalls: calls, pausedEventCount: pausedCount, finalEventCount: events.length, finalUsage: resumed.state.usage, finalCursor: resumed.eventCursor }, null, 2) + '\n')
  console.log(`Recorded ${events.length} real Core events (${calls} local invocations)`)
} finally { rmSync(root, { recursive: true, force: true }) }
