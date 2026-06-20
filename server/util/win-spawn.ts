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

import { spawn } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'
import crossSpawn from 'cross-spawn'

export function spawnCli(
  binary: string,
  args: string[],
  options: SpawnOptions = {},
): ChildProcess {
  /* c8 ignore next 5 -- Windows-only branch; coverage runs on Linux/macOS */
  if (process.platform === 'win32') {
    // Guarantee SystemRoot/ComSpec so cmd.exe (which cross-spawn uses to run
    // `.cmd` shims like claude.cmd/npm.cmd) can start even when the packaged
    // sidecar inherited a stripped environment. Chokepoint for EVERY Windows
    // spawn — protects rails, chat, setup and probes uniformly.
    return crossSpawn(binary, args, { ...options, env: windowsSpawnEnv(options.env) })
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

// Back-compat for callsites that only need the resolved binary
// (e.g. logging). Kept as a no-op identity on POSIX; on Windows
// `where`-based resolution lives inside cross-spawn now.
export function resolveWindowsBinary(name: string): string {
  return name
}
