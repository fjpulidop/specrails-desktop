import { describe, it, expect } from 'vitest'
import {
  projectDefinitionRuntimeEvidence,
  healRuntimeEvidence,
  CONFIDENCE_RAW_CAP,
  VERIFY_TAIL_CAP,
  extractVerifyStepText,
  harvestDeliveryEvidence,
  parseConfidenceScore,
  parseVerificationSentinel,
  readSettleEvidence,
  type EvidenceHarvestIO,
} from './delivery-evidence'
import type { EventRow } from '../../../types'
import type { DefinitionRunProbe } from '../../loops/runtime/loop-definition-recovery'

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

/** A step payload written by a build that carries the ms-precision boundary. */
function stepAt(index: number, nodeId: string, startedAtMs: number, job_id = 'run-1'): EventRow {
  return ev('loop_step', JSON.stringify({ index, nodeId, kind: 'ai-step', title: nodeId, startedAtMs }), job_id)
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

  it('does not accept a format quoted in prose or a tool invocation as a verdict', () => {
    expect(parseVerificationSentinel('I will print VERIFICATION: PASS when tests finish').verdict).toBe('absent')
    expect(parseVerificationSentinel('🔧 shell echo "VERIFICATION: PASS"').verdict).toBe('absent')
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

  it('decodes persisted provider log envelopes into readable verification lines', () => {
    const text = extractVerifyStepText([
      step(1, 'verify'),
      ev('log', JSON.stringify({ line: 'Tests finished\nVERIFICATION: FAIL — auth regression' })),
      stepEnd(1, 'verify'),
    ]).text
    expect(text).toBe('Tests finished\nVERIFICATION: FAIL — auth regression')
    expect(parseVerificationSentinel(text)).toEqual({ verdict: 'fail', detail: 'auth regression' })
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
    readEvents: () => [step(1, 'verify'), assistant('VERIFICATION: PASS'), stepEnd(1, 'verify')],
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

  it.each(['failed', 'interrupted'])('does not promote a %s verification to PASS', (status) => {
    const events = [step(1, 'verify'), ev('log', JSON.stringify({ line: 'VERIFICATION: PASS' }))]
    if (status === 'failed') events.push(ev('loop_step_end', JSON.stringify({ index: 1, nodeId: 'verify', status: 'failed' })))
    const out = harvestDeliveryEvidence(io({ readEvents: () => events }), [
      { ticketId: 7, runId: 'run-1', worktreePath: null },
    ])
    expect(out.units[0].sentinel).toBe('absent')
    expect(out.units[0].verifyTail).toBe('VERIFICATION: PASS')
  })

  it('uses a completed repaired verification after an earlier failed pass', () => {
    const out = harvestDeliveryEvidence(io({ readEvents: () => [
      step(1, 'verify'), assistant('VERIFICATION: FAIL — regression'),
      ev('loop_step_end', JSON.stringify({ index: 1, nodeId: 'verify', status: 'failed' })),
      step(2, 'verify'), ev('log', JSON.stringify({ line: 'VERIFICATION: PASS' })), stepEnd(2, 'verify'),
    ] }), [{ ticketId: 7, runId: 'run-1', worktreePath: null }])
    expect(out.units[0].sentinel).toBe('pass')
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


describe('parseConfidenceScore — shipped reviewer schema', () => {
  it('accepts `overall_score`, the field the installed Codex reviewer actually writes', () => {
    const parsed = parseConfidenceScore(JSON.stringify({ overall_score: 91 }), 'c')
    expect(parsed?.overall).toBe(91)
  })

  it('prefers the documented `overall` when a payload carries both', () => {
    const parsed = parseConfidenceScore(JSON.stringify({ overall: 70, overall_score: 91 }), 'c')
    expect(parsed?.overall).toBe(70)
  })

  it('lifts `issues[].note` into flags alongside explicit flags, deduped', () => {
    const parsed = parseConfidenceScore(
      JSON.stringify({
        flags: ['missing-tests'],
        issues: [{ note: 'missing-tests' }, { note: '  no rollback path  ' }, { note: '' }, null, 'nope'],
      }),
      'c',
    )
    expect(parsed?.flags).toEqual(['missing-tests', 'no rollback path'])
  })

  it('reports no score rather than inventing one when neither field is numeric', () => {
    const parsed = parseConfidenceScore(JSON.stringify({ overall_score: 'high' }), 'c')
    expect(parsed?.overall).toBeNull()
  })
})

describe('extractVerifyStepText — verify epoch boundary', () => {
  it('returns the ms boundary carried by the verify step payload', () => {
    const out = extractVerifyStepText([stepAt(1, 'verify', 1_700_000_000_000), assistant('VERIFICATION: PASS')])
    expect(out.startedAtMs).toBe(1_700_000_000_000)
  })

  it('reports no boundary for legacy payloads that predate the field', () => {
    const out = extractVerifyStepText([step(1, 'verify'), assistant('VERIFICATION: PASS')])
    expect(out.startedAtMs).toBeNull()
  })

  it('takes the LAST verify epoch when the loop iterated', () => {
    const out = extractVerifyStepText([
      stepAt(1, 'verify', 1000),
      assistant('VERIFICATION: FAIL — first pass'),
      stepAt(2, 'fix', 2000),
      stepAt(3, 'verify', 3000),
      assistant('VERIFICATION: PASS'),
    ])
    expect(out.startedAtMs).toBe(3000)
    expect(out.text).toContain('VERIFICATION: PASS')
    expect(out.text).not.toContain('first pass')
  })
})

describe('harvestDeliveryEvidence — revision freshness gate', () => {
  const REVISION = 'factory:revision'
  const openSpecScore = '/wt/a/openspec/changes/my-change/confidence-score.json'
  const memoryDir = '/wt/a/.specrails/agent-memory/explanations'
  const memoryScore = `${memoryDir}/2026-07-28-reviewer-ticket-7.confidence-score.json`

  const revisionIo = (over: Partial<EvidenceHarvestIO> = {}): EvidenceHarvestIO => ({
    readEvents: () => [stepAt(1, 'verify', 5_000), assistant('VERIFICATION: PASS'), stepEnd(1, 'verify')],
    listDir: (dir) => (dir === memoryDir ? ['2026-07-28-reviewer-ticket-7.confidence-score.json'] : ['my-change']),
    fileExists: (p) => p === openSpecScore || p === memoryScore,
    fileMtimeMs: () => 6_000,
    readFile: () => JSON.stringify({ overall_score: 90 }),
    now: () => new Date('2026-07-28T12:00:00.000Z'),
    ...over,
  })

  const unit = { ticketId: 7, runId: 'run-1', worktreePath: '/wt/a', loopId: REVISION }

  it('accepts a score written during the latest verify epoch', () => {
    const out = harvestDeliveryEvidence(revisionIo(), [unit])
    expect(out.harvest).toBe('ok')
    expect(out.units[0].confidence?.overall).toBe(90)
  })

  it('rejects a score left by an earlier pass, so a fix cannot reuse a clean verdict', () => {
    const out = harvestDeliveryEvidence(revisionIo({ fileMtimeMs: () => 4_999 }), [unit])
    expect(out.units[0].confidence).toBeNull()
    // Absence is honest data, not a harvest failure.
    expect(out.harvest).toBe('ok')
  })

  it('fails closed when the run carries no high-resolution boundary', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({ readEvents: () => [step(1, 'verify'), assistant('VERIFICATION: PASS')] }),
      [unit],
    )
    expect(out.units[0].confidence).toBeNull()
  })

  it('finds the reviewer artifact in agent-memory when openspec holds none', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({ fileExists: (p) => p === memoryScore }),
      [unit],
    )
    expect(out.units[0].confidence?.overall).toBe(90)
  })

  it('ignores an agent-memory score belonging to a different ticket', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({
        listDir: (dir) => (dir === memoryDir ? ['2026-07-28-reviewer-ticket-99.confidence-score.json'] : []),
        fileExists: () => false,
      }),
      [unit],
    )
    expect(out.units[0].confidence).toBeNull()
  })

  it('ignores a file that only resembles the reviewer filename contract', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({
        listDir: (dir) => (dir === memoryDir ? ['reviewer-ticket-7.confidence-score.json.bak'] : []),
        fileExists: () => false,
      }),
      [unit],
    )
    expect(out.units[0].confidence).toBeNull()
  })

  it('picks the newest candidate, breaking mtime ties deterministically by path', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({
        fileMtimeMs: () => 6_000,
        readFile: (p) => JSON.stringify({ overall_score: p === memoryScore ? 42 : 88 }),
      }),
      [unit],
    )
    // Same mtime → the lexicographically greater path wins; openspec/… > .specrails/…
    expect(out.units[0].confidence?.overall).toBe(88)
  })

  it('leaves non-revision loops on the legacy read that needs no boundary', () => {
    const out = harvestDeliveryEvidence(
      revisionIo({ readEvents: () => [step(1, 'verify'), assistant('VERIFICATION: PASS')] }),
      [{ ...unit, loopId: 'factory:implement' }],
    )
    expect(out.units[0].confidence?.overall).toBe(90)
  })
})

