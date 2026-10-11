import { spawn, spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChildProcess, SpawnSyncReturns } from 'child_process'
import { windowsSpawnEnv, stripWindowsVerbatimPrefix } from './util/win-spawn'

/** Bundled-path env vars set by the Tauri host — normalized at startup. */
const BUNDLED_PATH_ENV_VARS = [
  'SPECRAILS_BUNDLED_RUNTIMES_PATH',
  'SPECRAILS_BUNDLED_CORE_PATH',
  'SPECRAILS_BUNDLED_OPENSPEC_PATH',
  'SPECRAILS_BUNDLED_MCP_BRIDGE_PATH',
  'SPECRAILS_BUNDLED_DOCS_PATH',
] as const

/**
 * Backfill the Windows shell-critical environment into `process.env` ONCE at
 * startup. The desktop server runs as a pkg sidecar launched by the Tauri host,
 * which can deliver a STRIPPED env missing `SystemRoot`/`windir`/`ComSpec`
 * (and the npm-config family). Without `SystemRoot`, every `cmd.exe`-mediated
 * spawn — PTY/PowerShell, `execSync('where …')`, `.cmd` shims — fails to start.
 * Doing this on `process.env` directly means EVERY downstream consumer that
 * copies `process.env` (terminal-manager, binary-probe, plugin spawns, …) is
 * protected at the source, in addition to the per-callsite `windowsSpawnEnv()`.
 *
 * ALSO strips the Windows verbatim prefix (`\\?\`) from the bundled-path env
 * vars. Tauri's `resource_dir()` returns `\\?\C:\…` paths; Node's module loader
 * `realpathSync` mishandles that prefix when resolving the main entry script,
 * crashing the bundled-core child with `EISDIR: lstat 'C:'`. Normalizing here
 * (before resolveStartupPath + before any spawn) means every reader
 * (getBundledCoreCli, resolveBundledNodeExe, chromium/docs/setup-prerequisites,
 * the PATH prepend) gets a plain `C:\…` path. No-op on POSIX / already-present /
 * unprefixed. Idempotent.
 */
export function ensureWindowsBaseEnv(): void {
  if (process.platform !== 'win32') return
  Object.assign(process.env, windowsSpawnEnv(process.env))
  for (const key of BUNDLED_PATH_ENV_VARS) {
    const v = process.env[key]
    if (v) process.env[key] = stripWindowsVerbatimPrefix(v)
  }
}

export type PathSource = 'inherited' | 'fast-path' | 'login-shell' | 'bundled'
export type LoginShellStatus = 'ok' | 'skipped' | 'timeout' | 'error'

interface PathDiagnostic {
  pathSegments: string[]
  pathSources: PathSource[]
  loginShellStatus: LoginShellStatus
}

const PATH_BEGIN = '__SRH_PATH_BEGIN__'
const PATH_END = '__SRH_PATH_END__'
const LOGIN_SHELL_TIMEOUT_MS = 1500

let diagnostic: PathDiagnostic = {
  pathSegments: [],
  pathSources: [],
  loginShellStatus: 'skipped',
}

let warnedLoginShell = false

/**
 * True once `resolveStartupPath()` has actually prepended at least one bundled
 * runtime dir that exists on disk. Gates the login-shell no-op: when a desktop
 * build ships no runtimes (e.g. Windows ARM64, or a partial CI extraction) the
 * bundle is NOT active, so we fall back to system discovery + login-shell
 * augmentation instead of going dark.
 */
let bundledRuntimesActive = false

function fileExists(p: string): boolean {
  try {
    return fs.existsSync(p)
  } catch {
    return false
  }
}

/**
 * Resolve the bin directory for each bundled tool family from the actual binary
 * FILE (not just the directory), returning the dir to prepend or `null`. Keeping
 * this file-level and symmetric with setup-prerequisites means "bundle active"
 * means the same thing in both modules.
 */
