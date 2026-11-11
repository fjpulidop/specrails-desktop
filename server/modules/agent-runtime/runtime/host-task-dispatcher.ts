import type { DbInstance } from '../../../db'

/**
 * Host-task dispatcher (pr-ci-loop, Core capability `hostTasks`, contract 5.11).
 *
 * A Core definition pauses on a MACHINE interrupt (`kind: 'host-task'`) when it
 * needs an effect only the host may perform (wait for CI, push to a PR, prepare
 * a base merge). Desktop resolves it here, never through a person:
 *
 *   1. the dispatch `(runId, interruptId)` is persisted BEFORE the handler acts;
 *   2. the handler runs outside Core's lease (Core holds none while paused);
 *   3. the typed result is persisted BEFORE Core is resumed with `--host-result`.
 *
 * A restart between 2 and 3 re-runs the handler (handlers are idempotent); a
 * restart after 3 replays the recorded result, so an effect never repeats once
 * its outcome is known. The registry is generic: capability modules register
 * handlers by task name at composition time.
 */

export interface HostTaskRequest {
  task: string
  input: Record<string, unknown>
  outcomes: string[]
  effect: 'read' | 'write'
  timeoutMs?: number
  candidate: { hash: string | null; verified: boolean; receiptId?: string }
}
export interface HostTaskResult { outcome: string; output?: unknown }

export interface HostTaskInvocation {
  projectId: string
  runId: string
  interruptId: string
  request: HostTaskRequest
  signal: AbortSignal
  /** Advisory progress line for the run log (plain language, never secrets). */
  log(line: string): void
}
export type HostTaskHandler = (invocation: HostTaskInvocation) => Promise<HostTaskResult>

export interface HostTaskDispatchRow {
  run_id: string
  interrupt_id: string
  task: string
  status: 'running' | 'resolved'
  attempts: number
  result_json: string | null
  created_at: string
  updated_at: string
}

/** Largest result Core accepts as `output` (Core HOST_TASK_OUTPUT_LIMIT_BYTES). */
export const HOST_TASK_OUTPUT_LIMIT_BYTES = 256 * 1024

export function readHostTaskDispatch(db: DbInstance, runId: string, interruptId: string): HostTaskDispatchRow | undefined {
  return db.prepare('SELECT * FROM host_task_dispatches WHERE run_id = ? AND interrupt_id = ?').get(runId, interruptId) as HostTaskDispatchRow | undefined
}

export function listHostTaskDispatches(db: DbInstance, runId: string): HostTaskDispatchRow[] {
  return db.prepare('SELECT * FROM host_task_dispatches WHERE run_id = ? ORDER BY created_at, interrupt_id').all(runId) as HostTaskDispatchRow[]
}

/** Bound a handler result to what Core accepts; an oversized output is replaced, never truncated mid-JSON. */
export function boundHostTaskResult(result: HostTaskResult, outcomes: readonly string[]): HostTaskResult {
  const outcome = result.outcome === 'failed' || outcomes.includes(result.outcome) ? result.outcome : 'failed'
  const output = outcome === result.outcome ? result.output : { detail: `The host task returned an undeclared outcome (${String(result.outcome).slice(0, 64)})` }
  if (output === undefined) return { outcome }
  const encoded = JSON.stringify(output)
  if (encoded === undefined) return { outcome }
  if (Buffer.byteLength(encoded) <= HOST_TASK_OUTPUT_LIMIT_BYTES) return { outcome, output: JSON.parse(encoded) as unknown }
  return { outcome, output: { detail: 'The host task output exceeded the size Core accepts and was omitted', truncated: true } }
}

export interface HostTaskDispatcherOptions {
  db: DbInstance
  projectId: string
  handlers: Readonly<Record<string, HostTaskHandler>>
  now?: () => number
}

export interface HostTaskDispatcher {
  supports(task: string): boolean
  dispatch(input: { runId: string; interruptId: string; request: HostTaskRequest; log(line: string): void }): Promise<HostTaskResult>
  /** Abort every in-flight handler of a run (Stop on the card, cancellation). */
  cancel(runId: string): void
  dispose(): void
}

export function createHostTaskDispatcher(options: HostTaskDispatcherOptions): HostTaskDispatcher {
  const now = options.now ?? Date.now
  const inFlight = new Map<string, Map<string, { controller: AbortController; promise: Promise<HostTaskResult> }>>()
  const iso = () => new Date(now()).toISOString()

  const persistResult = (runId: string, interruptId: string, result: HostTaskResult): void => {
    options.db.prepare(`UPDATE host_task_dispatches SET status = 'resolved', result_json = ?, updated_at = ? WHERE run_id = ? AND interrupt_id = ?`)
      .run(JSON.stringify(result), iso(), runId, interruptId)
  }

  return {
    supports: task => Object.hasOwn(options.handlers, task),
    dispatch({ runId, interruptId, request, log }) {
      const running = inFlight.get(runId)?.get(interruptId)
      if (running) return running.promise
      const recorded = readHostTaskDispatch(options.db, runId, interruptId)
      if (recorded?.status === 'resolved' && recorded.result_json) {
        // Crash after the effect's outcome was known: replay it, never repeat the effect.
        return Promise.resolve(JSON.parse(recorded.result_json) as HostTaskResult)
      }
      const at = iso()
      options.db.prepare(`INSERT INTO host_task_dispatches (run_id, interrupt_id, task, status, attempts, result_json, created_at, updated_at)
        VALUES (?, ?, ?, 'running', 1, NULL, ?, ?)
        ON CONFLICT(run_id, interrupt_id) DO UPDATE SET status = 'running', attempts = attempts + 1, updated_at = excluded.updated_at`)
        .run(runId, interruptId, request.task, at, at)
      const controller = new AbortController()
      const handler = Object.hasOwn(options.handlers, request.task) ? options.handlers[request.task] : undefined
      const promise = (async (): Promise<HostTaskResult> => {
        let result: HostTaskResult
        if (!handler) result = { outcome: 'failed', output: { detail: `No host handler is registered for ${request.task}` } }
        else {
          try {
            result = boundHostTaskResult(await handler({ projectId: options.projectId, runId, interruptId, request, signal: controller.signal, log }), request.outcomes)
          } catch (error) {
            if (controller.signal.aborted) throw error
            result = { outcome: 'failed', output: { detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) } }
          }
        }
        if (controller.signal.aborted) throw new Error('host_task_cancelled')
        persistResult(runId, interruptId, result)
        return result
      })().finally(() => {
        const byRun = inFlight.get(runId)
        byRun?.delete(interruptId)
        if (byRun && byRun.size === 0) inFlight.delete(runId)
      })
      let byRun = inFlight.get(runId)
      if (!byRun) { byRun = new Map(); inFlight.set(runId, byRun) }
      byRun.set(interruptId, { controller, promise })
      return promise
    },
    cancel(runId) {
      for (const entry of inFlight.get(runId)?.values() ?? []) entry.controller.abort(new Error('host_task_cancelled'))
    },
    dispose() {
      for (const runId of [...inFlight.keys()]) for (const entry of inFlight.get(runId)!.values()) entry.controller.abort(new Error('host_task_cancelled'))
    },
  }
}

/** Abortable delay for polling handlers; rejects as soon as the signal aborts. */
export function hostTaskDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason ?? new Error('host_task_cancelled')); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
    timer.unref?.()
    const onAbort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('host_task_cancelled')) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
