/**
 * CRUD for the `rail_pr_deliveries` ledger (migration 36) — one row per isolated
 * rail LAUNCH tracking the ask-first PR decision lifecycle. This is the single
 * authoritative server-side state both decision surfaces (the rail row on the
 * dashboard and the launching agent-chat conversation) read and write, so the
 * two surfaces never desync and a refresh/restart never loses a pending
 * decision. Pure data access; the PR plumbing lives in rail-pr-delivery /
 * pr-publisher and the launch wiring in rail-isolated-launch.
 */
import type { DbInstance } from './db'
import type { OverlayCleanupEvidence } from './worktree-overlay'
import type { DeliverySettleEvidence } from './delivery-evidence'
import type { PrDecisionCardEnvelope, RailPrStateMessage } from './types'
import { newId } from './ids'

/**
 * `decision` is the user/action lifecycle only. Execution truth and delivery
 * readiness are deliberately orthogonal columns below: a successful agent run
 * can have a blocked commit/ref stage, and an open PR can be unchanged.
 */
export type PrDecision =
  | 'building'
  | 'on_review'
  | 'no_changes'
  | 'pr_draft'
  | 'pr_ready'
  | 'pr_closed'
  | 'completed'
  | 'merged'
  | 'discarded'
  | 'superseded'
  | 'implementation_failed'
  | 'pr_failed'

/** How far a Create-PR attempt got (the pr-publisher degradation ladder), independent of `decision`. */
export type PrDeliveryState = 'none' | 'local-only' | 'pushed' | 'pr-created'

/** Which surface launched the rail; `agent-chat` rows carry an origin_conversation_id. */
export type PrOriginSurface = 'dashboard' | 'agent-chat'

/** The engine's immutable aggregate result — never derived from Git delivery. */
export type PrImplementationOutcome =
  | 'running'
  | 'succeeded'
  | 'partially_succeeded'
  | 'failed'
  | 'unknown'

/** How far the verified result can safely progress through delivery. */
export type PrDeliveryOutcome =
  | 'pending'
  | 'ready'
  | 'delivered'
  | 'partial'
  | 'no_changes'
  | 'retryable_failure'
  | 'blocked'
  | 'not_started'
  | 'unknown'

/** Stable machine reason; clients localize these rather than raw git stderr. */
export type PrDeliveryStatusCode =
  | 'implementation_running'
  | 'implementation_failed'
  | 'ready_for_review'
  | 'partial_success'
  | 'partial_delivery'
  | 'existing_pr_updated'
  | 'no_changes'
  | 'commit_failed'
  | 'branch_verification_failed'
  | 'push_failed'
  | 'settlement_interrupted'
  | 'recovery_unavailable'
  | 'operation_interrupted'
  | 'delivery_failed'
  | 'pr_draft_ready'
  | 'pr_ready'
  | 'pr_closed'
  | 'merged'
  | 'discarded'
  | 'superseded'
  | 'cleanup_incomplete'

export type PrDecisionOperation = 'create-pr' | 'publish' | 'discard' | 'dismiss' | 'poll-merge' | 'reopen' | 'merge-local' | 'acknowledge-no-changes' | 'recover-and-retry'

/** Per-unit branch record captured at build-settle (mirrors rail-pr-delivery's DeliverBranch). */
export interface DeliverBranchRecord {
  ticketId: number
  branch: string
  /** Legacy delivery-eligibility bit retained for older decision code/wire consumers. */
  succeeded: boolean
  runId?: string
  implementationOutcome?: 'succeeded' | 'failed'
  deliveryOutcome?: 'ready' | 'no_changes' | 'blocked' | 'not_started'
  initialSha?: string | null
  finalSha?: string | null
  changed?: boolean
  failureCode?: PrDeliveryStatusCode | null
  branchOwnership?: 'created' | 'preexisting' | 'borrowed-pr'
  /** Delivery-owned isolated checkout retained for explicit local recovery. */
  worktreePath?: string | null
  /** Allocation-time never-commit paths. This list remains conservative even
   * when a copied overlay file changes; it is not cleanup authorization. */
  overlayExcludes?: string[]
  /** Live-revalidated fingerprints for automatic cleanup. Legacy path-only
   * records are intentionally insufficient removal authorization. */
  overlayCleanupEvidence?: OverlayCleanupEvidence[]
  /** Gitignored paths present at the moment the worktree was proven clean —
   * the IMMUTABLE settlement snapshot that authorizes releasing run-created
   * ignored artifacts (build caches). null/absent = no ignored authorization
   * (capture failed, overflowed, or legacy row) — release preserves as before. */
  settlementIgnoredPaths?: string[] | null
}

/** One covered ticket, frozen at LAUNCH (migration 56). The review packet's
 * "what you asked" section renders THIS, never the live store — a spec edited
 * mid-run must not silently rewrite what the delivery was asked to do. */
export interface DeliverySpecSnapshotEntry {
  ticketId: number
  title: string | null
  description: string | null
  labels: string[]
}

