/**
 * LoopRunManager — the app-driven engine that executes a published loop graph.
 *
 * The APP owns the iteration loop: it traverses the graph node-by-node,
 * increments the iteration counter at each Loop Decider, and enforces
 * maxIterations + timeout. The stop/continue verdict is produced by the Decider
 * NODE (an AI invocation), never by app heuristics. AI Step / Shell / Decider
 * execution is delegated to injected `executors` so the traversal, counting,
 * persistence, and event logic are unit-testable WITHOUT spawning real
 * processes; the production executors wire `runAiCliInvocation` + a shell spawn.
 *
 * Spec: openspec/changes/loop-builder/specs/loop-execution/spec.md
 */
import type { ChildProcess } from 'node:child_process'
import treeKill from 'tree-kill'
import { createJob, appendEvent, markJobInteractive, accumulateInteractiveTurn, type DbInstance, type InteractiveTurnUsage } from './db'
import {
  InteractiveJobSession,
  isZeroWorkSettle,
  type InteractiveJobSessionDeps,
  type InteractiveSpawnSpec,
} from './interactive-job-session'
import type { WsMessage, JobStatus } from './types'
import type { AdapterEvent, ProviderAdapter, ReasoningEffort } from './providers/types'
import {
  type LoopGraph,
  type LoopSpec,
  nodesById,
  findStartNode,
  successors,
  interpolateSpec,
} from './loop-graph'
import { expandCommands } from './loop-command-catalog'
import { BUILTIN_CONSTANTS, resolveConstants } from './loop-constants'
import { buildDeciderSystemPrompt, buildDeciderUserPrompt, type DeciderDecision } from './loop-decider'
import {
  createLoopRun,
  updateLoopRunCounters,
  finishLoopRunAndJob,
  pauseLoopRun,
  resumeLoopRun,
  readLoopJobUsage,
  stageLoopStepRecovery,
  setLoopStepSettledResult,
  updateLoopStepEventCheckpoint,
  updateLoopStepActivityCheckpoint,
  completeLoopStepRecovery,
  listLoopStepRecoveries,
  getLoopRun,
  type LoopStepRecoveryPayload,
  type LoopRunOutcome,
} from './loop-runs-store'
import { recordInvocation } from './ai-invocations'
import { newId } from './ids'
import { getAdapter, requireToolPolicy } from './providers'
import { parseStreamEvents } from './providers/runtime'
import { finaliseInvocationResult } from './result-event'
import { claimRailTickets, claimTicketOutcomeOwners } from './rails-store'

export interface AiStepResult {
  text: string
  sessionId?: string
  cost?: number
  /** Derived total (in+out+cache) for the in-memory running total / cost-uncertainty
   *  heuristic only. The per-direction breakdown below is what gets persisted. */
  tokens?: number
  /** Structured token breakdown — persisted to the matching ai_invocations columns
   *  so cache tokens and the in/out split are preserved (not folded into tokens_out). */
  tokensIn?: number
  tokensOut?: number
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs?: number
  /** Provider-reported API-active duration (excludes local idle time). Persisted
   *  to ai_invocations.duration_api_ms so per-ticket active-duration rollups count
   *  loop steps. */
  durationApiMs?: number
  /** Turn count for this AI step, threaded to ai_invocations.num_turns so scatter
   *  / totalTurns include loop steps (LOW-8). */
  numTurns?: number
  provider?: string
  model?: string
  estimated?: boolean
  /** True when the AI CLI hard-failed (spawn error or non-zero exit). */
  failed?: boolean
  /** The real failure reason (adapter error event, else stderr tail). */
  errorText?: string
  /** True when the step's settle consumed NO model work across its whole life
   *  (the claude CLI's synthetic `Unknown command:` result frame — see
   *  isZeroWorkSettle in interactive-job-session.ts). Set authoritatively by
   *  the interactive path; `undefined` means "not evaluated" and the engine
   *  derives it from the result's accumulated signals (one-shot path). A
   *  zero-work step is FAILED — its command never actually ran. */
  zeroWork?: boolean
}

export interface ShellResult {
  stdout: string
  stderr: string
  exitCode: number
  durationMs?: number
}

export interface DeciderRunResult extends DeciderDecision {
  cost?: number
  /** Derived total (in+out+cache) for the in-memory running total / cost-uncertainty
   *  heuristic only. The per-direction breakdown below is what gets persisted. */
  tokens?: number
  /** Structured token breakdown — persisted to the matching ai_invocations columns. */
  tokensIn?: number
  tokensOut?: number
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs?: number
  /** Provider-reported API-active duration; persisted to duration_api_ms (LOW-8). */
  durationApiMs?: number
  /** Turn count; persisted to num_turns (LOW-8). */
  numTurns?: number
  /** Provider session id; persisted to session_id (LOW-8). */
  sessionId?: string
  provider?: string
  model?: string
  estimated?: boolean
}

/** Streams a live activity line to the run's job log (AI text, tool use, shell
 *  output) so the session is inspectable in real time in JobDetail. */
export type LoopLogSink = (line: string, source?: 'stdout' | 'stderr') => void

/** Registers the spawned child so the engine can kill it on cancel/stop (a
 *  cooperative `_cancelled` flag alone can't interrupt a blocked `await`). */
export type LoopSpawnSink = (child: ChildProcess) => void

/** Input for the optional interactive-plan builder (mirrors runAiStep's spawn
 *  context — everything the one-shot path derives its cwd/env/argv from). */
export interface InteractivePlanInput {
  provider: string
  model: string
  effort?: ReasoningEffort
  cwd: string
  repoDir?: string
  /** Resume a prior step's session (mid-pass continuity — the interactive
   *  equivalent of the one-shot path's chat-resume). Absent on a fresh pass. */
  sessionId?: string
  /** Per-step wall-clock timeout (ms). Undefined ⇒ executor default (15 min). */
  aiStepTimeoutMs?: number
}

/** A resident interactive-session spawn plan for ONE ai-step (the interactive
 *  jobs default). The EXECUTORS build it (process glue: adapter, argv, env —
 *  byte-mirroring what the one-shot spawn passes); the ENGINE runs it (owns the
 *  InteractiveJobSession lifecycle: step timeout, turn routing, settle → step
 *  result). `spawn` is the tests' injection seam, exactly like the session's. */
export interface InteractiveAiStepPlan {
  adapter: ProviderAdapter
  spec: InteractiveSpawnSpec
  /** Wall-clock bound for the WHOLE step, user turns included. On expiry the
   *  session is aborted (fold in-flight turn → settle 'crashed'). */
  stepTimeoutMs: number
  /** Injectable spawn (tests). Defaults to the session's spawnAiCli. */
  spawn?: InteractiveJobSessionDeps['spawn']
  /** Injectable process-tree terminator paired with `spawn` in tests. */
  killTree?: InteractiveJobSessionDeps['killTree']
}

export interface LoopExecutors {
  runAiStep(input: {
    prompt: string
    sessionId?: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
    /** Per-step wall-clock timeout (ms). Undefined ⇒ executor default (15 min). */
    aiStepTimeoutMs?: number
  }): Promise<AiStepResult>
  /** OPTIONAL interactive upgrade for ai-steps: return a resident-session spawn
   *  plan when interactive jobs are enabled AND the provider supports persistent
   *  stdin (claude); return null/undefined (or omit the method) to run the step
   *  through the one-shot `runAiStep` — byte-identical legacy behaviour. */
  planInteractiveAiStep?(input: InteractivePlanInput): InteractiveAiStepPlan | null
  runShell(input: { command: string; cwd: string; onLine?: LoopLogSink; onSpawn?: LoopSpawnSink }): Promise<ShellResult>
  runDecider(input: {
    systemPrompt: string
    userPrompt: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
  }): Promise<DeciderRunResult>
  /** OPTIONAL: a cheap, deterministic fingerprint of the repo's working-tree
   *  state (HEAD + dirty set) used by the non-convergence guard — when this is
   *  UNCHANGED across consecutive Decider 'continue' verdicts the loop is making
   *  no progress and the engine aborts (outcome `stalled`) instead of cycling.
   *  Returns null when it can't read the tree (guard then disabled). Omit the
   *  method to disable the guard entirely (byte-identical legacy behaviour). */
  repoStateHash?(dir: string): string | null
}

export interface LoopRunRequest {
  /** Pre-allocated run id (so the caller can track/cancel before completion).
   *  Defaults to a fresh id. */
  runId?: string
  loopId: string
  loopName?: string
  graph: LoopGraph
  projectId: string
  /** Spawn cwd (workspace when the project is relocated, else the repo). */
  cwd: string
  /** The repo dir when relocated (→ SPECRAILS_REPO_DIR + claude `--add-dir`), so
   *  native core slash commands run against the real repo. Undefined = legacy. */
  repoDir?: string
  railIndex?: number | null
  ticketId?: number | null
  spec?: LoopSpec
  /** Launch-captured terminal destination. Persisted before any provider spawn
   * so a restart cannot re-read a changed feature flag. */
  ticketCompletionStatus?: 'done' | 'on_review'
  /** Isolated delivery performs commit/verification after the engine settles.
   * Until the caller confirms it, restart recovery must fail conservatively. */
  deferTerminalOutcome?: boolean
  /** name→value for `{{const:NAME}}` tokens (built-ins + custom global constants).
   *  Built-ins are always merged in by the engine, so a caller may omit this. */
  constants?: Record<string, string>
  provider: string
  model: string
  effort?: ReasoningEffort
  /** Set when this run executes in an isolated git worktree (parallel rail) — only
   *  drives a header line in the run log so the worktree/branch is visible. */
  isolation?: { branch: string; worktreePath: string }
}

