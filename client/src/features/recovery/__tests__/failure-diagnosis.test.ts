import { describe, expect, it, vi } from 'vitest'
import {
  availableRemedies, consequenceKey, headlineKey, offersStartOver, humanizePhase, logTailLines, openLogsAtFailure, readFailureDiagnosis, whyKey,
  type FailureDiagnosis, type RemedyHandlers,
} from '../lib/failure-diagnosis'

const base: FailureDiagnosis = { kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core', remedies: ['continue', 'edit-spec', 'open-logs', 'retry'] }
const handler = () => ({ run: vi.fn() })

describe('readFailureDiagnosis', () => {
  it('reads the wire record and drops unknown remedies', () => {
    expect(readFailureDiagnosis({ ...base, remedies: ['continue', 'teleport', 'retry'] })).toMatchObject({ kind: 'tests_failed', rounds: 4, remedies: ['continue', 'retry'] })
    // The older ids of Continue read as Continue, once.
    expect(readFailureDiagnosis({ ...base, remedies: ['resume', 'retry-with-browser', 'retry'] })?.remedies).toEqual(['continue', 'retry'])
  })
  it('never presents low confidence or an unknown kind as a cause', () => {
    expect(readFailureDiagnosis({ ...base, confidence: 'low' })).toMatchObject({ kind: 'unknown', confidence: 'low', remedies: ['open-logs', 'retry'] })
    expect(readFailureDiagnosis({ ...base, kind: 'gremlins' })).toMatchObject({ kind: 'unknown', confidence: 'low' })
  })
  it('is null for anything that is not a record', () => {
    for (const value of [null, undefined, 3, 'x', [], {}, { kind: 7 }]) expect(readFailureDiagnosis(value)).toBeNull()
  })
  it('keeps a structured blocker only when it says what to do', () => {
    const blocker = { kind: 'network', reason: 'CDN unreachable', command: 'npx', args: ['playwright', 'install'], cwd: 'a', requiredAction: 'Run it with network access' }
    expect(readFailureDiagnosis({ ...base, kind: 'environment', blocker })?.blocker).toEqual(blocker)
    expect(readFailureDiagnosis({ ...base, kind: 'environment', blocker: { reason: 'x' } })?.blocker).toBeNull()
  })
})

describe('availableRemedies', () => {
  it('shows the ranked remedies the surface can run, at most three, with Start over kept apart', () => {
    const all: RemedyHandlers = { continue: handler(), retry: handler(), 'edit-spec': handler(), 'open-logs': handler() }
    expect(availableRemedies(base, all)).toEqual(['continue', 'edit-spec', 'open-logs'])
    expect(offersStartOver(base, all)).toBe(true)
    expect(offersStartOver(base, { continue: handler() })).toBe(false)
    expect(consequenceKey('continue', { kind: 'incomplete_tasks' })).toBe('consequence.continueTasks')
    expect(consequenceKey('continue', null)).toBe('consequence.continueStopped')
    // Corrections ran out: Continue gives the fixer a fresh budget, and the card says so in plain words.
    const spent = { kind: 'blocked', confidence: 'high', phase: 'correction-exhausted', rounds: 3, resetAt: null, detail: 'Automatic corrections ran out.', resumablePhase: null, blocker: null, source: 'core' } as Parameters<typeof headlineKey>[0]
    expect(consequenceKey('continue', spent)).toBe('consequence.continueCorrections')
    expect(headlineKey(spent, 'Correction exhausted').key).toBe('headline.blocked.corrections')
    expect(whyKey(spent)).toEqual({ key: 'why.correctionsExhausted', params: { count: 3 } })
    expect(consequenceKey('edit-spec', base)).toBe('consequence.editSpec')
  })
  it('skips remedies the surface has no action for', () => {
    expect(availableRemedies(base, { 'open-logs': handler() })).toEqual(['open-logs'])
    expect(availableRemedies(base, {})).toEqual([])
  })
  it('reads and offers the env-file remedy only with its handler', () => {
    const env: FailureDiagnosis = { ...base, kind: 'environment', remedies: ['copy-env-files', 'continue', 'fix-environment'] }
    expect(readFailureDiagnosis(env)?.remedies).toEqual(['copy-env-files', 'continue', 'fix-environment'])
    expect(availableRemedies(env, { continue: handler(), 'copy-env-files': handler() })).toEqual(['copy-env-files', 'continue', 'fix-environment'])
    expect(availableRemedies(env, { continue: handler() })).toEqual(['continue', 'fix-environment'])
    expect(consequenceKey('copy-env-files', env)).toBe('consequence.copyEnvFiles')
  })
  it('offers fixing the environment without a handler, only for environment failures', () => {
    expect(availableRemedies({ ...base, kind: 'environment', remedies: ['fix-environment', 'continue'] }, {})).toEqual(['fix-environment'])
    expect(availableRemedies({ ...base, kind: 'blocked', remedies: ['fix-environment', 'continue'] }, {})).toEqual([])
  })
})

describe('headline and why keys', () => {
  it('composes the tests-failed sentence from what is known', () => {
    expect(headlineKey(base, 'Reviewer').key).toBe('headline.tests_failed.phaseRounds')
    expect(headlineKey({ ...base, phase: null }, null).key).toBe('headline.tests_failed.rounds')
    expect(headlineKey({ ...base, rounds: null }, 'Reviewer').key).toBe('headline.tests_failed.phase')
    expect(headlineKey({ ...base, rounds: null, phase: null }, null).key).toBe('headline.tests_failed.plain')
    expect(headlineKey(base, 'Reviewer').params).toMatchObject({ phase: 'Reviewer', count: 4 })
  })
  it('has one headline per kind', () => {
    expect(headlineKey({ ...base, kind: 'provider_limit' }, null).key).toBe('headline.provider_limit')
    expect(headlineKey({ ...base, kind: 'crash' }, 'Developer').key).toBe('headline.crash.phase')
    // A provider outage (contract 5.17) is its own cause, continued like a transient one.
    expect(headlineKey({ ...base, kind: 'provider_unavailable' }, 'Architect').key).toBe('headline.provider_unavailable.phase')
    expect(headlineKey({ ...base, kind: 'provider_unavailable' }, null).key).toBe('headline.provider_unavailable.plain')
    expect(whyKey({ ...base, kind: 'provider_unavailable' })?.key).toBe('why.provider_unavailable')
    expect(consequenceKey('continue', { kind: 'provider_unavailable' })).toBe('consequence.continueTransient')
    expect(readFailureDiagnosis({ ...base, kind: 'provider_unavailable' })?.kind).toBe('provider_unavailable')
    expect(headlineKey({ ...base, kind: 'unknown' }, null).key).toBe('headline.unknown')
  })
  it('says when a provider limit resets only when it knows', () => {
    expect(whyKey({ ...base, kind: 'provider_limit', resetAt: '3am (Europe/Madrid)' })).toEqual({ key: 'why.provider_limit.reset', params: { resetAt: '3am (Europe/Madrid)' } })
    expect(whyKey({ ...base, kind: 'provider_limit', resetAt: '3am', resetsAt: '2026-11-18T14:00:00.000Z' })).toEqual({ key: 'why.provider_limit.resetsAt', params: { resetsAt: '2026-11-18T14:00:00.000Z' } })
    expect(whyKey({ ...base, kind: 'provider_limit' })?.key).toBe('why.provider_limit.noReset')
    expect(whyKey({ ...base, kind: 'unknown' })).toBeNull()
  })
  it('makes raw step ids readable', () => {
    expect(humanizePhase('implement/fix-round')).toBe('Fix round')
    expect(humanizePhase(null)).toBeNull()
  })
})

describe('logTailLines', () => {
  const log = (line: string, seq = 1) => ({ event_type: 'log', payload: JSON.stringify({ line }), seq })
  it('returns the last non-empty log lines in order, ignoring other events', () => {
    const events = [log('one\ntwo'), { event_type: 'assistant', payload: '{}' }, log('   '), log('three\n\nfour')]
    expect(logTailLines(events, 3)).toEqual(['two', 'three', 'four'])
    expect(logTailLines([])).toEqual([])
  })
  it('survives unreadable events', () => {
    expect(logTailLines([{ event_type: 'log', payload: '{nope' }, log('ok')])).toEqual(['ok'])
  })
})

describe('openLogsAtFailure', () => {
  it('scrolls to and focuses the last failed step, else the log', () => {
    document.body.innerHTML = '<div data-testid="loop-step-explorer"><div id="a" data-testid="loop-step-section" data-status="failed"></div><div id="b" data-testid="loop-step-section" data-status="ok"></div><div id="c" data-testid="loop-step-section" data-status="failed"></div></div>'
    const scroll = vi.fn()
    for (const id of ['a', 'c']) document.getElementById(id)!.scrollIntoView = scroll
    expect(openLogsAtFailure()).toBe(true)
    expect(scroll).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.id).toBe('c')
    document.body.innerHTML = '<div data-testid="log-viewer" id="log"></div>'
    document.getElementById('log')!.scrollIntoView = scroll
    expect(openLogsAtFailure()).toBe(true)
    expect(document.activeElement?.id).toBe('log')
  })
  it('reports when there is no log to show', () => {
    document.body.innerHTML = ''
    expect(openLogsAtFailure()).toBe(false)
  })
})

