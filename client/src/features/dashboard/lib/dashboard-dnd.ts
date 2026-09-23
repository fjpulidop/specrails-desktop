import type { UniqueIdentifier } from '@dnd-kit/core'

/**
 * Insert `itemId` immediately before `beforeId` in `arr`. Falls back to
 * appending when `beforeId` is not found. Returns the array unchanged when
 * `beforeId === itemId` so a stray self-collision during drag-end can't
 * silently displace the item to the end of the list.
 */
export function insertAt(arr: number[], itemId: number, beforeId: UniqueIdentifier): number[] {
  if (typeof beforeId === 'number' && beforeId === itemId) return arr
  if (typeof beforeId === 'number' && arr.includes(beforeId)) {
    const idx = arr.indexOf(beforeId)
    const next = [...arr]
    next.splice(idx, 0, itemId)
    return next
  }
  return [...arr, itemId]
}

/**
 * Resolve the destination container for a ticket drag, given the raw
 * `over.id` from `useDndContext` / `handleDragEnd`.
 *
 * - String matching `containerIds` → returns it directly (`specs`, `done-specs`, `rail-N`).
 * - String matching `isRailSortId(...)` → returns the underlying rail id via `extractRailId`.
 *   This is the bug-fix path: a ticket dropped on the rail-sort wrapper would
 *   otherwise leak through and be ignored.
 * - Numeric ticket id → caller must look up its container via `findTicketContainer`.
 * - Anything else → returns `null` so the caller can fall back to source.
 */
export function resolveDestContainer(
  overId: UniqueIdentifier,
  containerIds: Set<string>,
  findTicketContainer: (id: number) => string | null,
  isRailSortId: (id: string | number) => id is string,
  extractRailId: (id: string) => string,
): string | null {
  if (typeof overId === 'string') {
    if (isRailSortId(overId)) {
      const rid = extractRailId(overId)
      return containerIds.has(rid) ? rid : null
    }
    return containerIds.has(overId) ? overId : null
  }
  if (typeof overId === 'number') {
    const found = findTicketContainer(overId)
    return found && containerIds.has(found) ? found : null
  }
  return null
}
