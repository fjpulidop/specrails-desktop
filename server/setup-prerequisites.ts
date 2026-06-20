import { spawnSync } from 'child_process'
import type { SpawnSyncReturns } from 'child_process'
import crossSpawn from 'cross-spawn'
import fs from 'fs'
import path from 'path'
import { listAdapters } from './providers'
import { windowsSpawnEnv } from './util/win-spawn'
import { getBundledCoreCli } from './bundled-core'
import { getBundledOpenspecCli } from './bundled-openspec'

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

/**
 * Run `<cmd> <args>` synchronously. On Windows use cross-spawn (NOT `shell:true`):
 * it spawns a real `.exe` directly (no `cmd.exe` interposition — pkg-safe and
 * immune to the GUI-launch env stripping), and runs `.cmd`/`.bat` shims through
 * `cmd.exe` with correct quoting (Node refuses to spawn `.cmd` without a shell
 * since CVE-2024-27980). On POSIX it is a plain `spawnSync`. `windowsSpawnEnv()`
 * guarantees `cmd.exe` can start (SystemRoot/ComSpec present even if the sidecar
 * inherited a stripped env) — without it every bundled probe failed with a bogus
 * "bundle corrupted — reinstall the app".
 */
function runVersionSpawn(cmd: string, args: string[]): SpawnSyncReturns<string> {
  const opts = { env: windowsSpawnEnv(), encoding: 'utf-8' as const, timeout: 5_000 }
  if (process.platform === 'win32') {
    return crossSpawn.sync(cmd, args, opts)
  }
  return spawnSync(cmd, args, opts)
}

export type Platform = 'darwin' | 'win32' | 'linux'

/** Discriminator on `SetupPrerequisite.kind`. `'tool'` is a dev prerequisite
 *  always required (node, npm, npx, git) or always optional (uv). `'provider'`
 *  is an AI CLI registered in `providerRegistry`; at least one must be
 *  usable for the app to accept Add Project. */
export type PrerequisiteKind = 'tool' | 'provider'

export interface SetupPrerequisite {
  /** Stable lookup key. For tools: the literal `node`/`npm`/.... For providers:
   *  the adapter id (`claude`, `codex`, future ids). */
  key: string
  kind: PrerequisiteKind
  label: string
  command: string
  required: boolean
  installed: boolean
  /** True when `installed` AND `<command> --version` exits 0. */
  executable: boolean
  version?: string
  /** Absolute path returned by `which`, when found. Used for diagnostics. */
  resolvedPath?: string
  /** Raw failure detail when `installed && !executable`. Used for diagnostics. */
  executionError?: string
  /** Semver `major.minor.patch` minimum. Undefined = no minimum (e.g. npx). */
  minVersion?: string
  /** True when `installed` AND `executable` AND (no minVersion OR parsed version >= minVersion). */
  meetsMinimum: boolean
  installUrl: string
  installHint: string
  /** True when this tool is provided by the bundled runtime (desktop mode only). */
  bundled?: true
  /** Desktop mode: 'corrupted-bundle' when the bundled binary fails --version probe. */
  error?: 'corrupted-bundle'
}

export interface SetupPrerequisitesStatus {
  ok: boolean
  platform: Platform
  prerequisites: SetupPrerequisite[]
  missingRequired: SetupPrerequisite[]
}

export const MIN_VERSIONS: Record<'node' | 'npm' | 'git' | 'uv', string> = {
  node: '18.0.0',
  npm: '9.0.0',
  git: '2.20.0',
  uv: '0.1.0',
}

interface CommandLookup {
  found: boolean
  resolvedPath?: string
}

function locateCommand(command: string): CommandLookup {
  // cross-spawn (via runVersionSpawn) resolves the `where`/`which` executable
  // and PATHEXT itself — no `shell:true` needed — and runs under an env that
  // includes SystemRoot so `where` can actually start in the packaged sidecar.
  const result = runVersionSpawn(WHICH_CMD, [command])
  if (result.error || (result.status ?? 1) !== 0) return { found: false }
  const resolvedPath = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0]?.trim() || undefined
  return { found: true, resolvedPath }
}

interface VersionProbe {
  executed: boolean
  version?: string
  error?: string
}

