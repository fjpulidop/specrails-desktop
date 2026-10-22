import {
  createStreamAuditState,
  extractStreamActions,
  classifyToolCall,
  retentionCutoff,
  toAgentActionRow,
  toCsv,
  toJsonl,
  type AgentActionCounts,
  type AgentActionDraft,
  type AgentActionInput,
  type AgentActionRow,
  type AgentAuditFormat,
} from './domain'
import type { AgentActionStore } from './ports'

export interface AgentAuditTimer {
  cancel(): void
}

export interface AgentAuditRecorderDeps {
  store: Pick<AgentActionStore, 'insertMany'>
  /** Content fingerprint for `hashSource` (sha256 in production). */
  hash?: (content: string) => string
  now?: () => number
  /** Flush cadence (default 250 ms) and batch size that triggers an early flush (default 200). */
  flushIntervalMs?: number
  maxBatch?: number
  /** Hard cap on pending rows; beyond it new rows are dropped and counted. */
  maxPending?: number
  schedule?: (callback: () => void, ms: number) => AgentAuditTimer
  log?: (message: string) => void
}

export interface AgentAuditStats {
  recorded: number
  written: number
  failed: number
  dropped: number
  pending: number
}

/** Accepts audit rows from run streams. `record` never throws and never does IO;
 * rows are written in batches on a timer. Storage failures are logged and
 * counted — they never reach the run that produced the action. */
export interface AgentAuditRecorder {
  record(actions: AgentActionInput | readonly AgentActionInput[]): void
  flush(): void
  stats(): AgentAuditStats
  dispose(): void
}

function defaultSchedule(callback: () => void, ms: number): AgentAuditTimer {
  const handle = setTimeout(callback, ms)
  ;(handle as { unref?: () => void }).unref?.()
  return { cancel: () => clearTimeout(handle) }
}

