/**
 * The person's Pause / Resume of a running Core definition run.
 *
 * Pause: `POST /loop-runs/:id/pause` — Core finishes the step in progress and parks
 * at the next step boundary (no step is interrupted); the run then holds as paused
 * by you, gives its capacity slot back and never resumes by itself.
 * Resume: `POST /loop-runs/:id/resume` — the same attempt continues in place.
 *
 * Cross-project capable like `cancelJob`: an explicit `projectId` builds the URL on
 * that project; null falls back to `getApiBase()` (the active project). Never
 * throws: every failure is `{ ok: false, error }` with the server's detail.
 */
import { API_ORIGIN } from '../../../lib/origin'
import { getApiBase } from '../../../lib/api'

/** What a job row says about the person's Pause (server `userPauseControl`). */
export type PauseControl = 'pause' | 'pausing' | 'resume'

export function pauseControlOf(job: { status?: string; pauseControl?: unknown } | null | undefined): PauseControl | null {
  if (!job || job.status !== 'running') return null
  return job.pauseControl === 'pause' || job.pauseControl === 'pausing' || job.pauseControl === 'resume' ? job.pauseControl : null
}

export type PauseRunOutcome = { ok: true } | { ok: false; error: string; code: string | null }

/** A resume after a restart may wait out the dead Core child's lease (server: up to 75 s). */
const TIMEOUT_MS = { pause: 15_000, resume: 90_000 } as const

async function post(projectId: string | null | undefined, jobId: string, verb: 'pause' | 'resume'): Promise<PauseRunOutcome> {
  const timeoutMs = TIMEOUT_MS[verb]
  const base = projectId ? `${API_ORIGIN}/api/projects/${projectId}` : getApiBase()
  let res: Response
  try {
    res = await fetch(`${base}/loop-runs/${encodeURIComponent(jobId)}/${verb}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : undefined,
    })
  } catch (err) {
    const e = err as Error & { name?: string }
    return { ok: false, error: e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `Request timed out after ${timeoutMs / 1000}s` : e?.message || String(err), code: null }
  }
  if (res.ok) return { ok: true }
  let body: { error?: unknown; detail?: unknown; message?: unknown } = {}
  try { body = await res.json() as typeof body } catch { /* no JSON body */ }
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.message === 'string' ? body.message : typeof body.error === 'string' ? body.error : `HTTP ${res.status}`
  return { ok: false, error: detail, code: typeof body.error === 'string' ? body.error : null }
}

export function pauseRun(options: { projectId?: string | null; jobId: string }): Promise<PauseRunOutcome> {
  return post(options.projectId, options.jobId, 'pause')
}

export function resumePausedRun(options: { projectId?: string | null; jobId: string }): Promise<PauseRunOutcome> {
  return post(options.projectId, options.jobId, 'resume')
}

const CONTROLS: readonly PauseControl[] = ['pause', 'pausing', 'resume']

/**
 * `GET /loop-runs/:id/pause-control`: the run's control without its job row (the
 * rail). Never throws; any failure reads as "no control" (Stop stays available).
 */
export async function readPauseControl(options: { projectId?: string | null; jobId: string }): Promise<PauseControl | null> {
  try {
    const base = options.projectId ? `${API_ORIGIN}/api/projects/${options.projectId}` : getApiBase()
    const res = await fetch(`${base}/loop-runs/${encodeURIComponent(options.jobId)}/pause-control`)
    if (!res.ok) return null
    const body = await res.json() as { pauseControl?: unknown }
    return CONTROLS.includes(body.pauseControl as PauseControl) ? body.pauseControl as PauseControl : null
  } catch {
    return null
  }
}