function resolveBundledBinDirs(runtimesPath: string): { nodeBinDir: string | null; gitBinDir: string | null; uvBinDir: string | null } {
  const isWin = process.platform === 'win32'
  const nodeBinDir = isWin
    ? (fileExists(path.join(runtimesPath, 'node', 'node.exe')) ? path.join(runtimesPath, 'node') : null)
    : (fileExists(path.join(runtimesPath, 'node', 'bin', 'node')) ? path.join(runtimesPath, 'node', 'bin') : null)
  let gitBinDir: string | null = null
  if (isWin) {
    // PortableGit ships the real binary at git/cmd/git.exe with a redirector at git/bin/git.exe.
    if (fileExists(path.join(runtimesPath, 'git', 'cmd', 'git.exe'))) gitBinDir = path.join(runtimesPath, 'git', 'cmd')
    else if (fileExists(path.join(runtimesPath, 'git', 'bin', 'git.exe'))) gitBinDir = path.join(runtimesPath, 'git', 'bin')
  } else if (fileExists(path.join(runtimesPath, 'git', 'bin', 'git'))) {
    gitBinDir = path.join(runtimesPath, 'git', 'bin')
  }
  const uvBinDir = isWin
    ? (fileExists(path.join(runtimesPath, 'uv', 'uv.exe')) ? path.join(runtimesPath, 'uv')
      : fileExists(path.join(runtimesPath, 'uv', 'bin', 'uv.exe')) ? path.join(runtimesPath, 'uv', 'bin')
        : null)
    : (fileExists(path.join(runtimesPath, 'uv', 'bin', 'uv')) ? path.join(runtimesPath, 'uv', 'bin')
      : fileExists(path.join(runtimesPath, 'uv', 'uv')) ? path.join(runtimesPath, 'uv')
        : null)
  return { nodeBinDir, gitBinDir, uvBinDir }
}

/**
 * Bin dir of the bundled GitHub CLI (`runtimes/gh/bin/gh[.exe]`), or null.
 * Unlike node/git, gh is a SYSTEM-FIRST tool: the user's own gh (with their
 * auth/hosts config, GHES setups, aliases) must always win, so this dir is
 * APPENDED to the END of PATH — it only resolves when no system gh exists.
 * It also never participates in the bundle-activation gate (node+git only).
 */
function resolveBundledGhBinDir(runtimesPath: string): string | null {
  const bin = process.platform === 'win32'
    ? path.join(runtimesPath, 'gh', 'bin', 'gh.exe')
    : path.join(runtimesPath, 'gh', 'bin', 'gh')
  return fileExists(bin) ? path.join(runtimesPath, 'gh', 'bin') : null
}

function getDelimiter(): string {
  return process.platform === 'win32' ? ';' : ':'
}

function splitPath(value: string | undefined): string[] {
  if (!value) return []
  return value.split(getDelimiter()).filter((s) => s.length > 0)
}

function joinPath(segments: string[]): string {
  return segments.join(getDelimiter())
}

function fastPathDirectories(): string[] {
  if (process.platform === 'darwin') {
    return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
  }
  if (process.platform === 'linux') {
    return ['/usr/local/bin', '/usr/local/sbin', path.join(os.homedir(), '.local/bin')]
  }
  return []
}

/**
 * Well-known Windows directories that hold globally-installed CLI shims
 * (`claude.cmd` / `codex.cmd` / `gemini.cmd`) which a GUI-launched (Explorer/
 * Tauri) process may not have on its inherited PATH. The per-user npm prefix
 * places `.cmd` shims DIRECTLY in the prefix root (`%APPDATA%\npm`), not a `bin`
 * subdir. `npm prefix -g` is the authoritative location for a custom prefix.
 */