/** Defensive per-ticket cap; contract-layer specs run long but bounded. */
const SPEC_SNAPSHOT_DESCRIPTION_CAP = 32_768

export function boundSpecSnapshot(entries: readonly DeliverySpecSnapshotEntry[]): DeliverySpecSnapshotEntry[] {
  return entries.map((entry) => ({
    ticketId: entry.ticketId,
    title: entry.title,
    description: entry.description == null ? null : entry.description.slice(0, SPEC_SNAPSHOT_DESCRIPTION_CAP),
    labels: entry.labels.slice(0, 32),
  }))
}

/** Parse a persisted spec_snapshot column value (null-tolerant). */
export function readSpecSnapshot(raw: string | null | undefined): DeliverySpecSnapshotEntry[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeliverySpecSnapshotEntry[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** States after which the delivery is closed (no further decision possible). */
export const TERMINAL_PR_DECISIONS: ReadonlySet<PrDecision> = new Set(['completed', 'merged', 'discarded', 'superseded'])

/** States in which the delivery still awaits (or is executing) a user decision. */
export const ACTIVE_PR_DECISIONS: ReadonlySet<PrDecision> = new Set([
  'building',
  'on_review',
  'no_changes',
  'pr_draft',
  'pr_ready',
  'pr_closed',
  'implementation_failed',
  'pr_failed',
])

export function isTerminalPrDecision(s: string): boolean {
  return TERMINAL_PR_DECISIONS.has(s as PrDecision)
}

export interface RailPrDeliveryRow {
  id: string
  rail_index: number
  loop_id: string | null
  rail_key: string
  /** JSON number[] — every ticket covered by the launch. */
  ticket_ids: string
  base_branch: string
  /** The assembled/delivered head branch (once a Create-PR ran). */
  branch: string | null
  pr_url: string | null
  pr_number: number | null
  pr_state: PrDeliveryState
  decision: PrDecision
  implementation_outcome: PrImplementationOutcome
  delivery_outcome: PrDeliveryOutcome
  status_code: PrDeliveryStatusCode | null
  status_detail: string | null
  /** Exact verified object used for continuation push/retry. */
  delivery_sha: string | null
  is_continuation: number
  supersedes_delivery_id: string | null
  /** Failed replacement generation whose allocation rollback restored this row. */
  restored_from_delivery_id: string | null
  operation: PrDecisionOperation | null
  operation_token: string | null
  operation_started_at_ms: number | null
  /** JSON string[] — bounded best-effort cleanup diagnostics. */
  cleanup_warnings: string
  /** JSON string[] — persistent safety-quarantine paths, bounded newest-first
   * across repeated cleanup attempts. */
  safety_archives: string
  /** JSON DeliverBranchRecord[] — per-unit source branches captured at settle. */
  branches: string
  loop_name: string
  /** JSON string[] — rail_worktrees ledger ids, for discard cleanup. */
  worktree_ids: string
  /** JSON string[] — the launch's loop-run ids (order matches ticket order;
   *  one entry for scope='all'). Patched right after allocation so the PR
   *  decision surfaces can link each run's log + live vitals (migration 38). */
  run_ids: string
  origin_surface: PrOriginSurface
  origin_conversation_id: string | null
  /** JSON DeliverySpecSnapshotEntry[] frozen at launch (migration 56); NULL on legacy rows. */
  spec_snapshot: string | null
  /** JSON DeliverySettleEvidence harvested at settle (migration 56); NULL until settle / on legacy rows. */
  settle_evidence: string | null
  created_at: string
  updated_at: string
}

export interface CreatePrDeliveryInput {
  /** Row uuid; generated when omitted. */
  id?: string
  railIndex: number
  loopId?: string | null
  railKey: string
  ticketIds: number[]
  baseBranch: string
  loopName: string
  originSurface: PrOriginSurface
  originConversationId?: string | null
  isContinuation?: boolean
  supersedesDeliveryId?: string | null
  /** Launch-time freeze of the covered tickets (bounded before persistence). */
  specSnapshot?: DeliverySpecSnapshotEntry[] | null
}

/**
 * Insert a new delivery row for a rail launch. The row starts at
 * decision='building', pr_state='none' with empty branches/worktree_ids —
 * settle patches those via transitionDecision.
 */
export function createPrDelivery(db: DbInstance, input: CreatePrDeliveryInput): RailPrDeliveryRow {
  const id = input.id ?? newId()
  db.prepare(
    `INSERT INTO rail_pr_deliveries (
       id, rail_index, loop_id, rail_key, ticket_ids, base_branch,
       loop_name, origin_surface, origin_conversation_id,
       implementation_outcome, delivery_outcome, status_code,
       is_continuation, supersedes_delivery_id, spec_snapshot
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'pending',
       'implementation_running', ?, ?, ?)`
  ).run(
    id,
    input.railIndex,
    input.loopId ?? null,
    input.railKey,
    JSON.stringify(input.ticketIds),
    input.baseBranch,
    input.loopName,
    input.originSurface,
    input.originConversationId ?? null,
    input.isContinuation ? 1 : 0,
    input.supersedesDeliveryId ?? null,
    input.specSnapshot && input.specSnapshot.length > 0
      ? JSON.stringify(boundSpecSnapshot(input.specSnapshot))
      : null,
  )
  return getPrDelivery(db, id)!
}

export class PrDeliveryGenerationConflict extends Error {
  readonly code = 'PR_DELIVERY_GENERATION_CONFLICT'

  constructor(readonly currentId: string | null) {
    super(currentId
      ? `rail already has active PR delivery ${currentId}`
      : 'expected active PR delivery is no longer current')
    this.name = 'PrDeliveryGenerationConflict'
  }
}

export interface SupersededPrDelivery {
  id: string
  decision: PrDecision
  statusCode: PrDeliveryStatusCode | null
}

/** SQLite's `datetime('now')` has one-second precision, so a claim, transition,
 * and release in the same second used to produce conflicting snapshots with an
 * identical `updatedAt`. Clients must fail closed on such ties. Keep the wire
 * timestamp strictly increasing per row while retaining a parseable UTC ISO
 * value for legacy rows and every mutation path. */
const NEXT_PR_UPDATED_AT_SQL = `CASE
  WHEN julianday('now') > julianday(updated_at)
  THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  ELSE strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds')
END`

/** Recheck admission and, for a continuation, replace the prior generation in
 * one SQLite transaction. The partial unique index is therefore an invariant,
 * not merely a router convention. Pass null for a genuinely fresh launch. */
export function createPrDeliveryGeneration(
  db: DbInstance,
  input: CreatePrDeliveryInput,
  expectedActive: { id: string; decision: PrDecision } | null,
): { delivery: RailPrDeliveryRow; superseded: SupersededPrDelivery | null } {
  return db.transaction(() => {
    const current = getActivePrDeliveryByRail(db, input.railIndex)
    if (expectedActive === null) {
      if (current) throw new PrDeliveryGenerationConflict(current.id)
      return { delivery: createPrDelivery(db, input), superseded: null }
    }
    if (
      !current || current.id !== expectedActive.id || current.decision !== expectedActive.decision ||
      current.operation_token !== null
    ) {
      throw new PrDeliveryGenerationConflict(current?.id ?? null)
    }
    const previous: SupersededPrDelivery = {
      id: current.id,
      decision: current.decision,
      statusCode: current.status_code,
    }
    const moved = db.prepare(`
      UPDATE rail_pr_deliveries
         SET decision = 'superseded', restored_from_delivery_id = NULL,
             updated_at = ${NEXT_PR_UPDATED_AT_SQL}
       WHERE id = ? AND decision = ? AND operation_token IS NULL
    `).run(current.id, current.decision)
    if (moved.changes !== 1) throw new PrDeliveryGenerationConflict(current.id)
    const delivery = createPrDelivery(db, {
      ...input,
      // An expected active generation can be replaced either by a verified
      // continuation or by a fresh lineage after its recorded PR went stale.
      // Persist the caller's ownership decision in this same transaction so a
      // crash cannot expose a fresh branch as a borrowed continuation branch.
      isContinuation: input.isContinuation ?? true,
      supersedesDeliveryId: current.id,
    })
    return { delivery, superseded: previous }
  })()
}

/** Allocation failed after a continuation generation replaced its predecessor:
 * close the failed generation first (freeing the unique slot), then restore the
 * exact prior decision/status. A stale/raced row leaves both untouched. */
export function failPrDeliveryAndRestoreSuperseded(
  db: DbInstance,
  failedId: string,
  previous: SupersededPrDelivery,
): boolean {
  return db.transaction(() => {
    const failed = db.prepare(`
      UPDATE rail_pr_deliveries
         SET decision = 'discarded', status_code = 'delivery_failed',
             delivery_outcome = 'blocked', updated_at = ${NEXT_PR_UPDATED_AT_SQL}
       WHERE id = ? AND decision = 'building'
    `).run(failedId)
    if (failed.changes !== 1) return false
    const restored = db.prepare(`
      UPDATE rail_pr_deliveries
         SET decision = ?, status_code = ?, restored_from_delivery_id = ?,
             updated_at = ${NEXT_PR_UPDATED_AT_SQL}
       WHERE id = ? AND decision = 'superseded'
    `).run(previous.decision, previous.statusCode, failedId, previous.id)
    if (restored.changes !== 1) throw new Error(`failed to restore superseded delivery ${previous.id}`)
    return true
  })()
}

export function getPrDelivery(db: DbInstance, id: string): RailPrDeliveryRow | undefined {
  return db.prepare('SELECT * FROM rail_pr_deliveries WHERE id = ?').get(id) as RailPrDeliveryRow | undefined
}

/**
 * The newest non-terminal delivery for a rail slot (a slot can be relaunched;
 * older terminal rows are history). Used by the relaunch-collision guard and
 * the GET /rails snapshot.
 */
export function getActivePrDeliveryByRail(db: DbInstance, railIndex: number): RailPrDeliveryRow | undefined {
  return db
    .prepare(
      `SELECT * FROM rail_pr_deliveries
       WHERE rail_index = ? AND decision NOT IN ('completed','merged','discarded','superseded')
       ORDER BY created_at DESC, rowid DESC LIMIT 1`
    )
    .get(railIndex) as RailPrDeliveryRow | undefined
}

/** Every non-terminal delivery — hydrates the GET /rails prDeliveries snapshot. */
export function listActivePrDeliveries(db: DbInstance): RailPrDeliveryRow[] {
  return db
    .prepare(
      `SELECT * FROM rail_pr_deliveries
       WHERE decision NOT IN ('completed','merged','discarded','superseded')
       ORDER BY rail_index, created_at DESC, rowid DESC`
    )
    .all() as RailPrDeliveryRow[]
}

/** Terminal delivery history, newest first. Continuation discovery uses this
 * only as a conservative ownership hint: callers must still require an exact
 * ticket target and revalidate the recorded PR/ref identity before reuse. */
export function listTerminalPrDeliveries(db: DbInstance): RailPrDeliveryRow[] {
  return db
    .prepare(
      `SELECT * FROM rail_pr_deliveries
       WHERE decision IN ('completed','merged','discarded','superseded')
       ORDER BY created_at DESC, rowid DESC`
    )
    .all() as RailPrDeliveryRow[]
}

function canonicalTicketSet(values: readonly unknown[]): string | null {
  if (values.length === 0) return null
  const tickets = new Set<number>()
  for (const value of values) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) tickets.add(value)
  }
  return tickets.size > 0 ? [...tickets].sort((a, b) => a - b).join(',') : null
}

