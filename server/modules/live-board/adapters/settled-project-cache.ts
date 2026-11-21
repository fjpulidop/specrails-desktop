import type { DbInstance } from '../../../db/types'
import type { DayWindow, LiveRunFacts } from '../domain'

/**
 * Reuse a project's live-board read while nothing it depends on has changed.
 *
 * Only a project with nothing live is reused: no loop run running or paused and
 * no in-memory run state (rail launches, restart-pending runs). Its cards are
 * then a function of its database and the local day alone, so the stamp below
 * is exact: `total_changes()` moves on every write through this connection and
 * `PRAGMA data_version` on every commit by any other connection or process.
 * A project with live work is read every time, as before.
 *
 * The cache belongs to the connection (a WeakMap entry dropped with it) and holds
 * only that project's own rows; nothing is shared between projects.
 */
const settled = new WeakMap<DbInstance, { stamp: string; runs: LiveRunFacts[] }>()

export interface SettledProjectState {
  db: DbInstance
  /** True while the project has in-memory run state (rail launches, restart-pending runs). */
  hasLiveMemory: boolean
}

function stamp(db: DbInstance, day: DayWindow): string | null {
  try {
    const live = db.prepare("SELECT 1 FROM loop_runs WHERE status IN ('running','paused') LIMIT 1").get()
    if (live) return null
    const changes = (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n
    const version = (db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version
    return `${changes}:${version}:${day.from}:${day.to}`
  } catch {
    return null
  }
}

/** The project's runs for `day`, read through `read` unless an identical settled read is cached. */
export function readSettledOrFresh(state: SettledProjectState, day: DayWindow, read: () => LiveRunFacts[]): LiveRunFacts[] {
  const key = state.hasLiveMemory ? null : stamp(state.db, day)
  if (key !== null) {
    const hit = settled.get(state.db)
    if (hit && hit.stamp === key) return structuredClone(hit.runs)
  }
  const runs = read()
  // Re-stamp after the read: a write during it must not be cached as current.
  if (key !== null && stamp(state.db, day) === key) settled.set(state.db, { stamp: key, runs: structuredClone(runs) })
  else settled.delete(state.db)
  return runs
}
