#!/usr/bin/env node
/**
 * specrails-desktop — specrails CLI bridge
 *
 * Routes commands to the manager when running, or falls back to invoking
 * claude directly when the manager is not reachable.
 *
 * Usage:
 *   specrails-desktop implement #42           → /specrails:implement #42 (via manager or direct)
 *   specrails-desktop "any raw prompt"        → raw prompt (no /specrails: prefix)
 *   specrails-desktop --status                → print manager state
 *   specrails-desktop --jobs                  → print job history table
 *   specrails-desktop --port 5000 <command>   → use port 5000 instead of 4200
 *   specrails-desktop --help                  → print usage and exit 0
 */

import http from 'http'
import net from 'net'
import { spawn } from 'child_process'
import { spawn as spawnProc } from 'child_process'
import { createInterface } from 'readline'
import WebSocket from 'ws'
import path from 'path'
import os from 'os'
import { spawnCli } from './win-spawn'
import fs from 'fs'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 4200
const DETECTION_TIMEOUT_MS = 500

export const KNOWN_VERBS = new Set([
  'implement',
  'batch-implement',
  'why',
  'get-backlog-specs',
  'auto-propose-backlog-specs',
  'propose-spec',
  'refactor-recommender',
  'health-check',
  'compat-check',
  'enrich',
])

const EXIT_PATTERN = /\[process exited with code (\d+)/

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const isTTY = process.stdout.isTTY === true

function ansi(code: string, text: string): string {
  if (!isTTY) return text
  return `\x1b[${code}m${text}\x1b[0m`
}

const dim = (t: string) => ansi('2', t)
const red = (t: string) => ansi('31', t)
const bold = (t: string) => ansi('1', t)
const dimCyan = (t: string) => ansi('2;36', t)

function cliPrefix(): string {
  return dim('[specrails-desktop]')
}

function cliLog(msg: string): void {
  process.stdout.write(`${cliPrefix()} ${msg}\n`)
}

function cliError(msg: string): void {
  process.stderr.write(`${cliPrefix()} ${red(`error: ${msg}`)}\n`)
}

function cliWarn(msg: string): void {
  process.stderr.write(`${cliPrefix()} ${dim(`warning: ${msg}`)}\n`)
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export type ParsedArgs =
  | { mode: 'help' }
  | { mode: 'version' }
  | { mode: 'status'; port: number }
  | { mode: 'jobs'; port: number }
  | { mode: 'desktop'; subArgs: string[]; port: number }
  | { mode: 'command'; resolved: string; port: number; projectOverride?: string }
  | { mode: 'raw'; resolved: string; port: number; projectOverride?: string }

export function parseArgs(argv: string[]): ParsedArgs {
  // argv is process.argv.slice(2)
  let port = DEFAULT_PORT
  let projectOverride: string | undefined
  const args = [...argv]

  // Extract --port <n> and --project <name|path> from any position
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && i + 1 < args.length) {
      const parsed = parseInt(args[i + 1], 10)
      if (!isNaN(parsed)) {
        port = parsed
      }
      args.splice(i, 2)
      i--
    } else if (args[i] === '--project' && i + 1 < args.length) {
      projectOverride = args[i + 1]
      args.splice(i, 2)
      i--
    }
  }

  if (args[0] === '--version' || args[0] === '-v') {
    return { mode: 'version' }
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { mode: 'help' }
  }

  if (args[0] === '--status') {
    return { mode: 'status', port }
  }

  if (args[0] === '--jobs') {
    return { mode: 'jobs', port }
  }

  if (args[0] === 'desktop') {
    return { mode: 'desktop', subArgs: args.slice(1), port }
  }

  // Allow server-management subcommands directly without the 'desktop' prefix:
  //   specrails-desktop start  →  specrails-desktop desktop start
  //   specrails-desktop stop   →  specrails-desktop desktop stop
  //   specrails-desktop add    →  specrails-desktop desktop add
  //   etc.
  const DESKTOP_SUBCOMMANDS = new Set(['start', 'stop', 'status', 'add', 'remove', 'list'])
  if (DESKTOP_SUBCOMMANDS.has(args[0])) {
    return { mode: 'desktop', subArgs: args, port }
  }

  const first = args[0]

  // Slash-prefixed command: pass through unchanged
  if (first.startsWith('/')) {
    const resolved = args.join(' ')
    return { mode: 'raw', resolved, port, projectOverride }
  }

  // Known verb: inject /specrails: prefix
  if (KNOWN_VERBS.has(first)) {
    const resolved = `/specrails:${args.join(' ')}`
    return { mode: 'command', resolved, port, projectOverride }
  }

  // Unknown first token: treat as raw prompt
  const resolved = args.join(' ')
  return { mode: 'raw', resolved, port, projectOverride }
}

