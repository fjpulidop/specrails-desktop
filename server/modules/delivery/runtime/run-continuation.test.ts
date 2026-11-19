import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import type { FailureDiagnosis } from '../../recovery'
import { normalizeContinueRemedy, planContinuation, stoppedStep } from './run-continuation'

const frozen = vi.hoisted(() => ({ value: undefined as unknown, prepare: vi.fn() }))
vi.mock('../../loops/runtime/loop-runs-store', async () => ({ ...await vi.importActual<object>('../../loops/runtime/loop-runs-store'), readDefinitionRun: () => frozen.value }))
vi.mock('./incomplete-tasks-remedy', async () => ({ ...await vi.importActual<object>('./incomplete-tasks-remedy'), prepareIncompleteTasksFork: frozen.prepare }))

let db: DbInstance
beforeEach(() => {
  db = initDb(':memory:')
  frozen.value = { row: { status: 'completed' }, metadata: { definition: { nodes: { developer: {}, verify: {}, reviewer: {} } } } }
  frozen.prepare.mockReset()
})

const probe = (scopes: DefinitionRunProbe['scopes'], patch: Partial<DefinitionRunProbe> = {}): DefinitionRunProbe => ({
  runId: 'run', engineVersion: 2, status: 'cancelled', resumable: false, lease: null, recoverableSteps: [], pendingInterrupts: [], completion: null,
  scopes, coreRevision: 1, eventCursor: 1, probedAt: '', ...patch,
})
const scope = (nodePath: string, status: string, visits = 1) => ({ nodePath, scopeId: 'root', kind: 'step', status, attemptId: `a-${nodePath}`, visits })
const diagnosis = (patch: Partial<FailureDiagnosis>): FailureDiagnosis => ({ kind: 'crash', confidence: 'high', phase: null, rounds: null, resetAt: null, detail: null, resumablePhase: null, blocker: null, source: 'core', ...patch })

describe('Continue: how a run goes on', () => {
  it('maps the older remedy id to Continue and rejects anything else', () => {
    expect(normalizeContinueRemedy('retry-with-browser')).toBe('continue')
    expect(normalizeContinueRemedy('continue')).toBe('continue')
    expect(normalizeContinueRemedy('continue-to-review')).toBe('continue-to-review')
    expect(normalizeContinueRemedy('retry')).toBeNull()
  })

  it('continues a stopped run from the step it stopped on, at its latest visit, in the same worktree', () => {
    const plan = planContinuation(db, 'run', 'continue', probe([scope('planner', 'succeeded'), scope('developer', 'cancelled', 2), scope('verify', 'pending')]), null)
    expect(plan).toEqual({ mode: 'fork', fromStep: 'developer', request: { requestId: expect.stringMatching(/^remedy-continue-/), fromNodePath: 'developer', scopeId: 'root', visit: 2 } })
  })

  it('prefers the step the diagnosis names, then an interrupted write', () => {
    const scopes = [scope('developer', 'failed'), scope('verify', 'failed', 3)]
    expect(planContinuation(db, 'run', 'continue', probe(scopes), diagnosis({ phase: 'verify' })).fromStep).toBe('verify')
    expect(stoppedStep(probe(scopes, { recoverableSteps: [{ attemptId: 'x', nodePath: 'verify', scopeId: 'root' }] }), null)).toEqual({ nodePath: 'verify', visit: 3 })
  })

  it('never forks from an end node: a host blocker continues from the step that reported it', () => {
    // The Implement recipe ends on `fixer-blocked` (kind end, blockerFrom fixer); forking there replayed the end.
    frozen.value = { row: { status: 'completed' }, metadata: { definition: { nodes: { verify: {}, fixer: {}, 'fixer-blocked': { kind: 'end', params: { blockerFrom: 'fixer', outcome: 'failure' } }, done: { kind: 'end' } } } } }
    const scopes = [scope('verify', 'succeeded', 2), scope('fixer', 'succeeded', 1), scope('fixer-blocked', 'succeeded', 1)]
    const plan = planContinuation(db, 'run', 'continue', probe(scopes, { status: 'failed' }), diagnosis({ kind: 'environment', phase: 'fixer-blocked' }))
    expect(plan).toMatchObject({ mode: 'fork', fromStep: 'fixer', request: { fromNodePath: 'fixer', visit: 1 } })
    // An end with no reporter falls back to where the run stopped, never to the end itself.
    const fallback = [scope('verify', 'failed', 2), scope('done', 'failed', 1)]
    expect(planContinuation(db, 'run', 'continue', probe(fallback, { status: 'failed' }), diagnosis({ kind: 'environment', phase: 'done' })).fromStep).toBe('verify')
  })

  it('resumes a paused run in place', () => {
    frozen.value = { row: { status: 'paused' }, metadata: { definition: { nodes: {} } } }
    expect(planContinuation(db, 'run', 'continue', probe([], { status: 'paused', resumable: true }), diagnosis({ kind: 'provider_limit', resumablePhase: 'reviewer' }))).toEqual({ mode: 'resume', fromStep: 'reviewer' })
  })

  it('restarts the developer with fresh budgets after a stall', () => {
    const plan = planContinuation(db, 'run', 'continue', probe([scope('developer', 'succeeded', 3), scope('fixer', 'failed')], { status: 'failed' }), diagnosis({ kind: 'blocked', detail: 'Implementation attempt limit reached (3/3)' }))
    expect(plan).toMatchObject({ mode: 'fork', fromStep: 'developer', request: { fromNodePath: 'developer', visit: 3, state: { $vars: { implementationAttempts: 0, unblockAttempts: 0, lastImplementationHash: '' } } } })
  })

  it('continues unfinished tasks from the developer with the remedy\'s own request', () => {
    frozen.prepare.mockReturnValue({ requestId: 'remedy-retry-with-browser-abc', fromNodePath: 'developer', scopeId: 'root', visit: 2, state: { $vars: {} } })
    const plan = planContinuation(db, 'run', 'continue', probe([], { status: 'failed' }), diagnosis({ kind: 'incomplete_tasks' }))
    expect(frozen.prepare).toHaveBeenCalledWith(db, 'run', 'retry-with-browser', expect.anything())
    expect(plan).toMatchObject({ mode: 'fork', fromStep: 'developer', request: { requestId: 'remedy-retry-with-browser-abc' } })
  })

  it('refuses a running run and a ledger with no step to continue from', () => {
    expect(() => planContinuation(db, 'run', 'continue', probe([], { status: 'running' }), null)).toThrow(/still running/)
    expect(() => planContinuation(db, 'run', 'continue', probe([scope('planner', 'succeeded')]), null)).toThrow(/no step/)
  })
})
