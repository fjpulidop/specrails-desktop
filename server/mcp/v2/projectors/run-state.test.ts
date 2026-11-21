import { describe, expect, it } from 'vitest'
import { RUN_HOLD_KINDS, type RunHold } from '../../../modules/loops/runtime/loop-run-hold'
import { rankRemedies, type ResolutionOption } from '../../../modules/recovery'
import { v2Catalog } from '../index'
import { buildDecisionState } from '../core/decision-state'
import { translator } from '../core/lang'
import { projectRunState, type RunFacts } from './run-state'

const t = translator('en')
const REF = 'run:shop-api/r1'
const env = { translate: t, policyFor: v2Catalog().policyFor, confirmAboveUsd: 0.5 }
const hold = (kind: RunHold['kind'], extra: Partial<RunHold> = {}): RunHold => ({ kind, step: 'developer', since: '2026-11-21T10:00:00Z', ...extra })
const state = (facts: RunFacts) => {
  const built = buildDecisionState(projectRunState(REF, facts, t), env)
  for (const offer of built.offers) expect(offer.label, offer.id).not.toMatch(/^(core|runs)\./)
  return built
}
const ids = (facts: RunFacts) => state(facts).offers.map((offer) => offer.id)
const option = (id: string, kind: ResolutionOption['kind'], extra: Partial<ResolutionOption> = {}): ResolutionOption => ({ id, kind, label: `Option ${id}`, does: 'd', consequence: 'c', guidance: 'g', ...extra })

describe('projectRunState: active runs (loop-run-hold.ts)', () => {
  it('maps every hold kind to its status, resolutions and Stop', () => {
    const expected: Record<RunHold['kind'], { status: string; offers: string[] }> = {
      restart: { status: 'paused', offers: ['resume', 'recover', 'stop'] },
      interrupted: { status: 'paused', offers: ['resume', 'recover', 'stop'] },
      provider_limit: { status: 'blocked', offers: ['limit.resume_now', 'limit.auto', 'limit.switch', 'stop'] },
      budget: { status: 'paused', offers: ['budget.once', 'budget.ignore', 'budget.raise', 'stop'] },
      question: { status: 'needs_you', offers: ['answer', 'stop'] },
      approval: { status: 'needs_you', offers: ['approve', 'reject', 'stop'] },
      paused: { status: 'paused', offers: ['resume', 'stop'] },
      queued: { status: 'queued', offers: ['stop'] },
    }
    for (const kind of RUN_HOLD_KINDS) {
      const built = state({ jobStatus: 'running', hold: hold(kind, kind === 'queued' ? { waitingFor: 'run_slots' } : {}), pauseControl: null, limit: { switchTargets: [{ provider: 'codex', model: 'gpt-5.5', effort: 'high' }] } })
      expect({ status: built.status, offers: built.offers.map((offer) => offer.id) }, kind).toEqual(expected[kind])
      expect(built.hold?.kind).toBe(kind)
    }
  })

  it('switches to the limit pause target, or by provider only on the older engine', () => {
    const core = state({ jobStatus: 'running', hold: hold('provider_limit'), pauseControl: null, limit: { switchTargets: [{ provider: 'codex', model: 'gpt-5.5', effort: null }] } })
    expect(core.offers.find((offer) => offer.id === 'limit.switch')?.call.args).toEqual({ action: 'limit', ref: REF, choice: 'switch', provider: 'codex', model: 'gpt-5.5' })
    expect(core.offers.find((offer) => offer.id === 'limit.switch')?.needsConfirm).toBe(true)
    const legacy = state({ jobStatus: 'running', hold: hold('provider_limit'), pauseControl: null, limit: { switchTargets: [], switchable: true } })
    expect(legacy.offers.find((offer) => offer.id === 'limit.switch')?.needs).toEqual(['provider'])
    expect(ids({ jobStatus: 'running', hold: hold('provider_limit'), pauseControl: null, limit: { switchable: false } })).toEqual(['limit.resume_now', 'limit.auto', 'stop'])
  })

  it('offers Pause on a working run and nothing extra while it is pausing', () => {
    expect(ids({ jobStatus: 'running', hold: null, pauseControl: 'pause' })).toEqual(['pause', 'stop'])
    expect(ids({ jobStatus: 'running', hold: null, pauseControl: 'pausing' })).toEqual(['stop'])
    expect(state({ jobStatus: 'running', hold: null, pauseControl: null }).status).toBe('running')
  })
})

