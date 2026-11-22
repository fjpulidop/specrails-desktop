import { describe, expect, it } from 'vitest'
import type { ChainPlan } from '../../../modules/builder/runtime/milestone-chain-reconcile'
import type { MilestoneProgress, MilestoneRail } from '../../../modules/builder/runtime/milestone-progress'
import { chainSnapshot, SCENARIOS } from './__fixtures__/chain-plans'
import { buildDecisionState } from '../core/decision-state'
import { translator } from '../core/lang'
import { createCatalog } from '../core/registry'
import { V2_TOOLS } from '../tools/index'
import { isActiveChain, projectChainState, projectMilestoneState, projectRailState } from './chain-state'

// The chain projector against the REAL reconcile function: every ChainOfferKind
// the plan can produce maps to one exact v2 call, that call exists in the
// catalog with its required fields satisfied (args + needs), and the plan's
// first offer stays the recommendation.

const catalog = createCatalog(V2_TOOLS)
const t = translator('en')
const env = { translate: t, policyFor: catalog.policyFor, confirmAboveUsd: 0.5 }
const refs = { chain: 'chain:shop-api/c1', run: (id: string) => `run:shop-api/${id}` }

/** The exact call each offer kind must produce. */
const EXPECTED: Record<string, (p: ChainPlan) => { tool: string; args: Record<string, unknown> }> = {
  complete: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  next: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  launch: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  retry: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  follow_run: () => ({ tool: 'specrails_runs', args: { action: 'get', ref: 'run:shop-api/m' } }),
  resume_run: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  answer_run: () => ({ tool: 'specrails_runs', args: { action: 'answer', ref: 'run:shop-api/q' } }),
  integrate: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'recommended' } }),
  rebuild: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'start' } }),
  resume_failed_step: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'failed_step' } }),
  retry_from_start: () => ({ tool: 'specrails_blueprint', args: { action: 'chain_resume', ref: refs.chain, from: 'start' } }),
}

/** An offer's call names a real catalog action and carries its required fields (or lists them in `needs`). */
function assertRunnable(offer: { call: { tool: string; args: Record<string, unknown> }; needs?: string[] }): void {
  const tool = catalog.byName.get(offer.call.tool)
  expect(tool, offer.call.tool).toBeDefined()
  const spec = tool!.actions[String(offer.call.args.action)]
  expect(spec, `${offer.call.tool}(${offer.call.args.action})`).toBeDefined()
  const supplied = new Set([...Object.keys(offer.call.args), ...(offer.needs ?? []).flatMap((need) => need.split('|').map((part) => part.split('.')[0]))])
  for (const field of spec.required ?? []) expect(supplied.has(field.split('.')[0]), `${offer.call.tool}(${offer.call.args.action}) needs ${field}`).toBe(true)
  if (spec.oneOf?.length) expect(spec.oneOf.some((field) => supplied.has(field))).toBe(true)
}