function windowsGlobalBinDirs(): string[] {
  if (process.platform !== 'win32') return []
  const dirs: string[] = []
  const appData = process.env.APPDATA
  const localAppData = process.env.LOCALAPPDATA
  const userProfile = process.env.USERPROFILE
  // Default per-user npm prefix: shims (`claude.cmd` …) live in the prefix ROOT.
  if (appData) dirs.push(path.join(appData, 'npm'))
  // Machine-wide Node install (also where a machine-scope npm prefix points).
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'))
  // Provider CLIs are NOT always npm-global. Claude Code's native Windows
  // installer drops its shim under %LOCALAPPDATA%\Programs and adds
  // %USERPROFILE%\.local\bin to PATH; version managers (Volta) and scoop use
  // their own shim dirs. A GUI-launched process can inherit a PATH missing these
  // (so `where claude` / cross-spawn fail → "claude no se reconoce"). Add the
  // common locations; all are existence-gated + deduped by the callers.
  if (localAppData) {
    dirs.push(path.join(localAppData, 'Programs'))
    dirs.push(path.join(localAppData, 'Volta', 'bin'))
  }
  if (userProfile) {
    dirs.push(path.join(userProfile, '.local', 'bin'))
    dirs.push(path.join(userProfile, 'scoop', 'shims'))
  }
  // Windows system dirs. A GUI-launched / pkg-stripped sidecar can inherit a PATH
  // missing %SystemRoot%\System32 — which holds `taskkill`/`where`, and \Wbem
  // holds `wmic`. Without them, cmd.exe-mediated tools fail: `tree-kill`'s
  // `taskkill` silently no-ops (a cancelled rail keeps running). Existence-gated
  // by the callers; harmless when already present (the common case).
  const systemRoot = process.env.SystemRoot || process.env.windir
  if (systemRoot) {
    dirs.push(path.join(systemRoot, 'System32'))
    dirs.push(path.join(systemRoot, 'System32', 'Wbem'))
  }
  return dirs
}

/**
 * Returns the absolute path to the bundled runtimes directory.
 * Only valid when SPECRAILS_IS_DESKTOP=1 and SPECRAILS_BUNDLED_RUNTIMES_PATH is set.
 * Throws if the env var is missing.
 */
export function resolveBundledRuntimePath(): string {
  const raw = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (!raw) {
    throw new Error(
      '[path-resolver] resolveBundledRuntimePath() called but SPECRAILS_BUNDLED_RUNTIMES_PATH is not set'
    )
  }
  // Strip the `\\?\` verbatim prefix (Tauri resource_dir) — see ensureWindowsBaseEnv.
  return stripWindowsVerbatimPrefix(raw)
}

/**
 * Absolute path to the bundled REAL Node executable (`runtimes/node/bin/node` on
 * POSIX, `runtimes/node/node.exe` on Windows), or `null` when no bundled runtimes
 * are present (non-desktop mode, a runtimes-less build, or a partial extraction).
 *
 * This is the node that must run bundled node CLIs (e.g. the openspec ESM CLI).
 * It is deliberately NOT `process.execPath`: in the packaged app `process.execPath`
 * is the `specrails-server` pkg binary, which cannot run an external ESM CLI —
 * passing it as `SPECRAILS_OPENSPEC_NODE` made `openspec init` exit with code -1.
 * Existence-gated so a stale/partial bundle degrades to the PATH `node` instead.
 */
export function resolveBundledNodeExe(): string | null {
  // Strip the `\\?\` verbatim prefix so the resulting node.exe path doesn't
  // crash Node's module loader when it runs cli.js (EISDIR lstat 'C:').
  const runtimesPath = stripWindowsVerbatimPrefix(process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH ?? '')
  if (!runtimesPath || runtimesPath.length === 0) return null
  const exe = process.platform === 'win32'
    ? path.join(runtimesPath, 'node', 'node.exe')
    : path.join(runtimesPath, 'node', 'bin', 'node')
  return fileExists(exe) ? exe : null
}

/**
 * Synchronously prepend well-known package-manager bin directories to
 * `process.env.PATH` if they are missing. No-op on Windows.
 *
 * Records the resulting segments and their sources for diagnostic reporting.
 */
export function resolveStartupPath(): void {
  resolveStartupPathBase()
  appendBundledGhDir()
}

/**
 * Desktop mode: append the bundled gh bin dir to the END of `process.env.PATH`
 * so a system-installed gh (earlier in PATH) always wins and the bundled one is
 * pure fallback. Runs AFTER the base resolution regardless of which branch it
 * took (active bundle, partial bundle, non-desktop no-op). Later login-shell
 * augmentation only PREPENDS, so the appended dir stays last.
 */
function appendBundledGhDir(): void {
  if (process.env.SPECRAILS_IS_DESKTOP !== '1') return
  const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
  if (!runtimesPath) return
  const ghBinDir = resolveBundledGhBinDir(runtimesPath)
  if (!ghBinDir) return
  const current = splitPath(process.env.PATH)
  if (current.includes(ghBinDir)) return
  const merged = [...current, ghBinDir]
  process.env.PATH = joinPath(merged)
  diagnostic = {
    pathSegments: merged,
    pathSources: [...diagnostic.pathSources, 'bundled' as PathSource],
    loginShellStatus: diagnostic.loginShellStatus,
  }
}

