import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import { appendEvent, createJob, initDb, type DbInstance } from './db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { serializeDiagnosis } from './modules/recovery'
import { readChainResolution, readRunDiagnosis, readVerificationTests, writeFailureAnalysis } from './modules/recovery/adapters/sqlite'
import { registerLoopRunRoutes } from './project-router-loop-runs'
import type { ProjectRoutesDeps } from './project-router-helpers'

const runtime = vi.hoisted(() => ({ probe: vi.fn(), fork: vi.fn(), prepare: vi.fn(), signal: vi.fn() }))
vi.mock('./modules/delivery/runtime/definition-fork', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/definition-fork')>('./modules/delivery/runtime/definition-fork'), forkDefinitionRun: runtime.fork }))
vi.mock('./modules/loops/runtime/loop-definition-recovery', () => ({ probeDefinitionRun: runtime.probe }))
vi.mock('./modules/delivery/runtime/incomplete-tasks-remedy', async () => ({ ...await vi.importActual<typeof import('./modules/delivery/runtime/incomplete-tasks-remedy')>('./modules/delivery/runtime/incomplete-tasks-remedy'), prepareIncompleteTasksFork: runtime.prepare }))
vi.mock('./modules/agent-runtime/runtime/agent-runtime-controls-router', () => ({ signalDefinitionRun: runtime.signal }))

let db: DbInstance
const begin = vi.fn()
const MENUS = 'tests/desktop/menus.spec.ts'
const blocked = (detail: string) => serializeDiagnosis({ kind: 'blocked', confidence: 'high', phase: 'correction-exhausted', rounds: 3, resetAt: null, detail, resumablePhase: null, blocker: null, source: 'core' })

function seedRun(id: string, forkOf: string | null, diagnosis: string, cost: number) {
  createLoopRun(db, { id, projectId: 'p', loopId: 'loop', loopName: 'Implement', railIndex: null, ticketId: null, provider: 'codex', model: 'gpt', iterationLimit: 1, startedAt: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'completed', final_outcome = 'failed', failure_diagnosis = ?, fork_of = ?, total_cost_usd = ? WHERE id = ?").run(diagnosis, forkOf, cost, id)
  createJob(db, { id, command: 'loop:implement', started_at: new Date().toISOString() } as never)
}
let seq = 0
function verification(runId: string, visit: number, lines: string[]) {
  for (const text of lines) appendEvent(db, runId, seq++, { event_type: 'verification-output', source: 'stdout', payload: JSON.stringify({ text: `[verification primary-1/npm] ${text}\n`, visit, nodePath: 'verify' }) })
}
const pass = (title: string) => `  ✓  21 ${MENUS}:209:1 › ${title} (843ms)`
const fail = (title: string) => `  ✘  21 ${MENUS}:209:1 › ${title} (6.1s)`
const timing = (title: string) => [`  1) ${MENUS}:209:1 › ${title} ──`, '    - Timeout 5000ms exceeded while waiting on the predicate', '  1 failed']

const OPTIONS = [
  { id: 'deterministic-close', kind: 'continue-with-guidance', label: 'Make the close tests deterministic', does: 'Launches Electron without the Playwright debugger.', consequence: 'The run can deliver once they pass every round.', risk: 'low', recommended: true, guidance: 'Launch Electron without --inspect in tests/desktop/menus.spec.ts and assert only the exit code.' },
  { id: 'manual-close', kind: 'mark-human-check', label: 'Check closing by hand after delivery', does: 'Moves the 3 close checks to manual checks.', consequence: 'The run can deliver; you verify closing by hand.', risk: 'medium', guidance: 'Salir exits from main; native close exits after the idle renderer crashes' },
  { id: 'edit', kind: 'edit-spec', label: 'Change the spec', does: 'Opens the spec.', consequence: 'You decide what closing must guarantee.', guidance: '' },
]

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.SPECRAILS_LOOPS_SECTION
  db = initDb(':memory:')
  seq = 0
  seedRun('a1', null, blocked('Automatic corrections ran out. The reviewer still asks for: [local/keep-draft] keep the draft'), 6.16)
  seedRun('a2', 'a1', blocked('Automatic corrections ran out. The reviewer still asks for: quit waits for the save'), 3.8)
  seedRun('run', 'a2', blocked('Automatic corrections ran out. Fixer: patched the exit wait'), 4.29)
  createLoopRun(db, { id: 'child', projectId: 'p', loopId: 'loop', loopName: 'Implement', railIndex: null, ticketId: null, provider: 'codex', model: 'gpt', iterationLimit: 1, startedAt: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'paused', restart_reason = 'fork' WHERE id = 'child'").run()
  verification('a1', 1, [pass('Salir exits from main')])
  verification('a2', 2, [pass('Salir exits from main')])
  verification('run', 3, [fail('Salir exits from main'), ...timing('Salir exits from main')])
  writeFailureAnalysis(db, 'run', { inputHash: 'h', language: 'en', provider: 'codex', model: null, createdAt: new Date().toISOString(),
    analysis: { headline: 'h', cause: 'c', category: 'tests', failedStep: 'verify', evidence: [], nextSteps: ['Open the evidence'], options: OPTIONS } as never })
  runtime.probe.mockResolvedValue({ status: 'paused', resumable: true, lease: null, pendingInterrupts: [], recoverableSteps: [{ attemptId: 'attempt', nodePath: 'verify', scopeId: 'root' }] })
  runtime.fork.mockResolvedValue({ loopRunId: 'child', forkOf: 'run', fromNodePath: 'verify', scopeId: 'root', visit: 3 })
  runtime.signal.mockResolvedValue({ id: 's1', acceptedAt: new Date().toISOString() })
  begin.mockImplementation(() => new Promise(() => {}))
  // A paused run resumes in place (no Core definition needed for the plan).
  db.prepare("UPDATE loop_runs SET status = 'paused', run_request_json = ?, runtime_metadata_json = ? WHERE id = 'run'").run(JSON.stringify({ runId: 'run', projectId: 'p', loopId: 'loop', cwd: '/repo' }), JSON.stringify({ source: 'definition' }))
})
afterEach(() => db.close())

function api() {
  const app = express(), router = express.Router()
  app.use(express.json())
  registerLoopRunRoutes({ router, ctx: () => ({ db, project: { id: 'p', path: '/repo' }, loopRunManager: { beginDefinitionResume: begin, isDefinitionRunActive: () => false, cancelDefinition: vi.fn(), isDisposed: () => false }, onLoopRunFinished: vi.fn() }) } as unknown as ProjectRoutesDeps)
  app.use('/api', router)
  return request(app)
}
const sent = () => runtime.signal.mock.calls[0]?.[2] as string

describe('picking a resolution', () => {
  it('continues with the picked option\'s guidance read from the stored analysis, plus the flaky tests rule', async () => {
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue', optionId: 'deterministic-close', guidance: 'IGNORED from the client' })
    expect(result.status).toBe(202)
    expect(result.body).toMatchObject({ remedy: 'continue', option: 'Make the close tests deterministic', guided: true })
    expect(sent()).toContain('"Make the close tests deterministic"')
    expect(sent()).toContain('Launch Electron without --inspect')
    expect(sent()).not.toContain('IGNORED')
    expect(sent()).toContain(`- ${MENUS} › Salir exits from main`)
    expect(sent()).toMatch(/Do not lengthen timeouts/)
    // The analysis' old plan is not sent with a picked option.
    expect(sent()).not.toContain('Open the evidence')
    expect((db.prepare('SELECT guidance FROM run_continuations').get() as { guidance: string }).guidance).toContain('Make the close tests deterministic')
  })

  it('moves named checks to [human] checks for the person', async () => {
    const result = await api().post('/api/p/loop-runs/run/remedy').send({ optionId: 'manual-close' })
    expect(result.status).toBe(202)
    expect(sent()).toContain('Which checks: Salir exits from main; native close exits after the idle renderer crashes')
    expect(sent()).toContain('[human]')
  })

  it('continues with the person\'s own instruction, bounded and validated', async () => {
    const ok = await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue', instruction: '  Use a fake clock in the close tests  ' })
    expect(ok.status).toBe(202)
    expect(sent()).toMatch(/own instruction[\s\S]*Use a fake clock in the close tests/)
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ instruction: ' ' })).status).toBe(400)
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ instruction: 'x'.repeat(4001) })).status).toBe(400)
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ instruction: 'a', optionId: 'deterministic-close' })).status).toBe(400)
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue-to-review', instruction: 'a' })).status).toBe(400)
  })

  it('refuses an unknown option, a malformed id and an option that runs on the client', async () => {
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ optionId: 'nope' })).status).toBe(404)
    expect((await api().post('/api/p/loop-runs/run/remedy').send({ optionId: '../x' })).status).toBe(400)
    const client = await api().post('/api/p/loop-runs/run/remedy').send({ optionId: 'edit' })
    expect(client.status).toBe(400)
    expect(client.body.error).toBe('option_runs_on_client')
    expect(runtime.signal).not.toHaveBeenCalled()
  })

  it('a plain Continue with options in the analysis is "keep going": no plan, no option', async () => {
    await api().post('/api/p/loop-runs/run/remedy').send({ remedy: 'continue' })
    const text = sent() ?? ''
    expect(text).not.toContain('Open the evidence')
    expect(text).not.toContain('Make the close tests deterministic')
  })
})

