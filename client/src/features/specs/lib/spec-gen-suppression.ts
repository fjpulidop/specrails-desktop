// Suppresses redundant "New ticket: ..." toasts in useTickets when the
// ticket originated from a spec-gen flow that already shows its own
// rich toast (project · title, "Generated in Xs", View action).
//
// useSpecGenTracker calls mark/unmark around the spec-gen lifecycle.
// useTickets checks isActive before firing ticket_created toasts.
//
// Refcounted (concurrent specs in same project) + 2s grace after
// unmark so a slightly-late ticket_created WS frame is still
// suppressed.

const counts = new Map<string, number>()
const GRACE_MS = 2000

export function markSpecGenInFlight(projectId: string): void {
  counts.set(projectId, (counts.get(projectId) ?? 0) + 1)
}

export function unmarkSpecGenInFlight(projectId: string): void {
  const cur = counts.get(projectId) ?? 0
  if (cur <= 0) return
  setTimeout(() => {
    const next = (counts.get(projectId) ?? 0) - 1
    if (next <= 0) counts.delete(projectId)
    else counts.set(projectId, next)
  }, GRACE_MS)
}

export function isSpecGenInFlight(projectId: string | null | undefined): boolean {
  if (!projectId) return false
  return (counts.get(projectId) ?? 0) > 0
}
