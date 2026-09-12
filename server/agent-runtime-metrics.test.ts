import { describe, expect, it } from 'vitest'
import { readRuntimeEfficiency, type EfficiencyTotals } from './agent-runtime-metrics'

const total: EfficiencyTotals = { attempts: 1, measuredAttempts: 1, durationMs: 1000, agentDurationMs: 800, providerCalls: 1, toolCalls: 2, inputTokens: 100, outputTokens: 10, costUsd: null, uncachedInputTokens: 20, cacheReadInputTokens: 80, cacheWriteInputTokens: null }
const metrics = () => ({ schemaVersion: 1, total, phases: [{ ...total, stepId: 'developer', providers: ['local'], models: ['model'] }] })
describe('optional Core efficiency wire contract', () => {
  it('retains unknown measurements and strips fields outside the metrics contract', () => {
    expect(readRuntimeEfficiency({ ...metrics(), transcript: 'private', total: { ...total, secret: 'private' } })).toEqual(metrics())
  })
  it.each([undefined, null, {}, { ...metrics(), schemaVersion: 2 }, { ...metrics(), total: { ...total, costUsd: -1 } }, { ...metrics(), total: { ...total, providerCalls: 1.5 } }, { ...metrics(), phases: [{ ...metrics().phases[0], models: [null] }] }, { ...metrics(), phases: [...metrics().phases, ...metrics().phases] }])('ignores absent, malformed or unsupported metrics without breaking controls', value => {
    expect(readRuntimeEfficiency(value)).toBeUndefined()
  })
})
