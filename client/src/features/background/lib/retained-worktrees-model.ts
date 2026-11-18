import type { RunState } from '../../../components/ui/run-state/run-state'
import type { RetainedSize, RetainedWorktree } from './retained-worktrees-api'

export type RetainedLabelFilter = 'all' | 'nothing-to-lose' | 'waiting-for-you'
export const IDLE_FILTERS = [0, 7, 30] as const
export const SIZE_FILTERS_MB = [0, 100, 1024] as const

export const retainedKey = (item: { projectId: string; id: string }): string => `${item.projectId}\0${item.id}`

/**
 * The status vocabulary for a retained worktree: something running in it is
 * `working`; "Nothing to lose" is `done` (removing it is safe); anything else
 * waits for the person's decision (`review`).
 */
export function retainedRunState(item: RetainedWorktree): RunState {
  if (item.evaluation.reasons.includes('run-active')) return 'working'
  return item.evaluation.label === 'nothing-to-lose' ? 'done' : 'review'
}

export interface RetainedFilters {
  label: RetainedLabelFilter
  minIdleDays: number
  minSizeMb: number
}

/** A size filter only hides worktrees whose size is known to be smaller. */
export function matchesFilters(item: RetainedWorktree, size: RetainedSize | undefined, filters: RetainedFilters): boolean {
  if (filters.label !== 'all' && item.evaluation.label !== filters.label) return false
  if (filters.minIdleDays > 0 && (item.idleDays === null || item.idleDays < filters.minIdleDays)) return false
  if (filters.minSizeMb > 0 && size?.status === 'done' && size.bytes < filters.minSizeMb * 1024 * 1024) return false
  return true
}

export interface RetainedProjectGroup {
  projectId: string
  projectName: string
  items: RetainedWorktree[]
}

/** Group by project (in the server's project order), waiting items first, then the idlest. */
export function groupByProject(items: readonly RetainedWorktree[], order: readonly string[]): RetainedProjectGroup[] {
  const groups = new Map<string, RetainedProjectGroup>()
  for (const item of items) {
    const group = groups.get(item.projectId) ?? { projectId: item.projectId, projectName: item.projectName, items: [] }
    group.items.push(item)
    groups.set(item.projectId, group)
  }
  const rank = (id: string) => { const index = order.indexOf(id); return index < 0 ? Number.MAX_SAFE_INTEGER : index }
  for (const group of groups.values()) {
    group.items.sort((a, b) => (b.idleDays ?? -1) - (a.idleDays ?? -1) || a.worktreePath.localeCompare(b.worktreePath))
  }
  return [...groups.values()].sort((a, b) => rank(a.projectId) - rank(b.projectId))
}

/** Bytes of the known sizes among `items`, and whether any is still unknown. */
export function knownBytes(items: readonly RetainedWorktree[], sizes: ReadonlyMap<string, RetainedSize>): { bytes: number; partial: boolean } {
  let bytes = 0
  let partial = false
  for (const item of items) {
    const size = sizes.get(retainedKey(item))
    if (size?.status === 'done') bytes += size.bytes
    else partial = true
  }
  return { bytes, partial }
}
