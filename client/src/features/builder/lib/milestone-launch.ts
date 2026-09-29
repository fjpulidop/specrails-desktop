// "Launch Milestone N" (premium-milestone-progress): the launch is SERVER-owned.
// One POST orders the milestone's todo specs by their dependencies, puts ONE
// spec on each rail, launches through the ordinary rails launch route, and
// chains each later spec on the previous spec's delivered branch inside the
// server (durable in SQLite; survives window close / restart). Launches are
// always sequential — the Parallel option was removed. The client keeps NO
// launch plan in browser storage: the old localStorage sequencer is gone, and
// its leftover keys are dropped on load.

import type { MilestoneChainLaunched, MilestoneChainSnapshot } from './milestone-progress'
import { coerceChain } from './milestone-progress'

/** One spec per rail (the server owns the chain; this mirrors its chunking). */
export const MAX_TICKETS_PER_RAIL = 1

/** The retired Sequential/Parallel preference — dropped, never read. */
export const LEGACY_MILESTONE_LAUNCH_MODE_KEY = 'specrails-desktop:milestone-launch-mode'
/** The retired browser-local sequencer's plan store — dropped, never read. */
export const LEGACY_SEQUENTIAL_PLANS_KEY = 'specrails-desktop:milestone-sequential-plans'

/** Wave checkpoints (premium-milestone-progress D9): the user's stored
 *  auto-continue preference. Default ON — each delivered rail launches the
 *  next one automatically unless the user turned it off (a failure still
 *  pauses the chain). */
export const MILESTONE_AUTO_ADVANCE_KEY = 'specrails-desktop:milestone-auto-advance'

export function readMilestoneAutoAdvance(): boolean {
  try {
    return localStorage.getItem(MILESTONE_AUTO_ADVANCE_KEY) !== 'false'
  } catch {
    return true
  }
}

export function saveMilestoneAutoAdvance(on: boolean): void {
  try { localStorage.setItem(MILESTONE_AUTO_ADVANCE_KEY, on ? 'true' : 'false') } catch { /* ignore */ }
}

/** Forget any plan the retired client-side sequencer left behind. Its runs
 *  were settled server-side long ago; the chain row is authoritative now. */
export function dropLegacySequentialPlans(): boolean {
  try {
    // The retired launch-mode preference goes too (Parallel no longer exists).
    localStorage.removeItem(LEGACY_MILESTONE_LAUNCH_MODE_KEY)
    if (localStorage.getItem(LEGACY_SEQUENTIAL_PLANS_KEY) === null) return false
    localStorage.removeItem(LEGACY_SEQUENTIAL_PLANS_KEY)
    return true
  } catch {
    return false
  }
}

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

export type MilestoneLaunchFailure = 'chain_active' | 'no_tickets' | 'milestone_not_found' | 'rail_limit_reached' | 'unavailable' | 'launch_rejected' | 'network'

export type MilestoneLaunchResult =
  | {
      ok: true
      chainId: string | null
      launched: MilestoneChainLaunched[]
      pending: number[][]
      /** Specs on rails right now. */
      ticketCount: number
      /** Specs still waiting for a later rail of the chain. */
      skippedCount: number
    }
  | { ok: false; reason: MilestoneLaunchFailure; error: string; detail?: string; chainId?: string }

function failureReason(status: number, error: string): MilestoneLaunchFailure {
  if (error === 'chain_active') return 'chain_active'
  if (error === 'no_tickets') return 'no_tickets'
  if (error === 'milestone_not_found') return 'milestone_not_found'
  if (error === 'rail_limit_reached') return 'rail_limit_reached'
  if (status === 503) return 'unavailable'
  return 'launch_rejected'
}