describe('programmatic-runtime evidence (core-host pipeline dir)', () => {
  const dir = '/ws/.specrails/pipeline/run-9'
  const evidenceId = 'a'.repeat(64)
  const state = {
    verification: { commands: [{ evidenceId, label: 'npm test', outcome: 'passed', command: 'npm', args: ['test'] }, { label: 'lint', outcome: 'failed', command: 'npm', args: ['run', 'lint'] }] },
    acceptance: {
      checks: [
        { name: 'primary: npm test', status: 'passed', required: true, evidence: ['Verification receipt 8cfb: exit code 0'], scope: 'Core ran it', limitations: 'only tests' },
        { name: 'Contract Layer review', status: 'passed', required: false, evidence: ['repeatIntervalMs=120 used'], scope: 'static', limitations: null },
      ],
      findings: ['Faithful port.', 'All tasks traceable.'],
    },
  }
  const evidenceDoc = { document: { origin: ['host'], required: true, exitCode: 0, durationMs: 673, stdout: 'UI tests: 70 passed, 0 failed\n', stderr: '' } }
  const checkpoint = { state: { steps: { reviewer: { output: { approved: true, score: 92, summary: 'Reviewed read-only. Solid.', issues: [{ message: 'nit: naming' }, 'plain issue'], aspects: { security: 95, test_coverage: 85, bogus: 'x' } } } } } }
  const files: Record<string, unknown> = {
    [`${dir}/state.json`]: state,
    [`${dir}/verification/evidence/${evidenceId}.json`]: evidenceDoc,
    [`${dir}/agent-workflow/run-9/checkpoint.json`]: checkpoint,
  }
  const io = (over: Partial<EvidenceHarvestIO> = {}): EvidenceHarvestIO => ({
    readEvents: () => [],
    listDir: () => [],
    fileExists: (p) => p in files,
    readFile: (p) => JSON.stringify(files[p]),
    now: () => new Date('2026-09-19T00:00:00.000Z'),
    ...over,
  })

  it('reads host commands, checks, findings and the reviewer verdict; fills confidence from the verdict', () => {
    const out = harvestDeliveryEvidence(io(), [{ ticketId: 8, runId: 'run-9', worktreePath: null, runtimeDir: dir }])
    expect(out.harvest).toBe('ok')
    const unit = out.units[0]
    expect(unit.sentinel).toBe('absent')
    expect(unit.runtime?.commands).toEqual([
      { label: 'npm test', outcome: 'passed', exitCode: 0, durationMs: 673, required: true, hostRun: true, outputTail: 'UI tests: 70 passed, 0 failed' },
      { label: 'lint', outcome: 'failed', exitCode: null, durationMs: null, required: true, hostRun: false, outputTail: null },
    ])
    expect(unit.runtime?.checks.map((c) => [c.name, c.hostRun, c.status])).toEqual([['primary: npm test', true, 'passed'], ['Contract Layer review', false, 'passed']])
    expect(unit.runtime?.findings).toEqual(['Faithful port.', 'All tasks traceable.'])
    expect(unit.runtime?.review).toEqual({ approved: true, score: 92, aspects: { security: 95, test_coverage: 85 }, issues: ['nit: naming', 'plain issue'], summary: 'Reviewed read-only. Solid.' })
    expect(unit.confidence).toMatchObject({ overall: 92, aspects: { security: 95, test_coverage: 85 }, flags: ['nit: naming', 'plain issue'], changeName: null })
    // Round-trips through the persisted column.
    expect(readSettleEvidence(JSON.stringify(out))?.units[0].runtime?.review?.score).toBe(92)
  })

  it('keeps a file-based confidence score authoritative over the runtime verdict', () => {
    const scorePath = '/wt/a/openspec/changes/c/confidence-score.json'
    const out = harvestDeliveryEvidence(io({
      listDir: () => ['c'],
      fileExists: (p) => p in files || p === scorePath,
      readFile: (p) => (p === scorePath ? JSON.stringify({ overall: 40 }) : JSON.stringify(files[p])),
    }), [{ ticketId: 8, runId: 'run-9', worktreePath: '/wt/a', runtimeDir: dir }])
    expect(out.units[0].confidence?.overall).toBe(40)
    expect(out.units[0].runtime?.review?.score).toBe(92)
  })

  it('is absent for legacy runs (no state.json) and tolerant of malformed files', () => {
    const none = harvestDeliveryEvidence(io({ fileExists: () => false }), [{ ticketId: 8, runId: 'run-9', worktreePath: null, runtimeDir: dir }])
    expect(none.units[0].runtime).toBeUndefined()
    expect(none.harvest).toBe('ok')
    const broken = harvestDeliveryEvidence(io({ readFile: () => '{not json' }), [{ ticketId: 8, runId: 'run-9', worktreePath: null, runtimeDir: dir }])
    expect(broken.units[0].runtime).toBeUndefined()
    const thrower = harvestDeliveryEvidence(io({ readFile: () => { throw new Error('EACCES') } }), [{ ticketId: 8, runId: 'run-9', worktreePath: null, runtimeDir: dir }])
    expect(thrower.harvest).toBe('ok') // readJson swallows; nothing to report is not an error
    expect(thrower.units[0].runtime).toBeUndefined()
  })
})

