import { spawnSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { listAdapters } from './providers'

const WHICH_CMD = process.platform === 'win32' ? 'where' : 'which'

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
  const result = spawnSync(WHICH_CMD, [command], {
    env: process.env,
    shell: process.platform === 'win32',
    encoding: 'utf-8',
  })
  if (result.error || (result.status ?? 1) !== 0) return { found: false }
  const resolvedPath = `${result.stdout ?? ''}`.trim().split(/\r?\n/)[0]?.trim() || undefined
  return { found: true, resolvedPath }
}

interface VersionProbe {
  executed: boolean
  version?: string
  error?: string
}

function probeVersion(command: string, resolvedPath?: string): VersionProbe {
  // IMPORTANT: prefer the absolute path returned by `which`. When the server is
  // bundled with `pkg`, calling spawn with the bare command name `'node'` is
  // intercepted by pkg's child_process patch and redirected to `process.execPath`
  // (the server binary itself) — the child then crashes with
  // `Cannot find module '/--version'` from pkg/prelude/bootstrap.js. Passing
  // an absolute path bypasses this interception.
  const target = resolvedPath || command
  // On Windows we must use `shell: true` to execute `.cmd` shims (npm, npx) — Node
  // refuses to spawn them directly since CVE-2024-27980. But cmd.exe splits the
  // command line on whitespace, so an absolute path like
  // `C:\Program Files\Git\cmd\git.exe` becomes `C:\Program` + arg `Files\Git\...`.
  // Wrap the target in double quotes when it contains a space.
  const isWin = process.platform === 'win32'
  const quotedTarget = isWin && /\s/.test(target) ? `"${target}"` : target
  const result = spawnSync(quotedTarget, ['--version'], {
    env: process.env,
    shell: isWin,
    encoding: 'utf-8',
    timeout: 5_000,
  })
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
      required: true,
      minVersion: MIN_VERSIONS.npm,
      installUrl: 'https://nodejs.org/en/download',
      installHint: 'npm ships with Node.js LTS.',
    },
    {
      key: 'npx',
      kind: 'tool',
      label: 'npx',
      command: 'npx',
      required: true,
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
      const candidates = getBundledToolCandidates(runtimesBase, definition.key as BundledToolKey)
      const bundledPath = candidates.find(fileExists)
      // Only treat as bundled when the binary FILE actually exists. A missing
      // file means this build never shipped runtimes for this platform/arch
      // (e.g. a runtimes-less Windows ARM64 build, or a partial CI extraction)
      // — fall through to the system probe so a system-installed tool still
      // satisfies the requirement, instead of dead-ending Add Project with a
      // futile "reinstall the app" message. 'corrupted-bundle' is reserved for
      // the case where the file EXISTS but fails its --version probe.
      if (bundledPath) {
        const probe = probeVersion(definition.key, bundledPath)
        if (!probe.executed) {
          return {
            ...definition,
            installed: true,
            executable: false,
            bundled: true as const,
            error: 'corrupted-bundle' as const,
            resolvedPath: bundledPath,
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
          resolvedPath: bundledPath,
          meetsMinimum: meetsMinimumVersion(probe.version, definition.minVersion),
          installHint: '',
        }
      }
      // bundledPath not found → fall through to the system probe below.
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
