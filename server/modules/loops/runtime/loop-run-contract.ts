/**
 * Loop run contract — the public types of the legacy/Core loop engine: the
 * injected executor port, the run request/result, the structured run-event
 * payloads (loop-step log explorer contract) and the budget-pause vocabulary.
 * Re-exported unchanged by `loop-run-manager.ts`, the module's public entry.
 */
import type { MachineInstalls } from '../../machine-installs'
import type { ChildProcess } from 'node:child_process'
import type { CoreCompletionSnapshot } from '../../../core-completion'
import type { CoreCompletionCheck, CoreRunInput } from '../../../core-execution'
import type { RunExecutionManifest } from '../../delivery/runtime/multi-repo-execution-store'
import type { HostTaskDispatcher } from '../../agent-runtime/runtime/host-task-dispatcher'
import type { AgentAuditRecorder } from '../../audit'
import type { RuntimeProviderOverride } from '../../agent-runtime/runtime/agent-runtime-settings'
import type { InteractiveJobSessionDeps, InteractiveSpawnSpec } from '../../execution/runtime/interactive-job-session'
import type { ProviderAdapter, ReasoningEffort } from '../../../providers/types'
import type { ProviderLimit } from '../../../provider-limit'
import type { LoopGraph, LoopSpec } from './loop-graph'
import type { DeciderDecision } from './loop-decider'
import type { LoopRunOutcome } from './loop-runs-store'
import type { DefinitionCompletion, DefinitionInterrupt, DefinitionLoopInvocation, DefinitionRuntimeResult } from './loop-definition-run'