describe('healRuntimeEvidence', () => {
  it('fills runtime + confidence for units that predate the harvest, leaves others untouched, null when nothing changes', async () => {
    const { healRuntimeEvidence } = await import('./delivery-evidence')
    const files: Record<string, unknown> = {
      '/ws/pipeline/run-1/state.json': { verification: { commands: [{ label: 'npm test', outcome: 'passed' }] }, acceptance: { checks: [], findings: [] } },
      '/ws/pipeline/run-1/agent-workflow/run-1/checkpoint.json': { state: { steps: { reviewer: { output: { approved: true, score: 77, aspects: {}, issues: [], summary: 's' } } } } },
    }
    const fsIo = { fileExists: (p: string) => p in files, readFile: (p: string) => JSON.stringify(files[p]) }
    const base = { schemaVersion: 1 as const, harvest: 'ok' as const, harvestedAt: 'x', units: [
      { ticketId: 1, runId: 'run-1', sentinel: 'absent' as const, sentinelDetail: null, verifyTail: null, confidence: null },
      { ticketId: 2, runId: 'run-2', sentinel: 'absent' as const, sentinelDetail: null, verifyTail: null, confidence: null },
      { ticketId: 3, runId: 'run-3', sentinel: 'pass' as const, sentinelDetail: null, verifyTail: null, confidence: null, runtime: null },
    ] }
    const healed = healRuntimeEvidence(base, '/ws/pipeline', fsIo)
    expect(healed?.units[0].runtime?.commands[0].label).toBe('npm test')
    expect(healed?.units[0].confidence?.overall).toBe(77)
    expect(healed?.units[1].runtime).toBeUndefined()
    expect(healed?.units[2]).toBe(base.units[2])
    expect(healRuntimeEvidence(healed!, '/ws/pipeline', fsIo)).toBeNull()
    expect(healRuntimeEvidence(base, '/nowhere', { fileExists: () => false, readFile: () => '' })).toBeNull()
  })
})

