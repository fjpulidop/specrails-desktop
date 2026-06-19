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
  const systemRoot = env.SystemRoot || env.windir || 'C:\\Windows'
  env.SystemRoot = systemRoot
  env.windir = env.windir || systemRoot
  env.ComSpec = env.ComSpec || `${systemRoot.replace(/[\\/]$/, '')}\\System32\\cmd.exe`
  return env
}

// Back-compat for callsites that only need the resolved binary
// (e.g. logging). Kept as a no-op identity on POSIX; on Windows
// `where`-based resolution lives inside cross-spawn now.
export function resolveWindowsBinary(name: string): string {
  return name
}