export function getVersion(): string {
  for (const rel of ['../package.json', '../../package.json']) {
    try {
      const pkgPath = path.join(__dirname, rel)
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
      if (typeof pkg.version === 'string') return pkg.version
    } catch {
      // try next
    }
  }
  return 'unknown'
}

function printVersion(): void {
  process.stdout.write(`specrails-desktop v${getVersion()}\n`)
}

function printHelp(): void {
  const version = getVersion()
  process.stdout.write(`
${bold(`specrails-desktop v${version}`)} — specrails CLI bridge

${bold('Project Required:')}
  Every command runs in the context of a project registered for the current
  directory. Register your project once before running any commands:

    ${dim('# Register your project (run once per project):')}
    specrails-desktop add .

    ${dim('# Then run commands from that directory:')}
    specrails-desktop implement #42

${bold('Usage:')}
  specrails-desktop implement #42                Run a known specrails verb (prepends /specrails:)
  specrails-desktop batch-implement #40 #41      Batch implementation across issues
  specrails-desktop why                          Explain recent changes
  specrails-desktop get-backlog-specs            View prioritized spec backlog
  specrails-desktop auto-propose-backlog-specs   Generate new spec ideas
  specrails-desktop propose-spec                 Explore an idea and produce a spec
  specrails-desktop refactor-recommender        Find refactoring opportunities
  specrails-desktop health-check                Run codebase health check
  specrails-desktop compat-check                Check for breaking API changes
  specrails-desktop "any raw prompt"             Pass a raw prompt directly to claude
  specrails-desktop --status                     Print manager status and exit
  specrails-desktop --jobs                       Print recent job history and exit
  specrails-desktop start|stop|add|remove|list  Manage the server
  specrails-desktop --project <name|path>        Override project (default: current directory)
  specrails-desktop --port <n>                   Override default port (${DEFAULT_PORT})
  specrails-desktop --version, -v               Print version and exit
  specrails-desktop --help, -h                  Show this help text

${bold('Execution paths:')}
  Manager running → POST /api/spawn + stream logs via WebSocket
  Manager not running → spawn claude directly with stream-json output
`.trimStart())
}

// ---------------------------------------------------------------------------
// Manager detection
// ---------------------------------------------------------------------------

export interface DetectionResult {
  running: boolean
  baseUrl: string
}

export function detectWebManager(port: number): Promise<DetectionResult> {
  const baseUrl = `http://127.0.0.1:${port}`
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      req.destroy()
      resolve({ running: false, baseUrl })
    }, DETECTION_TIMEOUT_MS)

    const req = http.get(`${baseUrl}/api/health`, { timeout: DETECTION_TIMEOUT_MS }, (res) => {
      clearTimeout(timer)
      res.resume() // drain the response
      if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
        resolve({ running: true, baseUrl })
      } else {
        resolve({ running: false, baseUrl })
      }
    })

    req.on('error', () => {
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })

    req.on('timeout', () => {
      req.destroy()
      clearTimeout(timer)
      resolve({ running: false, baseUrl })
    })
  })
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function loadDesktopToken(): string | null {
  const candidates = [
    path.join(os.homedir(), '.specrails', 'desktop.token'),
    // Legacy fallback: pre-rename installs keep the token at hub.token until the
    // server migrates it on next startup. Compat only — do not extend.
    path.join(os.homedir(), '.specrails', 'hub.token'),
  ]
  for (const tokenPath of candidates) {
    try {
      const t = fs.readFileSync(tokenPath, 'utf-8').trim()
      if (t.length >= 32) return t
    } catch {
      // try next candidate
    }
  }
  return null
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const token = loadDesktopToken()
    const parsed = new URL(url)
    const headers: http.OutgoingHttpHeaders = {}
    if (token) headers['Authorization'] = `Bearer ${token}`
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers,
    }
    const req = http.get(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
  })
}

