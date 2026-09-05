// "Launch Milestone N" (premium-milestone-progress): the launch is SERVER-owned.
// One POST chunks the milestone's todo specs into ≤3-spec rails, launches
// through the ordinary rails launch route, and — in sequential mode — chains
// each later chunk on the previous chunk's delivered branch inside the server
// (durable in SQLite; survives window close / restart). The client keeps NO
// launch plan in browser storage any more: the old localStorage sequencer is
// gone, and its leftover key is dropped on load.

import type { MilestoneChainLaunched, MilestoneChainSnapshot } from './milestone-progress'
import { coerceChain } from './milestone-progress'

export const MAX_TICKETS_PER_RAIL = 3

export type MilestoneLaunchMode = 'sequential' | 'parallel'

export const MILESTONE_LAUNCH_MODE_KEY = 'specrails-desktop:milestone-launch-mode'
/** The retired browser-local sequencer's plan store — dropped, never read. */
export const LEGACY_SEQUENTIAL_PLANS_KEY = 'specrails-desktop:milestone-sequential-plans'

export function readMilestoneLaunchMode(): MilestoneLaunchMode {
  try {
    return localStorage.getItem(MILESTONE_LAUNCH_MODE_KEY) === 'parallel' ? 'parallel' : 'sequential'
  } catch {
    return 'sequential'
  }
}

export function saveMilestoneLaunchMode(mode: MilestoneLaunchMode): void {
  try { localStorage.setItem(MILESTONE_LAUNCH_MODE_KEY, mode) } catch { /* ignore */ }
}

/** Wave checkpoints (premium-milestone-progress D9): the user's stored
 *  auto-continue preference. Default OFF — every delivered rail waits for
 *  "Launch next rail" unless the user opts into automatic continuation. */
export const MILESTONE_AUTO_ADVANCE_KEY = 'specrails-desktop:milestone-auto-advance'

export function readMilestoneAutoAdvance(): boolean {
  try {
    return localStorage.getItem(MILESTONE_AUTO_ADVANCE_KEY) === 'true'
  } catch {
    return false
  }
}

export function saveMilestoneAutoAdvance(on: boolean): void {
  try { localStorage.setItem(MILESTONE_AUTO_ADVANCE_KEY, on ? 'true' : 'false') } catch { /* ignore */ }
}

/** Forget any plan the retired client-side sequencer left behind. Its runs
 *  were settled server-side long ago; the chain row is authoritative now. */
export function dropLegacySequentialPlans(): boolean {
  try {
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

export type MilestoneLaunchFailure = 'chain_active' | 'no_tickets' | 'milestone_not_found' | 'unavailable' | 'launch_rejected' | 'network'

export type MilestoneLaunchResult =
  | {
      ok: true
      chainId: string | null
      launched: MilestoneChainLaunched[]
      pending: number[][]
      /** Specs on rails right now. */
      ticketCount: number
      /** Specs still waiting for a later chunk (sequential) or that could not launch (parallel). */
      skippedCount: number
    }
  | { ok: false; reason: MilestoneLaunchFailure; error: string; detail?: string; chainId?: string }

function failureReason(status: number, error: string): MilestoneLaunchFailure {
  if (error === 'chain_active') return 'chain_active'
  if (error === 'no_tickets') return 'no_tickets'
  if (error === 'milestone_not_found') return 'milestone_not_found'
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
  /** Sequential chains only: launch the next rail automatically after each
   *  delivered rail (true) or stop at a checkpoint (false, the UI default). */
  autoAdvance?: boolean
  fetchImpl?: typeof fetch
}

export async function launchMilestone(
  projectId: string,
  milestone: number,
  mode: MilestoneLaunchMode = readMilestoneLaunchMode(),
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
      body: JSON.stringify({ mode, autoAdvance }),
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
