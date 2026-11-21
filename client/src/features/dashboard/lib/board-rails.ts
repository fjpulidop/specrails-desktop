/**
 * Pure rail/spec-order helpers of the Dashboard board: per-project
 * localStorage persistence of the rails and the spec drag order, wire-mode
 * normalisation, the "can this PR head be continued" rules and the launch
 * outcome vocabulary shared by the launch hooks.
 */
import type { RailState } from '../../rails/components/RailsBoard'
import { migratedRailLoopId } from '../../rails/lib/rail-loops'
import { isRolesEngine } from '../../providers/lib/provider-capabilities'
import { railIndexFromId } from '../../rails/lib/rail-id'
import type { LocalTicket, RailPrStateSnapshot } from '../../../types'
import type { RailMode, RailStatus } from '../../rails/components/RailControls'

export const INITIAL_RAILS: RailState[] = [
  { id: 'rail-1', label: 'Rail 1', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-2', label: 'Rail 2', ticketIds: [], mode: 'implement', status: 'idle' },
  { id: 'rail-3', label: 'Rail 3', ticketIds: [], mode: 'implement', status: 'idle' },
]

/** Normalize a wire/persisted rail mode. The removed Batch mode
 *  (`batch-implement` / `batch`) folds into `implement`, which already runs every
 *  rail ticket in one aggregate run; so does the retired `freestyle` mode
 *  (Freestyle is a gallery loop now) and its pre-rename `ultracode` spelling.
 *  Unknown values yield undefined. */
export const toRailMode = (m: string | undefined): RailMode | undefined =>
  m === 'batch-implement' || m === 'batch' || m === 'freestyle' || m === 'ultracode'
    ? 'implement'
    : m === 'implement' || m === 'loop' ? m : undefined

export function prDecisionContinuesTickets(decision: RailPrStateSnapshot | undefined, ticketIds: number[]): boolean {
  if (!decision) return false
  if (decision.decision !== 'pr_draft' && decision.decision !== 'pr_ready') return false
  if (!decision.prUrl || !decision.branch) return false
  const covered = new Set(decision.ticketIds)
  return ticketIds.length > 0 && ticketIds.every((id) => covered.has(id))
}

export function ticketHasContinuablePr(ticketId: number, decisions: ReadonlyMap<number, RailPrStateSnapshot>, tickets: readonly LocalTicket[] = []): boolean {
  const hasAddenda = tickets.some((ticket) => ticket.id === ticketId && ticket.addenda?.some((a) => a.status === 'open'))
  for (const decision of decisions.values()) {
    if (hasAddenda && decision.decision !== 'building' && decision.ticketIds.includes(ticketId)) return true
    if (prDecisionContinuesTickets(decision, [ticketId])) return true
  }
  return false
}

/** Why a rail is excluded from a Launch-all batch. */
export type LaunchAllSkipReason = 'running' | 'empty' | 'pendingDecision' | 'onReview' | 'reviewLimit'
/** Per-rail terminal outcome of a (batched) launch attempt. */
export type LaunchOutcome = 'launched' | 'failed' | 'pendingDecision' | 'skipped' | 'budget' | 'reviewLimit' | 'noCommits'

export function loadSpecOrder(projectId: string | null): number[] | null {
  if (!projectId) return null
  try {
    const raw = localStorage.getItem(`specrails-desktop:spec-order:${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : null
  } catch { return null }
}

export function saveSpecOrder(projectId: string | null, ids: number[] | null) {
  if (!projectId) return
  // B23: these run inside setState updaters; an uncaught throw (quota exceeded,
  // Safari private mode) would crash the Dashboard render. Persistence is
  // best-effort — losing it is acceptable, crashing is not.
  try {
    if (ids) {
      localStorage.setItem(`specrails-desktop:spec-order:${projectId}`, JSON.stringify(ids))
    } else {
      localStorage.removeItem(`specrails-desktop:spec-order:${projectId}`)
    }
  } catch { /* non-fatal */ }
}

interface PersistedRail {
  id: string
  label: string
  ticketIds: number[]
  mode: RailMode
  status: RailStatus
  profileName?: string | null
}

export function loadRails(projectId: string | null): RailState[] | null {
  if (!projectId) return null
  try {
    const raw = localStorage.getItem(`specrails-desktop:rails:${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as (PersistedRail & { selectedLoopId?: string | null; freestyleModel?: unknown })[]
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    // Rails persisted before Batch was removed, or on a since-retired built-in
    // (Freestyle, Quick SDD, Revision), load as Implement. The retired ids never
    // reach the server: their picks are migrated here, on read.
    return parsed.map(({ freestyleModel: _retiredModel, ...rail }: PersistedRail & { selectedLoopId?: string | null; freestyleModel?: unknown }) => ({
      ...rail,
      mode: toRailMode(rail.mode as string | undefined) ?? 'implement',
      ...(migratedRailLoopId(rail.selectedLoopId) !== rail.selectedLoopId ? { selectedLoopId: migratedRailLoopId(rail.selectedLoopId) } : {}),
    }))
  } catch { return null }
}

export function saveRails(projectId: string | null, rails: RailState[]) {
  if (!projectId) return
  // B23: best-effort persistence (see saveSpecOrder) — never crash the render.
  try {
    localStorage.setItem(`specrails-desktop:rails:${projectId}`, JSON.stringify(rails))
  } catch { /* non-fatal */ }
}

/** Server railIndex for a rail id — identity mapping (`rail-N` → N-1), with a
 *  positional fallback for exotic ids. -1 when the rail doesn't exist. */
export function serverRailIndex(rails: readonly RailState[], railId: string): number {
  const idx = railIndexFromId(railId)
  if (idx !== null) return idx
  return rails.findIndex((r) => r.id === railId)
}

/** Provider id behind a rail's engine for catalog/capability lookups — the
 *  `roles` sentinel is not a provider, so it maps to the project primary. */
export function railProviderOf(r: { aiEngine?: string | null } | undefined, railProviders: readonly string[]): string {
  const engine = r?.aiEngine
  return (isRolesEngine(engine) ? undefined : engine) ?? railProviders[0] ?? 'claude'
}
