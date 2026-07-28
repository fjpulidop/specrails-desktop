import { describe, it, expect } from 'vitest'
import {
  CONFIDENCE_RAW_CAP,
  VERIFY_TAIL_CAP,
  extractVerifyStepText,
  harvestDeliveryEvidence,
  parseConfidenceScore,
  parseVerificationSentinel,
  readSettleEvidence,
  type EvidenceHarvestIO,
} from './delivery-evidence'
import type { EventRow } from './types'

let seq = 0
function ev(event_type: string, payload: string, job_id = 'run-1'): EventRow {
  seq += 1
  return { id: seq, job_id, seq, event_type, source: null, payload, timestamp: '2026-07-27T10:00:00Z' }
}

function assistant(text: string, job_id = 'run-1'): EventRow {
  return ev('assistant', JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }), job_id)
}

function step(index: number, nodeId: string, job_id = 'run-1'): EventRow {
  return ev('loop_step', JSON.stringify({ index, nodeId, kind: 'ai-step', title: nodeId }), job_id)
}

function stepEnd(index: number, nodeId: string, job_id = 'run-1'): EventRow {
  return ev('loop_step_end', JSON.stringify({ index, nodeId, status: 'ok' }), job_id)
}

describe('parseVerificationSentinel', () => {
  it('detects PASS', () => {
    expect(parseVerificationSentinel('all good\nVERIFICATION: PASS')).toEqual({ verdict: 'pass', detail: null })
  })

  it('detects FAIL and captures the bounded reason', () => {
    expect(parseVerificationSentinel('VERIFICATION: FAIL — 3 tests broken in auth')).toEqual({
      verdict: 'fail',
      detail: '3 tests broken in auth',
    })
  })

  it('accepts a colon separator and lowercase', () => {
    expect(parseVerificationSentinel('verification: fail: typecheck exploded').detail).toBe('typecheck exploded')
  })

  it('is absent when no sentinel appears', () => {
    expect(parseVerificationSentinel('tests pass, everything is fine')).toEqual({ verdict: 'absent', detail: null })
  })

  it('last sentinel wins so a quoted format in reasoning cannot shadow the verdict', () => {
    const text = 'I will end with VERIFICATION: PASS if green\n...\nVERIFICATION: FAIL — lint errors'
    expect(parseVerificationSentinel(text)).toEqual({ verdict: 'fail', detail: 'lint errors' })
  })

  it('drops a detail tail on PASS (only failures carry a reason)', () => {
    expect(parseVerificationSentinel('VERIFICATION: PASS — 68 tests').detail).toBeNull()
  })

  it('bounds an overlong failure detail', () => {
    const detail = parseVerificationSentinel(`VERIFICATION: FAIL — ${'x'.repeat(900)}`).detail
    expect(detail).toHaveLength(512)
  })
})

describe('extractVerifyStepText', () => {
  it('scopes to the verify step when loop boundaries exist', () => {
    const events = [
      step(1, 'implement'),
      assistant('writing the feature'),
      stepEnd(1, 'implement'),
      step(2, 'verify'),
      assistant('running tests\nVERIFICATION: PASS'),
      stepEnd(2, 'verify'),
    ]
    const out = extractVerifyStepText(events)
    expect(out.scoped).toBe(true)
    expect(out.text).toContain('running tests')
    expect(out.text).not.toContain('writing the feature')
  })

  it('takes the LAST verify step when a loop iterates', () => {
    const events = [
      step(1, 'verify'),
      assistant('first attempt\nVERIFICATION: FAIL — broken'),
      stepEnd(1, 'verify'),
      step(2, 'implement'),
      assistant('fixing'),
      stepEnd(2, 'implement'),
      step(3, 'verify'),
      assistant('second attempt\nVERIFICATION: PASS'),
      stepEnd(3, 'verify'),
    ]
    const out = extractVerifyStepText(events)
    expect(out.text).toContain('second attempt')
    expect(out.text).not.toContain('first attempt')
  })

  it('falls back to the whole stream (unscoped) for non-loop jobs', () => {
    const out = extractVerifyStepText([assistant('plain job output\nVERIFICATION: PASS')])
    expect(out.scoped).toBe(false)
    expect(out.text).toContain('plain job output')
  })

  it('includes plain log rows and ignores unrelated structured events', () => {
    const events = [
      step(1, 'verify'),
      ev('log', 'npm test output line'),
      ev('loop_graph', JSON.stringify({ graph: {} })),
      assistant('VERIFICATION: PASS'),
    ]
    const text = extractVerifyStepText(events).text
    expect(text).toContain('npm test output line')
    expect(text).toContain('VERIFICATION: PASS')
    expect(text).not.toContain('graph')
  })

  it('survives malformed payloads', () => {
    const events = [step(1, 'verify'), ev('assistant', '{not json'), assistant('ok')]
    expect(extractVerifyStepText(events).text).toBe('ok')
  })

  it('handles an interrupted verify step with no end event', () => {
    const events = [step(1, 'verify'), assistant('mid-flight output')]
    const out = extractVerifyStepText(events)
    expect(out.scoped).toBe(true)
    expect(out.text).toBe('mid-flight output')
  })
})

