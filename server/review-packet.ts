/**
 * Review-packet composer (nontech-review-experience Wave 2).
 *
 * Turns a settled delivery generation into a structured document a
 * non-technical person can judge — with ZERO model calls and zero live-store
 * reads. Everything comes from durable rows: the launch-time spec snapshot, the
 * settle-time evidence harvest, per-unit outcomes, provenance line stats, and
 * the invocation cost sum. Composing is therefore free, idempotent, and
 * reproducible after a restart.
 *
 * THE HONESTY CONTRACT (the reason this module is shaped like this):
 *
 * Verification claims are split into three tiers by their SOURCE, and the tier
 * travels with the claim so the UI can label it:
 *
 *   app-verified  — Specrails measured it (diff stats, changed test files,
 *                   the decider's routed verdict). Trustworthy.
 *   ai-reported   — the agent said so (the VERIFICATION sentinel, its verify
 *                   output). Rendered with an explicit "we did not run this"
 *                   caveat, never as fact.
 *   reviewer-score— sr-reviewer's own confidence-score.json. Labelled as the
 *                   AI grading itself, surfacing the documented
 *                   human-review band.
 *
 * A numeric verification claim (e.g. "68 tests passed") is NEVER emitted: no
 * structured source for it exists today, so scraping it out of prose would
 * launder a self-report into a measurement. `testEvidence` states which test
 * FILES changed, which is all the diff can actually prove.
 */
import type { DbInstance } from './db'
import { readSettleEvidence, type DeliveryConfidenceScore, type DeliveryUnitEvidence } from './delivery-evidence'
import {
  getPrDelivery,
  readSpecSnapshot,
  type DeliverBranchRecord,
  type PrDeliveryStatusCode,
  type RailPrDeliveryRow,
} from './rail-pr-store'
import { extractSpecNarrative } from './pr-body'
import { sumInvocationCostForRuns } from './ai-invocations'
import { provenanceRepositoryFilter, type ProvenanceRepositoryScope } from './project-repository-provenance'

/** Which story the packet tells. Chosen from durable outcomes, never guessed. */
export type PacketVariant = 'success' | 'no-changes' | 'partial' | 'failed'

export type ProofTier = 'app-verified' | 'ai-reported' | 'reviewer-score'

export interface PacketProofItem {
  tier: ProofTier
  /** Stable machine key; the client owns all localized copy. */
  code: string
  /** Bounded factual values the copy interpolates (never prose to display raw). */
  values?: Record<string, string | number>
  /** Verbatim agent output, shown only inside an explicitly-labelled block. */
  rawExcerpt?: string
}

export interface PacketTicketSection {
  ticketId: number
  /** From the LAUNCH snapshot — what was asked, not what the spec says now. */
  title: string | null
  problem: string | null
  solution: string | null
  labels: string[]
  /** Durable per-unit outcome for this ticket. */
  implementationOutcome: DeliverBranchRecord['implementationOutcome'] | null
  deliveryOutcome: DeliverBranchRecord['deliveryOutcome'] | null
  changed: boolean | null
  /**
   * Measured file churn from the construction-story rows, attributed per RUN.
   * Null when the run covered several tickets: provenance attributes files to a
   * run's PRIMARY ticket only, so splitting it per ticket would invent
   * precision. The delivery-level proof carries the real totals instead.
   */
  churn: { filesTouched: number; addedLines: number; removedLines: number; testFilesTouched: string[] } | null
  runIds: string[]
}

/** One generation in the revision chain, oldest first. */
export interface PacketVersion {
  prDeliveryId: string
  /** 1-based: v1 is the original build. */
  version: number
  /** The instruction that produced this version (null for v1). */
  revisionNote: string | null
  decision: RailPrDeliveryRow['decision']
  /** Cost of this version alone. */
  costUsd: number | null
  costEstimated: boolean
  /** True for the version being rendered. */
  current: boolean
}

/** An advisory "this may have outgrown its spec" signal, never a block. */
export interface PacketDriftNudge {
  code: 'drift.costShare' | 'drift.outOfScopeChurn' | 'drift.revisionCount'
  values: Record<string, string | number>
}

export interface PacketCost {
  totalUsd: number | null
  /** True when any component was a rate-card estimate rather than billed. */
  estimated: boolean
}