/**
 * Newest terminal generation touching any requested ticket. The returned row
 * is intentionally not otherwise validated: a newer subset, superset, or
 * malformed row still owns the overlapping ticket lineage and must shadow
 * older exact-set history rather than letting a caller resurrect a stale PR.
 */
export function getLatestTerminalPrDeliveryTouchingTicketSet(
  db: DbInstance,
  ticketIds: readonly number[],
): RailPrDeliveryRow | undefined {
  const target = canonicalTicketSet(ticketIds)
  if (!target || target.split(',').length !== ticketIds.length) return undefined
  const wanted = new Set(target.split(',').map(Number))
  return listTerminalPrDeliveries(db).find((row) => (
    parseJsonArray<unknown>(row.ticket_ids).some((value) => (
      typeof value === 'number' && Number.isSafeInteger(value) && wanted.has(value)
    ))
  ))
}

/** Startup projection source for persisted Agent cards. Terminal rows matter:
 * a process may die after their SQLite transition but before the conversation
 * envelope update, leaving an obsolete actionable card pinned forever. */
export function listOriginLinkedPrDeliveries(db: DbInstance): RailPrDeliveryRow[] {
  return db.prepare(`
    SELECT * FROM rail_pr_deliveries
     WHERE origin_conversation_id IS NOT NULL
     ORDER BY created_at ASC, rowid ASC
  `).all() as RailPrDeliveryRow[]
}

