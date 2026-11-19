// Isolation guard for the live Implement benchmark. The harness drives a real
// Specrails server, so it must never reach the person's own app: the default
// data home (~/.specrails or the home directory itself) and the default ports
// 4200/4201 are refused. Pure: every input is passed in.

import path from 'node:path'

export const RESERVED_PORTS = Object.freeze([4200, 4201])

export class IsolationError extends Error {
  constructor(message) { super(message); this.name = 'IsolationError' }
}

function normalize(p) {
  return path.resolve(p).replace(/[\\/]+$/, '')
}

/**
 * Validate the isolated target. Returns the normalized `{ home, port, clientPort }`
 * or throws an IsolationError naming the refused value.
 * @param {{ home?: string, port?: number|string, clientPort?: number|string }} target
 * @param {{ userHome: string }} env
 */
export function assertIsolatedTarget(target, env) {
  const userHome = normalize(env.userHome)
  if (!target?.home || !String(target.home).trim()) throw new IsolationError('--home is required (an isolated registry home such as ~/.specrails-dev-bench)')
  const home = normalize(String(target.home).replace(/^~(?=$|[\\/])/, userHome))
  const forbidden = [userHome, path.join(userHome, '.specrails'), path.join(userHome, '.specrails-dev')]
  if (forbidden.includes(home)) throw new IsolationError(`Refusing registry home ${home}: it is the person's own Specrails data. Pass a dedicated --home.`)
  if (home === path.parse(home).root) throw new IsolationError('Refusing the filesystem root as registry home')
  // The person's data lives directly in ~/.specrails; anything nested inside it is theirs too.
  if (home.startsWith(path.join(userHome, '.specrails') + path.sep)) throw new IsolationError(`Refusing registry home ${home}: it is inside ~/.specrails.`)
  const port = parsePort(target.port, '--port')
  const clientPort = target.clientPort === undefined || target.clientPort === null || target.clientPort === '' ? undefined : parsePort(target.clientPort, '--client-port')
  for (const [flag, value] of [['--port', port], ['--client-port', clientPort]]) {
    if (value !== undefined && RESERVED_PORTS.includes(value)) throw new IsolationError(`Refusing ${flag} ${value}: ports ${RESERVED_PORTS.join('/')} belong to the person's own Specrails app.`)
  }
  if (clientPort !== undefined && clientPort === port) throw new IsolationError('--client-port must differ from --port')
  return { home, port, clientPort }
}

function parsePort(value, flag) {
  const n = Number(value)
  if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new IsolationError(`${flag} must be a TCP port (got ${value})`)
  return n
}

/** The API base URL for an isolated port (IPv4 loopback, as the server binds). */
export function apiBase(port) {
  return `http://127.0.0.1:${port}`
}

/**
 * A git remote URL the harness may push to while generating repositories:
 * only a local bare repository under the work directory. Anything else (a
 * hosted remote, ssh, https) is refused, so generation never publishes.
 */
export function assertLocalRemote(remote, workDir) {
  const resolved = normalize(remote)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote) || /^[^/\\]+@[^:]+:/.test(remote)) throw new IsolationError(`Refusing remote ${remote}: only local bare repositories are allowed`)
  if (!resolved.startsWith(normalize(workDir) + path.sep)) throw new IsolationError(`Refusing remote ${remote}: it is outside the work directory`)
  return resolved
}