describe('parseConfidenceScore', () => {
  it('parses the documented reviewer schema', () => {
    const raw = JSON.stringify({
      schema_version: '1',
      agent: 'reviewer',
      overall: 82,
      aspects: { type_correctness: 90, test_coverage: 70 },
      flags: ['missing integration test'],
    })
    const parsed = parseConfidenceScore(raw, 'my-change')
    expect(parsed).toMatchObject({
      changeName: 'my-change',
      overall: 82,
      aspects: { type_correctness: 90, test_coverage: 70 },
      flags: ['missing integration test'],
    })
  })

  it('accepts the alternate `scores` key and nested {score} objects', () => {
    const parsed = parseConfidenceScore(JSON.stringify({ scores: { security: { score: 55 } } }), null)
    expect(parsed?.aspects).toEqual({ security: 55 })
  })

  it('returns null for malformed JSON', () => {
    expect(parseConfidenceScore('{oops', 'c')).toBeNull()
  })

  it('returns null for a non-object payload', () => {
    expect(parseConfidenceScore('[1,2,3]', 'c')).toBeNull()
    expect(parseConfidenceScore('"text"', 'c')).toBeNull()
  })

  it('never invents missing fields', () => {
    const parsed = parseConfidenceScore('{}', 'c')
    expect(parsed).toMatchObject({ overall: null, aspects: {}, flags: [] })
  })

  it('ignores non-numeric overall and non-string flags', () => {
    const parsed = parseConfidenceScore(JSON.stringify({ overall: 'high', flags: [1, 'real'] }), 'c')
    expect(parsed?.overall).toBeNull()
    expect(parsed?.flags).toEqual(['real'])
  })

  it('drops the raw payload when it exceeds the cap', () => {
    const big = JSON.stringify({ overall: 50, notes: 'x'.repeat(CONFIDENCE_RAW_CAP) })
    expect(parseConfidenceScore(big, 'c')).toMatchObject({ overall: 50, raw: null })
  })
})

