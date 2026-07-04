/**
 * Shared, manager-aware job/run cancel helper.
 *
 * ONE endpoint stops everything: `DELETE /api/projects/:projectId/jobs/:id`.
 * The server route dispatches by owner — a rail loop run (`railLoopRuns`)
 * goes to `LoopRunManager.cancel` (settles 'stopped' at the next node
 * boundary → `{ status: 'canceling' }`); a queue job goes to
 * `QueueManager.cancel` (`'canceled'` when still queued, `'canceling'` when
 * the running process was signalled); an already-terminal row is deleted
 * (`'deleted'`). Interactive jobs ride the same route — "Discard" is a label,
 * not a different endpoint.
 *
 * Cross-project capable: when `projectId` is provided the URL is built
 * EXPLICITLY as `${API_ORIGIN}/api/projects/${projectId}/...` (mission-mode
 * JobDetailModal shows jobs from the conversation's pinned project, which may
 * differ from the active one). Only when `projectId` is null/undefined does it
 * fall back to `getApiBase()` (board mode, where the active project IS the
 * job's project).
 *
 * NEVER throws — every failure (HTTP error, non-JSON body, network error,
 * timeout) is shaped into `{ ok: false, error, httpStatus }` with as much
 * detail as the transport gave us, so the caller can surface it verbatim.
 * The request is timeout-bounded (default 15s): during a provider-quota
 * incident the server can hang mid-request, and an unbounded fetch left the
 * user with a button that appeared to do nothing.
 */
import { API_ORIGIN } from './origin'
import { getApiBase } from './api'

/** Discriminates the cancel idiom (labels/toasts) — the endpoint is shared. */
export type CancelKind = 'job' | 'interactive' | 'loop-run'

/** Derive the cancel idiom for a job row. Loop runs are backed by a job row
 *  whose command is `loop: <name>` (the same discriminator JobDetailModal /
 *  JobDetailPage already use to mount the LoopStepExplorer). */
export function cancelKindForJob(job: { command: string; interactive?: number | boolean | null }): CancelKind {
  if (job.command.startsWith('loop:')) return 'loop-run'
  if (job.interactive) return 'interactive'
  return 'job'
}

export type CancelJobOutcome =
  /** The server accepted the cancel. `status` is the server's word:
   *  'canceling' | 'canceled' | 'deleted' (unknown strings pass through). */
  | { ok: true; status: string }
  /** The cancel did NOT land. `error` always carries human-readable detail;
   *  `httpStatus` is null for transport-level failures (network/timeout). */
  | { ok: false; error: string; httpStatus: number | null }

export interface CancelJobOptions {
  /** Explicit project scope. null/undefined → active project via getApiBase(). */
  projectId?: string | null
  jobId: string
  /** Optional idiom hint — accepted for call-site clarity; the endpoint is the
   *  same for every kind (the server dispatches to the owning manager). */
  kind?: CancelKind
  /** Abort the request after this many ms (default 15000). */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 15_000

function timeoutSignal(ms: number): AbortSignal | undefined {
  // Guarded: AbortSignal.timeout is Node ≥17.3 / modern browsers; older
  // webviews simply run unbounded (same as before this helper existed).
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  return undefined
}

export async function cancelJob(options: CancelJobOptions): Promise<CancelJobOutcome> {
  const { projectId, jobId, timeoutMs = DEFAULT_TIMEOUT_MS } = options
  const base = projectId ? `${API_ORIGIN}/api/projects/${projectId}` : getApiBase()

  let res: Response
  try {
    res = await fetch(`${base}/jobs/${jobId}`, { method: 'DELETE', signal: timeoutSignal(timeoutMs) })
  } catch (err) {
    const e = err as Error & { name?: string }
    const error = e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `Request timed out after ${Math.round(timeoutMs / 1000)}s`
      : (e?.message || String(err))
    return { ok: false, error, httpStatus: null }
  }

  if (res.ok) {
    // Body is informative only ({ ok, status }) — a malformed body must not
    // turn a successful cancel into a reported failure.
    let status = 'canceled'
    try {
      const data = await res.json() as { status?: string } | null
      if (data && typeof data.status === 'string') status = data.status
    } catch { /* keep default */ }
    return { ok: true, status }
  }

  // HTTP failure — surface EVERYTHING we can extract. Read the body ONCE as
  // text (a second read after a failed .json() would throw "already consumed").
  const httpStatus = typeof res.status === 'number' ? res.status : null
  const httpSuffix = httpStatus != null ? ` (HTTP ${httpStatus})` : ''
  let raw = ''
  try {
    if (typeof res.text === 'function') raw = await res.text()
    else if (typeof res.json === 'function') raw = JSON.stringify(await res.json())
  } catch { /* no readable body */ }
  let detail = raw.slice(0, 200).trim()
  try {
    const data = JSON.parse(raw) as { error?: string } | null
    if (data && typeof data.error === 'string' && data.error) detail = data.error
  } catch { /* not JSON — keep the raw snippet */ }
  const statusText = typeof res.statusText === 'string' ? res.statusText : ''
  const error = detail
    ? `${detail}${httpSuffix}`
    : `HTTP ${httpStatus ?? '?'}${statusText ? ` ${statusText}` : ''}`
  return { ok: false, error, httpStatus }
}
