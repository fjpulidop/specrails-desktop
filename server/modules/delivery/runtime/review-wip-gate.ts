import type { DbInstance } from '../../../db/types'
import {
  evaluateReviewWip,
  listPendingReview,
  normalizeReviewWipLimit,
  type PendingReviewItem,
  type ReviewWipLaunch,
  type ReviewWipRejection,
  launchAddsReviewWip,
} from '../domain/review-wip'
import { readReviewWipSnapshot } from '../adapters/review-wip-store'

export interface ReviewWipStatus {
  /** null = no limit configured. */
  limit: number | null
  pending: PendingReviewItem[]
  /** Admitted launches whose delivery row is not written yet. */
  reserved: number
}

export type ReviewWipAdmission =
  | { ok: true; release: () => void }
  | { ok: false; rejection: ReviewWipRejection }

export interface ReviewWipGate {
  status(): ReviewWipStatus
  /** Admit a launch on `railIndex`, holding a slot until `release()` (call it
   *  once the launch has answered: its delivery row then exists, or it never
   *  will). */
  admit(railIndex: number, launch: ReviewWipLaunch): ReviewWipAdmission
}

export interface ReviewWipGateOptions {
  /** The project's own connection — never another project's. */
  db: DbInstance
  /** The project's `reviewWipLimit` setting (read on every admission). */
  readLimit: () => number | null
}

/**
 * Per-project review WIP admission. Bound at composition to one project's
 * connection; the in-memory reservation count closes the window between the
 * check and the delivery row insert, so parallel launches (Launch all, MCP
 * launch_all) cannot overshoot the limit.
 *
 * Fail-open: an unreadable snapshot or setting never blocks work (mirrors the
 * daily budget gate); the failure is logged.
 */
export function createReviewWipGate(options: ReviewWipGateOptions): ReviewWipGate {
  // One entry per admitted, unanswered launch (rail index). A reservation
  // whose rail already shows its new delivery row is not counted twice.
  const reservations: number[] = []
  const reservedBeyond = (pending: readonly PendingReviewItem[]): number =>
    reservations.filter((railIndex) => !pending.some((item) => item.railIndex === railIndex)).length
  const read = (): { limit: number | null; pending: PendingReviewItem[] } => ({
    limit: normalizeReviewWipLimit(options.readLimit()),
    pending: listPendingReview(readReviewWipSnapshot(options.db)),
  })
  return {
    status() {
      try {
        const state = read()
        return { ...state, reserved: reservedBeyond(state.pending) }
      } catch (error) {
        console.warn('[review-wip] state unavailable:', error instanceof Error ? error.message : error)
        return { limit: null, pending: [], reserved: reservations.length }
      }
    },
    admit(railIndex, launch) {
      const addsWip = launchAddsReviewWip(launch)
      if (!addsWip) return { ok: true, release: () => {} }
      let state: { limit: number | null; pending: PendingReviewItem[] }
      try {
        state = read()
      } catch (error) {
        console.warn('[review-wip] state unavailable; admitting the launch:', error instanceof Error ? error.message : error)
        return { ok: true, release: () => {} }
      }
      const rejection = evaluateReviewWip({ ...state, reserved: reservedBeyond(state.pending), addsWip })
      if (rejection) return { ok: false, rejection }
      if (state.limit === null) return { ok: true, release: () => {} }
      reservations.push(railIndex)
      let released = false
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          const at = reservations.indexOf(railIndex)
          if (at >= 0) reservations.splice(at, 1)
        },
      }
    },
  }
}