describe('harvestDeliveryEvidence', () => {
  const scorePath = '/wt/a/openspec/changes/my-change/confidence-score.json'
  const io = (over: Partial<EvidenceHarvestIO> = {}): EvidenceHarvestIO => ({
    readEvents: () => [step(1, 'verify'), assistant('VERIFICATION: PASS')],
    listDir: () => ['my-change'],
    fileExists: (p) => p === scorePath,
    readFile: () => JSON.stringify({ overall: 88, aspects: { security: 80 }, flags: [] }),
    now: () => new Date('2026-07-27T12:00:00.000Z'),
    ...over,
  })

  it('harvests sentinel, tail and confidence score per unit', () => {
    const out = harvestDeliveryEvidence(io(), [{ ticketId: 7, runId: 'run-1', worktreePath: '/wt/a' }])
    expect(out.harvest).toBe('ok')
    expect(out.harvestedAt).toBe('2026-07-27T12:00:00.000Z')
    expect(out.units).toHaveLength(1)
    expect(out.units[0]).toMatchObject({ ticketId: 7, runId: 'run-1', sentinel: 'pass' })
    expect(out.units[0].verifyTail).toContain('VERIFICATION: PASS')
    expect(out.units[0].confidence).toMatchObject({ changeName: 'my-change', overall: 88 })
  })

  it('absence of every source is still `ok` (absence is honest data)', () => {
    const out = harvestDeliveryEvidence(
      io({ readEvents: () => [], fileExists: () => false }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' }],
    )
    expect(out.harvest).toBe('ok')
    expect(out.units[0]).toMatchObject({ sentinel: 'absent', verifyTail: null, confidence: null })
  })

  it('a missing worktree path skips the score without erroring', () => {
    const out = harvestDeliveryEvidence(io(), [{ ticketId: 1, runId: 'run-1', worktreePath: null }])
    expect(out.harvest).toBe('ok')
    expect(out.units[0].confidence).toBeNull()
    expect(out.units[0].sentinel).toBe('pass')
  })

  it('a missing runId skips the sentinel without erroring', () => {
    const out = harvestDeliveryEvidence(io(), [{ ticketId: 1, runId: null, worktreePath: '/wt/a' }])
    expect(out.units[0].sentinel).toBe('absent')
    expect(out.units[0].confidence).not.toBeNull()
  })

  it('malformed confidence JSON degrades to null, not a throw', () => {
    const out = harvestDeliveryEvidence(
      io({ readFile: () => '{broken' }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' }],
    )
    expect(out.harvest).toBe('ok')
    expect(out.units[0].confidence).toBeNull()
  })

  it('a throwing event reader marks the harvest partial and keeps the other source', () => {
    const out = harvestDeliveryEvidence(
      io({ readEvents: () => { throw new Error('db gone') } }),
      [
        { ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' },
        { ticketId: 2, runId: null, worktreePath: '/wt/a' },
      ],
    )
    expect(out.harvest).toBe('partial')
    expect(out.units[0].sentinel).toBe('absent')
    expect(out.units[0].confidence).not.toBeNull()
  })

  it('marks failed only when every unit errored', () => {
    const out = harvestDeliveryEvidence(
      io({ readEvents: () => { throw new Error('boom') } }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' }],
    )
    expect(out.harvest).toBe('failed')
  })

  it('an unreadable changes dir degrades to no score', () => {
    const out = harvestDeliveryEvidence(
      io({ listDir: () => { throw new Error('ENOENT') } }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' }],
    )
    expect(out.harvest).toBe('ok')
    expect(out.units[0].confidence).toBeNull()
  })

  it('picks deterministically when several change dirs carry a score', () => {
    const out = harvestDeliveryEvidence(
      io({
        listDir: () => ['b-change', 'a-change'],
        fileExists: () => true,
        readFile: (p) => JSON.stringify({ overall: p.includes('b-change') ? 60 : 20 }),
      }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: '/wt/a' }],
    )
    expect(out.units[0].confidence).toMatchObject({ changeName: 'b-change', overall: 60 })
  })

  it('bounds the verify tail', () => {
    const long = `${'y'.repeat(VERIFY_TAIL_CAP * 2)}\nVERIFICATION: PASS`
    const out = harvestDeliveryEvidence(
      io({ readEvents: () => [assistant(long)] }),
      [{ ticketId: 1, runId: 'run-1', worktreePath: null }],
    )
    expect(out.units[0].verifyTail).toHaveLength(VERIFY_TAIL_CAP)
    expect(out.units[0].verifyTail?.endsWith('VERIFICATION: PASS')).toBe(true)
  })

  it('an empty unit list is ok, not failed', () => {
    expect(harvestDeliveryEvidence(io(), []).harvest).toBe('ok')
  })
})

describe('readSettleEvidence', () => {
  it('round-trips a harvested record', () => {
    const harvested = harvestDeliveryEvidence(
      { readEvents: () => [assistant('VERIFICATION: PASS')] },
      [{ ticketId: 1, runId: 'run-1', worktreePath: null }],
    )
    expect(readSettleEvidence(JSON.stringify(harvested))).toEqual(harvested)
  })

  it('returns null for null/empty/malformed/shape-invalid values', () => {
    expect(readSettleEvidence(null)).toBeNull()
    expect(readSettleEvidence('')).toBeNull()
    expect(readSettleEvidence('{oops')).toBeNull()
    expect(readSettleEvidence('{"schemaVersion":1}')).toBeNull()
  })
})