function definitionProbe(scopes: NonNullable<DefinitionRunProbe['scopes']>): DefinitionRunProbe {
  return { runId: 'run-1', engineVersion: 2, status: 'succeeded', resumable: false, lease: null,
    pendingInterrupts: [], recoverableSteps: [], completion: { ok: true, verified: true, reasons: [] },
    coreRevision: 10, eventCursor: 20, probedAt: new Date().toISOString(), scopes }
}
const scopedReview = { nodePath: 'implement', scopeId: 'root', kind: 'implementation', status: 'succeeded', attemptId: 'a1', output: { review: { approved: true, score: 88, aspects: { correctness: 90 }, issues: [] } } }

describe('Core definition delivery evidence', () => {
  it('projects confirmed verification commands and implementation review without inventing durations or output', () => {
    const probe = definitionProbe([scopedReview, { nodePath: 'verify', scopeId: 'root', kind: 'verify', status: 'failed', attemptId: 'a2', output: { receiptId: 'receipt', commands: [{ command: 'npm test', exitCode: 1 }] } }])
    expect(projectDefinitionRuntimeEvidence(probe)).toMatchObject({ review: { approved: true, score: 88 }, commands: [{ label: 'npm test', exitCode: 1, outcome: 'failed', hostRun: true, durationMs: null, outputTail: null }] })
  })
  it('does not collapse parallel reviewers or reuse an unfinished current attempt', () => {
    expect(projectDefinitionRuntimeEvidence(definitionProbe([scopedReview, { ...scopedReview, scopeId: 'branch-2', attemptId: 'a2' }]))).toMatchObject({ review: null, findings: [expect.stringContaining('Multiple scoped')], scopedReviews: [{ scopeId: 'root', attemptId: 'a1' }, { scopeId: 'branch-2', attemptId: 'a2' }] })
    expect(projectDefinitionRuntimeEvidence(definitionProbe([{ ...scopedReview, status: 'running' }]))).toBeNull()
    expect(projectDefinitionRuntimeEvidence({ ...definitionProbe([scopedReview]), status: 'unavailable' })).toBeNull()
  })
  it('requires an explicit reviewer node for structured custom-role output', () => {
    const probe = definitionProbe([{ ...scopedReview, nodePath: 'custom-review', kind: 'role-turn', output: { structured: { approved: false, score: 55 } } }])
    expect(projectDefinitionRuntimeEvidence(probe)).toBeNull()
    expect(projectDefinitionRuntimeEvidence(probe, 'custom-review')).toMatchObject({ review: { approved: false, score: 55 } })
  })
  it('persists the exact reviewer selection for recovery without choosing a similarly named node', () => {
    const probe = definitionProbe([
      { ...scopedReview, nodePath: 'left/audit', kind: 'role-turn', output: { structured: { approved: false, score: 55 } } },
      { ...scopedReview, nodePath: 'right/audit', kind: 'role-turn', output: { structured: { approved: true, score: 99 } } },
    ])
    const unit = { ticketId: 1, runId: 'run-1', worktreePath: null, reviewerStepId: 'left/audit' }
    const harvested = harvestDeliveryEvidence({ readEvents: () => [] }, [{ ...unit, definitionStatus: probe }])
    expect(readSettleEvidence(JSON.stringify(harvested))?.units[0]).toMatchObject({ reviewerStepId: 'left/audit', confidence: { overall: 55 }, runtime: { review: { approved: false } } })
    const pending = harvestDeliveryEvidence({ readEvents: () => [] }, [unit])
    const healed = healRuntimeEvidence(readSettleEvidence(JSON.stringify(pending))!, '/unused', { readFile: () => { throw new Error('No legacy evidence') } }, new Map([['run-1', probe]]))
    expect(healed?.units[0]).toMatchObject({ reviewerStepId: 'left/audit', confidence: { overall: 55 }, runtime: { review: { approved: false } } })
  })
  it('uses Core evidence without reading legacy checkpoint files and reports unavailable inspection honestly', () => {
    const io: EvidenceHarvestIO = { readEvents: () => [], fileExists: () => false, readFile: () => { throw new Error('Legacy checkpoint should not be read') } }
    const unit = { ticketId: 1, runId: 'run-1', worktreePath: null, runtimeDir: '/legacy', definitionStatus: definitionProbe([scopedReview]) }
    expect(harvestDeliveryEvidence(io, [unit])).toMatchObject({ harvest: 'ok', units: [{ runtime: { review: { score: 88 } }, confidence: { overall: 88 } }] })
    expect(harvestDeliveryEvidence(io, [{ ...unit, definitionStatus: { ...unit.definitionStatus, status: 'unavailable' } }])).toMatchObject({ harvest: 'failed', units: [{ confidence: null }] })
  })
})

it('heals missing definition evidence through retained status and never falls back to an implementation journal', () => {
  const base = harvestDeliveryEvidence({ readEvents: () => [] }, [{ ticketId: 1, runId: 'run-1', worktreePath: null }])
  const readFile = () => { throw new Error('No legacy reads for definition runs') }
  const healed = healRuntimeEvidence(base, '/legacy', { readFile }, new Map([['run-1', definitionProbe([scopedReview])]]))
  expect(healed?.units[0]).toMatchObject({ runtime: { review: { score: 88 } }, confidence: { overall: 88 } })
  expect(healRuntimeEvidence(base, '/legacy', { readFile }, new Map([['run-1', { ...definitionProbe([]), status: 'unavailable' }]]))).toBeNull()
  const withFileConfidence = { ...base, units: [{ ...base.units[0], confidence: { changeName: 'change', overall: 91, aspects: {}, flags: [], raw: {} } }] }
  expect(healRuntimeEvidence(withFileConfidence, '/legacy', { readFile }, new Map([['run-1', definitionProbe([scopedReview])]]))?.units[0].confidence?.overall).toBe(91)
})
