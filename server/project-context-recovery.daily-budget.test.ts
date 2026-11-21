import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createJob, getJobEvents, initDb, type DbInstance } from './db'
import { initDesktopDb, setDesktopSetting, RESUME_ON_DAILY_RESET_KEY } from './desktop-db'
import { createLoopRun, writeLoopRunCap } from './modules/loops/runtime/loop-runs-store'
import { readBudgetHold, saveBudgetHold, saveRetainedBudgetPause } from './modules/loops/runtime/loop-budget-pauses'
import { BUDGET_RESET_RESUME_EVENT } from './modules/loops/runtime/loop-budget-reset-resume'
import { saveUserPause } from './modules/loops/runtime/loop-user-pauses'
import { bindResumeClock } from './modules/provider-quota/runtime/quota-reports'
import type { ProjectContext } from './project-registry'

const resume = vi.hoisted(() => vi.fn(async () => ({ status: 202, body: { loopRunId: 'r1' } })))
vi.mock('./project-router-loop-runs', async () => ({
  ...await vi.importActual<object>('./project-router-loop-runs'),
  resumeRetainedDefinitionRun: resume,
}))

const { scheduleRetainedDailyBudgetResumes } = await import('./project-context-recovery')

let db: DbInstance
let desktopDb: DbInstance
let dailyRejection: ReturnType<typeof vi.fn>
const scheduled: Array<{ at: number; fire: () => void; cancelled: boolean }> = []
const due = () => scheduled.filter((entry) => !entry.cancelled)
const fireAll = () => { const entries = due(); scheduled.length = 0; for (const entry of entries) entry.fire() }

/** A Core run a restart retained while it was held on the daily budget (reset already passed: held over midnight while the app was closed). */
function retainedRun(runId = 'r1', resetsAt = '2026-11-21T00:00:00.000Z') {
  createJob(db, { id: runId, command: 'loop:implement', started_at: '2026-11-20T21:00:00Z', owner: 'loop' })
  createLoopRun(db, { id: runId, projectId: 'p1', loopId: 'implement', ticketIds: [], provider: 'claude', model: 'haiku', iterationLimit: 3, startedAt: '2026-11-20T21:00:00Z' })
  db.prepare("UPDATE loop_runs SET engine_version=2, status='paused', restart_reason='restart' WHERE id=?").run(runId)
  saveRetainedBudgetPause(db, runId)
  saveBudgetHold(db, runId, { scope: 'project', resetsAt })
}

function context(): ProjectContext {
  return { db, desktopDb, dailyBudgetRejection: dailyRejection, broadcast: vi.fn(), loopRunManager: { budgetPause: () => null } } as unknown as ProjectContext
}

beforeEach(() => {
  db = initDb(':memory:')
  desktopDb = initDesktopDb(':memory:')
  dailyRejection = vi.fn(() => null)
  resume.mockClear()
  scheduled.length = 0
  bindResumeClock({
    schedule(at, fire) { const entry = { at, fire, cancelled: false }; scheduled.push(entry); return { cancel() { entry.cancelled = true } } },
    pending: () => due().length,
    dispose() {},
  })
  vi.spyOn(console, 'log').mockImplementation(() => {})
})
afterEach(() => { bindResumeClock(null); vi.restoreAllMocks() })

describe('daily budget reset after a restart', () => {
  it('resumes a run held over midnight while the app was closed, at startup, through the person\'s Resume path', async () => {
    retainedRun()
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    expect(due().map((entry) => new Date(entry.at).toISOString())).toEqual(['2026-11-21T00:00:00.000Z'])
    fireAll()
    await vi.waitFor(() => expect(resume).toHaveBeenCalledTimes(1))
    // The same door as the person's Resume of a restart-paused run: budget gate, capacity admission, re-run the cut step.
    expect(resume).toHaveBeenCalledWith(expect.anything(), 'r1', {}, { restartResume: true })
    const events = getJobEvents(db, 'r1')
    expect(events.some((event) => event.event_type === 'log' && event.payload.includes('The day reset'))).toBe(true)
    expect(events.find((event) => event.event_type === BUDGET_RESET_RESUME_EVENT)?.payload).toBe(JSON.stringify({ scope: 'project', resetsAt: '2026-11-21T00:00:00.000Z' }))
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[budget] demo: run r1 resumes by itself'))
    await vi.waitFor(() => expect(readBudgetHold(db, 'r1')).toBeNull())
  })

  it('never resumes a run the person paused', () => {
    retainedRun()
    saveUserPause(db, 'r1', { requestId: 'req', requestedAt: '2026-11-20T22:00:00Z', pausedAt: '2026-11-20T22:00:01Z' })
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    fireAll()
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps a run its own per-run cap still blocks held, says why, and does not schedule it again', () => {
    retainedRun()
    writeLoopRunCap(db, 'r1', 1)
    db.prepare('UPDATE loop_runs SET total_cost_usd = 2 WHERE id = ?').run('r1')
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    fireAll()
    expect(resume).not.toHaveBeenCalled()
    expect(readBudgetHold(db, 'r1')).toMatchObject({ period: 'run' })
    expect(getJobEvents(db, 'r1').some((event) => event.payload.includes('The day reset, but the run stays held'))).toBe(true)
    expect(due()).toEqual([])
  })

  it('does nothing with the setting off', () => {
    retainedRun()
    setDesktopSetting(desktopDb, RESUME_ON_DAILY_RESET_KEY, 'false')
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    fireAll()
    expect(resume).not.toHaveBeenCalled()
    expect(readBudgetHold(db, 'r1')).not.toBeNull()
  })

  it('waits for the next reset when the new day\'s budget is already spent', () => {
    retainedRun()
    dailyRejection.mockReturnValue({ error: 'daily_budget_exceeded', scope: 'project', budgetUsd: 5, spentUsd: 6, resetsAt: '2026-11-22T00:00:00.000Z', detail: 'Spent again.', action: 'Raise it.' })
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    fireAll()
    expect(resume).not.toHaveBeenCalled()
    expect(due().map((entry) => new Date(entry.at).toISOString())).toEqual(['2026-11-22T00:00:00.000Z'])
    dailyRejection.mockReturnValue(null)
    fireAll()
    expect(resume).toHaveBeenCalledTimes(1)
  })

  it('drops the hold of a run that did not survive the restart', () => {
    retainedRun()
    db.prepare("UPDATE loop_runs SET status='completed' WHERE id='r1'").run()
    scheduleRetainedDailyBudgetResumes(context(), db, () => true, 'demo')
    expect(due()).toEqual([])
    expect(readBudgetHold(db, 'r1')).toBeNull()
  })
})
