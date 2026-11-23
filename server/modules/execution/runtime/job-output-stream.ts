// Stream handling for a spawned one-shot queue job (stage of
// QueueManager._startJob): raw event persistence with the fail-stop, batched
// log/event broadcast, adapter event accumulation for accounting, the
// synthetic OTEL bridge, the agent-actions audit tap and the close hand-off to
// the terminal settle path. State that outlives the stream stays owned by
// QueueManager and is reached only through the narrow host below.
import type { ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import type { Interface as ReadlineInterface } from 'readline'
import type { WsMessage, LogMessage } from '../../../types'
import type { DbInstance } from '../../../db'
import { appendEvent } from '../../../db'
import type { ProviderAdapter, AdapterEvent } from '../../../providers'
import { parseStreamEvents } from '../../../providers/runtime'
import { extractDisplayText } from '../../../util/stream-display'
import { createStreamAuditTap, type AgentAuditRecorder } from '../../audit'
import { createCodexOtelBridge, type CodexOtelBridge } from '../../accounting/runtime/codex-otel-bridge'
import { observeQuotaLine } from '../../provider-quota/runtime/stream-observer'

export type EmitLine = (source: 'stdout' | 'stderr', line: string) => void

/** QueueManager state the stream reads or mutates; every read is live. */
export interface JobOutputStreamHost {
  db(): DbInstance | null
  isDisposed(): boolean
  /** Durable job still accepts child events (running, or force-failed row). */
  acceptsEvents(jobId: string): boolean
  /** First critical raw-event persistence failure: pause and stop the child. */
  failStopOnEventPersistence(jobId: string): void
  broadcast(msg: WsMessage): void
  appendLog(msg: LogMessage): void
  agentAudit: Pick<AgentAuditRecorder, 'record'> | null
  registerLiveAccounting(jobId: string, live: { events: AdapterEvent[]; adapter: ProviderAdapter; model?: string }): void
  registerReaders(jobId: string, readers: { stdout: ReadlineInterface; stderr: ReadlineInterface }): void
  onExit(
    jobId: string,
    code: number | null,
    lastResultEvent: Record<string, unknown> | null,
    emitLine: EmitLine,
    adapterEvents: AdapterEvent[],
    model: string,
    adapter: ProviderAdapter,
  ): void
}

export interface JobOutputStreamInput {
  jobId: string
  child: ChildProcess
  adapter: ProviderAdapter
  model: string
  projectId: string | null
  desktopPort: number
  telemetryEnabled: boolean
  environmentNotice: string | null
}

export function attachJobOutputStream(host: JobOutputStreamHost, input: JobOutputStreamInput): void {
  const { jobId, child, adapter } = input
  const railModel = input.model

  let eventSeq = 0
  let lastResultEvent: Record<string, unknown> | null = null
  let rawPersistenceFailed = false
  const persistEvent = (
    event: { event_type: string; source?: string | null; payload: string },
    critical = true,
  ): { seq: number; persisted: boolean } => {
    const seq = eventSeq++
    const db = host.db()
    // A force-failed child may continue emitting after its durable job became
    // terminal (and its history may already be deleted). Keep parsing usage
    // in memory for late reconciliation, but never write child events through
    // a terminal/missing FK or let storage failure escape readline.
    if (!db) return { seq, persisted: true }
    if (!host.acceptsEvents(jobId)) return { seq, persisted: false }
    try {
      appendEvent(db, jobId, seq, event)
    } catch (err) {
      console.error(`[queue-manager] event persistence failed for ${jobId}:`, err)
      if (critical && !rawPersistenceFailed) {
        rawPersistenceFailed = true
        host.failStopOnEventPersistence(jobId)
      }
      return { seq, persisted: false }
    }
    return { seq, persisted: true }
  }

  // Accumulator of parsed AdapterEvent for finaliseInvocationResult on close.
  const adapterEvents: AdapterEvent[] = []
  // Expose the (growing) accumulator + adapter/model so shutdown() can flush an
  // aborted, cost-estimated ai_invocations row if this job is still in flight
  // when the manager is torn down (CRIT-3). Cleared on every terminal path.
  host.registerLiveAccounting(jobId, { events: adapterEvents, adapter, model: railModel })

  // Synthetic OTEL bridge for providers whose CLI does not honour OTEL_*
  // env vars (codex today). Lifecycle bound to the spawn's close handler.
  let otelBridge: CodexOtelBridge | null = null
  if (input.telemetryEnabled && !adapter.capabilities.nativeOtelEnv && input.projectId) {
    otelBridge = createCodexOtelBridge({
      jobId,
      projectId: input.projectId,
      desktopPort: input.desktopPort,
      model: railModel,
    })
  }

  // ── Batched broadcast for high-frequency messages (log + event) ──────
  // Collects messages and flushes every ~80ms instead of one WS send per line.
  const pendingBroadcast: WsMessage[] = []
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const FLUSH_INTERVAL_MS = 80

  const batchedBroadcast = (msg: WsMessage): void => {
    if (host.isDisposed()) return
    pendingBroadcast.push(msg)
    if (!flushTimer) {
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (host.isDisposed()) { pendingBroadcast.length = 0; return }
        const batch = pendingBroadcast.splice(0)
        for (const m of batch) host.broadcast(m)
      }, FLUSH_INTERVAL_MS)
    }
  }

  const flushPending = (): void => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
    const batch = pendingBroadcast.splice(0)
    if (host.isDisposed()) return
    for (const m of batch) host.broadcast(m)
  }

  const emitLine: EmitLine = (source, line) => {
    const msg: LogMessage = {
      type: 'log',
      source,
      line,
      timestamp: new Date().toISOString(),
      processId: jobId,
    }
    host.appendLog(msg)
    batchedBroadcast(msg)
  }

  const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
  const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })
  host.registerReaders(jobId, { stdout: stdoutReader, stderr: stderrReader })

  if (input.environmentNotice) {
    persistEvent({ event_type: 'log', source: 'stderr', payload: JSON.stringify({ line: input.environmentNotice }) }, false)
    emitLine('stderr', input.environmentNotice)
  }

  // Agent actions audit: observes parsed provider frames; never throws.
  const auditTap = host.agentAudit ? createStreamAuditTap(host.agentAudit, { runId: jobId, jobId }) : null
  stdoutReader.on('line', (line) => {
    if (host.isDisposed()) return
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(line) } catch { /* plain text */ }
    if (parsed && auditTap) auditTap(parsed)

    // Feed the adapter for the canonical event shape used by
    // finaliseInvocationResult and (optionally) the OTEL bridge. Done
    // alongside the raw event persistence below, NOT in place of it: the
    // raw event log is what feeds the live Job Detail UI and the
    // telemetry export ZIP for non-bridge providers.
    observeQuotaLine(adapter.id, line)
    const adapterEventsForLine = parseStreamEvents(adapter, line)
    for (const adapterEv of adapterEventsForLine) {
      adapterEvents.push(adapterEv)
      otelBridge?.consumeEvent(adapterEv)
    }

    if (parsed) {
      const eventType = (parsed.type as string) ?? (parsed.role as string) ?? 'unknown'
      const persisted = persistEvent({
        event_type: eventType,
        source: 'stdout',
        payload: line,
      })
      if (!persisted.persisted) return
      batchedBroadcast({
        type: 'event',
        jobId,
        event_type: eventType,
        source: 'stdout',
        payload: line,
        timestamp: new Date().toISOString(),
        seq: persisted.seq,
      })
      if (eventType === 'result') {
        lastResultEvent = parsed
      }
      const displayText = extractDisplayText(parsed)
      if (displayText !== null) {
        persistEvent({
          event_type: 'log',
          source: 'stdout',
          payload: JSON.stringify({ line: displayText }),
        }, false)
        emitLine('stdout', displayText)
      }
    } else {
      persistEvent({
        event_type: 'log',
        source: 'stdout',
        payload: JSON.stringify({ line }),
      }, false)
      // For adapters whose stream is JSONL (claude, codex), a non-parseable
      // line is unexpected noise. For future plain-text adapters this is
      // their normal output. emitLine surfaces it either way.
      const textEvent = adapterEventsForLine.find((event) => event.kind === 'text-delta')
      if (textEvent?.kind === 'text-delta') {
        emitLine('stdout', textEvent.text)
      } else {
        emitLine('stdout', line)
      }
    }
  })

  stderrReader.on('line', (line) => {
    if (host.isDisposed()) return
    persistEvent({
      event_type: 'log',
      source: 'stderr',
      payload: JSON.stringify({ line }),
    }, false)
    emitLine('stderr', line)
  })

  child.on('close', (code) => {
    flushPending() // flush any remaining batched messages before job exit

    // Finalise the OTEL bridge (best-effort, async). The bridge POSTs to
    // the in-process OTLP receiver; failures are warned, not thrown.
    if (otelBridge) {
      otelBridge.finalize({ exitCode: code }).catch((err) => {
        console.warn('[queue-manager] otel bridge finalize failed:', err)
      })
    }

    host.onExit(jobId, code, lastResultEvent, emitLine, adapterEvents, railModel, adapter)
  })
}
