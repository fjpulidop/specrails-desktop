import { describe, expect, it } from 'vitest'
import { RUN_HOLD_KINDS, type RunHold } from '../../../modules/loops/runtime/loop-run-hold'
import { PR_DECISION_ACTIONS, actionAllowed, type DeliveryDecisionState } from '../../../modules/delivery'
import { reconcileMilestoneChain, type ReconcileInput } from '../../../modules/builder/runtime/milestone-chain-reconcile'
import { rankRemedies, type ResolutionOption } from '../../../modules/recovery'
import { v2Catalog } from '../index'
import { translator } from './lang'
import { buildDecisionState, type OfferDraft } from './decision-state'
import { offersFromRunHold, projectChain, projectDelivery, projectFailure, projectRunHold } from './decision-sources'

const t = translator('en')
const REF = 'run:shop/r1'
const env = { translate: t, policyFor: v2Catalog().policyFor, confirmAboveUsd: 0.5 }
const hold = (kind: RunHold['kind'], extra: Partial<RunHold> = {}): RunHold => ({ kind, step: 'developer', since: '2026-11-21T10:00:00Z', ...extra })
const ids = (offers: readonly OfferDraft[]) => offers.map((offer) => offer.id)
/** Every projected offer must be a real v2 call with a defined label. */
const valid = (projected: { offers: OfferDraft[]; hold?: unknown; recommended?: string }) => {
  const state = buildDecisionState({ status: 'paused', ...projected } as never, env)
  for (const offer of state.offers) expect(offer.label, offer.id).not.toMatch(/^core\./)
  if (state.hold) expect(state.hold.reason).not.toMatch(/^core\./)
  return state
}

describe('run holds (loop-run-hold.ts)', () => {
  it('offers the resolutions of every hold kind as real v2 calls', () => {
    const expected: Record<RunHold['kind'], string[]> = {
      restart: ['resume', 'recover'], interrupted: ['resume', 'recover'], provider_limit: ['limit.resume_now', 'limit.auto', 'limit.switch'],
      budget: ['budget.once', 'budget.ignore', 'budget.raise'], question: ['answer'], approval: ['approve', 'reject'], paused: ['resume'], queued: [],
    }
    for (const kind of RUN_HOLD_KINDS) {
      const projected = projectRunHold(REF, hold(kind, kind === 'queued' ? { waitingFor: 'run_slots', position: 1 } : {}), null, t, { switchTargets: [{ provider: 'codex', model: 'gpt-5' }] })
      expect(ids(projected.offers), kind).toEqual(expected[kind])
      valid(projected)
    }
  })

  it('localizes the reason with what the hold knows', () => {
    expect(valid(projectRunHold(REF, hold('provider_limit', { resumeAt: '2026-11-21T12:00:00Z' }), null, t)).hold).toMatchObject({ kind: 'provider_limit', resumeAt: '2026-11-21T12:00:00Z', reason: expect.stringContaining('2026-11-21T12:00:00Z') })
    expect(valid(projectRunHold(REF, hold('queued', { waitingFor: 'provider_quota' }), null, t)).hold).toMatchObject({ waitingFor: ['provider_quota'], reason: 'Waiting to start: provider quota.' })
    expect(valid(projectRunHold(REF, hold('paused', { byYou: true }), null, t)).hold?.reason).toMatch(/only your resume/)
  })

  it('omits the switch offer without a switch target and marks person-supplied fields', () => {
    expect(ids(offersFromRunHold(REF, hold('provider_limit')))).toEqual(['limit.resume_now', 'limit.auto'])
    expect(offersFromRunHold(REF, hold('question'))[0].needs).toEqual(['answer|optionId'])
    expect(offersFromRunHold(REF, hold('provider_limit'), { switchTargets: [{ provider: 'codex' }] })[2].call.args).toEqual({ action: 'limit', ref: REF, choice: 'switch', provider: 'codex' })
  })

  it('adds the pause control without duplicating resume', () => {
    expect(ids(projectRunHold(REF, null, 'pause', t).offers)).toEqual(['pause'])
    expect(ids(projectRunHold(REF, null, 'pausing', t).offers)).toEqual([])
    expect(ids(projectRunHold(REF, hold('paused', { byYou: true }), 'resume', t).offers)).toEqual(['resume'])
  })
})

describe('failures (recovery/domain.ts + analysis.ts)', () => {
  it('turns ranked remedies into offers and recommends the top runnable one', () => {
    const remedies = rankRemedies({ kind: 'tests_failed', confidence: 'high', resumablePhase: 'verify' })
    const projected = projectFailure(REF, { remedies })
    expect(projected.offers.length).toBeGreaterThan(1)
    expect(projected.recommended).toBe(projected.offers.find((offer) => offer.call.args.action === 'remedy')?.id)
    expect(ids(projected.offers)).toContain('diagnose')
    valid(projected)
  })

  it('puts analysis options first and recommends the marked one unless it is high risk', () => {
    const option = (id: string, kind: ResolutionOption['kind'], risk: ResolutionOption['risk'], recommended = false): ResolutionOption =>
      ({ id, kind, label: `Opción ${id}`, does: 'x', consequence: `Consecuencia ${id}`, risk, recommended, guidance: '' })
    const analysis = { options: [option('a', 'start-over', 'high', true), option('b', 'continue-with-guidance', 'low'), option('c', 'edit-spec', 'medium')] }
    const projected = projectFailure(REF, { remedies: ['continue', 'open-logs'] }, analysis)
    expect(ids(projected.offers)).toEqual(['resolution.a', 'resolution.b', 'resolution.c', 'remedy.continue', 'remedy.open-logs', 'diagnose'])
    expect(projected.recommended).toBe('resolution.b')
    expect(projected.offers[1]).toMatchObject({ label: 'Opción b', why: 'Consecuencia b', call: { args: { action: 'remedy', choice: 'continue', optionId: 'b' } } })
    expect(projectFailure(REF, { remedies: [] }, { options: [option('z', 'continue-to-review', 'medium', true)] }).recommended).toBe('resolution.z')
    valid(projected)
  })
})

