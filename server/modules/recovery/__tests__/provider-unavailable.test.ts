import { describe, expect, it } from 'vitest'
import { autoContinueVerdict, PROVIDER_OUTAGE_WAIT_MS } from '../continuation'
import { deriveFailureDiagnosis, parseCoreFailure, rankRemedies } from '../domain'

// The night of 2026-11-19: four codex runs refused by codex's account routing service within one minute.
const ROUTING = 'codex execution failed (exit 1). workspace routing discovery failed'

describe('provider outage (contract 5.17)', () => {
  it('reads Core 5.17 provider_unavailable as a known, continuable cause', () => {
    const core = { kind: 'provider_unavailable', confidence: 'high', phase: 'architect', resumablePhase: 'architect', detail: "The provider's service was unavailable for a moment (codex: workspace routing discovery failed); nothing about the work is wrong, and continuing re-runs the same step." }
    expect(parseCoreFailure(core)).toMatchObject({ kind: 'provider_unavailable', confidence: 'high' })
    const d = deriveFailureDiagnosis({ outcome: 'failed', core, errorText: ROUTING })
    expect(d).toMatchObject({ kind: 'provider_unavailable', resumablePhase: 'architect' })
    expect(rankRemedies(d)).toEqual(['continue', 'open-logs', 'retry'])
  })

  it('names an older Core\'s "crash" by the provider\'s own words', () => {
    const d = deriveFailureDiagnosis({ outcome: 'failed', stepId: 'reviewer', errorText: ROUTING,
      core: { kind: 'crash', confidence: 'high', phase: 'reviewer', rounds: 15, resumablePhase: 'reviewer', detail: ROUTING } })
    expect(d).toMatchObject({ kind: 'provider_unavailable', confidence: 'high', phase: 'reviewer', resumablePhase: 'reviewer', rounds: 15 })
    expect(d.detail).toBe("The provider's service was unavailable for a moment (codex: workspace routing discovery failed); nothing about the work is wrong, and continuing re-runs the same step.")
    expect(deriveFailureDiagnosis({ outcome: 'failed', errorText: 'claude execution failed (exit 1). API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}' }).kind).toBe('provider_unavailable')
  })

  it('never turns a usage limit, a verification failure or a real crash into an outage', () => {
    expect(deriveFailureDiagnosis({ outcome: 'failed', errorText: 'codex execution failed (exit 1). You’ve hit your usage limit. Try again at 3:32 AM.' }).kind).toBe('provider_limit')
    expect(deriveFailureDiagnosis({ outcome: 'failed', errorText: 'Verification failed: npm test — connect ECONNRESET 127.0.0.1:5432' }).kind).not.toBe('provider_unavailable')
    expect(deriveFailureDiagnosis({ outcome: 'failed', core: { kind: 'crash', confidence: 'high', detail: 'codex exited without a successful final result' } }).kind).toBe('crash')
  })

  it('continues by itself only after waiting the outage out', () => {
    const diagnosis = deriveFailureDiagnosis({ outcome: 'failed', errorText: ROUTING, stepId: 'architect' })
    expect(autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis, chainAlreadyContinued: false }))
      .toEqual({ continue: true, reason: 'provider_unavailable', delayMs: PROVIDER_OUTAGE_WAIT_MS })
    expect(autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis, previous: diagnosis, chainAlreadyContinued: false })).toEqual({ continue: false, reason: 'repeated_failure' })
  })
})