/** Run `<bin> <args>` and interpret the result as a `--version` probe. */
function runProbe(bin: string, args: string[]): VersionProbe {
  const result = runVersionSpawn(bin, args)
  if (result.error) {
    const err = result.error as NodeJS.ErrnoException
    return { executed: false, error: `${err.code ?? 'ERR'}: ${err.message}` }
  }
  if ((result.status ?? 1) !== 0) {
    const stderr = `${result.stderr ?? ''}`.trim().slice(0, 400)
    const signal = result.signal ? ` signal=${result.signal}` : ''
    return { executed: false, error: `exit=${result.status ?? '?'}${signal}${stderr ? ` stderr=${stderr}` : ''}` }
  }
  const output = `${result.stdout ?? result.stderr ?? ''}`.trim()
  const version = output.split(/\r?\n/)[0]?.trim() || undefined
  return { executed: true, version }
}

function probeVersion(command: string, resolvedPath?: string): VersionProbe {
  // IMPORTANT: prefer the absolute path returned by `which`. When the server is
  // bundled with `pkg`, calling spawn with the bare command name `'node'` is
  // intercepted by pkg's child_process patch and redirected to `process.execPath`
  // (the server binary itself) — the child then crashes with
  // `Cannot find module '/--version'` from pkg/prelude/bootstrap.js. Passing
  // an absolute path bypasses this interception.
  const target = resolvedPath || command
  // Spawn via cross-spawn on Windows (NOT shell:true). A bundled `.exe`
  // (node.exe, git.exe) is launched DIRECTLY — no cmd.exe interposition — so a
  // path with spaces needs no manual quoting and pkg's bare-name redirect never
  // applies. A `.cmd` shim (npm.cmd, npx.cmd) is run through cmd.exe by
  // cross-spawn with correct escaping. The env carries SystemRoot so cmd.exe can
  // start. This replaces the old `shell:true` path that made every bundled probe
  // fail with a bogus "corrupted-bundle" when the sidecar env lacked SystemRoot.
  return runProbe(target, ['--version'])
}

/** Extracts the first `major.minor.patch` triple from a version string.
 *  Tolerates prefixes like `v`, `git version `, `node `. */
export function parseSemver(raw: string | undefined): [number, number, number] | null {
  if (!raw) return null
  const match = raw.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a)
  const pb = parseSemver(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}

function meetsMinimumVersion(version: string | undefined, minVersion: string | undefined): boolean {
  if (!minVersion) return true
  if (!version) return false
  return compareVersions(version, minVersion) >= 0
}

function brokenSymlinkHint(label: string, command: string, resolvedPath: string | undefined): string {
  const where = resolvedPath ? ` at ${resolvedPath}` : ''
  return `${label} found${where} but failed to execute — possibly a broken symlink or a stale install. Reinstall ${command} or remove the stale link${resolvedPath ? ` at ${resolvedPath}` : ''}.`
}

// ─── Desktop-mode bundled runtime helpers ─────────────────────────────────

type BundledToolKey = 'node' | 'npm' | 'npx' | 'git'
const BUNDLED_TOOL_KEYS: ReadonlySet<string> = new Set(['node', 'npm', 'npx', 'git'])

function isBundledTool(key: string): key is BundledToolKey {
  return BUNDLED_TOOL_KEYS.has(key)
}

/** Candidate absolute paths for a bundled tool, in priority order. Windows git
 *  ships the real binary at git/cmd/git.exe with a redirector at git/bin/git.exe
 *  — we accept either so a layout shift in the PortableGit extractor degrades to
 *  a working alternate rather than a false "corrupted-bundle". */
function getBundledToolCandidates(runtimesBase: string, tool: BundledToolKey): string[] {
  if (process.platform === 'win32') {
    const map: Record<BundledToolKey, string[]> = {
      node: [path.join(runtimesBase, 'node', 'node.exe')],
      npm:  [path.join(runtimesBase, 'node', 'npm.cmd')],
      npx:  [path.join(runtimesBase, 'node', 'npx.cmd')],
      git:  [path.join(runtimesBase, 'git', 'cmd', 'git.exe'), path.join(runtimesBase, 'git', 'bin', 'git.exe')],
    }
    return map[tool]
  }
  const map: Record<BundledToolKey, string[]> = {
    node: [path.join(runtimesBase, 'node', 'bin', 'node')],
    npm:  [path.join(runtimesBase, 'node', 'bin', 'npm')],
    npx:  [path.join(runtimesBase, 'node', 'bin', 'npx')],
    git:  [path.join(runtimesBase, 'git', 'bin', 'git')],
  }
  return map[tool]
}

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/** The bundled REAL node executable inside the runtimes tree, or null. */
function bundledNodeExe(runtimesBase: string): string | null {
  return getBundledToolCandidates(runtimesBase, 'node').find(fileExists) ?? null
}