function httpPost(url: string, payload: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload)
    const urlObj = new URL(url)
    const token = loadDesktopToken()
    const headers: http.OutgoingHttpHeaders = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(data),
    }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const options: http.RequestOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers,
    }
    const req = http.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) {
    return `${totalSeconds}s`
  }
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}m ${seconds}s`
}

// ---------------------------------------------------------------------------
// Token formatting
// ---------------------------------------------------------------------------

export function formatTokens(n: number): string {
  return new Intl.NumberFormat('en-US', { useGrouping: true })
    .format(n)
    .replace(/,/g, ' ')
}

// ---------------------------------------------------------------------------
// Summary line
// ---------------------------------------------------------------------------

export interface SummaryData {
  durationMs: number
  costUsd?: number
  totalTokens?: number
  exitCode: number
}

export function printSummary(data: SummaryData): void {
  const doneLabel = isTTY ? bold('[specrails-desktop] done') : '[specrails-desktop] done'
  const durationPart = `duration: ${formatDuration(data.durationMs)}`
  const costPart = data.costUsd != null ? `  cost: $${data.costUsd.toFixed(2)}` : ''
  const tokenPart = data.totalTokens != null ? `  tokens: ${formatTokens(data.totalTokens)}` : ''
  const exitPart = `  exit: ${data.exitCode}`

  process.stdout.write(`${doneLabel}  ${durationPart}${costPart}${tokenPart}${exitPart}\n`)
}

// ---------------------------------------------------------------------------
// Manager path
// ---------------------------------------------------------------------------

interface WsLogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  processId: string
}

interface WsPhaseMessage {
  type: 'phase'
  phase: string
  state: string
}

interface WsInitMessage {
  type: 'init'
  logBuffer: WsLogMessage[]
}

type WsMsg = WsLogMessage | WsPhaseMessage | WsInitMessage | { type: string }

// ---------------------------------------------------------------------------
// Super mode: resolve project context from CWD
// ---------------------------------------------------------------------------

interface DesktopProject {
  id: string
  name: string
  path: string
}

async function resolveProjectFromCwd(baseUrl: string, projectOverride?: string): Promise<DesktopProject | null> {
  try {
    // --project flag: resolve by path (absolute/relative) or by name
    if (projectOverride) {
      // Path vs name: POSIX absolute (`/…`), relative (`./…`), OR a Windows
      // absolute (`C:\…` / `C:/…`) or any path containing a separator. Without
      // the drive-letter/backslash cases `--project C:\repo` was mis-read as a
      // project NAME on Windows and never matched.
      const isPathLike =
        path.isAbsolute(projectOverride) ||
        projectOverride.startsWith('.') ||
        /^[A-Za-z]:[\\/]/.test(projectOverride) ||
        projectOverride.includes('/') ||
        projectOverride.includes('\\')
      if (isPathLike) {
        const res = await httpGet(`${baseUrl}/api/resolve?path=${encodeURIComponent(projectOverride)}`)
        if (res.status === 200) {
          const data = JSON.parse(res.body) as { project?: DesktopProject }
          return data.project ?? null
        }
      } else {
        // Resolve by name: fetch all projects and match
        const res = await httpGet(`${baseUrl}/api/projects`)
        if (res.status === 200) {
          const data = JSON.parse(res.body) as { projects?: DesktopProject[] }
          const match = (data.projects ?? []).find(
            (p) => p.name.toLowerCase() === projectOverride.toLowerCase()
          )
          return match ?? null
        }
      }
      return null
    }

    // Default: resolve from CWD
    const cwd = process.cwd()
    const res = await httpGet(`${baseUrl}/api/resolve?path=${encodeURIComponent(cwd)}`)
    if (res.status === 200) {
      const data = JSON.parse(res.body) as { project?: DesktopProject }
      return data.project ?? null
    }
  } catch {
    // Resolve endpoint not available — not in Super mode
  }
  return null
}

async function runViaWebManager(command: string, baseUrl: string, projectOverride?: string): Promise<number> {
  // Detect Super mode: check if /api/state is reachable
  let spawnUrl = `${baseUrl}/api/spawn`
  let jobApiBase = `${baseUrl}/api`

  try {
    const superCheck = await httpGet(`${baseUrl}/api/state`)
    if (superCheck.status === 200) {
      // Super mode: resolve project from CWD or --project override
      const project = await resolveProjectFromCwd(baseUrl, projectOverride)
      if (!project) {
        const hint = projectOverride
          ? `no project found matching: ${projectOverride}`
          : `no project registered for the current directory.\n  Run: specrails-desktop add ${process.cwd()}`
        cliError(`server is running but ${hint}`)
        return 1
      }
      spawnUrl = `${baseUrl}/api/projects/${project.id}/spawn`
      jobApiBase = `${baseUrl}/api/projects/${project.id}`
      cliLog(`project: ${project.name}`)
    }
  } catch {
    // Single-project mode — use default paths
  }

  // Spawn the job
  let spawnRes: { status: number; body: string }
  try {
    spawnRes = await httpPost(spawnUrl, { command })
  } catch (err) {
    cliError('failed to connect to manager')
    return 1
  }

  if (spawnRes.status === 409) {
    cliError('manager is busy (another job is running)')
    return 1
  }

  if (spawnRes.status >= 400) {
    let errMsg = `spawn failed with HTTP ${spawnRes.status}`
    try {
      const parsed = JSON.parse(spawnRes.body) as { error?: string }
      if (parsed.error) errMsg = parsed.error
    } catch { /* use default */ }
    cliError(errMsg)
    return 1
  }

  let processId: string
  try {
    const parsed = JSON.parse(spawnRes.body) as { jobId?: string; processId?: string }
    // Server returns jobId; processId is the legacy field name used in LogMessage
    processId = (parsed.jobId ?? parsed.processId) ?? ''
    if (!processId) throw new Error('missing jobId')
  } catch {
    cliError('invalid response from /api/spawn')
    return 1
  }

  const startTime = Date.now()

  // Connect WebSocket and stream logs
  const wsUrl = baseUrl.replace(/^http/, 'ws')
  const token = loadDesktopToken()
  let exitCode = 1
  let resolved = false

  await new Promise<void>((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })

    ws.on('message', (data) => {
      let msg: WsMsg
      try {
        msg = JSON.parse(data.toString()) as WsMsg
      } catch {
        return
      }

      if (msg.type === 'init') {
        // Replay only log lines from our processId
        const initMsg = msg as WsInitMessage
        for (const logLine of initMsg.logBuffer) {
          if (logLine.processId === processId) {
            handleLogLine(logLine)
          }
        }
        return
      }

      if (msg.type === 'log') {
        const logMsg = msg as WsLogMessage
        if (logMsg.processId !== processId) return
        handleLogLine(logMsg)
        return
      }

      if (msg.type === 'phase') {
        const phaseMsg = msg as WsPhaseMessage
        process.stdout.write(`  ${dimCyan(`→ [${phaseMsg.phase}] ${phaseMsg.state}`)}\n`)
        return
      }
    })

    function handleLogLine(logMsg: WsLogMessage): void {
      if (resolved) return

      // Check for exit signal
      const match = EXIT_PATTERN.exec(logMsg.line)
      if (match) {
        exitCode = parseInt(match[1], 10)
        resolved = true
        ws.close()
        resolve()
        return
      }

      // Print to appropriate stream, preserving ANSI
      if (logMsg.source === 'stderr') {
        process.stderr.write(`${logMsg.line}\n`)
      } else {
        process.stdout.write(`${logMsg.line}\n`)
      }
    }

    ws.on('close', () => {
      if (!resolved) {
        cliWarn('lost connection to manager')
        resolved = true
        resolve()
      }
    })

    ws.on('error', (err) => {
      if (!resolved) {
        cliWarn(`WebSocket error: ${err.message}`)
        resolved = true
        resolve()
      }
    })
  })

  const durationMs = Date.now() - startTime

  // Fetch job metadata for cost/tokens
  let costUsd: number | undefined
  let totalTokens: number | undefined

  try {
    const jobRes = await httpGet(`${jobApiBase}/jobs/${processId}`)
    if (jobRes.status === 200) {
      const parsed = JSON.parse(jobRes.body) as {
        job?: {
          total_cost_usd?: number | null
          tokens_in?: number | null
          tokens_out?: number | null
          duration_ms?: number | null
        }
      }
      if (parsed.job) {
        if (parsed.job.total_cost_usd != null) costUsd = parsed.job.total_cost_usd
        const tokensIn = parsed.job.tokens_in ?? 0
        const tokensOut = parsed.job.tokens_out ?? 0
        if (parsed.job.tokens_in != null || parsed.job.tokens_out != null) {
          totalTokens = tokensIn + tokensOut
        }
        // Prefer server-side duration when available
        if (parsed.job.duration_ms != null) {
          printSummary({ durationMs: parsed.job.duration_ms, costUsd, totalTokens, exitCode })
          return exitCode
        }
      }
    }
  } catch { /* fall through to duration-only summary */ }

  printSummary({ durationMs, costUsd, totalTokens, exitCode })
  return exitCode
}

// ---------------------------------------------------------------------------
// Direct fallback path
// ---------------------------------------------------------------------------

interface StreamJsonResult {
  cost_usd?: number
  input_tokens?: number
  output_tokens?: number
}

async function runDirect(command: string): Promise<number> {
  const startTime = Date.now()

  const args = [
    '--dangerously-skip-permissions',
    '-p',
    ...command.trim().split(/\s+/),
    '--output-format', 'stream-json',
    '--verbose',
  ]

  let child: ReturnType<typeof spawn>
  try {
    // Windows: `claude` is `claude.cmd`; spawnCli routes through cross-spawn so
    // the shim resolves and multi-line args survive (raw `spawn(shell:false)`
    // threw ENOENT/EINVAL on Windows even with claude installed).
    child = spawnCli('claude', args, {
      env: process.env,
      shell: false,
    })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      cliError('claude binary not found')
    } else {
      cliError(`failed to spawn claude: ${(err as Error).message}`)
    }
    return 1
  }

  let resultData: StreamJsonResult | undefined

  // Stderr: pass through unchanged
  child.stderr?.pipe(process.stderr)

  // Stdout: parse NDJSON line by line
  const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity })

  rl.on('line', (line) => {
    if (!line.trim()) return

    let parsed: { type?: string } | null = null
    try {
      parsed = JSON.parse(line) as { type?: string }
    } catch {
      // Non-JSON line: print as-is
      process.stdout.write(`${line}\n`)
      return
    }

    if (parsed.type === 'text') {
      const content = (parsed as { content?: string }).content ?? ''
      if (content) process.stdout.write(`${content}\n`)
    } else if (parsed.type === 'result') {
      resultData = parsed as StreamJsonResult
    }
    // All other types: silently ignore
  })

  const exitCode = await new Promise<number>((resolve) => {
    child.on('close', (code) => {
      resolve(code ?? 1)
    })

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') {
        cliError('claude binary not found')
      } else {
        cliError(`claude process error: ${err.message}`)
      }
      resolve(1)
    })
  })

  const durationMs = Date.now() - startTime

  let costUsd: number | undefined
  let totalTokens: number | undefined

  if (resultData) {
    if (resultData.cost_usd != null) costUsd = resultData.cost_usd
    const tokensIn = resultData.input_tokens ?? 0
    const tokensOut = resultData.output_tokens ?? 0
    if (resultData.input_tokens != null || resultData.output_tokens != null) {
      totalTokens = tokensIn + tokensOut
    }
  }

  printSummary({ durationMs, costUsd, totalTokens, exitCode })
  return exitCode
}

// ---------------------------------------------------------------------------
// --status handler
// ---------------------------------------------------------------------------

async function handleStatus(port: number): Promise<number> {
  const baseUrl = `http://127.0.0.1:${port}`
  const detection = await detectWebManager(port)

  if (!detection.running) {
    process.stdout.write(`manager: not running (${baseUrl})\n`)
    return 1
  }

  try {
    const healthRes = await httpGet(`${baseUrl}/api/health`)
    if (healthRes.status !== 200) {
      process.stdout.write(`manager: not running (${baseUrl})\n`)
      return 1
    }

    const health = JSON.parse(healthRes.body) as {
      status?: string
      version?: string
      uptime?: number
      projects?: number
      mode?: string
    }

    const version = health.version ? `  (v${health.version})` : ''
    process.stdout.write(`manager: running${version}\n`)
    process.stdout.write(`mode:        ${health.mode ?? 'unknown'}\n`)
    if (health.projects !== undefined) {
      process.stdout.write(`projects:    ${health.projects}\n`)
    }

    // Legacy mode: fetch additional per-project details from /api/state
    if (health.mode !== 'super') {
      const stateRes = await httpGet(`${baseUrl}/api/state`)
      if (stateRes.status === 200) {
        const state = JSON.parse(stateRes.body) as {
          projectName?: string
          busy?: boolean
          phases?: Record<string, string>
        }
        process.stdout.write(`project:     ${state.projectName ?? 'unknown'}\n`)
        process.stdout.write(`busy:        ${state.busy ? 'true' : 'false'}\n`)
        if (state.phases) {
          const phaseStr = Object.entries(state.phases)
            .map(([phase, st]) => `${phase}=${st}`)
            .join('  ')
          process.stdout.write(`phases:      ${phaseStr}\n`)
        }
      }
    }

    return 0
  } catch {
    process.stdout.write(`manager: not running (${baseUrl})\n`)
    return 1
  }
}