export function createAgentAuditRecorder(deps: AgentAuditRecorderDeps): AgentAuditRecorder {
  const flushIntervalMs = deps.flushIntervalMs ?? 250
  const maxBatch = Math.max(1, deps.maxBatch ?? 200)
  const maxPending = Math.max(maxBatch, deps.maxPending ?? 20_000)
  const now = deps.now ?? Date.now
  const schedule = deps.schedule ?? defaultSchedule
  const log = deps.log ?? ((message: string) => console.warn(message))
  const pending: AgentActionRow[] = []
  const stats = { recorded: 0, written: 0, failed: 0, dropped: 0 }
  let timer: AgentAuditTimer | null = null
  let disposed = false
  let lastLogAt = 0

  const warn = (message: string) => {
    const at = now()
    // At most one line per 10 s: a broken disk must not flood the server log.
    if (at - lastLogAt < 10_000) return
    lastLogAt = at
    try { log(message) } catch { /* logging is advisory */ }
  }

  const flush = () => {
    if (timer) { timer.cancel(); timer = null }
    while (pending.length > 0) {
      const batch = pending.splice(0, maxBatch)
      try {
        deps.store.insertMany(batch)
        stats.written += batch.length
      } catch (error) {
        stats.failed += batch.length
        warn(`[agent-audit] could not write ${batch.length} action(s): ${error instanceof Error ? error.message : String(error)} (failed so far: ${stats.failed})`)
      }
    }
  }

  let timerMs = Number.POSITIVE_INFINITY
  const arm = (ms: number) => {
    if (disposed || (timer && timerMs <= ms)) return
    if (timer) timer.cancel()
    try {
      timer = schedule(() => { timer = null; flush() }, ms)
      timerMs = ms
    } catch {
      timer = null
    }
  }

  return {
    record(actions) {
      if (disposed) return
      try {
        const list = Array.isArray(actions) ? actions : [actions as AgentActionInput]
        if (list.length === 0) return
        const nowIso = new Date(now()).toISOString()
        for (const action of list) {
          let hash = action.hash ?? null
          if (!hash && typeof action.hashSource === 'string' && deps.hash) {
            try { hash = deps.hash(action.hashSource) } catch { hash = null }
          }
          const row = toAgentActionRow(action, hash, nowIso)
          if (!row) continue
          if (pending.length >= maxPending) { stats.dropped += 1; continue }
          pending.push(row)
          stats.recorded += 1
        }
        if (pending.length >= maxBatch) arm(0)
        else if (pending.length > 0) arm(flushIntervalMs)
      } catch (error) {
        warn(`[agent-audit] dropped malformed action: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
    flush() {
      try { flush() } catch { /* flush already isolates store failures */ }
    },
    stats: () => ({ ...stats, pending: pending.length }),
    dispose() {
      if (disposed) return
      try { flush() } catch { /* best effort */ }
      disposed = true
      if (timer) { timer.cancel(); timer = null }
    },
  }
}

// ─── Stream taps ─────────────────────────────────────────────────────────────

export interface StreamTapContext {
  runId: string
  jobId?: string | null
  /** Role for actions the stream does not attribute itself. */
  role?: string | (() => string)
}

/**
 * A stateful observer for one run's parsed stream events. Each call extracts
 * actions and hands them to the recorder. It never throws — a classification
 * bug cannot fail the run whose stream it observes.
 */
export function createStreamAuditTap(recorder: Pick<AgentAuditRecorder, 'record'>, context: StreamTapContext): (event: unknown) => void {
  const state = createStreamAuditState()
  return (event) => {
    try {
      const role = typeof context.role === 'function' ? context.role() : context.role ?? 'agent'
      const drafts = extractStreamActions(event, state, role)
      if (drafts.length > 0) recorder.record(drafts.map(draft => withRun(draft, context, role)))
    } catch { /* audit must never affect the run */ }
  }
}

function withRun(draft: AgentActionDraft, context: StreamTapContext, role: string): AgentActionInput {
  return { ...draft, role: draft.role ?? role, runId: context.runId, jobId: context.jobId ?? null }
}

/** Record one tool call already normalised by a provider adapter (name + input or preview). */
export function recordToolCall(
  recorder: Pick<AgentAuditRecorder, 'record'>,
  context: StreamTapContext & { source: string },
  name: string,
  input: unknown,
): void {
  try {
    const role = typeof context.role === 'function' ? context.role() : context.role ?? 'agent'
    const drafts = classifyToolCall(name, input, context.source, role)
    if (drafts.length > 0) recorder.record(drafts.map(draft => withRun(draft, context, role)))
  } catch { /* audit must never affect the caller */ }
}

// ─── Queries and retention ───────────────────────────────────────────────────

export const MAX_AGENT_AUDIT_EXPORT_ROWS = 100_000

export interface AgentAuditExport {
  body: string
  contentType: string
  rows: number
}

function render(records: Parameters<typeof toJsonl>[0], format: AgentAuditFormat): AgentAuditExport {
  return format === 'csv'
    ? { body: toCsv(records), contentType: 'text/csv; charset=utf-8', rows: records.length }
    : { body: toJsonl(records), contentType: 'application/x-ndjson; charset=utf-8', rows: records.length }
}

export function createAgentAuditService(deps: {
  store: AgentActionStore
  recorder?: Pick<AgentAuditRecorder, 'flush'>
  now?: () => number
}) {
  const now = deps.now ?? Date.now
  const settle = () => { try { deps.recorder?.flush() } catch { /* export reads what is durable */ } }
  return {
    exportRun(runId: string, format: AgentAuditFormat): AgentAuditExport {
      settle()
      return render(deps.store.listByRun(runId, MAX_AGENT_AUDIT_EXPORT_ROWS), format)
    },
    exportWindow(window: { from?: string; to?: string }, format: AgentAuditFormat): AgentAuditExport {
      settle()
      return render(deps.store.listWindow({ ...window, limit: MAX_AGENT_AUDIT_EXPORT_ROWS }), format)
    },
    countByKind(runIds: readonly string[]): AgentActionCounts {
      settle()
      return deps.store.countByKind(runIds)
    },
    /** Delete rows older than the retention window. Returns the number removed. */
    prune(retentionDays: number): number {
      settle()
      return deps.store.deleteBefore(retentionCutoff(now(), retentionDays))
    },
  }
}

export type AgentAuditService = ReturnType<typeof createAgentAuditService>
