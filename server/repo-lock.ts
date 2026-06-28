/**
 * Process-local per-key async mutex. Serialises work for a given key by chaining:
 * a new call waits for the previous one on the same key before running. Used so
 * concurrent rail merge-backs never run `git merge`/`reset` on the SAME base repo
 * at the same time (two single-ticket rails launched together are concurrent
 * writers). Different keys run in parallel.
 */
const chains = new Map<string, Promise<unknown>>()

export function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // Run after the previous holder settles (regardless of its outcome). The
  // caller still sees fn's own result/rejection.
  const run = prev.catch(() => undefined).then(() => fn())
  // Keep the chain alive but swallow errors so one failure never poisons the lock.
  chains.set(key, run.catch(() => undefined))
  return run
}

/** Test helper: forget all chains (avoids cross-test leakage). */
export function __resetRepoLocks(): void {
  chains.clear()
}