function resolveStartupPathBase(): void {
  // Desktop mode: bundled runtimes win when present. We existence-gate every
  // candidate dir so a runtimes-less or partially-extracted build degrades to
  // normal system PATH discovery instead of prepending dead dirs and disabling
  // all fallback (which would dead-end Add Project with "corrupted-bundle").
  if (process.env.SPECRAILS_IS_DESKTOP === '1') {
    const runtimesPath = process.env.SPECRAILS_BUNDLED_RUNTIMES_PATH
    if (runtimesPath) {
      const { nodeBinDir, gitBinDir, uvBinDir } = resolveBundledBinDirs(runtimesPath)
      // Activate the bundle only when BOTH node and git are present. A partial
      // bundle (one tool present, the other missing — a botched extraction) is
      // treated as NOT active so the full system fallback (fast-path + login-shell)
      // runs for every tool. Otherwise the missing tool would fall through to a
      // system probe against an un-augmented PATH and be wrongly reported missing.
      if (nodeBinDir && gitBinDir) {
        const inherited = splitPath(process.env.PATH)
        const inheritedSet = new Set(inherited)
        const bundledDirs = [nodeBinDir, gitBinDir, uvBinDir].filter((d): d is string => !!d && !inheritedSet.has(d))
        bundledDirs.forEach((d) => inheritedSet.add(d))
        // Provider CLIs (claude/codex/gemini/kimi) are NEVER bundled — they always
        // come from the system. On Windows their `.cmd` shims live in
        // `%APPDATA%\npm`, which a GUI-launched (Explorer/Tauri) process may not
        // have on PATH. This branch returns early, skipping the win32 fallback
        // block below that would otherwise add them — so prepend them here too,
        // AFTER the bundled node/git (which must still win for node/git).
        // No-op on macOS/Linux (windowsGlobalBinDirs() returns []), keeping
        // POSIX desktop PATH byte-identical.
        const winGlobal = windowsGlobalBinDirs().filter((d) => d && fileExists(d) && !inheritedSet.has(d))
        winGlobal.forEach((d) => inheritedSet.add(d))
        const merged = [...bundledDirs, ...winGlobal, ...inherited]
        process.env.PATH = joinPath(merged)
        bundledRuntimesActive = true
        diagnostic = {
          pathSegments: merged,
          pathSources: [
            ...bundledDirs.map(() => 'bundled' as PathSource),
            ...winGlobal.map(() => 'fast-path' as PathSource),
            ...inherited.map(() => 'inherited' as PathSource),
          ],
          loginShellStatus: 'skipped',
        }
        return
      }
      // Bundle absent or incomplete → fall through to system PATH discovery below
      // so system node/git still resolve (graceful fallback).
    }
    // No runtimes path, or no/partial bundle present: fall through (do NOT return).
  }

  const inherited = splitPath(process.env.PATH)
  const inheritedSet = new Set(inherited)

  if (process.platform === 'win32') {
    // Prepend well-known global-CLI dirs (npm prefix, Program Files\nodejs) that
    // a GUI-launched process may lack, so provider shims (claude/codex/gemini/kimi
    // .cmd) — and any RECURSIVE bare-name invocation by a spawned CLI — resolve.
    // Existence-gated + deduped; no-op when already present (the common case).
    const winPrepend: string[] = []
    for (const dir of windowsGlobalBinDirs()) {
      if (dir && fileExists(dir) && !inheritedSet.has(dir)) {
        winPrepend.push(dir)
        inheritedSet.add(dir)
      }
    }
    const winMerged = [...winPrepend, ...inherited]
    if (winPrepend.length > 0) process.env.PATH = joinPath(winMerged)
    diagnostic = {
      pathSegments: winMerged,
      pathSources: [
        ...winPrepend.map(() => 'fast-path' as PathSource),
        ...inherited.map(() => 'inherited' as PathSource),
      ],
      loginShellStatus: 'skipped',
    }
    return
  }

  const toPrepend: string[] = []
  for (const dir of fastPathDirectories()) {
    if (!inheritedSet.has(dir)) {
      toPrepend.push(dir)
      inheritedSet.add(dir)
    }
  }

  const merged = [...toPrepend, ...inherited]
  process.env.PATH = joinPath(merged)

  diagnostic = {
    pathSegments: merged,
    pathSources: [
      ...toPrepend.map(() => 'fast-path' as PathSource),
      ...inherited.map(() => 'inherited' as PathSource),
    ],
    loginShellStatus: 'skipped',
  }
}