describe('projectRunState: failed runs (recovery/domain.ts + analysis.ts)', () => {
  const remedies = rankRemedies({ kind: 'tests_failed', confidence: 'high', resumablePhase: 'verify' })

  it('continues a continuable run and recommends the analysis option it marked', () => {
    const built = state({ jobStatus: 'failed', hold: null, pauseControl: null, remedies, continuable: true, railIndex: 0,
      analysis: { options: [option('fix', 'continue-with-guidance', { recommended: true, risk: 'low' }), option('swap', 'change-model')] } })
    expect(built.status).toBe('failed')
    expect(built.recommended).toBe('resolution.fix')
    expect(built.offers.map((offer) => offer.id)).toContain('remedy.continue')
    // change-model without a settled provider switch runs on the client: not offered.
    expect(built.offers.map((offer) => offer.id)).not.toContain('resolution.swap')
    expect(built.offers.map((offer) => offer.id)).toContain('diagnose')
  })

  it('drops continuations of a run that cannot continue, keeps Start over on its rail', () => {
    const built = state({ jobStatus: 'failed', hold: null, pauseControl: null, remedies: ['continue', 'retry', 'open-logs'], continuable: false, railIndex: 2 })
    expect(built.offers.map((offer) => offer.id)).toEqual(['remedy.retry', 'remedy.open-logs', 'diagnose'])
    expect(built.recommended).toBe('remedy.retry')
    const noRail = state({ jobStatus: 'failed', hold: null, pauseControl: null, remedies: ['continue', 'retry'], continuable: false, railIndex: null })
    expect(noRail.offers.map((offer) => offer.id)).toEqual(['diagnose'])
  })

  it('offers continuing on another provider after a settled usage-limit failure', () => {
    const built = state({ jobStatus: 'failed', hold: null, pauseControl: null, remedies: ['continue'], continuable: true, railIndex: 0, settledSwitch: { targets: [{ provider: 'codex', model: 'gpt-5.5', effort: 'high' }] } })
    const offer = built.offers.find((candidate) => candidate.id === 'remedy.switch')
    expect(offer?.label).toBe('Continue on codex')
    expect(offer?.call.args).toEqual({ action: 'remedy', ref: REF, choice: 'continue', provider: 'codex', model: 'gpt-5.5', effort: 'high' })
    expect(built.offers.some((candidate) => candidate.id === 'remedy.retry')).toBe(true)
  })
})

describe('projectRunState: finished runs and version', () => {
  it('offers settle and dismiss only when the runtime says so', () => {
    expect(ids({ jobStatus: 'completed', hold: null, pauseControl: null, runtime: { canSettle: true, canDismiss: true } })).toEqual(['settle', 'dismiss'])
    expect(ids({ jobStatus: 'completed', hold: null, pauseControl: null })).toEqual([])
    expect(state({ jobStatus: 'completed', hold: null, pauseControl: null }).status).toBe('succeeded')
  })

  it('changes the version with the decision facts, not with spend', () => {
    const base: RunFacts = { jobStatus: 'running', hold: hold('budget'), pauseControl: null, spentUsd: 1, versionFacts: { f: null } }
    const a = state(base)
    expect(state({ ...base, spentUsd: 3 }).version).toBe(a.version)
    expect(state({ ...base, hold: hold('budget', { since: '2026-11-21T11:00:00Z' }) }).version).not.toBe(a.version)
    expect(state({ ...base, versionFacts: { f: '2026-11-21T12:00:00Z' } }).version).not.toBe(a.version)
    expect(a.cost).toEqual({ spentUsd: 1, estimated: false })
  })
})
