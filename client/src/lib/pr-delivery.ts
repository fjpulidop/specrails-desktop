import type {
  RailDeliveryOutcome,
  RailImplementationOutcome,
  RailPrDecision,
  RailPrStateSnapshot,
  RailPrUnitOutcome,
} from '../types'

const DECISIONS: ReadonlySet<string> = new Set([
  'building', 'on_review', 'pr_draft', 'pr_ready', 'no_changes', 'completed', 'pr_closed',
  'superseded', 'merged', 'discarded', 'implementation_failed', 'pr_failed',
])
const PR_STATES: ReadonlySet<string> = new Set(['none', 'local-only', 'pushed', 'pr-created'])
const IMPLEMENTATION_OUTCOMES: ReadonlySet<string> = new Set([
  'running', 'succeeded', 'partially_succeeded', 'failed', 'unknown',
])
const DELIVERY_OUTCOMES: ReadonlySet<string> = new Set([
  'pending', 'ready', 'delivered', 'partial', 'no_changes',
  'retryable_failure', 'blocked', 'not_started', 'unknown',
])
const OPERATIONS: ReadonlySet<string> = new Set([
  'create-pr', 'publish', 'discard', 'poll-merge', 'merge-local', 'dismiss', 'reopen', 'acknowledge-no-changes',
])
const STATUS_CODES: ReadonlySet<string> = new Set([
  'implementation_running', 'implementation_failed', 'ready_for_review',
  'partial_success', 'partial_delivery', 'existing_pr_updated', 'no_changes',
  'commit_failed', 'branch_verification_failed', 'push_failed',
  'settlement_interrupted', 'operation_interrupted', 'delivery_failed', 'pr_draft_ready', 'pr_ready',
  'pr_closed', 'merged', 'discarded', 'superseded', 'cleanup_incomplete',
  // Conservative legacy aliases retained by old recovered rows.
  'status_failed', 'ref_mismatch',
])

/** Stable machine statuses that have localized primary copy on both surfaces. */
export function isKnownPrDeliveryStatusCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && STATUS_CODES.has(code)
}

const INTERRUPTED_OPERATION_DETAIL_FRAGMENT = 'previous delivery action was interrupted by restart'

/** Stable-code detection with a narrow legacy-detail fallback for snapshots
 * emitted before `operation_interrupted` was added to the wire contract. */
export function isInterruptedPrDeliveryOperation(
  statusCode: string | null | undefined,
  statusDetail: string | null | undefined,
): boolean {
  return statusCode === 'operation_interrupted'
    || (typeof statusDetail === 'string' && statusDetail.toLowerCase().includes(INTERRUPTED_OPERATION_DETAIL_FRAGMENT))
}

const asString = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null
const asNullableString = (v: unknown): string | null => typeof v === 'string' && v.length > 0 ? v : null

function parseDurableTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  // SQLite's datetime('now') wire value is UTC but omits both `T` and `Z`.
  // Normalize that exact durable shape before falling back to ordinary ISO.
  const sqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value
  const parsed = Date.parse(sqliteUtc)
  return Number.isFinite(parsed) ? parsed : null
}

/** Compare two durable PR snapshot versions by `updatedAt`.
 *
 * Returns the INCOMING snapshot's order relative to CURRENT, or `null` when
 * either timestamp is absent/malformed. Equal timestamps are intentionally
 * explicit: SQLite stores these values at one-second precision, so callers
 * must not mistake a tie for proof that a conflicting payload is newer.
 */
export function comparePrSnapshotUpdatedAt(
  current: string | null | undefined,
  incoming: string | null | undefined,
): -1 | 0 | 1 | null {
  const currentMs = parseDurableTimestamp(current)
  const incomingMs = parseDurableTimestamp(incoming)
  if (currentMs == null || incomingMs == null) return null
  if (incomingMs < currentMs) return -1
  if (incomingMs > currentMs) return 1
  return 0
}