describe('projectChainState: reconcile offers → exact v2 calls', () => {
  const seen = new Set<string>()
  for (const [kind, build] of Object.entries(SCENARIOS)) {
    it(`${kind}: every offer is one runnable call and the plan's first is recommended`, () => {
      const p = build()
      expect(p.offers[0].kind).toBe(kind)
      const state = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: p, status: 'paused', pauseReason: kind === 'rebuild' ? 'integration_failed:merge_failed' : 'chunk_failed' })), env)
      for (const offer of p.offers) {
        seen.add(offer.kind)
        const projected = state.offers.find((o) => o.id === `chain.${offer.kind}`)!
        expect(projected.call).toEqual(EXPECTED[offer.kind](p))
        expect(projected.label).toBe(t(`core.offer.chain.${offer.kind}`))
        assertRunnable(projected)
      }
      expect(state.recommended).toBe(`chain.${p.offers[0].kind}`)
      if (kind === 'answer_run') expect(state.offers[0].needs).toEqual(['answer|optionId'])
      // The chain row's controls ride along on every active chain.
      expect(state.offers.map((o) => o.id)).toEqual(expect.arrayContaining(['chain.auto_advance_off', 'chain.cancel']))
      for (const offer of state.offers) assertRunnable(offer)
    })
  }
  it('covers every ChainOfferKind', () => {
    expect([...seen].sort()).toEqual(Object.keys(EXPECTED).sort())
  })

  it('a paused chain holds with its localized pause reason; integration failures keep their family code', () => {
    const p = SCENARIOS.rebuild()
    const failed = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: p, pauseReason: 'integration_failed:merge_failed' })), env)
    expect(failed.hold).toMatchObject({ kind: 'chain', code: 'integration_failed', reason: t('core.hold.chain.integration_failed') })
    const rejected = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: SCENARIOS.launch(), pauseReason: 'launch_rejected:preflight_blocked' })), env)
    expect(rejected.hold).toMatchObject({ code: 'launch_rejected', reason: 'The milestone chain could not launch the next spec (preflight_blocked).' })
    const stalled = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: SCENARIOS.retry(), pauseReason: 'chunk_stalled' })), env)
    expect(stalled.hold?.reason).toMatch(/stalled/)
    expect(failed.status).toBe('paused')
  })

  it('a wave checkpoint is needs_you with "launch the next rail" and Continue automatically', () => {
    const p = SCENARIOS.next()
    const state = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: p, status: 'awaiting_approval', pauseReason: null, autoAdvance: false })), env)
    expect(state.status).toBe('needs_you')
    expect(state.hold).toMatchObject({ code: 'checkpoint', reason: `Rail ${p.settled} of ${p.total} delivered; launch the next rail when you are ready.` })
    expect(state.offers.map((o) => o.id)).toEqual(['chain.next', 'chain.auto_advance_on', 'chain.cancel'])
    expect(state.offers[1].call.args).toEqual({ action: 'chain_auto_advance', ref: refs.chain, enabled: true })
    expect(state.offers[1].needsConfirm).toBe(true)
    expect(state.offers[2].irreversible).toBe(true)
  })

  it('a running chain waiting on a held rail says so and offers the plan\'s resume_run', () => {
    const p = SCENARIOS.resume_run()
    const rail: MilestoneRail = { railIndex: 3, name: 'M1 · #1', ticketIds: [1], active: true, hold: { kind: 'paused', step: 'developer', since: '2026-11-21T10:05:00.000Z', byYou: true }, runId: 'p', startedAt: null, delivery: null, chunkIndex: 1, engine: null }
    const state = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: p, status: 'running', pauseReason: null }), [rail]), env)
    expect(state.status).toBe('running')
    expect(state.hold).toMatchObject({ code: 'rail_held', reason: 'Rail 4 is held (paused); the chain waits for it.' })
    expect(state.recommended).toBe('chain.resume_run')
    const railState = buildDecisionState(projectRailState('run:shop-api/p', rail, t)!, env)
    expect(railState).toMatchObject({ status: 'paused', hold: { kind: 'paused', reason: t('core.hold.paused_by_you') } })
    expect(railState.offers.map((o) => o.call)).toEqual([{ tool: 'specrails_runs', args: { action: 'resume', ref: 'run:shop-api/p' } }])
    expect(projectRailState('run:shop-api/p', { ...rail, hold: null }, t)).toBeNull()
  })

  it('a terminal chain offers nothing; the version moves with the plan', () => {
    const done = buildDecisionState(projectChainState(refs, chainSnapshot({ status: 'completed', pauseReason: null, plan: null })), env)
    expect(done).toMatchObject({ status: 'succeeded', offers: [] })
    expect(isActiveChain({ status: 'cancelled' })).toBe(false)
    const a = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: SCENARIOS.retry() })), env).version
    const b = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: SCENARIOS.resume_failed_step() })), env).version
    const c = buildDecisionState(projectChainState(refs, chainSnapshot({ plan: SCENARIOS.retry(), updatedAt: '2026-11-21T11:00:00.000Z' })), env).version
    expect(new Set([a, b, c]).size).toBe(3)
  })
})

describe('projectMilestoneState: the popover CTAs', () => {
  const scope = { project: 'shop-api', milestone: 2 }
  const milestone = (over: Partial<MilestoneProgress> = {}): MilestoneProgress => ({
    id: 'm2', n: 2, title: 'Pantry', storedStatus: 'committed', state: 'committed', counts: { total: 3, done: 0, onReview: 0, inProgress: 0, todo: 3, failed: 0 }, rails: [], chain: null, ...over,
  })

  it('a committed milestone with pending specs and no live chain offers Launch', () => {
    const state = buildDecisionState(projectMilestoneState(milestone(), { milestoneRef: 'milestone:shop-api/m2', scope, generatable: false }), env)
    expect(state).toMatchObject({ status: 'waiting', recommended: 'milestone.launch' })
    expect(state.offers[0].call).toEqual({ tool: 'specrails_blueprint', args: { action: 'chain_launch', project: 'shop-api', milestone: 2 } })
    for (const offer of state.offers) assertRunnable(offer)
  })

  it('the first planned milestone after M1 offers Generate; a ready batch offers Commit then Regenerate', () => {
    const planned = milestone({ storedStatus: 'planned', state: 'planned', counts: { total: 0, done: 0, onReview: 0, inProgress: 0, todo: 0, failed: 0 } })
    const generate = buildDecisionState(projectMilestoneState(planned, { milestoneRef: 'milestone:shop-api/m2', scope, generatable: true }), env)
    expect(generate.offers.map((o) => o.id)).toEqual(['milestone.generate'])
    expect(generate.offers[0].label).toBe('Generate milestone 2')
    const ready = buildDecisionState(projectMilestoneState(planned, { milestoneRef: 'milestone:shop-api/m2', scope, generatable: true, draftReady: true }), env)
    expect(ready.offers.map((o) => o.id)).toEqual(['milestone.commit', 'milestone.generate'])
    expect(ready.offers[1].call.args).toMatchObject({ options: { fresh: true } })
    expect(ready.recommended).toBe('milestone.commit')
    for (const offer of ready.offers) assertRunnable(offer)
  })

  it('a milestone driven by a live chain carries the chain\'s offers, never Launch', () => {
    const chain = chainSnapshot({ milestoneN: 2, plan: SCENARIOS.retry() })
    const state = buildDecisionState(projectMilestoneState(milestone({ state: 'paused', chain }), { milestoneRef: 'milestone:shop-api/m2', scope, generatable: false, chainRefs: refs }), env)
    expect(state.status).toBe('paused')
    expect(state.recommended).toBe('chain.retry')
    expect(state.offers.some((o) => o.id === 'milestone.launch')).toBe(false)
  })
})