export interface ReviewPacket {
  schemaVersion: 1
  repositoryId?: string
  prDeliveryId: string
  railIndex: number
  variant: PacketVariant
  decision: RailPrDeliveryRow['decision']
  statusCode: PrDeliveryStatusCode | null
  /** Machine key for the one-line verdict above the fold. */
  headlineCode: string
  ticketIds: number[]
  baseBranch: string
  loopName: string
  prUrl: string | null
  prNumber: number | null
  succeededCount: number
  failedCount: number
  totalCount: number
  sections: PacketTicketSection[]
  proof: PacketProofItem[]
  /** Reviewer flags + risk hints derived from real signals only. */
  watchOut: PacketProofItem[]
  confidence: DeliveryConfidenceScore | null
  cost: PacketCost
  /** True when the settle harvest could not read anything at all. */
  evidenceUnavailable: boolean
  runIds: string[]
  /** Newest-first lineage of prior generations (Wave 3 renders versions). */
  supersedesDeliveryId: string | null
  /** The revision instruction that produced THIS generation (null for v1). */
  revisionNote: string | null
  /** Oldest-first version chain; length 1 when nothing has been revised. */
  versions: PacketVersion[]
  /** Cumulative cost across the whole chain (the honest number for a nudge). */
  chainCostUsd: number | null
  chainCostEstimated: boolean
  /** Advisory reshape-the-spec signals derived from real measurements only. */
  driftNudges: PacketDriftNudge[]
}

const TEST_FILE_RE = /(\.test\.|\.spec\.|(^|\/)__tests__\/)/

/** Per-provenance churn for one delivery run, from file_story_contributions. */
interface ChurnRow {
  job_id: string | null
  repository_id: string | null
  file_path: string
  added_lines: number
  removed_lines: number
}

