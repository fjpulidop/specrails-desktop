import { describe, it, expect, beforeEach } from 'vitest'
import { initDb, type DbInstance } from './db'
import { createPrDelivery, getPrDelivery, transitionDecision, type DeliverBranchRecord } from './rail-pr-store'
import type { DeliverySettleEvidence } from './delivery-evidence'
import {
  DRIFT_REVISION_COUNT,
  HUMAN_REVIEW_BAND,
  composeReviewPacket,
  computeDriftNudges,
  packetHasUnsourcedNumericClaim,
  selectVariant,
  type PacketVersion,
} from './review-packet'

let db: DbInstance
beforeEach(() => { db = initDb(':memory:') })

const SPEC = (id: number, title: string) => ({
  ticketId: id,
  title,
  description: `We cannot log in today.\n\nAdd a login form with validation.`,
  labels: ['auth'],
})

function unit(over: Partial<DeliverBranchRecord> = {}): DeliverBranchRecord {
  return {
    ticketId: 1, branch: 'feat/1-login', succeeded: true, runId: 'run-1',
    implementationOutcome: 'succeeded', deliveryOutcome: 'ready',
    initialSha: 'a'.repeat(40), finalSha: 'b'.repeat(40), changed: true,
    failureCode: null, branchOwnership: 'created', worktreePath: '/wt/1',
    ...over,
  }
}

function evidence(over: Partial<DeliverySettleEvidence['units'][number]> = {}, harvest: DeliverySettleEvidence['harvest'] = 'ok'): DeliverySettleEvidence {
  return {
    schemaVersion: 1,
    harvest,
    harvestedAt: '2026-07-27T12:00:00.000Z',
    units: [{
      ticketId: 1, runId: 'run-1', sentinel: 'pass', sentinelDetail: null,
      verifyTail: 'ran the suite\nVERIFICATION: PASS', confidence: null,
      ...over,
    }],
  }
}

