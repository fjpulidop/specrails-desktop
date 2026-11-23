import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, initDb, type DbInstance } from './db'
import { AUTO_CONTINUE_RUNS_KEY, initDesktopDb, setDesktopSetting } from './desktop-db'
import { createLoopRun } from './modules/loops/runtime/loop-runs-store'
import { recordRunContinuation } from './modules/loops/runtime/run-attempts'
import { serializeDiagnosis, type FailureDiagnosis } from './modules/recovery'
import { createAutoContinuation } from './project-context-auto-continue'
import type { ProjectContext } from './project-registry'

let db: DbInstance, desktopDb: DbInstance
const tasks: FailureDiagnosis = { kind: 'incomplete_tasks', confidence: 'high', phase: 'tasks', rounds: null, resetAt: null, detail: 'unfinished', resumablePhase: null, blocker: null, incompleteTasks: ['5.2 Visual review'], source: 'desktop' }

function run(id: string, outcome: string, diagnosis: FailureDiagnosis | null, forkOf?: string) {
  createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement', railIndex: 0, ticketIds: [14], iterationLimit: 1, startedAt: new Date().toISOString() })
  createJob(db, { id, command: 'loop:factory:implement #14', owner: 'loop', started_at: new Date().toISOString() })
  db.prepare("UPDATE loop_runs SET engine_version = 2, status = 'completed', final_outcome = ?, failure_diagnosis = ?, fork_of = ? WHERE id = ?").run(outcome, diagnosis ? serializeDiagnosis(diagnosis) : null, forkOf ?? null, id)
}

function coordinator(continueRun = vi.fn(async () => ({ status: 201, body: { loopRunId: 'fork-1' } }))) {
  const context = { db, loopRunManager: { isDisposed: () => false } } as unknown as ProjectContext
  return { continueRun, auto: createAutoContinuation({ context: () => context, desktopDb, continueRun, wait: async () => {}, delays: { firstMs: 0, retryMs: 0, attempts: 3 } }) }
}