function churnForRuns(db: DbInstance, runIds: readonly string[], repository?: ProvenanceRepositoryScope): ChurnRow[] {
  const ids = [...new Set(runIds.filter((id) => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(', ')
  try {
    const scope = provenanceRepositoryFilter(db, repository, 'p')
    const hasRepository = (db.prepare('PRAGMA table_info(file_provenance)').all() as Array<{ name: string }>).some(column => column.name === 'repository_id')
    return db.prepare(`
      SELECT c.job_id, c.file_path, c.added_lines, c.removed_lines,
             ${hasRepository ? 'p.repository_id' : 'NULL'} AS repository_id
        FROM file_story_contributions c
        LEFT JOIN file_provenance p ON p.id = c.provenance_id
       WHERE c.job_id IN (${placeholders}) AND ${scope.sql}
    `).all(...ids, ...scope.params) as ChurnRow[]
  } catch {
    return []
  }
}

function churnIdentity(row: ChurnRow): string {
  return JSON.stringify([row.repository_id ?? null, row.file_path])
}

/**
 * Variant selection reads ONLY durable outcomes. `no-changes` must win over
 * `success` (a run that changed nothing has nothing to show), and a mixed batch
 * is `partial` rather than a success that quietly hides a failed ticket.
 */
export function selectVariant(row: RailPrDeliveryRow, units: DeliverBranchRecord[]): PacketVariant {
  if (row.decision === 'no_changes' || row.delivery_outcome === 'no_changes' || row.status_code === 'no_changes') {
    return 'no-changes'
  }
  if (row.implementation_outcome === 'failed' || row.decision === 'implementation_failed') return 'failed'
  const succeeded = units.filter((unit) => unit.implementationOutcome === 'succeeded' || (unit.implementationOutcome == null && unit.succeeded)).length
  const failed = units.filter((unit) => unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)).length
  if (row.implementation_outcome === 'partially_succeeded' || row.delivery_outcome === 'partial' || (succeeded > 0 && failed > 0)) {
    return 'partial'
  }
  return 'success'
}

function headlineFor(variant: PacketVariant, succeeded: number, total: number): string {
  switch (variant) {
    case 'no-changes': return 'headline.noChanges'
    case 'failed': return succeeded > 0 ? 'headline.failedPartial' : 'headline.failed'
    case 'partial': return 'headline.partial'
    default: return total > 1 ? 'headline.successMany' : 'headline.success'
  }
}

/** Reviewer band documented by sr-reviewer's schema: 50-69 ⇒ recommend a human. */
export const HUMAN_REVIEW_BAND = { min: 50, max: 69 } as const

function buildProof(
  units: DeliverBranchRecord[],
  evidence: DeliveryUnitEvidence[] | null,
  churn: ChurnRow[],
  confidence: DeliveryConfidenceScore | null,
): PacketProofItem[] {
  const proof: PacketProofItem[] = []

  // ── Tier 1: what Specrails measured itself ────────────────────────────────
  const testFiles = [...new Set(churn.filter((row) => TEST_FILE_RE.test(row.file_path)).map(churnIdentity))]
  const totalFiles = new Set(churn.map(churnIdentity)).size
  const added = churn.reduce((sum, row) => sum + (row.added_lines || 0), 0)
  const removed = churn.reduce((sum, row) => sum + (row.removed_lines || 0), 0)
  if (totalFiles > 0) {
    proof.push({
      tier: 'app-verified',
      code: 'proof.filesChanged',
      values: { files: totalFiles, added, removed },
    })
  }
  proof.push(
    testFiles.length > 0
      ? { tier: 'app-verified', code: 'proof.testFilesChanged', values: { count: testFiles.length } }
      // The honest negative: silence here would read as "tests fine".
      : { tier: 'app-verified', code: 'proof.noTestFilesChanged' },
  )
  const verifiedBranches = units.filter((unit) => unit.finalSha && unit.finalSha !== unit.initialSha).length
  if (verifiedBranches > 0) {
    proof.push({ tier: 'app-verified', code: 'proof.commitsRecorded', values: { branches: verifiedBranches } })
  }

  // ── Tier 2: what the agent itself reported ────────────────────────────────
  const sentinels = (evidence ?? []).filter((unit) => unit.sentinel !== 'absent')
  if (sentinels.length === 0) {
    proof.push({ tier: 'ai-reported', code: 'proof.noVerificationReported' })
  } else {
    const failed = sentinels.filter((unit) => unit.sentinel === 'fail')
    if (failed.length > 0) {
      // Failure leads: a packet must never bury a reported failure under a pass.
      proof.push({
        tier: 'ai-reported',
        code: 'proof.verificationFailed',
        values: { count: failed.length },
        ...(failed[0].sentinelDetail ? { rawExcerpt: failed[0].sentinelDetail } : {}),
      })
    }
    const passed = sentinels.filter((unit) => unit.sentinel === 'pass')
    if (passed.length > 0) {
      proof.push({ tier: 'ai-reported', code: 'proof.verificationPassed', values: { count: passed.length } })
    }
    const tail = sentinels.map((unit) => unit.verifyTail).find((value): value is string => Boolean(value))
    if (tail) proof.push({ tier: 'ai-reported', code: 'proof.verifyOutput', rawExcerpt: tail })
  }

  // ── Tier 3: the reviewer grading its own pipeline ─────────────────────────
  if (confidence) {
    if (confidence.overall !== null) {
      proof.push({
        tier: 'reviewer-score',
        code: 'proof.reviewerScore',
        values: { overall: confidence.overall },
      })
    }
    for (const [aspect, score] of Object.entries(confidence.aspects)) {
      proof.push({ tier: 'reviewer-score', code: 'proof.reviewerAspect', values: { aspect, score } })
    }
  } else {
    proof.push({ tier: 'reviewer-score', code: 'proof.reviewerScoreUnavailable' })
  }
  return proof
}

/**
 * "What to watch out for" is capped and derived from REAL signals only —
 * reviewer flags, the human-review band, and a code-changed-without-tests
 * observation. Confabulated caution would train the user to ignore the section.
 */
function buildWatchOut(
  confidence: DeliveryConfidenceScore | null,
  churn: ChurnRow[],
  variant: PacketVariant,
): PacketProofItem[] {
  const out: PacketProofItem[] = []
  if (confidence?.overall !== null && confidence?.overall !== undefined) {
    if (confidence.overall >= HUMAN_REVIEW_BAND.min && confidence.overall <= HUMAN_REVIEW_BAND.max) {
      out.push({ tier: 'reviewer-score', code: 'watch.humanReviewRecommended', values: { overall: confidence.overall } })
    } else if (confidence.overall < HUMAN_REVIEW_BAND.min) {
      out.push({ tier: 'reviewer-score', code: 'watch.lowConfidence', values: { overall: confidence.overall } })
    }
  }
  for (const flag of (confidence?.flags ?? []).slice(0, 3)) {
    out.push({ tier: 'reviewer-score', code: 'watch.reviewerFlag', rawExcerpt: flag })
  }
  const codeFiles = churn.filter((row) => !TEST_FILE_RE.test(row.file_path))
  const testFiles = churn.filter((row) => TEST_FILE_RE.test(row.file_path))
  if (out.length < 3 && variant !== 'no-changes' && codeFiles.length > 0 && testFiles.length === 0) {
    out.push({ tier: 'app-verified', code: 'watch.noTestsForChangedCode', values: { files: codeFiles.length } })
  }
  return out.slice(0, 3)
}

/**
 * Walk the supersession chain back to the original build. Bounded so a corrupted
 * lineage cannot spin, and tolerant of a missing ancestor (an old row may have
 * been pruned) — the chain simply starts where the data does.
 */
export const MAX_VERSION_CHAIN = 25

function versionChain(db: DbInstance, row: RailPrDeliveryRow): RailPrDeliveryRow[] {
  const chain: RailPrDeliveryRow[] = [row]
  const seen = new Set([row.id])
  let cursor = row
  while (chain.length < MAX_VERSION_CHAIN && cursor.revision_of) {
    const previous = getPrDelivery(db, cursor.revision_of)
    if (!previous || seen.has(previous.id)) break
    seen.add(previous.id)
    chain.push(previous)
    cursor = previous
  }
  return chain.reverse() // oldest first: v1 … vN
}

/** Fraction of the original build's cost above which revisions are worth flagging. */
export const DRIFT_COST_SHARE = 0.5
/** Revision count backstop — advisory, never a block. */
export const DRIFT_REVISION_COUNT = 3

/**
 * Reshape-the-spec nudges. Every trigger is a real measurement (cumulative cost
 * vs the original build, churn landing outside the original file set, revision
 * depth) so the banner can show its own numbers instead of asserting a vibe.
 * A hard count alone was rejected: it treats a 40-cent typo fix and a nine-dollar
 * architectural thrash identically.
 */
export function computeDriftNudges(input: {
  versions: PacketVersion[]
  originalFileSet: ReadonlySet<string>
  currentFiles: ReadonlySet<string>
}): PacketDriftNudge[] {
  const nudges: PacketDriftNudge[] = []
  const [original, ...revisions] = input.versions
  if (revisions.length === 0) return nudges

  const originalCost = original?.costUsd ?? null
  const revisionCost = revisions.reduce((sum, version) => sum + (version.costUsd ?? 0), 0)
  if (originalCost !== null && originalCost > 0 && revisionCost > originalCost * DRIFT_COST_SHARE) {
    nudges.push({
      code: 'drift.costShare',
      values: {
        revisions: revisions.length,
        revisionCost: revisionCost.toFixed(2),
        originalCost: originalCost.toFixed(2),
        share: Math.round((revisionCost / originalCost) * 100),
      },
    })
  }

  if (input.originalFileSet.size > 0 && input.currentFiles.size > 0) {
    const outside = [...input.currentFiles].filter((file) => !input.originalFileSet.has(file))
    if (outside.length * 2 > input.currentFiles.size) {
      nudges.push({ code: 'drift.outOfScopeChurn', values: { files: outside.length, total: input.currentFiles.size } })
    }
  }

  if (revisions.length >= DRIFT_REVISION_COUNT) {
    nudges.push({ code: 'drift.revisionCount', values: { revisions: revisions.length } })
  }
  return nudges
}

export interface ComposeReviewPacketInput {
  db: DbInstance
  row: RailPrDeliveryRow
  repositoryId?: string
  includeLegacyProvenance?: boolean
}

export function composeReviewPacket({ db, row, repositoryId = row.repository_id ?? undefined, includeLegacyProvenance = false }: ComposeReviewPacketInput): ReviewPacket {
  const repository = repositoryId ? { repositoryId, includeLegacy: includeLegacyProvenance } : undefined
  const ticketIds = safeParse<number[]>(row.ticket_ids, [])
  const units = safeParse<DeliverBranchRecord[]>(row.branches, [])
  const runIds = safeParse<string[]>(row.run_ids, [])
  const snapshot = readSpecSnapshot(row.spec_snapshot)
  const evidence = readSettleEvidence(row.settle_evidence)
  const churn = churnForRuns(db, runIds, repository)
  const variant = selectVariant(row, units)

  const confidence = (evidence?.units ?? [])
    .map((unit) => unit.confidence)
    .find((score): score is DeliveryConfidenceScore => score !== null) ?? null

  const sections: PacketTicketSection[] = ticketIds.map((ticketId) => {
    const snap = snapshot?.find((entry) => entry.ticketId === ticketId) ?? null
    const narrative = extractSpecNarrative(snap?.description ?? null)
    const unitRows = units.filter((unit) => unit.ticketId === ticketId)
    const unitRunIds = [...new Set(unitRows.map((unit) => unit.runId).filter((id): id is string => Boolean(id)))]
    // A run that covered several tickets (a batch collapsed into one checkout)
    // cannot have its files split per ticket: provenance keys them to the run's
    // primary ticket. Report null rather than repeat delivery totals per section.
    const sharedRun = unitRunIds.some((runId) =>
      new Set(units.filter((unit) => unit.runId === runId).map((unit) => unit.ticketId)).size > 1)
    const unitChurn = !sharedRun && unitRunIds.length > 0
      ? churn.filter((row) => row.job_id != null && unitRunIds.includes(row.job_id))
      : null
    return {
      ticketId,
      title: snap?.title ?? null,
      problem: narrative.problem,
      solution: narrative.solution,
      labels: snap?.labels ?? [],
      implementationOutcome: unitRows[0]?.implementationOutcome ?? null,
      deliveryOutcome: unitRows[0]?.deliveryOutcome ?? null,
      changed: unitRows[0]?.changed ?? null,
      churn: unitChurn === null ? null : {
        filesTouched: new Set(unitChurn.map(churnIdentity)).size,
        addedLines: unitChurn.reduce((sum, c) => sum + (c.added_lines || 0), 0),
        removedLines: unitChurn.reduce((sum, c) => sum + (c.removed_lines || 0), 0),
        testFilesTouched: [...new Set(unitChurn.filter((c) => TEST_FILE_RE.test(c.file_path)).map((c) => !repositoryId && c.repository_id ? `${c.repository_id}:${c.file_path}` : c.file_path))],
      },
      runIds: unitRunIds,
    }
  })

  const succeededCount = units.length > 0
    ? units.filter((unit) => unit.implementationOutcome === 'succeeded' || (unit.implementationOutcome == null && unit.succeeded)).length
    : row.implementation_outcome === 'failed' ? 0 : ticketIds.length
  const failedCount = units.length > 0
    ? units.filter((unit) => unit.implementationOutcome === 'failed' || (unit.implementationOutcome == null && !unit.succeeded)).length
    : row.implementation_outcome === 'failed' ? ticketIds.length : 0

  const costSum = sumInvocationCostForRuns(db, runIds)

  const chain = versionChain(db, row)
  const versions: PacketVersion[] = chain.map((entry, index) => {
    const entryRunIds = safeParse<string[]>(entry.run_ids, [])
    const entryCost = sumInvocationCostForRuns(db, entryRunIds)
    return {
      prDeliveryId: entry.id,
      version: index + 1,
      revisionNote: entry.revision_note,
      decision: entry.decision,
      costUsd: entryCost?.totalUsd ?? null,
      costEstimated: entryCost?.estimated ?? false,
      current: entry.id === row.id,
    }
  })
  const chainCosts = versions.map((version) => version.costUsd).filter((value): value is number => value !== null)
  // Churn comparison uses the ORIGINAL generation's files as the scope baseline:
  // a revision touching mostly new files is the honest signal that the spec no
  // longer describes the work.
  const originalFiles = chain.length > 1
    ? new Set(churnForRuns(db, safeParse<string[]>(chain[0].run_ids, []), repository).map(churnIdentity))
    : new Set<string>()
  const driftNudges = computeDriftNudges({
    versions,
    originalFileSet: originalFiles,
    currentFiles: new Set(churn.map(churnIdentity)),
  })

  return {
    schemaVersion: 1,
    ...(repositoryId ? { repositoryId } : {}),
    prDeliveryId: row.id,
    railIndex: row.rail_index,
    variant,
    decision: row.decision,
    statusCode: row.status_code,
    headlineCode: headlineFor(variant, succeededCount, ticketIds.length),
    ticketIds,
    baseBranch: row.base_branch,
    loopName: row.loop_name,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    succeededCount,
    failedCount,
    totalCount: units.length > 0 ? new Set(units.map((u) => u.ticketId)).size : ticketIds.length,
    sections,
    proof: buildProof(units, evidence?.units ?? null, churn, confidence),
    watchOut: buildWatchOut(confidence, churn, variant),
    confidence,
    cost: { totalUsd: costSum?.totalUsd ?? null, estimated: costSum?.estimated ?? false },
    evidenceUnavailable: evidence === null || evidence.harvest === 'failed',
    runIds,
    supersedesDeliveryId: row.supersedes_delivery_id,
    revisionNote: row.revision_note,
    versions,
    chainCostUsd: chainCosts.length > 0 ? chainCosts.reduce((sum, value) => sum + value, 0) : null,
    chainCostEstimated: versions.some((version) => version.costEstimated),
    driftNudges,
  }
}

/** Assert-by-construction guard used in tests and by the route: no packet field
 * may carry a numeric verification claim without a structured source. */
export function packetHasUnsourcedNumericClaim(packet: ReviewPacket): boolean {
  return packet.proof.some((item) =>
    item.tier === 'ai-reported'
    && Object.keys(item.values ?? {}).some((key) => key === 'tests' || key === 'passed' || key === 'failedTests'))
}

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(raw) as T
    return parsed ?? fallback
  } catch {
    return fallback
  }
}