/**
 * Parse stdout from the login-shell probe. Returns the PATH between sentinel
 * markers, or `null` if the markers are not present.
 */
export function parseLoginShellOutput(stdout: string): string | null {
  const begin = stdout.indexOf(PATH_BEGIN)
  if (begin === -1) return null
  const start = begin + PATH_BEGIN.length
  const end = stdout.indexOf(PATH_END, start)
  if (end === -1) return null
  return stdout.slice(start, end)
}

type SpawnFn = typeof spawn

interface AugmentOptions {
  spawnFn?: SpawnFn
  timeoutMs?: number
}

/** GUI launches may omit SHELL even when the account uses zsh/bash. */
function resolveLoginShell(env: NodeJS.ProcessEnv = process.env): string {
  if (env.SHELL) return env.SHELL
  try {
    return os.userInfo().shell || '/bin/sh'
  } catch {
    return '/bin/sh'
  }
}

/**
 * Spawn the user's login shell once and merge any additional PATH segments
 * it exposes (Volta/nvm/fnm/asdf shims) into `process.env.PATH`. Async,
 * fire-and-forget — must not block startup.
 *
 * No-op on Windows and in test environments.
 */
export async function augmentPathFromLoginShell(opts: AugmentOptions = {}): Promise<void> {
  if (process.platform === 'win32') {
    diagnostic.loginShellStatus = 'skipped'
    return
  }
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') {
    diagnostic.loginShellStatus = 'skipped'
    return
  }

  // Desktop mode WITH an active bundle: login-shell augmentation must never run
  // — it could prepend system node/git dirs ahead of bundled ones. But when the
  // bundle is absent (runtimes-less build → system fallback), we DO want
  // login-shell augmentation so nvm/volta/fnm shims are discovered.
  if (process.env.SPECRAILS_IS_DESKTOP === '1' && bundledRuntimesActive) {
    diagnostic.loginShellStatus = 'skipped'
    return
  }

  const spawnFn = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS
  const shell = resolveLoginShell()
  const command = `printf "${PATH_BEGIN}%s${PATH_END}" "$PATH"`

  const status = await new Promise<LoginShellStatus>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(shell, ['-l', '-i', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve('error')
      return
    }

    let stdout = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr?.on('data', () => { /* discard */ })

    const finish = (s: LoginShellStatus) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(s)
    }

    child.on('error', () => finish('error'))
    child.on('close', (code) => {
      if (timedOut) {
        finish('timeout')
        return
      }
      if (code !== 0) {
        finish('error')
        return
      }
      const parsed = parseLoginShellOutput(stdout)
      if (parsed === null) {
        finish('error')
        return
      }
      mergeLoginShellPath(parsed)
      finish('ok')
    })
  })

  diagnostic.loginShellStatus = status

  if (status !== 'ok' && !warnedLoginShell) {
    warnedLoginShell = true
    console.warn(`[path-resolver] login-shell merge ${status}; using fast-path PATH only`)
  }
}

const ENV_BEGIN = '__SRH_ENV_BEGIN__'
const ENV_END = '__SRH_ENV_END__'

/**
 * Provider auth env vars to recover from the user's login shell. A GUI-launched
 * (Finder/Dock) desktop server inherits launchd's minimal env, NOT the user's
 * `.zshrc`/`.bashrc` exports — so a `GEMINI_API_KEY` (or Vertex config) the user
 * set in their dotfiles never reaches the gemini spawn. Without it, gemini-cli
 * falls back to its OAuth path, which on macOS re-reads the cached token through
 * the Keychain on EVERY spawn → the repeated "allow access to your keychain"
 * prompts. Recovering the key here makes gemini use API-key auth and skip the
 * Keychain entirely. Values are NEVER logged.
 */