/**
 * Absolute path to the bundled npm/npx CLI JS (`npm-cli.js` / `npx-cli.js`), or
 * null. The npm package ships INSIDE the node distribution: at
 * `node/node_modules/npm/bin/` on Windows and `node/lib/node_modules/npm/bin/`
 * on POSIX. Both `npm` and `npx` are served by the npm package (npx-cli.js lives
 * there too).
 */
function bundledNpmCliJs(runtimesBase: string, tool: 'npm' | 'npx'): string | null {
  const file = tool === 'npx' ? 'npx-cli.js' : 'npm-cli.js'
  const candidates =
    process.platform === 'win32'
      ? [path.join(runtimesBase, 'node', 'node_modules', 'npm', 'bin', file)]
      : [path.join(runtimesBase, 'node', 'lib', 'node_modules', 'npm', 'bin', file)]
  return candidates.find(fileExists) ?? null
}

/**
 * Probe a bundled npm/npx by running the bundled node DIRECTLY against the npm
 * package's CLI JS, instead of executing the `.cmd`/wrapper shim. The shims route
 * through `cmd.exe` (Windows) / a wrapper script and proved fragile in the
 * packaged app (a stripped sidecar env / cmd.exe quirks made `npm.cmd --version`
 * fail with a bogus "corrupted-bundle" even though node.exe itself runs fine).
 * Running `node npm-cli.js --version` is deterministic, shell-free and pkg-safe.
 * Returns null when the bundled node or the CLI JS isn't present (caller falls
 * back to probing the shim, then to the system tool).
 */
function probeBundledNpmLike(runtimesBase: string, tool: 'npm' | 'npx'): { probe: VersionProbe; resolvedPath: string } | null {
  const nodeExe = bundledNodeExe(runtimesBase)
  const cliJs = bundledNpmCliJs(runtimesBase, tool)
  if (!nodeExe || !cliJs) return null
  return { probe: runProbe(nodeExe, [cliJs, '--version']), resolvedPath: cliJs }
}

export interface PrerequisiteOptions {
  /** Optional: include `uv` (used by plugins like Serena). When false the
   *  setup wizard's `missingRequired` is not affected by uv's absence. */
  includeUv?: boolean
}

// Short-lived memo: probing involves up to ~12 synchronous spawnSync calls that
// block the single Express event loop. The endpoint only fires from low-freq
// setup flows, so a 30s TTL eliminates repeated probe storms (cold-cache
// client, window-focus rechecks) without masking real PATH changes.
let _statusCache: { key: string; at: number; value: SetupPrerequisitesStatus } | null = null
const STATUS_CACHE_TTL_MS = 30_000

export function getSetupPrerequisitesStatus(options: PrerequisiteOptions = {}): SetupPrerequisitesStatus {
  const key = options.includeUv ? 'uv' : 'base'
  const now = Date.now()
  if (_statusCache && _statusCache.key === key && now - _statusCache.at < STATUS_CACHE_TTL_MS) {
    return _statusCache.value
  }
  const value = computeSetupPrerequisitesStatus(options)
  _statusCache = { key, at: now, value }
  return value
}

/** Test-only: clear the short-lived prerequisites memo so each test re-probes. */
export function __resetSetupPrerequisitesCacheForTest(): void {
  _statusCache = null
}

