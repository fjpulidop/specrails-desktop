import type { RunState } from '../../../components/ui/run-state/run-state'

/** Server merge preview of one delivery (server/modules/delivery/domain/merge-preview.ts). */
export type MergePreviewStatus = 'clean' | 'conflicts' | 'already_merged' | 'unknown'

export interface SiblingConflict {
  deliveryId: string
  railIndex: number
  files: string[]
  fileCount: number
}

export interface DeliveryMergePreview {
  deliveryId: string
  railIndex: number
  baseRef: string
  baseSha: string | null
  status: MergePreviewStatus
  conflictFiles: string[]
  conflictFileCount: number
  baseAdvancedBy: number | null
  siblings: SiblingConflict[]
  reason: string | null
  computedAt: string
}

/** What a live board card carries. */
export interface MergePreviewSummary {
  status: MergePreviewStatus
  conflictFileCount: number
  siblingConflictCount: number
  baseAdvancedBy: number | null
}

/**
 * The run-state look of a preview, or null when there is nothing worth a
 * lamp: conflicts with the base or with a sibling read as `blocked` (the
 * warning look: the merge cannot go in as it stands); a change that already
 * landed reads as `done`. A clean merge or an unknown one draws no lamp.
 */
export function mergePreviewRunState(summary: Pick<MergePreviewSummary, 'status' | 'siblingConflictCount'>): RunState | null {
  if (summary.status === 'conflicts' || summary.siblingConflictCount > 0) return 'blocked'
  if (summary.status === 'already_merged') return 'done'
  return null
}

export function summarize(preview: DeliveryMergePreview): MergePreviewSummary {
  return {
    status: preview.status,
    conflictFileCount: preview.conflictFileCount,
    siblingConflictCount: preview.siblings.length,
    baseAdvancedBy: preview.baseAdvancedBy,
  }
}

/** The base branch name as people say it (`origin/main` → `main`). */
export function baseName(baseRef: string): string {
  return baseRef.startsWith('origin/') ? baseRef.slice('origin/'.length) : baseRef
}