// ---------------------------------------------------------------------------
// --jobs handler
// ---------------------------------------------------------------------------

interface JobRow {
  id: string
  command: string
  started_at: string
  duration_ms: number | null
  exit_code: number | null
  status: string
}

interface JobsResponse {
  jobs: JobRow[]
  total: number
}

function formatJobDuration(ms: number | null): string {
  if (ms == null) return '-'
  return formatDuration(ms)
}

function formatJobStarted(isoStr: string): string {
  try {
    const d = new Date(isoStr)
    const year = d.getFullYear()
    const month = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    const hour = String(d.getHours()).padStart(2, '0')
    const min = String(d.getMinutes()).padStart(2, '0')
    return `${year}-${month}-${day} ${hour}:${min}`
  } catch {
    return isoStr.slice(0, 16)
  }
}

async function handleJobs(port: number): Promise<number> {
  const baseUrl = `http://127.0.0.1:${port}`
  const detection = await detectWebManager(port)

  if (!detection.running) {
    cliError(`manager is not running (${baseUrl})`)
    return 1
  }

  let res: { status: number; body: string }
  try {
    res = await httpGet(`${baseUrl}/api/jobs`)
  } catch {
    cliError('failed to fetch job list')
    return 1
  }

  if (res.status === 501 || res.status === 404) {
    cliLog('jobs history requires manager with SQLite persistence (#57)')
    return 1
  }

  if (res.status !== 200) {
    cliError(`unexpected response from /api/jobs: HTTP ${res.status}`)
    return 1
  }

  let data: JobsResponse
  try {
    data = JSON.parse(res.body) as JobsResponse
  } catch {
    cliError('invalid response from /api/jobs')
    return 1
  }

  if (!data.jobs || data.jobs.length === 0) {
    cliLog('no jobs recorded yet')
    return 0
  }

  // Column widths
  const idW = 8
  const cmdW = 30
  const startW = 18
  const durW = 8
  const exitW = 4

  const header = [
    'ID'.padEnd(idW),
    'COMMAND'.padEnd(cmdW),
    'STARTED'.padEnd(startW),
    'DURATION'.padEnd(durW),
    'EXIT'.padEnd(exitW),
  ].join('  ')

  process.stdout.write(`${bold(header)}\n`)

  for (const job of data.jobs) {
    const idCell = job.id.slice(0, idW).padEnd(idW)
    const cmdCell = job.command.slice(0, cmdW).padEnd(cmdW)
    const startCell = formatJobStarted(job.started_at).padEnd(startW)
    const durCell = formatJobDuration(job.duration_ms).padEnd(durW)
    const exitCell = (job.exit_code ?? '-').toString().padEnd(exitW)
    process.stdout.write(`${idCell}  ${cmdCell}  ${startCell}  ${durCell}  ${exitCell}\n`)
  }

  return 0
}

