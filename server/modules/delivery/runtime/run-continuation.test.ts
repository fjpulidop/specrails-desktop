import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'
import type { FailureDiagnosis } from '../../recovery'
import { normalizeContinueRemedy, planContinuation, stoppedStep, withProviderSwitch } from './run-continuation'

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

// The Implement recipe's graph around verification and correction (kinds and ends as the frozen definition has them).
const IMPLEMENT_NODES: Record<string, unknown> = {
  developer: { kind: 'role-turn', ends: { failed: 'failed', invalid: 'failed', next: 'developer-blocker' } },
  'developer-blocker': { kind: 'condition', ends: { false: 'tasks', true: 'developer-blocked' } },
  'developer-blocked': { kind: 'end', params: { blockerFrom: 'developer', outcome: 'failure' } },
  tasks: { kind: 'artifact-contract', ends: { fail: 'failed', failed: 'failed', pass: 'verify' } },
  verify: { kind: 'verify', ends: { blocked: 'host-blocked', fail: 'correction-context', failed: 'failed', pass: 'reviewer' } },
  'host-blocked': { kind: 'end', params: { blockerFrom: 'verify', outcome: 'failure' } },
  'correction-context': { kind: 'condition', ends: { false: 'clear-review', true: 'capture-review' } },
  'clear-review': { kind: 'assign', ends: { failed: 'failed', next: 'correction-budget' } },
  'capture-review': { kind: 'assign', ends: { failed: 'failed', next: 'correction-budget' } },
  'correction-budget': { kind: 'condition', ends: { false: 'correction-exhausted', true: 'begin-correction' } },
  'correction-exhausted': { kind: 'end', params: { outcome: 'failure' } },
  'begin-correction': { kind: 'assign', ends: { failed: 'failed', next: 'fixer' } },
  fixer: { kind: 'role-turn', ends: { failed: 'failed', invalid: 'failed', next: 'correction-blocker' } },
  'correction-blocker': { kind: 'condition', ends: { false: 'correction-progress', true: 'fixer-blocked' } },
  'fixer-blocked': { kind: 'end', params: { blockerFrom: 'fixer', outcome: 'failure' } },
  'correction-progress': { kind: 'condition', ends: { false: 'correction-decided', true: 'tasks' } },
  'correction-decided': { kind: 'condition', ends: { false: 'correction-stalled', true: 'reviewer' } },
  'correction-stalled': { kind: 'end', params: { outcome: 'failure' } },
  reviewer: { kind: 'role-turn', ends: { failed: 'failed', invalid: 'failed', next: 'review-policy' } },
  'review-policy': { kind: 'condition', ends: { false: 'correction-context', true: 'archive' } },
  archive: { kind: 'openspec-archive', ends: { failed: 'archive-retry', next: 'done' } },
  'archive-retry': { kind: 'condition', ends: { false: 'archive-failed', true: 'verify' } },
  'archive-failed': { kind: 'end', params: { outcome: 'failure' } },
  failed: { kind: 'end', params: { outcome: 'failure' } },
  done: { kind: 'end', params: { outcome: 'success' } },
}
// The ledger of run d587300f as Core recorded it: every step succeeded, the run took `correction-stalled`.
const STALLED_RUN = ['developer', 'developer-blocker', 'tasks', 'verify', 'correction-context', 'clear-review', 'correction-budget', 'begin-correction', 'fixer', 'correction-blocker', 'correction-progress', 'correction-decided', 'correction-stalled']
  .map((nodePath) => ({ nodePath, scopeId: 'root', kind: 'step', status: 'succeeded', attemptId: `a-${nodePath}`, visits: 1 }))

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

  it('gives the fixer a fresh correction budget when the corrections ran out (never restarts the developer with a spent budget)', () => {
    frozen.value = { row: { status: 'completed' }, metadata: { definition: { nodes: { developer: {}, reviewer: {}, fixer: {}, 'correction-budget': {}, 'correction-exhausted': { kind: 'end' } } } } }
    const scopes = [scope('developer', 'succeeded', 1), scope('reviewer', 'succeeded', 4), scope('correction-budget', 'succeeded', 4), scope('correction-exhausted', 'succeeded', 1)]
    for (const d of [diagnosis({ kind: 'blocked', phase: 'correction-exhausted', detail: 'Automatic corrections ran out. The reviewer still asks for: …' }), diagnosis({ kind: 'blocked', detail: 'Automatic correction limit reached (3/3).' })]) {
      const plan = planContinuation(db, 'run', 'continue', probe(scopes, { status: 'failed' }), d)
      expect(plan).toMatchObject({ mode: 'fork', fromStep: 'correction-budget', request: { fromNodePath: 'correction-budget', visit: 4, state: { $vars: { correctionAttempts: 0 } } } })
    }
  })

  it('a correction stall (the fixer could not reproduce the failure) re-runs the same verification with a fresh correction budget', () => {
    // Run d587300f (generala-dorada): verify failed on 4 Playwright tests, the fixer could not reproduce
    // them and changed nothing, and the run ended at `correction-stalled` with every step succeeded.
    // Core summarises it as "Automatic correction changed nothing." (the end node says "made no
    // candidate changes"); neither the developer rule nor the ledger matched, and Continue got a 409.
    frozen.value = { row: { status: 'completed' }, metadata: { definition: { nodes: IMPLEMENT_NODES } } }
    const stalled = diagnosis({ kind: 'blocked', phase: 'correction-stalled', detail: 'Automatic correction changed nothing. Fixer: Diagnosis: the 4 Playwright failures (menus.spec:105, …) did not reproduce…' })
    const completion = { ok: false, verified: false, reasons: ['Automatic correction made no candidate changes. Host verification is valid: false. … Fixer diagnosis: …', 'unverified'] }
    const expected = { mode: 'fork', fromStep: 'verify', request: { fromNodePath: 'verify', scopeId: 'root', visit: 1, state: { $vars: { correctionAttempts: 0 } } } }
    expect(planContinuation(db, 'run', 'continue', probe(STALLED_RUN, { status: 'failed', completion }), stalled)).toMatchObject(expected)
    // Read from any one signal: the end node, Core's new summary, an older Core's wording, or the end reason alone.
    for (const d of [diagnosis({ kind: 'blocked', phase: 'correction-stalled' }), diagnosis({ kind: 'blocked', detail: 'Automatic correction changed nothing.' }), diagnosis({ kind: 'blocked', detail: 'Automatic correction made no candidate changes.' })]) {
      expect(planContinuation(db, 'run', 'continue', probe(STALLED_RUN, { status: 'failed' }), d)).toMatchObject(expected)
    }
    expect(planContinuation(db, 'run', 'continue', probe(STALLED_RUN, { status: 'failed', completion }), diagnosis({ kind: 'blocked' }))).toMatchObject(expected)
    // At the latest verification visit.
    const twice = STALLED_RUN.map((s) => (s.nodePath === 'verify' ? { ...s, visits: 3 } : s))
    expect(planContinuation(db, 'run', 'continue', probe(twice, { status: 'failed' }), stalled)).toMatchObject({ fromStep: 'verify', request: { visit: 3 } })
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
    expect(() => planContinuation(db, 'run', 'continue', probe([]), null)).toThrow(/no step/)
  })

  it('never strands a settled run whose steps all finished: it goes on from the work step its end reports', () => {
    frozen.value = { row: { status: 'completed' }, metadata: { definition: { nodes: IMPLEMENT_NODES } } }
    // archive → archive-retry (condition) → archive-failed (end, no blockerFrom): re-run the archive.
    const archived = [...STALLED_RUN.filter((s) => s.nodePath !== 'correction-stalled'), scope('archive', 'succeeded'), scope('archive-retry', 'succeeded'), scope('archive-failed', 'succeeded')]
    expect(planContinuation(db, 'run', 'continue', probe(archived, { status: 'failed' }), diagnosis({ kind: 'spec_invalid', phase: 'archive-failed' }))).toMatchObject({ fromStep: 'archive', request: { fromNodePath: 'archive', visit: 1 } })
    // An end several work steps lead to (`failed`) goes on from the developer.
    const failed = [...STALLED_RUN.filter((s) => s.nodePath !== 'correction-stalled'), scope('failed', 'succeeded')]
    expect(planContinuation(db, 'run', 'continue', probe(failed, { status: 'failed' }), diagnosis({ kind: 'unknown', phase: 'failed' })).fromStep).toBe('developer')
    // With no developer, the last work step it ran; never a condition or an end.
    expect(stoppedStep(probe([scope('planner', 'succeeded'), scope('route', 'succeeded'), scope('failed', 'succeeded')]), null, { planner: {}, route: { kind: 'condition' }, failed: { kind: 'end' } })).toEqual({ nodePath: 'planner', visit: 1 })
  })
})

