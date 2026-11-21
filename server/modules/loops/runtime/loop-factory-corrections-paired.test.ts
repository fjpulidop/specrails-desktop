import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { compilerFailures, core, execute, useFactoryPairing } from './__fixtures__/factory-pairing'
import { definitionReviewBrief } from '../../delivery/runtime/delivery-evidence'
import { buildWhatToLookAt } from '../../delivery/runtime/review-brief'
import type { DefinitionRunProbe } from './loop-definition-recovery'

// Factory pairing: configurable Implement correction routing, budgets and
// stalls through the real bridge and a built Core checkout.
vi.mock('../../../core-node-runtime', () => ({ resolveCoreNodeRuntime: () => process.execPath }))
// Retention copying has its own installed-package tests. Keep real negotiation,
// validation, freezing, process execution and result parsing in this pairing.
vi.mock('../../agent-runtime/runtime/agent-runtime-package', async importOriginal => {
  const original = await importOriginal<typeof import('../../agent-runtime/runtime/agent-runtime-package')>()
  const selected = new Map<string, string>()
  return { ...original,
    prepareRetainedAgentRuntime: async () => {},
    retainAgentRuntime: (cli: string, contextPath: string) => { selected.set(contextPath, cli); return cli },
    resolveRetainedAgentRuntime: async (contextPath: string) => {
      const cli = selected.get(contextPath)
      if (!cli) throw new Error('Fixture runtime was never retained')
      return cli
    },
  }
})
useFactoryPairing()

it.skipIf(!core)('routes failed verification to the configurable correction agent and repeats host gates', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CORRECT', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
}, 180_000)

it.skipIf(!core)('stops configurable Implement after an unchanged correction without repeating failed host checks', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_CORRECT', '1')
  vi.stubEnv('SPECRAILS_FACTORY_NOOP', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'failed', completion: { ok: false, verified: false }, errorText: expect.stringContaining('Queue-modal test is outside the approved scope') })
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts.filter(node => node === 'verify')).toHaveLength(1)
  expect(starts).toContain('correction-stalled')
  expect(starts).not.toContain('reviewer')
  expect(starts).not.toContain('archive')
}, 180_000)

it.skipIf(!core)('hands compiler failures through lint noise to the fixer and stops after one unchanged correction', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_TYPESCRIPT_FAILURE', '1')
  vi.stubEnv('SPECRAILS_FACTORY_CORRECT', '1')
  vi.stubEnv('SPECRAILS_FACTORY_NOOP', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct'])
  const prompt = actual.calls.find(call => call.role === 'correct')!.prompt
  const verificationText = prompt.split('Host verification: ')[1]?.split('. Latest review findings for this candidate:')[0]
  expect(verificationText).toBeDefined()
  const verification = JSON.parse(verificationText!) as { commands: Array<{ args: string[]; exitCode: number; evidenceId: string; failureSummary: string[] }> }
  expect(verification.commands).toHaveLength(1)
  expect(verification.commands[0]).toMatchObject({ args: ['compiler-check.cjs'], exitCode: 2, evidenceId: expect.any(String), failureSummary: expect.arrayContaining(compilerFailures) })
  expect(verification.commands[0].evidenceId).not.toBe('')
  expect(verification.commands[0].failureSummary.join('\n')).not.toContain('0 errors, 74 warnings')
  expect(actual.result).toMatchObject({ failed: true, runtimeStatus: 'failed', completion: { ok: false, verified: false } })
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts.filter(node => node === 'verify')).toHaveLength(1)
  expect(starts.filter(node => node === 'fixer')).toHaveLength(1)
  expect(starts).toContain('correction-stalled')
  expect(starts).not.toContain('reviewer')
  expect(starts).not.toContain('archive')
}, 180_000)

it.skipIf(!core).each(['reject', 'score'])('stops unchanged %s review corrections even when all host checks pass', async reviewMode => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', reviewMode)
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'failed', completion: { ok: false }, errorText: expect.stringContaining('no candidate changes') })
  expect(actual.result.errorText).not.toContain('Maximum global node visits')
  expect(actual.result.errorText).toContain(reviewMode === 'reject' ? 'Required canvas fallback is missing.' : '"security":70')
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts.filter(node => node === 'verify')).toHaveLength(1)
  expect(starts).toContain('correction-stalled')
  expect(starts).not.toContain('archive')
  const prompt = actual.calls.find(call => call.role === 'correct')!.prompt
  expect(prompt).toContain('security >= 75')
  expect(prompt).toContain('Host verification is valid')
  expect(actual.lines.join('')).toContain('[runtime] workflow_failed — Automatic correction made no candidate changes')
}, 180_000)

it.skipIf(!core)('accepts a review correction only after its real candidate changes pass verification and review', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', 'repair')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'assess'])
  expect(readFileSync(path.join(actual.repository, 'review-obligation.txt'), 'utf8')).toContain('Required review obligation implemented')
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts.filter(node => node === 'verify')).toHaveLength(2)
  expect(starts).toContain('archive')
}, 180_000)

it.skipIf(!core)('accepts already implemented work on its first review without requiring an artificial code diff', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_ALREADY_IMPLEMENTED', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess'])
  const diff = spawnSync('git', ['-C', actual.repository, 'diff', '--', 'code.cjs'])
  expect(diff.status).toBe(0)
  expect(diff.stdout.toString()).toBe('')
}, 180_000)

