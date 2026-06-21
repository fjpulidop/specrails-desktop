// Interactive ultracode job sessions (resident persistent-stdin transport).
//
// A standard ultracode job spawns `claude -p <prompt>` once and settles when the
// child closes. An INTERACTIVE ultracode job instead keeps ONE `claude -p
// --input-format stream-json` child resident across many user turns (the same
// transport ExploreStdinSessions uses for Explore chat): each user prompt is a
// newline-delimited stream-json message written to stdin, the agent works, and
// the turn ends on a `result` event WITHOUT killing the child. The session stays
// alive until the user finalizes (SIGTERM) — at which point QueueManager flips
// the job to a terminal status. Every turn's REAL token usage is summed into the
// job row as it completes, so the live Job Detail totals are honest (never an
// estimate) and the finalized job carries the full conversation's spend.
//
// This module owns the transport + per-turn streaming/persistence/accounting.
// QueueManager owns spawn-arg construction and the terminal settle (slot release,
// rail/ticket completion, ai_invocations) via the onSettle callback.

import type { ChildProcess } from 'node:child_process'
import { createInterface, type Interface } from 'node:readline'
import { spawnAiCli } from './util/cli-prompt'
import { frameStreamJsonUserMessage } from './explore-stdin-session'
import { finaliseInvocationResult } from './result-event'
import { appendEvent, accumulateInteractiveTurn, type DbInstance } from './db'
import { extractDisplayText } from './util/stream-display'
import type { AdapterEvent, ProviderAdapter } from './providers/types'
import type { WsMessage } from './types'

/** Running sum of every completed turn's REAL usage in one interactive job. */
export interface AccumulatedUsage {
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_create: number
  total_cost_usd: number
  num_turns: number
}

/** Reason + final accumulated state handed back to QueueManager when the session
 *  ends (user finalize, or an unexpected child crash). */
export interface SettleInfo {
  reason: 'finalized' | 'crashed'
  totals: AccumulatedUsage
  model: string | null
  sessionId: string | null
}

export interface InteractiveSpawnSpec {
  binary: string
  args: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
}

export interface InteractiveJobSessionDeps {
  jobId: string
  projectId: string
  db: DbInstance | null
  adapter: ProviderAdapter
  broadcast: (msg: WsMessage) => void
  /** Called exactly once when the session ends. QueueManager releases the active
   *  slot, stamps the terminal job status, records ai_invocations, fires the
   *  rail/ticket completion callback, and drains the queue. */
  onSettle: (info: SettleInfo) => void
  /** Injectable spawn (tests). Defaults to spawnAiCli. */
  spawn?: typeof spawnAiCli
}

function zeroUsage(): AccumulatedUsage {
  return {
    tokens_in: 0,
    tokens_out: 0,
    tokens_cache_read: 0,
    tokens_cache_create: 0,
    total_cost_usd: 0,
    num_turns: 0,
  }
}

/** SIGTERM → SIGKILL escalation window on finalize (ms). */
const FINALIZE_KILL_GRACE_MS = 2000

export class InteractiveJobSession {
  private readonly _jobId: string
  private readonly _projectId: string
  private readonly _db: DbInstance | null
  private readonly _adapter: ProviderAdapter
  private readonly _broadcast: (msg: WsMessage) => void
  private readonly _onSettle: (info: SettleInfo) => void
  private readonly _spawn: typeof spawnAiCli

  private _child: ChildProcess | null = null
  private _stdoutReader: Interface | null = null
  private _stderrReader: Interface | null = null

  private _eventSeq = 0
  private _streaming = false
  /** True between writing a turn to stdin and receiving its `result` event.
   *  Guards _onTurnResult against double-counting a duplicate `result` frame. */
  private _awaitingResult = false
  /** Monotonic id assigned to each turn written to stdin. A `result` frame is only
   *  counted when its turn-id matches the in-flight turn — so a stray/late/duplicate
   *  result for a finished turn can never be folded into the NEXT turn's totals. */
  private _turnSeq = 0
  /** The turn-id currently awaiting a `result` (== _turnSeq while streaming). */
  private _activeTurnId = 0
  /** The highest turn-id whose `result` has already been counted. A result whose
   *  turn-id is <= this has already settled and is rejected (stray/duplicate). */
  private _lastSettledTurnId = 0
  private _pending: string[] = []
  private _turnEvents: AdapterEvent[] = []

