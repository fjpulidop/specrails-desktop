import { describe, expect, it } from 'vitest'
import {
  autoContinueVerdict, continuationGuidance, failureEvidence, parseFailureAnalysis, parseResolutionOptions, readStoredOptions, repeatedStop,
  resolutionGuidance, resolutionKindsFor, sameCause, stopChecks, type FailureDiagnosis, type FailureEvidence,
} from '..'

const option = (patch: Record<string, unknown> = {}) => ({
  id: 'deterministic-close', kind: 'continue-with-guidance', label: 'Make the close tests deterministic',
  does: 'Launches Electron without the Playwright debugger in tests/desktop/menus.spec.ts.', consequence: 'The run can deliver once they pass on every round.',
  risk: 'low', recommended: true, guidance: 'In tests/desktop/menus.spec.ts launch Electron without --inspect and assert only the exit code.', ...patch,
})

const evidence = (optionKinds: FailureEvidence['context'] extends infer C ? C extends { optionKinds: infer K } ? K : never : never): FailureEvidence => ({
  job: { command: 'loop:implement', status: 'failed', provider: 'codex', model: null }, diagnosis: { kind: 'blocked', detail: 'Automatic corrections ran out' },
  lines: ['[runtime] verification_failed: verify'], truncated: false,
  context: { failingTests: [], flakyTests: [], attempts: null, optionKinds },
})

const diagnosis = (patch: Partial<FailureDiagnosis>): FailureDiagnosis => ({
  kind: 'blocked', confidence: 'high', phase: 'correction-exhausted', rounds: 3, resetAt: null, detail: 'Automatic corrections ran out.', resumablePhase: null, blocker: null, source: 'core', ...patch,
})

describe('resolution options from the AI analysis', () => {
  it('keeps at most four options, drops unknown kinds and the kinds this run cannot execute, and keeps one recommendation', () => {
    const parsed = parseResolutionOptions([
      option(), option({ id: 'deterministic-close', recommended: true, label: 'Second with the same id' }), option({ kind: 'rm-rf' }),
      option({ id: 'review', kind: 'continue-to-review' }), option({ id: 'manual', kind: 'mark-human-check', guidance: 'Salir exits from main; native close exits during an idle reload' }),
      option({ id: 'model', kind: 'change-model' }), option({ id: 'over', kind: 'start-over' }),
    ], ['continue-with-guidance', 'mark-human-check', 'change-model', 'start-over'])
    expect(parsed.map((item) => [item.id, item.kind, !!item.recommended])).toEqual([
      ['deterministic-close', 'continue-with-guidance', true], ['deterministic-close-2', 'continue-with-guidance', false],
      ['manual', 'mark-human-check', false], ['model', 'change-model', false],
    ])
    // Only Continue kinds carry guidance for the agent.
    expect(parsed[3].guidance).toBe('')
  })

  it('drops an option the person cannot read, and a move to manual checks that names none', () => {
    expect(parseResolutionOptions([option({ consequence: '' }), option({ label: '  ' }), option({ kind: 'mark-human-check', guidance: '' }), 'text', null])).toEqual([])
    expect(parseResolutionOptions('not a list')).toEqual([])
    const odd = parseResolutionOptions([option({ risk: 'extreme', id: 'Weird ID!!' })])[0]
    expect(odd.id).toBe('weird-id')
    expect('risk' in odd).toBe(false)
  })

  it('parses options from the model answer within the evidence\'s executable kinds; an older answer has none and keeps its plan', () => {
    const answer = JSON.stringify({ headline: 'The close tests fail under the debugger', cause: 'Electron waits for the inspector.', category: 'tests', failedStep: 'verify', evidence: [],
      nextSteps: ['Open the evidence'], options: [option(), option({ id: 'spec', kind: 'edit-spec' })] })
    const parsed = parseFailureAnalysis(answer, evidence(['continue-with-guidance', 'change-model']))
    expect(parsed.options?.map((item) => item.id)).toEqual(['deterministic-close'])
    const old = parseFailureAnalysis(JSON.stringify({ headline: 'h', cause: 'c', category: 'tests', nextSteps: ['resume from verify'] }), evidence(['continue-with-guidance']))
    expect(old.options).toBeUndefined()
    expect(old.nextSteps).toEqual(['resume from verify'])
    // A cached analysis written before options existed still reads (no options).
    expect(readStoredOptions({ headline: 'h' } as never)).toEqual([])
    expect(readStoredOptions(null)).toEqual([])
  })

  it('lets the evidence carry the failing and flaky tests and the attempts into the hashed input', () => {
    const built = failureEvidence({ job: evidence([]).job, diagnosis: null, events: [], context: { failingTests: ['a › b'], flakyTests: ['a › b'], attempts: { count: 5, costUsd: 15.02, repeated: true, times: 3 }, optionKinds: ['continue-with-guidance'] } })
    expect(built.context).toMatchObject({ flakyTests: ['a › b'], attempts: { count: 5, repeated: true } })
  })

  it('offers only the kinds the run can execute', () => {
    expect(resolutionKindsFor({ kind: 'blocked', confidence: 'high', remedies: ['continue', 'edit-spec', 'open-logs', 'retry'] }))
      .toEqual(['continue-with-guidance', 'mark-human-check', 'edit-spec', 'change-model', 'start-over'])
    expect(resolutionKindsFor({ kind: 'incomplete_tasks', confidence: 'high', remedies: ['continue', 'continue-to-review', 'open-logs', 'retry'] }))
      .toEqual(['continue-with-guidance', 'continue-to-review', 'mark-human-check', 'change-model', 'start-over'])
    // An unknown cause is never continued on an AI's word.
    expect(resolutionKindsFor({ kind: 'unknown', confidence: 'low', remedies: ['open-logs', 'retry'] })).toEqual(['change-model', 'start-over'])
    expect(resolutionKindsFor(null)).toEqual(['change-model'])
  })
})