describe('the chain behind the card', () => {
  beforeEach(() => { db.prepare("UPDATE loop_runs SET status = 'completed' WHERE id = 'run'").run() })
  it('reads the failing and flaky tests of the latest verification across the chain', () => {
    expect(readVerificationTests(db, 'run')).toMatchObject({ failingTests: [`${MENUS} › Salir exits from main`], flakyTests: [`${MENUS} › Salir exits from main`] })
    expect(readRunDiagnosis(db, 'run')).toMatchObject({ failingTests: [`${MENUS} › Salir exits from main`], flakyTests: [`${MENUS} › Salir exits from main`] })
    // The first attempt alone has passing tests only.
    expect(readRunDiagnosis(db, 'a1')?.failingTests).toBeUndefined()
  })

  it('says the chain keeps stopping the same way, with its spend, and serves it with the attempts', async () => {
    expect(readChainResolution(db, 'run')).toEqual({ attempts: 3, costUsd: 14.25, costEstimated: false, repeated: true, times: 3 })
    expect(readChainResolution(db, 'a2')).toMatchObject({ attempts: 2, repeated: false })
    expect(readChainResolution(db, 'a1')).toBeNull()
    const result = await api().get('/api/p/loop-runs/run/attempts')
    expect(result.body.resolution).toMatchObject({ attempts: 3, repeated: true, costUsd: 14.25 })
  })
})
