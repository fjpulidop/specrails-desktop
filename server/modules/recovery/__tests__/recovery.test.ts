import { beforeEach, describe, expect, it } from 'vitest'
import { initDb, type DbInstance } from '../../../db'
import { createLoopRun, finishLoopRun, finishLoopRunAndJob, getLoopRun } from '../../loops/runtime/loop-runs-store'
import {
  FAILURE_KINDS, deriveFailureDiagnosis, parseBlocker, isDiagnosableOutcome, parseCoreFailure, parseStoredDiagnosis, presentFailureDiagnosis, rankRemedies, serializeDiagnosis,
} from '../domain'
import { readJobDiagnosis, readRunDiagnosis } from '../adapters/sqlite'

describe('parseCoreFailure', () => {
  it('accepts Core\'s record and keeps only documented fields', () => {
    expect(parseCoreFailure({ kind: 'tests_failed', phase: 'fixer', rounds: 4, resumablePhase: 'fixer', detail: 'a  b\nc', confidence: 'high', extra: 1 }))
      .toEqual({ kind: 'tests_failed', confidence: 'high', phase: 'fixer', rounds: 4, resetAt: null, detail: 'a b c', resumablePhase: 'fixer', blocker: null, source: 'core' })
  })
  it('keeps the reset hint only for provider limits', () => {
    expect(parseCoreFailure({ kind: 'provider_limit', resetAt: '3am', confidence: 'high' })?.resetAt).toBe('3am')
    expect(parseCoreFailure({ kind: 'crash', resetAt: '3am', confidence: 'high' })?.resetAt).toBeNull()
  })
  it('never presents a low-confidence or newer-than-known kind as a cause', () => {
    expect(parseCoreFailure({ kind: 'crash', confidence: 'low' })).toMatchObject({ kind: 'unknown', confidence: 'low' })
    expect(parseCoreFailure({ kind: 'cosmic_rays', confidence: 'high' })).toMatchObject({ kind: 'unknown', confidence: 'low' })
  })
  it('rejects malformed records', () => {
    for (const value of [null, undefined, 'x', [], {}, { kind: 4 }]) expect(parseCoreFailure(value)).toBeNull()
  })
})

