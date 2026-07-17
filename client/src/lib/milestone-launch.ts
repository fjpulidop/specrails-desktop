// "Launch Milestone N" (add-project-builder D6): place ALL `M<n>`-labeled todo
// tickets on ONE rail and launch it batch-implement (sequential, single
// worktree, single PR) — greenfield milestone specs are chain-dependent, so
// parallel per-ticket rails from a near-empty main would each build on
// nothing. Reuses the existing rails REST surface unchanged; the server maps
// the bare mode to the batch factory loop (worktree isolation + ask-first PR).

export type MilestoneLaunchResult =
  | { ok: true; railIndex: number; ticketCount: number }
  | { ok: false; reason: 'no-tickets' | 'rail-create-failed' | 'assign-failed' | 'launch-failed'; detail?: string }

interface TicketLite {
  id: number
  status: string
  labels: string[]
}

export function milestoneLabel(n: number): string {
  return `M${n}`
}

export function filterMilestoneTickets(tickets: TicketLite[], milestone: number): number[] {
  const label = milestoneLabel(milestone)
  return tickets
    .filter((t) => t.status === 'todo' && Array.isArray(t.labels) && t.labels.includes(label))
    .map((t) => t.id)
}

/**
 * Gather M<n> todo tickets → create a rail (server allocates the lowest free
 * index) → assign → launch batch-implement. Any HTTP failure surfaces as a
 * typed reason for the caller's toast; existing launch guards (409
 * tickets_in_flight / pr_decision_pending) arrive as `launch-failed` details.
 */
export async function launchMilestone(
  projectId: string,
  milestone: number,
  fetchImpl: typeof fetch = fetch,
): Promise<MilestoneLaunchResult> {
  const base = `/api/projects/${projectId}`

  const ticketsRes = await fetchImpl(`${base}/tickets`, { cache: 'no-store' })
  if (!ticketsRes.ok) return { ok: false, reason: 'no-tickets' }
  const ticketsBody = (await ticketsRes.json()) as { tickets?: TicketLite[] } | TicketLite[]
  const tickets = Array.isArray(ticketsBody) ? ticketsBody : ticketsBody.tickets ?? []
  const ticketIds = filterMilestoneTickets(tickets, milestone)
  if (ticketIds.length === 0) return { ok: false, reason: 'no-tickets' }

  const railRes = await fetchImpl(`${base}/rails`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: milestoneLabel(milestone) }),
  })
  if (!railRes.ok) {
    const body = await railRes.json().catch(() => ({}))
    return { ok: false, reason: 'rail-create-failed', detail: (body as { error?: string }).error }
  }
  const { rail } = (await railRes.json()) as { rail: { railIndex: number } }

  const assignRes = await fetchImpl(`${base}/rails/${rail.railIndex}/tickets`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketIds, mode: 'batch-implement' }),
  })
  if (!assignRes.ok) {
    const body = await assignRes.json().catch(() => ({}))
    return { ok: false, reason: 'assign-failed', detail: (body as { error?: string }).error }
  }

  const launchRes = await fetchImpl(`${base}/rails/${rail.railIndex}/launch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'batch-implement' }),
  })
  if (!launchRes.ok) {
    const body = await launchRes.json().catch(() => ({}))
    return { ok: false, reason: 'launch-failed', detail: (body as { error?: string }).error }
  }

  return { ok: true, railIndex: rail.railIndex, ticketCount: ticketIds.length }
}