describe('Continue with another provider (a run that settled on a usage limit)', () => {
  const offer = { providerId: 'codex', roles: ['developer', 'fixer'], targets: [{ provider: 'claude', model: 'haiku', effort: 'low' }], via: 'fork' as const }
  const choice = { provider: 'claude', model: 'haiku', effort: 'low' }
  it('forks from the same step as Continue, with the roles on the limited provider moved on the fork itself', () => {
    const plan = planContinuation(db, 'run', 'continue', probe([scope('developer', 'completed'), scope('fixer', 'failed', 2)]), diagnosis({ kind: 'provider_limit', phase: 'fixer' }))
    const switched = withProviderSwitch(plan, { runId: 'run', sequence: 1, offer, choice })
    expect(switched.plan).toMatchObject({ mode: 'fork', fromStep: 'fixer', request: { fromNodePath: 'fixer', scopeId: 'root', visit: 2 } })
    if (switched.plan.mode !== 'fork' || plan.mode !== 'fork') throw new Error('fork expected')
    // Its own fork request: a plain Continue's earlier request never conflicts with it.
    expect(switched.plan.request.requestId).toMatch(/^remedy-switch-[0-9a-f]{16}$/)
    expect(switched.plan.request.requestId).not.toBe(plan.request.requestId)
    expect(switched.routeOverrides).toEqual({ schemaVersion: 1, requestId: 'desktop-switch:run:1', reason: 'provider-limit', fromProvider: 'codex',
      routes: { developer: { provider: 'claude', model: 'haiku', effort: 'low' }, fixer: { provider: 'claude', model: 'haiku', effort: 'low' } },
      providers: [{ id: 'claude', kind: 'cli', cli: 'claude' }] })
    expect(switched.plan.request.routeOverrides).toEqual(switched.routeOverrides)
  })
  it('an older retained Core (routeOverrides only) moves the routes on the fork\'s first resume instead', () => {
    const plan = planContinuation(db, 'run', 'continue', probe([scope('fixer', 'failed')]), diagnosis({ kind: 'provider_limit', phase: 'fixer' }))
    const switched = withProviderSwitch(plan, { runId: 'run', sequence: 2, offer: { ...offer, via: 'resume' }, choice })
    if (switched.plan.mode !== 'fork') throw new Error('fork expected')
    expect(switched.plan.request.routeOverrides).toBeUndefined()
    expect(switched.routeOverrides.requestId).toBe('desktop-switch:run:2')
  })
  it('a paused run resumes in place with the override', () => {
    frozen.value = { row: { status: 'paused' }, metadata: {} }
    const plan = planContinuation(db, 'run', 'continue', probe([], { status: 'paused' }), diagnosis({ kind: 'provider_limit', resumablePhase: 'developer' }))
    expect(withProviderSwitch(plan, { runId: 'run', sequence: 1, offer, choice })).toMatchObject({ plan: { mode: 'resume' }, routeOverrides: { routes: { developer: { provider: 'claude' } } } })
  })
})