function coerceUnit(v: unknown): RailPrUnitOutcome | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.ticketId !== 'number' || !Number.isFinite(o.ticketId) || typeof o.branch !== 'string') return null
  const implementationOutcome = typeof o.implementationOutcome === 'string' && IMPLEMENTATION_OUTCOMES.has(o.implementationOutcome)
    ? o.implementationOutcome as RailImplementationOutcome
    : undefined
  const deliveryOutcome = typeof o.deliveryOutcome === 'string' && DELIVERY_OUTCOMES.has(o.deliveryOutcome)
    ? o.deliveryOutcome as RailDeliveryOutcome
    : undefined
  return {
    ticketId: o.ticketId,
    branch: o.branch,
    succeeded: o.succeeded === true,
    ...(asString(o.runId) ? { runId: asString(o.runId) } : {}),
    ...(implementationOutcome ? { implementationOutcome } : {}),
    ...(deliveryOutcome ? { deliveryOutcome } : {}),
    initialSha: asNullableString(o.initialSha),
    finalSha: asNullableString(o.finalSha),
    ...(typeof o.changed === 'boolean' ? { changed: o.changed } : {}),
    failureCode: asNullableString(o.failureCode),
    ...(o.branchOwnership === 'created' || o.branchOwnership === 'preexisting' || o.branchOwnership === 'borrowed-pr'
      ? { branchOwnership: o.branchOwnership }
      : {}),
  }
}

/** Tolerant wire coercion used by HTTP action snapshots and GET /rails hydration. */
export function coerceRailPrStateSnapshot(v: unknown, fallbackRailIndex?: number): RailPrStateSnapshot | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const prDeliveryId = asString(o.prDeliveryId) ?? asString(o.id)
  const railIndex = typeof o.railIndex === 'number' && Number.isFinite(o.railIndex) ? o.railIndex : fallbackRailIndex
  if (!prDeliveryId || railIndex == null || typeof o.decision !== 'string' || !DECISIONS.has(o.decision)) return null
  const implementationOutcome = typeof o.implementationOutcome === 'string' && IMPLEMENTATION_OUTCOMES.has(o.implementationOutcome)
    ? o.implementationOutcome as RailImplementationOutcome
    : undefined
  const deliveryOutcome = typeof o.deliveryOutcome === 'string' && DELIVERY_OUTCOMES.has(o.deliveryOutcome)
    ? o.deliveryOutcome as RailDeliveryOutcome
    : undefined
  const rawUnits = Array.isArray(o.units) ? o.units : Array.isArray(o.branches) ? o.branches : []
  const units = rawUnits.map(coerceUnit).filter((unit): unit is RailPrUnitOutcome => unit !== null)
  return {
    prDeliveryId,
    railIndex,
    railKey: typeof o.railKey === 'string' ? o.railKey : '',
    ticketIds: Array.isArray(o.ticketIds) ? o.ticketIds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [],
    baseBranch: typeof o.baseBranch === 'string' ? o.baseBranch : '',
    branch: asNullableString(o.branch),
    prUrl: asNullableString(o.prUrl),
    prNumber: typeof o.prNumber === 'number' && Number.isInteger(o.prNumber) && o.prNumber > 0 ? o.prNumber : null,
    prState: typeof o.prState === 'string' && PR_STATES.has(o.prState)
      ? o.prState as RailPrStateSnapshot['prState']
      : 'none',
    decision: o.decision as RailPrDecision,
    runIds: Array.isArray(o.runIds)
      ? o.runIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
      : units.map((unit) => unit.runId).filter((id): id is string => typeof id === 'string' && id.length > 0),
    originConversationId: asNullableString(o.originConversationId),
    createdAt: typeof o.createdAt === 'string' ? o.createdAt : undefined,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : undefined,
    ...(implementationOutcome ? { implementationOutcome } : {}),
    ...(deliveryOutcome ? { deliveryOutcome } : {}),
    statusCode: asNullableString(o.statusCode),
    statusDetail: asNullableString(o.statusDetail),
    deliverySha: asNullableString(o.deliverySha),
    isContinuation: o.isContinuation === true,
    supersedesDeliveryId: asNullableString(o.supersedesDeliveryId),
    restoredFromDeliveryId: asNullableString(o.restoredFromDeliveryId),
    operation: typeof o.operation === 'string' && OPERATIONS.has(o.operation)
      ? o.operation as RailPrStateSnapshot['operation']
      : null,
    cleanupWarnings: Array.isArray(o.cleanupWarnings)
      ? o.cleanupWarnings.filter((warning): warning is string => typeof warning === 'string' && warning.length > 0)
      : [],
    safetyArchives: Array.isArray(o.safetyArchives)
      ? o.safetyArchives.filter((archive): archive is string => typeof archive === 'string' && archive.length > 0)
      : [],
    units,
  }
}

export interface PrDeliverySemanticInput {
  decision: RailPrDecision
  ticketIds: number[]
  prUrl: string | null
  prState: RailPrStateSnapshot['prState']
  implementationOutcome?: RailImplementationOutcome
  deliveryOutcome?: RailDeliveryOutcome
  statusCode?: string | null
  statusDetail?: string | null
  isContinuation?: boolean
  cleanupWarnings?: string[]
  safetyArchives?: string[]
  units?: RailPrUnitOutcome[]
}

