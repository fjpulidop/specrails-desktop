import fs from 'fs'
import path from 'path'

/**
 * The Node an external client's `specrails` entry runs the bridge with.
 *
 * The packaged app registers its bundled runtime. A source checkout used to
 * register this server's own `process.execPath`, which on Homebrew is a
 * versioned Cellar path (`/opt/homebrew/Cellar/node/25.2.1/bin/node`) that
 * disappears on the next `brew upgrade`, and the client then fails to start the
 * server with no hint why. Version managers (nvm, fnm, volta, asdf, n) have the
 * same problem. This picks, in order:
 *
 *   1. the bundled runtime;
 *   2. the execPath itself when it is not versioned;
 *   3. a stable link that resolves to the same Node: `node` on PATH, then the
 *      Homebrew `opt/<formula>` link, then the Homebrew/system `bin/node`;
 *   4. the versioned execPath, with a warning.
 */

export type NodeSource = 'bundled' | 'exec_path' | 'stable_link' | 'versioned'

export interface StableNode {
  command: string
  source: NodeSource
  /** Set when the command will break on a Node upgrade. */
  warning?: string
}

export interface NodePathDeps {
  execPath: string
  bundled: string | null
  env: Readonly<Record<string, string | undefined>>
  platform: NodeJS.Platform
  /** True when this server runs as a pkg-built binary (its execPath is not a Node that runs scripts). */
  packagedServer?: boolean
  /** The first `node` on PATH, used when `packagedServer` has no bundled runtime. */
  nodeOnPath?: string | null
  /** Resolved real path, or null when the file does not exist. */
  realpath?: (file: string) => string | null
  /** True for an existing executable file. */
  isExecutable?: (file: string) => boolean
}

const VERSIONED: readonly RegExp[] = [
  /[\\/]Cellar[\\/][^\\/]+[\\/][^\\/]+[\\/]/i, // Homebrew: Cellar/<formula>/<version>/
  /[\\/]\.nvm[\\/]versions[\\/]node[\\/]v?\d/i, // nvm
  /[\\/]fnm[\\/]node-versions[\\/]v?\d/i, // fnm
  /[\\/]fnm_multishells[\\/]/i, // fnm per-shell links
  /[\\/]\.volta[\\/]tools[\\/]image[\\/]node[\\/]\d/i, // volta images (its shim lives in ~/.volta/bin)
  /[\\/]\.asdf[\\/]installs[\\/]nodejs[\\/]\d/i, // asdf
  /[\\/]mise[\\/]installs[\\/]node[\\/]\d/i, // mise
  /[\\/]n[\\/]versions[\\/]node[\\/]\d/i, // n
  /[\\/]nodenv[\\/]versions[\\/]\d/i, // nodenv
  /[\\/]nvm[\\/]v\d+\.\d+/i, // nvm-windows (%APPDATA%/nvm/v22.1.0)
]

/** True when `file` names one installed Node version that an upgrade or `nvm uninstall` removes. */
export function isVersionedNodePath(file: string): boolean {
  return VERSIONED.some((pattern) => pattern.test(file))
}

function defaultRealpath(file: string): string | null {
  try { return fs.realpathSync(file) } catch { return null }
}

function defaultIsExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file)
    return stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)
  } catch { return false }
}

/** Homebrew's version-independent links for a Cellar path: `<prefix>/opt/<formula>/bin/node`, then `<prefix>/bin/node`. */
function homebrewLinks(execPath: string): string[] {
  const match = /^(.*)[\\/]Cellar[\\/]([^\\/]+)[\\/][^\\/]+[\\/]bin[\\/]node$/.exec(execPath)
  if (!match) return []
  const [, prefix, formula] = match
  return [path.join(prefix!, 'opt', formula!, 'bin', 'node'), path.join(prefix!, 'bin', 'node')]
}

export function stableNodeCommand(deps: NodePathDeps): StableNode {
  if (deps.bundled) return { command: deps.bundled, source: 'bundled' }
  // A pkg-built server's execPath is the server binary itself: given the bridge script it ignores it
  // and starts a second Specrails server, so the client sees the connection close. Use a real Node.
  if (deps.packagedServer) {
    if (!deps.nodeOnPath) {
      return {
        command: deps.execPath,
        source: 'versioned',
        warning: 'No Node.js was found on PATH, and this Specrails server binary cannot run the MCP bridge itself. Install Node.js (or put `node` on PATH), then connect again.',
      }
    }
    return stableNodeCommand({ ...deps, packagedServer: false, execPath: deps.nodeOnPath })
  }
  const exec = deps.execPath
  if (!isVersionedNodePath(exec)) return { command: exec, source: 'exec_path' }
  const realpath = deps.realpath ?? defaultRealpath
  const isExecutable = deps.isExecutable ?? defaultIsExecutable
  const target = realpath(exec) ?? exec
  const win = deps.platform === 'win32'
  const pathDirs = (deps.env.PATH ?? deps.env.Path ?? '').split(win ? ';' : ':').filter(Boolean)
  const onPath = pathDirs.map((dir) => path.join(dir, win ? 'node.exe' : 'node'))
  const candidates = [...new Set([...onPath, ...homebrewLinks(exec), '/opt/homebrew/bin/node', '/usr/local/bin/node'])]
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate) || isVersionedNodePath(candidate) || !isExecutable(candidate)) continue
    if (realpath(candidate) === target) return { command: candidate, source: 'stable_link' }
  }
  return {
    command: exec,
    source: 'versioned',
    warning: `The bridge runs with ${exec}, one installed Node version: it stops working when that version is upgraded or removed. Put a stable \`node\` on PATH (for example \`brew link node\`), then connect again.`,
  }
}