describe('deriveFailureDiagnosis', () => {
  it('prefers Core\'s classification and fills the phase from the failed step', () => {
    expect(deriveFailureDiagnosis({ outcome: 'failed', stepId: 'node-3', stallReason: 'idle_timeout', core: { kind: 'environment', confidence: 'high' } }))
      .toMatchObject({ kind: 'environment', source: 'core', phase: 'node-3' })
  })
  it('uses the loop\'s provider-limit signal with the provider\'s own reset wording', () => {
    expect(deriveFailureDiagnosis({ outcome: 'stalled', stallReason: 'provider_limit', providerLimit: { kind: 'session_limit', message: "You've hit your session limit", resetsAt: '3am (Europe/Madrid)' } }))
      .toMatchObject({ kind: 'provider_limit', confidence: 'high', resetAt: '3am (Europe/Madrid)', source: 'desktop' })
  })
  it('maps stall reasons', () => {
    expect(deriveFailureDiagnosis({ outcome: 'stalled', stallReason: 'idle_timeout' })).toMatchObject({ kind: 'tool_inactivity', confidence: 'high' })
    expect(deriveFailureDiagnosis({ outcome: 'stalled', stallReason: 'no_progress' })).toMatchObject({ kind: 'blocked', confidence: 'high' })
  })
  it('treats the loop\'s own cost and iteration caps as blocked, not failed', () => {
    for (const outcome of ['max-cost', 'max-iterations']) expect(deriveFailureDiagnosis({ outcome })).toMatchObject({ kind: 'blocked', confidence: 'high', detail: null })
  })
  it('recognises a provider limit in an older Core\'s error text', () => {
    expect(deriveFailureDiagnosis({ outcome: 'failed', errorText: "claude failed. You've hit your session limit · resets 3am (Europe/Madrid)" }))
      .toMatchObject({ kind: 'provider_limit', resetAt: '3am (Europe/Madrid)' })
  })
  it('recognises Core\'s fixed blocker sentences only', () => {
    expect(deriveFailureDiagnosis({ outcome: 'blocked', errorText: 'Baseline blocked: the characterization tests do not pass' })).toMatchObject({ kind: 'blocked', confidence: 'high' })
    expect(deriveFailureDiagnosis({ outcome: 'blocked', errorText: 'Verification cannot run in this environment: no network' })).toMatchObject({ kind: 'environment', confidence: 'high' })
    expect(deriveFailureDiagnosis({ outcome: 'blocked', blockedReason: 'validation blocked' })).toMatchObject({ kind: 'blocked', detail: 'validation blocked' })
  })
  it('turns Core\'s structured host blocker into an environment cause with its required action', () => {
    const hostBlocker = { kind: 'network', reason: 'the Playwright CDN is unreachable', command: 'npx', args: ['playwright', 'install'], cwd: 'ticket-1', requiredAction: 'Run npx playwright install with network access', junk: 1 }
    const diagnosis = deriveFailureDiagnosis({ outcome: 'blocked', hostBlocker, blockedReason: 'Host blocker (network)' })
    expect(diagnosis).toMatchObject({ kind: 'environment', confidence: 'high', detail: 'the Playwright CDN is unreachable', blocker: { kind: 'network', command: 'npx', args: ['playwright', 'install'], cwd: 'ticket-1', requiredAction: 'Run npx playwright install with network access' } })
    expect(parseStoredDiagnosis(serializeDiagnosis(diagnosis))?.blocker).toEqual(diagnosis.blocker)
    expect(parseBlocker({ reason: 'x' })).toBeNull()
  })
  it('says unknown, with low confidence, when nothing certain matches', () => {
    expect(deriveFailureDiagnosis({ outcome: 'failed', errorText: 'tests failed somewhere probably', stepId: 's1' }))
      .toEqual({ kind: 'unknown', confidence: 'low', phase: 's1', rounds: null, resetAt: null, detail: 'tests failed somewhere probably', resumablePhase: null, blocker: null, source: 'desktop' })
  })
})

describe('rankRemedies', () => {
  const rank = (kind: (typeof FAILURE_KINDS)[number], extra: { resumablePhase?: string | null; confidence?: 'high' | 'low' } = {}) =>
    rankRemedies({ kind, confidence: extra.confidence ?? 'high', resumablePhase: extra.resumablePhase ?? null })
  it('orders remedies by cause', () => {
    expect(rank('tests_failed', { resumablePhase: 'fixer' })).toEqual(['resume', 'edit-spec', 'open-logs', 'retry'])
    expect(rank('tests_failed')).toEqual(['edit-spec', 'open-logs', 'retry'])
    expect(rank('provider_limit')).toEqual(['resume', 'retry', 'open-logs'])
    expect(rank('environment')).toEqual(['fix-environment', 'resume', 'open-logs', 'retry'])
    expect(rank('blocked')).toEqual(['resume', 'edit-spec', 'open-logs', 'retry'])
    for (const kind of ['timeout', 'tool_inactivity', 'crash'] as const) expect(rank(kind)).toEqual(['resume', 'retry', 'open-logs'])
  })
  it('offers only logs and a retry when the cause is unknown or uncertain', () => {
    expect(rank('unknown')).toEqual(['open-logs', 'retry'])
    expect(rank('crash', { confidence: 'low' })).toEqual(['open-logs', 'retry'])
  })
  it('only ever names existing remedies', () => {
    for (const kind of FAILURE_KINDS) for (const remedy of rank(kind, { resumablePhase: 'x' })) expect(['resume', 'retry', 'edit-spec', 'fix-environment', 'open-logs']).toContain(remedy)
  })
})

