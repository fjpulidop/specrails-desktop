// Start, stop and restart the ISOLATED Specrails server the benchmark drives.
// Only the process this module started (or the one listening on the isolated
// port, verified to run `server/index.ts` with the isolated home) is signalled.

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { apiBase } from './isolation.mjs'

const sleep = ms => new Promise(r => setTimeout(r, ms))

export function serverEnv({ home, port, clientPort, coreBin, pathPrepend, extraEnv = {} }) {
  const env = { ...process.env, ...extraEnv,
    SPECRAILS_REGISTRY_HOME: home,
    SPECRAILS_DEV_SERVER_PORT: String(port),
    SPECRAILS_FRAMEWORK_AUTOSWAP: 'false',
  }
  delete env.SPECRAILS_PORT
  if (clientPort) env.SPECRAILS_DEV_CLIENT_PORT = String(clientPort)
  if (coreBin) env.SPECRAILS_CORE_BIN = coreBin
  if (pathPrepend) env.PATH = `${pathPrepend}${path.delimiter}${env.PATH}`
  return env
}

/** PID listening on the port, or null (macOS/Linux lsof). */
export function listenerPid(port) {
  try {
    const out = execFileSync('lsof', ['-tiTCP:' + port, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim()
    return out ? Number(out.split('\n')[0]) : null
  } catch { return null }
}

function commandOf(pid) {
  try { return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).trim() } catch { return '' }
}

function envOf(pid) {
  try { return execFileSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }) } catch { return '' }
}

export async function waitHealthy(port, timeoutMs = 120_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(`${apiBase(port)}/api/health`, { signal: AbortSignal.timeout(2000) })
      if (r.ok) return Date.now() - t0
    } catch { /* not up yet */ }
    await sleep(500)
  }
  throw new Error(`Server on port ${port} did not become healthy within ${timeoutMs / 1000}s`)
}

/** Start the server from `desktopDir` with tsx (no watch). Returns { pid, readyMs }. */
export async function startServer(opts) {
  const { desktopDir, port, logFile } = opts
  if (listenerPid(port)) throw new Error(`Port ${port} is already in use`)
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  const out = fs.openSync(logFile, 'a')
  fs.writeSync(out, `\n=== benchmark start ${new Date().toISOString()}\n`)
  const tsx = path.join(desktopDir, 'node_modules', '.bin', 'tsx')
  // `inspectPort` (soak mode): the server's own inspector on loopback, for heap samples over CDP.
  // A tsx argument, not NODE_OPTIONS, so Core children and verification commands never inherit it.
  const args = [...(opts.inspectPort ? [`--inspect=127.0.0.1:${opts.inspectPort}`] : []), 'server/index.ts']
  const child = spawn(tsx, args, { cwd: desktopDir, env: serverEnv(opts), stdio: ['ignore', out, out], detached: true })
  child.unref()
  const readyMs = await waitHealthy(port)
  return { pid: child.pid, readyMs }
}

/** Verify the listener belongs to this isolated home before signalling it. */
export function ownedListener(port, home) {
  const pid = listenerPid(port)
  if (!pid) return null
  const cmd = commandOf(pid)
  if (!/server\/index\.ts|tsx/.test(cmd)) throw new Error(`Port ${port} is held by an unexpected process: ${cmd}`)
  const env = envOf(pid)
  if (env && !env.includes(`SPECRAILS_REGISTRY_HOME=${home}`)) throw new Error(`Port ${port} is not served from ${home}; refusing to signal it`)
  return pid
}

/**
 * Stop the isolated server. `graceful` sends SIGTERM (Desktop's own shutdown,
 * which pauses runs for restart); otherwise SIGKILL (a crash).
 */
export async function stopServer({ port, home, graceful = true }) {
  const pid = ownedListener(port, home)
  if (!pid) return false
  const parent = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
  process.kill(pid, graceful ? 'SIGTERM' : 'SIGKILL')
  for (let i = 0; i < 60 && listenerPid(port); i++) await sleep(500)
  // The tsx launcher parent exits with its child; signal it only if it still runs tsx.
  if (parent > 1 && /tsx/.test(commandOf(parent))) { try { process.kill(parent, 'SIGTERM') } catch { /* gone */ } }
  await sleep(500)
  return true
}

/** Variables a restart must carry over from the running server (its initial environment). */
export const CARRIED_ENV = ['PATH', 'SPECRAILS_CORE_BIN', 'BENCH_INSTALLED_DIR']

/** `NAME=value` pairs of a `ps eww` command line (values without spaces only). Pure. */
export function parsePsEnv(text, names = CARRIED_ENV) {
  const out = {}
  for (const name of names) {
    const match = new RegExp(`(?:^|\\s)${name}=(\\S*)`).exec(text)
    if (match) out[name] = match[1]
  }
  return out
}

/**
 * Restart the isolated server with the environment it ran with. A scenario's restart
 * must not drop the Core under test or the fake installers on PATH: bench5 restarted
 * with the harness's own arguments, lost both, and a remembered install ran the REAL
 * Homebrew. Explicit options still win.
 */
export async function restartServer(opts, { graceful = true } = {}) {
  const pid = ownedListener(opts.port, opts.home)
  const carried = pid ? parsePsEnv(envOf(pid)) : {}
  await stopServer({ port: opts.port, home: opts.home, graceful })
  const keepPath = !opts.pathPrepend && carried.PATH
  return startServer({ ...opts, ...(keepPath ? { pathPrepend: undefined } : {}),
    extraEnv: { ...(opts.extraEnv ?? {}), ...(keepPath ? { PATH: carried.PATH } : {}),
      ...(!opts.coreBin && carried.SPECRAILS_CORE_BIN ? { SPECRAILS_CORE_BIN: carried.SPECRAILS_CORE_BIN } : {}),
      ...(carried.BENCH_INSTALLED_DIR && !process.env.BENCH_INSTALLED_DIR ? { BENCH_INSTALLED_DIR: carried.BENCH_INSTALLED_DIR } : {}) } })
}

/** First executable `name` on a PATH string, or null. */
export function whichOnPath(name, pathValue) {
  for (const dir of String(pathValue ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    try { fs.accessSync(file, fs.constants.X_OK); return file } catch { /* next */ }
  }
  return null
}

/** The PATH the running isolated server started with, or null when it cannot be read. */
export function listenerPath(port, home) {
  const pid = ownedListener(port, home)
  return pid ? parsePsEnv(envOf(pid), ['PATH']).PATH ?? null : null
}