describe('deliveries (decision-policy.ts)', () => {
  const row = (over: Partial<DeliveryDecisionState>): DeliveryDecisionState => ({ decision: 'on_review', delivery_outcome: 'none' as never, implementation_outcome: 'succeeded' as never, status_code: null, is_continuation: 0, pr_url: null, branch: 'feat/1', ...over })

  it('offers exactly the actions the policy allows', () => {
    for (const decision of ['on_review', 'pr_draft', 'pr_ready', 'pr_closed', 'no_changes', 'pr_failed', 'merged'] as const) {
      for (const prUrl of [null, 'https://github.com/o/r/pull/1']) {
        const facts = row({ decision, pr_url: prUrl })
        const projected = projectDelivery('delivery:shop/57', facts)
        expect(ids(projected.offers), `${decision} ${prUrl}`).toEqual(PR_DECISION_ACTIONS.filter((action) => actionAllowed(action, facts)).map((action) => `decide.${action.replace(/-/g, '_')}`))
        valid(projected)
      }
    }
  })

  it('recommends a clean local integration or the PR the project delivers by', () => {
    expect(projectDelivery('delivery:shop/57', row({}), { mergePreviewClean: true, prefersLocal: true }).recommended).toBe('decide.merge_local')
    expect(projectDelivery('delivery:shop/57', row({}), { mergePreviewClean: false, prefersLocal: true, deliversByPr: true }).recommended).toBe('decide.create_pr')
    expect(projectDelivery('delivery:shop/57', row({})).recommended).toBeUndefined()
    expect(projectDelivery('delivery:shop/57', row({}), {}, '2026-11-21T10:00:00Z').hold).toEqual({ kind: 'pr_decision', since: '2026-11-21T10:00:00Z' })
    expect(projectDelivery('delivery:shop/57', row({ decision: 'merged' })).hold).toBeUndefined()
  })

  it('offers Fix CI only where ciFixAllowed does', () => {
    const facts = row({ decision: 'pr_ready', pr_url: 'https://github.com/o/r/pull/1' })
    expect(ids(projectDelivery('delivery:shop/57', facts, { ci: { ...facts, operation: null } }).offers)).toContain('decide.ci_fix')
    expect(ids(projectDelivery('delivery:shop/57', facts, { ci: { ...facts, operation: 'merging' } }).offers)).not.toContain('decide.ci_fix')
  })

  it('classifies external and irreversible decisions for confirmation', () => {
    const state = valid(projectDelivery('delivery:shop/57', row({})))
    expect(state.offers.find((offer) => offer.id === 'decide.create_pr')).toMatchObject({ external: true, needsConfirm: true })
    expect(state.offers.find((offer) => offer.id === 'decide.merge_local')).toMatchObject({ irreversible: true, needsConfirm: true })
  })
})

describe('milestone chains (milestone-chain-reconcile.ts)', () => {
  const input = (over: Partial<ReconcileInput> = {}): ReconcileInput => ({
    chain: { milestoneN: 1, status: 'paused', chunks: [[1], [2]], launched: [], retryChunk: null, headBranch: null, integrationBranch: 'main' },
    tickets: [{ id: 1, status: 'todo', labels: ['M1'], title: 'One', executionOrder: 1 }, { id: 2, status: 'todo', labels: ['M1'], title: 'Two', executionOrder: 2 }],
    deliveries: [], runs: [], integrates: true, ...over,
  })
  const runRef = (id: string) => `run:shop/${id}`

  it('maps the plan offers to calls and recommends the plan\'s first offer', () => {
    const plan = reconcileMilestoneChain(input())
    const projected = projectChain('chain:shop/1', plan, runRef, { reason: 'user_paused', since: null })
    expect(projected.offers[0]).toMatchObject({ id: 'chain.launch', call: { tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: 'chain:shop/1', from: 'recommended' } } })
    expect(projected.recommended).toBe('chain.launch')
    expect(valid(projected).hold).toMatchObject({ kind: 'chain', code: 'user_paused', reason: 'You paused the milestone chain.' })
  })

  it('routes run offers to the run and keeps both failed-spec paths', () => {
    const plan = reconcileMilestoneChain(input({ runs: [{ id: 'r9', ticketIds: [1], railIndex: 0, status: 'paused', outcome: null, pauseReason: null, forkOf: null, engineVersion: 2, startedAt: null }] }))
    const projected = projectChain('chain:shop/1', plan, runRef)
    expect(projected.offers[0]).toMatchObject({ id: 'chain.answer_run', call: { tool: 'specrails_runs', args: { action: 'answer', ref: 'run:shop/r9' } }, needs: ['answer|optionId'] })
    const failed = projectChain('chain:shop/1', { offers: [
      { kind: 'resume_failed_step', from: 'failed_step', ticketId: 1, title: 'One', runId: 'r1' },
      { kind: 'retry_from_start', from: 'start', ticketId: 1, title: 'One', runId: null },
    ] }, runRef, { reason: 'integration_failed:conflict', since: null })
    expect(failed.offers.map((offer) => offer.call.args.from)).toEqual(['failed_step', 'start'])
    expect(valid(failed).hold?.code).toBe('integration_failed')
  })
})
