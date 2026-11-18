/**
 * Event emission for one loop run's backing job row: the run-owned monotonic
 * seq allocator, structured run events (`loop_graph`, `loop_step`,
 * `loop_step_end`, …), flat log lines and forwarded raw provider frames. Every
 * write persists to `events` first and then broadcasts (advisory).
 * Contract: docs/internals/loop-step-log-explorer.md.
 */
import { createStreamAuditTap } from '../../audit'
import { appendEvent } from '../../../db'
import { runtimeEfficiencyEventLine, isRecordedRuntimeEfficiencyEvent } from '../../agent-runtime/runtime/agent-runtime-events'
import { updateLoopStepActivityCheckpoint } from './loop-runs-store'
import { detectPortConflict } from '../../terminals/domain/run-ports'
import type { LoopRunHost, LoopRunState } from './loop-run-context'
import type { LoopLogSink, LoopStepEndEventPayload, LoopStepEventPayload } from './loop-run-contract'

export interface LoopStepEndInput {
  status: LoopStepEndEventPayload['status']
  exitCode?: number | null
  durationMs?: number
  decision?: 'continue' | 'stop'
  reason?: LoopStepEndEventPayload['reason']
  idleMs?: number
}

export interface LoopRunEvents {
  /** Monotonic event-seq allocator for THIS run's job row. Shared with an
   *  interactive step session (which persists its own provider events/logs on
   *  the same job id) so replay ordering (getJobEvents ORDER BY seq) stays
   *  correct — two independent counters would collide/interleave wrongly. */
  takeSeq(): number
  emitRunEvent(eventType: string, payload: unknown): void
  emitStep(
    kind: LoopStepEventPayload['kind'],
    title: string,
    nodeId: string,
    iteration: number,
    detail?: Pick<LoopStepEventPayload, 'template' | 'command' | 'attempt'>,
  ): void
  emitStepEnd(input: LoopStepEndInput): void
  logLine: LoopLogSink
  onRawLine(line: string): void
  /** Agent actions audit tap for this run (null when no recorder is bound). */
  auditTap: ReturnType<typeof createStreamAuditTap> | null
}

/** Agent conversation events: their tool output is the agent's own exploration, not the
 *  run's checks, so a collision the agent hit (and maybe worked around) is not the cause. */
const AGENT_STREAM_EVENT = /^(?:assistant|user|system|result|stream_event|(?:item|turn|thread)\..*)$/

