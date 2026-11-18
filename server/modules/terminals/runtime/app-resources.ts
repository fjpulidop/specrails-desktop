import { measureAppResources, type AppResourceCategory, type AppResourceRoot } from '../domain/app-resources'
import type { MissionResourceSample, MissionResourceTotals, ProcessSample } from '../domain/mission-resources'
import type { ProcessTableReader } from './resource-sampler'

export interface AppResourcesSnapshot {
  measuredAt: number
  /** False when the process table could not be read on this platform. */
  supported: boolean
  totals: MissionResourceTotals
  categories: AppResourceCategory[]
  /** Totals sampled while the view is polled, oldest first (in memory only). */
  history: MissionResourceSample[]
}

export interface AppResourcesSamplerOptions {
  readProcessTable: ProcessTableReader
  /** Roots with a known owner, resolved against the same table. */
  listRoots: (table: ProcessSample[]) => AppResourceRoot[]
  serverPid?: number
  now?: () => number
  historySize?: number
  /** A gap longer than this between requests means nobody is watching: the history restarts. */
  historyIdleMs?: number
  /** Requests closer than this share one history point. */
  historyIntervalMs?: number
}

/**
 * App-wide resource snapshots: one process-table read per request (the reader caches), attributed with
 * `measureAppResources`. A short in-memory history is kept only while a client keeps polling, for a
 * sparkline; nothing is sampled in the background.
 */
export function createAppResourcesSampler({
  readProcessTable, listRoots, serverPid = process.pid, now = Date.now,
  historySize = 100, historyIdleMs = 30_000, historyIntervalMs = 1_000,
}: AppResourcesSamplerOptions) {
  let history: MissionResourceSample[] = []
  return {
    async snapshot(): Promise<AppResourcesSnapshot> {
      const table = await readProcessTable()
      const measuredAt = now()
      const measured = table
        ? measureAppResources(table, listRoots(table), serverPid)
        : { totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 }, categories: [] }
      const last = history[history.length - 1]
      if (last && measuredAt - last.at > historyIdleMs) history = []
      const previous = history[history.length - 1]
      if (table && (!previous || measuredAt - previous.at >= historyIntervalMs)) {
        history.push({ at: measuredAt, ...measured.totals })
        if (history.length > historySize) history = history.slice(-historySize)
      }
      return { measuredAt, supported: table !== null, ...measured, history: [...history] }
    },
  }
}
