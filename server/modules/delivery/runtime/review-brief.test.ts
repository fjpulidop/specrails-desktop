import { describe, expect, it } from 'vitest'
import {
  buildWhatToLookAt,
  normalizeReviewBrief,
  parseReviewBriefRecord,
  reviewBriefFromReviewerOutput,
  summarizeReviewBriefs,
  type DeliveryReviewBriefRecord,
} from './review-brief'
import { readDeliveryRiskSummary } from './rail-pr-store'

const FULL_BRIEF = {
  behaviourChanges: [{ what: 'Retries stop after 3 attempts instead of 5', where: 'src/net/retry.ts:41', userVisible: true }],
  invariantsTouched: [{ invariant: 'Queue order is preserved per project', evidence: 'src/queue.ts:120-138', status: 'kept' }],
  untested: [{ path: 'src/net/retry.ts', why: 'No test exercises the timeout branch' }],
  risks: [
    { severity: 'low', area: 'ux', whatToLookAt: 'Copy changed', ref: 'src/ui.tsx:3' },
    { severity: 'high', area: 'data', whatToLookAt: 'Migration drops a default', ref: 'server/db/migrations.ts:1600' },
    { severity: 'medium', area: 'api', whatToLookAt: 'Response field renamed', ref: 'server/api.ts:12' },
  ],
  humanChecks: ['Confirm the new copy with the product owner'],
  divergences: [],
}

function briefRecord(over: Partial<DeliveryReviewBriefRecord> = {}): DeliveryReviewBriefRecord {
  return { source: 'pipeline', approved: true, score: 88, recordedAt: '2026-10-21T10:00:00.000Z', brief: normalizeReviewBrief(FULL_BRIEF)!.brief, diagnostic: null, droppedEntries: 0, ...over }
}

describe('normalizeReviewBrief', () => {
  it('keeps a full brief, orders risks high first and fills every list', () => {
    const out = normalizeReviewBrief(FULL_BRIEF)!
    expect(out.dropped).toBe(0)
    expect(out.brief.risks.map((risk) => risk.severity)).toEqual(['high', 'medium', 'low'])
    expect(out.brief.behaviourChanges[0]).toEqual({ what: 'Retries stop after 3 attempts instead of 5', where: 'src/net/retry.ts:41', userVisible: true })
    expect(out.brief.divergences).toEqual([])
  })

  it('accepts a partial brief: absent sections become empty lists', () => {
    const out = normalizeReviewBrief({ risks: [{ severity: 'medium', whatToLookAt: 'Check the lock' }] })!
    expect(out.brief).toEqual({ behaviourChanges: [], invariantsTouched: [], untested: [], risks: [{ severity: 'medium', area: null, whatToLookAt: 'Check the lock', ref: null }], humanChecks: [], divergences: [] })
  })

  it('drops and counts entries that break the contract instead of failing', () => {
    const out = normalizeReviewBrief({
      risks: [{ severity: 'critical', whatToLookAt: 'x' }, { severity: 'high', whatToLookAt: '  ' }, 'nope', { severity: 'high', whatToLookAt: 'ok' }],
      humanChecks: ['', 'Check it', 42],
      untested: 'not a list',
    })!
    expect(out.brief.risks).toHaveLength(1)
    expect(out.brief.humanChecks).toEqual(['Check it'])
    expect(out.dropped).toBe(6)
  })

  it('caps risks at five and returns null for non-objects', () => {
    const risks = Array.from({ length: 8 }, (_, i) => ({ severity: 'low', whatToLookAt: `r${i}` }))
    expect(normalizeReviewBrief({ risks })!.brief.risks).toHaveLength(5)
    expect(normalizeReviewBrief([])).toBeNull()
    expect(normalizeReviewBrief('brief')).toBeNull()
  })
})

