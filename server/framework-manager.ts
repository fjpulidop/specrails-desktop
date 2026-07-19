import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'

import { getBundledCoreCli, getBundledCoreVersion } from './bundled-core'
import { resolveHome, atomicWrite } from './artifact-registry'
import { isNewer } from './semver-lite'
import { resolveBundledNodeExe } from './path-resolver'

/**
 * The node interpreter to run the core CLI with. In the PACKAGED app
 * `process.execPath` is the `specrails-server` pkg binary — NOT node — so
 * `spawnSync(process.execPath, [cli, …])` would re-launch the server instead of
 * running `cli.js`, silently breaking every framework materialize/swap/assemble.
 * Use the bundled real node when present (it always is when a bundled core is —
 * they ship together), and fall back to `process.execPath` only in dev/tests
 * where `process.execPath` IS node.
 */
function nodeInterpreter(): string {
  return resolveBundledNodeExe() ?? process.execPath
}

/**
 * FrameworkManager — materializes the bundled specrails-core framework ONCE into
 * `~/.specrails/framework/<version>/<providerDir>/` and points
 * `~/.specrails/framework/current` at it, so every project workspace assembles by
 * SYMLINK (offline) instead of running a per-project `npx specrails-core init`.
 *
 * The heavy lifting lives in specrails-core's offline subcommands
 * (`install-framework` / `assemble`) — this manager only SHELLS OUT to the
 * bundled core CLI (resolved via `getBundledCoreCli()`), so there is ONE source
 * of truth for materialize + assemble.
 *
 * Existence-gated EVERYWHERE: when no bundled core is present (env absent / dev
 * mode / partial extraction) every method no-ops gracefully and the caller falls
 * back to the legacy npx path — byte-identical to today.
 */

export type FrameworkBroadcast = (msg: { type: string; [k: string]: unknown }) => void

export interface FrameworkManagerOptions {
  /** Overridable registry home (mirrors artifact-registry / core). Tests pin this. */
  home?: string
  /** App-level WS broadcast (no projectId) for `framework.updated`. */
  broadcast?: FrameworkBroadcast
  /**
   * Override the specrails-core package root used to materialize the framework.
   * Default: the BUNDLED core (`SPECRAILS_BUNDLED_CORE_PATH`). The core update
   * channel (`CoreUpdateManager`) passes a freshly npm-installed newer core root
   * here so `materialize`/`swapCurrent` run that version's `install-framework`
   * instead of the bundled one. When set, `<coreRoot>/dist/installer/cli.js`
   * must exist and its `package.json` version is the materialized version.
   */
  coreRoot?: string
}

export interface MaterializeResult {
  /** False when there is no bundled core (graceful no-op). */
  ran: boolean
  /** The version materialized (null when no-op). */
  version: string | null
  /** Providers that were materialized. */
  providers: string[]
  /** Per-provider exit failures, if any (empty on success). */
  errors: Array<{ provider: string; message: string }>
}

/** `~/.specrails/framework` — same home as the registry. */
export function frameworkRoot(home?: string): string {
  return path.join(resolveHome(home), '.specrails', 'framework')
}

/** Path to the `current` symlink under the framework root. */
function currentLink(home?: string): string {
  return path.join(frameworkRoot(home), 'current')
}

/**
 * Read the framework version from the documented per-version stamp marker that
 * core's `install-framework` writes at `<versionDir>/.framework-stamp<providerDir>.json`
 * (`{ version, provider, at }`). When `current` is a real dir (Windows copy
 * fallback) or a junction, the version is NOT recoverable from the path basename
 * (`current`), so the marker inside the dir is the source of truth.
 *
 * Returns the first non-empty `version` field found among any stamp markers
 * directly under `dir`, or null when none is present/readable.
 */
