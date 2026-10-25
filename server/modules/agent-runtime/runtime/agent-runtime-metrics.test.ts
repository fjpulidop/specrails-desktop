import { describe, expect, it } from 'vitest'
import { applyRuntimeSelectionOrigins, readRuntimeBaselineSpend, readRuntimeEfficiency, readRuntimeEfficiencySummary, type EfficiencyTotals } from './agent-runtime-metrics'
import summaryContract from '../../../schemas/fixtures/runtime-efficiency-summary.v1.json'

const total: EfficiencyTotals = { attempts: 1, measuredAttempts: 1, durationMs: 1000, agentDurationMs: 800, providerCalls: 1, toolCalls: 2, inputTokens: 100, outputTokens: 10, costUsd: null, uncachedInputTokens: 20, cacheReadInputTokens: 80, cacheWriteInputTokens: null }
const metrics = () => ({ schemaVersion: 1, total, phases: [{ ...total, stepId: 'developer', providers: ['local'], models: ['model'] }] })
describe('optional Core efficiency wire contract', () => {
  it('validates arbitrary nested steps against the run catalog and retains the legacy fallback', () => {
    const stepIds = ['plan', 'build', 'test', 'implement/reviewer', 'publish', 'finish', 'audit']
    const value = { ...metrics(), phases: stepIds.map(stepId => ({ ...metrics().phases[0], stepId })) }
    expect(readRuntimeEfficiency(value, { stepIds })).toEqual(value)
    expect(readRuntimeEfficiency(value)).toBeUndefined()
    expect(readRuntimeEfficiency(value, { stepIds: stepIds.slice(1) })).toBeUndefined()
    expect(readRuntimeEfficiency({ ...value, phases: [value.phases[0], value.phases[0]] }, { stepIds })).toBeUndefined()
  })
  it('retains unknown measurements and strips fields outside the metrics contract', () => {
    expect(readRuntimeEfficiency({ ...metrics(), transcript: 'private', total: { ...total, secret: 'private' } })).toEqual(metrics())
  })
  it.each([undefined, null, {}, { ...metrics(), schemaVersion: 2 }, { ...metrics(), total: { ...total, costUsd: -1 } }, { ...metrics(), total: { ...total, providerCalls: 1.5 } }, { ...metrics(), phases: [{ ...metrics().phases[0], models: [null] }] }, { ...metrics(), phases: [...metrics().phases, ...metrics().phases] }])('ignores absent, malformed or unsupported metrics without breaking controls', value => {
    expect(readRuntimeEfficiency(value)).toBeUndefined()
  })
})

it('validates open roles and escalations against frozen roles while preserving their origins', () => {
  const fixture = Object.values(summaryContract.fixtures)[0]
  const roleIds = ['architect', 'developer', 'reviewer', 'auditor', 'release-owner']
  const summary = { ...fixture, workflowVersion: 'a'.repeat(64), roles: roleIds.map(role => ({ ...fixture.roles[0], role, origin: 'core-config' })),
    escalations: [{ role: 'auditor', attemptId: 'attempt', provider: 'local', model: null, effort: null, reason: null }], escalationsTruncated: false }
  const parsed = readRuntimeEfficiencySummary(summary, { roleIds })
  expect(parsed?.roles.map(role => role.role)).toEqual(roleIds)
  expect(parsed?.escalations?.[0].role).toBe('auditor')
  expect(readRuntimeEfficiencySummary(summary)).toBeUndefined()
  expect(readRuntimeEfficiencySummary(summary, { roleIds: roleIds.slice(0, 4) })).toBeUndefined()
  expect(readRuntimeEfficiencySummary({ ...summary, escalations: [{ ...summary.escalations[0], role: 'unknown' }] }, { roleIds })).toBeUndefined()
  const selected = applyRuntimeSelectionOrigins(parsed, { schemaVersion: 1, runId: fixture.runId, origins: { architect: 'default', developer: 'explicit-launch-override', reviewer: 'project-role' } }, fixture.runId)
  expect(selected?.roles.find(role => role.role === 'developer')?.origin).toBe('explicit-launch-override')
  expect(selected?.roles.find(role => role.role === 'auditor')?.origin).toBe('core-config')
  const loop = applyRuntimeSelectionOrigins(parsed, { schemaVersion: 1, runId: fixture.runId, origins: Object.fromEntries(roleIds.map(role => [role, 'loop-role'])) }, fixture.runId)
  expect(loop?.roles.every(role => role.origin === 'loop-role')).toBe(true)
  expect(loop?.roles.map(({ origin: _origin, ...role }) => role)).toEqual(parsed?.roles.map(({ origin: _origin, ...role }) => role))
})

it('accepts packaged Core summary fixtures without a sibling checkout and strips unrecognized payloads', async () => {
  const { readFileSync } = await import('node:fs')
  const { readRuntimeEfficiencySummary } = await import('./agent-runtime-metrics')
  const contract = JSON.parse(readFileSync(new URL('../../../schemas/fixtures/runtime-efficiency-summary.v1.json', import.meta.url), 'utf8'))
  for (const fixture of Object.values(contract.fixtures)) {
    const result = readRuntimeEfficiencySummary({ ...(fixture as object), transcript: 'private' })
    expect(result).toBeDefined()
    expect(JSON.stringify(result)).not.toContain('private')
  }
  expect(readRuntimeEfficiencySummary(contract.fixtures['incomplete-metrics'])!.invocations.complete).toBe(false)
  expect(readRuntimeEfficiencySummary(contract.fixtures.reuse)!.checks.durationMs).toBe(0)
  expect(readRuntimeEfficiencySummary(contract.fixtures['unavailable-evidence'])!.checks.executed).toBeNull()
})

it('accepts the contract 5.7 baseline invocation kind and keeps the baseline spend apart', () => {
  const fixture = Object.values(summaryContract.fixtures)[0] as Record<string, any>
  const withBaseline = { ...fixture, invocations: { ...fixture.invocations, byKind: { ...fixture.invocations.byKind, baseline: 2 } }, baseline: { invocations: 2, roles: ['architect', 'developer', 7], costUsd: 0.5, inputTokens: null, outputTokens: 10 } }
  const parsed = readRuntimeEfficiencySummary(withBaseline)
  expect(parsed?.invocations.byKind.baseline).toBe(2)
  expect(parsed?.baseline).toEqual({ invocations: 2, roles: ['architect', 'developer'], costUsd: 0.5, inputTokens: null, outputTokens: 10 })
  expect(readRuntimeEfficiencySummary({ ...withBaseline, invocations: { ...withBaseline.invocations, byKind: { ...withBaseline.invocations.byKind, baseline: -1 } } })).toBeUndefined()
  expect(readRuntimeEfficiencySummary({ ...fixture, invocations: { ...fixture.invocations, byKind: { ...fixture.invocations.byKind, other: 1 } } })).toBeUndefined()
  expect(readRuntimeEfficiencySummary(fixture)?.baseline).toBeUndefined()
  expect(readRuntimeBaselineSpend({ invocations: 1.5 })).toBeUndefined()
  expect(readRuntimeBaselineSpend(null)).toBeUndefined()
})
