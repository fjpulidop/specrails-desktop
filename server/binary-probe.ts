import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'child_process'
import { windowsSpawnEnv } from './util/win-spawn'
import { execBounded } from './util/bounded-exec'

// Windows has no `which`; probe via `where` instead. Both exit non-zero
// when the command is missing, which the try/catch relies on.
// Resolved per call so a platform override (tests) is honoured.
const whichCmd = (): 'where' | 'which' => (process.platform === 'win32' ? 'where' : 'which')

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
  // An absolute binary (the bundled Node that runs the local AI runner) is
  // probed by existence: `where C:\\…\\node.exe` does not resolve a path.
  if (path.isAbsolute(binary)) {
    onPath = fs.existsSync(binary)
    _cache.set(binary, { at: now, onPath })
    return onPath
  }
  try {
    // `where` runs via cmd.exe; pass a SystemRoot-backfilled env so the probe
    // (a HARD gate before job/chat spawns) can't be falsely cached as missing
    // when a packaged sidecar inherited a stripped env.
    execSync(`${whichCmd()} ${binary}`, { stdio: 'ignore', env: windowsSpawnEnv(), timeout: WHICH_TIMEOUT_MS })
    onPath = true
  } catch {
    onPath = false
  }
  _cache.set(binary, { at: now, onPath })
  return onPath
}

// ─── Async probes (event-loop safe) ─────────────────────────────────────────
// Provider detection, CLI status and /available-providers used to run
// `which <cli>` + `<cli> --version` through execSync: ~1 s per Node-based CLI,
// serially, with the whole server frozen. These run the SAME shell commands
// (so Windows `where` + npm `.cmd` shims resolve exactly as before) without
// blocking, bounded by a timeout that kills the process tree.

/** `which`/`where` lookups are local and fast; never let a hung PATH entry stall a probe. */
export const WHICH_TIMEOUT_MS = 3_000

export interface ProbeCommandOptions {
  /** Hard ceiling in ms. */
  timeout: number
  env?: NodeJS.ProcessEnv
}

/** Run a constant probe command through the platform shell; resolves trimmed stdout. */
export async function runProbeCommand(command: string, opts: ProbeCommandOptions): Promise<string> {
  const stdout = await execBounded(command, [], {
    shell: true,
    timeoutMs: opts.timeout,
    env: opts.env ?? process.env,
    killGraceMs: 500,
  })
  return stdout.trim()
}

/** A `which` lookup killed by its timeout proves nothing (a heavily loaded machine): it is retried once with this budget. */
export const WHICH_RETRY_TIMEOUT_MS = 15_000
const timedOut = (error: unknown): boolean => Boolean(error && typeof error === 'object' && (error as { timedOut?: unknown }).timedOut === true)

/** `which <binary>`: found, not found, or `unknown` when even the retry timed out. */
async function lookUp(binary: string, env: NodeJS.ProcessEnv | undefined): Promise<boolean | 'unknown'> {
  for (const timeout of [WHICH_TIMEOUT_MS, WHICH_RETRY_TIMEOUT_MS]) {
    try {
      await runProbeCommand(`${whichCmd()} ${binary}`, { timeout, env })
      return true
    } catch (error) {
      if (!timedOut(error)) return false
    }
  }
  return 'unknown'
}

export type CliProbeResult =
  | { installed: false; executable: false }
  | { installed: true; executable: false }
  | { installed: true; executable: true; versionOutput: string }

export interface CliProbeOptions {
  /** Budget for `<binary> --version` (Node CLIs cold-start slowly on Windows). */
  versionTimeoutMs: number
  env?: NodeJS.ProcessEnv
}

/**
 * The shared provider CLI readiness probe: PATH lookup, then `--version`.
 * Always probes fresh (detection is explicit) and refreshes the
 * `binaryOnPath` memo so spawn-time gates reuse the answer.
 */
export async function probeCliBinary(binary: string, opts: CliProbeOptions): Promise<CliProbeResult> {
  const found = await lookUp(binary, opts.env)
  if (found === false) {
    _cache.set(binary, { at: Date.now(), onPath: false })
    return { installed: false, executable: false }
  }
  // An unanswered lookup is never cached: the `--version` probe below decides, as for a slow CLI.
  if (found === true) _cache.set(binary, { at: Date.now(), onPath: true })
  try {
    const versionOutput = await runProbeCommand(`${binary} --version`, { timeout: opts.versionTimeoutMs, env: opts.env })
    return { installed: true, executable: true, versionOutput }
  } catch {
    return { installed: true, executable: false }
  }
}

/** Non-blocking `binaryOnPath`, sharing its memo and TTL. */
export async function binaryOnPathAsync(binary: string): Promise<boolean> {
  const now = Date.now()
  const hit = _cache.get(binary)
  if (hit && now - hit.at < PROBE_TTL_MS) return hit.onPath
  let onPath: boolean
  if (path.isAbsolute(binary)) {
    onPath = fs.existsSync(binary)
  } else {
    const found = await lookUp(binary, windowsSpawnEnv())
    // Unanswered (the machine is too loaded to run `which`): not proof of absence, and not cached.
    if (found === 'unknown') return true
    onPath = found
  }
  _cache.set(binary, { at: Date.now(), onPath })
  return onPath
}

/** Test-only: clear the probe memo so each test re-probes. */
export function __resetBinaryProbeCacheForTest(): void {
  _cache.clear()
}
