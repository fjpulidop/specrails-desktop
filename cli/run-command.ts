import { spawn } from 'child_process'
import { createInterface } from 'readline'
import WebSocket from 'ws'
import path from 'path'
import { spawnCli } from './win-spawn'
import { httpGet, httpPost, loadDesktopToken } from './desktop-client'
import { cliError, cliLog, dimCyan, cliWarn, printSummary } from './output'



export const EXIT_PATTERN = /\[process exited with code (\d+)/


// ---------------------------------------------------------------------------
// Manager path
// ---------------------------------------------------------------------------

export interface WsLogMessage {
  type: 'log'
  source: 'stdout' | 'stderr'
  line: string
  processId: string
}


export interface WsPhaseMessage {
  type: 'phase'
  phase: string
  state: string
}


export interface WsInitMessage {
  type: 'init'
  logBuffer: WsLogMessage[]
}


export type WsMsg = WsLogMessage | WsPhaseMessage | WsInitMessage | { type: string }


// ---------------------------------------------------------------------------
// Super mode: resolve project context from CWD
// ---------------------------------------------------------------------------

export interface DesktopProject {
  id: string
  name: string
  path: string
}


export async function resolveProjectFromCwd(baseUrl: string, projectOverride?: string): Promise<DesktopProject | null> {
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
        // Resolve by name: fetch all projects and match. Names are NOT unique
        // (two repos with the same basename register the same name), so a bare
        // first-match `find` would silently mis-route. Auto-pick only on a
        // unique match; on collision, error out listing the candidates.
        const res = await httpGet(`${baseUrl}/api/projects`)
        if (res.status === 200) {
          const data = JSON.parse(res.body) as { projects?: DesktopProject[] }
          const matches = (data.projects ?? []).filter(
            (p) => p.name.toLowerCase() === projectOverride.toLowerCase()
          )
          if (matches.length > 1) {
            cliError(`--project "${projectOverride}" is ambiguous (${matches.length} projects share this name):`)
            for (const m of matches) {
              cliError(`  ${m.id}  ${m.path}`)
            }
            cliError('disambiguate with --project <path> instead of the name')
            return null
          }
          return matches[0] ?? null
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


export async function runViaWebManager(command: string, baseUrl: string, projectOverride?: string): Promise<number> {
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

// Mirrors the real claude stream-json `result` event (see claude-adapter.ts
// extractClaudeResult): cost is `total_cost_usd`, tokens nest under `usage.*`,
// and the final answer text is carried on `result`.
export interface StreamJsonResult {
  total_cost_usd?: number
  result?: string
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
}


export async function runDirect(command: string): Promise<number> {
  const startTime = Date.now()

  const args = [
    '--dangerously-skip-permissions',
    // `-p` takes a SINGLE operand — the whole prompt. Splitting on whitespace
    // (the old `...command.trim().split(/\s+/)`) shattered multi-word prompts
    // into stray positionals and lost quoting/whitespace. Pass it intact.
    '-p',
    command.trim(),
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

    if (parsed.type === 'assistant') {
      // Real claude emits assistant text as `type:'assistant'` with
      // `message.content[]` `{type:'text', text}` blocks (mirror
      // parseClaudeStreamLine). The legacy `type:'text'`/`content` shape is
      // kept as a fallback for older/synthetic streams.
      const msg = (parsed as { message?: { content?: Array<{ type?: string; text?: string }> } }).message
      const text = (msg?.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('')
      if (text) process.stdout.write(`${text}\n`)
    } else if (parsed.type === 'text') {
      const content = (parsed as { content?: string }).content ?? ''
      if (content) process.stdout.write(`${content}\n`)
    } else if (parsed.type === 'result') {
      resultData = parsed as StreamJsonResult
      // The `result` event also carries the final answer text on `result`.
      if (resultData.result) process.stdout.write(`${resultData.result}\n`)
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
    if (resultData.total_cost_usd != null) costUsd = resultData.total_cost_usd
    const usage = resultData.usage
    const tokensIn = usage?.input_tokens ?? 0
    const tokensOut = usage?.output_tokens ?? 0
    if (usage?.input_tokens != null || usage?.output_tokens != null) {
      totalTokens = tokensIn + tokensOut
    }
  }

  printSummary({ durationMs, costUsd, totalTokens, exitCode })
  return exitCode
}