beforeEach(() => {
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('automatic continuation', () => {
  it('continues a run that left tasks unfinished once, and says so in its history', async () => {
    run('run-14', 'failed', tasks)
    const { auto, continueRun } = coordinator()
    expect(await auto.settle('run-14')).toBe('continued')
    expect(continueRun).toHaveBeenCalledWith(expect.anything(), 'run-14', 'continue', { automatic: true })
    const line = db.prepare("SELECT payload FROM events WHERE job_id = 'run-14' AND event_type = 'log'").get() as { payload: string }
    expect(JSON.parse(line.payload).line).toMatch(/^Specrails continued automatically: approved tasks were left unfinished/)
  })

  it('waits out the run\'s own settlement before continuing', async () => {
    run('run-14', 'failed', tasks)
    const continueRun = vi.fn()
      .mockResolvedValueOnce({ status: 409, body: { error: 'runtime_fork_rejected', detail: 'runtime_settlement_pending: Finish original settlement before forking' } })
      .mockResolvedValueOnce({ status: 201, body: { loopRunId: 'fork-1' } })
    const { auto } = coordinator(continueRun)
    expect(await auto.settle('run-14')).toBe('continued')
    expect(continueRun).toHaveBeenCalledTimes(2)
  })

  it('declines with the setting off, for a stop, for a second time in the chain and for a repeated failure', async () => {
    run('run-14', 'failed', tasks)
    setDesktopSetting(desktopDb, AUTO_CONTINUE_RUNS_KEY, 'false')
    const { auto, continueRun } = coordinator()
    expect(await auto.settle('run-14')).toBe('declined')
    setDesktopSetting(desktopDb, AUTO_CONTINUE_RUNS_KEY, 'true')

    run('stopped', 'stopped', null)
    expect(await auto.settle('stopped')).toBe('declined')

    run('fork-a', 'failed', { ...tasks, detail: 'other words' }, 'run-14')
    recordRunContinuation(db, { runId: 'fork-a', sourceRunId: 'run-14', remedy: 'continue', mode: 'fork', fromStep: 'developer', cause: 'incomplete_tasks', guidance: null, automatic: true })
    expect(await auto.settle('fork-a')).toBe('declined')

    run('fork-b', 'failed', tasks, 'run-14')
    expect(await auto.settle('fork-b')).toBe('declined')
    expect(continueRun).not.toHaveBeenCalled()
  })

  it('waits out a provider outage before continuing, and says when it will (the 2026-11-19 routing outage)', async () => {
    const outage: FailureDiagnosis = { ...tasks, kind: 'provider_unavailable', phase: 'architect', incompleteTasks: null, resumablePhase: 'architect', detail: "The provider's service was unavailable for a moment (codex: workspace routing discovery failed); nothing about the work is wrong, and continuing re-runs the same step." }
    run('run-7', 'failed', outage)
    const waits: number[] = []
    const continueRun = vi.fn(async () => ({ status: 201, body: { loopRunId: 'fork-7' } }))
    const context = { db, loopRunManager: { isDisposed: () => false } } as unknown as ProjectContext
    const auto = createAutoContinuation({ context: () => context, desktopDb, continueRun, wait: async (ms) => { waits.push(ms) }, delays: { firstMs: 0, retryMs: 0, attempts: 3 } })
    expect(await auto.settle('run-7')).toBe('continued')
    expect(waits).toContain(120_000)
    expect(continueRun).toHaveBeenCalledTimes(1)
    const lines = (db.prepare("SELECT payload FROM events WHERE job_id = 'run-7' AND event_type = 'log' ORDER BY seq").all() as { payload: string }[]).map(row => JSON.parse(row.payload).line)
    expect(lines[0]).toBe("The provider's service was unavailable. Specrails continues this run automatically in 2 min; Continue does it now.")
    expect(lines[1]).toMatch(/^Specrails continued automatically: the provider's service was unavailable/)
  })

  it('does not continue after the outage wait when the person already continued it', async () => {
    const outage: FailureDiagnosis = { ...tasks, kind: 'provider_unavailable', incompleteTasks: null }
    run('run-8', 'failed', outage)
    const continueRun = vi.fn(async () => ({ status: 201, body: { loopRunId: 'fork-8' } }))
    const context = { db, loopRunManager: { isDisposed: () => false } } as unknown as ProjectContext
    const auto = createAutoContinuation({ context: () => context, desktopDb, continueRun, delays: { firstMs: 0, retryMs: 0, attempts: 3 },
      // The person pressed Continue during the wait: the source run now has a successor.
      wait: async (ms) => { if (ms === 120_000) db.prepare("INSERT INTO definition_fork_operations (project_id, source_run_id, request_id, child_run_id, request_json, adopted) VALUES ('p1', 'run-8', 'person', 'fork-person', '{}', 1)").run() } })
    expect(await auto.settle('run-8')).toBe('declined')
    expect(continueRun).not.toHaveBeenCalled()
  })

  it('never continues a credential blocker', async () => {
    run('run-1', 'failed', { ...tasks, kind: 'environment', incompleteTasks: null, blocker: { kind: 'credential', reason: 'npm returned 401', command: 'npm', args: ['ci'], cwd: '.', requiredAction: 'Log in to the registry' } })
    const { auto, continueRun } = coordinator()
    expect(await auto.settle('run-1')).toBe('declined')
    expect(continueRun).not.toHaveBeenCalled()
  })

  it('observes failed completions only, once per run', async () => {
    run('run-14', 'failed', tasks)
    const settled = vi.fn(async () => ({ status: 201, body: {} }))
    const { auto } = coordinator(settled)
    auto.observe({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-14', railIndex: 0, status: 'success', ticketIds: [] } as never)
    auto.observe({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-14', railIndex: 0, status: 'failed', ticketIds: [] } as never)
    auto.observe({ type: 'loop.run_completed', projectId: 'p1', loopRunId: 'run-14', railIndex: 0, status: 'failed', ticketIds: [] } as never)
    await vi.waitFor(() => expect(settled).toHaveBeenCalledTimes(1))
  })

  it('gives up on an error that is not about timing', async () => {
    run('run-14', 'failed', tasks)
    const { auto } = coordinator(vi.fn(async () => ({ status: 409, body: { error: 'remedy_not_applicable' } })))
    expect(await auto.settle('run-14')).toBe('failed')
  })
})