export function createLoopRunEvents(host: LoopRunHost, runId: string, state: LoopRunState): LoopRunEvents {
  const takeSeq = (): number => state.seq++
  // Port collisions printed by the run's checks, servers and Core receipts (recovery `port_in_use`).
  const notePortConflict = (line: string): void => {
    const conflict = detectPortConflict(line)
    if (conflict) state.portConflict = { ...conflict, stepId: state.openStep?.nodeId ?? null }
  }
  // Persist + broadcast ONE structured JSON event on the run's job row (the
  // same wire shape the raw-provider forwarder uses).
  const emitRunEvent = (eventType: string, payload: unknown): void => {
    const s = takeSeq()
    const json = JSON.stringify(payload)
    try {
      appendEvent(host.db, runId, s, { event_type: eventType, source: 'stdout', payload: json })
    } catch { /* best-effort */ }
    host.emit({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: json, seq: s, timestamp: new Date(host.now()).toISOString() })
  }
  // Emit a structured step-boundary event (for a segmented/collapsible client
  // view) AND a visual divider line in the flat log, so each loop step is a
  // clearly-delimited section. `iteration` is the 1-based pass number at
  // emission (see LoopStepEventPayload).
  const emitStep: LoopRunEvents['emitStep'] = (kind, title, nodeId, iteration, detail) => {
    state.stepNum += 1
    const startedAtMs = host.now()
    state.openStep = { index: state.stepNum, nodeId, startMs: startedAtMs }
    const payload: LoopStepEventPayload = { index: state.stepNum, kind, title, nodeId, iteration, startedAtMs, ...(detail ?? {}) }
    emitRunEvent('loop_step', payload)
    logLine(`\n━━━━━━ Step ${state.stepNum} · ${title} ━━━━━━`)
  }
  // Close the CURRENTLY-open step (no-op when none is open). Appended AFTER
  // the step's last persisted output line — every call site sits past the
  // step's settle `await`, and the interactive session takes its seqs from the
  // SAME allocator synchronously as it streams, so this event's seq is always
  // greater. durationMs falls back to the step's wall-clock when the executor
  // reported none.
  const emitStepEnd = (input: LoopStepEndInput): void => {
    const openStep = state.openStep
    if (!openStep) return
    if (input.status === 'failed') state.failedStepId = openStep.nodeId
    const payload: LoopStepEndEventPayload = {
      index: openStep.index,
      nodeId: openStep.nodeId,
      status: input.status,
      exitCode: input.exitCode ?? null,
      durationMs: input.durationMs ?? Math.max(0, host.now() - openStep.startMs),
      ...(input.decision ? { decision: input.decision } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.idleMs != null ? { idleMs: input.idleMs } : {}),
    }
    state.openStep = null
    emitRunEvent('loop_step_end', payload)
  }
  const logLine: LoopLogSink = (line, source = 'stdout', metadata) => {
    const attemptId = metadata?.attemptId
    const attribution = typeof attemptId === 'string' && attemptId.trim() && attemptId.length <= 256 ? { attemptId } : {}
    notePortConflict(line)
    const s = takeSeq()
    try {
      appendEvent(host.db, runId, s, { event_type: 'log', source, payload: JSON.stringify({ line, ...attribution }) })
    } catch { /* events table best-effort */ }
    host.emit({ type: 'log', source, line, timestamp: new Date(host.now()).toISOString(), processId: runId, ...attribution })
  }
  // Forward a RAW provider stdout line (claude/codex JSONL) as an `event` —
  // identical to QueueManager — so JobStatusPanel parses real activity
  // (thinking/reading/editing/tool steps) instead of staying on "Connecting…".
  // Non-JSON lines fall back to a plain log line.
  // Agent actions audit for one-shot AI steps (provider JSONL) and Core
  // agent-event tool lines. Observing only: a tap failure never reaches the run.
  const auditTap = host.options.agentAudit ? createStreamAuditTap(host.options.agentAudit, { runId, jobId: runId, role: 'loop' }) : null
  const onRawLine = (line: string): void => {
    if (!line) return
    let eventType: string | undefined
    try {
      const parsed = JSON.parse(line) as { type?: unknown; role?: unknown }
      if (typeof parsed.type === 'string') eventType = parsed.type
      else if (typeof parsed.role === 'string') eventType = parsed.role
      auditTap?.(parsed)
    } catch { /* not JSON */ }
    if (!eventType) { logLine(line); return }
    if (!AGENT_STREAM_EVENT.test(eventType)) notePortConflict(line)
    if (eventType === 'runtime-efficiency-event') {
      const validated = runtimeEfficiencyEventLine(line, runId)
      if (!validated || isRecordedRuntimeEfficiencyEvent(host.db, runId, validated)) return
      line = validated
    }
    const s = takeSeq()
    try {
      appendEvent(host.db, runId, s, { event_type: eventType, source: 'stdout', payload: line })
    } catch { /* best-effort */ }
    const recoveryStepKey = host.activeStepRecovery(runId)
    if (recoveryStepKey) {
      try {
        updateLoopStepActivityCheckpoint(
          host.db,
          runId,
          recoveryStepKey,
          undefined,
          host.now(),
        )
      } catch (err) {
        console.error(`[loop] raw activity checkpoint failed for ${runId}/${recoveryStepKey}:`, err)
      }
    }
    host.emit({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: line, seq: s, timestamp: new Date(host.now()).toISOString() })
  }
  return { takeSeq, emitRunEvent, emitStep, emitStepEnd, logLine, onRawLine, auditTap }
}
