import http from 'http'
import net from 'net'
import path from 'path'
import os from 'os'
import { spawnCli } from './win-spawn'
import fs from 'fs'
import { cliLog, cliError, bold } from './output'
import { detectWebManager, httpGet, httpPost, loadDesktopToken } from './desktop-client'



// ---------------------------------------------------------------------------
// Server-management subcommand group
// ---------------------------------------------------------------------------

export const DESKTOP_PID_FILE = path.join(os.homedir(), '.specrails', 'manager.pid')

export const DESKTOP_LOG_FILE = path.join(os.homedir(), '.specrails', 'desktop.log')


export function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.once('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE')
    })
    srv.once('listening', () => {
      srv.close()
      resolve(false)
    })
    srv.listen(port, '127.0.0.1')
  })
}


export function readPid(): number | null {
  try {
    const raw = fs.readFileSync(DESKTOP_PID_FILE, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}


export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}


export function desktopServerPath(): string {
  // __dirname differs by runtime:
  //   compiled (npm install): <root>/cli/dist/  → need ../../server/dist/index.js
  //   tsx dev:                <root>/cli/        → need ../server/dist/index.js
  // Try both, compiled path first.
  const fromDist = path.resolve(__dirname, '..', '..', 'server', 'dist', 'index.js')
  const fromSrc  = path.resolve(__dirname, '..', 'server', 'dist', 'index.js')
  const devTs    = path.resolve(__dirname, '..', 'server', 'index.ts')
  if (fs.existsSync(fromDist)) return fromDist
  if (fs.existsSync(fromSrc))  return fromSrc
  if (fs.existsSync(devTs))    return devTs
  return fromDist
}


export async function desktopStart(port: number): Promise<number> {
  const pid = readPid()
  if (pid !== null && isProcessRunning(pid)) {
    cliLog(`server already running (pid ${pid}) on port ${port}`)
    return 0
  }

  // Check if port is already in use by another process
  const portBusy = await isPortInUse(port)
  if (portBusy) {
    cliError(`port ${port} is already in use by another process`)
    cliError(`if a previous server is stale, run: specrails-desktop stop`)
    cliError(`or use a different port: specrails-desktop --port <port> start`)
    return 1
  }

  const serverPath = desktopServerPath()
  const isTs = serverPath.endsWith('.ts')
  const args = isTs
    ? ['tsx', serverPath, '--port', String(port)]
    : ['node', serverPath, '--port', String(port)]

  // Ensure log dir exists and open log file for server output
  try {
    fs.mkdirSync(path.dirname(DESKTOP_LOG_FILE), { recursive: true })
  } catch { /* ignore */ }

  let logFd: number | undefined
  try {
    logFd = fs.openSync(DESKTOP_LOG_FILE, 'a')
  } catch { /* ignore — fall back to silent */ }

  const stdio: ['ignore', number | 'ignore', number | 'ignore'] = [
    'ignore',
    logFd ?? 'ignore',
    logFd ?? 'ignore',
  ]

  // spawnCli so a dev `tsx`(.cmd) launcher resolves on Windows and the env is
  // SystemRoot-backfilled; for the packaged `node` path cross-spawn spawns the
  // .exe directly (no cmd.exe wrapper), keeping `detached` clean.
  const child = spawnCli(args[0], args.slice(1), {
    detached: true,
    stdio,
    env: { ...process.env },
  })

  if (logFd !== undefined) {
    try { fs.closeSync(logFd) } catch { /* ignore */ }
  }

  child.unref()

  // Poll until the server is ready (up to 15 seconds, checking every 300ms)
  const pollTimeoutMs = 15000
  const pollIntervalMs = 300
  const startPoll = Date.now()

  while (Date.now() - startPoll < pollTimeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, pollIntervalMs))
    const detection = await detectWebManager(port)
    if (detection.running) {
      cliLog(`server started on http://127.0.0.1:${port}`)
      return 0
    }
  }
  cliError(`server failed to start — logs: ${DESKTOP_LOG_FILE}`)
  return 1
}


export async function desktopStop(): Promise<number> {
  const pid = readPid()
  if (pid === null) {
    cliLog('server is not running (no pid file)')
    return 0
  }
  if (!isProcessRunning(pid)) {
    cliLog('server is not running (stale pid file)')
    try { fs.unlinkSync(DESKTOP_PID_FILE) } catch { /* ignore */ }
    return 0
  }
  try {
    process.kill(pid, 'SIGTERM')
    cliLog(`server stopped (pid ${pid})`)
    return 0
  } catch (err) {
    cliError(`failed to stop server: ${(err as Error).message}`)
    return 1
  }
}


