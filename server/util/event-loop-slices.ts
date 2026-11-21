/**
 * Cooperative slicing for cross-project read models. Each project's read stays
 * synchronous (one SQLite connection, consistent rows), but the event loop gets
 * a turn every few milliseconds so health checks, WebSocket frames and other
 * requests are not queued behind a read of every project.
 */
export const DEFAULT_SLICE_MS = 6

/** Yield one macrotask turn (I/O and timers run before the caller resumes). */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/**
 * Map `items` in order, yielding to the event loop whenever a slice has run for
 * `sliceMs`. A throwing `fn` is the caller's to isolate; the order of results
 * always matches `items`.
 */
export async function mapInSlices<T, R>(items: readonly T[], fn: (item: T, index: number) => R, sliceMs: number = DEFAULT_SLICE_MS): Promise<R[]> {
  const out: R[] = []
  let sliceStart = Date.now()
  for (let index = 0; index < items.length; index++) {
    out.push(fn(items[index], index))
    if (index < items.length - 1 && Date.now() - sliceStart >= sliceMs) {
      await yieldToEventLoop()
      sliceStart = Date.now()
    }
  }
  return out
}

/** A read that already ran: replays its value, or rethrows its failure. */
export type Settled<R> = { ok: true; value: R } | { ok: false; error: unknown }

export function settle<R>(read: () => R): Settled<R> {
  try { return { ok: true, value: read() } } catch (error) { return { ok: false, error } }
}

export function replay<R>(result: Settled<R>): R {
  if (result.ok) return result.value
  throw result.error
}
