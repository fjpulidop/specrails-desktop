/**
 * Durable record of the person's own Pause of a Core definition run. One `queue_state`
 * row per run (`user_pause:<runId>`), written when the person asks for the pause (so a
 * restart while it is still pausing keeps the run paused, not merely restart-paused),
 * stamped when the run parks at a step boundary, and removed by any resume of the run
 * or by its settlement. While the row exists the run never resumes by itself: startup
 * recovery skips it (host-task re-dispatch, usage-limit automatic resume) and every
 * surface reads its hold as `paused` by you.
 */
import type { DbInstance } from '../../../db'

const PREFIX = 'user_pause:'

export interface UserPauseRecord {
  /** The Core pause request id (unique per request: Core ignores one it already consumed). */
  requestId: string
  requestedAt: string
  /** Set once the run parked at a step boundary. */
  pausedAt?: string
}

export function saveUserPause(db: DbInstance, runId: string, record: UserPauseRecord): void {
  db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(PREFIX + runId, JSON.stringify(record))
}

export function readUserPause(db: DbInstance, runId: string): UserPauseRecord | null {
  const row = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(PREFIX + runId) as { value: string } | undefined
  if (!row) return null
  try {
    const parsed = JSON.parse(row.value) as Partial<UserPauseRecord> | null
    if (!parsed || typeof parsed.requestId !== 'string' || typeof parsed.requestedAt !== 'string') return null
    return { requestId: parsed.requestId, requestedAt: parsed.requestedAt, ...(typeof parsed.pausedAt === 'string' ? { pausedAt: parsed.pausedAt } : {}) }
  } catch { return null }
}

/** The run parked: stamp when (a record lost meanwhile is written again). */
export function markUserPaused(db: DbInstance, runId: string, requestId: string, at: string): void {
  const current = readUserPause(db, runId)
  saveUserPause(db, runId, { requestId: current?.requestId ?? requestId, requestedAt: current?.requestedAt ?? at, pausedAt: at })
}

export function clearUserPause(db: DbInstance, runId: string): void {
  db.prepare('DELETE FROM queue_state WHERE key = ?').run(PREFIX + runId)
}

/** A fresh Core pause request id: unique per run, request and process (a restart restarts any counter). */
export function userPauseRequestId(runId: string, sequence: number, nowMs: number): string {
  return `desktop-user-pause:${runId}:${sequence}:${nowMs.toString(36)}`
}

/** Core's pause reason for the person's Pause (a lowercase token, like `budget`). */
export const USER_PAUSE_REASON = 'requested'

/** The run log's line when the person resumes a run they paused (live or after a restart). */
export const USER_RESUME_LINE = '\n▶ Resumed by you — the run continues from its next step.'

/** The structured run event (`{ state: 'paused' | 'resumed' }`) the narrated log words as "Paused by you" / "Resumed by you". */
export const USER_PAUSE_EVENT = 'run-user-pause'