function churn(rows: Array<{ path: string; added?: number; removed?: number; runId?: string; repositoryId?: string }>): void {
  for (const row of rows) {
    const id = db.prepare('INSERT INTO file_provenance(file_path, job_id, kind, at, repository_id) VALUES (?, ?, ?, ?, ?)')
      .run(row.path, row.runId ?? 'run-1', 'modified', 1, row.repositoryId ?? null).lastInsertRowid
    db.prepare(`
      INSERT INTO file_story_contributions (provenance_id, job_id, file_path, added_lines, removed_lines)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, row.runId ?? 'run-1', row.path, row.added ?? 10, row.removed ?? 2)
  }
}

function delivery(over: {
  ticketIds?: number[]
  units?: DeliverBranchRecord[]
  runIds?: string[]
  snapshot?: Array<ReturnType<typeof SPEC>>
  evidence?: DeliverySettleEvidence | null
  decision?: 'on_review' | 'no_changes' | 'implementation_failed' | 'pr_draft'
  implementationOutcome?: 'succeeded' | 'failed' | 'partially_succeeded'
  deliveryOutcome?: 'ready' | 'no_changes' | 'partial' | 'not_started'
  statusCode?: string | null
} = {}) {
  const ticketIds = over.ticketIds ?? [1]
  createPrDelivery(db, {
    id: 'del-1', railIndex: 0, loopId: 'factory:implement', railKey: '0-factory:implement',
    ticketIds, baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    specSnapshot: over.snapshot ?? ticketIds.map((id) => SPEC(id, `Ticket ${id}`)),
  })
  transitionDecision(db, 'del-1', 'building', over.decision ?? 'on_review', {
    branches: over.units ?? [unit()],
    runIds: over.runIds ?? ['run-1'],
    implementationOutcome: over.implementationOutcome ?? 'succeeded',
    deliveryOutcome: over.deliveryOutcome ?? 'ready',
    statusCode: (over.statusCode ?? 'ready_for_review') as never,
    ...(over.evidence === undefined ? { settleEvidence: evidence() } : over.evidence === null ? {} : { settleEvidence: over.evidence }),
  })
  return composeReviewPacket({ db, row: getPrDelivery(db, 'del-1')! })
}

describe('selectVariant', () => {
  const row = (over: Record<string, unknown>) => ({
    decision: 'on_review', implementation_outcome: 'succeeded', delivery_outcome: 'ready', status_code: null,
    ...over,
  }) as never

  it('no-changes wins over success', () => {
    expect(selectVariant(row({ delivery_outcome: 'no_changes' }), [])).toBe('no-changes')
    expect(selectVariant(row({ decision: 'no_changes' }), [])).toBe('no-changes')
    expect(selectVariant(row({ status_code: 'no_changes' }), [])).toBe('no-changes')
  })

  it('failed implementation is failed', () => {
    expect(selectVariant(row({ implementation_outcome: 'failed' }), [])).toBe('failed')
    expect(selectVariant(row({ decision: 'implementation_failed' }), [])).toBe('failed')
  })

  it('a mixed batch is partial, never success', () => {
    const units = [unit(), unit({ ticketId: 2, succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started' })]
    expect(selectVariant(row({}), units)).toBe('partial')
  })

  it('honours an explicit partially_succeeded outcome', () => {
    expect(selectVariant(row({ implementation_outcome: 'partially_succeeded' }), [])).toBe('partial')
  })

  it('a clean single-ticket delivery is success', () => {
    expect(selectVariant(row({}), [unit()])).toBe('success')
  })
})

describe('composeReviewPacket — success variant', () => {
  it('counts same-path files in different repositories separately for a shared coordinator run', () => {
    churn([{ path: 'src/index.ts', repositoryId: 'app', added: 3 }, { path: 'src/index.ts', repositoryId: 'api', added: 7 }])
    const packet = delivery()
    expect(packet.proof.find(proof => proof.code === 'proof.filesChanged')?.values).toMatchObject({ files: 2, added: 10 })
    expect(packet.sections[0].churn?.filesTouched).toBe(2)
    const api = composeReviewPacket({ db, row: getPrDelivery(db, 'del-1')!, repositoryId: 'api' })
    expect(api.repositoryId).toBe('api')
    expect(api.proof.find(proof => proof.code === 'proof.filesChanged')?.values).toMatchObject({ files: 1, added: 7 })
    expect(api.sections[0].churn?.filesTouched).toBe(1)
  })

  it('includes historical primary churn only on an explicit primary legacy scope', () => {
    churn([{ path: 'legacy.ts', added: 11 }, { path: 'src/index.ts', repositoryId: 'api', added: 7 }])
    delivery()
    const row = getPrDelivery(db, 'del-1')!
    const noLegacy = composeReviewPacket({ db, row, repositoryId: 'app' })
    expect(noLegacy.proof.some(proof => proof.code === 'proof.filesChanged')).toBe(false)
    const primary = composeReviewPacket({ db, row, repositoryId: 'app', includeLegacyProvenance: true })
    expect(primary.proof.find(proof => proof.code === 'proof.filesChanged')?.values).toMatchObject({ files: 1, added: 11 })
    const api = composeReviewPacket({ db, row: { ...row, repository_id: 'api' } })
    expect(api.proof.find(proof => proof.code === 'proof.filesChanged')?.values).toMatchObject({ files: 1, added: 7 })
  })

  it('renders what was asked from the LAUNCH snapshot', () => {
    churn([{ path: 'src/auth.ts' }, { path: 'src/auth.test.ts' }])
    const packet = delivery()
    expect(packet.variant).toBe('success')
    expect(packet.headlineCode).toBe('headline.success')
    expect(packet.sections).toHaveLength(1)
    expect(packet.sections[0]).toMatchObject({ ticketId: 1, title: 'Ticket 1', labels: ['auth'] })
    expect(packet.sections[0].problem).toContain('cannot log in')
    expect(packet.sections[0].solution).toContain('login form')
  })

  it('is reproducible from rows alone and spends nothing', () => {
    churn([{ path: 'src/auth.ts' }])
    const first = delivery()
    const second = composeReviewPacket({ db, row: getPrDelivery(db, 'del-1')! })
    expect(second).toEqual(first)
    expect(db.prepare('SELECT COUNT(*) AS n FROM ai_invocations').get()).toEqual({ n: 0 })
  })

  it('attributes churn per run for a single-ticket delivery', () => {
    churn([{ path: 'src/auth.ts', added: 40, removed: 5 }, { path: 'src/auth.test.ts', added: 20, removed: 0 }])
    const packet = delivery()
    expect(packet.sections[0].churn).toEqual({
      filesTouched: 2, addedLines: 60, removedLines: 5, testFilesTouched: ['src/auth.test.ts'],
    })
  })
})

describe('composeReviewPacket — proof tiers', () => {
  it('separates measured facts from the agent report and the reviewer score', () => {
    churn([{ path: 'src/auth.ts' }, { path: 'src/auth.test.ts' }])
    const packet = delivery({
      evidence: evidence({
        confidence: { changeName: 'add-login', overall: 88, aspects: { security: 80 }, flags: [], raw: null },
      }),
    })
    const byTier = (tier: string) => packet.proof.filter((item) => item.tier === tier).map((item) => item.code)
    expect(byTier('app-verified')).toContain('proof.filesChanged')
    expect(byTier('app-verified')).toContain('proof.testFilesChanged')
    expect(byTier('ai-reported')).toContain('proof.verificationPassed')
    expect(byTier('reviewer-score')).toContain('proof.reviewerScore')
    expect(byTier('reviewer-score')).toContain('proof.reviewerAspect')
  })

  it('states the honest negative when no test file changed', () => {
    churn([{ path: 'src/auth.ts' }])
    const packet = delivery()
    expect(packet.proof.map((item) => item.code)).toContain('proof.noTestFilesChanged')
    expect(packet.proof.map((item) => item.code)).not.toContain('proof.testFilesChanged')
  })

  it('leads with a reported FAILURE before any pass', () => {
    const packet = delivery({
      evidence: {
        schemaVersion: 1, harvest: 'ok', harvestedAt: 'now',
        units: [
          { ticketId: 1, runId: 'run-1', sentinel: 'pass', sentinelDetail: null, verifyTail: null, confidence: null },
          { ticketId: 2, runId: 'run-2', sentinel: 'fail', sentinelDetail: 'typecheck broke', verifyTail: null, confidence: null },
        ],
      },
      ticketIds: [1, 2],
      units: [unit(), unit({ ticketId: 2, runId: 'run-2', branch: 'feat/2' })],
      runIds: ['run-1', 'run-2'],
    })
    const aiCodes = packet.proof.filter((item) => item.tier === 'ai-reported').map((item) => item.code)
    expect(aiCodes.indexOf('proof.verificationFailed')).toBeLessThan(aiCodes.indexOf('proof.verificationPassed'))
    expect(packet.proof.find((item) => item.code === 'proof.verificationFailed')?.rawExcerpt).toBe('typecheck broke')
  })

  it('says so when the agent reported no verification at all', () => {
    const packet = delivery({ evidence: evidence({ sentinel: 'absent', verifyTail: null }) })
    expect(packet.proof.map((item) => item.code)).toContain('proof.noVerificationReported')
  })

  it('marks the reviewer score unavailable rather than omitting the tier', () => {
    const packet = delivery()
    expect(packet.proof.map((item) => item.code)).toContain('proof.reviewerScoreUnavailable')
    expect(packet.confidence).toBeNull()
  })

  it('never emits a numeric verification claim without a structured source', () => {
    churn([{ path: 'src/auth.ts' }])
    const packet = delivery({
      evidence: evidence({ verifyTail: 'Test Files 263 passed\nTests 6818 passed\nVERIFICATION: PASS' }),
    })
    expect(packetHasUnsourcedNumericClaim(packet)).toBe(false)
    // The prose IS carried, but only inside a labelled raw excerpt.
    const output = packet.proof.find((item) => item.code === 'proof.verifyOutput')
    expect(output?.tier).toBe('ai-reported')
    expect(output?.rawExcerpt).toContain('6818 passed')
    expect(output?.values).toBeUndefined()
  })

  // One active generation per rail is a durable invariant (partial unique
  // index), so each case needs its own fresh database.
  it('flags evidence as unavailable when the harvest failed outright', () => {
    expect(delivery({ evidence: evidence({}, 'failed') }).evidenceUnavailable).toBe(true)
  })

  it('flags evidence as unavailable when nothing was harvested at all', () => {
    expect(delivery({ evidence: null }).evidenceUnavailable).toBe(true)
  })

  it('does not flag evidence as unavailable on a clean harvest', () => {
    expect(delivery().evidenceUnavailable).toBe(false)
  })
})

describe('composeReviewPacket — watch out', () => {
  it('surfaces the documented human-review band', () => {
    const packet = delivery({
      evidence: evidence({
        confidence: { changeName: 'c', overall: HUMAN_REVIEW_BAND.min, aspects: {}, flags: [], raw: null },
      }),
    })
    expect(packet.watchOut.map((item) => item.code)).toContain('watch.humanReviewRecommended')
  })

  it('calls out a low score separately from the band', () => {
    const packet = delivery({
      evidence: evidence({ confidence: { changeName: 'c', overall: 20, aspects: {}, flags: [], raw: null } }),
    })
    expect(packet.watchOut.map((item) => item.code)).toContain('watch.lowConfidence')
  })

  it('carries reviewer flags verbatim, capped at three items overall', () => {
    const packet = delivery({
      evidence: evidence({
        confidence: {
          changeName: 'c', overall: 95, aspects: {},
          flags: ['f1', 'f2', 'f3', 'f4', 'f5'], raw: null,
        },
      }),
    })
    expect(packet.watchOut).toHaveLength(3)
    expect(packet.watchOut.map((item) => item.rawExcerpt)).toEqual(['f1', 'f2', 'f3'])
  })

  it('warns when code changed with no test file touched', () => {
    churn([{ path: 'src/auth.ts' }, { path: 'src/session.ts' }])
    const packet = delivery()
    expect(packet.watchOut.map((item) => item.code)).toContain('watch.noTestsForChangedCode')
  })

  it('stays silent when there is nothing real to warn about', () => {
    churn([{ path: 'src/auth.ts' }, { path: 'src/auth.test.ts' }])
    const packet = delivery({
      evidence: evidence({ confidence: { changeName: 'c', overall: 96, aspects: {}, flags: [], raw: null } }),
    })
    expect(packet.watchOut).toEqual([])
  })

  it('does not warn about missing tests on a no-change run', () => {
    const packet = delivery({ decision: 'no_changes', deliveryOutcome: 'no_changes', statusCode: 'no_changes' })
    expect(packet.watchOut.map((item) => item.code)).not.toContain('watch.noTestsForChangedCode')
  })
})

describe('composeReviewPacket — other variants', () => {
  it('no-changes packet does not imply changes', () => {
    const packet = delivery({ decision: 'no_changes', deliveryOutcome: 'no_changes', statusCode: 'no_changes' })
    expect(packet.variant).toBe('no-changes')
    expect(packet.headlineCode).toBe('headline.noChanges')
  })

  it('failed packet reports zero succeeded and a failed headline', () => {
    const packet = delivery({
      decision: 'implementation_failed',
      implementationOutcome: 'failed',
      deliveryOutcome: 'not_started',
      statusCode: 'implementation_failed',
      units: [unit({ succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started', changed: false, finalSha: null })],
    })
    expect(packet.variant).toBe('failed')
    expect(packet.headlineCode).toBe('headline.failed')
    expect(packet.succeededCount).toBe(0)
    expect(packet.failedCount).toBe(1)
  })

  it('partial packet counts both sides and keeps one section per ticket', () => {
    const packet = delivery({
      ticketIds: [1, 2],
      units: [unit(), unit({ ticketId: 2, runId: 'run-2', branch: 'feat/2', succeeded: false, implementationOutcome: 'failed', deliveryOutcome: 'not_started' })],
      runIds: ['run-1', 'run-2'],
      implementationOutcome: 'partially_succeeded',
      deliveryOutcome: 'partial',
      statusCode: 'partial_success',
    })
    expect(packet.variant).toBe('partial')
    expect(packet.headlineCode).toBe('headline.partial')
    expect(packet.succeededCount).toBe(1)
    expect(packet.failedCount).toBe(1)
    expect(packet.sections.map((s) => s.ticketId)).toEqual([1, 2])
  })

  it('a many-ticket success uses the plural headline', () => {
    const packet = delivery({
      ticketIds: [1, 2],
      units: [unit(), unit({ ticketId: 2, runId: 'run-2', branch: 'feat/2' })],
      runIds: ['run-1', 'run-2'],
    })
    expect(packet.headlineCode).toBe('headline.successMany')
  })
})

describe('composeReviewPacket — batch attribution honesty', () => {
  it('reports null per-ticket churn when one run covered several tickets', () => {
    churn([{ path: 'src/a.ts' }, { path: 'src/b.ts' }])
    const packet = delivery({
      ticketIds: [1, 2],
      // One batch run collapsed into a single checkout → same runId for both.
      units: [unit(), unit({ ticketId: 2 })],
      runIds: ['run-1'],
    })
    expect(packet.sections.every((section) => section.churn === null)).toBe(true)
    // The delivery-level proof still carries the real totals.
    expect(packet.proof.find((item) => item.code === 'proof.filesChanged')?.values).toMatchObject({ files: 2 })
  })
})

describe('composeReviewPacket — cost and degradation', () => {
  it('reports null cost until invocations exist', () => {
    expect(delivery().cost).toEqual({ totalUsd: null, estimated: false })
  })

  it('sums real invocation cost and marks estimation', () => {
    db.prepare(`
      INSERT INTO ai_invocations (id, project_id, surface, surface_ref_id, status, started_at, total_cost_usd, total_cost_usd_estimated)
      VALUES ('i1', 'p', 'loop', 'run-1', 'completed', datetime('now'), 1.25, 0),
             ('i2', 'p', 'loop', 'run-1', 'completed', datetime('now'), 0.75, 1)
    `).run()
    const packet = delivery()
    expect(packet.cost.totalUsd).toBeCloseTo(2.0, 5)
    expect(packet.cost.estimated).toBe(true)
  })

  it('survives malformed JSON columns without throwing', () => {
    delivery()
    db.prepare(`UPDATE rail_pr_deliveries SET branches = '{oops', run_ids = 'nope', ticket_ids = '{' WHERE id = 'del-1'`).run()
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, 'del-1')! })
    expect(packet.ticketIds).toEqual([])
    expect(packet.sections).toEqual([])
    expect(packet.runIds).toEqual([])
  })

  it('a legacy row with no snapshot renders bare sections rather than failing', () => {
    createPrDelivery(db, {
      id: 'del-legacy', railIndex: 1, loopId: 'l', railKey: '1-l', ticketIds: [7],
      baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
    })
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, 'del-legacy')! })
    expect(packet.sections[0]).toMatchObject({ ticketId: 7, title: null, problem: null, solution: null, labels: [] })
    expect(packet.evidenceUnavailable).toBe(true)
  })

  it('carries the lineage pointer for the version chain', () => {
    const packet = delivery()
    expect(packet.supersedesDeliveryId).toBeNull()
    expect(packet.prDeliveryId).toBe('del-1')
    expect(packet.railIndex).toBe(0)
    expect(packet.baseBranch).toBe('main')
    expect(packet.loopName).toBe('Implement')
  })
})

describe('composeReviewPacket — version lineage', () => {
  /** Build a chain of generations linked by revision_of, oldest first. */
  function chain(notes: Array<string | null>): string[] {
    const ids: string[] = []
    notes.forEach((note, index) => {
      const id = `del-${index + 1}`
      createPrDelivery(db, {
        id, railIndex: index, loopId: 'l', railKey: `${index}-l`, ticketIds: [1],
        baseBranch: 'main', loopName: 'Implement', originSurface: 'dashboard',
        ...(note ? { revisionNote: note, revisionOf: ids[index - 1] } : {}),
      })
      transitionDecision(db, id, 'building', 'on_review', {
        branches: [unit()], runIds: [`run-${index + 1}`],
        implementationOutcome: 'succeeded', deliveryOutcome: 'ready', statusCode: 'ready_for_review',
      })
      ids.push(id)
    })
    return ids
  }

  function cost(runId: string, usd: number, estimated = false): void {
    db.prepare(`
      INSERT INTO ai_invocations (id, project_id, surface, surface_ref_id, status, started_at, total_cost_usd, total_cost_usd_estimated)
      VALUES (?, 'p', 'loop', ?, 'completed', datetime('now'), ?, ?)
    `).run(`inv-${runId}-${usd}`, runId, usd, estimated ? 1 : 0)
  }

  it('reports a single version for an unrevised delivery', () => {
    const [id] = chain([null])
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, id)! })
    expect(packet.versions).toHaveLength(1)
    expect(packet.versions[0]).toMatchObject({ version: 1, revisionNote: null, current: true })
    expect(packet.revisionNote).toBeNull()
    expect(packet.driftNudges).toEqual([])
  })

  it('renders the chain oldest-first with each version\'s instruction', () => {
    const ids = chain([null, 'make it blue', 'and bigger'])
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, ids[2])! })
    expect(packet.versions.map((v) => [v.version, v.revisionNote])).toEqual([
      [1, null], [2, 'make it blue'], [3, 'and bigger'],
    ])
    expect(packet.versions.filter((v) => v.current).map((v) => v.version)).toEqual([3])
    expect(packet.revisionNote).toBe('and bigger')
  })

  it('sums cumulative cost across the chain and flags estimation', () => {
    const ids = chain([null, 'tweak'])
    cost('run-1', 2.0)
    cost('run-2', 0.5, true)
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, ids[1])! })
    expect(packet.chainCostUsd).toBeCloseTo(2.5, 5)
    expect(packet.chainCostEstimated).toBe(true)
    // The per-cycle cost stays the CURRENT generation's only.
    expect(packet.cost.totalUsd).toBeCloseTo(0.5, 5)
  })

  it('tolerates a pruned ancestor by starting the chain where the data does', () => {
    const ids = chain([null, 'tweak'])
    db.prepare('DELETE FROM rail_pr_deliveries WHERE id = ?').run(ids[0])
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, ids[1])! })
    expect(packet.versions).toHaveLength(1)
    expect(packet.versions[0].current).toBe(true)
  })

  it('cannot spin on a self-referential lineage', () => {
    const [id] = chain([null])
    db.prepare('UPDATE rail_pr_deliveries SET revision_of = id WHERE id = ?').run(id)
    const packet = composeReviewPacket({ db, row: getPrDelivery(db, id)! })
    expect(packet.versions).toHaveLength(1)
  })
})

describe('computeDriftNudges', () => {
  const version = (over: Partial<PacketVersion> = {}): PacketVersion => ({
    prDeliveryId: 'd', version: 1, revisionNote: null, decision: 'on_review',
    costUsd: 1, costEstimated: false, current: false, ...over,
  })

  it('is silent with no revisions', () => {
    expect(computeDriftNudges({
      versions: [version()], originalFileSet: new Set(['a.ts']), currentFiles: new Set(['a.ts']),
    })).toEqual([])
  })

  it('flags revisions that cost more than half the original build', () => {
    const nudges = computeDriftNudges({
      versions: [version({ costUsd: 4 }), version({ version: 2, costUsd: 2.5, revisionNote: 'x' })],
      originalFileSet: new Set(['a.ts']), currentFiles: new Set(['a.ts']),
    })
    expect(nudges.map((n) => n.code)).toContain('drift.costShare')
    expect(nudges[0].values).toMatchObject({ revisionCost: '2.50', originalCost: '4.00', share: 63 })
  })

  it('does not flag a cheap revision', () => {
    const nudges = computeDriftNudges({
      versions: [version({ costUsd: 4 }), version({ version: 2, costUsd: 0.4, revisionNote: 'x' })],
      originalFileSet: new Set(['a.ts']), currentFiles: new Set(['a.ts']),
    })
    expect(nudges.map((n) => n.code)).not.toContain('drift.costShare')
  })

  it('flags churn landing mostly outside the original file set', () => {
    const nudges = computeDriftNudges({
      versions: [version(), version({ version: 2, revisionNote: 'x' })],
      originalFileSet: new Set(['a.ts']),
      currentFiles: new Set(['b.ts', 'c.ts', 'd.ts']),
    })
    expect(nudges.map((n) => n.code)).toContain('drift.outOfScopeChurn')
  })

  it('does not flag churn that stays inside the original scope', () => {
    const nudges = computeDriftNudges({
      versions: [version(), version({ version: 2, revisionNote: 'x' })],
      originalFileSet: new Set(['a.ts', 'b.ts']),
      currentFiles: new Set(['a.ts', 'b.ts']),
    })
    expect(nudges.map((n) => n.code)).not.toContain('drift.outOfScopeChurn')
  })

  it('uses revision count only as a backstop', () => {
    const versions = [version(), ...Array.from({ length: DRIFT_REVISION_COUNT }, (_, i) =>
      version({ version: i + 2, revisionNote: 'x', costUsd: 0.01 }))]
    const nudges = computeDriftNudges({
      versions, originalFileSet: new Set(['a.ts']), currentFiles: new Set(['a.ts']),
    })
    expect(nudges.map((n) => n.code)).toEqual(['drift.revisionCount'])
    expect(nudges[0].values).toMatchObject({ revisions: DRIFT_REVISION_COUNT })
  })

  it('stays silent when cost history is unknown rather than guessing', () => {
    const nudges = computeDriftNudges({
      versions: [version({ costUsd: null }), version({ version: 2, costUsd: null, revisionNote: 'x' })],
      originalFileSet: new Set(), currentFiles: new Set(),
    })
    expect(nudges).toEqual([])
  })
})
