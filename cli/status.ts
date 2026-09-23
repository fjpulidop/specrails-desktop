import { detectWebManager, httpGet } from './desktop-client'
import { cliError, cliLog, bold } from './output'
import { formatJobStarted, formatJobDuration } from './format'



// ---------------------------------------------------------------------------
// --status handler
// ---------------------------------------------------------------------------

export async function handleStatus(port: number): Promise<number> {
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

export interface JobRow {
  id: string
  command: string
  started_at: string
  duration_ms: number | null
  exit_code: number | null
  status: string
}


export interface JobsResponse {
  jobs: JobRow[]
  total: number
}


export async function handleJobs(port: number): Promise<number> {
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