  private readonly _accum: AccumulatedUsage = zeroUsage()
  private _model: string | null = null
  private _sessionId: string | null = null

  private _finalizing = false
  private _settled = false
  private _disposed = false
  private _killTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: InteractiveJobSessionDeps) {
    this._jobId = deps.jobId
    this._projectId = deps.projectId
    this._db = deps.db
    this._adapter = deps.adapter
    this._broadcast = deps.broadcast
    this._onSettle = deps.onSettle
    this._spawn = deps.spawn ?? spawnAiCli
  }

  /** Spawn the resident child and run the first turn (the ultracode prompt). */
  start(spec: InteractiveSpawnSpec, firstPrompt: string): void {
    const child = this._spawn(spec.binary, spec.args, {
      env: spec.env ?? process.env,
      // stdin MUST be piped — it is the per-turn transport.
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spec.cwd,
    } as Parameters<typeof spawnAiCli>[2])
    this._child = child

    // Absorb spawn 'error' (e.g. ENOENT) so it does not crash the process; the
    // 'close' that follows settles the job as crashed through _handleClose.
    child.on('error', (err) => {
      console.error(`[interactive-job] spawn failed for ${this._jobId}: ${err.message}`)
    })

    if (child.stdout) {
      this._stdoutReader = createInterface({ input: child.stdout, crlfDelay: Infinity })
      this._stdoutReader.on('line', (line) => this._handleStdoutLine(line))
    }
    if (child.stderr) {
      this._stderrReader = createInterface({ input: child.stderr, crlfDelay: Infinity })
      this._stderrReader.on('line', (line) => this._handleStderrLine(line))
    }
    child.on('close', (code) => this._handleClose(code))

    this.send(firstPrompt)
  }

  /** Accept a user prompt. Written to the child now if idle, else queued and fed
   *  when the active turn's `result` fires. The prompt is only echoed to the
   *  transcript (persist + `job.turn_user`) AFTER delivery is confirmed — a queued
   *  prompt is "delivered" the moment it lands in the pending buffer (it will run),
   *  an immediate prompt only after a confirmed stdin write. Returns false if the
   *  session is gone OR the write could not be delivered (stdin destroyed/EPIPE). */
  send(text: string): boolean {
    if (this._disposed || this._finalizing || !this._child) return false
    const queued = this._streaming
    if (queued) {
      this._pending.push(text)
    } else if (!this._writeTurn(text)) {
      // The child is alive but stdin isn't writable (mid-crash/EPIPE). Do NOT echo
      // the turn as accepted — surface a delivery-failure note instead, and settle
      // the session as crashed since the transport is gone.
      const note = `⚠️ Could not deliver your message — the agent's input channel is closed.`
      this._persistLog('stderr', note)
      this._emitLog('stderr', note)
      this._settle('crashed')
      return false
    }
    // Surface the user turn in the transcript via the existing `log` channel so
    // it both renders live (the client's 'log' handler) and survives a reload
    // (persisted as a log event, picked up by GET /jobs/:id). The 🧑 prefix marks
    // it as the user's prompt amid the agent's streamed work.
    const line = `🧑 ${text}`
    this._persistLog('stdout', line)
    this._emitLog('stdout', line)
    // Control signal for the in-job chat UI (streaming-state / queued hint).
    this._broadcast({
      type: 'job.turn_user',
      projectId: this._projectId,
      jobId: this._jobId,
      text,
      queued,
      timestamp: new Date().toISOString(),
    })
    return true
  }

  isStreaming(): boolean {
    return this._streaming
  }

  getTotals(): AccumulatedUsage {
    return { ...this._accum }
  }

  /** User-initiated end: SIGTERM the child (SIGKILL after a grace window). The
   *  subsequent 'close' settles the job as 'finalized'. Idempotent. */
  finalize(): void {
    if (this._finalizing || this._settled) return
    this._finalizing = true
    const child = this._child
    if (!child || child.killed || !child.pid) {
      this._settle('finalized')
      return
    }
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    this._killTimer = setTimeout(() => {
      try { if (this._child && !this._child.killed) this._child.kill('SIGKILL') } catch { /* gone */ }
      // Hard-deadline fallback: if the child never emits 'close' (D-state /
      // uninterruptible / signal-swallowing), _handleClose never runs and the slot
      // would leak forever. Force the settle here so the queue always drains. If
      // 'close' does fire, _settle is idempotent so this is a no-op.
      this._settle('finalized')
    }, FINALIZE_KILL_GRACE_MS)
  }

  /** Teardown without settling (project removal / shutdown). */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._clearKillTimer()
    this._closeReaders()
    try { if (this._child && !this._child.killed) this._child.kill('SIGTERM') } catch { /* gone */ }
    this._child = null
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Write a single turn to the child's stdin. Returns true only on a confirmed
   *  write; false when stdin is gone/destroyed or the write throws (EPIPE) — the
   *  caller must NOT treat an unconfirmed turn as accepted. */
  private _writeTurn(text: string): boolean {
    const child = this._child
    if (!child || !child.stdin || child.stdin.destroyed) return false
    try {
      child.stdin.write(frameStreamJsonUserMessage(text))
    } catch (err) {
      console.error('[interactive-job] stdin write failed:', err)
      return false
    }
    // Tag this turn so only its OWN `result` is counted (BUG-INTJOB-03): a late or
    // duplicate result for a prior turn won't match _activeTurnId once a new turn
    // has begun, so it can never inflate the next turn's totals.
    this._turnSeq += 1
    this._activeTurnId = this._turnSeq
    this._streaming = true
    this._awaitingResult = true
    this._turnEvents = []
    return true
  }

  private _handleStdoutLine(line: string): void {
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(line) } catch { /* plain text */ }

    const adapterEv = this._adapter.parseStreamLine(line)
    if (adapterEv) this._turnEvents.push(adapterEv)

    if (parsed) {
      const eventType = (parsed.type as string) ?? 'unknown'
      this._persistEvent(eventType, line)
      this._broadcast({
        type: 'event',
        jobId: this._jobId,
        event_type: eventType,
        source: 'stdout',
        payload: line,
        timestamp: new Date().toISOString(),
        seq: this._eventSeq - 1,
      })
      if (eventType === 'result') {
        this._onTurnResult(parsed)
      }
      const displayText = extractDisplayText(parsed)
      if (displayText !== null) {
        this._persistLog('stdout', displayText)
        this._emitLog('stdout', displayText)
      }
    } else {
      this._persistLog('stdout', line)
      if (adapterEv?.kind === 'text-delta') {
        this._emitLog('stdout', adapterEv.text)
      } else {
        this._emitLog('stdout', line)
      }
    }
  }

  private _handleStderrLine(line: string): void {
    this._persistLog('stderr', line)
    this._emitLog('stderr', line)
  }

  private _onTurnResult(_parsed: Record<string, unknown>): void {
    // Count a result only for the in-flight turn, exactly once (BUG-INTJOB-03).
    // `_awaitingResult` alone is insufficient: after a turn settles, the next
    // queued prompt re-arms `_awaitingResult`, so a stray/duplicate result for the
    // PRIOR turn would be folded into the new turn's (reset) events. Tagging each
    // turn with a monotonic id and recording the last settled id closes that gap —
    // a result is rejected unless a turn is genuinely awaiting AND its id hasn't
    // already been settled.
    if (!this._awaitingResult) return
    if (this._activeTurnId <= this._lastSettledTurnId) return
    this._lastSettledTurnId = this._activeTurnId
    this._awaitingResult = false
    this._streaming = false
    const { result: normalised } = finaliseInvocationResult(this._adapter, this._turnEvents, {})
    this._accum.tokens_in += normalised.tokens_in ?? 0
    this._accum.tokens_out += normalised.tokens_out ?? 0
    this._accum.tokens_cache_read += normalised.tokens_cache_read ?? 0
    this._accum.tokens_cache_create += normalised.tokens_cache_create ?? 0
    this._accum.total_cost_usd += normalised.total_cost_usd ?? 0
    this._accum.num_turns += normalised.num_turns ?? 1
    if (!this._model && normalised.model) this._model = normalised.model
    if (normalised.session_id) this._sessionId = normalised.session_id

    if (this._db) {
      try {
        accumulateInteractiveTurn(this._db, this._jobId, {
          tokens_in: normalised.tokens_in ?? 0,
          tokens_out: normalised.tokens_out ?? 0,
          tokens_cache_read: normalised.tokens_cache_read ?? 0,
          tokens_cache_create: normalised.tokens_cache_create ?? 0,
          total_cost_usd: normalised.total_cost_usd ?? 0,
          num_turns: normalised.num_turns ?? 1,
          model: normalised.model,
          session_id: normalised.session_id,
        })
      } catch (err) {
        console.error('[interactive-job] accumulate turn failed:', err)
      }
    }

    this._broadcast({
      type: 'job.turn_done',
      projectId: this._projectId,
      jobId: this._jobId,
      totals: { ...this._accum },
      timestamp: new Date().toISOString(),
    })

    // Feed the next queued prompt (if any) now that the turn is idle. Deferred to a
    // microtask so any stray/duplicate result for THIS just-settled turn that is
    // sitting in the same synchronous stdout batch is processed (and rejected by
    // the `!_awaitingResult` / turn-id guard above) BEFORE the next turn re-arms.
    if (!this._finalizing && this._pending.length > 0) {
      queueMicrotask(() => {
        if (this._disposed || this._settled || this._finalizing || this._streaming) return
        if (this._pending.length === 0) return
        const next = this._pending.shift() as string
        if (!this._writeTurn(next)) {
          const note = `⚠️ Could not deliver a queued message — the agent's input channel is closed.`
          this._persistLog('stderr', note)
          this._emitLog('stderr', note)
          this._settle('crashed')
        }
      })
    }
  }

  private _persistEvent(eventType: string, payload: string): void {
    if (!this._db) return
    try {
      appendEvent(this._db, this._jobId, this._eventSeq++, {
        event_type: eventType,
        source: 'stdout',
        payload,
      })
    } catch (err) {
      console.error('[interactive-job] persist event failed:', err)
    }
  }

  private _persistLog(source: 'stdout' | 'stderr', line: string): void {
    if (!this._db) return
    try {
      appendEvent(this._db, this._jobId, this._eventSeq++, {
        event_type: 'log',
        source,
        payload: JSON.stringify({ line }),
      })
    } catch (err) {
      console.error('[interactive-job] persist log failed:', err)
    }
  }

  private _emitLog(source: 'stdout' | 'stderr', line: string): void {
    this._broadcast({
      type: 'log',
      source,
      line,
      timestamp: new Date().toISOString(),
      processId: this._jobId,
    })
  }

  private _handleClose(_code: number | null): void {
    if (this._disposed || this._settled) return
    this._settle(this._finalizing ? 'finalized' : 'crashed')
  }

  private _settle(reason: 'finalized' | 'crashed'): void {
    if (this._settled) return
    this._settled = true
    this._streaming = false
    this._awaitingResult = false
    this._clearKillTimer()
    this._closeReaders()
    // The child is gone — any prompts still queued (turn died without a `result`,
    // or the user finalized mid-turn) can never run. Surface them in the
    // transcript instead of dropping them silently.
    if (this._pending.length > 0) {
      const note = `⚠️ ${this._pending.length} queued prompt(s) were not sent — the session ended.`
      this._persistLog('stderr', note)
      this._emitLog('stderr', note)
      this._pending = []
    }
    this._onSettle({
      reason,
      totals: { ...this._accum },
      model: this._model,
      sessionId: this._sessionId,
    })
  }

  private _clearKillTimer(): void {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }
  }

  private _closeReaders(): void {
    try { this._stdoutReader?.close() } catch { /* best-effort */ }
    try { this._stderrReader?.close() } catch { /* best-effort */ }
    this._stdoutReader = null
    this._stderrReader = null
  }
}
