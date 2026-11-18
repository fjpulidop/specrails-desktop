/**
 * Durable record of a `limit_paused` run (provider usage limit): what it waits
 * for and whether it resumes by itself. One `queue_state` row per run
 * (`limit_pause:<runId>`), written when the run parks and removed when it
 * resumes or settles, so a restart still knows `resumeAt`.
 */
import type { DbInstance } from '../../../db'
import type { LoopLimitPause } from './loop-run-contract'

const PREFIX = 'limit_pause:'

export function saveLimitPause(db: DbInstance, runId: string, pause: LoopLimitPause): void {
  db.prepare('INSERT OR REPLACE INTO queue_state (key, value) VALUES (?, ?)').run(PREFIX + runId, JSON.stringify(pause))
}

export function clearLimitPause(db: DbInstance, runId: string): void {
  db.prepare('DELETE FROM queue_state WHERE key = ?').run(PREFIX + runId)
}

function parse(value: string): LoopLimitPause | null {
  try {
    const raw = JSON.parse(value) as Partial<LoopLimitPause>
    if (typeof raw.providerId !== 'string' || typeof raw.message !== 'string' || typeof raw.pausedAt !== 'string') return null
    const resumeAt = typeof raw.resumeAt === 'string' && Number.isFinite(Date.parse(raw.resumeAt)) ? raw.resumeAt : null
    return { providerId: raw.providerId, resumeAt, autoResume: raw.autoResume !== false, message: raw.message, pausedAt: raw.pausedAt, switchable: raw.switchable === true }
  } catch { return null }
}

export function readLimitPause(db: DbInstance, runId: string): LoopLimitPause | null {
  const row = db.prepare('SELECT value FROM queue_state WHERE key = ?').get(PREFIX + runId) as { value: string } | undefined
  return row ? parse(row.value) : null
}

export function listLimitPauses(db: DbInstance): Array<{ runId: string; pause: LoopLimitPause }> {
  const rows = db.prepare("SELECT key, value FROM queue_state WHERE key LIKE 'limit_pause:%'").all() as Array<{ key: string; value: string }>
  return rows.flatMap((row) => { const pause = parse(row.value); return pause ? [{ runId: row.key.slice(PREFIX.length), pause }] : [] })
}
