// Interactive job sessions (resident persistent-stdin transport).
//
// A standard job spawns `claude -p <prompt>` once and settles when the child
// closes. An INTERACTIVE job instead keeps ONE `claude -p --input-format
// stream-json` child resident across many user turns (the same transport
// ExploreStdinSessions uses for Explore chat): each user prompt is a
// newline-delimited stream-json message written to stdin, the agent works, and
// the turn ends on a `result` event WITHOUT killing the child. Two settle modes:
//
//   'finalize' (freestyle) — the session idles between turns until the user
//     explicitly finalizes (SIGTERM), at which point QueueManager flips the job
//     to a terminal status. Byte-identical to the original interactive-freestyle
//     behaviour.
//   'auto' (every other command — the default-interactive flip) — the session
//     settles ITSELF the moment it goes QUIESCENT: a turn `result` arrived and
//     nothing is queued behind it. A user message that lands mid-stream still
//     queues and extends the session ("ask questions / steer, but the job tends
//     to finish its plan"); an explicit finalize() still settles immediately;
//     a child that produces NO output for `zombieTimeoutMs` is treated as
//     wedged and settles 'crashed' (mirrors the one-shot zombie timeout).
//
// Every turn's REAL token usage is summed into the job row as it completes, so
// the live Job Detail totals are honest (never an estimate) and the settled job
// carries the full conversation's spend.
//
// This module owns the transport + per-turn streaming/persistence/accounting.
// QueueManager owns spawn-arg construction and the terminal settle (slot release,
// rail/ticket completion, ai_invocations) via the onSettle callback.

import type { ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createInterface, type Interface } from 'node:readline'
import { spawnAiCli } from './util/cli-prompt'
import { treeKillSafe } from './util/win-spawn'
import { frameStreamJsonUserMessage } from './explore-stdin-session'
import { finaliseInvocationResult } from './result-event'
import { appendEvent, accumulateInteractiveTurn, type DbInstance, type InteractiveTurnUsage } from './db'
import { extractDisplayText } from './util/stream-display'
import type { AdapterEvent, ProviderAdapter } from './providers/types'
import { parseStreamEvents } from './providers/runtime'
import type { WsMessage } from './types'

/** Claude's stream-json result frames do not carry a turn id. Hash a canonical
 * representation of the real frame instead: an exact/semantic retransmission
 * remains identifiable even after the next stdin turn has been armed, while a
 * genuine later result differs through its cumulative/session/result fields. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

function resultFrameSignature(frame: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(frame)).digest('hex')
}

/** Running sum of every completed turn's REAL usage in one interactive job. */
export interface AccumulatedUsage {
  tokens_in: number
  tokens_out: number
  tokens_cache_read: number
  tokens_cache_create: number
  total_cost_usd: number
  num_turns: number
}

// ─── Zero-work settle detection ──────────────────────────────────────────────
// Live evidence (run 01f41203): a mistyped `/specrails:implement` made the
// claude CLI emit a SYNTHETIC terminal result frame — `{subtype:'success',
// is_error:false, num_turns:0, total_cost_usd:0, duration_api_ms:0,
// result:'Unknown command: /specrails:implement'}` — and exit cleanly. No model
// ever ran, yet the settle looked like a success and the factory loop
// "succeeded" without implementing anything. Strictness rule: a session/step
// that consumed NO model work across its WHOLE life is a FAILED settle — the
// command never actually ran. The predicate below is the ONE shared definition
// consumed by QueueManager (interactive jobs) and LoopRunManager (ai-steps).

/** Whole-life accumulated signals a settle is judged on. */
export interface ZeroWorkSignals {
  /** Accumulated `num_turns` across every counted turn (deltas of the
   *  cumulative reading — see HIGH-2 in this module). */
  numTurns: number
  /** Accumulated token counts, all four directions. */
  tokensIn: number
  tokensOut: number
  tokensCacheRead: number
  tokensCacheCreate: number
  /** True when ANY assistant-derived event (model text, tool use, or a frame
   *  carrying a usage snapshot) was observed at any point in the life. */
  sawAssistantEvent: boolean
  /** The final `result` payload text, or null when no turn completed. */
  resultText: string | null
}

/** The claude CLI's synthetic no-op marker: the result text of a frame emitted
 *  for a command the CLI could not resolve (nothing was sent to the model). */
export const UNKNOWN_COMMAND_RE = /^Unknown command:/

/** True when an adapter event indicates the model actually did work. `result`
 *  frames do NOT count (the synthetic no-op frame is itself a result), nor do
 *  session-started/error frames — only assistant-derived events do. */
export function isModelWorkEvent(ev: AdapterEvent): boolean {
  if (ev.kind === 'text-delta' || ev.kind === 'tool-use') return true
  // A claude `assistant` frame with no text/tool block still surfaces as
  // {kind:'other', type:'assistant'} (and usually carries a usage snapshot).
  if (ev.kind === 'other' && ev.type === 'assistant') return true
  if (ev.kind === 'result' || ev.kind === 'session-started' || ev.kind === 'error') return false
  // Any other event carrying a per-assistant-event usage snapshot counts.
  const usage = (ev as { usage?: unknown }).usage
  return usage != null && typeof usage === 'object'
}

/**
 * A settle is ZERO-WORK when the session/step consumed no model work across
 * its WHOLE life: accumulated `num_turns === 0` AND no assistant events AND
 * zero usage tokens — all signals, exactly what the synthetic frame carries.
 * Belt-and-braces: a final result text matching `Unknown command:` marks
 * zero-work even when the numeric accounting drifted, PROVIDED no assistant
 * event was ever seen — a multi-turn session that did real work earlier and
 * merely ended on a synthetic frame (e.g. the user sent `/help` late) is NOT
 * zero-work, because real turns always emit assistant events.
 */
