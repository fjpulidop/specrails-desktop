/** Persists in-flight spec generation across page refreshes and project switches */

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return m > 0 ? `${m}:${(s % 60).toString().padStart(2, '0')}` : `${s}s`
}


export interface PendingSpec {
  /** requestId (fast mode) or conversationId (explore mode) */
  id: string
  /** Ticket IDs known at submit time — used to detect the newly-created ticket */
  knownTicketIds: number[]
  projectId: string
  projectName: string
  startTime: number
  /** Truncated idea text shown in the toast */
  truncated: string
}

const KEY = 'specrails-desktop:pending-specs'

export function readPendingSpecs(): PendingSpec[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function savePendingSpec(spec: PendingSpec): void {
  try {
    // Deduplicate by id
    const list = readPendingSpecs().filter(s => s.id !== spec.id)
    list.push(spec)
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch { /* ignore */ }
}

export function removePendingSpec(id: string): void {
  try {
    const list = readPendingSpecs().filter(s => s.id !== id)
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch { /* ignore */ }
}
