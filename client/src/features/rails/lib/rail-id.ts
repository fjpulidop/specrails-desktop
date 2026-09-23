/**
 * Canonical mapping between a client rail id (`rail-N`, 1-based) and its server
 * railIndex (0-based). This is the ONE identity binding for every server call
 * (launch/stop/tickets/profile/engine/name) and every railIndex-keyed lookup
 * (metrics, PR decisions, worktree progress) — array POSITION is never used, so
 * reordering rails on the board or deleting a middle rail can't cross wires.
 */

/** Hard cap on rails per project (mirror of the server's MAX_RAILS). */
export const MAX_RAILS = 12

/** Client rail id for a server railIndex: 0 → 'rail-1'. */
export function railIdFromIndex(railIndex: number): string {
  return `rail-${railIndex + 1}`
}

/**
 * Server railIndex for a client rail id: 'rail-1' → 0. Returns null when the
 * id is not the canonical `rail-<positive int>` shape (legacy/test fixtures) —
 * callers fall back to array position for those.
 */
export function railIndexFromId(railId: string): number | null {
  const m = /^rail-(\d+)$/.exec(railId)
  if (!m) return null
  const n = parseInt(m[1], 10)
  if (!Number.isInteger(n) || n < 1) return null
  return n - 1
}