describe('port_in_use', () => {
  it('reads the port and names it in the headline', () => {
    const d = readFailureDiagnosis({ ...base, kind: 'port_in_use', port: 3000, remedies: ['resume', 'retry', 'open-logs'] })!
    expect(d.port).toBe(3000)
    expect(headlineKey(d, null)).toEqual({ key: 'headline.port_in_use.port', params: { phase: '', count: 4, port: 3000 } })
    expect(whyKey(d)).toEqual({ key: 'why.port_in_use', params: {} })
    const noPort = readFailureDiagnosis({ ...base, kind: 'port_in_use', port: 'x' })!
    expect(noPort.port).toBeNull()
    expect(headlineKey(noPort, null).key).toBe('headline.port_in_use.plain')
  })
})

describe('incomplete tasks on the wire', () => {
  it('reads the task list and its remedies (the older retry id as Continue)', async () => {
    const { readFailureDiagnosis } = await import('../lib/failure-diagnosis')
    const read = readFailureDiagnosis({ kind: 'incomplete_tasks', confidence: 'high', incompleteTasks: ['4.1 Note', 7, ''], remedies: ['continue-to-review', 'retry-with-browser', 'bogus'] })
    expect(read).toMatchObject({ kind: 'incomplete_tasks', incompleteTasks: ['4.1 Note'], remedies: ['continue-to-review', 'continue'] })
    expect(readFailureDiagnosis({ kind: 'spec_invalid', confidence: 'high', remedies: [] })?.kind).toBe('spec_invalid')
  })
})