export function isZeroWorkSettle(signals: ZeroWorkSignals): boolean {
  if (signals.sawAssistantEvent) return false
  if (signals.resultText !== null && UNKNOWN_COMMAND_RE.test(signals.resultText.trim())) {
    return true
  }
  return (
    signals.numTurns === 0 &&
    signals.tokensIn === 0 &&
    signals.tokensOut === 0 &&
    signals.tokensCacheRead === 0 &&
    signals.tokensCacheCreate === 0
  )
}

/** Reason + final accumulated state handed back to QueueManager when the session
 *  ends (user finalize, or an unexpected child crash). */
export interface SettleInfo {
  reason: 'finalized' | 'crashed'
  totals: AccumulatedUsage
  model: string | null
  sessionId: string | null
  /** True when any part of `totals.total_cost_usd` was priced from the rate card
   *  rather than a native `result` cost — set when an in-flight turn was folded
   *  in on a mid-turn finalize/crash (COST-ACCOUNTING-AUDIT CRIT-4). */
  estimated: boolean
  /** Sum of every turn's active wall-clock segment (write→result), NOT
   *  finished_at − started_at. Excludes idle time between turns so per-ticket
   *  "active duration" analytics don't inflate a long-open session
   *  (COST-ACCOUNTING-AUDIT LOW-15). */
  activeDurationMs: number
  /** The last turn's `result` payload string (or null when no turn completed) —
   *  the same field the one-shot path captures for output chaining between
   *  dependent pipeline steps. */
  resultText: string | null
  /** The last turn's `result` frame was flagged `is_error` by the provider
   *  (claude: a usage/rate-limit notice returned as the reply). The owner
   *  treats the step as FAILED with `resultText` as the reason. */
  resultIsError: boolean
  /** True when the WHOLE session consumed no model work (isZeroWorkSettle over
   *  the accumulated totals + assistant-event flag + final result text). A
   *  'finalized' settle that is zero-work must be treated as FAILED by the
   *  owner — the job/step's command never actually ran (the claude CLI's
   *  synthetic `Unknown command:` result frame). */
  zeroWork: boolean
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
  /** 'finalize' (default): the session idles between turns until an explicit
   *  human finalize — today's freestyle behaviour, byte-identical. 'auto': the
   *  session settles ITSELF (reason 'finalized') as soon as it is QUIESCENT —
   *  a turn `result` arrived, no queued prompts remain, and no user write is
   *  in flight. A user message that arrives mid-stream still queues and
   *  extends the session; explicit finalize() still settles immediately. */
  settleMode?: 'finalize' | 'auto'
  /** Wedge detector for 'auto' sessions only: when the child produces NO
   *  stdout/stderr output for this long, the in-flight turn is folded and the
   *  session settles 'crashed' (reuses the queue's zombie-timeout budget).
   *  Never armed in 'finalize' mode — idling awaiting the human is by design.
   *  Unset / <= 0 disables the timer. */
  zombieTimeoutMs?: number
  /** Fired synchronously when the zombie budget elapses, BEFORE the session
   *  aborts — lets the owner tell a wedge apart from any other 'crashed'
   *  settle (the loop engine retries a stalled step once by resume). */
  onZombieTimeout?: () => void
  /** Grace window for the QUIESCENT auto-settle's graceful teardown: the child
   *  gets its stdin EOF'd (the stream-json CLI exits by itself after flushing
   *  its session transcript — an immediate SIGTERM races that flush and leaves
   *  the session unresumable, so the NEXT loop step's `--resume` lands on a
   *  missing conversation and settles zero-work) and only after this window is
   *  it SIGTERM'd. Default 5000ms. */
  quiescentEofGraceMs?: number
  /** Shared event-seq allocator. A session that shares its job row with OTHER
   *  writers (the loop engine persists its own step-boundary/log events on the
   *  same job id) must draw seq numbers from the owner's monotonic counter, or
   *  the interleaved rows collide/replay out of order (getJobEvents ORDER BY
   *  seq). Unset ⇒ the session's private counter starting at 0 — byte-identical
   *  QueueManager behaviour, where the session owns the whole job's events. */
  nextEventSeq?: () => number
  /** Optional owner-provided durable turn checkpoint. LoopRunManager uses this
   * to commit the jobs accumulator and loop-step raw-event frontier in ONE
   * transaction. QueueManager omits it and retains the legacy direct update. */
  persistTurnUsage?: (
    turn: InteractiveTurnUsage,
    completedEventSeq: number,
    checkpoint?: { cost?: number; turns?: number; activeDurationMs: number },
  ) => void
  /** Loop owner hook for crash-recoverable active duration. Called before a
   * turn is delivered and again as raw activity arrives. A thrown checkpoint
   * failure fail-stops the session; it must never continue with an untracked
   * provider turn. */
  persistTurnActivity?: (turnStartedAtMs: number, activityAtMs: number) => void
  /** Injectable spawn (tests). Defaults to spawnAiCli. */
  spawn?: typeof spawnAiCli
  /** Injectable process-tree terminator (tests). Defaults to treeKillSafe. */
  killTree?: typeof treeKillSafe
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
  private readonly _settleMode: 'finalize' | 'auto'
  private readonly _zombieTimeoutMs: number
  private readonly _onZombieTimeoutHook: (() => void) | undefined
  private readonly _quiescentEofGraceMs: number
  /** Armed by the quiescent graceful teardown: SIGTERM escalation if the child
   *  ignores the stdin EOF. Cleared on close/settle/dispose. */
  private _eofTimer: ReturnType<typeof setTimeout> | null = null
  private readonly _nextEventSeq: (() => number) | null
  private readonly _persistTurnUsage: ((
    turn: InteractiveTurnUsage,
    completedEventSeq: number,
    checkpoint?: { cost?: number; turns?: number; activeDurationMs: number },
  ) => void) | null
  private readonly _persistTurnActivity: ((turnStartedAtMs: number, activityAtMs: number) => void) | null
  private readonly _spawn: typeof spawnAiCli
  private readonly _killTree: typeof treeKillSafe

