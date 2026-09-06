import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { FrameworkManager, readCurrentFrameworkVersion, type FrameworkBroadcast } from './framework-manager'
import { isNewer, isValidVersion } from './semver-lite'
import { windowsSpawnEnv } from './util/win-spawn'
import { getBundledCoreVersion } from './bundled-core'
import { getCoreRuntimeStatus, managedCoreRoot, readCoreRuntime, type CoreRuntimeSource } from './core-runtime'
import { atomicWrite, withFileLock } from './artifact-registry'

/** Voluntary Core updates retain the complete npm package and dependencies,
 * publish its framework, then await every project refresh. Partial refreshes
 * remain explicitly pending across restart and can retry without the network.
 * Older packages/frameworks remain available for diagnosis and recovery. */

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
  runtimeVersion: string | null
  runtimeSource: CoreRuntimeSource | null
  frameworkVersion: string | null
  runtimeError: string | null
  pendingVersion: string | null
  migrationError: string | null
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
  reseed?: (version: string) => Promise<Array<{ projectId: string; error?: string }>>
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
  private pendingVersion: string | null = null
  private migrationError: string | null = null
  private readonly reseed: NonNullable<CoreUpdateManagerOptions['reseed']>

  constructor(opts: CoreUpdateManagerOptions = {}) {
    this.home = opts.home
    this.broadcast = opts.broadcast
    this.providersFn = opts.providers ?? (() => ['claude'])
    this.fetchLatestFn = opts.fetchLatest ?? (() => fetchLatestFromRegistry())
    this.npmInstallFn = opts.npmInstall ?? defaultNpmInstall
    this.makeFrameworkFn =
      opts.makeFramework ??
      ((coreRoot) => new FrameworkManager({ home: this.home, broadcast: this.broadcast, coreRoot }))
    this.reseed = opts.reseed ?? (async () => [])
    try {
      const cached = JSON.parse(fs.readFileSync(path.join(managedCoreRoot(this.home), 'update-status.json'), 'utf8'))
      if (typeof cached.latestVersion === 'string' && isValidVersion(cached.latestVersion) && Number.isFinite(cached.lastCheckedAt)) {
        this.latestVersion = cached.latestVersion
        this.lastCheckedAt = cached.lastCheckedAt
      }
      if (typeof cached.pendingVersion === 'string' && isValidVersion(cached.pendingVersion)) {
        this.pendingVersion = cached.pendingVersion
        this.migrationError = typeof cached.migrationError === 'string' ? cached.migrationError : 'Core project refresh was interrupted. Retry to finish updating project files.'
      }
    } catch { /* first launch / cache unavailable: installed state is independent */ }
  }

  /** True when the bundled-framework system is active (a bundled core is present). */
  isAvailable(): boolean {
    return getCoreRuntimeStatus(this.home).runtime !== null || readCurrentFrameworkVersion(this.home) !== null
  }

  /** Current status — no network (uses the cached latest from the last check). */
  getStatus(): CoreUpdateStatus {
    const selected = getCoreRuntimeStatus(this.home)
    const bundledVersion = getBundledCoreVersion()
    const frameworkVersion = readCurrentFrameworkVersion(this.home)
    const currentVersion = frameworkVersion ?? selected.runtime?.version ?? null
    const updateAvailable = this.pendingVersion !== null ||
      this.latestVersion != null &&
      currentVersion != null &&
      (isNewer(this.latestVersion, currentVersion) || selected.error !== null && this.latestVersion === currentVersion) &&
      Number(this.latestVersion.split('.')[0]) <= 5
    return {
      available: this.isAvailable(),
      currentVersion,
      bundledVersion,
      latestVersion: this.latestVersion,
      updateAvailable,
      updating: this.updating,
      lastCheckedAt: this.lastCheckedAt,
      runtimeVersion: selected.runtime?.version ?? null,
      runtimeSource: selected.runtime?.source ?? null,
      frameworkVersion,
      runtimeError: selected.error,
      pendingVersion: this.pendingVersion,
      migrationError: this.migrationError,
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
    this.persistStatus()
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
    const requested = (targetVersion ?? this.pendingVersion ?? this.latestVersion ?? '').trim().replace(/^[v=]+/, '')
    if (!requested || !isValidVersion(requested)) {
      return { ok: false, error: 'No valid target version to update to. Check for updates first.' }
    }
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requested) || ![4, 5].includes(Number(requested.split('.')[0]))) {
      return { ok: false, error: 'This Desktop supports Core 4 and 5. Update Desktop before installing another major version.' }
    }
    const current = readCurrentFrameworkVersion(this.home)
    if (current && !isNewer(requested, current) && !(requested === current && (getCoreRuntimeStatus(this.home).error || this.pendingVersion === requested))) {
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
    let tmp: string | undefined
    try {
      tmp = fs.mkdtempSync(path.join(realTmpDir(), 'core-update-'))
      const retained = path.join(managedCoreRoot(this.home), requested, 'node_modules', CORE_PACKAGE)
      if (readCoreRuntime(retained, 'managed')?.version === requested) {
        // A project migration retry can finish fully offline.
        fs.cpSync(path.dirname(path.dirname(retained)), tmp, { recursive: true })
      } else {
        this.npmInstallFn(`${CORE_PACKAGE}@${requested}`, tmp)
      }
      let coreRoot = path.join(tmp, 'node_modules', CORE_PACKAGE)
      const cli = path.join(coreRoot, 'dist', 'installer', 'cli.js')
      if (!fs.existsSync(cli)) {
        throw new Error('downloaded core is missing dist/installer/cli.js')
      }
      const staged = readCoreRuntime(coreRoot, 'managed')
      if (!staged || staged.version !== requested) throw new Error(`Downloaded Core version does not match requested ${requested}.`)
      const installed = staged.version
      // Retain the complete npm installation, including sibling dependencies.
      // Publication is a same-filesystem rename and occurs before current moves.
      const store = managedCoreRoot(this.home)
      fs.mkdirSync(store, { recursive: true, mode: 0o700 })
      const destination = path.join(store, installed)
      if (readCoreRuntime(path.join(destination, 'node_modules', CORE_PACKAGE), 'managed')?.version !== installed) {
        const staging = fs.mkdtempSync(path.join(store, '.stage-'))
        let retainedBackup: string | null = null
        try {
          fs.cpSync(tmp, staging, { recursive: true })
          try {
            fs.lstatSync(destination)
            const backup = fs.mkdtempSync(path.join(store, `.previous-${installed}-`))
            retainedBackup = path.join(backup, 'installation')
            fs.renameSync(destination, retainedBackup)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
          fs.renameSync(staging, destination)
        } catch (error) {
          // Restore only when publication never created a destination. The
          // retained previous installation is never deleted, even on success.
          if (retainedBackup && !fs.existsSync(destination)) fs.renameSync(retainedBackup, destination)
          throw error
        } finally { fs.rmSync(staging, { recursive: true, force: true }) }
      }
      coreRoot = path.join(destination, 'node_modules', CORE_PACKAGE)
      if (readCoreRuntime(coreRoot, 'managed')?.version !== installed) throw new Error('The retained Core package could not be verified. Retry the update.')
      const fm = this.makeFrameworkFn(coreRoot)

      this.emit('materializing', { version: installed })
      const providers = uniqueProviders(this.providersFn())
      withFileLock(this.home, () => {
        const now = readCurrentFrameworkVersion(this.home)
        if (now && isNewer(now, installed)) throw new Error(`Core advanced to ${now} while downloading; refusing to downgrade.`)
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
        // Recovery state is mandatory before publication. If this write fails,
        // current stays on the previous usable version and no project is reseeded.
        this.pendingVersion = installed
        this.migrationError = null
        this.persistStatus(true)
        const swapped = fm.swapCurrentDetailed(installed)
        if (!swapped.ok) {
          throw new Error(`framework swap-current failed${swapped.detail ? `: ${swapped.detail}` : ''}`)
        }
      })

      const projects = await this.reseed(installed)
      const failed = projects.filter(project => project.error)
      if (failed.length) throw new Error(`Core ${installed} is installed, but project refresh failed: ${failed.map(project => `${project.projectId}: ${project.error}`).join('; ')}. Retry the update to finish refreshing project files.`)
      this.pendingVersion = null
      this.migrationError = null

      // Installation is not a registry-latest check. Preserve its cached value
      // and timestamp, including a known version newer than this target.
      try { this.persistStatus(true) }
      catch (error) { this.pendingVersion = installed; throw error }
      this.updating = false
      this.emit('done', { version: installed })
      // Reuse the existing app-level event so any listener that reacts to a
      // framework version bump (e.g. core-version banners) refreshes too.
      this.safeBroadcast({ type: 'framework.updated', version: installed })
      return { ok: true, version: installed }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (this.pendingVersion) {
        this.migrationError = message
        this.persistStatus()
      }
      this.updating = false
      this.emit('error', { message })
      return { ok: false, error: message }
    } finally {
      this.updating = false
      try {
        if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
      } catch {
        /* best-effort temp cleanup */
      }
    }
  }

  private persistStatus(required = false): void {
    try {
      const root = managedCoreRoot(this.home)
      fs.mkdirSync(root, { recursive: true, mode: 0o700 })
      atomicWrite(path.join(root, 'update-status.json'), JSON.stringify({ latestVersion: this.latestVersion, lastCheckedAt: this.lastCheckedAt, pendingVersion: this.pendingVersion, migrationError: this.migrationError }))
    } catch (error) {
      if (required) throw new Error(`Could not persist Core update recovery state: ${error instanceof Error ? error.message : String(error)}`)
      // A registry-cache failure does not erase the installed version.
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