const IMPLEMENT_CMD_TOKEN_RE = /\{\{\s*cmd:(?:implement|batch)\s*\}\}/
const IMPLEMENT_CMD_TEXT_RE = /(?:^|\s)(?:\/(?:specrails:|sr:)?(?:implement|batch-implement)|\$(?:implement|batch-implement))\b/
const LOOP_BLOCKED_LINE_RE = /(?:^|\n)\s*LOOP_BLOCKED:\s*(.+?)(?:\n|$)/i
const HUMAN_PROCEED_QUESTION_RE = /(?:^|\n)\s*(?:\*\*)?How would you like to proceed\??/i
const HUMAN_PROCEED_NO_WORK_RE = /\b(?:no code has changed|I haven't launched any agents|I have not launched any agents|not a fresh feature to build|would duplicate work|sync first|treat this as)\b/i

function withReviewContinuationContext(base: string, rawTemplate: string, spec?: LoopSpec): string {
  if (spec?.status !== 'on_review') return base
  if (!IMPLEMENT_CMD_TOKEN_RE.test(rawTemplate) && !IMPLEMENT_CMD_TEXT_RE.test(rawTemplate) && !IMPLEMENT_CMD_TEXT_RE.test(base)) return base
  return [
    base,
    '',
    '---',
    'Specrails rail continuation context:',
    '- This ticket is already on_review and this run is fully unattended; the user has already chosen to continue implementation work.',
    '- If the current branch has an existing open PR, or the feature appears already implemented, do NOT pause to ask whether to proceed and do NOT restart from scratch.',
    '- Treat the run as review follow-ups on the current PR/worktree: inspect the ticket description, PR context, current branch, and working diff; implement only the missing requested deltas.',
    '- If the local branch is ahead/behind its remote, do not stop for confirmation. Continue safely on the current worktree; only pull/rebase when it is clearly safe and necessary.',
    '- If truly no code change is needed, state that clearly and leave the tree unchanged; otherwise make the smallest correct change and let the following verify step prove it.',
  ].join('\n')
}

function aiStepBlockedReason(text: string): string | null {
  const explicit = LOOP_BLOCKED_LINE_RE.exec(text)
  if (explicit?.[1]?.trim()) return explicit[1].trim()
  if (HUMAN_PROCEED_QUESTION_RE.test(text) && HUMAN_PROCEED_NO_WORK_RE.test(text)) {
    return 'The AI step asked how to proceed instead of performing unattended work.'
  }
  return null
}

export interface LoopRunResult {
  runId: string
  outcome: LoopRunOutcome
  iterations: number
  totalCostUsd: number | null
}

// ── Structured run-event payloads (loop-step log explorer contract) ──────────
// These ride the run's backing job row as persisted `events` rows + `event`
// broadcasts (event_type below, payload = JSON of the interface). All additive
// to the existing stream — no DB migration; the client segments the flat log by
// them. Seq ordering guarantees: `loop_graph` precedes the first `loop_step`;
// each `loop_step_end` is appended after its step's last persisted output line
// (the interactive session shares the run's seq allocator, so its final frames
// land at lower seqs than the end event).

/** `loop_step` — appended+broadcast BEFORE each step spawns. */
export interface LoopStepEventPayload {
  /** 1-based ordinal of the step within the WHOLE run (monotonic across iterations). */
  index: number
  kind: 'ai-step' | 'shell' | 'decider'
  title: string
  /** Id of the graph node this step executes (resolves against `loop_graph`'s snapshot). */
  nodeId: string
  /** The run's current iteration (1-based) at emission. Pass 1 = 1; increments
   *  when a Decider evaluates (the Decider itself belongs to the pass it closes). */
  iteration: number
  /** ai-step only — the AUTHORED prompt (the raw `{{cmd:X}}` template string),
   *  present only when rendering changed it (a plain free-text prompt would
   *  duplicate `command`). Capped at STEP_TEMPLATE_CAP — payloads persist per
   *  event. Surfaced by the step explorer's header detail disclosure; the old
   *  `Template: …` flat-log line is no longer emitted. */
  template?: string
  /** ai-step only — the rendered prompt actually sent to the provider (magic
   *  commands expanded, spec/run/const tokens resolved; EXCLUDES the injected
   *  cross-iteration history). Capped at STEP_COMMAND_CAP with an ellipsis.
   *  Replaces the removed `Command: …` flat-log line. */
  command?: string
}

/** `loop_step_end` — appended+broadcast at each step's tail. A step torn down
 *  by manager shutdown / project removal (dispose, never settles) gets NO end
 *  event — the client reads missing-end + settled run as "interrupted". */
export interface LoopStepEndEventPayload {
  /** Matches the opening `loop_step`'s index. */
  index: number
  nodeId: string
  status: 'ok' | 'failed'
  /** Shell steps: the real exit code. ai-step/decider: null (the one-shot
   *  executor result does not expose an exit code). */
  exitCode: number | null
  durationMs: number
  /** Decider steps only — the verdict the run actually routed by. */
  decision?: 'continue' | 'stop'
}

/** `loop_graph` — emitted ONCE at run start (after the run-header log lines,
 *  before the first `loop_step`): the run's graph SNAPSHOT, verbatim, so
 *  historical replay stays faithful when the loop is later edited or deleted
 *  (loop_runs stores no graph). */
export interface LoopGraphEventPayload {
  graph: LoopGraph
  loopId: string
  /** Display name; falls back to the loop id when the request carried no name. */
  loopName: string
  provider: string
  model: string
  iterationLimit: number
}

const HISTORY_MAX_CHARS = 1500
/** Caps for the `loop_step` detail fields (`template` / `command`) — the
 *  payload persists per event, so a runaway prompt must not bloat the events
 *  table. Head-only cut with an ellipsis (unlike `truncate` there is no
 *  trailing verdict to preserve here — the opening of a prompt is the signal). */
const STEP_TEMPLATE_CAP = 1000
const STEP_COMMAND_CAP = 2000
function capText(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + '…'
}
/** Abort the run after this many CONSECUTIVE AI steps hard-fail with no output.
 *  One failure can be transient; N in a row means the provider isn't running at
 *  all (quota, auth, crash) — bail instead of grinding to the iteration cap. */
const AI_FAILFAST_THRESHOLD = 2

/** Shrink a step's output for the Decider history. Keeps BOTH ends — the opening
 *  context AND the trailing lines — because the Decider keys off a final verdict
 *  line (e.g. `VERIFICATION: PASS`) that a head-only cut would silently drop. */
export function truncate(s: string, max = 600): string {
  if (s.length <= max) return s
  const head = Math.ceil(max * 0.6)
  const tail = max - head
  return s.slice(0, head) + '\n…\n' + s.slice(s.length - tail)
}

// ── Run-scoped captured variables ({{run.<name>}}) ───────────────────────────
// A run can capture values from a step's output and reference them in LATER
// ai-step prompts and shell commands as `{{run.<name>}}`. v1 captures exactly one
// — `changeId`, the OpenSpec change id — written so the family can generalize.

const RUN_TOKEN_RE = /\{\{\s*run\.(\w+)\s*\}\}/g
/** First ACTIVE `openspec/changes/<id>` path mentioned in a step's output.
 *  Archive paths (`openspec/changes/archive/...`) are historical destinations,
 *  not runnable change ids for later `{{run.changeId}}` commands. */
const CHANGE_ID_RE = /openspec\/changes\/(?!archive(?:\/|$))([A-Za-z0-9._-]+)(?=\/|\s|$)/g

/** Replace `{{run.<name>}}` with the captured value; uncaptured → '' (never a
 *  leaked literal token). Applied AFTER `{{cmd:*}}` and `{{spec.*}}`. */
export function resolveRunVars(text: string, vars: Record<string, string>): string {
  return text.replace(RUN_TOKEN_RE, (_m, key: string) => vars[key] ?? '')
}

/** Extract the OpenSpec change id from a step's output (first match wins), or
 *  undefined when none is present. */
export function extractChangeId(text: string): string | undefined {
  CHANGE_ID_RE.lastIndex = 0
  const m = CHANGE_ID_RE.exec(text)
  return m ? m[1] : undefined
}

type PausedHumanDecision =
  | { action: 'resume'; text: string }
  | { action: 'stop' }

type LoopRecordedResult = {
  cost?: number
  tokens?: number
  tokensIn?: number
  tokensOut?: number
  tokensCacheRead?: number
  tokensCacheCreate?: number
  durationMs?: number
  durationApiMs?: number
  numTurns?: number
  sessionId?: string
  provider?: string
  model?: string
  estimated?: boolean
  failed?: boolean
}

function insertLoopInvocation(
  db: DbInstance,
  payload: LoopStepRecoveryPayload,
  result: LoopRecordedResult,
  finishedAt: string,
): void {
  const ticketIds = Array.isArray(payload.ticketIds)
    ? [...new Set(payload.ticketIds)]
    : (payload.ticketId == null ? [] : [payload.ticketId])
  const targets: Array<number | null> = ticketIds.length > 0 ? ticketIds : [null]
  const splitInt = (value: number | undefined): Array<number | undefined> => {
    if (value === undefined) return targets.map(() => undefined)
    const base = Math.floor(value / targets.length)
    const remainder = value - base * targets.length
    return targets.map((_target, index) => base + (index < remainder ? 1 : 0))
  }
  const tokensIn = splitInt(result.tokensIn)
  const tokensOut = splitInt(
    result.tokensOut ?? (
      result.tokensIn === undefined && result.tokensOut === undefined
        ? result.tokens
        : undefined
    ),
  )
  const cacheRead = splitInt(result.tokensCacheRead)
  const cacheCreate = splitInt(result.tokensCacheCreate)
  const turns = splitInt(result.numTurns)
  targets.forEach((ticketId, index) => {
    const suffix = ticketId == null || targets.length === 1 ? '' : `:t${ticketId}`
    recordInvocation(db, {
      id: `${payload.invocationId}${suffix}`,
      project_id: payload.projectId,
      provider: result.provider ?? payload.provider,
      surface: 'loop',
      surface_ref_id: `${payload.surfaceRefId}${suffix}`,
      ticket_id: ticketId,
      status: result.failed ? 'failed' : 'success',
      started_at: payload.startedAt,
      finished_at: finishedAt,
      total_cost_usd: result.cost === undefined ? undefined : result.cost / targets.length,
      total_cost_usd_estimated: result.estimated ?? false,
      tokens_in: tokensIn[index],
      tokens_out: tokensOut[index],
      tokens_cache_read: cacheRead[index],
      tokens_cache_create: cacheCreate[index],
      num_turns: turns[index],
      session_id: result.sessionId,
      duration_ms: result.durationMs === undefined ? undefined : result.durationMs / targets.length,
      duration_api_ms: result.durationApiMs === undefined ? undefined : result.durationApiMs / targets.length,
      model: result.model ?? payload.model ?? undefined,
      loop_run_id: payload.runId,
    })
  })
  const aggregate = db.prepare(`
    SELECT COALESCE(SUM(total_cost_usd), 0) AS cost,
           COALESCE(SUM(tokens_in), 0) AS tokens_in,
           COALESCE(SUM(tokens_out), 0) AS tokens_out,
           COALESCE(SUM(tokens_cache_read), 0) AS cache_read,
           COALESCE(SUM(tokens_cache_create), 0) AS cache_create,
           COALESCE(SUM(duration_ms), 0) AS duration,
           COALESCE(SUM(num_turns), 0) AS turns
      FROM ai_invocations
     WHERE surface = 'loop' AND loop_run_id = ?
  `).get(payload.runId) as {
    cost: number; tokens_in: number; tokens_out: number
    cache_read: number; cache_create: number; duration: number; turns: number
  }
  const usageTelemetryAvailable =
    getAdapter(payload.provider).capabilities.reportsUsage !== false
  db.prepare(`
    UPDATE jobs
       SET total_cost_usd = ?, tokens_in = ?, tokens_out = ?,
           tokens_cache_read = ?, tokens_cache_create = ?,
           duration_ms = ?, num_turns = ?
     WHERE id = ? AND owner = 'loop'
  `).run(
    usageTelemetryAvailable ? aggregate.cost : null,
    usageTelemetryAvailable ? aggregate.tokens_in : null,
    usageTelemetryAvailable ? aggregate.tokens_out : null,
    usageTelemetryAvailable ? aggregate.cache_read : null,
    usageTelemetryAvailable ? aggregate.cache_create : null,
    aggregate.duration,
    usageTelemetryAvailable ? aggregate.turns : null,
    payload.runId,
  )
}

/** Recover every AI/decider step that was staged before provider spawn but did
 * not atomically land its invocation. Completed interactive turns are the jobs
 * delta from the durable baseline; raw events after completedEventSeq are the
 * unfinished/failed-to-checkpoint turn. The insert and checkpoint removal share
 * one transaction, so a crash between them replays without duplication. */
function boundedInflightDurationMs(
  payload: LoopStepRecoveryPayload,
  finishedAt: string,
): number {
  const startedAt = payload.activeTurnStartedAtMs
  const lastActivityAt = payload.lastActivityAtMs
  if (!Number.isFinite(startedAt) || !Number.isFinite(lastActivityAt)) return 0
  const finishedAtMs = Date.parse(finishedAt)
  const boundedEnd = Number.isFinite(finishedAtMs)
    ? Math.min(lastActivityAt!, finishedAtMs)
    : lastActivityAt!
  return Math.max(0, boundedEnd - startedAt!)
}

export function recoverOrphanLoopStepAccounting(
  db: DbInstance,
  finishedAt = new Date().toISOString(),
  onlyRunId?: string,
): number {
  let recovered = 0
  for (const row of listLoopStepRecoveries(db).filter((candidate) => !onlyRunId || candidate.run_id === onlyRunId)) {
    let payload: LoopStepRecoveryPayload
    try {
      payload = JSON.parse(row.payload) as LoopStepRecoveryPayload
      if (!payload || payload.runId !== row.run_id || payload.stepKey !== row.step_key) continue
    } catch {
      continue
    }
    if (payload.settledResult) {
      const settled = payload.settledResult as LoopRecordedResult
      const didRecover = completeLoopStepRecovery(db, payload.runId, payload.stepKey, (stable) => {
        insertLoopInvocation(db, stable, settled, finishedAt)
        const aggregate = readLoopJobUsage(db, payload.runId)
        const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + (settled.durationMs ?? 0)
        db.prepare(`
          UPDATE loop_runs
             SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
                 iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
           WHERE id = ?
        `).run(
          aggregate.totalCostUsd,
          aggregate.tokensIn + aggregate.tokensOut,
          recoveredLoopDuration,
          stable.iterationCount ?? null,
          payload.runId,
        )
        // ai_invocations contains AI-active duration only. The backing job is
        // the whole loop and must retain shell duration already represented by
        // loopDurationBaseline across this recovery transaction.
        db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
          .run(recoveredLoopDuration, payload.runId)
      })
      if (didRecover) recovered += 1
      continue
    }
    const current = readLoopJobUsage(db, payload.runId)
    const completed = {
      tokensIn: Math.max(0, current.tokensIn - (payload.baseline?.tokensIn ?? 0)),
      tokensOut: Math.max(0, current.tokensOut - (payload.baseline?.tokensOut ?? 0)),
      tokensCacheRead: Math.max(0, current.tokensCacheRead - (payload.baseline?.tokensCacheRead ?? 0)),
      tokensCacheCreate: Math.max(0, current.tokensCacheCreate - (payload.baseline?.tokensCacheCreate ?? 0)),
      totalCostUsd: Math.max(0, current.totalCostUsd - (payload.baseline?.totalCostUsd ?? 0)),
      numTurns: Math.max(0, current.numTurns - (payload.baseline?.numTurns ?? 0)),
    }
    const rawRows = db.prepare(`
      SELECT seq, event_type, payload FROM events
       WHERE job_id = ? AND seq > ? AND source = 'stdout'
       ORDER BY seq
    `).all(payload.runId, payload.completedEventSeq ?? -1) as Array<{
      seq: number; event_type: string; payload: string
    }>
    const adapter = getAdapter(payload.provider as Parameters<typeof getAdapter>[0])
    const usageTelemetryAvailable = adapter.capabilities.reportsUsage !== false
    const events = rawRows
      .flatMap((raw) => [...parseStreamEvents(adapter, raw.payload)])
    const { result: partial, estimated } = finaliseInvocationResult(adapter, events, {
      fallbackModel: payload.model ?? undefined,
    })
    const hasResult = rawRows.some((raw) => raw.event_type === 'result')
    const partialCost = hasResult && partial.total_cost_usd != null
      ? Math.max(0, partial.total_cost_usd - (payload.providerCostBaseline ?? 0))
      : (partial.total_cost_usd ?? 0)
    const partialTurns = hasResult && partial.num_turns != null
      ? Math.max(0, partial.num_turns - (payload.providerTurnsBaseline ?? 0))
      : (partial.num_turns ?? (events.length > 0 ? 1 : 0))
    const partialUsage: InteractiveTurnUsage = {
      tokens_in: partial.tokens_in ?? 0,
      tokens_out: partial.tokens_out ?? 0,
      tokens_cache_read: partial.tokens_cache_read ?? 0,
      tokens_cache_create: partial.tokens_cache_create ?? 0,
      total_cost_usd: partialCost,
      num_turns: partialTurns,
      model: partial.model,
      session_id: partial.session_id,
      estimated: partialCost > 0 && estimated,
    }
    const partialDurationMs = hasResult
      ? (partial.duration_ms ?? 0)
      : ((partial.duration_ms ?? 0) > 0
          ? partial.duration_ms!
          : boundedInflightDurationMs(payload, finishedAt))
    // completedDurationMs contains only fully-checkpointed turns. The current
    // raw turn contributes either provider duration OR the bounded wall fallback,
    // never both.
    const recoveredDurationMs = (payload.completedDurationMs ?? 0) + partialDurationMs
    const didRecover = completeLoopStepRecovery(db, payload.runId, payload.stepKey, (stable) => {
      if (
        usageTelemetryAvailable &&
        (
          partialUsage.tokens_in || partialUsage.tokens_out ||
          partialUsage.tokens_cache_read || partialUsage.tokens_cache_create ||
          partialUsage.total_cost_usd || partialUsage.num_turns
        )
      ) {
        accumulateInteractiveTurn(db, payload.runId, partialUsage)
      }
      insertLoopInvocation(db, stable, {
        cost: usageTelemetryAvailable
          ? completed.totalCostUsd + partialUsage.total_cost_usd
          : undefined,
        tokens: usageTelemetryAvailable
          ? completed.tokensIn + completed.tokensOut + partialUsage.tokens_in + partialUsage.tokens_out
          : undefined,
        tokensIn: usageTelemetryAvailable
          ? completed.tokensIn + partialUsage.tokens_in
          : undefined,
        tokensOut: usageTelemetryAvailable
          ? completed.tokensOut + partialUsage.tokens_out
          : undefined,
        tokensCacheRead: usageTelemetryAvailable
          ? completed.tokensCacheRead + partialUsage.tokens_cache_read
          : undefined,
        tokensCacheCreate: usageTelemetryAvailable
          ? completed.tokensCacheCreate + partialUsage.tokens_cache_create
          : undefined,
        numTurns: usageTelemetryAvailable
          ? completed.numTurns + partialUsage.num_turns
          : undefined,
        durationMs: recoveredDurationMs,
        model: partial.model ?? payload.model ?? undefined,
        sessionId: partial.session_id,
        provider: payload.provider,
        estimated: partialUsage.estimated,
        failed: true,
      }, finishedAt)
      const aggregate = readLoopJobUsage(db, payload.runId)
      const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + recoveredDurationMs
      db.prepare(`
        UPDATE loop_runs
           SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
               iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
         WHERE id = ?
      `).run(
        aggregate.totalCostUsd,
        aggregate.tokensIn + aggregate.tokensOut,
        recoveredLoopDuration,
        stable.iterationCount ?? null,
        payload.runId,
      )
      db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
        .run(recoveredLoopDuration, payload.runId)
    })
    if (didRecover) recovered += 1
  }
  return recovered
}

export class LoopRunManager {
  private _disposed = false
  private readonly _cancelled = new Set<string>()
  /** The currently-spawned child per run, so cancel/stop can actually KILL a
   *  blocked spawn (the cooperative `_cancelled` flag can't interrupt an await). */
  private readonly _activeChild = new Map<string, ChildProcess>()
  /** The ACTIVE interactive step session per run (present only while an ai-step
   *  runs as a resident persistent-stdin session — between steps the entry is
   *  gone, so a mid-decider/shell turn correctly routes 409). Keyed by the run
   *  id, which IS the backing job row's id — the manager-agnostic turn routing
   *  (project-router-jobs) addresses sessions by that job id. */
  private readonly _interactiveSteps = new Map<string, InteractiveJobSession>()
  private readonly _activeStepRecovery = new Map<string, string>()
  private readonly _pausedHumanDecisions = new Map<string, {
    reason: string
    resolve: (decision: PausedHumanDecision) => void
  }>()

  constructor(
    private readonly db: DbInstance,
    private readonly broadcast: (msg: WsMessage) => void,
    private readonly executors: LoopExecutors,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** WebSocket delivery is advisory. A disconnected/misbehaving listener must
   * never change launch, accounting, traversal, or terminal outcomes. */
  private _emit(msg: WsMessage): void {
    try { this.broadcast(msg) } catch { /* persisted state remains authoritative */ }
  }

  /** Cancel an in-flight run: flag it AND kill the active spawned child so a
   *  blocked AI Step / Shell returns immediately (the engine then settles
   *  'stopped' at the next boundary). An interactive step is torn down through
   *  its session's abort() (fold in-flight turn → settle 'crashed' → the
   *  awaited step resolves) — NOT dispose(), which never settles and would
   *  leave the engine's `await` hanging forever. */
  cancel(runId: string): void {
    this._cancelled.add(runId)
    const paused = this._pausedHumanDecisions.get(runId)
    if (paused) {
      this._pausedHumanDecisions.delete(runId)
      paused.resolve({ action: 'stop' })
    }
    const session = this._interactiveSteps.get(runId)
    if (session) {
      session.abort('■ Run canceled — tearing down the interactive step session.')
    }
    const child = this._activeChild.get(runId)
    if (child?.pid) {
      try { treeKill(child.pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* already gone */ }
    }
  }

  // ─── Interactive step routing (manager-agnostic /jobs/:id/messages) ─────────

  /** True while an interactive step session is resident for this run/job id. */
  isInteractiveJob(jobId: string): boolean {
    return this._interactiveSteps.has(jobId)
  }

  /** True while the loop is paused between engine steps awaiting a human call. */
  isPaused(jobId: string): boolean {
    return this._pausedHumanDecisions.has(jobId)
  }

  pausedReason(jobId: string): string | null {
    return this._pausedHumanDecisions.get(jobId)?.reason ?? null
  }

  /** Feed one more user prompt to the ACTIVE step session owning this job row
   *  (queued behind the active turn — steering; the loop tends to continue its
   *  plan). Returns false when no interactive step is live for the id. */
  sendInteractiveTurn(jobId: string, text: string): boolean {
    const paused = this._pausedHumanDecisions.get(jobId)
    if (paused) {
      this._pausedHumanDecisions.delete(jobId)
      paused.resolve({ action: 'resume', text })
      return true
    }
    const session = this._interactiveSteps.get(jobId)
    if (!session) return false
    return session.send(text)
  }

  /** Settle-now for THIS step: SIGTERM the resident child; the session settles
   *  'finalized' and the loop advances with what the step produced. Returns
   *  false when no interactive step is live for the id. */
  finalizeInteractive(jobId: string): boolean {
    const session = this._interactiveSteps.get(jobId)
    if (!session) return false
    session.finalize()
    return true
  }

  /** Teardown for project removal / process shutdown: dispose every resident
   *  interactive step session (SIGTERM, NO settle — mirrors QueueManager's
   *  shutdown) and kill any in-flight one-shot children. Does not settle the
   *  runs — the startup orphan sweeps (jobs + loop_runs) reconcile the rows on
   *  the next boot, exactly as they do for a crash today. */
  shutdown(): void {
    if (this._disposed) return
    this._disposed = true
    for (const runId of this._activeChild.keys()) this._cancelled.add(runId)
    for (const runId of this._interactiveSteps.keys()) this._cancelled.add(runId)
    for (const [runId, session] of this._interactiveSteps) {
      try {
        const snapshot = session.snapshotForAbort()
        const stepKey = this._activeStepRecovery.get(runId)
        if (stepKey) {
          let recoveredProjectId: string | null = null
          completeLoopStepRecovery(this.db, runId, stepKey, (payload) => {
            recoveredProjectId = payload.projectId
            insertLoopInvocation(this.db, payload, {
              cost: snapshot.totals.total_cost_usd,
              tokens: snapshot.totals.tokens_in + snapshot.totals.tokens_out,
              tokensIn: snapshot.totals.tokens_in,
              tokensOut: snapshot.totals.tokens_out,
              tokensCacheRead: snapshot.totals.tokens_cache_read,
              tokensCacheCreate: snapshot.totals.tokens_cache_create,
              numTurns: snapshot.totals.num_turns,
              durationMs: snapshot.activeDurationMs,
              sessionId: snapshot.sessionId ?? undefined,
              model: snapshot.model ?? undefined,
              provider: payload.provider,
              estimated: snapshot.estimated,
              failed: true,
            }, new Date(this.now()).toISOString())
            const aggregate = readLoopJobUsage(this.db, runId)
            const recoveredLoopDuration = (payload.loopDurationBaseline ?? 0) + snapshot.activeDurationMs
            this.db.prepare(`
              UPDATE loop_runs
                 SET total_cost_usd = ?, total_tokens = ?, total_duration_ms = ?,
                     iteration_count = MAX(iteration_count, COALESCE(?, iteration_count))
               WHERE id = ?
            `).run(
              aggregate.totalCostUsd,
              aggregate.tokensIn + aggregate.tokensOut,
              recoveredLoopDuration,
              payload.iterationCount ?? null,
              runId,
            )
            this.db.prepare(`UPDATE jobs SET duration_ms = ? WHERE id = ? AND owner = 'loop'`)
              .run(recoveredLoopDuration, runId)
          })
          this._activeStepRecovery.delete(runId)
          if (recoveredProjectId) {
            this._emit({ type: 'spending.invalidated', projectId: recoveredProjectId })
          }
        }
      } catch (err) {
        // Leave the durable step checkpoint for startup raw-event recovery.
        console.error(`[loop] shutdown accounting checkpoint failed for ${runId}:`, err)
      }
      try { session.dispose() } catch { /* ignore */ }
    }
    this._interactiveSteps.clear()
    for (const child of this._activeChild.values()) {
      if (child?.pid) {
        try { treeKill(child.pid, 'SIGKILL', () => { /* best-effort */ }) } catch { /* gone */ }
      }
    }
    this._activeChild.clear()
    for (const [runId, paused] of this._pausedHumanDecisions.entries()) {
      this._cancelled.add(runId)
      try { paused.resolve({ action: 'stop' }) } catch { /* ignore */ }
    }
    this._pausedHumanDecisions.clear()
  }

  async run(req: LoopRunRequest): Promise<LoopRunResult> {
    if (this._disposed) throw new Error('LoopRunManager is shut down')
    const adapter = getAdapter(req.provider)
    // A Decider is a structured, read-only judgment over repository state.
    // Prompt wording is not a permission boundary: reject before allocating or
    // persisting the run when the CLI cannot enforce read-only natively.
    if (req.graph.nodes.some((node) => node.type === 'decider')) {
      requireToolPolicy(adapter, 'read-only')
    }
    const usageTelemetryAvailable = adapter.capabilities.reportsUsage !== false
    const neverAfterDispose = (): Promise<LoopRunResult> => new Promise(() => { /* startup recovery owns settlement */ })
    const runId = req.runId ?? newId()
    const maxIterations = req.graph.config.maxIterations
    const timeoutMs = req.graph.config.timeoutMinutes * 60_000
    const deadline = this.now() + timeoutMs
    // Per-step AI timeout (ms) — undefined falls back to the executor default.
    const aiStepTimeoutMs = req.graph.config.aiStepTimeoutMinutes != null
      ? req.graph.config.aiStepTimeoutMinutes * 60_000
      : undefined
    // Optional cost cap (USD). Like maxIterations/timeout, it's a BETWEEN-STEPS
    // guard: per-step cost is only known when that step's process exits, so the
    // loop is stopped before the NEXT step once the accumulated total crosses the
    // cap (may overshoot by at most one step). Honest accuracy caveat: for
    // non-Claude providers the per-step cost is ESTIMATED (rate card) — see the
    // fail-open warning below when a step yields no priced cost.
    const configuredMaxCostUsd = typeof req.graph.config.maxCostUsd === 'number' && req.graph.config.maxCostUsd > 0
      ? req.graph.config.maxCostUsd
      : undefined
    // A cap with no observable usage is not a guard at all. Disable it rather
    // than pretending an unknown bill is $0 and surface the limitation in the
    // run log below.
    const maxCostUsd = usageTelemetryAvailable ? configuredMaxCostUsd : undefined

    const launchStartedAt = new Date(this.now()).toISOString()
    const jobCommand = `loop: ${req.loopName ?? req.loopId}${req.ticketId != null ? ` #${req.ticketId}` : ''}`
    const exactTicketIds = req.spec?.ticketIds ?? (req.ticketId == null ? [] : [req.ticketId])
    const persistLaunch = this.db.transaction(() => {
      claimTicketOutcomeOwners(this.db, exactTicketIds, runId)
      if (req.railIndex != null && exactTicketIds.length > 0) {
        claimRailTickets(this.db, req.railIndex, exactTicketIds, runId)
      }
      createLoopRun(this.db, {
        id: runId,
        projectId: req.projectId,
        loopId: req.loopId,
        loopName: req.loopName ?? null,
        railIndex: req.railIndex ?? null,
        ticketId: req.ticketId ?? null,
        provider: req.provider,
        model: req.model,
        reasoningEffort: req.effort ?? null,
        ticketIds: exactTicketIds,
        ticketCompletionStatus: req.ticketCompletionStatus ?? 'done',
        causalOwnership: true,
        iterationLimit: maxIterations,
        startedAt: launchStartedAt,
      })
      createJob(this.db, {
        id: runId,
        command: jobCommand,
        started_at: launchStartedAt,
        provider: req.provider,
        owner: 'loop',
        causal_ownership: true,
      })
    })
    persistLaunch()
    this._emit({
      type: 'loop.run_started',
      projectId: req.projectId,
      loopRunId: runId,
      loopId: req.loopId,
      railIndex: req.railIndex ?? null,
    })

    // Surface the run as a JOB so the full session streams live in the Jobs list
    // + JobDetail. Both identities committed together above, before any spawn.
    let seq = 0
    // Monotonic event-seq allocator for THIS run's job row. Shared with an
    // interactive step session (which persists its own provider events/logs on
    // the same job id) so replay ordering (getJobEvents ORDER BY seq) stays
    // correct — two independent counters would collide/interleave wrongly.
    const takeSeq = (): number => seq++
    let stepNum = 0
    // The last emitted step still awaiting its `loop_step_end` (cleared by
    // emitStepEnd). The settle path closes a step left open by a traversal
    // exception as 'failed', so the persisted stream only ever lacks an end
    // event when the manager was disposed mid-flight (shutdown / project
    // removal — the client reads that as "interrupted").
    let openStep: { index: number; nodeId: string; startMs: number } | null = null
    // Persist + broadcast ONE structured JSON event on the run's job row (the
    // same wire shape the raw-provider forwarder uses).
    const emitRunEvent = (eventType: string, payload: unknown): void => {
      const s = takeSeq()
      const json = JSON.stringify(payload)
      try {
        appendEvent(this.db, runId, s, { event_type: eventType, source: 'stdout', payload: json })
      } catch { /* best-effort */ }
      this._emit({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: json, seq: s, timestamp: new Date(this.now()).toISOString() })
    }
    // Emit a structured step-boundary event (for a segmented/collapsible client
    // view) AND a visual divider line in the flat log, so each loop step is a
    // clearly-delimited section. `iteration` is the 1-based pass number at
    // emission (see LoopStepEventPayload).
    const emitStep = (
      kind: LoopStepEventPayload['kind'],
      title: string,
      nodeId: string,
      iteration: number,
      detail?: Pick<LoopStepEventPayload, 'template' | 'command'>,
    ): void => {
      stepNum += 1
      openStep = { index: stepNum, nodeId, startMs: this.now() }
      const payload: LoopStepEventPayload = { index: stepNum, kind, title, nodeId, iteration, ...(detail ?? {}) }
      emitRunEvent('loop_step', payload)
      logLine(`\n━━━━━━ Step ${stepNum} · ${title} ━━━━━━`)
    }
    // Close the CURRENTLY-open step (no-op when none is open). Appended AFTER
    // the step's last persisted output line — every call site sits past the
    // step's settle `await`, and the interactive session takes its seqs from the
    // SAME allocator synchronously as it streams, so this event's seq is always
    // greater. durationMs falls back to the step's wall-clock when the executor
    // reported none.
    const emitStepEnd = (input: { status: 'ok' | 'failed'; exitCode?: number | null; durationMs?: number; decision?: 'continue' | 'stop' }): void => {
      if (!openStep) return
      const payload: LoopStepEndEventPayload = {
        index: openStep.index,
        nodeId: openStep.nodeId,
        status: input.status,
        exitCode: input.exitCode ?? null,
        durationMs: input.durationMs ?? Math.max(0, this.now() - openStep.startMs),
        ...(input.decision ? { decision: input.decision } : {}),
      }
      openStep = null
      emitRunEvent('loop_step_end', payload)
    }
    const logLine = (line: string, source: 'stdout' | 'stderr' = 'stdout'): void => {
      const s = takeSeq()
      try {
        appendEvent(this.db, runId, s, { event_type: 'log', source, payload: JSON.stringify({ line }) })
      } catch { /* events table best-effort */ }
      this._emit({ type: 'log', source, line, timestamp: new Date(this.now()).toISOString(), processId: runId })
    }
    // Forward a RAW provider stdout line (claude/codex JSONL) as an `event` —
    // identical to QueueManager — so JobStatusPanel parses real activity
    // (thinking/reading/editing/tool steps) instead of staying on "Connecting…".
    // Non-JSON lines fall back to a plain log line.
    const onRawLine = (line: string): void => {
      if (!line) return
      let eventType: string | undefined
      try {
        const parsed = JSON.parse(line) as { type?: unknown; role?: unknown }
        if (typeof parsed.type === 'string') eventType = parsed.type
        else if (typeof parsed.role === 'string') eventType = parsed.role
      } catch { /* not JSON */ }
      if (!eventType) { logLine(line); return }
      const s = takeSeq()
      try {
        appendEvent(this.db, runId, s, { event_type: eventType, source: 'stdout', payload: line })
      } catch { /* best-effort */ }
      const recoveryStepKey = this._activeStepRecovery.get(runId)
      if (recoveryStepKey) {
        try {
          updateLoopStepActivityCheckpoint(
            this.db,
            runId,
            recoveryStepKey,
            undefined,
            this.now(),
          )
        } catch (err) {
          console.error(`[loop] raw activity checkpoint failed for ${runId}/${recoveryStepKey}:`, err)
        }
      }
      this._emit({ type: 'event', jobId: runId, event_type: eventType, source: 'stdout', payload: line, seq: s, timestamp: new Date(this.now()).toISOString() })
    }
    logLine(`▶ Loop "${req.loopName ?? req.loopId}" started${req.spec?.title ? ` — spec: ${req.spec.title}` : ''}`)
    if (req.isolation) logLine(`⎇ Isolated worktree: ${req.isolation.worktreePath} (branch ${req.isolation.branch})`)
    if (!usageTelemetryAvailable) {
      logLine(
        `⚠️ ${adapter.displayName} does not report token/cost usage in headless mode; usage totals will remain unavailable.` +
          (configuredMaxCostUsd !== undefined
            ? ' The configured maxCostUsd guard is disabled because it cannot be verified.'
            : ''),
        'stderr',
      )
    }
    // Per-run graph SNAPSHOT — once, before the first loop_step — so a later
    // edit/delete of the loop never breaks the historical replay of this run.
    const graphPayload: LoopGraphEventPayload = {
      graph: req.graph,
      loopId: req.loopId,
      loopName: req.loopName ?? req.loopId,
      provider: req.provider,
      model: req.model,
      iterationLimit: maxIterations,
    }
    emitRunEvent('loop_graph', graphPayload)
    console.log(`[loop] start run=${runId} loop=${req.loopId} provider=${req.provider} model=${req.model} nodes=${req.graph.nodes.length} cwd=${req.cwd}`)

    const byId = nodesById(req.graph)
    const start = findStartNode(req.graph)

    let outcome: LoopRunOutcome = 'failed'
    let iteration = 0
    let totalCost = 0
    let totalTokens = 0
    let totalDuration = 0
    let finalJobUsage: {
      tokensIn: number | null
      tokensOut: number | null
      tokensCacheRead: number | null
      tokensCacheCreate: number | null
      numTurns: number | null
    } = {
      tokensIn: usageTelemetryAvailable ? 0 : null,
      tokensOut: usageTelemetryAvailable ? 0 : null,
      tokensCacheRead: usageTelemetryAvailable ? 0 : null,
      tokensCacheCreate: usageTelemetryAvailable ? 0 : null,
      numTurns: usageTelemetryAvailable ? 0 : null,
    }
    let aiSessionId: string | undefined
    // Consecutive AI steps that hard-failed with no output (provider down /
    // out of quota / crashing). Reset on any step that runs or produces output.
    let consecutiveAiFailures = 0
    // Non-convergence guard: the working-tree fingerprint at the last Decider
    // verdict, and how many consecutive 'continue' verdicts have left it
    // UNCHANGED. Two zero-change iterations in a row ⇒ the loop is spinning
    // without progress (verify→fix→verify producing an identical tree) → abort
    // `stalled` instead of burning iterations/cost. Disabled when the executor
    // provides no `repoStateHash` or it can't read the tree.
    let lastRepoHash: string | null = null
    let consecutiveNoProgress = 0
    const NO_PROGRESS_LIMIT = 2
    // True for the step that runs immediately after a Decider 'continue' — that
    // step must see the cross-iteration history (the verdict it acts on). Mid-body
    // RESUMED steps already carry prior context in their session, so re-appending
    // the history there is redundant tokens; this flag keeps it off for them.
    let justContinued = false
    // Fail-open honesty: flips true the first time a cost-bearing step yields no
    // priced cost while a cap is set (non-Claude estimate / unknown model / a
    // failed step) → the cap can under-count, so we warn once in the run log.
    let costUnknownWarned = false
    // Honest total: flips true whenever a cost-bearing step ends without a priced
    // figure — most commonly a claude AI step killed by AI_STEP_TIMEOUT_MS, which
    // never emits its terminal `result` event, so its tokens AND cost are lost
    // (claude cost is all-or-nothing — no rate-card fallback for native-cost
    // providers). When set, the displayed loop total is a LOWER BOUND (`≥`), not
    // an exact figure — so an expensive step that billed $0 isn't read as cheap.
    let costUncertain = false
    // Built-ins always resolve even if the caller omitted `constants`; custom
    // values layer on top. Used to expand `{{const:*}}` in every node's text.
    const constMap = { ...BUILTIN_CONSTANTS, ...(req.constants ?? {}) }
    const history: string[] = []
    // Run-scoped captured variables ({{run.<name>}}). Populated as steps run
    // (e.g. `changeId` from the first opsx:ff step's output) and resolved in later
    // ai-step prompts and shell commands. Empty until something is captured.
    const runVars: Record<string, string> = {}
    // Backstop against a cycle with no Decider (would otherwise never increment
    // `iteration`): cap total node executions well above any honest run.
    const stepCap = (maxIterations + 1) * (req.graph.nodes.length + 2) + 16
    let steps = 0

    const record = (
      refSuffix: string,
      r: LoopRecordedResult,
      // The REAL turn-start instant, captured before the step/decider await. The
      // row is bucketed/ordered by started_at, so it must be the start, not finish.
      startedAt: string,
      stepKey?: string,
    ) => {
      if (usageTelemetryAvailable) totalCost += r.cost ?? 0
      // A cost-bearing step that produced work (tokens) or hard-failed but reports
      // no priced cost → its real spend is missing from the total. The common case
      // is a claude step killed by timeout before its terminal `result` event:
      // tokens streamed, but cost (and tokens) are dropped, so the step bills $0.
      // Flag the run total as a lower bound and say so, per occurrence.
      const costBearingButUnpriced =
        usageTelemetryAvailable
        && r.cost == null
        && (r.failed === true || (r.tokens ?? 0) > 0)
      if (costBearingButUnpriced) {
        costUncertain = true
        costUnknownWarned = true // this line already carries the cap caveat below
        logLine(
          `⚠️ Step cost unknown — the process ended before billing (timeout/crash), so it counts as $0. The loop total is a lower bound.${maxCostUsd !== undefined ? ' The cost cap may under-count.' : ''}`,
          'stderr',
        )
      }
      // Honest cost-cap caveat: a cost-bearing step that reports no figure means
      // the cap can't be enforced precisely from here on. Warn once (live).
      if (
        usageTelemetryAvailable
        && maxCostUsd !== undefined
        && r.cost == null
        && !costUnknownWarned
      ) {
        costUnknownWarned = true
        logLine('⚠️ A step reported no priced cost (non-Claude estimate / unknown model / failed step) — the cost cap may under-count.', 'stderr')
      }
      if (usageTelemetryAvailable) {
        totalTokens += r.tokens ?? ((r.tokensIn ?? 0) + (r.tokensOut ?? 0))
      }
      totalDuration += r.durationMs ?? 0
      const finishedAt = new Date(this.now()).toISOString()
      if (stepKey) {
        setLoopStepSettledResult(this.db, runId, stepKey, r)
        const completed = completeLoopStepRecovery(this.db, runId, stepKey, (payload) => {
          insertLoopInvocation(this.db, payload, r, finishedAt)
          updateLoopRunCounters(this.db, runId, {
            iterationCount: iteration,
            totalCostUsd: totalCost,
            totalTokens,
            totalDurationMs: totalDuration,
          })
        })
        if (!completed) throw new Error(`Missing loop step checkpoint ${runId}/${stepKey}`)
      } else {
        // Compatibility for synthetic/test call paths that predate staged steps.
        recordInvocation(this.db, {
          id: newId(), project_id: req.projectId,
          provider: r.provider ?? req.provider, surface: 'loop',
          surface_ref_id: refSuffix, ticket_id: req.ticketId ?? null,
          status: r.failed ? 'failed' : 'success', started_at: startedAt,
          finished_at: finishedAt, total_cost_usd: r.cost,
          total_cost_usd_estimated: r.estimated ?? false,
          tokens_in: r.tokensIn,
          tokens_out: r.tokensOut ?? (
            r.tokensIn === undefined && r.tokensOut === undefined ? r.tokens : undefined
          ),
          tokens_cache_read: r.tokensCacheRead,
          tokens_cache_create: r.tokensCacheCreate,
          num_turns: r.numTurns, session_id: r.sessionId,
          duration_ms: r.durationMs, duration_api_ms: r.durationApiMs,
          model: r.model ?? req.model, loop_run_id: runId,
        })
      }
      // BUG-07: the loop path is the only recordInvocation callsite that never
      // invalidated open spending dashboards — they'd freeze for the whole (often
      // multi-hour) run. Broadcast after each row, wrapped so a broadcast failure
      // can't break traversal (mirrors the file-summary callsite).
      try {
        this._emit({ type: 'spending.invalidated', projectId: req.projectId })
      } catch { /* best-effort — never break traversal on a broadcast failure */ }
    }

    const stageAiAccounting = (
      kind: 'ai' | 'decider',
      nodeId: string,
      surfaceRefId: string,
      startedAt: string,
    ): string => {
      const stepKey = `${kind}:${stepNum}:${nodeId}`
      const startedAtMs = Date.parse(startedAt)
      const payload: LoopStepRecoveryPayload = {
        version: 1,
        runId,
        stepKey,
        invocationId: newId(),
        projectId: req.projectId,
        provider: req.provider,
        model: req.model ?? null,
        surfaceRefId,
        ticketIds: exactTicketIds,
        startedAt,
        baseline: readLoopJobUsage(this.db, runId),
        completedEventSeq: seq - 1,
        providerCostBaseline: 0,
        providerTurnsBaseline: 0,
        loopDurationBaseline: (this.db.prepare(`SELECT total_duration_ms FROM loop_runs WHERE id = ?`)
          .get(runId) as { total_duration_ms: number } | undefined)?.total_duration_ms ?? totalDuration,
        completedDurationMs: 0,
        iterationCount: iteration,
        ...(Number.isFinite(startedAtMs)
          ? { activeTurnStartedAtMs: startedAtMs, lastActivityAtMs: startedAtMs }
          : {}),
      }
      stageLoopStepRecovery(this.db, payload)
      this._activeStepRecovery.set(runId, stepKey)
      return stepKey
    }

    const composeHistory = (): string => {
      const joined = history.join('\n')
      return joined.length > HISTORY_MAX_CHARS ? '…' + joined.slice(-HISTORY_MAX_CHARS) : joined
    }

    // The first step of the body (the start node's successor). When the Decider's
    // 'continue' edge routes BACK here, the whole body re-runs — that's an
    // iterate-per-item loop (strict TDD, story executors, …) whose per-pass state
    // lives in the code on disk, not the chat. We drop the resumed AI session at
    // that loop-back so each iteration starts FRESH (re-reading the current code),
    // keeping context bounded regardless of pass count. Within an iteration the
    // steps still resume, so RED→GREEN→REFACTOR share context.
    const awaitHumanDecision = async (reason: string): Promise<PausedHumanDecision> => {
      const decisionPromise = new Promise<PausedHumanDecision>((resolve) => {
        this._pausedHumanDecisions.set(runId, { reason, resolve })
      })
      logLine(`\n■ Loop paused — needs a human decision: ${reason}`, 'stderr')
      try { markJobInteractive(this.db, runId) } catch { /* best-effort */ }
      pauseLoopRun(this.db, runId, {
        iterationCount: iteration,
        totalCostUsd: totalCost,
        totalTokens,
        totalDurationMs: totalDuration,
      })
      const pausedAt = new Date(this.now()).toISOString()
      this._emit({
        type: 'loop.run_paused',
        projectId: req.projectId,
        loopRunId: runId,
        railIndex: req.railIndex ?? null,
        reason,
        ticketIds: exactTicketIds,
      })
      this._emit({
        type: 'job.interactive',
        projectId: req.projectId,
        jobId: runId,
        acceptingTurns: true,
        settleMode: 'auto',
        timestamp: pausedAt,
      })

      const decision = await decisionPromise
      if (this._disposed) return new Promise(() => { /* startup recovery owns settlement */ })
      if (decision.action === 'stop' || this._cancelled.has(runId)) {
        logLine(`\n■ Loop stop requested while paused.`, 'stderr')
        return { action: 'stop' }
      }

      resumeLoopRun(this.db, runId)
      const answer = decision.text.trim()
      const resumedAt = new Date(this.now()).toISOString()
      logLine(`\n▶ Loop resumed — human decision received${answer ? `:\n${answer}` : '.'}`)
      history.push(`Human decision: ${truncate(answer)}`)
      this._emit({
        type: 'loop.run_resumed',
        projectId: req.projectId,
        loopRunId: runId,
        railIndex: req.railIndex ?? null,
        ticketIds: exactTicketIds,
      })
      this._emit({
        type: 'job.interactive',
        projectId: req.projectId,
        jobId: runId,
        acceptingTurns: false,
        settleMode: 'auto',
        timestamp: resumedAt,
      })
      return decision
    }

    const firstStepId = start ? req.graph.edges.find((e) => e.source === start.id)?.target : undefined

    try {
      let nodeId: string | undefined = start?.id
      let settled = !start // no start node → fall through to settle as failed
      if (!start) outcome = 'failed'

      while (nodeId && !settled) {
        if (this._cancelled.has(runId)) { outcome = 'stopped'; break }
        if (this.now() > deadline) { outcome = 'failed'; break }
        if (++steps > stepCap) { outcome = 'max-iterations'; break }
        // Cost cap: stop BEFORE the next step once prior steps crossed the budget.
        if (maxCostUsd !== undefined && totalCost >= maxCostUsd) {
          logLine(`\n■ Cost cap reached: $${totalCost.toFixed(4)} ≥ $${maxCostUsd.toFixed(2)} — stopping the loop.`, 'stderr')
          outcome = 'max-cost'
          break
        }

        const node = byId.get(nodeId)
        if (!node) { outcome = 'failed'; break }
        const succs = successors(req.graph, node.id)
        // The RAIL governs provider/model/effort for the whole run — nodes do
        // NOT override (decided in design: "lo que pongamos en el rail manda").
        const nodeProvider = req.provider
        const nodeModel = req.model
        const nodeEffort = req.effort
        // User-given step name (shown in the run log header); falls back per-kind.
        const nodeLabel = String(node.data?.label ?? '').trim()

        switch (node.type) {
          case 'start':
            nodeId = succs[0]?.id
            break
          case 'end':
            outcome = node.data?.outcome === 'failure' ? 'failed' : 'success'
            settled = true
            break
          case 'ai-step': {
            // Expand magic commands FIRST — `{{cmd:implement}}` becomes the
            // NATIVE per-provider invocation (claude `/specrails:implement #<id>
            // --yes`, codex `$implement #<id> --yes`) — then resolve `{{spec.*}}`
            // data tokens and finally `{{const:*}}` library constants.
            const rawTemplate = String(node.data?.prompt ?? '')
            const expanded = resolveConstants(
              resolveRunVars(
                interpolateSpec(
                  expandCommands(rawTemplate, { provider: nodeProvider, ticketIds: req.spec?.ticketIds, specId: req.spec?.id }),
                  req.spec
                ),
                runVars
              ),
              constMap
            )
            const base = withReviewContinuationContext(expanded, rawTemplate, req.spec)
            // Inject the cross-iteration history only when there's no live session
            // to carry it (a fresh pass) OR right after a Decider 'continue' (so the
            // step sees the verdict). A mid-body resumed step already has it.
            const includeHistory = history.length > 0 && (!aiSessionId || justContinued)
            const prompt = includeHistory ? `${base}\n\n---\nContext from previous iterations:\n${composeHistory()}` : base
            justContinued = false
            // The authored template + the actual COMMAND sent ride the loop_step
            // payload (NOT the flat log — the old `Template:`/`Command:` log lines
            // were noise once the step explorer landed; the log now opens on real
            // output). `template` is omitted when rendering changed nothing (a
            // plain free-text prompt would just duplicate `command`).
            emitStep('ai-step', `🤖 ${nodeLabel || 'AI Step'} (${nodeProvider}/${nodeModel}${nodeEffort ? `, effort: ${nodeEffort}` : ''})`, node.id, iteration + 1, {
              ...(rawTemplate && rawTemplate !== base ? { template: capText(rawTemplate, STEP_TEMPLATE_CAP) } : {}),
              ...(base ? { command: capText(base, STEP_COMMAND_CAP) } : {}),
            })
            // BUG-32: capture the REAL start instant BEFORE the await — the row is
            // bucketed/ordered by started_at, which must be the turn-start, not the
            // finish time (this.now() evaluated after the await would be the finish).
            const aiStepStart = new Date(this.now()).toISOString()
            const aiRecoveryKey = stageAiAccounting('ai', node.id, `loop:${runId}`, aiStepStart)
            // Interactive upgrade (default for persistent-stdin providers): the
            // executors return a resident-session plan when the kill-switch is on
            // and the provider is capable (claude); null falls through to the
            // byte-identical one-shot spawn. The plan mirrors the one-shot's
            // cwd/env/argv derivation; the engine owns the session lifecycle.
            const interactivePlan = this.executors.planInteractiveAiStep?.({
              provider: nodeProvider,
              model: nodeModel,
              effort: nodeEffort,
              cwd: req.cwd,
              repoDir: req.repoDir,
              sessionId: aiSessionId,
              aiStepTimeoutMs,
            }) ?? null
            const res = interactivePlan
              ? await this._runInteractiveAiStep({
                  runId,
                  projectId: req.projectId,
                  plan: interactivePlan,
                  prompt,
                  fallbackModel: nodeModel,
                  nextEventSeq: takeSeq,
                  recoveryStepKey: aiRecoveryKey,
                })
              : await this.executors.runAiStep({ prompt, sessionId: aiSessionId, provider: nodeProvider, model: nodeModel, effort: nodeEffort, cwd: req.cwd, repoDir: req.repoDir, onLine: logLine, onRawLine, onSpawn: (c) => this._activeChild.set(runId, c), aiStepTimeoutMs })
            if (this._disposed) return neverAfterDispose()
            this._activeChild.delete(runId)
            // Zero-work strictness (run 01f41203): a settle that consumed NO
            // model work — the claude CLI's synthetic `Unknown command:` result
            // frame (num_turns 0, no assistant events, zero usage tokens) —
            // means the step's command never actually ran. A step that didn't
            // run is FAILED, never 'ok'. The interactive path evaluates the
            // predicate at session settle (res.zeroWork set); for the one-shot
            // path the engine derives it here from the result's accumulated
            // signals (text accumulates ONLY from assistant text-delta events,
            // so non-empty text ⇒ assistant events were seen).
            const oneShotZeroWork = res.zeroWork === undefined && !res.failed && isZeroWorkSettle({
              numTurns: res.numTurns ?? 0,
              tokensIn: res.tokensIn ?? 0,
              tokensOut: res.tokensOut ?? 0,
              tokensCacheRead: res.tokensCacheRead ?? 0,
              tokensCacheCreate: res.tokensCacheCreate ?? 0,
              sawAssistantEvent: res.text.trim().length > 0,
              resultText: res.text.trim() ? res.text : null,
            })
            const zeroWork = res.zeroWork === true || oneShotZeroWork
            const blockedReason = aiStepBlockedReason(res.text)
            const stepFailed = res.failed === true || zeroWork || blockedReason !== null
            const stepErrorText = res.errorText ?? (zeroWork
              ? `zero work performed — the command never ran${res.text.trim() ? `: ${res.text.trim()}` : ''}`
              : blockedReason
                ? `blocked — ${blockedReason}`
              : undefined)
            // Make the failure reason land visibly INSIDE the step's log
            // segment (the interactive session already surfaced its own note at
            // settle; the Template/Command flat-log lines are gone, so without
            // this the one-shot `Unknown command:` text would never be seen).
            if (oneShotZeroWork) {
              logLine(`✖ Zero work performed — the command never ran${res.text.trim() ? `: ${res.text.trim()}` : ''}`, 'stderr')
            }
            // Step tail marker — after the step's last streamed output (both the
            // one-shot and interactive paths have fully persisted their frames by
            // here: the session resolves inside onSettle, past its final writes).
            // Failure mirrors what the engine already treats as step failure
            // (res.failed: non-zero exit / spawn error / timeout / crashed
            // session — plus zero-work); no exit code is exposed by the AI
            // executors → null.
            emitStepEnd({ status: stepFailed ? 'failed' : 'ok', durationMs: res.durationMs })
            // Only carry forward the session of a step that actually ran — a
            // hard-failed turn (codex still emits thread.started before its error)
            // would otherwise make the next step `--resume` a dead session.
            if (res.sessionId && (!stepFailed || (blockedReason !== null && !res.failed && !zeroWork))) aiSessionId = res.sessionId
            history.push(`AI Step: ${truncate(res.text)}`)
            record(`loop:${runId}`, { ...res, failed: stepFailed }, aiStepStart, aiRecoveryKey)
            this._activeStepRecovery.delete(runId)
            if (blockedReason) {
              const decision = await awaitHumanDecision(blockedReason)
              if (decision.action === 'stop') {
                outcome = 'stopped'
                settled = true
                break
              }
              justContinued = true
              nodeId = node.id
              continue
            }
            // Capture the OpenSpec change id from a step's output the FIRST time it
            // appears (first-match-wins, kept stable across loop-back iterations so
            // the re-pass amends the same change). Used by `{{run.changeId}}` in the
            // loop-back ff prompt and the unattended archive shell node.
            if (!runVars.changeId) {
              const cid = extractChangeId(res.text)
              if (cid) { runVars.changeId = cid; logLine(`↪ Captured OpenSpec change id: ${cid}`) }
            }
            // Fail-fast: a hard-failed step (non-zero exit / spawn error) that
            // produced NO output means the provider never really ran — quota,
            // auth, crash. One can be transient; AI_FAILFAST_THRESHOLD in a row
            // is systemic, so abort with the real reason instead of spinning to
            // the iteration cap (wasting wall-clock and, on paid providers, money).
            // A ZERO-WORK step routes the SAME way a crashed no-output step does
            // (its `Unknown command:` text is a CLI synthetic, not model output),
            // so a persistently-unresolvable command aborts the run identically
            // instead of grinding to the cap.
            if (stepFailed && (zeroWork || !res.text.trim())) {
              consecutiveAiFailures += 1
              if (consecutiveAiFailures >= AI_FAILFAST_THRESHOLD) {
                logLine(`Loop aborted: provider appears down — ${consecutiveAiFailures} AI steps failed with no output and no successful AI call in between${stepErrorText ? ` — ${stepErrorText}` : ''}`, 'stderr')
                outcome = 'failed'
                settled = true
                break
              }
            } else {
              consecutiveAiFailures = 0
            }
            nodeId = succs[0]?.id
            break
          }
          case 'shell': {
            // Guard: refuse to run when a declared run-variable was never captured
            // (e.g. an archive node whose `{{run.changeId}}` is empty) — running
            // `openspec archive  -y` against an unknown change would archive the
            // wrong thing. Settle the run failed with a clear reason instead.
            const reqVarsRaw = node.data?.requireRunVars
            const requireRunVars = Array.isArray(reqVarsRaw)
              ? reqVarsRaw.filter((v): v is string => typeof v === 'string')
              : []
            const missingRunVars = requireRunVars.filter((name) => !runVars[name])
            if (missingRunVars.length > 0) {
              emitStep('shell', `⚡ ${nodeLabel || 'Shell'}`, node.id, iteration + 1)
              logLine(`Skipped: required run variable(s) not captured: ${missingRunVars.map((n) => `{{run.${n}}}`).join(', ')} — refusing to run the command against an unknown target.`, 'stderr')
              // Never spawned → no exit code; the refusal is a failed step.
              emitStepEnd({ status: 'failed' })
              outcome = 'failed'
              settled = true
              break
            }
            const command = resolveConstants(resolveRunVars(interpolateSpec(String(node.data?.command ?? ''), req.spec), runVars), constMap)
            emitStep('shell', `⚡ ${nodeLabel || 'Shell'}`, node.id, iteration + 1)
            logLine(`$ ${command}`)
            const sh = await this.executors.runShell({ command, cwd: req.cwd, onLine: logLine, onSpawn: (c) => this._activeChild.set(runId, c) })
            if (this._disposed) return neverAfterDispose()
            this._activeChild.delete(runId)
            logLine(`(exit ${sh.exitCode})`)
            emitStepEnd({ status: sh.exitCode === 0 ? 'ok' : 'failed', exitCode: sh.exitCode, durationMs: sh.durationMs })
            totalDuration += sh.durationMs ?? 0
            updateLoopRunCounters(this.db, runId, {
              iterationCount: iteration,
              totalCostUsd: totalCost,
              totalTokens,
              totalDurationMs: totalDuration,
            })
            history.push(`Shell \`${command}\` exit=${sh.exitCode}: ${truncate(sh.stdout || sh.stderr)}`)
            nodeId = succs[0]?.id
            break
          }
          case 'decider': {
            if (iteration >= maxIterations) { outcome = 'max-iterations'; settled = true; break }
            iteration += 1
            const goal = resolveConstants(interpolateSpec(String(node.data?.goal ?? 'The loop goal is met.'), req.spec), constMap)
            // `iteration` was just incremented — it IS this pass's 1-based number.
            emitStep('decider', `🔍 ${nodeLabel || 'Loop Decider'} (iteration ${iteration})`, node.id, iteration)
            logLine(`Goal: ${goal}`)
            // BUG-32: capture the real Decider start BEFORE the await (see AI step).
            const deciderStart = new Date(this.now()).toISOString()
            const deciderRecoveryKey = stageAiAccounting(
              'decider', node.id, `loop:${runId}:decider`, deciderStart,
            )
            const dec = await this.executors.runDecider({
              systemPrompt: buildDeciderSystemPrompt(),
              // Give the Decider the spec so it can verify completeness against the
              // FULL scope instead of trusting a step's self-reported success.
              userPrompt: buildDeciderUserPrompt({ goal, history, spec: req.spec ? { title: req.spec.title, description: req.spec.description } : undefined }),
              provider: nodeProvider,
              model: nodeModel,
              effort: nodeEffort,
              cwd: req.cwd,
              repoDir: req.repoDir,
              onLine: logLine,
              onRawLine,
              onSpawn: (c) => this._activeChild.set(runId, c),
            })
            if (this._disposed) return neverAfterDispose()
            this._activeChild.delete(runId)
            // A parseable Decider verdict means this AI invocation (SAME
            // provider/model) succeeded → the provider is alive, so clear any
            // ai-step failure streak. This stops a false fail-fast abort when an
            // ai-step blips but the provider is demonstrably up. (When the provider
            // is truly down the Decider also fails → parsed=false → no reset.)
            if (dec.parsed) consecutiveAiFailures = 0
            const verdictWord = dec.blocked ? 'blocked' : dec.continue ? 'continue' : 'stop'
            // BUG-03: a Decider that couldn't parse a verdict (dec.parsed === false)
            // is a failed AI invocation — record it as such, not as success.
            record(
              `loop:${runId}:decider`,
              { ...dec, failed: !dec.parsed },
              deciderStart,
              deciderRecoveryKey,
            )
            this._activeStepRecovery.delete(runId)
            logLine(`Decision: ${verdictWord} — ${dec.reasoning}`)
            // The verdict line above is the decider step's last output. `decision`
            // is the route actually taken (an unparseable verdict defaults to
            // continue AND flags the step failed — mirrors record()'s status).
            emitStepEnd({
              status: dec.parsed ? 'ok' : 'failed',
              durationMs: dec.durationMs,
              decision: dec.continue ? 'continue' : 'stop',
            })
            history.push(`Decider: ${verdictWord} — ${dec.reasoning}`)
            updateLoopRunCounters(this.db, runId, {
              iterationCount: iteration,
              totalCostUsd: totalCost,
              totalTokens,
              totalDurationMs: totalDuration,
            })
            this._emit({
              type: 'loop.run_progress',
              projectId: req.projectId,
              loopRunId: runId,
              iteration,
              activeNode: node.id,
              reasoning: dec.reasoning,
            })
            // Route by the edge's explicit `branch` (the Decider's two named
            // source handles: 'continue' / 'stop'). Legacy graphs authored before
            // labeled branches carry no `branch` — fall back to the original
            // successor-node-type heuristic (continue → first non-end, stop →
            // first end) so old loops keep running identically.
            const out = req.graph.edges.filter((e) => e.source === node.id)
            const branchTarget = (b: 'continue' | 'stop'): string | undefined =>
              out.find((e) => e.branch === b)?.target
            const ends = succs.filter((n) => n.type === 'end')
            const conts = succs.filter((n) => n.type !== 'end')
            // BLOCKED: the loop is stuck on a human decision — halt now with a
            // dedicated outcome (NOT success) and surface the question. This is
            // the fix for the verify→fix cycle spinning on an unanswered scope
            // question the loop can't resolve on its own.
            if (dec.blocked) {
              const decision = await awaitHumanDecision(dec.reasoning)
              if (decision.action === 'stop') {
                outcome = 'stopped'
                settled = true
                break
              }
              const target = branchTarget('continue') ?? conts[0]?.id ?? firstStepId
              if (!target) {
                outcome = 'failed'
                settled = true
                break
              }
              justContinued = true
              nodeId = target
              continue
            }
            // Non-convergence guard: if two consecutive 'continue' iterations
            // leave the working tree byte-identical, the loop isn't progressing
            // (e.g. verify keeps passing a baseline while the feature is never
            // written) — abort `stalled` rather than cycle to the cap.
            if (dec.continue && this.executors.repoStateHash) {
              const dir = req.repoDir ?? req.cwd
              const hash = this.executors.repoStateHash(dir)
              // null = couldn't read the tree → skip (never let null match null).
              if (hash !== null) {
                if (hash === lastRepoHash) {
                  consecutiveNoProgress += 1
                  if (consecutiveNoProgress >= NO_PROGRESS_LIMIT) {
                    logLine(`\n■ Loop stalled — ${consecutiveNoProgress + 1} iterations changed nothing in the working tree; stopping instead of cycling.`, 'stderr')
                    outcome = 'stalled'
                    settled = true
                    break
                  }
                } else {
                  consecutiveNoProgress = 0
                }
                lastRepoHash = hash
              }
            }
            if (dec.continue) {
              const target = branchTarget('continue') ?? conts[0]?.id
              if (target) {
                nodeId = target
                // The next step acts on this verdict → let it see the history.
                justContinued = true
                // New iteration of an iterate-per-item loop → drop the resumed AI
                // session so the next pass starts fresh (re-reads the code on disk).
                // Provider-agnostic: clearing aiSessionId makes runAiStep use the
                // 'rail-job' (fresh) action, which every adapter maps to its own
                // native spawn — no claude/codex/gemini/kimi branching here.
                if (target === firstStepId) aiSessionId = undefined
              }
              else { outcome = 'success'; settled = true }
            } else {
              const target = branchTarget('stop') ?? ends[0]?.id
              if (target) nodeId = target
              else { outcome = 'success'; settled = true }
            }
            break
          }
          case 'condition':
            // v1: AND/OR branching is not yet evaluated — follow the first edge.
            nodeId = succs[0]?.id
            break
          default:
            nodeId = succs[0]?.id
        }

        // Ran off the end of the graph without an explicit End node.
        if (nodeId === undefined && !settled) {
          outcome = 'success'
          settled = true
        }
      }
    } catch (err) {
      if (this._disposed) return neverAfterDispose()
      outcome = 'failed'
      console.error(`[loop] run=${runId} traversal threw:`, err)
      logLine(`error: ${(err as Error)?.message ?? String(err)}`, 'stderr')
    }

    if (this._disposed) return neverAfterDispose()

    // Backstop: a traversal exception (or any future path that breaks out
    // mid-step) must not leave the last step dangling — close it as failed.
    // The ONLY way a persisted stream ends with an open step is a mid-flight
    // dispose (shutdown/project removal), where this code never runs.
    emitStepEnd({ status: 'failed' })

    // A traversal exception can bypass record(). Reconcile the staged step
    // BEFORE writing aggregate job totals, while its jobs baseline is still
    // valid. If reconciliation itself fails, finishLoopRunAndJob detects the
    // surviving checkpoint and preserves those baseline columns for startup.
    try {
      const recoveredSteps = recoverOrphanLoopStepAccounting(
        this.db,
        new Date(this.now()).toISOString(),
        runId,
      )
      this._activeStepRecovery.delete(runId)
      const aggregate = this.db.prepare(`
        SELECT COALESCE(SUM(total_cost_usd), 0) AS cost,
               COALESCE(SUM(tokens_in), 0) AS tokens_in,
               COALESCE(SUM(tokens_out), 0) AS tokens_out,
               COALESCE(SUM(tokens_cache_read), 0) AS cache_read,
               COALESCE(SUM(tokens_cache_create), 0) AS cache_create,
               COALESCE(SUM(duration_ms), 0) AS duration,
               COALESCE(SUM(num_turns), 0) AS turns
          FROM ai_invocations
         WHERE surface = 'loop' AND loop_run_id = ?
      `).get(runId) as {
        cost: number; tokens_in: number; tokens_out: number
        cache_read: number; cache_create: number; duration: number; turns: number
      }
      if (usageTelemetryAvailable) {
        totalCost = aggregate.cost
        totalTokens = aggregate.tokens_in + aggregate.tokens_out
      }
      if (recoveredSteps > 0) {
        // Recovery already committed the authoritative D+X totals. Refresh the
        // traversal locals before finishLoopRunAndJob; otherwise a catch path
        // that never called record() writes its stale D baseline back over the
        // recovered row (duration was the visible casualty, but keep all
        // counters/iteration coherent).
        const durable = getLoopRun(this.db, runId)
        if (durable) {
          totalCost = durable.total_cost_usd
          totalTokens = durable.total_tokens
          totalDuration = durable.total_duration_ms
          iteration = Math.max(iteration, durable.iteration_count)
        }
      }
      if (usageTelemetryAvailable) {
        finalJobUsage = {
          tokensIn: aggregate.tokens_in,
          tokensOut: aggregate.tokens_out,
          tokensCacheRead: aggregate.cache_read,
          tokensCacheCreate: aggregate.cache_create,
          numTurns: aggregate.turns,
        }
      }
    } catch (err) {
      console.error(`[loop] staged accounting reconciliation failed for ${runId}:`, err)
    }

    console.log(
      `[loop] settle run=${runId} outcome=${outcome} iterations=${iteration} ` +
        (usageTelemetryAvailable ? `cost=$${totalCost.toFixed(4)}` : 'usage=unavailable'),
    )

    // Settle the backing job so the Jobs list + JobDetail reflect the final
    // status, and emit job.finalized so an open JobDetail re-fetches + stops the
    // live stream (mirrors QueueManager).
    // `stopped`/`stalled` are controlled halts (not done, not a hard crash) →
    // surface as `canceled`, so tickets revert to todo rather than being marked
    // done/on_review AND the run is never counted as success.
    const jobStatus: JobStatus =
      outcome === 'success' ? 'completed'
        : outcome === 'stopped' || outcome === 'stalled' ? 'canceled'
          : 'failed'
    // `≥` when any cost-bearing step ended unpriced (timeout/crash) — the figure
    // is a lower bound, not exact. Providers without usage telemetry get an
    // explicit unavailable marker, never a fabricated "$0.0000".
    logLine(
      `\n■ Loop finished: ${outcome} — ${iteration} iteration${iteration === 1 ? '' : 's'}, ` +
        (usageTelemetryAvailable
          ? `${costUncertain ? '≥ ' : ''}$${totalCost.toFixed(4)}`
          : 'usage/cost unavailable'),
    )
    const finishedAt = new Date(this.now()).toISOString()
    finishLoopRunAndJob(this.db, runId, {
      outcome,
      finishedAt,
      counters: {
        iterationCount: iteration,
        // loop_runs retains its legacy non-null internal counters; public/job
        // telemetry below carries the honest nullable availability contract.
        totalCostUsd: totalCost,
        totalTokens,
        totalDurationMs: totalDuration,
      },
      job: {
        exitCode: outcome === 'success' ? 0 : 1,
        status: jobStatus,
        totalCostUsd: usageTelemetryAvailable ? totalCost : null,
        tokensIn: finalJobUsage.tokensIn,
        tokensOut: finalJobUsage.tokensOut,
        tokensCacheRead: finalJobUsage.tokensCacheRead,
        tokensCacheCreate: finalJobUsage.tokensCacheCreate,
        durationMs: totalDuration,
        numTurns: finalJobUsage.numTurns,
      },
      callbackOutcome: req.deferTerminalOutcome ? 'failed' : outcome,
      outcomeFinalized: !req.deferTerminalOutcome,
    })
    this._emit({
      type: 'job.finalized',
      projectId: req.projectId,
      jobId: runId,
      status: jobStatus,
      totals: {
        tokens_in: finalJobUsage.tokensIn,
        tokens_out: finalJobUsage.tokensOut,
        tokens_cache_read: finalJobUsage.tokensCacheRead,
        tokens_cache_create: finalJobUsage.tokensCacheCreate,
        total_cost_usd: usageTelemetryAvailable ? totalCost : null,
        num_turns: finalJobUsage.numTurns,
      },
      timestamp: new Date(this.now()).toISOString(),
    })
    this._emit({
      type: 'loop.run_completed',
      projectId: req.projectId,
      loopRunId: runId,
      railIndex: req.railIndex ?? null,
      status: outcome,
      ticketIds: exactTicketIds,
    })

    return {
      runId,
      outcome,
      iterations: iteration,
      totalCostUsd: usageTelemetryAvailable ? totalCost : null,
    }
  }

  /**
   * Run ONE ai-step as a resident interactive session (settleMode 'auto'):
   * first stdin frame = the step's rendered prompt (slash or prose — both
   * expand, spike-verified), user turns mid-step queue+extend, and the moment
   * the session goes QUIESCENT (turn result, nothing pending) it settles itself
   * and the loop advances exactly as after a one-shot. The SettleInfo maps onto
   * the same AiStepResult shape the one-shot executor returns, so everything
   * downstream (history, changeId capture, fail-fast, `record()`'s single
   * ai_invocations row per step) is untouched.
   *
   * Ownership/teardown matrix (never leaks the child, never double-settles —
   * the session's _settle is idempotent and every path funnels through it):
   *  • quiescence / explicit finalizeInteractive → settle 'finalized' (step ok)
   *  • step timeout → session.abort() → fold in-flight turn → settle 'crashed'
   *  • run cancel → cancel() calls session.abort() → settle 'crashed' → the
   *    engine's next boundary check settles the run 'stopped'
   *  • manager shutdown / project removal → dispose() (kill, NO settle; the
   *    startup orphan sweeps reconcile the rows — mirrors QueueManager)
   *
   * Accounting: the session accumulates per-turn REAL usage onto the jobs row
   * live (accumulateInteractiveTurn) and folds any killed in-flight turn as a
   * rate-card ESTIMATE; the ENGINE stays the sole ai_invocations authority —
   * one `record()` row per step from the settle-derived totals (no session-side
   * invocation row, so nothing double-records).
   */
  private _runInteractiveAiStep(input: {
    runId: string
    projectId: string
    plan: InteractiveAiStepPlan
    prompt: string
    fallbackModel: string
    nextEventSeq: () => number
    recoveryStepKey: string
  }): Promise<AiStepResult> {
    return new Promise<AiStepResult>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      let timedOut = false
      const session = new InteractiveJobSession({
        jobId: input.runId,
        projectId: input.projectId,
        db: this.db,
        adapter: input.plan.adapter,
        broadcast: this.broadcast,
        settleMode: 'auto',
        // The step timeout below is the sole watchdog — the one-shot loop path
        // has no zombie detector either (byte-parity), so none is armed here.
        nextEventSeq: input.nextEventSeq,
        persistTurnUsage: (usage, completedEventSeq, checkpoint) => {
          const checkpointTurn = this.db.transaction(() => {
            accumulateInteractiveTurn(this.db, input.runId, usage)
            updateLoopStepEventCheckpoint(
              this.db,
              input.runId,
              input.recoveryStepKey,
              completedEventSeq,
              checkpoint?.cost,
              checkpoint?.turns,
              checkpoint?.activeDurationMs,
            )
          })
          checkpointTurn()
        },
        persistTurnActivity: (turnStartedAtMs, activityAtMs) => {
          updateLoopStepActivityCheckpoint(
            this.db,
            input.runId,
            input.recoveryStepKey,
            turnStartedAtMs,
            activityAtMs,
          )
        },
        spawn: input.plan.spawn,
        killTree: input.plan.killTree,
        onSettle: (info) => {
          if (timer) { clearTimeout(timer); timer = null }
          this._interactiveSteps.delete(input.runId)
          // The step's session is gone — the composer flips to its gentle
          // "waiting for the next step" state instead of erroring on 409.
          this._emit({
            type: 'job.interactive',
            projectId: input.projectId,
            jobId: input.runId,
            acceptingTurns: false,
            settleMode: 'auto',
            timestamp: new Date(this.now()).toISOString(),
          })
          // Zero-work strictness: a session that settled cleanly but consumed
          // NO model work across its whole life (the synthetic `Unknown
          // command:` frame) is a FAILED step — the command never ran. Judged
          // by the session itself over the accumulated totals (whole-session,
          // so a multi-turn step ending on one synthetic frame is unaffected).
          const failed = info.reason === 'crashed' || info.zeroWork
          resolve({
            // The last turn's `result` payload — the same terminal text the
            // one-shot path captures (feeds history/changeId/fail-fast).
            text: info.resultText ?? '',
            sessionId: info.sessionId ?? undefined,
            cost: info.totals.total_cost_usd,
            // Derived scalar = input+output ONLY (legacy semantics — see the
            // one-shot executor's note); cache volume rides the structured fields.
            tokens: info.totals.tokens_in + info.totals.tokens_out,
            tokensIn: info.totals.tokens_in,
            tokensOut: info.totals.tokens_out,
            tokensCacheRead: info.totals.tokens_cache_read,
            tokensCacheCreate: info.totals.tokens_cache_create,
            // Sum of active turn wall-segments (write→result), excluding idle
            // gaps between turns — matches the queue's interactive semantics.
            durationMs: info.activeDurationMs,
            numTurns: info.totals.num_turns,
            provider: input.plan.adapter.id,
            model: info.model ?? input.fallbackModel,
            estimated: info.estimated,
            failed,
            zeroWork: info.zeroWork,
            errorText: failed
              ? (info.reason === 'crashed'
                  ? (timedOut ? 'AI step timed out' : 'interactive step session crashed')
                  : `zero work performed — the command never ran${info.resultText ? `: ${info.resultText}` : ''}`)
              : undefined,
          })
        },
      })
      this._interactiveSteps.set(input.runId, session)
      // The run's backing job row was created without the flag (before this
      // step's capability gate); stamp it now so GET /jobs/:id advertises the
      // in-job chat affordance. Idempotent across steps.
      try { markJobInteractive(this.db, input.runId) } catch { /* best-effort */ }
      // A resident step session is live — an open Job Detail composer re-enables
      // without polling (mirror flip of the onSettle broadcast above).
      this._emit({
        type: 'job.interactive',
        projectId: input.projectId,
        jobId: input.runId,
        acceptingTurns: true,
        settleMode: 'auto',
        timestamp: new Date(this.now()).toISOString(),
      })
      if (input.plan.stepTimeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true
          session.abort(
            `AI step timed out after ${Math.round(input.plan.stepTimeoutMs / 1000)}s — tearing down the interactive session`,
          )
        }, input.plan.stepTimeoutMs)
        timer.unref?.()
      }
      session.start(input.plan.spec, input.prompt)
    })
  }
}
