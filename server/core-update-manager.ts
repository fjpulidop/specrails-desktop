import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { FrameworkManager, readCurrentFrameworkVersion, type FrameworkBroadcast } from './framework-manager'
import { isNewer, isValidVersion } from './semver-lite'
import { windowsSpawnEnv } from './util/win-spawn'

/**
 * CoreUpdateManager — the voluntary, app-global specrails-core update channel.
 *
 * The bundled framework (see FrameworkManager) is pinned to the core version
 * shipped inside the app build. This manager lets a user UPDATE specrails-core
 * independently of the desktop app: it queries npm for the latest published
 * version, and on an explicit request npm-installs that newer core into a temp
 * staging dir, materializes its framework into `~/.specrails/framework/<version>`
 * and atomically swaps `framework/current` to it — every project workspace that
 * symlinks `current/...` jumps to the new core with NO restart and NO per-project
 * `npx`. The previous `framework/<version>` dir is left intact (non-destructive).
 *
 * Detection is deliberately simple (KISS): npm `latest` strictly greater than the
 * installed `framework/current` version ⇒ an update is available. There is no
 * compatibility-range gate; the floor is the app-bundled core (the update only
 * ever moves the pointer UP — FrameworkManager.versionCheck has an anti-downgrade
 * guard so the next startup never reverts a manual update).
 *
 * The whole feature is gated on a bundled core being present (desktop mode); in
 * dev / non-desktop mode `isAvailable()` is false and projects use the legacy npx
 * path, so a core "update" would have no effect and the UI shows "unavailable".
 */

export const CORE_PACKAGE = 'specrails-core'
const REGISTRY_URL = `https://registry.npmjs.org/${CORE_PACKAGE}/latest`
const CHECK_TIMEOUT_MS = 10_000
const INSTALL_TIMEOUT_MS = 180_000

export type CoreUpdatePhase = 'downloading' | 'materializing' | 'done' | 'error'

export interface CoreUpdateStatus {
  /** True when the bundled-framework system is active (desktop mode). */
  available: boolean
  /** The version `framework/current` resolves to (falls back to bundled). */
  currentVersion: string | null
  /** The core version shipped inside this app build. */
  bundledVersion: string | null
  /** Latest published npm version (null until a check has run). */
  latestVersion: string | null
  /** latestVersion strictly newer than currentVersion. */
  updateAvailable: boolean
  /** An update is currently in progress. */
  updating: boolean
  /** Epoch ms of the last successful npm check (null if never). */
  lastCheckedAt: number | null
}

export interface CoreUpdateResult {
  ok: boolean
  version?: string
  error?: string
}

export interface CoreUpdateManagerOptions {
  home?: string
  broadcast?: FrameworkBroadcast
  /** Installed-provider union to materialize for (default `['claude']`). */
  providers?: () => string[]
  /** Override the npm-latest fetch (tests). */
  fetchLatest?: () => Promise<string>
  /** Override the npm install (tests). Installs `spec` into `cwd`. */
  npmInstall?: (spec: string, cwd: string) => void
  /** Override FrameworkManager construction for a staged core root (tests). */
  makeFramework?: (coreRoot: string) => FrameworkManager
}

export class CoreUpdateManager {
  private readonly home?: string
  private readonly broadcast?: FrameworkBroadcast
  private readonly providersFn: () => string[]
  private readonly fetchLatestFn: () => Promise<string>
  private readonly npmInstallFn: (spec: string, cwd: string) => void
  private readonly makeFrameworkFn: (coreRoot: string) => FrameworkManager

  private latestVersion: string | null = null
  private lastCheckedAt: number | null = null
  private updating = false

  constructor(opts: CoreUpdateManagerOptions = {}) {
    this.home = opts.home
    this.broadcast = opts.broadcast
    this.providersFn = opts.providers ?? (() => ['claude'])
    this.fetchLatestFn = opts.fetchLatest ?? (() => fetchLatestFromRegistry())
    this.npmInstallFn = opts.npmInstall ?? defaultNpmInstall
    this.makeFrameworkFn =
      opts.makeFramework ??
      ((coreRoot) => new FrameworkManager({ home: this.home, broadcast: this.broadcast, coreRoot }))
  }

  /** A read-only FrameworkManager pointed at the bundled core. */
  private bundledFramework(): FrameworkManager {
    return new FrameworkManager({ home: this.home })
  }

  /** True when the bundled-framework system is active (a bundled core is present). */
  isAvailable(): boolean {
    return this.bundledFramework().isAvailable()
  }

  /** Current status — no network (uses the cached latest from the last check). */
  getStatus(): CoreUpdateStatus {
    const fm = this.bundledFramework()
    const bundledVersion = fm.bundledVersion()
    const currentVersion = readCurrentFrameworkVersion(this.home) ?? bundledVersion
    const updateAvailable =
      this.latestVersion != null &&
      currentVersion != null &&
      isNewer(this.latestVersion, currentVersion)
    return {
      available: fm.isAvailable(),
      currentVersion,
      bundledVersion,
      latestVersion: this.latestVersion,
      updateAvailable,
      updating: this.updating,
      lastCheckedAt: this.lastCheckedAt,
    }
  }

  /** Hit npm for the latest published version, cache it, return refreshed status. */
  async checkForUpdate(): Promise<CoreUpdateStatus> {
    const latest = await this.fetchLatestFn()
    if (!isValidVersion(latest)) {
      throw new Error(`core-update: npm returned an unparseable version "${latest}"`)
    }
    this.latestVersion = latest.trim().replace(/^[v=]+/, '')
    this.lastCheckedAt = Date.now()
    return this.getStatus()
  }