export interface AiStepResult {
  /** Core's structured `failure` record (contract 5.8+), raw; validated by the recovery module. */
  failure?: unknown
  runtimeStatus?: DefinitionRuntimeResult['runtimeStatus']
  completion?: DefinitionCompletion
  pendingInterrupts?: DefinitionInterrupt[]
  pendingQuestion?: DefinitionRuntimeResult['pendingQuestion']
  pendingApproval?: DefinitionRuntimeResult['pendingApproval']
  pause?: DefinitionRuntimeResult['pause']
  graph?: Record<string, unknown>
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
  /** The provider flagged the final `result` as an error (claude `is_error`).
   *  Structural — no text heuristics; the engine fails the step on it. */
  resultIsError?: boolean
  /** True when the step's settle consumed NO model work across its whole life
   *  (the claude CLI's synthetic `Unknown command:` result frame — see
   *  isZeroWorkSettle in interactive-job-session.ts). Set authoritatively by
   *  the interactive path; `undefined` means "not evaluated" and the engine
   *  derives it from the result's accumulated signals (one-shot path). A
   *  zero-work step is FAILED — its command never actually ran. */
  zeroWork?: boolean
  /** True when the idle watchdog tore the step down (no provider output for
   *  the idle budget). The engine retries such a step ONCE by resume before
   *  failing it; `failed` is also true. */
  stalled?: boolean
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
export type LoopLogSink = (line: string, source?: 'stdout' | 'stderr', metadata?: { attemptId?: string }) => void

/** Registers the spawned child so the engine can kill it on cancel/stop (a
 *  cooperative `_cancelled` flag alone can't interrupt a blocked `await`). */
export type LoopSpawnSink = (child: ChildProcess) => void

/** Input for the optional interactive-plan builder (mirrors runAiStep's spawn
 *  context — everything the one-shot path derives its cwd/env/argv from). */
export interface InteractivePlanInput {
  coreRun?: CoreRunInput
  provider: string
  model: string
  effort?: ReasoningEffort
  profileName?: string | null
  cwd: string
  repoDir?: string
  executionManifest?: RunExecutionManifest
  /** Resume a prior step's session (mid-pass continuity — the interactive
   *  equivalent of the one-shot path's chat-resume). Absent on a fresh pass. */
  sessionId?: string
  /** Per-step wall-clock timeout (ms). Undefined ⇒ executor default (15 min);
   *  0 ⇒ no per-step timeout. */
  aiStepTimeoutMs?: number
  /** Inactivity bound (ms) — see loop-step-idle.ts. 0 disables; absent uses the executor default. */
  idleTimeoutMs?: number
}

/** A resident interactive-session spawn plan for ONE ai-step (the interactive
 *  jobs default). The EXECUTORS build it (process glue: adapter, argv, env —
 *  byte-mirroring what the one-shot spawn passes); the ENGINE runs it (owns the
 *  InteractiveJobSession lifecycle: step timeout, turn routing, settle → step
 *  result). `spawn` is the tests' injection seam, exactly like the session's. */
export interface InteractiveAiStepPlan {
  /** Host-validated Core verification evidence for this step. */
  promptPrefix?: string
  adapter: ProviderAdapter
  spec: InteractiveSpawnSpec
  /** Wall-clock bound for the WHOLE step, user turns included. On expiry the
   *  session is aborted (fold in-flight turn → settle 'crashed'). */
  stepTimeoutMs: number
  /** Compatibility alias for plans produced before loop-step-idle. */
  inactivityTimeoutMs?: number
  /** Inactivity bound (ms): the engine arms it as the session's wedge detector
   *  (no raw output for this long → step settles `stalled`). Absent ⇒ none. */
  idleTimeoutMs?: number
  /** Injectable spawn (tests). Defaults to the session's spawnAiCli. */
  spawn?: InteractiveJobSessionDeps['spawn']
  /** Injectable process-tree terminator paired with `spawn` in tests. */
  killTree?: InteractiveJobSessionDeps['killTree']
}

export interface LoopExecutors {
  /** OPTIONAL: one value-free warning written to the run log at start when
   *  configured project environment names are unresolved; null when none. */
  environmentNotice?(): string | null
  assertDefinitionSupport?(graph?: LoopRunRequest['graph']): Promise<void>
  /** Rejects a legacy traversal when the active Core has no engine 1 (Core 7). */
  assertLegacyEngineSupport?(): Promise<void>
  runDefinition?(input: DefinitionLoopInvocation): Promise<DefinitionRuntimeResult>
  cancelDefinition?(input: { runId: string; contextPath: string; requestId: string }): Promise<void>
  /** Cooperative Core pause of a RUNNING definition run (`runtime pause`): the
   *  current step finishes, then Core exits 2 with `state.pause`. Rejects with
   *  `engine_unsupported` when the retained Core lacks `pauseRuns`. */
  pauseDefinition?(input: { runId: string; contextPath: string; requestId: string; reason: string }): Promise<{ outcome: string }>
  readCoreCompletion?(runId: string): Promise<CoreCompletionSnapshot | null>
  runAiStep(input: {
    runtimeProviderOverride?: RuntimeProviderOverride
    coreRun?: CoreRunInput
    prompt: string
    sessionId?: string
    provider: string
    model: string
    effort?: ReasoningEffort
    profileName?: string | null
    cwd: string
    repoDir?: string
  executionManifest?: RunExecutionManifest
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
    /** Per-step wall-clock timeout (ms). Undefined ⇒ executor default (15 min);
     *  0 ⇒ no per-step timeout. */
    aiStepTimeoutMs?: number
    /** Inactivity bound (ms) — see loop-step-idle.ts. 0 disables; absent uses the executor default. */
    idleTimeoutMs?: number
  }): Promise<AiStepResult>
  /** OPTIONAL interactive upgrade for ai-steps: return a resident-session spawn
   *  plan when interactive jobs are enabled AND the provider supports persistent
   *  stdin (claude); return null/undefined (or omit the method) to run the step
   *  through the one-shot `runAiStep` — byte-identical legacy behaviour. */
  planInteractiveAiStep?(input: InteractivePlanInput): InteractiveAiStepPlan | null
  /** Installed Core's deterministic completion gate, shared by both transports. */
  validateCoreCompletion?(input: InteractivePlanInput & { coreRun: CoreRunInput }): CoreCompletionCheck
  runShell(input: { command: string; cwd: string; repoDir?: string; timeoutMs?: number; onLine?: LoopLogSink; onSpawn?: LoopSpawnSink }): Promise<ShellResult>
  runDecider(input: {
    systemPrompt: string
    userPrompt: string
    provider: string
    model: string
    effort?: ReasoningEffort
    cwd: string
    repoDir?: string
  executionManifest?: RunExecutionManifest
    onLine?: LoopLogSink
    onRawLine?: (line: string) => void
    onSpawn?: LoopSpawnSink
    timeoutMs?: number
  }): Promise<DeciderRunResult>
  /** OPTIONAL: a cheap, deterministic fingerprint of the repo's working-tree
   *  state (HEAD + dirty set) used by the non-convergence guard — when this is
   *  UNCHANGED across consecutive Decider 'continue' verdicts the loop is making
   *  no progress and the engine aborts (outcome `stalled`) instead of cycling.
   *  Returns null when it can't read the tree (guard then disabled). Omit the
   *  method to disable the guard entirely (byte-identical legacy behaviour). */
  repoStateHash?(dir: string): string | null | Promise<string | null>
}

export interface LoopRunRequest {
  /** Admitted rail options for a fresh retry; excludes execution paths/ids. */
  launchConfig?: Record<string, unknown>
  /** Lines a fresh run logs right after its banner (a likely overlap with another rail). */
  launchNotices?: string[]
  runtimeProviderOverride?: RuntimeProviderOverride
  /** Loop Decider engine (roles launch, hybrid-role-engines); absent ⇒ the rail's provider/model/effort. */
  deciderEngine?: { provider: string; model: string; effort?: ReasoningEffort }
  /** Explicit rail profile; null opts out of profile injection, undefined uses defaults. */
  profileName?: string | null
  /** Pre-allocated run id (so the caller can track/cancel before completion).
   *  Defaults to a fresh id. */
  runId?: string
  /** Per-run soft cap override (USD) for THIS launch: > 0 caps it, 0 waives the
   *  project/app default. Absent ⇒ the default applies ("pause and ask at $X"). */
  runCapUsd?: number
  loopId: string
  loopName?: string
  graph: LoopGraph
  projectId: string
  /** Spawn cwd (workspace when the project is relocated, else the repo). */
  cwd: string
  /** The repo dir when relocated (→ SPECRAILS_REPO_DIR + claude `--add-dir`), so
   *  native core slash commands run against the real repo. Undefined = legacy. */
  repoDir?: string
  executionManifest?: RunExecutionManifest
  railIndex?: number | null
  /** Registered identity for a legacy single-repository run without a manifest. */
  repositoryId?: string
  workspacePaths?: string[]
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
  /** PR review follow-up (pr-follow-up-fixes): the frozen scope's identity and
   *  its rendered briefing, appended to EVERY ai-step prompt of this run so no
   *  phase (prepare, implement, verify, deliver) can miss it. Same id/version/
   *  hash for the whole run — a draft edited meanwhile never changes it. */
  followUp?: { id: string; version: number; hash: string; briefing: string; openspecChangeName?: string | null }
  /** Spec addenda (spec-addenda): the iteration notes the run's specs carried at
   *  launch, frozen (ids + hashes) and rendered ONCE into a briefing appended to
   *  EVERY ai-step prompt — after the follow-up, before the history. A note
   *  edited mid-run never changes what this run received. */
  addenda?: { ids: string[]; briefing: string }
  /** Intent -> Spec (Intent mode): the Intent reservation commit Core measures the
   *  change from (`repositories[].baseSha`) and the bounded conversation
   *  summary written to `.specrails/pipeline/<runId>/flow-summary.md`.
   *  `changeId`: the change this Intent's earlier run derived, re-derived in place. */
  flowDerivation?: { baseSha: string | null; summary: string; changeId?: string | null }
}

export type LoopStallReason = 'idle_timeout' | 'no_progress' | 'provider_limit'

export interface LoopRunResult {
  runId: string
  outcome: LoopRunOutcome
  iterations: number
  totalCostUsd: number | null
  /** Why a `stalled` run stopped (absent for other outcomes). */
  stallReason?: LoopStallReason
  /** `provider_limit` only: the provider's own notice + reset hint. */
  providerLimit?: ProviderLimit
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
  /** Millisecond-precision wall-clock instant the step opened. ADDITIVE and
   *  optional: legacy persisted payloads predate it, and consumers must fail
   *  closed rather than guess when it is absent. Evidence harvesting needs it
   *  because the ISO `timestamp` on the enclosing event is second-granular —
   *  a reviewer artifact written in the same second as the verify step opened
   *  could not otherwise be told apart from one left by the previous pass. */
  startedAtMs?: number
  /** ai-step only — set to 2 on the single automatic retry the engine runs
   *  after an idle stall (the stalled attempt closed with a `stalled` end
   *  event). Absent on first attempts. */
  attempt?: number
}

/** `loop_step_end` — appended+broadcast at each step's tail. A step torn down
 *  by manager shutdown / project removal (dispose, never settles) gets NO end
 *  event — the client reads missing-end + settled run as "interrupted". */
export interface LoopStepEndEventPayload {
  /** Matches the opening `loop_step`'s index. */
  index: number
  nodeId: string
  /** `stalled`: the idle watchdog tore the step down (no provider output for
   *  `idleMs`); `reason` says why. Older clients fold it into `failed`. */
  status: 'ok' | 'failed' | 'stalled'
  /** Shell steps: the real exit code. ai-step/decider: null (the one-shot
   *  executor result does not expose an exit code). */
  exitCode: number | null
  durationMs: number
  /** Decider steps only — the verdict the run actually routed by. */
  decision?: 'continue' | 'stop'
  /** `stalled`: `idle_timeout`. `failed`: `provider_limit` when the provider
   *  answered with a usage/rate-limit notice (the run stops at once). */
  reason?: 'idle_timeout' | 'provider_limit'
  /** `stalled` only — the idle budget that elapsed. */
  idleMs?: number
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

export type PausedHumanDecision =
  | { action: 'resume'; text: string; interruptId?: string; approve?: boolean; optionId?: string; reject?: boolean }
  | { action: 'stop' }
  /** `limit_paused` only: continue now on another provider (prior context goes along as historical data). */
  | { action: 'switch'; provider: string; model: string }

/** The daily budget a run is paused on — structurally the admission gate's
 *  409 body (`daily_budget_exceeded`), bound by the composition root. */
export interface LoopBudgetBreach {
  error: 'daily_budget_exceeded'
  scope: 'project' | 'desktop'
  /** Absent = the daily budget; `run` = the per-run soft cap (no reset window). */
  period?: 'week' | 'month' | 'run'
  budgetUsd: number
  spentUsd: number
  resetsAt: string | null
  detail: string
  action: string
}

/** Pause kind recorded on `loop_runs.restart_reason` and the paused event for a
 *  run stopped between AI steps by the daily budget. Resumable in place. */
export const BUDGET_PAUSED = 'budget_paused' as const

/** Pause kind recorded on `loop_runs.restart_reason` and the paused event for a
 *  run whose provider refused requests on its usage limit. It resumes on its own
 *  at `resumeAt` (unless the person cancels that), now, or on another provider. */
export const LIMIT_PAUSED = 'limit_paused' as const

/** What a `limit_paused` run waits for. Persisted (queue_state) so a restart keeps `resumeAt`. */
export interface LoopLimitPause {
  providerId: string
  /** When the provider accepts requests again (ISO); null when it did not say. */
  resumeAt: string | null
  /** Resume by itself at `resumeAt` (default on; the person can turn it off for this run). */
  autoResume: boolean
  /** The provider's own notice. */
  message: string
  pausedAt: string
  /** Legacy engine only: the step can continue on another provider. */
  switchable: boolean
}

/** How a resume answers a per-run soft cap: continue without it, or with a higher one. */
export type RunCapChoice = { ignore: true } | { raiseTo: number }

export type BudgetResumeResult =
  | { status: 'resumed' }
  | { status: 'not_budget_paused' }
  | { status: 'over_budget'; rejection: LoopBudgetBreach }

export type LoopRecordedResult = {
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

/** One parked run: a human decision (question/approval/LOOP_BLOCKED) or a
 *  `budget_paused` pause, resolved by resume/stop. */
export interface PausedRun {
  reason: string
  pending?: DefinitionInterrupt[]
  /** Present when the pause is `budget_paused` rather than a human decision. */
  budget?: LoopBudgetBreach
  /** Present when the pause is `limit_paused` (provider usage limit). */
  limit?: LoopLimitPause
  resolve: (decision: PausedHumanDecision) => void
}

/** LoopRunManager's optional composition bindings. */
export interface LoopRunManagerOptions {
  idleTimeoutMs?: number
  dailyBudget?: () => LoopBudgetBreach | null
  /** provider-quota: a run paused on a usage limit resumes by itself at the reset (default true). */
  autoResumeOnLimit?: () => boolean
  /** Default per-run soft cap (USD) a new run starts with; null/absent = none. */
  runCapDefault?: () => number | null
  /** Agent actions audit sink bound to this project (observing only). */
  agentAudit?: Pick<AgentAuditRecorder, 'record'> | null
  /** Observer after each Core workflow invocation ends (paused included);
   *  the composition reads Core's run records (architect clarifications).
   *  Advisory: a throw never affects the run. */
  onDefinitionInvocationEnd?: (runId: string, ticketIds: readonly number[], runtimeStatus: string) => void
  /** Resolver of Core MACHINE interrupts (`host-task`, Core `hostTasks`), bound at
   *  composition. Absent ⇒ a host task fails its node instead of waiting. */
  hostTasks?: () => HostTaskDispatcher | undefined
  /** Machine-wide installs a run asks the person for (Core `machineInstalls`), bound at composition.
   *  Absent ⇒ an install question waits for the person like any question and Install installs nothing. */
  machineInstalls?: () => MachineInstalls | undefined
  /** Cancels a Core run this process does not drive (paused or recovered after
   *  a restart): records the cancellation in Core and settles the run here.
   *  Bound at composition; absent ⇒ only Core is told. */
  cancelRetained?: (runId: string) => void
  /** The machine's run admission queue (capacity module), bound at composition.
   *  A Core run takes a slot before Core starts working and waits, queued, while
   *  the machine is at capacity. Absent or null ⇒ every run starts at once. */
  admission?: () => LoopRunAdmission | null
}

/** The part of the capacity module's admission queue the loop engine uses. */
export interface LoopRunAdmission {
  acquire(run: { runId: string; projectId: string; provider: string }, options?: { signal?: AbortSignal; onWait?: (waitingFor: string, position: number) => void }): Promise<() => void>
  waiting(runId: string): { waitingFor: string; since: number; position: number } | null
}