/**
 * Recover cards stranded between engine completion and delivery settlement.
 * Callers wait for every known run to finish; startup may additionally close
 * impossible empty/incomplete generations from the prior process. Hydration
 * never invokes this reconciler. Successful/uncertain work is NEVER called an
 * implementation failure and this data-only pass never removes a worktree.
 */
export function reconcileFailedBuildingPrDeliveries(
  db: DbInstance,
  opts: { startup?: boolean } = {},
): RailPrDeliveryRow[] {
  const rows = db
    .prepare(`SELECT * FROM rail_pr_deliveries WHERE decision = 'building' ORDER BY created_at ASC, rowid ASC`)
    .all() as RailPrDeliveryRow[]
  const reconciled: RailPrDeliveryRow[] = []

  for (const row of rows) {
    const runIds = parseJsonArray<string>(row.run_ids ?? '[]')
    if (runIds.length === 0) {
      if (!opts.startup) continue
      if (transitionDecision(db, row.id, 'building', 'pr_failed', {
        implementationOutcome: 'unknown',
        deliveryOutcome: 'blocked',
        statusCode: 'settlement_interrupted',
        statusDetail: 'The prior process stopped before run allocation became durable.',
      })) {
        const updated = getPrDelivery(db, row.id)
        if (updated) reconciled.push(updated)
      }
      continue
    }
    const uniqueRunIds = [...new Set(runIds)]
    const placeholders = uniqueRunIds.map(() => '?').join(',')
    const runs = db
      .prepare(`SELECT id, status, final_outcome FROM loop_runs WHERE id IN (${placeholders})`)
      .all(...uniqueRunIds) as Array<{ id: string; status: string; final_outcome: string | null }>
    if (runs.length !== uniqueRunIds.length || runs.some((run) => run.status !== 'completed')) {
      if (!opts.startup) continue
      if (transitionDecision(db, row.id, 'building', 'pr_failed', {
        implementationOutcome: 'unknown',
        deliveryOutcome: 'blocked',
        statusCode: 'settlement_interrupted',
        statusDetail: 'The prior process stopped before every implementation unit settled.',
      })) {
        const updated = getPrDelivery(db, row.id)
        if (updated) reconciled.push(updated)
      }
      continue
    }

    const successfulRunIds = new Set(runs.filter((run) => run.final_outcome === 'success').map((run) => run.id))
    if (successfulRunIds.size === 0) {
      if (transitionDecision(db, row.id, 'building', 'implementation_failed', {
        implementationOutcome: 'failed',
        deliveryOutcome: 'not_started',
        statusCode: 'implementation_failed',
      })) {
        const updated = getPrDelivery(db, row.id)
        if (updated) reconciled.push(updated)
      }
      continue
    }

    const placeholdersForWorktrees = uniqueRunIds.map(() => '?').join(',')
    const worktrees = db.prepare(`
      SELECT id, ticket_id, run_id, branch, merge_state
        FROM rail_worktrees
       WHERE run_id IN (${placeholdersForWorktrees})
       ORDER BY created_at ASC, rowid ASC
    `).all(...uniqueRunIds) as Array<{
      id: string
      ticket_id: number
      run_id: string | null
      branch: string
      merge_state: string
    }>
    const reconstructed = worktrees.map((worktree): DeliverBranchRecord => {
      const implementationSucceeded = worktree.run_id != null && successfulRunIds.has(worktree.run_id)
      const deliveryReady = implementationSucceeded && ['built', 'released'].includes(worktree.merge_state)
      return {
        ticketId: worktree.ticket_id,
        branch: worktree.branch,
        succeeded: deliveryReady,
        ...(worktree.run_id ? { runId: worktree.run_id } : {}),
        implementationOutcome: implementationSucceeded ? 'succeeded' : 'failed',
        deliveryOutcome: deliveryReady ? 'ready' : implementationSucceeded ? 'blocked' : 'not_started',
        changed: deliveryReady,
        ...(!deliveryReady && implementationSucceeded ? { failureCode: 'settlement_interrupted' as const } : {}),
      }
    })
    const readyCount = reconstructed.filter((unit) => unit.succeeded).length
    const implementationOutcome: PrImplementationOutcome = successfulRunIds.size === runs.length
      ? 'succeeded'
      : 'partially_succeeded'
    const canResumeFreshReview = row.is_continuation !== 1 && readyCount > 0
    const next: PrDecision = canResumeFreshReview ? 'on_review' : 'pr_failed'
    const deliveryOutcome: PrDeliveryOutcome = canResumeFreshReview
      ? (implementationOutcome === 'partially_succeeded' ? 'partial' : 'ready')
      : 'blocked'
    const statusCode: PrDeliveryStatusCode = canResumeFreshReview
      ? (implementationOutcome === 'partially_succeeded' ? 'partial_success' : 'ready_for_review')
      : 'settlement_interrupted'
    if (transitionDecision(db, row.id, 'building', next, {
      implementationOutcome,
      deliveryOutcome,
      statusCode,
      statusDetail: canResumeFreshReview
        ? 'Recovered committed implementation branches after an interrupted settlement.'
        : 'Implementation completed, but delivery settlement was interrupted before an exact deliverable could be proven.',
      ...(reconstructed.length > 0 ? { branches: reconstructed } : {}),
      ...(worktrees.length > 0 ? { worktreeIds: worktrees.map((worktree) => worktree.id) } : {}),
    })) {
      const updated = getPrDelivery(db, row.id)
      if (updated) reconciled.push(updated)
    }
  }

  return reconciled
}

