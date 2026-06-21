// Cross-platform spawn wrapper.
//
// Two Windows-specific problems forced this helper:
//
// 1) `claude` (and similar npm-installed binaries) is shipped as a
//    `.cmd` shim. `spawn('claude', ..., { shell: false })` fails
//    with ENOENT because Node looks for an exact `claude` file
//    without extension expansion.
//
// 2) Setting `shell: true` makes Windows resolve the shim, but
//    cmd.exe then re-parses the concatenated command line and
//    truncates any arg containing `\n` (e.g. claude's
//    `--system-prompt "You are a...\n..."`).
//
// Since Node 20.12 / CVE-2024-27980 the obvious middle ground —
// `spawn('claude.cmd', ..., { shell: false })` — also fails, this
// time with EINVAL: Node refuses to spawn .cmd/.bat without a
// shell. `cross-spawn` is the de-facto fix: on Windows it
// internally launches `cmd.exe /d /s /c` with quoted-then-escaped
// args so newlines and shell metacharacters survive intact, and on
// POSIX it falls through to the native `child_process.spawn`.

import { spawn, execFileSync, execFile } from 'child_process'
import path from 'path'
import type { ChildProcess, SpawnOptions } from 'child_process'
import crossSpawn from 'cross-spawn'
import treeKill from 'tree-kill'

/**
 * Kill a process tree, robustly on Windows. `tree-kill` shells out to
 * `exec('taskkill /pid … /T /F')` through cmd.exe, which resolves `taskkill`
 * against the spawn env's PATH — but `taskkill.exe` lives in
 * `%SystemRoot%\System32`, which a GUI-launched / pkg-stripped sidecar's PATH can
 * lack, so the kill silently no-ops (the rail keeps running) and, with no
 * callback, the failure is swallowed. Here we instead invoke the ABSOLUTE
 * `taskkill.exe` with a SystemRoot-backfilled env (`windowsSpawnEnv`), so the
 * kill never depends on PATH. POSIX delegates to `tree-kill` unchanged
 * (byte-identical). Errors are always surfaced via `callback`.
 */
export function treeKillSafe(pid: number, signal: string | undefined, callback?: (err?: Error) => void): void {
  const done = (err?: Error) => { if (callback) callback(err) }
  if (process.platform !== 'win32') {
    treeKill(pid, signal, (err) => done(err ?? undefined))
    return
  }
  /* c8 ignore start -- Windows-only branch; coverage runs on Linux/macOS */
  try {
    const env = windowsSpawnEnv()
    const systemRoot = (env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
    const taskkill = path.join(systemRoot, 'System32', 'taskkill.exe')
    // /T = whole tree, /F = force. taskkill has no SIGTERM/SIGKILL distinction;
    // `tree-kill` already always force-kills on win32, so behaviour is unchanged.
    execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { env }, (err) => done(err ?? undefined))
  } catch (err) {
    done(err as Error)
  }
  /* c8 ignore stop */
}

export function spawnCli(
  binary: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  /* c8 ignore next 8 -- Windows-only branch; coverage runs on Linux/macOS */
  if (process.platform === 'win32') {
    // Resolve the bare CLI name (`claude`/`codex`/`gemini`/`npx`…) to its
    // ABSOLUTE shim path first. cross-spawn's internal `which.sync` can fail to
    // locate the `.cmd` even when the cmd.exe `where` builtin finds it (PATH
    // format / reparse-point / resolver divergence); on a miss it silently
    // degrades to `cmd.exe /c "claude …"`, and cmd.exe then re-resolves the bare
    // name and prints `"claude" no se reconoce…` → the job dies with code 1.
    // Spawning the resolved absolute path bypasses that bare-name lookup. Plus
    // the SystemRoot/ComSpec backfill so cmd.exe can start under a stripped env.
    return crossSpawn(resolveWindowsBinary(binary), args, { ...options, env: windowsSpawnEnv(options.env) })
  }

  return spawn(binary, args, options)
}

/**
 * Return an environment safe for spawning children on Windows. The desktop
 * server runs as a pkg-packaged sidecar launched by the Tauri host, and that
 * spawn can deliver a STRIPPED environment missing `SystemRoot` / `windir` /
 * `ComSpec`. Without `SystemRoot`, `cmd.exe` (used to run `.cmd` shims like
 * `npm.cmd`/`npx.cmd`, and by cross-spawn) fails to initialise — which silently
 * broke every bundled-tool `--version` probe and any npx/npm spawn during setup.
 * Reconstructs the canonical values when absent. No-op (returns `base`
 * unchanged) on POSIX. Pass a base env to layer extra vars on top.
 */