  private _child: ChildProcess | null = null
  private _stdoutReader: Interface | null = null
  private _stderrReader: Interface | null = null

  private _eventSeq = 0
  private _lastPersistedEventSeq = -1
  private _streaming = false
  /** True between writing a turn to stdin and receiving its `result` event.
   *  Guards _onTurnResult against double-counting a duplicate `result` frame. */
  private _awaitingResult = false
  /** Monotonic id assigned to each delivered turn. It gates one accepted result
   * per active turn; canonical result signatures provide the cross-turn replay
   * barrier because Claude's protocol does not expose a turn id. */
  private _turnSeq = 0
  /** The turn-id currently awaiting a `result` (== _turnSeq while streaming). */
  private _activeTurnId = 0
  /** The highest turn-id whose `result` has already been counted. A result whose
   *  turn-id is <= this has already settled and is rejected (stray/duplicate). */
  private _lastSettledTurnId = 0
  private _pending: string[] = []
  private _turnEvents: AdapterEvent[] = []
  /** Accepted result-frame signatures for this resident child. The protocol has
   * no turn id, so this is the durable-in-process correlation barrier that keeps
   * a retransmitted prior result out of a newly-armed turn. */
  private readonly _acceptedResultSignatures = new Set<string>()

  private readonly _accum: AccumulatedUsage = zeroUsage()
  private _model: string | null = null
  private _sessionId: string | null = null
  /** Last completed turn's `result` payload (output chaining — see SettleInfo). */
  private _resultText: string | null = null
  private _resultIsError = false
  /** True once ANY assistant-derived event was observed across the whole
   *  session life (isModelWorkEvent). Feeds the zero-work settle predicate:
   *  real turns always emit assistant events; the synthetic `Unknown command:`
   *  frame never does. */
  private _sawModelWork = false
  /** The child's still-running backgrounded commands, mirrored from claude's
   *  `system/background_tasks_changed` roster (descriptions, else task ids).
   *  Read at quiescent auto-settle to say out loud that they are being torn
   *  down with the session (their output never reaches the agent). */
  private _liveBackgroundTasks: string[] = []

  /** Previous turn's CUMULATIVE `total_cost_usd` / `num_turns` reading. The
   *  persistent stream-json transport reports both cumulatively per turn, so we
   *  accumulate deltas against these baselines (HIGH-2). Reset to 0 when the
   *  child (re)spawns. */
  private _baselineCost = 0
  private _baselineTurns = 0
  /** Set once the in-flight (unfinished) turn has been folded into `_accum` so a
   *  finalize→_settle and a shutdown→snapshotForAbort can never fold it twice. */
  private _inflightFolded = false
  /** True when the folded in-flight turn's cost was rate-card estimated. */
  private _inflightEstimated = false
  /** Wall-clock start of the in-flight turn (write→result), or null when idle. */
  private _turnStartMs: number | null = null
  /** Running sum of active turn wall-segments (LOW-15). */
  private _activeDurationMs = 0

