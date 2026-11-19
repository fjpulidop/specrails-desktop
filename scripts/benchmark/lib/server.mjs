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
  const child = spawn(tsx, ['server/index.ts'], { cwd: desktopDir, env: serverEnv(opts), stdio: ['ignore', out, out], detached: true })
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

export async function restartServer(opts, { graceful = true } = {}) {
  await stopServer({ port: opts.port, home: opts.home, graceful })
  return startServer(opts)
}
