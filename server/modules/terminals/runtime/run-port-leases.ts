/**
 * Machine-wide lease table of run port blocks (see domain/run-ports.ts).
 *
 * One server process hosts every project, so one in-memory table keeps
 * concurrently live runs apart; it is persisted at
 * `<specrailsHome>/.specrails/run-ports.json` so a resumed run after a restart
 * keeps the block it was given (its dev server, test config and logs keep
 * agreeing on the port). A lease lives as long as its worktree directory: the
 * table drops leases whose worktree is gone whenever it allocates.
 *
 * Reads are synchronous and O(1) after the first allocation, because spawn
 * env builders are synchronous. `ensureRunPortLease` is the async entry used
 * before a run's first spawn: it additionally skips blocks where something
 * already listens (another app, a second Specrails home).
 */
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { resolveSpecrailsHome } from '../../../util/specrails-home'
import {
  blockRange, candidateBlocks, isRunWorktreePath, runPortArea, runPortEnv,
  type RunPortArea, type RunPortLease,
} from '../domain/run-ports'

const FILE_VERSION = 1

export interface RunPortLeaseTableOptions {
  /** Specrails home (default: SPECRAILS_REGISTRY_HOME or the OS home). */
  home?: () => string
  area?: () => RunPortArea
  now?: () => number
  /** Whether a worktree still exists (lease GC). */
  exists?: (worktreePath: string) => boolean
  /** Whether any port of the block is already bound by someone. */
  probeBlock?: (start: number, end: number) => Promise<boolean>
  windows?: boolean
}

function canonical(value: string): string {
  try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
}

/** True when nothing can bind `port` on the wildcard address (dual stack where available). */
function portBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'EADDRINUSE' || err.code === 'EACCES'))
    server.listen({ port, exclusive: true }, () => server.close(() => resolve(false)))
  })
}

async function defaultProbeBlock(start: number, end: number): Promise<boolean> {
  const ports: number[] = []
  for (let p = start; p <= end; p++) ports.push(p)
  return (await Promise.all(ports.map(portBusy))).some(Boolean)
}

export function createRunPortLeaseTable(options: RunPortLeaseTableOptions = {}) {
  const home = options.home ?? (() => resolveSpecrailsHome())
  const area = options.area ?? (() => runPortArea(process.env))
  const now = options.now ?? Date.now
  const exists = options.exists ?? ((p: string) => fs.existsSync(p))
  const probeBlock = options.probeBlock ?? defaultProbeBlock
  const windows = options.windows ?? process.platform === 'win32'
  let leases: Map<string, RunPortLease> | null = null
  let loadedFrom: string | null = null
  const inFlight = new Map<string, Promise<RunPortLease | null>>()

  const filePath = () => path.join(home(), '.specrails', 'run-ports.json')
  const projectsRoot = () => path.join(home(), '.specrails', 'projects')

  function load(): Map<string, RunPortLease> {
    const file = filePath()
    if (leases && loadedFrom === file) return leases
    leases = new Map()
    loadedFrom = file
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: number; leases?: RunPortLease[] }
      const current = area()
      if (raw.version === FILE_VERSION && Array.isArray(raw.leases)) {
        for (const lease of raw.leases) {
          if (!lease || typeof lease.worktreePath !== 'string' || !Number.isInteger(lease.block)) continue
          // The area may have been reconfigured: a block outside it is re-leased.
          if (lease.block < 0 || lease.block >= current.blocks) continue
          const range = blockRange(current, lease.block)
          leases.set(lease.worktreePath, { worktreePath: lease.worktreePath, block: lease.block, ...range, leasedAt: Number(lease.leasedAt) || 0 })
        }
      }
    } catch { /* absent or unreadable: start empty */ }
    return leases
  }

  function persist(table: Map<string, RunPortLease>): void {
    const file = filePath()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, leases: [...table.values()] }, null, 2) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
    } catch (err) {
      // The in-memory table still separates live runs; only restart stability is lost.
      console.warn(`[run-ports] could not persist leases: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  function gc(table: Map<string, RunPortLease>): boolean {
    let changed = false
    for (const key of [...table.keys()]) {
      if (!exists(key)) { table.delete(key); changed = true }
    }
    return changed
  }

  function keyOf(worktreePath: string | undefined | null): string | null {
    if (!worktreePath) return null
    const root = projectsRoot()
    const raw = path.resolve(worktreePath)
    // Cheap rejection first: most spawns are not in a run worktree.
    const rawMatch = isRunWorktreePath(raw, root, windows)
    const key = canonical(worktreePath)
    // A symlinked home (macOS /var → /private/var) must still land under the projects root.
    return rawMatch || isRunWorktreePath(key, canonical(root), windows) ? key : null
  }

  function commit(table: Map<string, RunPortLease>, key: string, block: number): RunPortLease {
    const lease: RunPortLease = { worktreePath: key, block, ...blockRange(area(), block), leasedAt: now() }
    table.set(key, lease)
    persist(table)
    return lease
  }

  /** The worktree's lease, allocating one without probing when it has none. Null for non-run paths. */
  function lease(worktreePath: string | undefined | null): RunPortLease | null {
    const key = keyOf(worktreePath)
    if (!key) return null
    const table = load()
    const existing = table.get(key)
    if (existing) return existing
    gc(table)
    const taken = new Set([...table.values()].map((l) => l.block))
    const block = candidateBlocks(area(), key, taken)[0]
    return block === undefined ? null : commit(table, key, block)
  }

  /** Like `lease`, but a new lease skips blocks where something already listens. */
  async function ensure(worktreePath: string | undefined | null): Promise<RunPortLease | null> {
    const key = keyOf(worktreePath)
    if (!key) return null
    const table = load()
    const existing = table.get(key)
    if (existing) return existing
    const pending = inFlight.get(key)
    if (pending) return pending
    const run = (async () => {
      gc(table)
      const taken = new Set([...table.values()].map((l) => l.block))
      const candidates = candidateBlocks(area(), key, taken)
      // Bound the probing: a crowded machine falls back to the first candidate.
      for (const block of candidates.slice(0, 16)) {
        const range = blockRange(area(), block)
        let busy = false
        try { busy = await probeBlock(range.start, range.end) } catch { busy = false }
        const raced = table.get(key)
        if (raced) return raced
        if (busy || [...table.values()].some((l) => l.block === block)) continue
        return commit(table, key, block)
      }
      return lease(key)
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, run)
    return run
  }

  return {
    lease,
    ensure,
    /** Live leases (worktrees that still exist). */
    list(): RunPortLease[] {
      const table = load()
      if (gc(table)) persist(table)
      return [...table.values()]
    },
    release(worktreePath: string): void {
      const table = load()
      if (table.delete(canonical(worktreePath)) || table.delete(path.resolve(worktreePath))) persist(table)
    },
    /** Env additions for a process whose cwd/repo dir is `worktreePath` (empty for non-run paths). */
    env(worktreePath: string | undefined | null, base: NodeJS.ProcessEnv): Record<string, string> {
      return runPortEnv(lease(worktreePath), base)
    },
  }
}

export type RunPortLeaseTable = ReturnType<typeof createRunPortLeaseTable>

/** The app-wide table. */
export const runPortLeases: RunPortLeaseTable = createRunPortLeaseTable()

/** Merge the run's port env into `env` (a copy); non-run paths are returned unchanged. */
export function withRunPortEnv(env: NodeJS.ProcessEnv, worktreePath: string | undefined | null): NodeJS.ProcessEnv {
  const extra = runPortLeases.env(worktreePath, env)
  return Object.keys(extra).length ? { ...env, ...extra } : env
}