it.skipIf(!core)('bounds changed corrections that never satisfy review before exhausting global node visits', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', 'churn')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.filter(call => call.role === 'correct')).toHaveLength(3)
  expect(actual.calls.filter(call => call.role === 'assess')).toHaveLength(4)
  expect(actual.result).toMatchObject({ runtimeStatus: 'failed', completion: { ok: false }, errorText: expect.stringContaining('Automatic correction limit reached') })
  expect(actual.result.errorText).toContain('Required canvas fallback is missing.')
  const starts = actual.events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)
  expect(starts).toContain('correction-exhausted')
  expect(starts).not.toContain('archive')
}, 180_000)

it.skipIf(!core)('retains the correction budget across a question before fixing without replaying completed review', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', 'churn')
  vi.stubEnv('SPECRAILS_FACTORY_CORRECTION_QUESTION', '1')
  const actual = await execute('implement', false, false, undefined, undefined, false, true, false, false, true)
  // A real question pauses after consuming the first correction slot. Resume
  // keeps that slot and leaves only two further corrections available.
  expect(actual.calls.filter(call => call.role === 'correct')).toHaveLength(3)
  expect(actual.calls.filter(call => call.role === 'assess')).toHaveLength(4)
  expect(actual.calls.filter(call => call.role === 'plan')).toHaveLength(1)
  expect(actual.calls.filter(call => call.role === 'build')).toHaveLength(1)
  expect(actual.result.errorText).toContain('Automatic correction limit reached (3/3)')
}, 180_000)

const startsOf = (events: Array<Record<string, any>>): string[] => events.filter(event => event.type === 'workflow-event' && event.event.type === 'step_started').map(event => event.event.nodePath)

it.skipIf(!core)('verifies again after a fixer repaired the environment without changing the candidate, and delivers (bench5 D7)', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_ENV_REPAIR', 'install')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  const starts = startsOf(actual.events)
  expect(starts.filter(node => node === 'verify')).toHaveLength(2)
  expect(starts).toContain('mark-environment-reverify')
  expect(starts).not.toContain('correction-stalled')
  expect(starts).toContain('archive')
  // The repair stayed in the ignored node_modules: the delivered candidate is the developer's alone.
  expect(spawnSync('git', ['-C', actual.repository, 'status', '--porcelain']).stdout.toString()).not.toContain('node_modules')
}, 180_000)

it.skipIf(!core)('stalls the second unchanged correction when a claimed environment repair did not fix verification', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_ENV_REPAIR', 'claim')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  // One re-verification per candidate: the second unchanged fixer turn on the same candidate stalls,
  // and each fixer turn spent one correction attempt.
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'correct', 'correct'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'failed', completion: { ok: false, verified: false }, errorText: expect.stringContaining('Automatic correction made no candidate changes') })
  const starts = startsOf(actual.events)
  expect(starts.filter(node => node === 'verify')).toHaveLength(2)
  expect(starts.filter(node => node === 'mark-environment-reverify')).toHaveLength(1)
  expect(starts).toContain('correction-stalled')
  expect(starts).not.toContain('reviewer')
}, 180_000)

it.skipIf(!core)('delivers a review whose only findings the reviewer marked as advice or out of scope, with the findings recorded', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', 'advice')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess'])
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded', completion: { ok: true, verified: true } })
  expect(actual.calls.find(call => call.role === 'assess')!.prompt).toContain('`[advice] `')
  const starts = startsOf(actual.events)
  expect(starts).not.toContain('fixer')
  expect(starts).toContain('archive')
  // The review packet reads the reviewer's committed scope from Core's status: the marked findings are
  // there as review notes, outside the issues that drive corrections.
  const status = spawnSync(process.execPath, [path.join(core!, 'dist/agent-runtime/cli.js'), 'status', '--context', actual.contextPath], { cwd: actual.repository, env: { ...process.env, SPECRAILS_GIT_AUTO: 'false' }, encoding: 'utf8' })
  const state = (JSON.parse(status.stdout) as { state: { status: string; scopes: DefinitionRunProbe['scopes'] } }).state
  const packet = buildWhatToLookAt([{ ticketId: 1, reviewBrief: definitionReviewBrief({ status: 'succeeded', scopes: state.scopes } as DefinitionRunProbe, 'reviewer') }])
  expect(packet?.reviewNotes).toEqual([
    { ticketId: 1, kind: 'advice', issue: 'Consider naming the export value.', reason: expect.stringContaining('advice') },
    { ticketId: 1, kind: 'out-of-scope', issue: 'Add a CLI flag for the value in a follow-up.', reason: expect.stringContaining('outside this change') },
  ])
  expect(packet?.humanChecks ?? []).toEqual([])
}, 180_000)

it.skipIf(!core)('corrects only the actionable finding of a review that mixes it with advice', async () => {
  vi.stubEnv('SPECRAILS_FACTORY_REVIEW_MODE', 'advice-mixed')
  const actual = await execute('implement', false, false, undefined, undefined, false, true)
  expect(actual.calls.map(call => call.role)).toEqual(['plan', 'build', 'assess', 'correct', 'assess'])
  const fixer = actual.calls.find(call => call.role === 'correct')!.prompt
  const findings = fixer.split('Latest review findings for this candidate: ')[1]?.split('. Prior execution:')[0] ?? ''
  expect(findings).toContain('Required canvas fallback is missing.')
  expect(findings).not.toContain('Consider naming the export value.')
  expect(findings).not.toContain('CLI flag')
  expect(startsOf(actual.events).filter(node => node === 'fixer')).toHaveLength(1)
  expect(actual.result).toMatchObject({ runtimeStatus: 'succeeded' })
}, 180_000)
