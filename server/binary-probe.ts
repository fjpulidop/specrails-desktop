import { execSync } from 'child_process'
import { windowsSpawnEnv } from './util/win-spawn'

// Windows has no `which`; probe via `where` instead. Both exit non-zero
// when the command is missing, which the try/catch relies on.
const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

// H19: the `which <binary>` probe is a synchronous subprocess that blocks the
// single event loop, and it ran on every job enqueue (QueueManager) and every
// chat turn (ChatManager). PATH contents change rarely, so memoize per binary
// with a short TTL — a freshly installed CLI is picked up after at most the
// TTL, and a stale positive fails loudly at spawn time anyway.
const PROBE_TTL_MS = 30_000
const _cache = new Map<string, { at: number; onPath: boolean }>()

export function binaryOnPath(binary: string): boolean {
  const now = Date.now()
  const hit = _cache.get(binary)
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.onPath
  let onPath: boolean
  try {
    // `where` runs via cmd.exe; pass a SystemRoot-backfilled env so the probe
    // (a HARD gate before job/chat spawns) can't be falsely cached as missing
    // when a packaged sidecar inherited a stripped env.
    execSync(`${WHICH_CMD} ${binary}`, { stdio: 'ignore', env: windowsSpawnEnv() })
    onPath = true
  } catch {
    onPath = false
  }
  _cache.set(binary, { at: now, onPath })
  return onPath
}

/** Test-only: clear the probe memo so each test re-probes. */
export function __resetBinaryProbeCacheForTest(): void {
  _cache.clear()
}