  private _finalizing = false
  private _settled = false
  private _disposed = false
  /** `ChildProcess.killed` only means a signal was sent. This tracks the real
   *  lifecycle event used to decide whether SIGKILL escalation is still needed. */
  private _childClosed = false
  private _stdinFailed = false
  private _terminationStarted = false
  private _terminationReason: 'finalized' | 'crashed' | null = null
  private _killTimer: ReturnType<typeof setTimeout> | null = null
  /** Auto-mode wedge detector (see InteractiveJobSessionDeps.zombieTimeoutMs). */
  private _zombieTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: InteractiveJobSessionDeps) {
    this._jobId = deps.jobId
    this._projectId = deps.projectId
    this._db = deps.db
    this._adapter = deps.adapter
    this._broadcast = deps.broadcast
    this._onSettle = deps.onSettle
    this._settleMode = deps.settleMode ?? 'finalize'
    this._zombieTimeoutMs = deps.zombieTimeoutMs ?? 0
    this._onZombieTimeoutHook = deps.onZombieTimeout
    this._quiescentEofGraceMs = deps.quiescentEofGraceMs ?? 5000
    this._nextEventSeq = deps.nextEventSeq ?? null
    this._persistTurnUsage = deps.persistTurnUsage ?? null
    this._persistTurnActivity = deps.persistTurnActivity ?? null
    this._spawn = deps.spawn ?? spawnAiCli
    this._killTree = deps.killTree ?? treeKillSafe
  }

  /** Spawn the resident child and run the first turn (the freestyle prompt). */
  start(spec: InteractiveSpawnSpec, firstPrompt: string): void {
    const child = this._spawn(spec.binary, spec.args, {
      env: spec.env ?? process.env,
      // stdin MUST be piped — it is the per-turn transport.
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: spec.cwd,
    } as Parameters<typeof spawnAiCli>[2])
    this._child = child
    this._childClosed = false
    this._stdinFailed = false
    this._terminationStarted = false
    this._terminationReason = null

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
    child.on('close', (code) => {
      this._childClosed = true
      this._clearKillTimer()
      this._clearEofTimer()
      this._handleClose(code)
    })
    // A buffered write can fail asynchronously (typically EPIPE after the child
    // exits). `try/catch` around write() cannot observe that event, and an
    // unhandled Writable 'error' terminates Node. Install this BEFORE the first
    // `send()` below so even the initial frame is protected.
    child.stdin?.on('error', (err) => {
      this._stdinFailed = true
      console.error(`[interactive-job] stdin failed for ${this._jobId}: ${err.message}`)
      if (this._disposed || this._settled) return
      this._terminateChildTree(this._finalizing ? 'finalized' : 'crashed')
    })

    // Auto-mode wedge detector: reset on ANY raw output ('data' — synchronous
    // under fake timers, mirroring the one-shot path's zombie timer) and fire
    // when the child stays silent for the whole budget. Finalize mode never
    // arms a timer (idling awaiting the human is by design).
    if (this._settleMode === 'auto' && this._zombieTimeoutMs > 0) {
      child.stdout?.on('data', () => this._resetZombieTimer())
      child.stderr?.on('data', () => this._resetZombieTimer())
      this._resetZombieTimer()
    }

    // Fresh child ⇒ fresh cumulative baselines (HIGH-2). Field initializers
    // already zero these, but reset explicitly so a future respawn is safe.
    this._baselineCost = 0
    this._baselineTurns = 0
    this._inflightFolded = false

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
      this._terminateChildTree('crashed')
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

  /** The session's settle mode ('finalize' = idles awaiting an explicit human
   *  finalize; 'auto' = settles itself on quiescence). Surfaced on GET /jobs/:id
   *  so the client can phrase the composer truthfully (Finalize vs wrap-up). */
  getSettleMode(): 'finalize' | 'auto' {
    return this._settleMode
  }

  getTotals(): AccumulatedUsage {
    return { ...this._accum }
  }

  /** User-initiated end: SIGTERM the child (SIGKILL after a grace window). The
   *  subsequent 'close' settles the job as 'finalized'. Idempotent. */
  finalize(): void {
    if (this._finalizing || this._settled) return
    this._finalizing = true
    this._clearZombieTimer()
    this._terminateChildTree('finalized')
  }

  /** Quiescent auto-settle teardown, GRACEFUL: EOF the child's stdin so the
   *  stream-json CLI exits by itself — it flushes its session transcript on the
   *  way out, keeping the session `--resume`-able by the NEXT loop step. The
   *  previous immediate SIGTERM raced that flush: the next step's resume found
   *  no conversation, got an instant empty synthetic result, and settled
   *  zero-work in 0.0s. SIGTERM remains as escalation after the grace window,
   *  and as the direct fallback when stdin is already gone. */
  private _finalizeQuiescent(): void {
    if (this._finalizing || this._settled) return
    this._finalizing = true
    this._clearZombieTimer()
    const child = this._child
    const stdin = child?.stdin
    if (!child || this._childClosed || !stdin || stdin.destroyed || this._stdinFailed) {
      this._terminateChildTree('finalized')
      return
    }
    try {
      stdin.end()
    } catch {
      this._terminateChildTree('finalized')
      return
    }
    this._eofTimer = setTimeout(() => {
      this._eofTimer = null
      if (this._childClosed || this._settled || this._disposed) return
      this._terminateChildTree('finalized')
    }, this._quiescentEofGraceMs)
    this._eofTimer.unref?.()
  }

  /** Programmatic teardown that SETTLES 'crashed' after folding any in-flight
   *  turn (loop step timeout / run cancel). Unlike dispose(), the onSettle
   *  callback fires — an owner AWAITING the settle (the loop engine) is
   *  released with the partial work accounted. Unlike finalize(), the session
   *  is not counted as a clean completion. No-op when already settled/disposed
   *  or when a finalize is in flight (its own settle wins — this avoids a
   *  double-kill race between the two teardown paths). */
  abort(note?: string): void {
    if (this._settled || this._disposed || this._finalizing) return
    if (note) {
      this._persistLog('stderr', note)
      this._emitLog('stderr', note)
    }
    this._terminateChildTree('crashed')
  }

  /** Teardown without settling (project removal / shutdown). */
  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._clearZombieTimer()
    this._clearEofTimer()
    this._closeReaders()
    this._terminateChildTree(null)
    this._child = null
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  /** Write a single turn to the child's stdin. Returns true only on a confirmed
   *  write; false when stdin is gone/destroyed or the write throws (EPIPE) — the
   *  caller must NOT treat an unconfirmed turn as accepted. */
  private _writeTurn(text: string): boolean {
    const child = this._child
    if (!child || !child.stdin || child.stdin.destroyed || this._stdinFailed) return false
    const turnStartedAtMs = Date.now()
    if (this._persistTurnActivity) {
      try {
        // Commit the start BEFORE stdin delivery. If this fails, the provider
        // never receives work that startup recovery cannot time/account.
        this._persistTurnActivity(turnStartedAtMs, turnStartedAtMs)
      } catch (err) {
        this._failStopPersistence('turn-start checkpoint', err)
        return false
      }
    }
    try {
      child.stdin.write(frameStreamJsonUserMessage(text))
    } catch (err) {
      console.error('[interactive-job] stdin write failed:', err)
      return false
    }
    // Arm exactly one result for this delivered turn. Cross-turn retransmissions
    // are rejected by the canonical-signature barrier in _handleStdoutLine.
    this._turnSeq += 1
    this._activeTurnId = this._turnSeq
    this._streaming = true
    this._awaitingResult = true
    this._turnEvents = []
    // Start the active-duration segment for this turn (LOW-15).
    this._turnStartMs = turnStartedAtMs
    return true
  }

  private _handleStdoutLine(line: string): void {
    let parsed: Record<string, unknown> | null = null
    try { parsed = JSON.parse(line) } catch { /* plain text */ }

    // Keep the child's live background-task roster current so the quiescent
    // auto-settle can say out loud when the agent replied with work still running.
    this._trackBackgroundTasks(parsed)

    // parseStreamEvents is pure, so classifying the frame through the adapter
    // BEFORE the drop logic is safe — and it is the adapter that knows a claude
    // `result` frame carrying `origin.kind === 'task-notification'` is a
    // CLI-internal notification turn, not this turn's terminal result.
    const adapterEvents = parseStreamEvents(this._adapter, line)

    // A late retransmission can arrive after the next queued prompt has already
    // been written. Drop it BEFORE event persistence: adding it to the next
    // turn's event buffer corrupts live totals, while persisting it beyond the
    // prior checkpoint would make crash recovery count it again.
    if (parsed?.type === 'result') {
      // A terminal frame with no active turn is causally unassignable. Drop it
      // before persistence so raw recovery cannot count it.
      if (!this._awaitingResult) return
      if (!adapterEvents.some((ev) => ev.kind === 'result')) {
        // Notification turn (loop run 5c958db2): the CLI answered its OWN
        // orphaned-background-task notice, not the prompt we wrote — the real
        // turn is still coming. Closing the turn here auto-settled the session
        // and tore the child down mid-thought as a zero-work failure. Leave the
        // turn armed, and do not persist the frame as a `result` row either
        // (crash recovery counts persisted result rows as completed turns).
        const note = `↷ ${this._adapter.id} reported a background-task notification (not this turn's result) — continuing.`
        this._persistLog('stdout', note)
        this._emitLog('stdout', note)
        return
      }
      const signature = resultFrameSignature(parsed)
      if (this._acceptedResultSignatures.has(signature)) return
    }

    for (const adapterEvent of adapterEvents) {
      this._turnEvents.push(adapterEvent)
      if (!this._sawModelWork && isModelWorkEvent(adapterEvent)) this._sawModelWork = true
    }

    if (parsed) {
      const eventType = (parsed.type as string) ?? 'unknown'
      const { seq, persisted } = this._persistEvent(eventType, line)
      if (!persisted) return
      if (eventType !== 'result' && !this._checkpointRawActivity()) return
      this._broadcast({
        type: 'event',
        jobId: this._jobId,
        event_type: eventType,
        source: 'stdout',
        payload: line,
        timestamp: new Date().toISOString(),
        seq,
      })
      if (eventType === 'result') {
        this._onTurnResult(parsed, seq, resultFrameSignature(parsed))
      }
      const displayText = extractDisplayText(parsed)
      if (displayText !== null) {
        this._persistLog('stdout', displayText)
        this._emitLog('stdout', displayText)
      }
    } else {
      this._persistLog('stdout', line)
      const textEvent = adapterEvents.find((event) => event.kind === 'text-delta')
      if (textEvent?.kind === 'text-delta') {
        this._emitLog('stdout', textEvent.text)
      } else {
        this._emitLog('stdout', line)
      }
    }
  }

  /** Mirror claude's `system/background_tasks_changed` roster. Any other frame
   *  (or a non-claude provider, which never emits it) leaves the roster as is. */
  private _trackBackgroundTasks(parsed: Record<string, unknown> | null): void {
    if (!parsed || parsed.type !== 'system' || parsed.subtype !== 'background_tasks_changed') return
    const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
    this._liveBackgroundTasks = tasks.map((task) => {
      const t = (task ?? {}) as { description?: unknown; task_id?: unknown }
      if (typeof t.description === 'string' && t.description.trim()) return t.description.trim()
      return typeof t.task_id === 'string' && t.task_id ? t.task_id : 'task'
    })
  }

  /** Quiescence reached while the child still has background tasks running
   *  (loop run 5c958db2: a verify step backgrounded the CI chain and replied
   *  "I'll report the verdict when it lands"). The reply IS the step's end —
   *  the child is torn down and the task output never reaches the agent — so
   *  say so in the transcript instead of leaving a verdict-less step to be
   *  puzzled over. The loop templates forbid backgrounding for this reason. */
  private _noteOrphanedBackgroundTasks(): void {
    const tasks = this._liveBackgroundTasks
    if (tasks.length === 0) return
    const shown = tasks.slice(0, 3).join(', ') + (tasks.length > 3 ? `, +${tasks.length - 3} more` : '')
    const note = `⚠️ The agent ended its turn with ${tasks.length} background task(s) still running (${shown}). A step settles on the reply, so they are terminated and their output never reaches the agent — long commands must run in the foreground.`
    this._persistLog('stderr', note)
    this._emitLog('stderr', note)
  }

  private _handleStderrLine(line: string): void {
    this._persistLog('stderr', line)
    if (!this._checkpointRawActivity()) return
    this._emitLog('stderr', line)
  }

  /** Update the active wall segment on raw activity. Failure is terminal: the
   * raw event/log is already durable while the completed-event frontier remains
   * unchanged, so startup can replay the turn exactly once. */
  private _checkpointRawActivity(): boolean {
    if (!this._persistTurnActivity || this._turnStartMs === null) return true
    try {
      this._persistTurnActivity(this._turnStartMs, Date.now())
      return true
    } catch (err) {
      this._failStopPersistence('raw-activity checkpoint', err)
      return false
    }
  }

  private _failStopPersistence(context: string, err: unknown): void {
    console.error(`[interactive-job] ${context} failed; stopping session:`, err)
    if (this._disposed || this._settled) return
    // Block send()/auto-settle immediately while the child termination is in
    // flight. `_terminationReason` remains crashed even though `_finalizing`
    // also serves as the admission gate.
    this._finalizing = true
    this._terminateChildTree('crashed')
  }

  private _onTurnResult(
    parsed: Record<string, unknown>,
    resultEventSeq: number,
    resultSignature: string,
  ): void {
    // Count a result only for the in-flight turn, exactly once (BUG-INTJOB-03).
    // `_awaitingResult` alone is insufficient: after a turn settles, the next
    // queued prompt re-arms `_awaitingResult`, so a stray/duplicate result for the
    // PRIOR turn would be folded into the new turn's (reset) events. The active
    // sequence gates one result per delivery; _handleStdoutLine rejects any
    // previously accepted canonical frame before it reaches this method.
    if (!this._awaitingResult) return
    if (this._activeTurnId <= this._lastSettledTurnId) return
    this._acceptedResultSignatures.add(resultSignature)
    this._lastSettledTurnId = this._activeTurnId
    this._awaitingResult = false
    this._streaming = false
    // Close the active-duration segment for this turn (LOW-15).
    if (this._turnStartMs !== null) {
      this._activeDurationMs += Math.max(0, Date.now() - this._turnStartMs)
      this._turnStartMs = null
    }
    // Capture the turn's result text for output chaining (mirrors the one-shot
    // path's lastResultEvent.result). The LAST completed turn wins.
    if (typeof parsed.result === 'string') {
      this._resultText = parsed.result
    }
    this._resultIsError = parsed.is_error === true
    const { result: normalised } = finaliseInvocationResult(this._adapter, this._turnEvents, {})

    // COST-ACCOUNTING-AUDIT HIGH-2: this ONE resident `claude -p --input-format
    // stream-json` child reports `total_cost_usd` and `num_turns` CUMULATIVELY
    // per turn (empirically verified — turn N's result carries the running
    // SESSION total, not that turn's own spend). Summing the raw readings counts
    // turn 1 N times over an N-turn session (Σ of prefix sums). Record the DELTA
    // against the previous cumulative snapshot instead, and clamp at 0 so a
    // stray lower reading (or a mid-session counter reset) can never subtract.
    // Token fields ARE per-turn (correct) and keep summing unchanged.
    let costDelta = 0
    if (typeof normalised.total_cost_usd === 'number') {
      costDelta = Math.max(0, normalised.total_cost_usd - this._baselineCost)
      this._baselineCost = normalised.total_cost_usd
    }
    let turnsDelta = 1
    if (typeof normalised.num_turns === 'number') {
      turnsDelta = Math.max(0, normalised.num_turns - this._baselineTurns)
      this._baselineTurns = normalised.num_turns
    }

    this._accum.tokens_in += normalised.tokens_in ?? 0
    this._accum.tokens_out += normalised.tokens_out ?? 0
    this._accum.tokens_cache_read += normalised.tokens_cache_read ?? 0
    this._accum.tokens_cache_create += normalised.tokens_cache_create ?? 0
    this._accum.total_cost_usd += costDelta
    this._accum.num_turns += turnsDelta
    if (!this._model && normalised.model) this._model = normalised.model
    if (normalised.session_id) this._sessionId = normalised.session_id

    if (this._db) {
      const usage: InteractiveTurnUsage = {
          tokens_in: normalised.tokens_in ?? 0,
          tokens_out: normalised.tokens_out ?? 0,
          tokens_cache_read: normalised.tokens_cache_read ?? 0,
          tokens_cache_create: normalised.tokens_cache_create ?? 0,
          total_cost_usd: costDelta,
          num_turns: turnsDelta,
          model: normalised.model,
          session_id: normalised.session_id,
        }
      if (this._persistTurnUsage) {
        try {
          this._persistTurnUsage(usage, resultEventSeq, {
            cost: this._baselineCost,
            turns: this._baselineTurns,
            activeDurationMs: this._activeDurationMs,
          })
        } catch (err) {
          // The result row is already durable, but its frontier did not commit.
          // Stop before turn_done/next-prompt/auto-finalize; onSettle or startup
          // recovery consumes the retained turn exactly once.
          this._failStopPersistence('turn usage checkpoint', err)
          return
        }
      } else {
        try {
          accumulateInteractiveTurn(this._db, this._jobId, usage)
        } catch (err) {
          console.error('[interactive-job] accumulate turn failed:', err)
        }
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
          this._terminateChildTree('crashed')
        }
      })
    } else if (this._settleMode === 'auto' && !this._finalizing) {
      // AUTO settle-mode: the turn finished with nothing queued behind it —
      // the session is QUIESCENT, so it settles itself (reason 'finalized' →
      // QueueManager stamps 'completed'). Deferred to a microtask so anything
      // in the same synchronous stdout batch is observed first; the re-check
      // keeps the session alive when a user prompt slipped in meanwhile (a
      // queued or freshly-written turn extends the session instead).
      queueMicrotask(() => {
        if (this._disposed || this._settled || this._finalizing) return
        if (this._streaming || this._pending.length > 0) return
        this._noteOrphanedBackgroundTasks()
        this._finalizeQuiescent()
      })
    }
  }

  /** Draw the next event seq — from the shared allocator when the job row has
   *  other event writers (loop engine), else the private per-session counter. */
  private _takeSeq(): number {
    return this._nextEventSeq ? this._nextEventSeq() : this._eventSeq++
  }

  /** Persist one raw provider event. Returns the seq it was written under so
   *  the caller's WS broadcast carries the same ordinal. */
  private _persistEvent(eventType: string, payload: string): { seq: number; persisted: boolean } {
    const seq = this._takeSeq()
    if (!this._db) return { seq, persisted: true }
    try {
      appendEvent(this._db, this._jobId, seq, {
        event_type: eventType,
        source: 'stdout',
        payload,
      })
      this._lastPersistedEventSeq = Math.max(this._lastPersistedEventSeq, seq)
      return { seq, persisted: true }
    } catch (err) {
      console.error('[interactive-job] persist event failed:', err)
      // Every DB-backed session now relies on raw rows for crash recovery.
      // Continuing would let a later result/frontier certify provider work that
      // cannot be reconstructed after process death.
      this._failStopPersistence('raw event persistence', err)
      return { seq, persisted: false }
    }
  }

  private _persistLog(source: 'stdout' | 'stderr', line: string): void {
    const seq = this._takeSeq()
    if (!this._db) return
    try {
      appendEvent(this._db, this._jobId, seq, {
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

  /**
   * Fold an in-flight (unfinished) turn's streamed usage into the running totals
   * so a finalize/crash mid-turn does NOT drop the whole turn's spend
   * (COST-ACCOUNTING-AUDIT CRIT-4). The killed turn never emitted a terminal
   * `result` frame, so its `_turnEvents` carry only per-assistant-event usage;
   * finaliseInvocationResult reconstructs the tokens and prices them via the
   * rate card (estimated). Idempotent — a settle and a shutdown snapshot can each
   * request the fold but it happens at most once.
   */
  private _foldInflightTurn(): void {
    if (this._inflightFolded) return
    if (!this._awaitingResult || this._turnEvents.length === 0) return
    this._inflightFolded = true
    // Close the in-flight active-duration segment (LOW-15).
    if (this._turnStartMs !== null) {
      this._activeDurationMs += Math.max(0, Date.now() - this._turnStartMs)
      this._turnStartMs = null
    }
    const { result: partial, estimated } = finaliseInvocationResult(this._adapter, this._turnEvents, {})
    const partialCost = partial.total_cost_usd ?? 0
    this._accum.tokens_in += partial.tokens_in ?? 0
    this._accum.tokens_out += partial.tokens_out ?? 0
    this._accum.tokens_cache_read += partial.tokens_cache_read ?? 0
    this._accum.tokens_cache_create += partial.tokens_cache_create ?? 0
    this._accum.total_cost_usd += partialCost
    // The killed turn is one turn of real work even though no `result` counted it.
    this._accum.num_turns += partial.num_turns ?? 1
    if (partialCost > 0 && estimated) this._inflightEstimated = true
    if (!this._model && partial.model) this._model = partial.model
    if (partial.session_id) this._sessionId = partial.session_id
    if (this._db) {
      try {
        const usage: InteractiveTurnUsage = {
          tokens_in: partial.tokens_in ?? 0,
          tokens_out: partial.tokens_out ?? 0,
          tokens_cache_read: partial.tokens_cache_read ?? 0,
          tokens_cache_create: partial.tokens_cache_create ?? 0,
          total_cost_usd: partialCost,
          num_turns: partial.num_turns ?? 1,
          model: partial.model,
          session_id: partial.session_id,
          // Mark the jobs row estimated when this folded turn was priced from the
          // rate card (no terminal `result` frame) — keeps Job Detail honest.
          estimated: partialCost > 0 && estimated,
        }
        if (this._persistTurnUsage) {
          this._persistTurnUsage(usage, this._lastPersistedEventSeq, {
            activeDurationMs: this._activeDurationMs,
          })
        }
        else accumulateInteractiveTurn(this._db, this._jobId, usage)
      } catch (err) {
        console.error('[interactive-job] fold in-flight turn failed:', err)
      }
    }
  }

  /**
   * Fold any in-flight turn and return the accumulated totals for an aborted
   * teardown row (shutdown / project removal). Does NOT settle or kill the child
   * — the caller writes the ai_invocations row from this snapshot and then calls
   * dispose(). (COST-ACCOUNTING-AUDIT HIGH-1 / CRIT-3.)
   */
  snapshotForAbort(): { totals: AccumulatedUsage; model: string | null; sessionId: string | null; estimated: boolean; activeDurationMs: number } {
    this._foldInflightTurn()
    return {
      totals: { ...this._accum },
      model: this._model,
      sessionId: this._sessionId,
      estimated: this._inflightEstimated,
      activeDurationMs: this._activeDurationMs,
    }
  }

  private _handleClose(_code: number | null): void {
    if (this._disposed || this._settled) return
    this._settle(this._terminationReason ?? (this._finalizing ? 'finalized' : 'crashed'))
  }

  // ─── Auto-mode wedge detector ────────────────────────────────────────────────

  private _resetZombieTimer(): void {
    if (this._zombieTimeoutMs <= 0) return
    if (this._settled || this._disposed || this._finalizing) return
    if (this._zombieTimer !== null) clearTimeout(this._zombieTimer)
    this._zombieTimer = setTimeout(() => {
      this._zombieTimer = null
      this._onZombieTimeout()
    }, this._zombieTimeoutMs)
  }

  private _clearZombieTimer(): void {
    if (this._zombieTimer !== null) {
      clearTimeout(this._zombieTimer)
      this._zombieTimer = null
    }
  }

  /** The child produced NO output for the whole zombie budget — treat it as
   *  wedged: surface a note, SIGTERM the child (best-effort SIGKILL escalation),
   *  fold the in-flight turn and settle 'crashed' (via abort). The later 'close'
   *  is a no-op (settle is idempotent). */
  private _onZombieTimeout(): void {
    if (this._settled || this._disposed || this._finalizing) return
    const timeoutSec = Math.round(this._zombieTimeoutMs / 1000)
    const note = `[zombie-detection] Interactive job ${this._jobId} produced no output for ${timeoutSec}s — auto-terminating`
    console.error(note)
    try { this._onZombieTimeoutHook?.() } catch { /* owner hook must never block teardown */ }
    this.abort(note)
  }

  private _settle(reason: 'finalized' | 'crashed'): void {
    if (this._settled) return
    this._settled = true
    // Fold any unfinished turn BEFORE snapshotting totals so a mid-turn
    // finalize/crash keeps that turn's spend (CRIT-4).
    this._foldInflightTurn()
    this._streaming = false
    this._awaitingResult = false
    this._clearKillTimer()
    this._clearEofTimer()
    this._clearZombieTimer()
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
    // Zero-work strictness: judge the WHOLE session's accumulated signals (a
    // multi-turn session where only the LAST turn was synthetic did real work
    // and is NOT zero-work). Owners flip a zero-work 'finalized' settle to a
    // FAILED terminal status; surface WHY here as a visible stderr-style line
    // (the synthetic frame's result text never reaches the log otherwise —
    // extractDisplayText drops `result` frames).
    const zeroWork = isZeroWorkSettle({
      numTurns: this._accum.num_turns,
      tokensIn: this._accum.tokens_in,
      tokensOut: this._accum.tokens_out,
      tokensCacheRead: this._accum.tokens_cache_read,
      tokensCacheCreate: this._accum.tokens_cache_create,
      sawAssistantEvent: this._sawModelWork,
      resultText: this._resultText,
    })
    if (zeroWork && reason === 'finalized') {
      const note = `✖ Zero work performed — the command never ran${this._resultText ? `: ${this._resultText}` : ''}`
      this._persistLog('stderr', note)
      this._emitLog('stderr', note)
    }
    this._onSettle({
      reason,
      totals: { ...this._accum },
      model: this._model,
      sessionId: this._sessionId,
      estimated: this._inflightEstimated,
      activeDurationMs: this._activeDurationMs,
      resultText: this._resultText,
      resultIsError: this._resultIsError,
      zeroWork,
    })
  }

  /**
   * Shared teardown for finalize / abort / dispose. Signal the WHOLE process
   * tree, then escalate only when the child has not emitted a real `close`.
   * `ChildProcess.killed` is deliberately ignored: Node flips it as soon as a
   * signal is sent, even when the process survives that signal.
   *
   * Finalize/abort settle on close. A child that never closes is force-settled
   * only after SIGKILL has actually been requested, preserving queue liveness
   * without releasing the slot after a mere SIGTERM attempt. Dispose never
   * settles because its owner already flushed/reconciles the job separately.
   */
  private _terminateChildTree(reason: 'finalized' | 'crashed' | null): void {
    if (reason !== null && this._terminationReason === null) this._terminationReason = reason
    const child = this._child
    if (!child || this._childClosed || !child.pid) {
      if (reason !== null && !this._disposed) this._settle(reason)
      return
    }
    if (this._terminationStarted) return
    this._terminationStarted = true

    const pid = child.pid
    // Arm before SIGTERM: an injected/synchronous terminator may cause `close`
    // immediately, and that close must be able to cancel the escalation.
    this._killTimer = setTimeout(() => {
      this._killTimer = null
      if (this._childClosed) return
      try {
        this._killTree(pid, 'SIGKILL', (err) => {
          if (err) console.error(`[interactive-job] SIGKILL failed for ${this._jobId}: ${err.message}`)
        })
      } catch (err) {
        console.error(`[interactive-job] SIGKILL failed for ${this._jobId}: ${(err as Error).message}`)
      }
      // Hard deadline: the OS may never deliver `close` for an uninterruptible
      // child. The tree has now received SIGKILL, so release an awaiting owner.
      if (reason !== null && !this._disposed) this._settle(reason)
    }, FINALIZE_KILL_GRACE_MS)
    this._killTimer.unref?.()

    try {
      this._killTree(pid, 'SIGTERM', (err) => {
        if (err) console.error(`[interactive-job] SIGTERM failed for ${this._jobId}: ${err.message}`)
      })
    } catch (err) {
      console.error(`[interactive-job] SIGTERM failed for ${this._jobId}: ${(err as Error).message}`)
    }
  }

  private _clearKillTimer(): void {
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }
  }

  private _clearEofTimer(): void {
    if (this._eofTimer !== null) {
      clearTimeout(this._eofTimer)
      this._eofTimer = null
    }
  }

  private _closeReaders(): void {
    try { this._stdoutReader?.close() } catch { /* best-effort */ }
    try { this._stderrReader?.close() } catch { /* best-effort */ }
    this._stdoutReader = null
    this._stderrReader = null
  }
}
