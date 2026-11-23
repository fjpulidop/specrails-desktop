import { describe, expect, it } from 'vitest'
import { v2Catalog } from '../index'
import { translator } from './lang'
import { buildDecisionState, needsPerson, stateVersion, type DecisionEnv, type OfferDraft } from './decision-state'

const env = (lang: 'en' | 'es' = 'en', confirmAboveUsd = 0.5): DecisionEnv => ({ translate: translator(lang), policyFor: v2Catalog().policyFor, confirmAboveUsd })
const resume: OfferDraft = { id: 'resume', labelKey: 'core.offer.run.resume', call: { tool: 'specrails_runs', args: { action: 'resume', ref: 'run:shop/1' } } }
const cancel: OfferDraft = { id: 'cancel', labelKey: 'core.offer.delivery.discard', call: { tool: 'specrails_runs', args: { action: 'cancel', ref: 'run:shop/1' } } }

describe('buildDecisionState', () => {
  it('localizes status, hold and labels and fills tier and confirmation facts from the catalog', () => {
    const state = buildDecisionState({ status: 'paused', hold: { kind: 'paused', since: '2026-11-21T10:00:00Z' }, offers: [resume, cancel], recommended: 'resume' }, env('es'))
    expect(state).toMatchObject({ status: 'paused', appState: 'paused', label: 'En pausa', recommended: 'resume', hold: { kind: 'paused', since: '2026-11-21T10:00:00Z' } })
    expect(state.offers[0]).toMatchObject({ id: 'resume', tier: 'ai-spawn', needsConfirm: true, label: 'Reanudar', effect: 'La ejecución sigue desde donde se detuvo.' })
    // Lean offers: a false flag is left out.
    expect(state.offers[0]).not.toHaveProperty('irreversible')
    expect(state.offers[0]).not.toHaveProperty('external')
    expect(state.offers[1]).toMatchObject({ id: 'cancel', tier: 'destructive', irreversible: true, needsConfirm: true })
    expect(state.hold?.reason).toBe('En pausa.')
  })

  it('decides needsConfirm for costly offers from their cost hint and the threshold', () => {
    const cheap = buildDecisionState({ status: 'paused', offers: [{ ...resume, costHint: [0.05, 0.2] }] }, env())
    expect(cheap.offers[0].needsConfirm).toBeUndefined()
    expect(buildDecisionState({ status: 'paused', offers: [{ ...resume, costHint: [0.05, 0.2] }] }, env('en', 0.1)).offers[0].needsConfirm).toBe(true)
    expect(buildDecisionState({ status: 'paused', offers: [{ ...resume, costHint: [0.05, 0.2] }] }, env()).offers[0].costHint).toEqual([0.05, 0.2])
  })

  it('puts the recommended offer first; the version keeps the domain order', () => {
    const plain = buildDecisionState({ status: 'paused', offers: [resume, cancel] }, env())
    const picked = buildDecisionState({ status: 'paused', offers: [resume, cancel], recommended: 'cancel' }, env())
    expect(plain.offers.map((offer) => offer.id)).toEqual(['resume', 'cancel'])
    expect(picked.offers.map((offer) => offer.id)).toEqual(['cancel', 'resume'])
    expect(stateVersion({ status: 'paused', offers: [resume, cancel], recommended: 'cancel' })).toBe(picked.version)
  })

  it('gives each offer an effect from its label key, a text, or an explicit key (none when the key is missing)', () => {
    const state = buildDecisionState({ status: 'paused', offers: [
      resume,
      { id: 'x', labelKey: 'core.offer.resolution', label: 'Use Node 22', effect: 'Reinstalls with Node 22.', call: resume.call },
      { id: 'y', labelKey: 'core.offer.run.pause', effectKey: 'core.choice.run.resume', call: { tool: 'specrails_runs', args: { action: 'pause', ref: 'run:shop/1' } } },
      { id: 'z', labelKey: 'core.nope.label', call: { tool: 'specrails_runs', args: { action: 'stop', ref: 'run:shop/1' } } },
    ] }, env())
    expect(state.offers.map((offer) => offer.effect)).toEqual(['The run continues from where it stopped.', 'Reinstalls with Node 22.', 'The run continues from where it stopped.', undefined])
  })

  it('has a version stable across languages and costs, and sensitive to legality and facts', () => {
    const input = { status: 'paused' as const, offers: [resume], versionFacts: { updatedAt: 'a' } }
    const version = buildDecisionState(input, env()).version
    expect(buildDecisionState({ ...input, cost: { spentUsd: 3, estimated: false } }, env('es')).version).toBe(version)
    expect(buildDecisionState({ ...input, offers: [resume, cancel] }, env()).version).not.toBe(version)
    expect(buildDecisionState({ ...input, status: 'running' }, env()).version).not.toBe(version)
    expect(buildDecisionState({ ...input, versionFacts: { updatedAt: 'b' } }, env()).version).not.toBe(version)
    expect(stateVersion(input)).toBe(version)
    expect(version).toMatch(/^[0-9a-f]{16}$/)
  })

  it('refuses offers outside the catalog and duplicate ids; drops an unknown recommendation', () => {
    expect(() => buildDecisionState({ status: 'paused', offers: [{ ...resume, call: { tool: 'specrails_runs', args: { action: 'explode' } } }] }, env())).toThrow(/unknown call/)
    expect(() => buildDecisionState({ status: 'paused', offers: [resume, resume] }, env())).toThrow(/Duplicate/)
    expect(buildDecisionState({ status: 'paused', offers: [resume], recommended: 'nope' }, env()).recommended).toBeUndefined()
  })

  it('prefers a chain-specific hold reason and falls back to the generic one', () => {
    expect(buildDecisionState({ status: 'paused', hold: { kind: 'chain', code: 'chunk_failed', since: null }, offers: [] }, env()).hold?.reason).toMatch(/spec failed/)
    expect(buildDecisionState({ status: 'paused', hold: { kind: 'chain', code: 'something_new', since: null }, offers: [] }, env()).hold?.reason).toBe('The milestone chain is paused.')
  })

  it('tells whether the person is the next actor', () => {
    expect(needsPerson({ status: 'ready_for_review' })).toBe(true)
    expect(needsPerson({ status: 'paused', hold: { kind: 'budget', reason: '', since: null } })).toBe(true)
    expect(needsPerson({ status: 'running' })).toBe(false)
    expect(needsPerson({ status: 'queued', hold: { kind: 'queued', reason: '', since: null } })).toBe(false)
  })
})
