import fs from 'node:fs'
import path from 'node:path'
import { resolveBundledNodeExe } from './path-resolver'

/** The first `node` executable on PATH, as an absolute path; null when none. */
export function findNodeOnPath(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | null {
  const key = platform === 'win32' ? Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'Path' : 'PATH'
  const names = platform === 'win32' ? ['node.exe'] : ['node']
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of (env[key] ?? '').split(separator)) {
    if (!dir) continue
    for (const name of names) {
      const file = path.join(dir, name)
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file } catch { /* not here */ }
    }
  }
  return null
}

/** External Core CLIs need ordinary Node. A pkg sidecar's process.execPath is
 * the server executable: using it would recursively launch another server.
 * A bare `node` is not enough either: pkg rewrites a spawn of `node` to its own
 * executable, so Core would run inside the server binary and hand that binary
 * (its process.execPath) to providers as the command of its MCP bridge, which
 * then starts a server instead of the bridge. Under pkg, resolve the absolute
 * path of the real Node on PATH. */
export function resolveCoreNodeRuntime(env: NodeJS.ProcessEnv = process.env): string {
  const bundled = resolveBundledNodeExe()
  if (bundled) return bundled
  if (!(process as NodeJS.Process & { pkg?: unknown }).pkg) return process.execPath
  return findNodeOnPath(env) ?? 'node'
}