describe('stored diagnosis', () => {
  it('round-trips and treats junk as absent', () => {
    const diagnosis = deriveFailureDiagnosis({ outcome: 'stalled', stallReason: 'idle_timeout', stepId: 'n1' })
    expect(parseStoredDiagnosis(serializeDiagnosis(diagnosis))).toEqual(diagnosis)
    for (const raw of [null, '', 'not json', '[]', '{"kind":7}']) expect(parseStoredDiagnosis(raw)).toBeNull()
  })
  it('knows which outcomes deserve a diagnosis', () => {
    expect(['failed', 'blocked', 'stalled'].every(isDiagnosableOutcome)).toBe(true)
    expect(['success', 'stopped', null].some((o) => isDiagnosableOutcome(o))).toBe(false)
  })
})

describe('sqlite adapter (migration 84)', () => {
  let db: DbInstance
  beforeEach(() => { db = initDb(':memory:') })
  const run = (id: string) => createLoopRun(db, { id, projectId: 'p1', loopId: 'l', loopName: 'Implement', railIndex: 0, ticketIds: [1], iterationLimit: 1, startedAt: '2026-10-24T10:00:00.000Z' })

  it('adds the nullable column', () => {
    const cols = (db.prepare('PRAGMA table_info(loop_runs)').all() as Array<{ name: string }>).map((c) => c.name)
    expect(cols).toContain('failure_diagnosis')
  })

  it('persists the diagnosis with the run outcome and reads it back with remedies', () => {
    run('r1')
    const stored = serializeDiagnosis(deriveFailureDiagnosis({ outcome: 'failed', core: { kind: 'tests_failed', phase: 'fixer', rounds: 4, resumablePhase: 'fixer', confidence: 'high' } }))
    finishLoopRun(db, 'r1', { outcome: 'failed', finishedAt: '2026-10-24T10:05:00.000Z', failureDiagnosis: stored })
    expect(getLoopRun(db, 'r1')?.failure_diagnosis).toBe(stored)
    expect(readRunDiagnosis(db, 'r1')).toMatchObject({ kind: 'tests_failed', rounds: 4, remedies: ['resume', 'edit-spec', 'open-logs', 'retry'] })
  })

  it('derives unknown for runs finished before the column and none for runs that did not fail', () => {
    run('old'); finishLoopRun(db, 'old', { outcome: 'failed', finishedAt: '2026-10-24T10:05:00.000Z' })
    run('ok'); finishLoopRun(db, 'ok', { outcome: 'success', finishedAt: '2026-10-24T10:05:00.000Z' })
    run('live')
    expect(readRunDiagnosis(db, 'old')).toMatchObject({ kind: 'unknown', confidence: 'low' })
    expect(readRunDiagnosis(db, 'ok')).toBeNull()
    expect(readRunDiagnosis(db, 'live')).toBeNull()
    expect(readRunDiagnosis(db, 'missing')).toBeNull()
  })

  it('clears a stale diagnosis when a resumed run finishes without one', () => {
    run('r2')
    db.prepare("INSERT INTO jobs (id, command, started_at, status) VALUES ('r2','/x',datetime('now'),'running') ON CONFLICT(id) DO NOTHING").run()
    finishLoopRun(db, 'r2', { outcome: 'failed', finishedAt: '2026-10-24T10:05:00.000Z', failureDiagnosis: serializeDiagnosis(deriveFailureDiagnosis({ outcome: 'failed' })) })
    finishLoopRunAndJob(db, 'r2', { outcome: 'success', finishedAt: '2026-10-24T11:00:00.000Z', counters: { iterationCount: 1, totalCostUsd: 0, totalTokens: 0, totalDurationMs: 1 },
      job: { exitCode: 0, status: 'completed', totalCostUsd: 0, tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheCreate: 0, durationMs: 1, numTurns: 1 } })
    expect(getLoopRun(db, 'r2')?.failure_diagnosis).toBeNull()
  })

  it('explains a failed queue job honestly as unknown', () => {
    expect(readJobDiagnosis(db, 'job-x', 'failed')).toMatchObject({ kind: 'unknown', confidence: 'low' })
    expect(readJobDiagnosis(db, 'job-x', 'completed')).toBeNull()
  })

  it('presents remedies without mutating the record', () => {
    const base = deriveFailureDiagnosis({ outcome: 'failed' })
    expect(presentFailureDiagnosis(base)).toEqual({ ...base, remedies: ['open-logs', 'retry'] })
  })
})