function readFrameworkVersionMarker(dir: string): string | null {
  let entries: string[]
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    // `.framework-stamp.claude.json` / `.framework-stamp.codex.json` / `.gemini`.
    if (!name.startsWith('.framework-stamp') || !name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string') {
        const v = parsed.version.trim()
        if (v.length > 0) return v
      }
    } catch {
      /* unreadable / malformed marker — try the next one */
    }
  }
  return null
}

/**
 * The version `framework/current` resolves to, or null when `current` is absent
 * / unresolvable. POSIX: reads the basename of the symlink target (the `<version>`
 * dir name). Windows junction/copy fallback: `current` is a real dir (or a
 * junction whose `lstat` is not a POSIX symlink), so the basename is `current`
 * and the version is read from the documented `.framework-stamp*.json` marker
 * inside it instead.
 */
export function readCurrentFrameworkVersion(home?: string): string | null {
  const link = currentLink(home)
  try {
    const st = fs.lstatSync(link)
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(link)
      const resolved = path.isAbsolute(target) ? target : path.resolve(frameworkRoot(home), target)
      const base = path.basename(resolved)
      // A POSIX symlink targets the `<version>` dir by name. A Windows junction
      // read as a symlink also yields the absolute `<version>` target, so the
      // basename is the version. Only when the basename is still `current`
      // (unresolvable) do we fall back to the stamp marker inside the dir.
      if (base !== 'current') return base
      return readFrameworkVersionMarker(resolved)
    }
    if (st.isDirectory()) {
      // Windows copy fallback / non-symlink junction: `current` is a real dir
      // holding the materialized framework. Read the version from its marker.
      return readFrameworkVersionMarker(link)
    }
    return null
  } catch {
    return null
  }
}

export class FrameworkManager {
  private readonly home?: string
  private readonly broadcast?: FrameworkBroadcast
  private readonly coreRoot?: string

  constructor(opts: FrameworkManagerOptions = {}) {
    this.home = opts.home
    this.broadcast = opts.broadcast
    this.coreRoot = opts.coreRoot
  }

  /**
   * Resolve the core CLI to shell out to: the override core root (update channel)
   * when set, else the bundled core. Returns null when neither is present.
   */
  private resolveCli(): string | null {
    if (this.coreRoot) {
      const cli = path.join(this.coreRoot, 'dist', 'installer', 'cli.js')
      return fs.existsSync(cli) ? cli : null
    }
    return getBundledCoreCli()
  }

  /** True when a usable core (override or bundled) is present (else methods no-op). */
  isAvailable(): boolean {
    return this.resolveCli() !== null
  }

  /**
   * The version the app should materialize: the override core's version (update
   * channel) when a `coreRoot` is set, else the bundled core version. Null when
   * neither is present / unreadable.
   */
  bundledVersion(): string | null {
    if (this.coreRoot) {
      try {
        const pkg = JSON.parse(
          fs.readFileSync(path.join(this.coreRoot, 'package.json'), 'utf8'),
        ) as { version?: string }
        const v = pkg.version?.trim()
        return v && v.length > 0 ? v : null
      } catch {
        return null
      }
    }
    return getBundledCoreVersion()
  }