export const AUTH_ENV_VARS = [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_APPLICATION_CREDENTIALS',
] as const

const LOGIN_SHELL_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function normalizeLoginShellEnvNames(names: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of names) {
    const name = String(raw).trim()
    if (!LOGIN_SHELL_ENV_NAME_RE.test(name) || out.includes(name)) continue
    out.push(name)
  }
  return out
}

function buildLoginShellEnvCommand(names: readonly string[]): string {
  // `printf` reuses POSIX positional `$VAR` expansion (works in sh/bash/zsh).
  const fmt = ENV_BEGIN + names.map((v) => `${v}=%s\n`).join('') + ENV_END
  const refs = names.map((v) => `"$${v}"`).join(' ')
  return `printf '${fmt}' ${refs}`
}

/** Parse the `KEY=value` block emitted between the env sentinels. */
export function parseLoginShellEnv(stdout: string): Record<string, string> {
  const begin = stdout.indexOf(ENV_BEGIN)
  if (begin === -1) return {}
  const start = begin + ENV_BEGIN.length
  const end = stdout.indexOf(ENV_END, start)
  if (end === -1) return {}
  const block = stdout.slice(start, end)
  const out: Record<string, string> = {}
  for (const line of block.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (value.length > 0) out[key] = value
  }
  return out
}

/** Backfill arbitrary, pre-validated environment variable names from the user's
 * login shell into `process.env` (only when not already set — never override an
 * explicit value). POSIX-only and runs regardless of bundle state, so macOS GUI
 * launches can recover tokens exported in `.zshrc`/`.bashrc` without hardcoding
 * every possible package-manager/provider variable. No-op on Windows and tests. */
export async function augmentEnvFromLoginShell(
  names: readonly string[],
  opts: AugmentOptions = {},
): Promise<void> {
  if (process.platform === 'win32') return
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return

  const wanted = normalizeLoginShellEnvNames(names).filter((name) => !process.env[name])
  if (wanted.length === 0) return

  const spawnFn = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS
  const shell = resolveLoginShell()
  const command = buildLoginShellEnvCommand(wanted)

  await new Promise<void>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(shell, ['-l', '-i', '-c', command], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve()
      return
    }

    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
    }, timeoutMs)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve()
    }

    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8') })
    child.stderr?.on('data', () => { /* discard */ })
    child.on('error', finish)
    child.on('close', () => {
      const recovered = parseLoginShellEnv(stdout)
      for (const key of wanted) {
        const val = recovered[key]
        // Backfill only when unset/empty — never clobber an explicit value.
        if (val && !process.env[key]) process.env[key] = val
      }
      finish()
    })
  })
}

/** Default budget for the asynchronous project-env probe. Real interactive
 * profiles (oh-my-zsh, nvm, powerlevel10k, conda) routinely exceed 1.5 s. */
export const LOGIN_SHELL_PROBE_TIMEOUT_MS = 10_000
const LOGIN_SHELL_PROBE_MAX_TIMEOUT_MS = 120_000
const LOGIN_SHELL_OUTPUT_CAP = 1024 * 1024

/** `SPECRAILS_LOGIN_SHELL_TIMEOUT_MS` overrides the asynchronous probe budget.
 * Invalid or non-positive values fall back to the 10 s default; values are
 * capped at 2 minutes so a typo cannot park a probe forever. */
export function resolveLoginShellProbeTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SPECRAILS_LOGIN_SHELL_TIMEOUT_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return LOGIN_SHELL_PROBE_TIMEOUT_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0) return LOGIN_SHELL_PROBE_TIMEOUT_MS
  return Math.min(value, LOGIN_SHELL_PROBE_MAX_TIMEOUT_MS)
}

/** Outcome of one login-shell env probe. `ok` means the sentinel block was
 * complete (whatever the exit status); `skipped` means no probe was needed or
 * allowed (Windows, tests, nothing missing). Never contains anything but the
 * requested names' values, which callers must keep out of logs and payloads. */
export type LoginShellEnvProbeStatus = 'ok' | 'timeout' | 'failed' | 'skipped'