function computeSetupPrerequisitesStatus(options: PrerequisiteOptions = {}): SetupPrerequisitesStatus {
  const isDesktop = process.env.SPECRAILS_IS_DESKTOP === '1'
  const runtimesBase = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? ''

  // When the app ships a bundled core AND bundled openspec, project-add is fully
  // OFFLINE: it runs `node cli.js` / `node openspec.js` directly and NEVER spawns
  // npm or npx. So npm/npx are advisory (not required) in that mode — a broken or
  // unprobeable npm/npx must NOT dead-end Add Project for tools the install flow
  // never invokes. Outside the bundled-offline path (dev / no bundle) npx IS used
  // (npx specrails-core), so npm/npx stay required there.
  const bundledOfflineSetup = isDesktop && getBundledCoreCli() !== null && getBundledOpenspecCli() !== null

  const platform: Platform = process.platform === 'darwin'
    ? 'darwin'
    : process.platform === 'win32'
      ? 'win32'
      : 'linux'

  const definitions: Array<Omit<SetupPrerequisite, 'installed' | 'executable' | 'version' | 'resolvedPath' | 'meetsMinimum'>> = [
    {
      key: 'node',
      kind: 'tool',
      label: 'Node.js',
      command: 'node',
      required: true,
      minVersion: MIN_VERSIONS.node,
      installUrl: 'https://nodejs.org/en/download',
      installHint: process.platform === 'win32'
        ? 'Install Node.js LTS, then restart Specrails so Windows refreshes PATH.'
        : 'Install Node.js LTS, then restart Specrails so PATH is refreshed.',
    },
    {
      key: 'npm',
      kind: 'tool',
      label: 'npm',
      command: 'npm',
      required: !bundledOfflineSetup,
      minVersion: MIN_VERSIONS.npm,
      installUrl: 'https://nodejs.org/en/download',
      installHint: 'npm ships with Node.js LTS.',
    },
    {
      key: 'npx',
      kind: 'tool',
      label: 'npx',
      command: 'npx',
      required: !bundledOfflineSetup,
      installUrl: 'https://nodejs.org/en/download',
      installHint: 'npx ships with npm and is required to run specrails-core.',
    },
    {
      key: 'git',
      kind: 'tool',
      label: 'Git',
      command: 'git',
      required: true,
      minVersion: MIN_VERSIONS.git,
      installUrl: process.platform === 'win32'
        ? 'https://git-scm.com/download/win'
        : 'https://git-scm.com/downloads',
      installHint: process.platform === 'win32'
        ? 'Install Git for Windows and enable the option that adds Git to PATH, then restart Specrails.'
        : 'Install Git and restart Specrails if PATH changed.',
    },
  ]

  // Provider CLIs (one entry per registered adapter). Individually `required:
  // false` — the "at least one provider" rule is enforced at the bottom of
  // this function, not via `required`.
  for (const adapter of listAdapters()) {
    definitions.push({
      key: adapter.id,
      kind: 'provider',
      label: adapter.displayName,
      command: adapter.binary,
      required: false,
      minVersion: adapter.minCliVersion ?? undefined,
      installUrl: providerInstallUrl(adapter.id),
      installHint: providerInstallHint(adapter.id, process.platform),
    })
  }

  if (options.includeUv) {
    definitions.push({
      key: 'uv',
      kind: 'tool',
      label: 'uv',
      command: 'uv',
      required: false,
      minVersion: MIN_VERSIONS.uv,
      installUrl: 'https://docs.astral.sh/uv/getting-started/installation/',
      installHint: process.platform === 'win32'
        ? 'Install uv via winget (`winget install astral-sh.uv`) or PowerShell installer, then restart Specrails.'
        : process.platform === 'darwin'
          ? 'Install uv via Homebrew (`brew install uv`) or the curl installer, then restart Specrails.'
          : 'Install uv via the curl installer (`curl -LsSf https://astral.sh/uv/install.sh | sh`), then restart Specrails.',
    })
  }

  const prerequisites: SetupPrerequisite[] = definitions.map((definition) => {
    // Desktop mode: probe bundled absolute paths for node/npm/npx/git.
    // Provider CLIs (claude, codex) are always probed via system PATH regardless of mode.
    if (isDesktop && definition.kind === 'tool' && isBundledTool(definition.key)) {
      const tool = definition.key as BundledToolKey
      // npm/npx: probe by running the bundled node DIRECTLY against the npm
      // package's CLI JS — robust where the `.cmd`/wrapper shim proved fragile in
      // the packaged app (cmd.exe / stripped-env quirks made `npm.cmd --version`
      // fail with a bogus "corrupted-bundle" even though node.exe runs fine).
      let effective: { probe: VersionProbe; resolvedPath: string } | null =
        tool === 'npm' || tool === 'npx' ? probeBundledNpmLike(runtimesBase, tool) : null

      // Otherwise (node/git, or npm/npx whose CLI JS wasn't found) probe the
      // bundled binary/shim directly. Only treat as bundled when the FILE exists;
      // a missing file means this build shipped no runtimes for this platform/arch
      // — fall through to the system probe so a system-installed tool still
      // satisfies the requirement instead of dead-ending Add Project with a futile
      // "reinstall the app". 'corrupted-bundle' is reserved for file-EXISTS-but-
      // fails-its-probe.
      if (!effective) {
        const bundledPath = getBundledToolCandidates(runtimesBase, tool).find(fileExists)
        if (bundledPath) {
          effective = { probe: probeVersion(tool, bundledPath), resolvedPath: bundledPath }
        }
      }

      if (effective) {
        const { probe, resolvedPath } = effective
        if (!probe.executed) {
          return {
            ...definition,
            installed: true,
            executable: false,
            bundled: true as const,
            error: 'corrupted-bundle' as const,
            resolvedPath,
            executionError: probe.error,
            meetsMinimum: false,
            installHint: 'Bundle corrupted — reinstall the Specrails app.',
          }
        }
        return {
          ...definition,
          installed: true,
          executable: true,
          bundled: true as const,
          version: probe.version,
          resolvedPath,
          meetsMinimum: meetsMinimumVersion(probe.version, definition.minVersion),
          installHint: '',
        }
      }
      // No bundled binary/CLI found → fall through to the system probe below.
    }

    // Non-desktop (or provider CLI in any mode, or desktop with bundle absent): system probe.
    const lookup = locateCommand(definition.command)
    const installed = lookup.found
    let executable = false
    let version: string | undefined
    let executionError: string | undefined
    if (installed) {
      const probe = probeVersion(definition.command, lookup.resolvedPath)
      executable = probe.executed
      version = probe.version
      executionError = probe.error
    }
    const meetsMinimum = installed && executable && meetsMinimumVersion(version, definition.minVersion)
    const installHint = installed && !executable
      ? brokenSymlinkHint(definition.label, definition.command, lookup.resolvedPath)
      : definition.installHint
    return {
      ...definition,
      installed,
      executable,
      version,
      resolvedPath: lookup.resolvedPath,
      executionError,
      meetsMinimum,
      installHint,
    }
  })

  // A required tool counts as missing if not installed, not executable, or below its minimum version.
  const missingRequired = prerequisites.filter(
    (item) => item.required && (!item.installed || !item.executable || !item.meetsMinimum),
  )

  // At-least-one provider rule: if no provider entry is usable, surface a
  // synthetic "missing required" entry so the UI blocks Add Project.
  const providers = prerequisites.filter((p) => p.kind === 'provider')
  const anyProviderUsable = providers.some(
    (p) => p.installed && p.executable && p.meetsMinimum,
  )
  if (providers.length > 0 && !anyProviderUsable) {
    // Mark all provider rows as missingRequired so PrerequisitesPanel renders
    // them visibly. They keep `required: false` so the type still matches the
    // tool semantics; the panel inspects `kind === 'provider'` for grouping.
    for (const p of providers) missingRequired.push(p)
  }

  return {
    ok: missingRequired.length === 0,
    platform,
    prerequisites,
    missingRequired,
  }
}

