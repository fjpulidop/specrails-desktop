import { measureAppResources, type AppResourceCategory, type AppResourceRoot } from '../domain/app-resources'
import os from 'node:os'
import { withMachineCpu, type MissionResourceSample, type MissionResourceTotals, type ProcessSample } from '../domain/mission-resources'
import type { ProcessTableReader } from './resource-sampler'

export interface AppResourcesSnapshot {
  measuredAt: number
  /** False when the process table could not be read on this platform. */
  supported: boolean
  totals: MissionResourceTotals
  categories: AppResourceCategory[]
  /** Totals sampled while the view is polled, oldest first (in memory only). */
  history: MissionResourceSample[]
  /** Logical cores: every `cpuPercent` is a share of the whole machine (0-100 %), not of one core. */
  cpuCores: number
}

/** Logical cores of this machine (the denominator of every CPU share). */
export function logicalCores(): number {
  return (typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length) || 1
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
  /** Logical cores (tests fix it). */
  cpuCores?: number
}

/**
 * App-wide resource snapshots: one process-table read per request (the reader caches), attributed with
 * `measureAppResources`. A short in-memory history is kept only while a client keeps polling, for a
 * sparkline; nothing is sampled in the background.
 */
export function createAppResourcesSampler({
  readProcessTable, listRoots, serverPid = process.pid, now = Date.now,
  historySize = 100, historyIdleMs = 30_000, historyIntervalMs = 1_000, cpuCores = logicalCores(),
}: AppResourcesSamplerOptions) {
  let history: MissionResourceSample[] = []
  return {
    async snapshot(): Promise<AppResourcesSnapshot> {
      const table = await readProcessTable()
      const measuredAt = now()
      const raw = table
        ? measureAppResources(table, listRoots(table), serverPid)
        : { totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 }, categories: [] }
      // Out of the whole machine, like memory (the table measures each process against one core).
      const measured = {
        totals: withMachineCpu(raw.totals, cpuCores),
        categories: raw.categories.map((category) => ({ ...withMachineCpu(category, cpuCores), items: category.items.map((item) => withMachineCpu(item, cpuCores)) })),
      }
      const last = history[history.length - 1]
      if (last && measuredAt - last.at > historyIdleMs) history = []
      const previous = history[history.length - 1]
      if (table && (!previous || measuredAt - previous.at >= historyIntervalMs)) {
        history.push({ at: measuredAt, ...measured.totals })
        if (history.length > historySize) history = history.slice(-historySize)
      }
      return { measuredAt, supported: table !== null, ...measured, history: [...history], cpuCores }
    },
  }
}
