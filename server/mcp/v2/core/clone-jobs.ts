import { randomUUID } from 'crypto'
import { eventJournalFor, refKey, type EventJournal, type JournalEvent } from '../../../modules/events-journal'
import { apiCall, type McpToolContext } from '../../tools/types'
import { asRecord, type Row } from './text'

/**
 * `specrails_projects(clone)` beyond a client's call timeout. A clone runs in
 * the background of this server process and is followed by its journal rows
 * (`clone:<cloneId>`, from `repository.clone_*` frames): started, Git
 * progress (phase and percent, from the clone route), done with the
 * registered project, or failed with the route's reason. The caller waits
 * inline up to `waitMs`; a slower clone answers 202 and is followed with
 * `specrails_wait(until, refs:[clone:<id>])`.
 *
 * The running set is process-local by design: only this process can finish a
 * clone. A journal row still `running` for a clone this process does not know
 * was interrupted by a restart, and `settleInterruptedClones` records that
 * failure the first time anyone reads it (no clone stays running forever).
 */

/** Long enough for the route's own 300 s Git timeout. */
const CLONE_TIMEOUT_MS = 310_000

export interface CloneRequest {
  url: unknown
  destination: string
  register: boolean
  name?: string | null
  providers?: string[]
  /** Makes the registered project the default of this MCP session. */
  select?: boolean
}

export interface CloneOutcome {
  path: string
  project?: { id: string; slug: string; name: string }
}

export interface CloneJob {
  id: string
  destination: string
  register: boolean
  startedAt: number
  /** Settles with the outcome; rejects with the route's error (an McpApiError). */
  done: Promise<CloneOutcome>
  outcome?: CloneOutcome
  error?: unknown
}

const running = new Map<string, CloneJob>()

/** This process's running clones (oldest first). */
export function runningClones(): CloneJob[] {
  return [...running.values()]
}

export function isCloneRunning(id: string): boolean {
  return running.has(id)
}

const journalOf = (ctx: Pick<McpToolContext, 'desktopDb' | 'eventBus'>): EventJournal => eventJournalFor(ctx.desktopDb, ctx.eventBus)

/** One frame to the GUI (broadcast) and to the journal (ingest de-duplicates the bus copy). */
function emit(ctx: McpToolContext, frame: Row): void {
  const message = { ...frame, timestamp: new Date().toISOString() }
  try { ctx.broadcast(message as never) } catch { /* the GUI copy is best effort */ }
  try { journalOf(ctx).ingest(message) } catch { /* the journal is optional */ }
}

function errorText(err: unknown): { error: string; code?: string } {
  const data = asRecord((err as { data?: unknown })?.data)
  const error = typeof data.error === 'string' ? data.error : err instanceof Error ? err.message : String(err)
  return { error, ...(typeof data.code === 'string' ? { code: data.code } : {}) }
}

/**
 * Starts a clone in the background and returns at once. The work runs through
 * the app's own routes (POST /repositories/clone, then POST /projects) without
 * the calling request's cancellation: a client that times out or disconnects
 * never aborts it.
 */
export function startClone(ctx: McpToolContext, request: CloneRequest): CloneJob {
  const id = randomUUID()
  const background: McpToolContext = { ...ctx, signal: undefined }
  const session = ctx.sessionState
  emit(ctx, { type: 'repository.clone_started', cloneId: id, path: request.destination })
  const job: CloneJob = { id, destination: request.destination, register: request.register, startedAt: Date.now(), done: Promise.resolve({ path: request.destination }) }
  running.set(id, job)
  job.done = (async (): Promise<CloneOutcome> => {
    const cloned = asRecord(await apiCall(background, 'POST', '/repositories/clone', { url: request.url, destination: request.destination, cloneId: id }, { timeoutMs: CLONE_TIMEOUT_MS }))
    const path = String(cloned.path ?? request.destination)
    if (!request.register) return { path }
    const body: Row = { path }
    if (request.name) body.name = request.name
    if (request.providers?.length) body.providers = request.providers
    const project = asRecord(asRecord(await apiCall(background, 'POST', '/projects', body)).project)
    const out = { id: String(project.id ?? ''), slug: String(project.slug ?? ''), name: String(project.name ?? project.slug ?? '') }
    if (request.select && out.id && session) session.activeProjectId = out.id
    return { path, project: out }
  })()
  job.done.then((outcome) => {
    job.outcome = outcome
    emit(ctx, { type: 'repository.clone_done', cloneId: id, path: outcome.path, ...(outcome.project ? { newProjectId: outcome.project.id, slug: outcome.project.slug } : {}) })
  }, (err: unknown) => {
    job.error = err
    emit(ctx, { type: 'repository.clone_failed', cloneId: id, path: request.destination, ...errorText(err) })
  }).finally(() => { running.delete(id) })
  // The caller observes `done` itself; never an unhandled rejection here.
  job.done.catch(() => {})
  return job
}

/** Resolves true when the job settled within `ms` (false on timeout or abort). */
export async function settledWithin(job: CloneJob, ms: number, signal?: AbortSignal): Promise<boolean> {
  if (ms <= 0) return false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    onAbort = () => resolve(false)
    signal?.addEventListener('abort', onAbort)
  })
  try {
    return await Promise.race([job.done.then(() => true, () => true), late])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
}

export const INTERRUPTED_CLONE = 'interrupted'

/**
 * Clone refs whose latest row is still running but that no process task owns
 * (the app restarted mid-clone): records their failure now, once, and returns
 * the refreshed latest rows.
 */
export function settleInterruptedClones(ctx: Pick<McpToolContext, 'desktopDb' | 'eventBus'>, ids: readonly string[]): Map<string, JournalEvent> {
  const journal = journalOf(ctx)
  const refs = ids.map((id) => ({ kind: 'clone', id }))
  if (!refs.length) return new Map()
  let latest = journal.latest(refs)
  const orphans = ids.filter((id) => {
    const row = latest.get(refKey('clone', id))
    return row && !row.settled && !running.has(id)
  })
  if (!orphans.length) return latest
  for (const id of orphans) {
    const path = latest.get(refKey('clone', id))?.data?.path
    journal.ingest({
      type: 'repository.clone_failed', cloneId: id, code: INTERRUPTED_CLONE, ...(path ? { path } : {}),
      error: `Interrupted: Specrails restarted while this clone ran.${path ? ` ${path} may hold a partial clone; remove it before cloning there again.` : ''}`,
    })
  }
  journal.flush()
  latest = journal.latest(refs)
  return latest
}

/** Test hook: forget the running set (a simulated restart). */
export function _forgetRunningClonesForTest(): void {
  running.clear()
}