/** Optional column updates riding a decision transition. */
export interface PrDeliveryPatch {
  branch?: string | null
  prUrl?: string | null
  prNumber?: number | null
  prState?: PrDeliveryState
  branches?: DeliverBranchRecord[]
  worktreeIds?: string[]
  runIds?: string[]
  implementationOutcome?: PrImplementationOutcome
  deliveryOutcome?: PrDeliveryOutcome
  statusCode?: PrDeliveryStatusCode | null
  statusDetail?: string | null
  deliverySha?: string | null
  isContinuation?: boolean
  supersedesDeliveryId?: string | null
  operation?: PrDecisionOperation | null
  operationToken?: string | null
  operationStartedAtMs?: number | null
  cleanupWarnings?: string[]
  safetyArchives?: string[]
  /** Settle-time deterministic harvest (migration 56); written once at settle. */
  settleEvidence?: DeliverySettleEvidence | null
}

// Column allow-list — patch keys are interpolated into the SET clause, so gate
// them to prevent any future caller injecting SQL via an object key (values
// are always parameterized). Mirrors loop-runs-store's COUNTER_COLUMNS.
const PATCH_COLUMNS: Record<keyof PrDeliveryPatch, string> = {
  branch: 'branch',
  prUrl: 'pr_url',
  prNumber: 'pr_number',
  prState: 'pr_state',
  branches: 'branches',
  worktreeIds: 'worktree_ids',
  runIds: 'run_ids',
  implementationOutcome: 'implementation_outcome',
  deliveryOutcome: 'delivery_outcome',
  statusCode: 'status_code',
  statusDetail: 'status_detail',
  deliverySha: 'delivery_sha',
  isContinuation: 'is_continuation',
  supersedesDeliveryId: 'supersedes_delivery_id',
  operation: 'operation',
  operationToken: 'operation_token',
  operationStartedAtMs: 'operation_started_at_ms',
  cleanupWarnings: 'cleanup_warnings',
  safetyArchives: 'safety_archives',
  settleEvidence: 'settle_evidence',
}

