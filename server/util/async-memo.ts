/**
 * Keyed async memo with a time-to-live and in-flight sharing.
 *
 * Concurrent `get` calls for the same key share one pending load; a settled
 * value is reused until `ttlMs` elapses or the key is invalidated. A rejected
 * load is never cached, so the next call retries. An invalidation that lands
 * while a load is pending discards that load's result instead of caching a
 * value computed before the change.
 *
 * Callers own the key space: key per project/run (never a bare global key for
 * project data) so one project's value cannot be served to another.
 */
export interface AsyncMemo<K, V> {
  get(key: K, load: () => Promise<V>): Promise<V>
  /** Drop one key (or every key when omitted), including a pending load's future result. */
  invalidate(key?: K): void
  /** Settled entries currently held (expired ones are pruned lazily). */
  size(): number
}

export function createAsyncMemo<K, V>(options: { ttlMs: number; now?: () => number; maxEntries?: number }): AsyncMemo<K, V> {
  const now = options.now ?? (() => Date.now())
  const maxEntries = options.maxEntries ?? 1_000
  const settled = new Map<K, { at: number; value: V }>()
  const pending = new Map<K, { promise: Promise<V>; generation: number }>()
  let generation = 0
  const generations = new Map<K, number>()
  const keyGeneration = (key: K) => generations.get(key) ?? 0

  return {
    get(key, load) {
      const hit = settled.get(key)
      if (hit && now() - hit.at < options.ttlMs) return Promise.resolve(hit.value)
      if (hit) settled.delete(key)
      const inflight = pending.get(key)
      if (inflight && inflight.generation === keyGeneration(key) + generation) return inflight.promise
      const started = keyGeneration(key) + generation
      const promise = Promise.resolve().then(load).then((value) => {
        if (keyGeneration(key) + generation === started) {
          if (settled.size >= maxEntries) settled.delete(settled.keys().next().value as K)
          settled.set(key, { at: now(), value })
        }
        return value
      }).finally(() => {
        if (pending.get(key)?.promise === promise) pending.delete(key)
      })
      pending.set(key, { promise, generation: started })
      return promise
    },
    invalidate(key) {
      if (key === undefined) {
        generation += 1
        settled.clear()
        return
      }
      generations.set(key, keyGeneration(key) + 1)
      settled.delete(key)
    },
    size() { return settled.size },
  }
}