export function windowsSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return base
  const env = { ...base }
  const systemRoot = (env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
  env.SystemRoot = env.SystemRoot || systemRoot
  env.windir = env.windir || systemRoot
  env.ComSpec = env.ComSpec || `${systemRoot}\\System32\\cmd.exe`

  // npm/npx load @npmcli/config on startup (even `npm --version` and the inner
  // npm-prefix.js resolver), which reads the user profile via USERPROFILE /
  // APPDATA / HOMEDRIVE+HOMEPATH / TEMP. A GUI-launched, env-stripped sidecar can
  // lack these → `node npm-cli.js --version` fails the same way the .cmd shim did.
  // Backfill canonical Windows defaults when absent (node.exe itself needs none
  // of these, which is why node/git probed fine while npm/npx did not).
  const userProfile =
    env.USERPROFILE ||
    (env.HOMEDRIVE && env.HOMEPATH ? `${env.HOMEDRIVE}${env.HOMEPATH}` : 'C:\\Users\\Default')
  env.USERPROFILE = userProfile
  const drive = /^([A-Za-z]:)(.*)$/.exec(userProfile)
  if (drive) {
    env.HOMEDRIVE = env.HOMEDRIVE || drive[1]
    env.HOMEPATH = env.HOMEPATH || (drive[2] || '\\')
  }
  env.APPDATA = env.APPDATA || `${userProfile}\\AppData\\Roaming`
  env.LOCALAPPDATA = env.LOCALAPPDATA || `${userProfile}\\AppData\\Local`
  const temp = env.TEMP || env.TMP || `${env.LOCALAPPDATA}\\Temp`
  env.TEMP = env.TEMP || temp
  env.TMP = env.TMP || temp
  return env
}

/**
 * Strip the Windows extended-length / "verbatim" path prefix (`\\?\`) from a
 * path. Tauri's `resource_dir()` returns canonicalized paths like
 * `\\?\C:\Users\…\core`, and Node's MODULE LOADER `realpathSync` (used to
 * resolve the main entry script) does NOT handle the `\\?\` prefix — it parses
 * the root as a bare `C:` and throws `EISDIR: lstat 'C:'`. So a bundled `node`
 * interpreter or `cli.js` entry carrying this prefix crashes the child at
 * startup. Normalizing the bundled path env vars to plain `C:\…` form fixes it.
 * `\\?\UNC\server\share` → `\\server\share`. No-op on POSIX / unprefixed paths.
 */
export function stripWindowsVerbatimPrefix(p: string): string {
  if (typeof p !== 'string' || p.length === 0) return p
  if (p.startsWith('\\\\?\\UNC\\')) return '\\\\' + p.slice(8)
  if (p.startsWith('\\\\?\\')) return p.slice(4)
  return p
}

// Resolution cache: a binary's absolute shim path changes rarely, and `where`
// is a synchronous subprocess. Memoize per-name with a short TTL (mirrors
// binary-probe). A freshly (re)installed CLI is picked up after at most the TTL.
const RESOLVE_TTL_MS = 30_000
const _resolveCache = new Map<string, { at: number; resolved: string }>()

/** Prefer a cmd.exe-runnable shim: `.cmd`/`.bat` and `.exe` over `.ps1`
 *  (PowerShell scripts cannot be run by `cmd.exe /c` directly). */
function rankWindowsExecExt(p: string): number {
  const lower = p.toLowerCase()
  if (lower.endsWith('.cmd') || lower.endsWith('.bat')) return 0
  if (lower.endsWith('.exe') || lower.endsWith('.com')) return 1
  if (lower.endsWith('.ps1')) return 3
  return 2
}

/**
 * Resolve a bare command name to its absolute path on Windows via the `where`
 * builtin (PATHEXT-aware, the same resolver the pre-spawn `binaryOnPath` gate
 * uses — so when that gate passed, this succeeds too). Returns the bare name
 * unchanged on POSIX (byte-identical), when `name` is already a path, or on any
 * failure (graceful fallback to the prior cross-spawn behaviour). Cached.
 */
export function resolveWindowsBinary(name: string): string {
  if (process.platform !== 'win32') return name
  // Already a path (absolute or with a separator) → nothing to resolve. Use
  // win32 path semantics: `where` output and Windows paths use `C:\…`, which the
  // host's default `path` module would misjudge when these run under tests.
  if (path.win32.isAbsolute(name) || name.includes('\\') || name.includes('/')) return name
  const now = Date.now()
  const hit = _resolveCache.get(name)
  if (hit && now - hit.at < RESOLVE_TTL_MS) return hit.resolved
  let resolved = name
  try {
    const out = execFileSync('where', [name], {
      env: windowsSpawnEnv(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    const candidates = out
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && path.win32.isAbsolute(s))
    if (candidates.length > 0) {
      candidates.sort((a, b) => rankWindowsExecExt(a) - rankWindowsExecExt(b))
      resolved = candidates[0]
    }
  } catch {
    /* `where` missing/failed → keep the bare name; cross-spawn/cmd.exe will try. */
  }
  _resolveCache.set(name, { at: now, resolved })
  return resolved
}

/** Test-only: clear the resolution memo so each test re-resolves. */
export function __resetWindowsBinaryResolveCacheForTest(): void {
  _resolveCache.clear()
}