  /**
   * Materialize + swap to `targetVersion` (default: the cached latest). Streams
   * `core_update.progress` WS events and broadcasts `framework.updated` on
   * success. Returns the outcome; never throws (errors become a failed result +
   * an `error` progress event).
   */
  async update(targetVersion?: string): Promise<CoreUpdateResult> {
    if (this.updating) {
      return { ok: false, error: 'An update is already in progress.' }
    }
    if (!this.isAvailable()) {
      return { ok: false, error: 'Core updates are unavailable in this build.' }
    }
    const requested = (targetVersion ?? this.latestVersion ?? '').trim().replace(/^[v=]+/, '')
    if (!requested || !isValidVersion(requested)) {
      return { ok: false, error: 'No valid target version to update to. Check for updates first.' }
    }
    const current = readCurrentFrameworkVersion(this.home)
    if (current && !isNewer(requested, current)) {
      return { ok: false, error: `Already on ${current}; ${requested} is not newer.` }
    }

    this.updating = true
    this.emit('downloading', { version: requested })
    // realpath the tmp root: on macOS os.tmpdir() is a symlinked path
    // (/var/folders → /private/var/folders). The staged core's cli.js has an
    // auto-run guard comparing import.meta.url (realpathed by Node's ESM
    // loader) against process.argv[1] (the literal spawn arg) — a symlinked
    // staging path makes them differ, so main() never runs and every
    // install-framework/swap-current child exits 0 as a silent no-op.
    const tmp = fs.mkdtempSync(path.join(realTmpDir(), 'core-update-'))
    try {
      this.npmInstallFn(`${CORE_PACKAGE}@${requested}`, tmp)
      const coreRoot = path.join(tmp, 'node_modules', CORE_PACKAGE)
      const cli = path.join(coreRoot, 'dist', 'installer', 'cli.js')
      if (!fs.existsSync(cli)) {
        throw new Error('downloaded core is missing dist/installer/cli.js')
      }
      const fm = this.makeFrameworkFn(coreRoot)
      // The version actually installed (npm may resolve a dist-tag/range).
      const installed = fm.bundledVersion() ?? requested

      this.emit('materializing', { version: installed })
      const providers = uniqueProviders(this.providersFn())
      const mat = fm.materialize(installed, providers)
      if (!mat.ran) {
        throw new Error('framework materialize did not run (no usable core)')
      }
      if (mat.errors.length > 0) {
        throw new Error(
          `framework materialize failed: ${mat.errors.map((e) => `${e.provider}: ${e.message}`).join('; ')}`,
        )
      }
      // A materialize that reports no errors but ALSO no materialized providers
      // wrote nothing — swapping `current` at a nonexistent version dir would
      // fail downstream with a misleading "swap-current failed". Surface the
      // real condition instead (mirrors FrameworkManager.versionCheck's guard).
      if (mat.providers.length === 0) {
        throw new Error(
          `framework materialize completed without materializing any provider (requested: ${providers.join(', ') || 'none'})`,
        )
      }
      const swapped = fm.swapCurrentDetailed(installed)
      if (!swapped.ok) {
        throw new Error(`framework swap-current failed${swapped.detail ? `: ${swapped.detail}` : ''}`)
      }

      this.latestVersion = installed
      this.lastCheckedAt = Date.now()
      this.emit('done', { version: installed })
      // Reuse the existing app-level event so any listener that reacts to a
      // framework version bump (e.g. core-version banners) refreshes too.
      this.safeBroadcast({ type: 'framework.updated', version: installed })
      return { ok: true, version: installed }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.emit('error', { message })
      return { ok: false, error: message }
    } finally {
      this.updating = false
      try {
        fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  private emit(phase: CoreUpdatePhase, extra: { version?: string; message?: string }): void {
    this.safeBroadcast({ type: 'core_update.progress', phase, ...extra })
  }

  private safeBroadcast(msg: { type: string; [k: string]: unknown }): void {
    try {
      this.broadcast?.(msg)
    } catch {
      /* broadcast is best-effort */
    }
  }
}

function uniqueProviders(values: string[]): string[] {
  const out = Array.from(new Set(values.filter((v) => typeof v === 'string' && v.length > 0)))
  return out.length > 0 ? out : ['claude']
}

/** os.tmpdir() with symlinks resolved (macOS /var/folders → /private/var/folders). */
function realTmpDir(): string {
  const dir = os.tmpdir()
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

/** GET the latest published version from the npm registry (no npm binary needed). */
async function fetchLatestFromRegistry(): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    })
    if (!res.ok) {
      throw new Error(`npm registry returned ${res.status}`)
    }
    const json = (await res.json()) as { version?: unknown }
    if (typeof json.version !== 'string' || json.version.length === 0) {
      throw new Error('npm registry response has no version field')
    }
    return json.version
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Install `spec` into `cwd` with a minimal isolated package.json — mirrors
 * `scripts/assemble-bundled-core.mjs`. On Windows npm is `npm.cmd`; Node 20.12+
 * (CVE-2024-27980) refuses to spawn a `.cmd` without a shell, so run through the
 * shell there. POSIX spawns directly.
 */
function defaultNpmInstall(spec: string, cwd: string): void {
  fs.writeFileSync(
    path.join(cwd, 'package.json'),
    JSON.stringify({ name: 'core-update-stage', private: true, version: '0.0.0' }),
  )
  execFileSync('npm', ['install', spec, '--no-audit', '--no-fund', '--no-save', '--ignore-scripts', '--silent'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: INSTALL_TIMEOUT_MS,
    shell: process.platform === 'win32',
    // SystemRoot/ComSpec so npm.cmd's cmd.exe can start even if the packaged
    // sidecar inherited a stripped Windows environment.
    env: windowsSpawnEnv(),
  })
}
