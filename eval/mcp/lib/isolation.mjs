// Isolation rules for the MCP eval harness (pure). The harness boots its own
// Specrails server and agent clients; none of them may reach the person's app,
// data home or client configuration.
import os from 'node:os'
import path from 'node:path'
import { assertIsolatedTarget, IsolationError } from '../../../scripts/benchmark/lib/isolation.mjs'

/** The person's own apps: packaged (4200/4201) and dev (4300/4301). */
export const PERSON_PORTS = Object.freeze([4200, 4201, 4300, 4301])
export const DEFAULT_PORT = 4400
export const DEFAULT_CLIENT_PORT = 4401
export { IsolationError }

/** Validated `{ home, port, clientPort }`; refuses the person's data home and ports. */
export function assertEvalTarget(target, env = { userHome: os.homedir() }) {
  const checked = assertIsolatedTarget(target, env)
  for (const port of [checked.port, checked.clientPort]) {
    if (port !== undefined && PERSON_PORTS.includes(port)) throw new IsolationError(`Refusing port ${port}: it belongs to the person's own Specrails app.`)
  }
  return checked
}

/**
 * A client home (HOME / CODEX_HOME) must be a fresh directory of the harness:
 * never the person's home, ~/.claude or ~/.codex, and inside `root`.
 */
export function assertClientHome(dir, root, env = { userHome: os.homedir() }) {
  const resolved = path.resolve(dir)
  const home = path.resolve(env.userHome)
  for (const forbidden of [home, path.join(home, '.claude'), path.join(home, '.codex')]) {
    if (resolved === forbidden || resolved.startsWith(forbidden + path.sep) && !resolved.startsWith(path.resolve(root) + path.sep)) {
      throw new IsolationError(`Refusing client home ${resolved}: it is the person's own client configuration.`)
    }
  }
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new IsolationError(`Refusing client home ${resolved}: it is outside the eval work directory.`)
  return resolved
}

/** Environment variables of the harness's own process that a client must never inherit. */
const HOST_ONLY = /^(CLAUDECODE|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK_.*|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_PREVIEW_.*|CODEX_.*|SPECRAILS_.*|ANTHROPIC_BASE_URL|MCP_.*)$/

/** Credentials a person may hand to the temp-home clients (never read from their config files). */
export const CREDENTIAL_KEYS = Object.freeze(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY'])

/**
 * The environment of an agent client: a temp HOME, the PATH, locale and the
 * explicitly passed credentials only (pure).
 */
export function clientEnv(base, { home, pass = [] }) {
  const env = {}
  for (const key of ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM']) if (base[key] !== undefined) env[key] = base[key]
  for (const key of pass) {
    if (base[key] === undefined) continue
    if (HOST_ONLY.test(key) && !CREDENTIAL_KEYS.includes(key)) continue
    env[key] = base[key]
  }
  env.HOME = home
  return env
}