export async function desktopStatus(port: number): Promise<number> {
  const pid = readPid()
  const detection = await detectWebManager(port)

  if (!detection.running) {
    process.stdout.write(`server: not running\n`)
    return 1
  }

  try {
    const res = await httpGet(`${detection.baseUrl}/api/state`)
    const state = JSON.parse(res.body) as { projectCount?: number; projects?: Array<{ name: string }> }
    process.stdout.write(`server: running (pid ${pid ?? '?'}) on ${detection.baseUrl}\n`)
    process.stdout.write(`projects: ${state.projectCount ?? 0}\n`)
    if (state.projects) {
      for (const p of state.projects) {
        process.stdout.write(`  - ${p.name}\n`)
      }
    }
    return 0
  } catch {
    process.stdout.write(`server: running on ${detection.baseUrl}\n`)
    return 0
  }
}


export async function desktopAdd(projectPath: string, port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    cliError('server is not running. Start it first with: specrails-desktop start')
    return 1
  }
  try {
    const res = await httpPost(`${detection.baseUrl}/api/projects`, {
      path: path.resolve(projectPath),
    })
    if (res.status === 201) {
      const data = JSON.parse(res.body) as { project?: { name: string; id: string } }
      cliLog(`added project: ${data.project?.name ?? projectPath}`)
      return 0
    } else if (res.status === 409) {
      cliLog('project already registered')
      return 0
    } else {
      let errMsg = `HTTP ${res.status}`
      try { errMsg = (JSON.parse(res.body) as { error?: string }).error ?? errMsg } catch { /* use default */ }
      cliError(`failed to add project: ${errMsg}`)
      return 1
    }
  } catch (err) {
    cliError(`failed to connect to server: ${(err as Error).message}`)
    return 1
  }
}


export async function desktopRemove(projectId: string, port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    cliError('server is not running')
    return 1
  }
  try {
    const deleteRes = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const urlObj = new URL(`${detection.baseUrl}/api/projects/${projectId}`)
      const token = loadDesktopToken()
      const headers: http.OutgoingHttpHeaders = {}
      if (token) headers['Authorization'] = `Bearer ${token}`
      const options: http.RequestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: 'DELETE',
        headers,
      }
      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })
    if (deleteRes.status === 200) {
      cliLog(`project removed`)
      return 0
    } else {
      cliError(`failed to remove project: HTTP ${deleteRes.status}`)
      return 1
    }
  } catch (err) {
    cliError(`failed to connect to server: ${(err as Error).message}`)
    return 1
  }
}


export async function desktopList(port: number): Promise<number> {
  const detection = await detectWebManager(port)
  if (!detection.running) {
    cliError('server is not running')
    return 1
  }
  try {
    const res = await httpGet(`${detection.baseUrl}/api/projects`)
    const data = JSON.parse(res.body) as { projects: Array<{ id: string; name: string; path: string }> }
    if (!data.projects || data.projects.length === 0) {
      cliLog('no projects registered')
      return 0
    }
    const idW = 36
    const nameW = 24
    process.stdout.write(`${bold('ID'.padEnd(idW))}  ${bold('NAME'.padEnd(nameW))}  ${bold('PATH')}\n`)
    for (const p of data.projects) {
      process.stdout.write(`${p.id.padEnd(idW)}  ${p.name.padEnd(nameW)}  ${p.path}\n`)
    }
    return 0
  } catch (err) {
    cliError(`failed to fetch projects: ${(err as Error).message}`)
    return 1
  }
}


export async function handleDesktop(subArgs: string[], port: number): Promise<number> {
  const sub = subArgs[0]

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    process.stdout.write(`
${bold('specrails-desktop')} — server management

${bold('Usage:')}
  specrails-desktop start                  Start the Specrails server
  specrails-desktop stop                   Stop the Specrails server
  specrails-desktop status                 Show server status and registered projects
  specrails-desktop add <path>             Register a project by path
  specrails-desktop remove <id>            Unregister a project by ID
  specrails-desktop list                   List all registered projects
`.trimStart())
    return 0
  }

  if (sub === 'start') {
    return desktopStart(port)
  }
  if (sub === 'stop') {
    return desktopStop()
  }
  if (sub === 'status') {
    return desktopStatus(port)
  }
  if (sub === 'add') {
    const projectPath = subArgs[1]
    if (!projectPath) {
      cliError('usage: specrails-desktop add <path>')
      return 1
    }
    return desktopAdd(projectPath, port)
  }
  if (sub === 'remove') {
    const projectId = subArgs[1]
    if (!projectId) {
      cliError('usage: specrails-desktop remove <id>')
      return 1
    }
    return desktopRemove(projectId, port)
  }
  if (sub === 'list') {
    return desktopList(port)
  }

  cliError(`unknown subcommand: ${sub}`)
  return 1
}