describe('the guidance a chosen resolution sends', () => {
  it('hands the option\'s label, what it does and its guidance to the agent', () => {
    const text = resolutionGuidance({ kind: 'continue-with-guidance', label: 'Make the close tests deterministic', does: 'Without the debugger.', guidance: 'Launch Electron without --inspect.' })!
    expect(text).toContain('"Make the close tests deterministic"')
    expect(text).toContain('What to do: Launch Electron without --inspect.')
    expect(resolutionGuidance({ kind: 'continue-with-guidance', label: 'Keep trying as is', guidance: '' })).toMatch(/same approach/)
  })
  it('moves named checks to [human] checks the person makes after delivery, keeping the tests', () => {
    const text = resolutionGuidance({ kind: 'mark-human-check', label: 'Check closing by hand', guidance: 'Salir exits from main' })!
    expect(text).toContain('Which checks: Salir exits from main')
    expect(text).toContain('[human]')
    expect(text).toMatch(/Do not delete the test/)
  })
  it('passes the person\'s own instruction, bounded, and nothing for an empty one', () => {
    expect(resolutionGuidance({ kind: 'instruction', text: '  Use a fake clock  ' })).toMatch(/own instruction[\s\S]*Use a fake clock$/)
    expect(resolutionGuidance({ kind: 'instruction', text: 'x'.repeat(9000) })!.length).toBeLessThan(4300)
    expect(resolutionGuidance({ kind: 'instruction', text: '  ' })).toBeNull()
    expect(resolutionGuidance(null)).toBeNull()
  })
  it('tells the fixer to make flaky tests deterministic instead of tuning timeouts, with any cause', () => {
    const text = continuationGuidance(diagnosis({}), { flakyTests: ['tests/desktop/menus.spec.ts › Salir exits from main'] })!
    expect(text).toContain('- tests/desktop/menus.spec.ts › Salir exits from main')
    expect(text).toMatch(/deterministic/)
    expect(text).toMatch(/Do not lengthen timeouts/)
    expect(continuationGuidance(diagnosis({ kind: 'crash', phase: 'fixer', detail: null }), { flakyTests: [] })).toBeNull()
  })
})

describe('the same cause twice', () => {
  const stop = (patch: Partial<FailureDiagnosis>, failingTests: string[] = []) => ({ diagnosis: diagnosis(patch), failingTests })
  it('is the same kind at the same step with the same failing checks, even in other words', () => {
    const a = stop({ detail: 'Automatic corrections ran out. Fixer: patched the 5 s wait.' }, ['menus › Salir exits'])
    const b = stop({ detail: 'Automatic corrections ran out. Fixer: closed the inspector on quit.' }, ['menus › Salir exits'])
    expect(sameCause(a, b)).toBe(true)
    expect(sameCause(a, stop({ detail: 'other' }, ['menus › other test']))).toBe(false)
    expect(sameCause(a, stop({ kind: 'tests_failed' }, ['menus › Salir exits']))).toBe(false)
    expect(stopChecks(stop({ detail: 'The reviewer still asks for: [local-settings/apply-after-save] keep the draft' }))).toEqual(['local-settings/apply-after-save'])
  })
  it('two consecutive attempts with the same cause, or three budget stops in a row at one step, repeat', () => {
    expect(repeatedStop([stop({ detail: 'x' }, ['t']), stop({ detail: 'y' }, ['t'])])).toEqual({ repeated: true, times: 2 })
    expect(repeatedStop([stop({ detail: 'x' }, ['t']), stop({ detail: 'y' }, ['u'])])).toEqual({ repeated: false, times: 1 })
    // The motivating chain: corrections ran out three times with different findings each time.
    const chain = [stop({ kind: 'crash', phase: null }), stop({ detail: 'a [x/y]' }), stop({ detail: 'b' }), stop({ detail: 'c' }, ['menus › Salir exits'])]
    expect(repeatedStop(chain)).toEqual({ repeated: true, times: 3 })
    expect(repeatedStop(chain.slice(0, 3))).toEqual({ repeated: false, times: 1 })
  })
  it('makes automatic continuation refuse a repeat', () => {
    const stalled = diagnosis({ detail: 'Implementation attempt limit reached (3/3)' })
    expect(autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis: stalled, chainAlreadyContinued: false })).toMatchObject({ continue: true })
    expect(autoContinueVerdict({ enabled: true, outcome: 'failed', diagnosis: stalled, chainAlreadyContinued: false, repeated: true })).toEqual({ continue: false, reason: 'repeated_failure' })
  })
})