describe('parseReviewBriefRecord', () => {
  it('reads Core review-brief.json', () => {
    const record = parseReviewBriefRecord(JSON.stringify({ schemaVersion: 1, change: 'c', approved: false, score: 61, recordedAt: '2026-10-21T10:00:00Z', brief: FULL_BRIEF }))
    expect(record).toMatchObject({ source: 'pipeline', approved: false, score: 61, diagnostic: null, droppedEntries: 0 })
    expect(record.brief?.risks[0].severity).toBe('high')
  })

  it('keeps a verdict without a brief and Core diagnostics', () => {
    expect(parseReviewBriefRecord(JSON.stringify({ schemaVersion: 1, approved: true, score: 90, brief: null }))).toMatchObject({ brief: null, diagnostic: null })
    expect(parseReviewBriefRecord(JSON.stringify({ schemaVersion: 1, brief: null, diagnostic: 'Review brief dropped after the repair turn: x' })).diagnostic).toContain('dropped')
  })

  it('turns a malformed file into a diagnostic record, never a throw', () => {
    expect(parseReviewBriefRecord('{not json')).toMatchObject({ brief: null, diagnostic: expect.stringContaining('not valid JSON') })
    expect(parseReviewBriefRecord(JSON.stringify({ schemaVersion: 99, brief: FULL_BRIEF }))).toMatchObject({ brief: null, diagnostic: expect.stringContaining('schema version') })
    expect(parseReviewBriefRecord(JSON.stringify({ schemaVersion: 1, brief: 'text' }))).toMatchObject({ brief: null, diagnostic: expect.stringContaining('not an object') })
  })
})

describe('reviewBriefFromReviewerOutput', () => {
  it('is null for older reviewer outputs without a brief', () => {
    expect(reviewBriefFromReviewerOutput({ approved: true, score: 80 })).toBeNull()
    expect(reviewBriefFromReviewerOutput(null)).toBeNull()
  })
  it('reads brief and briefDiagnostic', () => {
    expect(reviewBriefFromReviewerOutput({ approved: true, score: 80, brief: FULL_BRIEF })).toMatchObject({ source: 'definition', approved: true, score: 80 })
    expect(reviewBriefFromReviewerOutput({ briefDiagnostic: 'dropped' })).toMatchObject({ brief: null, diagnostic: 'dropped' })
  })
})

describe('summaries', () => {
  it('summarizes across units with the top risk first', () => {
    const second = briefRecord({ brief: normalizeReviewBrief({ risks: [{ severity: 'high', whatToLookAt: 'Second', ref: 'b.ts:1' }] })!.brief })
    expect(summarizeReviewBriefs([briefRecord(), undefined, second])).toEqual({
      highCount: 2, mediumCount: 1, lowCount: 1, diagnostic: false,
      top: { severity: 'high', area: 'data', whatToLookAt: 'Migration drops a default', ref: 'server/db/migrations.ts:1600' },
    })
    expect(summarizeReviewBriefs([undefined, null])).toBeNull()
    expect(summarizeReviewBriefs([briefRecord({ brief: null, diagnostic: 'x' })])).toMatchObject({ top: null, diagnostic: true })
  })

  it('reads the risk summary from a persisted settle_evidence column', () => {
    const evidence = { schemaVersion: 1, harvest: 'ok', harvestedAt: 'x', units: [{ ticketId: 1, runId: 'r', reviewBrief: briefRecord() }] }
    expect(readDeliveryRiskSummary(JSON.stringify(evidence))?.highCount).toBe(1)
    expect(readDeliveryRiskSummary(JSON.stringify({ ...evidence, units: [{ ticketId: 1 }] }))).toBeNull()
    expect(readDeliveryRiskSummary('{"reviewBrief": broken')).toBeNull()
    expect(readDeliveryRiskSummary(null)).toBeNull()
  })

  it('merges unit briefs in a fixed order and hides an empty result', () => {
    const merged = buildWhatToLookAt([
      { ticketId: 1, reviewBrief: briefRecord() },
      { ticketId: 2, reviewBrief: briefRecord({ brief: normalizeReviewBrief({ risks: [{ severity: 'high', whatToLookAt: 'Other' }] })!.brief, droppedEntries: 2 }) },
      { ticketId: 3 },
    ])!
    expect(merged.risks.map((risk) => [risk.ticketId, risk.severity])).toEqual([[1, 'high'], [2, 'high'], [1, 'medium'], [1, 'low']])
    expect(merged.humanChecks).toEqual([{ ticketId: 1, text: 'Confirm the new copy with the product owner' }])
    expect(merged.droppedEntries).toBe(2)
    expect(buildWhatToLookAt([{ ticketId: 1 }])).toBeNull()
    expect(buildWhatToLookAt([{ ticketId: 1, reviewBrief: briefRecord({ brief: normalizeReviewBrief({})!.brief }) }])).toBeNull()
    expect(buildWhatToLookAt([{ ticketId: 1, reviewBrief: briefRecord({ brief: null, diagnostic: 'dropped' }) }])).toMatchObject({ diagnostics: [{ ticketId: 1, message: 'dropped' }], risks: [] })
  })
})