export interface PrDeliveryPresentation {
  noChanges: boolean
  partial: boolean
  partialUndeliverable: boolean
  implementationFailed: boolean
  deliveryBlocked: boolean
  retryablePush: boolean
  retryablePrCreation: boolean
  continuation: boolean
  localOnly: boolean
  closed: boolean
  superseded: boolean
  terminal: boolean
  succeededCount: number
  deliverableCount: number
  failedCount: number
  totalCount: number
  units: RailPrUnitOutcome[]
  cleanupWarnings: string[]
  safetyArchives: string[]
}

/** ONE semantic derivation shared by dashboard and agent-chat cards. */
export function derivePrDeliveryPresentation(input: PrDeliverySemanticInput): PrDeliveryPresentation {
  const units = input.units ?? []
  const succeededCount = units.length > 0
    ? units.filter((u) => u.implementationOutcome === 'succeeded' || (u.implementationOutcome == null && u.succeeded)).length
    : input.implementationOutcome === 'failed' ? 0 : input.ticketIds.length
  const failedCount = units.length > 0
    ? units.filter((u) => u.implementationOutcome === 'failed' || (u.implementationOutcome == null && !u.succeeded)).length
    : input.implementationOutcome === 'failed' ? input.ticketIds.length : 0
  const noChanges = input.decision === 'no_changes' || input.decision === 'completed' || input.deliveryOutcome === 'no_changes' || input.statusCode === 'no_changes'
  const partial = input.implementationOutcome === 'partially_succeeded' || input.deliveryOutcome === 'partial' || (succeededCount > 0 && failedCount > 0)
  const deliverableCount = units.length > 0
    ? units.filter((u) => u.deliveryOutcome === 'ready' || u.deliveryOutcome === 'delivered' || (u.deliveryOutcome == null && u.succeeded)).length
    : partial ? 0 : succeededCount
  const partialUndeliverable = partial && deliverableCount === 0
  // Legacy implementation_failed rows had no orthogonal outcome. Preserve their
  // old rendering, but never let a successful implementation inherit that copy.
  const implementationFailed = input.implementationOutcome === 'failed' || (
    input.implementationOutcome == null && input.decision === 'implementation_failed'
  )
  const retryableFailure = input.deliveryOutcome === 'retryable_failure'
  // Outcome precedence is deliberately exclusive. Historical recovery rows can
  // retain a blocked-looking status code (notably settlement_interrupted) after
  // the exact commit has become retryable, while an implementation failure may
  // also carry delivery diagnostics. Neither must steal the card from the more
  // actionable/truthful state.
  const deliveryBlocked = !implementationFailed && !retryableFailure && (
    partialUndeliverable || input.deliveryOutcome === 'blocked' || [
      'commit_failed', 'branch_verification_failed', 'settlement_interrupted',
      'status_failed', 'ref_mismatch', 'delivery_failed',
    ].includes(input.statusCode ?? '')
  )
  // Card/ticket semantics follow the durable generation contract. Per-unit
  // branch ownership is a cleanup constraint only: a fresh replacement PR can
  // borrow or predate a branch and still be safely discarded without deleting
  // that protected ref. Startup repairs legacy continuation bits before
  // actions are admitted, so presentation must not infer them from failures or
  // ownership.
  const continuation = input.isContinuation === true
  const retryablePush = !implementationFailed && retryableFailure && (
    input.statusCode === 'push_failed' || continuation || Boolean(input.prUrl)
  )
  const retryablePrCreation = !implementationFailed && retryableFailure && !retryablePush
  const closed = input.decision === 'pr_closed'
  const superseded = input.decision === 'superseded'
  return {
    noChanges,
    partial,
    partialUndeliverable,
    implementationFailed,
    deliveryBlocked,
    retryablePush,
    retryablePrCreation,
    continuation,
    localOnly: input.prState === 'local-only',
    closed,
    superseded,
    terminal: input.decision === 'merged' || input.decision === 'discarded' || input.decision === 'completed' || superseded,
    succeededCount,
    deliverableCount,
    failedCount,
    totalCount: units.length > 0 ? units.length : input.ticketIds.length,
    units,
    cleanupWarnings: input.cleanupWarnings ?? [],
    safetyArchives: input.safetyArchives ?? [],
  }
}