// ─── Provider install hints ────────────────────────────────────────────────

function providerInstallUrl(id: string): string {
  switch (id) {
    case 'claude':
      return 'https://claude.com/download'
    case 'codex':
      return 'https://developers.openai.com/codex'
    case 'gemini':
      return 'https://github.com/google-gemini/gemini-cli'
    default:
      return 'https://github.com'
  }
}

function providerInstallHint(id: string, platform: NodeJS.Platform): string {
  switch (id) {
    case 'claude':
      return 'Install Claude Code from https://claude.com/download, run `claude login`, then restart Specrails.'
    case 'codex':
      return platform === 'darwin'
        ? 'Install Codex CLI via `brew install codex` (or follow https://developers.openai.com/codex), authenticate with `codex login`, then restart Specrails.'
        : platform === 'win32'
          ? 'Install Codex CLI from https://developers.openai.com/codex, authenticate with `codex login`, then restart Specrails.'
          : 'Install Codex CLI from https://developers.openai.com/codex (or `pipx install codex-cli`), authenticate with `codex login`, then restart Specrails.'
    case 'gemini':
      return 'Install Gemini CLI via `npm i -g @google/gemini-cli` (or see https://github.com/google-gemini/gemini-cli), set GEMINI_API_KEY, then restart Specrails.'
    default:
      return `Install the ${id} CLI and restart Specrails.`
  }
}

export function formatMissingSetupPrerequisites(status = getSetupPrerequisitesStatus()): string | null {
  if (status.ok) return null

  return [
    'SpecRails setup needs a few developer tools before it can install this project.',
    '',
    ...status.missingRequired.map((item) => {
      if (!item.installed) {
        return `- ${item.label} (${item.command}) is not on PATH. ${item.installHint}`
      }
      if (!item.executable) {
        return `- ${item.installHint}`
      }
      // installed and executable but below minimum version
      return `- ${item.label} ${item.version ?? '?'} found, but version ${item.minVersion}+ is required. ${item.installHint}`
    }),
    '',
    'Install the missing tools, restart Specrails, then retry setup.',
  ].join('\n')
}