export interface LoginShellEnvProbe {
  /** Recovered non-empty values for the probed names only. */
  values: Record<string, string>
  status: LoginShellEnvProbeStatus
  /** Shell exit code; a diagnostic only (null when killed or not spawned). */
  exitCode: number | null
  /** Shell executable used, or null when no probe ran. */
  shell: string | null
  /** Normalized names the probe actually asked for (missing from the env). */
  names: string[]
}

/** True when the probe output contains the complete env sentinel block. The
 * block is the proof that the printf ran, independent of the shell's status. */
export function hasCompleteLoginShellEnvBlock(stdout: string): boolean {
  const begin = stdout.indexOf(ENV_BEGIN)
  return begin !== -1 && stdout.indexOf(ENV_END, begin + ENV_BEGIN.length) !== -1
}

function loginShellProbeSkipped(names: string[] = []): LoginShellEnvProbe {
  return { values: {}, status: 'skipped', exitCode: null, shell: null, names }
}

function pickRecovered(stdout: string, wanted: readonly string[]): Record<string, string> {
  const recovered = parseLoginShellEnv(stdout)
  const out: Record<string, string> = {}
  for (const key of wanted) {
    const val = recovered[key]
    if (val) out[key] = val
  }
  return out
}

function settleLoginShellProbe(stdout: string, wanted: string[], shell: string, exitCode: number | null, timedOut: boolean): LoginShellEnvProbe {
  if (hasCompleteLoginShellEnvBlock(stdout)) {
    return { values: pickRecovered(stdout, wanted), status: 'ok', exitCode, shell, names: wanted }
  }
  return { values: {}, status: timedOut ? 'timeout' : 'failed', exitCode, shell, names: wanted }
}

function wantedLoginShellNames(names: readonly string[], env: NodeJS.ProcessEnv): string[] | null {
  if (process.platform === 'win32') return null
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return null
  return normalizeLoginShellEnvNames(names).filter((name) => !env[name])
}

/** Asynchronously read missing configured names from the login shell without
 * blocking the event loop or mutating any environment. Values from a complete
 * sentinel block are accepted regardless of the shell's exit status. Output is
 * capped at 1 MiB; the child is killed at the timeout. Callers own any cache. */
export function readEnvFromLoginShell(
  names: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnFn?: SpawnFn } = {},
): Promise<LoginShellEnvProbe> {
  const env = opts.env ?? process.env
  const wanted = wantedLoginShellNames(names, env)
  if (wanted === null) return Promise.resolve(loginShellProbeSkipped())
  if (wanted.length === 0) return Promise.resolve(loginShellProbeSkipped(wanted))

  const spawnFn = opts.spawnFn ?? spawn
  const timeoutMs = opts.timeoutMs ?? resolveLoginShellProbeTimeoutMs(env)
  const shell = resolveLoginShell(env)
  const command = buildLoginShellEnvCommand(wanted)

  return new Promise<LoginShellEnvProbe>((resolve) => {
    let child: ChildProcess
    try {
      child = spawnFn(shell, ['-l', '-i', '-c', command], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve({ values: {}, status: 'failed', exitCode: null, shell, names: wanted })
      return
    }

    let stdout = ''
    let timedOut = false
    let settled = false
    const kill = () => { try { child.kill('SIGKILL') } catch { /* ignore */ } }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
      // Settle now: a background job started by the profile can keep the pipes
      // (and so 'close') open long after the shell itself was killed. A complete
      // block printed before a hung exit hook is still a success.
      finish(null)
    }, timeoutMs)
    const finish = (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(settleLoginShellProbe(stdout, wanted, shell, exitCode, timedOut))
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length >= LOGIN_SHELL_OUTPUT_CAP) return
      stdout += chunk.toString('utf-8')
      if (stdout.length >= LOGIN_SHELL_OUTPUT_CAP) {
        stdout = stdout.slice(0, LOGIN_SHELL_OUTPUT_CAP)
        if (!hasCompleteLoginShellEnvBlock(stdout)) kill()
      }
    })
    child.stderr?.on('data', () => { /* discard: profiles print noise; values never go to stderr */ })
    child.on('error', () => finish(null))
    child.on('close', (code: number | null) => finish(typeof code === 'number' ? code : null))
  })
}

