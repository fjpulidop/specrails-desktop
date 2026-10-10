import { expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { core, execute, useFactoryPairing } from './__fixtures__/factory-pairing'

// Factory pairing: configurable Implement recipes, review repairs, approval,
// planning confidence and addendum corrections through the real bridge and a
// built Core checkout.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
// Retention copying has its own installed-package tests. Keep real negotiation,
// validation, freezing, process execution and result parsing in this pairing.
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: (contextPath: string) => {
      const cli = selected.get(contextPath)
      if (!cli) throw new Error('Fixture runtime was never retained')
      return cli
    },
  }
})
useFactoryPairing()

it.skipIf(!core)('executes configurable Implement with arbitrary loop-owned agents and real artifacts and verification', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'accessibility', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
it.skipIf(!core)('delivers a pre-existing formatting test failure to the configurable fixer and verifies its minimal repair', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REGEX', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
  const prompt = actual.calls.find(call => call.role === 'correct')!.prompt
  for (const value of ['failureSummary', 'evidenceId', 'guard.test.cjs', 'ERR_ASSERTION', 'expected:', 'An unchanged file or a pre-existing test does not prove', 'Latest review findings']) expect(prompt).toContain(value)
  expect(readFileSync(path.join(actual.repository, 'guard.test.cjs'), 'utf8')).toContain('&&\\s*!confirmPending/')
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('completes after a formatting repair when the reviewer omits workflow tool calls', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REGEX', '1')
  vi.stubEnv('SPECRAILS_FACTORY_OMIT_REVIEW_WORKFLOW', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
  const review = actual.calls.find(call => call.role === 'assess')!
  expect(review).toMatchObject({ access: 'read', artifacts: 'none' })
  expect(review.prompt).toContain('Host-loaded official verify workflow')
  expect(review.prompt).toContain('openspec-verify-change')
  expect(review.prompt).toContain('contextFiles')
  expect(actual.events.filter(event => event.type === 'workflow-event' && event.event.nodePath === 'reviewer').map(event => event.event.type)).toEqual(['step_started', 'step_succeeded'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('resumes candidate-bound approval in configurable Implement without replaying its agents', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('investigates low planning confidence before asking, then resumes the generic Implement recipe', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CONFIDENCE', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'plan', 'plan', 'build', 'assess'])
  expect(actual.calls[2].prompt).toContain('Return two')
}, 180_000)

it.skipIf(!core)('corrects a partial addendum before archiving through the real Implement runtime', async () => {
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, false, ['a1'])
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)

it.skipIf(!core)('clears previous review findings when a review correction breaks host verification', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_STALE_REVIEW', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, false, ['a1'])
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'correct', 'assess'])
  const corrections = actual.calls.filter(call => call.role === 'correct')
  const reviewContext = (prompt: string) => prompt.split('Latest review findings for this candidate:')[1].split('Prior execution:')[0]
  expect(reviewContext(corrections[0].prompt)).toContain('"verdict":"partial"')
  expect(reviewContext(corrections[1].prompt)).toContain('No reviewer findings for the current verified candidate')
  expect(reviewContext(corrections[1].prompt)).not.toContain('"verdict":"partial"')
  expect(corrections[1].prompt).toContain('"exitCode":9')
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
}, 180_000)
