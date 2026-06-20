// Windows-safe spawn for the CLI bridge. Mirrors server/util/win-spawn.ts but is
// self-contained because the CLI compiles with its own tsconfig (rootDir: cli).
//
// Two Windows problems this solves:
//  1. `claude`/`tsx` etc. ship as `.cmd` shims. `spawn('claude', …, { shell:false })`
//     fails with ENOENT (no extension expansion) and, since Node 20.12 /
//     CVE-2024-27980, `spawn('claude.cmd', …, { shell:false })` fails with EINVAL.
//     cross-spawn launches cmd.exe with quoted args so `.cmd` resolves and
//     multi-line `--system-prompt`/`-p` values survive intact.
//  2. A GUI-launched packaged app can inherit a stripped env missing SystemRoot/
//     ComSpec, which cmd.exe needs to start — windowsSpawnEnv backfills them.

import { spawn } from 'child_process'
import type { ChildProcess, SpawnOptions } from 'child_process'
import crossSpawn from 'cross-spawn'

/** Reconstruct the Windows shell-critical env when a stripped sidecar lacks it. */
export function windowsSpawnEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (process.platform !== 'win32') return base
  const env = { ...base }
  const systemRoot = (env.SystemRoot || env.windir || 'C:\\Windows').replace(/[\\/]$/, '')
  env.SystemRoot = env.SystemRoot || systemRoot
  env.windir = env.windir || systemRoot
  env.ComSpec = env.ComSpec || `${systemRoot}\\System32\\cmd.exe`
  return env
}

/** Spawn `binary` Windows-safely: cross-spawn on win32 (resolves `.cmd`, quotes
 *  args), plain spawn on POSIX. Backfills the Windows base env unless the caller
 *  already supplied one. */
export function spawnCli(binary: string, args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform === 'win32') {
    return crossSpawn(binary, args, { ...options, env: windowsSpawnEnv(options.env) })
  }
  return spawn(binary, args, options)
}
