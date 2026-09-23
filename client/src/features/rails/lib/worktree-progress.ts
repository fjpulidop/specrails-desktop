/**
 * Client-side accumulation of `rail.worktree_progress` WS events for the parallel
 * (worktree-isolated) rail launch. Pure + tested; the dashboard feeds events in
 * and renders the per-rail summary. The server only broadcasts the terminal
 * states (`merged` / `needs-review`), but the type covers the full lifecycle for
 * forward-compat.
 */
export type WorktreeState = 'building' | 'built' | 'merging' | 'merged' | 'needs-review' | 'failed'

/** railIndex → (ticketId → its latest worktree/merge state). */
export type RailWorktreeMap = Record<number, Record<number, WorktreeState>>

/** Immutably record one ticket's latest state for a rail. */
export function applyWorktreeProgress(
  map: RailWorktreeMap,
  railIndex: number,
  ticketId: number,
  state: WorktreeState
): RailWorktreeMap {
  return { ...map, [railIndex]: { ...(map[railIndex] ?? {}), [ticketId]: state } }
}

/** Drop a rail's accumulated progress (e.g. when it is relaunched or cleared). */
export function clearRailProgress(map: RailWorktreeMap, railIndex: number): RailWorktreeMap {
  if (!(railIndex in map)) return map
  const next = { ...map }
  delete next[railIndex]
  return next
}

export interface WorktreeSummary {
  merged: number
  needsReview: number
  failed: number
  /** Tickets that have reported any state. */
  reported: number
}

/** Summarise a rail's per-ticket states, or null when nothing has been reported. */
export function worktreeSummary(perTicket: Record<number, WorktreeState> | undefined): WorktreeSummary | null {
  if (!perTicket) return null
  const states = Object.values(perTicket)
  if (states.length === 0) return null
  let merged = 0
  let needsReview = 0
  let failed = 0
  for (const s of states) {
    if (s === 'merged') merged++
    else if (s === 'needs-review') needsReview++
    else if (s === 'failed') failed++
  }
  return { merged, needsReview, failed, reported: states.length }
}
