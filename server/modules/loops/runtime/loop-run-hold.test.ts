import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, createJob, appendEvent, type DbInstance } from '../../../db'
import { createLoopRun, pauseLoopRun } from './loop-runs-store'
import { saveLimitPause } from './loop-limit-pauses'
import { deriveRunHold, readRunHold, readRunHolds, type RunHoldFacts } from './loop-run-hold'

const facts = (over: Partial<RunHoldFacts> = {}): RunHoldFacts => ({
  loopStatus: 'paused', restartReason: null, checkpoint: null, retainedLimit: null, live: null,
  restartPending: false, lastActivityAt: '2026-11-19T14:51:45.000Z', ...over,
})

// The checkpoint startup recovery writes for a run the restart cut off mid developer step.
const RESTART_CHECKPOINT = {
  coreStatus: 'running', status: 'interrupted', lease: { active: false }, pendingInterrupts: [],
  recoverableSteps: [{ attemptId: 'a3e7afe4', nodePath: 'developer', scopeId: 'root' }],
}
const LIMIT = { providerId: 'claude', resumeAt: '2026-11-19T18:00:00.000Z', autoResume: true, message: 'limit', pausedAt: '2026-11-19T15:00:00.000Z', switchable: false }

describe('deriveRunHold', () => {
  it('a run paused by an app restart is a restart hold of the step that was working, since its last event', () => {
    expect(deriveRunHold(facts({ restartReason: 'restart', checkpoint: RESTART_CHECKPOINT })))
      .toEqual({ kind: 'restart', step: 'developer', since: '2026-11-19T14:51:45.000Z' })
  })

  it('a run startup recovery has not reconciled yet reads as paused by the restart at once', () => {
    expect(deriveRunHold(facts({ loopStatus: 'running', restartPending: true }))?.kind).toBe('restart')
    // Without the startup mark a running row is genuinely working.
    expect(deriveRunHold(facts({ loopStatus: 'running' }))).toBeNull()
  })

  it('an interrupted write outside a restart is its own hold', () => {
    expect(deriveRunHold(facts({ checkpoint: { status: 'interrupted', recoverableSteps: [{ attemptId: 'x', nodePath: 'fixer', scopeId: 'root' }] } })))
      .toMatchObject({ kind: 'interrupted', step: 'fixer' })
  })

  it('a usage limit (live or retained over a restart) waits for its reset', () => {
    expect(deriveRunHold(facts({ live: { budget: false, limit: LIMIT, pending: [] } })))
      .toMatchObject({ kind: 'provider_limit', since: LIMIT.pausedAt, resumeAt: LIMIT.resumeAt })
    expect(deriveRunHold(facts({ restartReason: 'restart', retainedLimit: LIMIT, checkpoint: RESTART_CHECKPOINT })))
      .toMatchObject({ kind: 'provider_limit' })
  })

  it('the budget cap and a question are their own holds', () => {
    expect(deriveRunHold(facts({ restartReason: 'budget_paused' }))?.kind).toBe('budget')
    expect(deriveRunHold(facts({ live: { budget: true, limit: null, pending: [] } }))?.kind).toBe('budget')
    expect(deriveRunHold(facts({ live: { budget: false, limit: null, pending: [{ kind: 'question' }] } }))?.kind).toBe('question')
    expect(deriveRunHold(facts({ live: { budget: false, limit: null, pending: [{ kind: 'approval' }] } }))?.kind).toBe('approval')
    // A question retained over a restart is still a question, not a restart.
    expect(deriveRunHold(facts({ restartReason: 'restart', checkpoint: { pendingInterrupts: [{ kind: 'question', nodePath: 'architect' }] } })))
      .toMatchObject({ kind: 'question', step: 'architect' })
  })

  it('a host task is the host working, never a hold', () => {
    expect(deriveRunHold(facts({ loopStatus: 'running', checkpoint: { pendingInterrupts: [{ kind: 'host-task' }] } }))).toBeNull()
  })
})

describe('readRunHolds', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })

  function run(id: string) {
    createLoopRun(db, { id, projectId: 'p1', loopId: 'factory:implement', loopName: 'Implement', railIndex: 0, ticketId: 15, provider: 'claude', model: 'haiku', reasoningEffort: null, iterationLimit: 1, startedAt: '2026-11-19T14:35:16.238Z' })
    createJob(db, { id, command: 'loop: Implement #15', started_at: '2026-11-19T14:35:16.238Z', provider: 'claude', owner: 'loop' })
  }

  it('reads the restart hold of a paused run whose job row still says running', () => {
    run('r1')
    appendEvent(db, 'r1', 0, { event_type: 'log', source: 'stdout', payload: '{}' })
    db.prepare("UPDATE events SET timestamp = '2026-11-19 14:51:45' WHERE job_id = 'r1'").run()
    db.prepare("UPDATE loop_runs SET status='paused', restart_reason='restart', runtime_status_json=? WHERE id='r1'").run(JSON.stringify(RESTART_CHECKPOINT))
    expect(readRunHold(db, 'r1')).toEqual({ kind: 'restart', step: 'developer', since: '2026-11-19T14:51:45.000Z' })
  })

  it('omits working runs and reads retained usage limits and startup-pending runs', () => {
    run('working'); run('limited'); run('booting')
    pauseLoopRun(db, 'limited', undefined, 'limit_paused')
    saveLimitPause(db, 'limited', LIMIT)
    const holds = readRunHolds(db, ['working', 'limited', 'booting', 'not-a-loop'], { restartPending: new Set(['booting']) })
    expect(holds.has('working')).toBe(false)
    expect(holds.get('limited')?.kind).toBe('provider_limit')
    expect(holds.get('booting')?.kind).toBe('restart')
    expect(holds.has('not-a-loop')).toBe(false)
  })

  it('prefers the live manager pause and survives a failing source', () => {
    run('asked')
    pauseLoopRun(db, 'asked')
    expect(readRunHold(db, 'asked', { livePause: () => ({ budget: false, limit: null, pending: [{ kind: 'question' }] }) })?.kind).toBe('question')
    expect(readRunHold(db, 'asked', { livePause: () => { throw new Error('gone') } })?.kind).toBe('paused')
  })
})