function patchValue(key: keyof PrDeliveryPatch, patch: PrDeliveryPatch): string | number | null {
  const raw = patch[key]
  if (key === 'branches' || key === 'worktreeIds' || key === 'runIds') return JSON.stringify(raw)
  if (key === 'cleanupWarnings') return JSON.stringify(boundCleanupWarnings(raw as string[]))
  if (key === 'safetyArchives') return JSON.stringify(normalizeSafetyArchives(raw as string[]))
  if (key === 'statusDetail') return raw == null ? null : boundPrDiagnostic(String(raw))
  if (key === 'isContinuation') return raw ? 1 : 0
  if (key === 'settleEvidence') return raw == null ? null : JSON.stringify(raw)
  return raw as string | number | null
}

/** Bounded, single-line diagnostics are safe to persist/broadcast as secondary
 * detail. Primary UI copy always derives from status_code. */
export function boundPrDiagnostic(value: string, maxLength = 512): string {
  return value.replace(/[\r\n\t\0]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, maxLength)
}

/** Cleanup is best-effort; retain enough unique warnings to be honest without
 * allowing unbounded command output to inflate every snapshot. */
export function boundCleanupWarnings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => boundPrDiagnostic(value)).filter(Boolean))].slice(0, 8)
}

/** Safety archive paths must remain exact filesystem locations. They are
 * internally generated pointers to bytes that still occupy disk, so dropping
 * an older pointer is never a valid payload-size optimization. Deduplicate
 * exact non-empty OS-representable paths without trimming them. */
export function normalizeSafetyArchives(values: readonly string[]): string[] {
  const newestUnique: string[] = []
  for (const value of values) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || value.includes('\0')) continue
    const previous = newestUnique.indexOf(value)
    if (previous >= 0) newestUnique.splice(previous, 1)
    newestUnique.push(value)
  }
  return newestUnique
}

export function mergeSafetyArchives(
  existing: readonly string[],
  additions: readonly string[],
): string[] {
  return normalizeSafetyArchives([...existing, ...additions])
}

/** Add one quarantine path independently of lifecycle state. Safety archives
 * are monotonic recovery metadata: a concurrent decision transition must not
 * erase a path created just before a crash. */
export function appendPrDeliverySafetyArchive(
  db: DbInstance,
  id: string,
  archive: string,
): string[] | null {
  return db.transaction(() => {
    const row = db.prepare(`SELECT safety_archives FROM rail_pr_deliveries WHERE id = ?`)
      .get(id) as { safety_archives: string } | undefined
    if (!row) return null
    const existing = normalizeSafetyArchives(
      parseJsonArray<unknown>(row.safety_archives ?? '[]')
        .filter((value): value is string => typeof value === 'string'),
    )
    const merged = mergeSafetyArchives(existing, [archive])
    db.prepare(`
      UPDATE rail_pr_deliveries
         SET safety_archives = ?, updated_at = ${NEXT_PR_UPDATED_AT_SQL}
       WHERE id = ?
    `).run(JSON.stringify(merged), id)
    return merged
  })()
}

/**
 * COMPARE-AND-SET decision transition: one atomic
 * `UPDATE … WHERE id = ? AND decision = ?` (no read-modify-write), so two
 * surfaces racing on the same delivery cannot both win. Returns `false` (row
 * untouched) when `expected` is stale — the caller maps that to a 409.
 * `patch` may set delivery columns alongside the transition; `updated_at` is
 * always bumped.
 */
export function transitionDecision(
  db: DbInstance,
  id: string,
  expected: PrDecision,
  next: PrDecision,
  patch: PrDeliveryPatch = {}
): boolean {
  const keys = (Object.keys(patch) as (keyof PrDeliveryPatch)[]).filter((k) => patch[k] !== undefined)
  const patchClause = keys.map((k) => `, ${PATCH_COLUMNS[k]} = ?`).join('')
  const values = keys.map((k) => patchValue(k, patch))
  return (
    db
      .prepare(
        `UPDATE rail_pr_deliveries
         SET decision = ?, updated_at = ${NEXT_PR_UPDATED_AT_SQL}${patchClause}
         WHERE id = ? AND decision = ?`
      )
      .run(next, ...values, id, expected).changes > 0
  )
}

/** Complete a decision transition only while the caller still owns the lease it
 * claimed before external effects. A reclaimed stale lease invalidates the old
 * worker's final CAS, so it cannot overwrite the newer owner's authoritative
 * state after eventually returning. */