describe('workflow protocol record (Core contract 5.16)', () => {
  it('reads the role, the model and a well-formed stronger-model suggestion only', () => {
    const wire = { ...base, kind: 'workflow_protocol', role: 'plan', model: 'haiku', strongerModel: { provider: 'claude', model: 'sonnet', label: 'Claude Sonnet 5.5' }, remedies: ['resume', 'retry', 'open-logs'] }
    expect(readFailureDiagnosis(wire)).toMatchObject({ kind: 'workflow_protocol', role: 'plan', model: 'haiku', strongerModel: { model: 'sonnet' }, remedies: ['continue', 'retry', 'open-logs'] })
    expect(readFailureDiagnosis({ ...wire, strongerModel: { provider: 'claude' } })?.strongerModel).toBeNull()
    const read = readFailureDiagnosis(wire)!
    expect(headlineKey(read, 'Architect')).toEqual({ key: 'headline.workflow_protocol.role', params: { phase: 'Architect', count: 4, role: 'plan' } })
    expect(whyKey(read)).toEqual({ key: 'why.workflow_protocol.stronger', params: { model: 'haiku', stronger: 'Claude Sonnet 5.5' } })
    expect(whyKey({ ...read, strongerModel: null })).toEqual({ key: 'why.workflow_protocol.plain', params: {} })
  })
})

