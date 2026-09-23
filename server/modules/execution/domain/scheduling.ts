export interface PendingJob {
  status: string
}

/** Preserve the first occurrence; remove stale IDs without relaunching terminal jobs. */
export function normalizePendingQueue(queue: readonly string[], jobs: ReadonlyMap<string, PendingJob>) {
  const seen = new Set<string>()
  const normalizedQueue: string[] = []
  const removedJobIds: string[] = []
  for (const id of queue) {
    if (seen.has(id)) continue
    seen.add(id)
    if (jobs.get(id)?.status === 'queued') normalizedQueue.push(id)
    else removedJobIds.push(id)
  }
  return { normalizedQueue, removedJobIds }
}

/** Historical/external missing dependencies are satisfied by the established contract. */
export function isDependencySatisfied(parentStatus: string | null): boolean {
  return parentStatus === null || parentStatus === 'completed'
}
