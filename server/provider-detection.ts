// App-level provider detection singleton.
//
// Provider availability is a property of the MACHINE, not of any project: this
// module probes every registered adapter (binary presence, version, auth state),
// applies the beta-flag vetoes at the source, and caches the result for 60s.
// Consumers (provider-selection, routers, setup) read the same snapshot, so the
// whole app agrees on which providers exist at any moment.
//
// Spec: openspec/changes/global-core-zero-friction/specs/provider-auto-detection/spec.md

import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listAdapters } from './providers'
import type { ProviderAdapter } from './providers/types'
import { checkCoreCompat, coreCompatSupportsProvider } from './core-compat'

export type ProviderAuthState = 'authenticated' | 'unauthenticated' | 'unknown'

export interface DetectedProvider {
  id: string
  displayName: string
  installed: boolean
  executable: boolean
  version?: string
  meetsMinimum?: boolean
  authState: ProviderAuthState
  /** True when the provider is usable (installed + executable + version floor met + not vetoed). */
  usable: boolean
  /** Human-readable issue when not usable. */
  error?: string
  /** Set when the provider is force-disabled by its beta env kill switch. */
  vetoed?: boolean
}

export interface DetectionSnapshot {
  /** Per-adapter probe results, keyed by provider id (includes vetoed/missing ones). */
  providers: Record<string, DetectedProvider>
  /** Ordered ids of usable providers (detected ∩ non-vetoed). */
  detected: string[]
  at: number
}

const CACHE_TTL_MS = 60_000
/** Auth probes are offline file checks today, but keep the contract bounded. */
export const AUTH_PROBE_TIMEOUT_MS = 1500

// Emergency rollback for the codex provider: SPECRAILS_CODEX_BETA=0 forces
// codex unavailable without redeploying. The pre-rebrand SPECRAILS_HUB_CODEX_BETA
// name is read as a legacy fallback when the new var is unset.
export function isCodexBetaDisabled(): boolean {
  const v = process.env.SPECRAILS_CODEX_BETA ?? process.env.SPECRAILS_HUB_CODEX_BETA
  return v === '0'
}

// Gemini parity kill switch: only the exact string '0' disables.
export function isGeminiBetaDisabled(): boolean {
  return process.env.SPECRAILS_GEMINI_BETA === '0'
}

function isVetoed(id: string): boolean {
  if (id === 'codex') return isCodexBetaDisabled()
  if (id === 'gemini') return isGeminiBetaDisabled()
  return false
}

/**
 * Offline, provider-specific auth probe. Never throws; degrades to 'unknown'.
 * These are file-presence heuristics — cheap, offline, and bounded — chosen
 * over spawning login-status subcommands (slow, sometimes network-bound).
 */
function probeAuthState(id: string, home: string): ProviderAuthState {
  try {
    switch (id) {
      case 'claude':
        // ~/.claude.json exists once the CLI has run/logged in. Credentials may
        // also live in the OS keychain, so absence is 'unknown', never a hard
        // 'unauthenticated'.
        return fs.existsSync(path.join(home, '.claude.json')) ? 'authenticated' : 'unknown'
      case 'codex': {
        // Match the invocation's custom home without reading credential bytes.
        // A relative override depends on the invocation cwd, so do not guess
        // an identity from this process's different working directory.
        const override = process.env.CODEX_HOME
        if (override && !path.isAbsolute(override)) return 'unknown'
        const authPath = path.join(override || path.join(home, '.codex'), 'auth.json')
        try {
          if (!fs.statSync(authPath).isFile()) return 'unknown'
          fs.accessSync(authPath, fs.constants.R_OK)
          return 'authenticated'
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unauthenticated' : 'unknown'
        }
      }
      case 'gemini': {
        // OAuth creds land under ~/.gemini; an API key via env also counts.
        if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'authenticated'
        return fs.existsSync(path.join(home, '.gemini', 'oauth_creds.json'))
          ? 'authenticated'
          : 'unknown'
      }
      default:
        // Kimi (and future providers) have no safe offline probe today.
        return 'unknown'
    }
  } catch {
    return 'unknown'
  }
}

