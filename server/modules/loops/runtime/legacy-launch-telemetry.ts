/**
 * Legacy-launch telemetry — the D8 retirement counter.
 *
 * Every launch that still runs through a pre-Core path appends one row to the
 * per-project `legacy_launch_events` table (migration 66): the node-by-node
 * loop traversal in LoopRunManager, the QueueManager slash command a bare rail
 * mode enqueues, and the isolated-rail merge-back. The analytics page reads the
 * summary so two releases can prove the counter stays at zero before D8.3–D8.5
 * remove those paths. Nothing here changes how a launch runs.
 *
 * Append-only. A run-scoped event is idempotent per (kind, runId) so restart
 * replay and retries never inflate the count; events without a run id count
 * every call. Pure SQLite helpers; no Express, no process access.
 */
import { randomUUID } from 'node:crypto'
import type { DbInstance } from '../../../db'

export const LEGACY_LAUNCH_KINDS = ['legacy_loop_traversal', 'queue_manager_slash', 'merge_back'] as const
export type LegacyLaunchKind = (typeof LEGACY_LAUNCH_KINDS)[number]

export interface LegacyLaunchEvent {
  kind: LegacyLaunchKind
  /** Owning project; the table lives in that project's database. */
  projectId: string
  /** Loop run, queue job or delivery id. Present ⇒ idempotent per (kind, runId). */
  runId?: string
  /** ISO-8601 timestamp; defaults to now. */
  at?: string
}

export interface LegacyLaunchSummary {
  total: number
  /** Every known kind is present (zero-filled) so consumers get a stable shape. */
  byKind: Record<string, number>
  /** ISO timestamp of the latest counted event, null when nothing was counted. */
  lastAt: string | null
}

function assertIso(value: string, field: string): string {
  if (typeof value !== 'string' || !value.trim() || Number.isNaN(Date.parse(value))) {
    throw new RangeError(`legacy launch telemetry: ${field} must be an ISO-8601 timestamp`)
  }
  return new Date(value).toISOString()
}

/** Record one legacy launch. Throws only on malformed input; callers that must
 *  never block a launch wrap the call. */
export function recordLegacyLaunch(db: DbInstance, event: LegacyLaunchEvent): void {
  if (!LEGACY_LAUNCH_KINDS.includes(event?.kind)) {
    throw new TypeError(`legacy launch telemetry: unknown kind ${JSON.stringify(event?.kind)}`)
  }
  if (typeof event.projectId !== 'string' || !event.projectId.trim()) {
    throw new TypeError('legacy launch telemetry: projectId is required')
  }
  if (event.runId !== undefined && (typeof event.runId !== 'string' || !event.runId.trim())) {
    throw new TypeError('legacy launch telemetry: runId must be a non-empty string when present')
  }
  const at = event.at === undefined ? new Date().toISOString() : assertIso(event.at, 'at')
  // The partial unique index on (kind, run_id) makes the run-scoped insert a
  // no-op on replay; rows without a run id never collide.
  db.prepare(`
    INSERT OR IGNORE INTO legacy_launch_events (id, kind, project_id, run_id, at)
    VALUES (?, ?, ?, ?, ?)
  `).run(randomUUID(), event.kind, event.projectId, event.runId ?? null, at)
}

/** Aggregate the counter, optionally from an ISO lower bound (inclusive). The
 *  bound is compared lexicographically, so a date-only `YYYY-MM-DD` works. */
export function readLegacyLaunchSummary(db: DbInstance, since?: string): LegacyLaunchSummary {
  const params: string[] = []
  let where = ''
  if (since !== undefined) {
    where = 'WHERE at >= ?'
    params.push(assertIso(since, 'since'))
  }
  const rows = db.prepare(`
    SELECT kind, COUNT(*) AS count, MAX(at) AS last_at
      FROM legacy_launch_events ${where}
     GROUP BY kind
  `).all(...params) as Array<{ kind: string; count: number; last_at: string | null }>
  const byKind: Record<string, number> = Object.fromEntries(LEGACY_LAUNCH_KINDS.map((kind) => [kind, 0]))
  let total = 0
  let lastAt: string | null = null
  for (const row of rows) {
    byKind[row.kind] = (byKind[row.kind] ?? 0) + row.count
    total += row.count
    if (row.last_at && (lastAt === null || row.last_at > lastAt)) lastAt = row.last_at
  }
  return { total, byKind, lastAt }
}