export function transitionClaimedDecision(
  db: DbInstance,
  id: string,
  expected: PrDecision,
  next: PrDecision,
  operationToken: string,
  patch: PrDeliveryPatch = {},
): boolean {
  if (!operationToken) return false
  const keys = (Object.keys(patch) as (keyof PrDeliveryPatch)[]).filter((key) => patch[key] !== undefined)
  const patchClause = keys.map((key) => `, ${PATCH_COLUMNS[key]} = ?`).join('')
  const values = keys.map((key) => patchValue(key, patch))
  return db.prepare(`
    UPDATE rail_pr_deliveries
       SET decision = ?, updated_at = ${NEXT_PR_UPDATED_AT_SQL}${patchClause}
     WHERE id = ? AND decision = ? AND operation_token = ?
  `).run(next, ...values, id, expected, operationToken).changes > 0
}

/** Decision-side Git/GitHub effects must be claimed BEFORE they start. The
 * stale lease is reclaimable after a dead process; a live loser performs zero
 * external work. `expected` remains the visible decision throughout the effect
 * so the final decision transition keeps its existing CAS contract. */
export function claimPrDeliveryOperation(
  db: DbInstance,
  id: string,
  expected: PrDecision,
  operation: PrDecisionOperation,
  token: string,
  nowMs = Date.now(),
  leaseMs = 30 * 60 * 1000,
): boolean {
  if (!token) return false
  const staleBefore = nowMs - Math.max(1, leaseMs)
  return db.prepare(`
    UPDATE rail_pr_deliveries
       SET operation = ?, operation_token = ?, operation_started_at_ms = ?,
           updated_at = ${NEXT_PR_UPDATED_AT_SQL}
     WHERE id = ? AND decision = ?
       AND (operation_token IS NULL OR operation_started_at_ms IS NULL OR operation_started_at_ms < ?)
  `).run(operation, token, nowMs, id, expected, staleBefore).changes > 0
}

/** Release only the caller's lease. Works after a successful decision change,
 * too, so a handler can use one `finally` without racing a newer operation. */
export function releasePrDeliveryOperation(db: DbInstance, id: string, token: string): boolean {
  return db.prepare(`
    UPDATE rail_pr_deliveries
       SET operation = NULL, operation_token = NULL, operation_started_at_ms = NULL,
           updated_at = ${NEXT_PR_UPDATED_AT_SQL}
     WHERE id = ? AND operation_token = ?
  `).run(id, token).changes > 0
}

/** A process restart proves every persisted decision lease is orphaned: tokens
 * are process-local capabilities and no prior worker can still complete inside
 * this process. Clear them while startup admission is closed so reprojected
 * cards never remain permanently disabled as "Publishing…"/"Discarding…". */
export function clearOrphanedPrDeliveryOperations(db: DbInstance): number {
  return db.prepare(`
    UPDATE rail_pr_deliveries
       SET operation = NULL, operation_token = NULL, operation_started_at_ms = NULL,
           status_code = CASE
             WHEN decision NOT IN ('completed','merged','discarded','superseded')
              AND NOT (
                operation = 'recover-and-retry'
                AND status_code IN ('settlement_interrupted','recovery_unavailable')
              )
             THEN 'operation_interrupted'
             ELSE status_code
           END,
           status_detail = CASE
             WHEN decision NOT IN ('completed','merged','discarded','superseded')
              AND NOT (
                operation = 'recover-and-retry'
                AND status_code IN ('settlement_interrupted','recovery_unavailable')
              )
              AND (status_detail IS NULL OR status_detail = '')
             THEN 'A previous delivery action was interrupted by restart. Its durable evidence was preserved; review the current state and retry.'
             ELSE status_detail
           END,
           updated_at = ${NEXT_PR_UPDATED_AT_SQL}
     WHERE operation IS NOT NULL OR operation_token IS NOT NULL OR operation_started_at_ms IS NOT NULL
  `).run().changes
}

/**
 * The camelCase wire shape of a delivery row (JSON arrays parsed) — what the
 * rail.pr_state broadcast and the GET /rails prDeliveries record carry.
 */
export interface PrDeliverySnapshot {
  id: string
  railIndex: number
  loopId: string | null
  railKey: string
  ticketIds: number[]
  baseBranch: string
  branch: string | null
  prUrl: string | null
  prNumber: number | null
  prState: PrDeliveryState
  decision: PrDecision
  implementationOutcome: PrImplementationOutcome
  deliveryOutcome: PrDeliveryOutcome
  statusCode: PrDeliveryStatusCode | null
  statusDetail: string | null
  deliverySha: string | null
  isContinuation: boolean
  supersedesDeliveryId: string | null
  restoredFromDeliveryId: string | null
  operation: PrDecisionOperation | null
  cleanupWarnings: string[]
  safetyArchives: string[]
  branches: DeliverBranchRecord[]
  /** Alias used by cards; branches remains for backward-compatible APIs. */
  units: DeliverBranchRecord[]
  loopName: string
  worktreeIds: string[]
  /** The launch's loop-run ids, in ticket order (per-run log link + vitals). */
  runIds: string[]
  originSurface: PrOriginSurface
  originConversationId: string | null
  createdAt: string
  updatedAt: string
}