function usabilityError(adapter: ProviderAdapter, d: {
  installed: boolean
  executable: boolean
  meetsMinimum?: boolean
  version?: string
  error?: string
}): string | undefined {
  if (!d.installed) return d.error ?? `${adapter.displayName} CLI was not found on PATH.`
  if (!d.executable) return d.error ?? `${adapter.displayName} was found but its readiness probe failed.`
  if (adapter.minCliVersion && d.meetsMinimum !== true) {
    return d.error
      ?? `${adapter.displayName} ${d.version ?? '(unknown version)'} does not satisfy the required minimum ${adapter.minCliVersion}.`
  }
  return undefined
}

async function probeAdapter(adapter: ProviderAdapter, home: string): Promise<DetectedProvider> {
  const vetoed = isVetoed(adapter.id)
  let detection: { installed: boolean; executable: boolean; version?: string; meetsMinimum?: boolean; error?: string }
  try {
    detection = await adapter.detectInstalled()
  } catch (err) {
    detection = {
      installed: false,
      executable: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  const error = usabilityError(adapter, detection)
  let usable = !vetoed && error === undefined
  // Kimi selection additionally requires a Core build that can render its
  // skills — same gate /available-providers applies.
  if (usable && adapter.id === 'kimi') {
    try {
      const core = await checkCoreCompat()
      if (!coreCompatSupportsProvider(core, 'kimi')) usable = false
    } catch {
      usable = false
    }
  }
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    installed: detection.installed,
    executable: detection.executable,
    version: detection.version,
    meetsMinimum: detection.meetsMinimum,
    authState: detection.installed ? probeAuthState(adapter.id, home) : 'unknown',
    usable,
    error,
    ...(vetoed ? { vetoed: true } : {}),
  }
}

let _snapshot: DetectionSnapshot | null = null
let _inflight: Promise<DetectionSnapshot> | null = null

async function runDetection(): Promise<DetectionSnapshot> {
  const home = os.homedir()
  const adapters = listAdapters()
  const results = await Promise.all(adapters.map((a) => probeAdapter(a, home)))
  const providers: Record<string, DetectedProvider> = {}
  for (const r of results) providers[r.id] = r
  const snapshot: DetectionSnapshot = {
    providers,
    detected: results.filter((r) => r.usable).map((r) => r.id),
    at: Date.now(),
  }
  _snapshot = snapshot
  return snapshot
}

/**
 * Read the detection snapshot. Cached for 60s; `refresh: true` bypasses the
 * cache (still coalescing concurrent refreshes into one probe run).
 */
export async function getDetectionSnapshot(opts?: { refresh?: boolean }): Promise<DetectionSnapshot> {
  const fresh = _snapshot && Date.now() - _snapshot.at < CACHE_TTL_MS
  if (fresh && !opts?.refresh) return _snapshot as DetectionSnapshot
  if (_inflight) return _inflight
  _inflight = runDetection().finally(() => {
    _inflight = null
  })
  return _inflight
}

/**
 * Synchronous accessor for the last snapshot's usable ids. Returns null when no
 * detection has completed yet — callers fall back to legacy project-row data.
 */
export function getDetectedIdsSync(): string[] | null {
  return _snapshot ? _snapshot.detected : null
}

export function getSnapshotSync(): DetectionSnapshot | null {
  return _snapshot
}

/**
 * Refresh and report whether the usable set changed vs the previous snapshot.
 * Callers use the flag to decide whether to broadcast `providers.detected_changed`.
 */
export async function refreshDetection(): Promise<{ snapshot: DetectionSnapshot; changed: boolean }> {
  const before = _snapshot?.detected.join(',') ?? null
  const snapshot = await getDetectionSnapshot({ refresh: true })
  const after = snapshot.detected.join(',')
  return { snapshot, changed: before !== null && before !== after }
}

/** Test-only: clear module state. */
export function _resetDetectionForTests(): void {
  _snapshot = null
  _inflight = null
}
