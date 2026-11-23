// Durable orphan-recovery outbox contract of QueueManager: the immutable
// terminal intent payload staged with every terminal row, its validation on
// replay (ticket ownership re-derived from the command) and the shared
// terminal-status vocabulary. Pure: no database or process access.
import type { Job, JobPriority } from '../../../types'
import type { JobResult } from '../../../db'
import type { InvocationStatus } from '../../accounting/runtime/ai-invocations'
import { VALID_PRIORITIES } from '../../../types'
import { extractTicketIdsFromCommand } from '../../specs/runtime/ticket-store'

export const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'zombie_terminated', 'skipped'])

export interface OrphanRecoveryPayload {
  id: string
  command: string
  ticketIds: number[]
  pipelineId: string | null
  startedAt: string
  finishedAt: string
  provider: string
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead: number | null
  tokensCacheCreate: number | null
  totalCostUsd: number | null
  totalCostUsdEstimated: number | null
  numTurns: number | null
  durationMs: number | null
  durationApiMs: number | null
  sessionId: string | null
  /** Explicit terminal semantics for current outbox rows. Payloads written by
   * older builds omit these fields and replay as failed/aborted. */
  terminalStatus?: Exclude<Job['status'], 'queued' | 'running'>
  invocationStatus?: InvocationStatus
  ticketCompletionStatus?: 'done' | 'on_review'
  exitCode?: number | null
  /** Force-failed job whose child is still alive. Keep the completed outbox row
   * until its late close durably replaces the partial usage snapshot. */
  awaitingLateReconciliation?: boolean
  /** Exact recursive pre-start descendants captured before the parent becomes
   * deletable. Old payloads omit it and use dependency links as fallback. */
  descendants?: OrphanRecoveryDescendant[]
  causalOwnership?: boolean
}

export interface OrphanRecoveryDescendant {
  id: string
  command: string
  parentId: string
  pipelineId: string | null
  priority: JobPriority
  causalOwnership?: boolean
}

export interface OrphanRecoveryRow {
  job_id: string
  payload: string
  accounting_completed: number
  callback_completed: number
  terminal_completed: number
}

export interface JobFinishedOptions {
  ticketCompletionStatus?: 'done' | 'on_review'
  /** Marks an at-least-once delivery from the durable orphan outbox. */
  recoveryReplay?: boolean
  /** Durable callback inputs. Recovery must not depend on a deletable jobs row. */
  recoveryCommand?: string
  recoveryTicketIds?: number[]
  recoveryDurationMs?: number | null
  recoveryCausalOwnership?: boolean
}

export interface StageTerminalIntent {
  status: Exclude<Job['status'], 'queued' | 'running'>
  invocationStatus: InvocationStatus
  provider: string
  finishedAt: string
  exitCode: number | null
  result?: Partial<JobResult>
  interactive?: boolean
  ticketCompletionStatus?: 'done' | 'on_review'
  /** True for work that never reached a provider (queued cancel/skip). */
  accountingCompleted?: boolean
  /** A caller that already terminalized descendants in the same transaction
   * still leaves this false: replay delivers their callbacks idempotently. */
  terminalCompleted?: boolean
  descendants?: OrphanRecoveryDescendant[]
  /** Queued cancellation may have an unresolved queued parent that cannot be
   * referenced from jobs yet; pass null while retaining descendant ownership. */
  dependsOnJobId?: string | null
  awaitingLateReconciliation?: boolean
}

export interface DecodedOrphanRecovery {
  payload: OrphanRecoveryPayload
  terminalStatus: Exclude<Job['status'], 'queued' | 'running'>
  invocationStatus: InvocationStatus
}

export function decodeOrphanRecoveryPayload(
  jobId: string,
  encoded: string,
): DecodedOrphanRecovery {
  const payload = JSON.parse(encoded) as OrphanRecoveryPayload
  if (!payload || typeof payload !== 'object') throw new Error('payload is not an object')
  if (typeof payload.command !== 'string') throw new Error('payload command is invalid')
  // Ticket ownership is derived from the immutable command, never trusted
  // from a legacy/corrupt payload. This also repairs pre-fix [0]/overflow ids.
  payload.ticketIds = extractTicketIdsFromCommand(payload.command)
  payload.totalCostUsdEstimated ??= 0
  const terminalStatus = payload.terminalStatus ?? 'failed'
  const invocationStatus = payload.invocationStatus ?? 'aborted'
  const nullableNumber = (value: unknown): boolean =>
    value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
  if (
    payload.id !== jobId ||
    typeof payload.startedAt !== 'string' ||
    typeof payload.finishedAt !== 'string' ||
    typeof payload.provider !== 'string' || !payload.provider ||
    (payload.pipelineId !== null && typeof payload.pipelineId !== 'string') ||
    !payload.ticketIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
    !nullableNumber(payload.tokensIn) ||
    !nullableNumber(payload.tokensOut) ||
    !nullableNumber(payload.tokensCacheRead) ||
    !nullableNumber(payload.tokensCacheCreate) ||
    !nullableNumber(payload.totalCostUsd) ||
    !nullableNumber(payload.numTurns) ||
    !nullableNumber(payload.durationMs) ||
    !nullableNumber(payload.durationApiMs) ||
    (payload.totalCostUsdEstimated !== 0 && payload.totalCostUsdEstimated !== 1) ||
    (payload.exitCode != null && !Number.isInteger(payload.exitCode)) ||
    (payload.model !== null && typeof payload.model !== 'string') ||
    (payload.sessionId !== null && typeof payload.sessionId !== 'string') ||
    (payload.causalOwnership !== undefined && typeof payload.causalOwnership !== 'boolean') ||
    (payload.awaitingLateReconciliation !== undefined && typeof payload.awaitingLateReconciliation !== 'boolean') ||
    (payload.ticketCompletionStatus !== undefined && !['done', 'on_review'].includes(payload.ticketCompletionStatus)) ||
    !TERMINAL_STATUSES.has(terminalStatus) ||
    !['success', 'failed', 'aborted'].includes(invocationStatus) ||
    (payload.descendants !== undefined && (
      !Array.isArray(payload.descendants) ||
      !payload.descendants.every((descendant) =>
        descendant && typeof descendant.id === 'string' &&
        typeof descendant.command === 'string' &&
        typeof descendant.parentId === 'string' &&
        (descendant.pipelineId === null || typeof descendant.pipelineId === 'string') &&
        VALID_PRIORITIES.has(descendant.priority) &&
        (descendant.causalOwnership === undefined || typeof descendant.causalOwnership === 'boolean')
      )
    ))
  ) {
    throw new Error('payload identity or fields are invalid')
  }
  return { payload, terminalStatus, invocationStatus }
}