  /**
   * Materialize the framework for `version` (default: the bundled core version)
   * for each provider — idempotent + offline. Shells out to the bundled core
   * `install-framework --no-swap` once per provider, so the materialize step
   * NEVER moves `current`: the caller (`versionCheck`) materializes EVERY
   * provider first, then issues a SINGLE `swapCurrent(version)` only when all of
   * them succeeded. This prevents a half-installed multi-provider release from
   * flipping `current` to a version whose other providerDirs are missing. No-ops
   * (ran:false) when no bundled core is present.
   */
  materialize(version?: string, providers: string[] = ['claude']): MaterializeResult {
    const cli = this.resolveCli()
    if (!cli) {
      return { ran: false, version: null, providers: [], errors: [] }
    }
    const ver = version ?? this.bundledVersion()
    if (!ver) {
      return { ran: false, version: null, providers: [], errors: [] }
    }

    const fwDir = frameworkRoot(this.home)
    fs.mkdirSync(fwDir, { recursive: true })

    const errors: MaterializeResult['errors'] = []
    const done: string[] = []
    for (const provider of dedupe(providers)) {
      const res = spawnSync(
        nodeInterpreter(),
        [
          cli,
          'install-framework',
          '--framework-dir',
          fwDir,
          '--provider',
          provider,
          '--version',
          ver,
          // Materialize-all-then-swap-once: each provider is installed WITHOUT
          // moving `current`; the finalising swap happens in versionCheck.
          '--no-swap',
        ],
        { env: this.childEnv(), encoding: 'utf-8', timeout: 120_000 },
      )
      if (res.error || (res.status ?? 1) !== 0) {
        const msg = res.error?.message ?? (res.stderr || `exit ${res.status ?? 'unknown'}`)
        errors.push({ provider, message: `${msg}`.trim() })
      } else {
        done.push(provider)
      }
    }
    return { ran: true, version: ver, providers: done, errors }
  }

  /**
   * Atomically point `framework/current` at `version` via core's dedicated
   * `swap-current` subcommand — the ONE finalising step after every provider was
   * materialized with `--no-swap`. Guard/no-op when `current` already points at
   * `version`. Returns true when `current` ended up at `version`.
   *
   * The `provider` param is retained for signature compatibility but is unused:
   * `swap-current` only moves the version pointer (provider-invariant).
   */
  swapCurrent(version: string, _provider = 'claude'): boolean {
    return this.swapCurrentDetailed(version).ok
  }

  /**
   * Like `swapCurrent`, but on failure carries WHY it failed (`detail`) — the
   * subprocess stderr/exit or the missing-CLI/verify-mismatch case — so callers
   * (the core update channel) can surface an actionable error instead of the
   * bare "swap-current failed".
   */
  swapCurrentDetailed(version: string): { ok: boolean; detail: string | null } {
    const cli = this.resolveCli()
    if (!cli) return { ok: false, detail: 'no usable core CLI to run swap-current with' }
    if (readCurrentFrameworkVersion(this.home) === version) return { ok: true, detail: null }
    const fwDir = frameworkRoot(this.home)
    const res = spawnSync(
      nodeInterpreter(),
      [cli, 'swap-current', '--framework-dir', fwDir, '--version', version],
      { env: this.childEnv(), encoding: 'utf-8', timeout: 120_000 },
    )
    if (res.error || (res.status ?? 1) !== 0) {
      const detail = (res.error?.message ?? `${res.stderr || res.stdout || ''}`.trim()) || `exit ${res.status ?? 'unknown'}`
      return { ok: false, detail }
    }
    if (readCurrentFrameworkVersion(this.home) !== version) {
      return { ok: false, detail: `swap-current exited 0 but current still resolves to ${readCurrentFrameworkVersion(this.home) ?? 'nothing'}` }
    }
    return { ok: true, detail: null }
  }