// ---------------------------------------------------------------------------
// Server-management subcommand group
// ---------------------------------------------------------------------------

const DESKTOP_PID_FILE = path.join(os.homedir(), '.specrails', 'manager.pid')
const DESKTOP_LOG_FILE = path.join(os.homedir(), '.specrails', 'desktop.log')

function isPortInUse(port: number): Promise<boolean> {
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

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(DESKTOP_PID_FILE, 'utf-8').trim()
    const pid = parseInt(raw, 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function desktopServerPath(): string {
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

async function desktopStart(port: number): Promise<number> {
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

async function desktopStop(): Promise<number> {
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

async function desktopStatus(port: number): Promise<number> {
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

async function desktopAdd(projectPath: string, port: number): Promise<number> {
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

async function desktopRemove(projectId: string, port: number): Promise<number> {
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

async function desktopList(port: number): Promise<number> {
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

async function handleDesktop(subArgs: string[], port: number): Promise<number> {
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

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const parsed = parseArgs(argv)

  if (parsed.mode === 'version') {
    printVersion()
    process.exit(0)
  }

  if (parsed.mode === 'help') {
    printHelp()
    process.exit(0)
  }

  if (parsed.mode === 'status') {
    const code = await handleStatus(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'jobs') {
    const code = await handleJobs(parsed.port)
    process.exit(code)
  }

  if (parsed.mode === 'desktop') {
    const code = await handleDesktop(parsed.subArgs, parsed.port)
    process.exit(code)
  }

  // Command or raw: resolve command string
  const command = parsed.resolved
  const port = parsed.port

  cliLog(`running: ${command}`)

  const detection = await detectWebManager(port)

  let exitCode: number

  const projectOverride = (parsed.mode === 'command' || parsed.mode === 'raw') ? parsed.projectOverride : undefined

  if (detection.running) {
    cliLog(`routing via manager at ${detection.baseUrl}`)
    exitCode = await runViaWebManager(command, detection.baseUrl, projectOverride)
  } else {
    cliLog('manager not running — invoking claude directly')
    exitCode = await runDirect(command)
  }

  process.exit(exitCode)
}

// Only run main() when this file is executed directly (not when imported in tests)
if (require.main === module) {
  main().catch((err: unknown) => {
    cliError((err as Error).message ?? String(err))
    process.exit(1)
  })
}

// ---------------------------------------------------------------------------
// Test-only exports — not part of the public API
// ---------------------------------------------------------------------------

export const _internal = {
  ansi, dim, red, bold, dimCyan, cliPrefix, cliLog, cliError, cliWarn,
  httpGet, httpPost, formatJobDuration, formatJobStarted, printVersion, printHelp,
  handleStatus, handleJobs, handleDesktop, desktopStart, desktopStop, desktopStatus, desktopAdd, desktopRemove, desktopList, desktopServerPath,
  resolveProjectFromCwd, runViaWebManager, runDirect, isPortInUse, readPid, isProcessRunning, main,
  isTTY, DESKTOP_PID_FILE, DESKTOP_LOG_FILE, EXIT_PATTERN, DEFAULT_PORT, DETECTION_TIMEOUT_MS,
}