async function readBody(res: Response): Promise<Record<string, unknown>> {
  try {
    const body = await res.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export interface MilestoneLaunchOptions {
  /** Launch the next rail automatically after each delivered rail (true, the
   *  default) or stop at a checkpoint (false). */
  autoAdvance?: boolean
  fetchImpl?: typeof fetch
}

export async function launchMilestone(
  projectId: string,
  milestone: number,
  options: MilestoneLaunchOptions | typeof fetch = {},
): Promise<MilestoneLaunchResult> {
  const opts: MilestoneLaunchOptions = typeof options === 'function' ? { fetchImpl: options } : options
  const fetchImpl = opts.fetchImpl ?? fetch
  const autoAdvance = opts.autoAdvance ?? readMilestoneAutoAdvance()
  let res: Response
  try {
    res = await fetchImpl(`/api/projects/${projectId}/blueprint/milestones/${milestone}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoAdvance }),
    })
  } catch (err) {
    return { ok: false, reason: 'network', error: 'network', detail: err instanceof Error ? err.message : String(err) }
  }
  const body = await readBody(res)
  if (!res.ok) {
    const error = typeof body.error === 'string' ? body.error : `http_${res.status}`
    return {
      ok: false,
      reason: failureReason(res.status, error),
      error,
      ...(typeof body.detail === 'string' ? { detail: body.detail } : {}),
      ...(typeof body.chainId === 'string' ? { chainId: body.chainId } : {}),
    }
  }
  const launched = Array.isArray(body.launched)
    ? body.launched.filter((l): l is MilestoneChainLaunched => Boolean(l) && typeof l === 'object' && typeof (l as MilestoneChainLaunched).chunk === 'number')
    : []
  const pending = Array.isArray(body.pending) ? body.pending.filter((c): c is number[] => Array.isArray(c)) : []
  return {
    ok: true,
    chainId: typeof body.chainId === 'string' ? body.chainId : null,
    launched,
    pending,
    ticketCount: launched.reduce((n, l) => n + (Array.isArray(l.ticketIds) ? l.ticketIds.length : 0), 0),
    skippedCount: pending.reduce((n, c) => n + c.length, 0),
  }
}

export type ChainControlResult =
  | { ok: true; chain: MilestoneChainSnapshot | null }
  | { ok: false; error: string; detail?: string }

async function controlChain(projectId: string, chainId: string, verb: 'resume' | 'cancel', fetchImpl: typeof fetch): Promise<ChainControlResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/projects/${projectId}/blueprint/chains/${chainId}/${verb}`, { method: 'POST' })
  } catch (err) {
    return { ok: false, error: 'network', detail: err instanceof Error ? err.message : String(err) }
  }
  const body = await readBody(res)
  if (!res.ok) {
    return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${res.status}`, ...(typeof body.detail === 'string' ? { detail: body.detail } : {}) }
  }
  return { ok: true, chain: coerceChain(body.chain) }
}

export function resumeChain(projectId: string, chainId: string, fetchImpl: typeof fetch = fetch): Promise<ChainControlResult> {
  return controlChain(projectId, chainId, 'resume', fetchImpl)
}

export function cancelChain(projectId: string, chainId: string, fetchImpl: typeof fetch = fetch): Promise<ChainControlResult> {
  return controlChain(projectId, chainId, 'cancel', fetchImpl)
}

/** Flip auto-continue on a live chain; turning it on at a checkpoint launches
 *  the next rail immediately (the server resumes). */
export async function setChainAutoAdvance(projectId: string, chainId: string, autoAdvance: boolean, fetchImpl: typeof fetch = fetch): Promise<ChainControlResult> {
  let res: Response
  try {
    res = await fetchImpl(`/api/projects/${projectId}/blueprint/chains/${chainId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoAdvance }),
    })
  } catch (err) {
    return { ok: false, error: 'network', detail: err instanceof Error ? err.message : String(err) }
  }
  const body = await readBody(res)
  if (!res.ok) {
    return { ok: false, error: typeof body.error === 'string' ? body.error : `http_${res.status}`, ...(typeof body.detail === 'string' ? { detail: body.detail } : {}) }
  }
  return { ok: true, chain: coerceChain(body.chain) }
}