  /**
   * Compare the bundled core version with `framework/current`. When they differ
   * (or current is absent), materialize the bundled version + swap `current` and
   * broadcast `framework.updated`. Called on first-run + post-update. No-ops when
   * no bundled core is present. Returns the resulting current version (or null).
   */
  versionCheck(providers: string[] = ['claude']): { swapped: boolean; version: string | null } {
    const bundled = this.bundledVersion()
    if (!this.resolveCli() || !bundled) {
      return { swapped: false, version: readCurrentFrameworkVersion(this.home) }
    }
    const current = readCurrentFrameworkVersion(this.home)
    if (current === bundled) {
      return { swapped: false, version: current }
    }
    // Anti-downgrade guard: NEVER swap `current` down to the bundled version when
    // `current` is already NEWER. The core update channel lets a user voluntarily
    // materialize a core newer than the one shipped in this app build; without
    // this guard the next startup versionCheck would revert that manual update
    // back to the (older) bundled version. Only first-run (current null) or a
    // genuinely newer bundled core (a fresh app update) proceeds.
    if (current && !isNewer(bundled, current)) {
      return { swapped: false, version: current }
    }
    // Materialize EVERY requested provider first (each with `--no-swap`), then
    // swap `current` ONCE — and ONLY when every provider materialized cleanly.
    // A partial multi-provider install must NEVER flip `current`: doing so would
    // point `current` at a version whose other providerDirs are missing, so a
    // rail spawning under a non-materialized provider would fail to assemble.
    const mat = this.materialize(bundled, providers)
    if (!mat.ran) {
      return { swapped: false, version: current }
    }
    if (mat.errors.length > 0) {
      // Do NOT swap; surface the failure (don't discard it, don't report success).
      try {
        this.broadcast?.({
          type: 'framework.update_failed',
          version: bundled,
          errors: mat.errors,
        })
      } catch {
        /* broadcast is best-effort */
      }
      return { swapped: false, version: current }
    }
    if (mat.providers.length === 0) {
      // No errors yet nothing materialized (empty/duplicate-only provider list).
      return { swapped: false, version: current }
    }
    const swap = this.swapCurrentDetailed(bundled)
    if (swap.ok) {
      try {
        this.broadcast?.({ type: 'framework.updated', version: bundled })
      } catch {
        /* broadcast is best-effort */
      }
      return { swapped: true, version: bundled }
    }
    // Materialized cleanly but the swap itself failed — surface as a failure.
    try {
      this.broadcast?.({
        type: 'framework.update_failed',
        version: bundled,
        errors: [{ provider: providers[0] ?? 'claude', message: `swap-current failed${swap.detail ? `: ${swap.detail}` : ''}` }],
      })
    } catch {
      /* broadcast is best-effort */
    }
    return { swapped: false, version: readCurrentFrameworkVersion(this.home) }
  }

  /**
   * Assemble a project workspace by SYMLINKING the materialized framework into
   * it (offline) via the bundled core `assemble` subcommand. Returns false (no-op)
   * when no bundled core is present — caller falls back to legacy npx assembly.
   */
  assembleWorkspace(input: {
    workspace: string
    provider: string
    version?: string
    codeRoot: string
  }): { ran: boolean; error?: string } {
    const cli = this.resolveCli()
    if (!cli) return { ran: false }
    const ver = input.version ?? this.bundledVersion()
    if (!ver) return { ran: false }
    const fwDir = frameworkRoot(this.home)
    const res = spawnSync(
      nodeInterpreter(),
      [
        cli,
        'assemble',
        '--workspace',
        input.workspace,
        '--framework-dir',
        fwDir,
        '--provider',
        input.provider,
        '--version',
        ver,
        '--code-root',
        input.codeRoot,
      ],
      { env: this.childEnv(), encoding: 'utf-8', timeout: 120_000 },
    )
    if (res.error || (res.status ?? 1) !== 0) {
      const msg = res.error?.message ?? (res.stderr || `exit ${res.status ?? 'unknown'}`)
      return { ran: true, error: `${msg}`.trim() }
    }
    return { ran: true }
  }

  /** Child env: thread the registry home so the core CLI co-locates framework + registry. */
  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    if (this.home) {
      env.SPECRAILS_REGISTRY_HOME = this.home
    }
    // Point the core CLI's scriptDir at the package whose framework we are
    // materializing so its template/command sources resolve from there: the
    // OVERRIDE core (update channel) when set, else the bundled package.
    const coreRoot = this.coreRoot ?? process.env.SPECRAILS_BUNDLED_CORE_PATH
    if (coreRoot) env.SPECRAILS_CORE_SCRIPT_DIR = coreRoot
    return env
  }
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values))
}

// Re-export atomicWrite for symmetry (the atomic swap is delegated to core's
// ensureCurrentSymlink; this keeps the dependency explicit for future callers
// that may need a desktop-side atomic write of framework metadata).
export { atomicWrite }