function parseJsonArray<T>(raw: string): T[] {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as T[]) : []
  } catch {
    return []
  }
}

export function toPrDeliverySnapshot(row: RailPrDeliveryRow): PrDeliverySnapshot {
  const units = parseJsonArray<DeliverBranchRecord>(row.branches)
  return {
    id: row.id,
    railIndex: row.rail_index,
    loopId: row.loop_id,
    railKey: row.rail_key,
    ticketIds: parseJsonArray<number>(row.ticket_ids),
    baseBranch: row.base_branch,
    branch: row.branch,
    prUrl: row.pr_url,
    prNumber: row.pr_number,
    prState: row.pr_state,
    decision: row.decision,
    implementationOutcome: row.implementation_outcome ?? 'unknown',
    deliveryOutcome: row.delivery_outcome ?? 'unknown',
    statusCode: row.status_code ?? null,
    statusDetail: row.status_detail ?? null,
    deliverySha: row.delivery_sha ?? null,
    isContinuation: row.is_continuation === 1,
    supersedesDeliveryId: row.supersedes_delivery_id ?? null,
    restoredFromDeliveryId: row.restored_from_delivery_id ?? null,
    operation: row.operation ?? null,
    cleanupWarnings: parseJsonArray<string>(row.cleanup_warnings ?? '[]'),
    safetyArchives: normalizeSafetyArchives(
      parseJsonArray<unknown>(row.safety_archives ?? '[]')
        .filter((value): value is string => typeof value === 'string'),
    ),
    branches: units,
    units,
    loopName: row.loop_name,
    worktreeIds: parseJsonArray<string>(row.worktree_ids),
    runIds: parseJsonArray<string>(row.run_ids ?? '[]'),
    originSurface: row.origin_surface,
    originConversationId: row.origin_conversation_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Build the durable `rail.pr_state` broadcast payload from a delivery snapshot
 * — the ONE message shape every mutation of the row re-broadcasts (launch
 * insert, build-settle, decision-endpoint transitions), so both decision
 * surfaces converge on the same state.
 */
export function toRailPrStateMessage(projectId: string, snap: PrDeliverySnapshot): RailPrStateMessage {
  return {
    type: 'rail.pr_state',
    projectId,
    railIndex: snap.railIndex,
    prDeliveryId: snap.id,
    railKey: snap.railKey,
    ticketIds: snap.ticketIds,
    baseBranch: snap.baseBranch,
    branch: snap.branch,
    prUrl: snap.prUrl,
    prNumber: snap.prNumber,
    prState: snap.prState,
    decision: snap.decision,
    implementationOutcome: snap.implementationOutcome,
    deliveryOutcome: snap.deliveryOutcome,
    statusCode: snap.statusCode,
    statusDetail: snap.statusDetail,
    deliverySha: snap.deliverySha,
    isContinuation: snap.isContinuation,
    supersedesDeliveryId: snap.supersedesDeliveryId,
    restoredFromDeliveryId: snap.restoredFromDeliveryId,
    operation: snap.operation,
    cleanupWarnings: snap.cleanupWarnings,
    safetyArchives: snap.safetyArchives,
    units: snap.units,
    runIds: snap.runIds,
    originConversationId: snap.originConversationId,
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
  }
}

/**
 * Build the agent-chat PR-decision card envelope from a delivery snapshot —
 * the ONE mapper both card writers (rail-isolated-launch's origin-card sync
 * and rail-pr-decision's finalizeTransition) share, so the persisted card and
 * the `agent_pr_decision` broadcast can never drift between the two sites.
 */
export function toPrDecisionCardEnvelope(projectId: string, snap: PrDeliverySnapshot): PrDecisionCardEnvelope {
  return {
    kind: 'pr_decision',
    prDeliveryId: snap.id,
    railIndex: snap.railIndex,
    projectId,
    baseBranch: snap.baseBranch,
    ticketIds: snap.ticketIds,
    decision: snap.decision,
    implementationOutcome: snap.implementationOutcome,
    deliveryOutcome: snap.deliveryOutcome,
    statusCode: snap.statusCode,
    statusDetail: snap.statusDetail,
    deliverySha: snap.deliverySha,
    isContinuation: snap.isContinuation,
    supersedesDeliveryId: snap.supersedesDeliveryId,
    restoredFromDeliveryId: snap.restoredFromDeliveryId,
    operation: snap.operation,
    cleanupWarnings: snap.cleanupWarnings,
    safetyArchives: snap.safetyArchives,
    units: snap.units,
    prUrl: snap.prUrl,
    prNumber: snap.prNumber,
    prState: snap.prState,
    branch: snap.branch,
    runIds: snap.runIds,
    createdAt: snap.createdAt,
    updatedAt: snap.updatedAt,
  }
}
