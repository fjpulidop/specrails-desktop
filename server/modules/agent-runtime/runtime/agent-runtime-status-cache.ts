import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-controller (= per-project) cache of Core `status` reads.
 *
 * Every Core status read spawns a Node process (~0.5 s, several seconds when
 * the Board asks for all rails at once). The cache keeps the rail board and the
 * history list from re-spawning Core for runs whose answer cannot have changed:
 *
 * - legacy runs (checkpoint.json journal): keyed by the checkpoint's content
 *   hash, exactly as before;
 * - engine v2 runs (SQLite/WAL): keyed by a stat fingerprint of the run's
 *   workflow store and only reused while the run is settled (no live lease,
 *   not running, no host task in progress, not active in Desktop) and for at
 *   most `settledTtlMs`. Live runs are never served from the cache.
 *
 * Concurrent reads of the same run share one Core process, and at most
 * `maxConcurrent` status processes run at once. `invalidate` drops the cached
 * value and detaches any pending read so its result is not stored.
 */
export interface StatusFingerprint { kind: 'legacy' | 'v2'; key: string }

export const SETTLED_STATUS_TTL_MS = 5 * 60_000
export const MAX_CONCURRENT_STATUS_READS = 4

function statKey(file: string): string {
  try {
    const stat = fs.statSync(file)
    return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
  } catch { return '-' }
}

/** Cheap identity of the files Core reads to answer `status` for this run. */
export function runtimeStatusFingerprint(contextFile: string, runId: string): StatusFingerprint | null {
  const directory = path.dirname(contextFile)
  const workflow = path.join(directory, 'agent-workflow')
  const checkpoint = path.join(workflow, runId, 'checkpoint.json')
  const store = path.join(workflow, 'run.sqlite')
  if (fs.existsSync(store)) {
    // The -shm index can change on reads; the database and its WAL change on every write.
    const files = [store, `${store}-wal`, checkpoint, path.join(directory, 'desktop-runtime-selection.json'), path.join(directory, 'desktop-runtime-config.json')]
    return { kind: 'v2', key: files.map(statKey).join('|') }
  }
  if (!fs.existsSync(checkpoint)) return null
  return { kind: 'legacy', key: createHash('sha256').update(fs.readFileSync(checkpoint)).digest('hex') }
}

export class RuntimeStatusCache<S> {
  private entries = new Map<string, { fingerprint: string; kind: StatusFingerprint['kind']; state: S; at: number }>()
  private pending = new Map<string, { token: object; promise: Promise<S> }>()
  private running = 0
  private queue: Array<() => void> = []

  constructor(private options: { settledTtlMs?: number; maxConcurrent?: number; now?: () => number } = {}) {}

  private get now(): number { return (this.options.now ?? Date.now)() }

  /**
   * `settled` is evaluated at read time against the cached state: a run that
   * resumed (Desktop or loop manager) stops being served from the cache even
   * before its files change.
   */
  async read(runId: string, fingerprint: StatusFingerprint | null, settled: (state: S) => boolean, load: () => Promise<S>): Promise<{ state: S; cached: boolean }> {
    const entry = this.entries.get(runId)
    if (entry && fingerprint && entry.fingerprint === fingerprint.key && entry.kind === fingerprint.kind) {
      const fresh = entry.kind === 'legacy' || (this.now - entry.at < (this.options.settledTtlMs ?? SETTLED_STATUS_TTL_MS) && settled(entry.state))
      if (fresh) return { state: entry.state, cached: true }
    }
    // Once a run is seen live (or its files moved on) the old answer is gone for good.
    if (entry) this.entries.delete(runId)
    const inflight = this.pending.get(runId)
    if (inflight) return { state: await inflight.promise, cached: false }
    const token = {}
    const promise = this.limited(load).then((state) => {
      if (this.pending.get(runId)?.token === token) {
        if (fingerprint && (fingerprint.kind === 'legacy' || settled(state))) this.entries.set(runId, { fingerprint: fingerprint.key, kind: fingerprint.kind, state, at: this.now })
        else this.entries.delete(runId)
      }
      return state
    }).finally(() => { if (this.pending.get(runId)?.token === token) this.pending.delete(runId) })
    this.pending.set(runId, { token, promise })
    return { state: await promise, cached: false }
  }

  invalidate(runId?: string): void {
    if (runId === undefined) { this.entries.clear(); this.pending.clear(); return }
    this.entries.delete(runId)
    this.pending.delete(runId)
  }

  private async limited<T>(task: () => Promise<T>): Promise<T> {
    const max = this.options.maxConcurrent ?? MAX_CONCURRENT_STATUS_READS
    // A finishing read hands its slot straight to the next waiter.
    if (this.running >= max) await new Promise<void>(resolve => this.queue.push(resolve))
    else this.running += 1
    try { return await task() } finally {
      const next = this.queue.shift()
      if (next) next()
      else this.running -= 1
    }
  }
}
