import { describe, expect, it, vi } from 'vitest'
import {
  availableRemedies, headlineKey, humanizePhase, logTailLines, openLogsAtFailure, readFailureDiagnosis, whyKey,
  type FailureDiagnosis, type RemedyHandlers,
} from '../lib/failure-diagnosis'

const base: FailureDiagnosis = { kind: 'tests_failed', confidence: 'high', phase: 'reviewer', rounds: 4, resetAt: null, detail: null, resumablePhase: 'fixer', blocker: null, source: 'core', remedies: ['resume', 'edit-spec', 'open-logs', 'retry'] }
const handler = () => ({ run: vi.fn() })

describe('readFailureDiagnosis', () => {
  it('reads the wire record and drops unknown remedies', () => {
    expect(readFailureDiagnosis({ ...base, remedies: ['resume', 'teleport', 'retry'] })).toMatchObject({ kind: 'tests_failed', rounds: 4, remedies: ['resume', 'retry'] })
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
  it('shows the ranked remedies the surface can run, at most three', () => {
    const all: RemedyHandlers = { resume: handler(), retry: handler(), 'edit-spec': handler(), 'open-logs': handler() }
    expect(availableRemedies(base, all)).toEqual(['resume', 'edit-spec', 'open-logs'])
  })
  it('skips remedies the surface has no action for', () => {
    expect(availableRemedies(base, { 'open-logs': handler() })).toEqual(['open-logs'])
    expect(availableRemedies(base, {})).toEqual([])
  })
  it('offers fixing the environment without a handler, only for environment failures', () => {
    expect(availableRemedies({ ...base, kind: 'environment', remedies: ['fix-environment', 'resume'] }, {})).toEqual(['fix-environment'])
    expect(availableRemedies({ ...base, kind: 'blocked', remedies: ['fix-environment', 'resume'] }, {})).toEqual([])
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
    expect(headlineKey({ ...base, kind: 'unknown' }, null).key).toBe('headline.unknown')
  })
  it('says when a provider limit resets only when it knows', () => {
    expect(whyKey({ ...base, kind: 'provider_limit', resetAt: '3am (Europe/Madrid)' })).toEqual({ key: 'why.provider_limit.reset', params: { resetAt: '3am (Europe/Madrid)' } })
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
