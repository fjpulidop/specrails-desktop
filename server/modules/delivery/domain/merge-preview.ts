/**
 * Merge preview: pure vocabulary and rules. Whether each pending delivery
 * would merge cleanly into its base as the base stands NOW, how far the base
 * moved since the delivery was cut, and which pending siblings touch the same
 * lines. Facts come from `runtime/merge-preview.ts` (Git, no checkout); this
 * file only shapes, summarizes and orders them.
 */

export type MergePreviewStatus = 'clean' | 'conflicts' | 'already_merged' | 'unknown'

export interface SiblingConflict {
  deliveryId: string
  railIndex: number
  /** First conflicted paths (capped); `fileCount` is the full count. */
  files: string[]
  fileCount: number
}

export interface DeliveryMergePreview {
  deliveryId: string
  railIndex: number
  /** The ref compared against (`origin/<base>` when it exists, else `<base>`). */
  baseRef: string
  baseSha: string | null
  /** Aggregate over the delivery's branches (worst first: conflicts > unknown > clean > already_merged). */
  status: MergePreviewStatus
  /** Paths that conflict with the current base (capped); `conflictFileCount` is the full count. */
  conflictFiles: string[]
  conflictFileCount: number
  /** Commits on the base the delivery does not have; null when unknown. */
  baseAdvancedBy: number | null
  /** Pending deliveries on the same base whose changes conflict with this one. */
  siblings: SiblingConflict[]
  /** Why the status is `unknown` (Git too old, a ref that no longer resolves…). */
  reason: string | null
  computedAt: string
}

/** What a live board card needs. */
export interface MergePreviewSummary {
  status: MergePreviewStatus
  conflictFileCount: number
  siblingConflictCount: number
  baseAdvancedBy: number | null
}

export function summarizeMergePreview(preview: DeliveryMergePreview): MergePreviewSummary {
  return {
    status: preview.status,
    conflictFileCount: preview.conflictFileCount,
    siblingConflictCount: preview.siblings.length,
    baseAdvancedBy: preview.baseAdvancedBy,
  }
}

const STATUS_RANK: Readonly<Record<MergePreviewStatus, number>> = { conflicts: 3, unknown: 2, clean: 1, already_merged: 0 }

/** The worst of several branch statuses (a delivery may carry several branches). */
export function worstStatus(statuses: readonly MergePreviewStatus[]): MergePreviewStatus {
  if (statuses.length === 0) return 'unknown'
  return statuses.reduce((worst, next) => (STATUS_RANK[next] > STATUS_RANK[worst] ? next : worst))
}

/** True when the preview should read as a warning (the `blocked` look). */
export function mergePreviewNeedsAttention(summary: Pick<MergePreviewSummary, 'status' | 'siblingConflictCount'>): boolean {
  return summary.status === 'conflicts' || summary.siblingConflictCount > 0
}

export interface MergeOrderFacts {
  ticketId: number
  /** Conflicted paths against the current base; null when unknown. */
  baseConflicts: number | null
  /** How many sibling candidates it conflicts with. */
  siblingConflicts: number
}

/**
 * Merge-back order key: candidates that merge cleanly into the base first,
 * unknown next, conflicting last (fewest conflicted paths first); then the
 * fewest sibling conflicts, so the most entangled one integrates onto the most
 * complete base. Returns a comparator; ties fall through to the caller's
 * existing order (touch-list overlap, ticket id).
 */
export function compareForMergeBack(a: MergeOrderFacts, b: MergeOrderFacts): number {
  const tier = (f: MergeOrderFacts): number => (f.baseConflicts === 0 ? 0 : f.baseConflicts === null ? 1 : 2)
  return tier(a) - tier(b)
    || (a.baseConflicts ?? 0) - (b.baseConflicts ?? 0)
    || a.siblingConflicts - b.siblingConflicts
}
