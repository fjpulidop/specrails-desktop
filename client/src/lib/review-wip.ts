import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import type { RailPrDecision, RailPrStateSnapshot } from '../types'
import { getApiBase } from './api'

/**
 * Review WIP limit (review-wip-limit). The server is the authority: every
 * launch door refuses a new delivery at the limit with the 409 below. The
 * board mirrors the same count from the live per-rail delivery snapshots so
 * the badge and the disabled Play buttons follow WebSocket updates without a
 * refetch. Keep `REVIEW_WIP_DECISIONS` in sync with
 * `server/modules/delivery/domain/review-wip.ts`.
 */
export const REVIEW_WIP_DECISIONS: ReadonlySet<RailPrDecision> = new Set<RailPrDecision>(['building', 'on_review', 'pr_draft', 'pr_ready'])

/** The limit the settings UI suggests. */
export const SUGGESTED_REVIEW_WIP_LIMIT = 5
export const REVIEW_WIP_LIMIT_MAX = 100

/** Window event the settings section fires after saving the limit. */
export const REVIEW_WIP_LIMIT_CHANGED_EVENT = 'specrails:review-wip-limit-changed'

export interface PendingReview {
  deliveryId: string
  railIndex: number
  ticketIds: number[]
  since: string
}

export interface ReviewWipRejection {
  limit: number
  pending: PendingReview[]
}

/** Deliveries counting against the limit, oldest first (top-level per rail). */
export function pendingReviewFromDecisions(decisions: ReadonlyMap<number, RailPrStateSnapshot>): PendingReview[] {
  return [...decisions.values()]
    .filter((snap) => REVIEW_WIP_DECISIONS.has(snap.decision))
    .map((snap) => ({ deliveryId: snap.prDeliveryId, railIndex: snap.railIndex, ticketIds: [...snap.ticketIds], since: snap.createdAt ?? '' }))
    .sort((a, b) => a.since.localeCompare(b.since) || a.railIndex - b.railIndex)
}

/**
 * Whether a rail's next launch would add a new delivery. A rail that still
 * owns an active delivery can only launch its continuation (or is refused
 * for the pending decision), so the limit never applies to it.
 */
export function railLaunchAddsReviewWip(railIndex: number, decisions: ReadonlyMap<number, RailPrStateSnapshot>): boolean {
  return !decisions.has(railIndex)
}

export function reviewWipReached(limit: number | null, pendingCount: number): boolean {
  return limit !== null && pendingCount >= limit
}

/** How many new deliveries may still start (Infinity without a limit). */
export function reviewWipCapacity(limit: number | null, pendingCount: number): number {
  return limit === null ? Number.POSITIVE_INFINITY : Math.max(0, limit - pendingCount)
}

/** The 409 `review_wip_limit_reached` body of a launch, else null. */
export function readReviewWipRejection(body: unknown): ReviewWipRejection | null {
  if (!body || typeof body !== 'object') return null
  const raw = body as Record<string, unknown>
  if (raw.error !== 'review_wip_limit_reached' || typeof raw.limit !== 'number' || !Number.isFinite(raw.limit)) return null
  const pending = Array.isArray(raw.pending)
    ? raw.pending.flatMap((item): PendingReview[] => {
      const p = item as Record<string, unknown> | null
      if (!p || typeof p.deliveryId !== 'string' || typeof p.railIndex !== 'number') return []
      return [{
        deliveryId: p.deliveryId,
        railIndex: p.railIndex,
        ticketIds: Array.isArray(p.ticketIds) ? p.ticketIds.filter((id): id is number => typeof id === 'number') : [],
        since: typeof p.since === 'string' ? p.since : '',
      }]
    })
    : []
  return { limit: raw.limit, pending }
}

/** "Review limit reached: 3 of 3 deliveries wait for review." */
export function reviewWipRejectionMessage(t: TFunction, rejection: ReviewWipRejection): string {
  return t('common:reviewWip.reached', { count: rejection.pending.length, limit: rejection.limit })
}

/** What the person can do about it. */
export function reviewWipActionMessage(t: TFunction): string {
  return t('common:reviewWip.action')
}

/** Parse a settings value: an integer from 1 to 100, or null for no limit. */
export function parseReviewWipLimitInput(raw: string): number | null | undefined {
  const value = raw.trim()
  if (value === '') return null
  if (!/^\d+$/.test(value)) return undefined
  const n = Number(value)
  return n >= 1 && n <= REVIEW_WIP_LIMIT_MAX ? n : undefined
}

export function notifyReviewWipLimitChanged(limit: number | null): void {
  try { window.dispatchEvent(new CustomEvent(REVIEW_WIP_LIMIT_CHANGED_EVENT, { detail: { limit } })) } catch { /* non-DOM */ }
}

/**
 * The active project's `reviewWipLimit` (null = no limit). Re-read on project
 * switch and whenever the settings section saves a new value.
 */
export function useReviewWipLimit(activeProjectId: string | null): number | null {
  const [limit, setLimit] = useState<number | null>(null)
  useEffect(() => {
    if (!activeProjectId) { setLimit(null); return }
    let cancelled = false
    const load = () => {
      fetch(`${getApiBase()}/settings`)
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { reviewWipLimit?: unknown } | null) => {
          if (cancelled || !data) return
          setLimit(typeof data.reviewWipLimit === 'number' ? data.reviewWipLimit : null)
        })
        .catch(() => {})
    }
    load()
    const onChanged = (event: Event) => {
      const detail = (event as CustomEvent<{ limit?: unknown }>).detail
      if (detail && (typeof detail.limit === 'number' || detail.limit === null)) setLimit(detail.limit as number | null)
      else load()
    }
    window.addEventListener(REVIEW_WIP_LIMIT_CHANGED_EVENT, onChanged)
    return () => { cancelled = true; window.removeEventListener(REVIEW_WIP_LIMIT_CHANGED_EVENT, onChanged) }
  }, [activeProjectId])
  return limit
}
