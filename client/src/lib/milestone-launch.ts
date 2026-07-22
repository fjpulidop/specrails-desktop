// "Launch Milestone N" (add-project-builder D6): place `M<n>`-labeled todo
// tickets on rails and launch them batch-implement (sequential, single
// worktree, single PR per rail). Each rail carries AT MOST
// MAX_TICKETS_PER_RAIL specs — a large milestone is chunked across several
// rails instead of dumping the whole set on one. Reuses the existing rails
// REST surface unchanged; the server maps the bare mode to the batch factory
// loop (worktree isolation + ask-first PR) and enforces the same per-rail cap.

export const MAX_TICKETS_PER_RAIL = 3

export type MilestoneLaunchResult =
  | { ok: true; railIndices: number[]; ticketCount: number; skippedCount: number }
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

export function chunkTickets(ticketIds: number[], size: number = MAX_TICKETS_PER_RAIL): number[][] {
  const chunks: number[][] = []
  for (let i = 0; i < ticketIds.length; i += size) chunks.push(ticketIds.slice(i, i + size))
  return chunks
}

/**
 * Gather M<n> todo tickets → chunk into groups of ≤ MAX_TICKETS_PER_RAIL →
 * for each chunk: create a rail (server allocates the lowest free index) →
 * assign → launch batch-implement. A failure before anything launched
 * surfaces as a typed reason; a failure after at least one rail launched
 * returns `ok: true` with the launched count plus `skippedCount` so the
 * caller's toast can say how many specs did not make it.
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

  const chunks = chunkTickets(ticketIds)
  const railIndices: number[] = []
  let launchedTickets = 0
  let failure: { reason: 'rail-create-failed' | 'assign-failed' | 'launch-failed'; detail?: string } | null = null

  for (const [chunkIndex, chunk] of chunks.entries()) {
    const railName = chunks.length === 1
      ? milestoneLabel(milestone)
      : `${milestoneLabel(milestone)} · ${chunkIndex + 1}`

    const railRes = await fetchImpl(`${base}/rails`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: railName }),
    })
    if (!railRes.ok) {
      const body = await railRes.json().catch(() => ({}))
      failure = { reason: 'rail-create-failed', detail: (body as { error?: string }).error }
      break
    }
    const { rail } = (await railRes.json()) as { rail: { railIndex: number } }

    const assignRes = await fetchImpl(`${base}/rails/${rail.railIndex}/tickets`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticketIds: chunk, mode: 'batch-implement' }),
    })
    if (!assignRes.ok) {
      const body = await assignRes.json().catch(() => ({}))
      failure = { reason: 'assign-failed', detail: (body as { error?: string }).error }
      break
    }

    const launchRes = await fetchImpl(`${base}/rails/${rail.railIndex}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'batch-implement' }),
    })
    if (!launchRes.ok) {
      const body = await launchRes.json().catch(() => ({}))
      failure = { reason: 'launch-failed', detail: (body as { error?: string }).error }
      break
    }

    railIndices.push(rail.railIndex)
    launchedTickets += chunk.length
  }

  if (railIndices.length === 0 && failure) return { ok: false, ...failure }

  return {
    ok: true,
    railIndices,
    ticketCount: launchedTickets,
    skippedCount: ticketIds.length - launchedTickets,
  }
}