function isSpawnSyncTimeout(res: SpawnSyncReturns<string | Buffer>): boolean {
  const error = res.error as NodeJS.ErrnoException | undefined
  return Boolean(error && (error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(error.message)))
}

/** Synchronous, detailed variant used only as the cold fallback at spawn time.
 * Keeps the short 1.5 s budget so a cold spawn never freezes the server for
 * long, and accepts a complete sentinel block regardless of exit status. */
export function readEnvFromLoginShellSyncDetailed(
  names: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnSyncFn?: typeof spawnSync } = {},
): LoginShellEnvProbe {
  const env = opts.env ?? process.env
  const wanted = wantedLoginShellNames(names, env)
  if (wanted === null) return loginShellProbeSkipped()
  if (wanted.length === 0) return loginShellProbeSkipped(wanted)

  const spawnSyncFn = opts.spawnSyncFn ?? spawnSync
  const timeoutMs = opts.timeoutMs ?? LOGIN_SHELL_TIMEOUT_MS
  const shell = resolveLoginShell(env)
  const command = buildLoginShellEnvCommand(wanted)
  let res: SpawnSyncReturns<string | Buffer>
  try {
    res = spawnSyncFn(shell, ['-l', '-i', '-c', command], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      // An interactive shell can ignore SIGTERM; the cold fallback must stay bounded.
      killSignal: 'SIGKILL',
      maxBuffer: LOGIN_SHELL_OUTPUT_CAP,
    })
  } catch {
    return { values: {}, status: 'failed', exitCode: null, shell, names: wanted }
  }
  const stdout = typeof res.stdout === 'string' ? res.stdout : res.stdout?.toString('utf8') ?? ''
  return settleLoginShellProbe(stdout, wanted, shell, typeof res.status === 'number' ? res.status : null, isSpawnSyncTimeout(res))
}

/** Read missing configured names without mutating the caller's or global env.
 * Callers own any cache so project credentials cannot leak across scopes. */
export function readEnvFromLoginShellSync(
  names: readonly string[],
  opts: { env?: NodeJS.ProcessEnv; timeoutMs?: number; spawnSyncFn?: typeof spawnSync } = {},
): NodeJS.ProcessEnv {
  return readEnvFromLoginShellSyncDetailed(names, opts).values
}

/** Compatibility backfill for callers that intentionally augment process.env.
 * Failed probes remain retryable; successful names are already present. */
export function augmentEnvFromLoginShellSync(
  names: readonly string[],
  opts: { timeoutMs?: number; spawnSyncFn?: typeof spawnSync } = {},
): void {
  const recovered = readEnvFromLoginShellSync(names, opts)
  for (const [key, value] of Object.entries(recovered)) {
    if (value && !process.env[key]) process.env[key] = value
  }
}

/** Startup backfill for the built-in provider auth variables. */
export async function augmentAuthEnvFromLoginShell(opts: AugmentOptions = {}): Promise<void> {
  await augmentEnvFromLoginShell(AUTH_ENV_VARS, opts)
}

function mergeLoginShellPath(rawPath: string): void {
  const current = splitPath(process.env.PATH)
  const currentSet = new Set(current)
  const incoming = splitPath(rawPath)

  const additions: string[] = []
  for (const dir of incoming) {
    if (!currentSet.has(dir)) {
      additions.push(dir)
      currentSet.add(dir)
    }
  }
  if (additions.length === 0) return

  const merged = [...additions, ...current]
  process.env.PATH = joinPath(merged)

  diagnostic = {
    pathSegments: merged,
    pathSources: [
      ...additions.map(() => 'login-shell' as PathSource),
      ...diagnostic.pathSources,
    ],
    loginShellStatus: diagnostic.loginShellStatus,
  }
}

export function getPathDiagnostic(): PathDiagnostic {
  return {
    pathSegments: [...diagnostic.pathSegments],
    pathSources: [...diagnostic.pathSources],
    loginShellStatus: diagnostic.loginShellStatus,
  }
}

/** Test-only helper to reset module state. */
export function __resetPathResolverForTest(): void {
  diagnostic = { pathSegments: [], pathSources: [], loginShellStatus: 'skipped' }
  warnedLoginShell = false
  bundledRuntimesActive = false
}
