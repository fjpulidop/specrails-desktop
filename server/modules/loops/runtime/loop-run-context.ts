/**
 * The per-run context shared by the units that execute one loop run: the
 * narrow host port onto LoopRunManager's resident state, the run's resolved
 * limits, its mutable traversal/accounting state, and the step result every
 * node executor returns to the traversal. Built once by `LoopRunManager._run`.
 */
import type { PausedHumanDecision } from './loop-run-contract'
import type { ChildProcess } from 'node:child_process'
import type { DbInstance } from '../../../db'
import type { WsMessage } from '../../../types'
import type { ProviderAdapter, ReasoningEffort } from '../../../providers/types'
import type { ProviderLimit } from '../../../provider-limit'
import type { LoopNode } from './loop-graph'
import type { LoopRunOutcome } from './loop-runs-store'
import type { DefinitionCompletion, DefinitionResumeControls } from './loop-definition-run'
import type { seedChangeId } from './loop-run-vars'
import type { LoopRunEvents } from './loop-run-events'
import type { InteractiveAiStepInput } from './loop-interactive-ai-step'
import type {
  AiStepResult,
  LoopBudgetBreach,
  LoopExecutors,
  LoopRunManagerOptions,
  LoopRunRequest,
  LoopStallReason,
  PausedRun,
} from './loop-run-contract'

/** What a run may touch of its manager: resident per-run registries, the
 *  budget gate and the definition execution claim. */
/** What the per-run cap projects ahead (see `LoopRunHost.budgetBreach`). */
export interface RunCapProjection { turnsAhead?: number; inFlight?: string; beforeStart?: boolean }

export interface LoopRunHost {
  readonly db: DbInstance
  readonly executors: LoopExecutors
  readonly options: LoopRunManagerOptions
  now(): number
  /** Advisory WebSocket delivery (never throws). */
  emit(msg: WsMessage): void
  isDisposed(): boolean
  isCancelled(runId: string): boolean
  setActiveChild(runId: string, child: ChildProcess): void
  clearActiveChild(runId: string): void
  activeStepRecovery(runId: string): string | undefined
  setActiveStepRecovery(runId: string, stepKey: string): void
  clearActiveStepRecovery(runId: string): void
  parkPause(runId: string, pause: PausedRun): void
  /** Resolve the run's parked pause if it is still parked (a scheduled limit resume). */
  resolvePause(runId: string, decision: PausedHumanDecision): boolean
  /**
   * The budget or per-run cap that stops the run before its next step, else null. The per-run cap
   * projects the next AI step's expected cost; `inFlight` names the AI step running now, whose
   * expected cost is added (`turnsAhead` 2 asks the same without a graph: two turns at the
   * largest so far); `beforeStart` projects the workflow's first AI step before Core starts.
   */
  budgetBreach(runId: string, options?: RunCapProjection): LoopBudgetBreach | null
  trackRunCap(runId: string, cap: { capUsd: number | null; cost: () => number; turns?: (options?: RunCapProjection) => import('../../execution').RunTurnCosts }): void
  untrackRunCap(runId: string): void
  /** An AI step started: a "run this step once" answer to the per-run cap is used up. */
  noteAiStepStarted(runId: string): void
  claimDefinition(req: LoopRunRequest & { runId: string }): void
  releaseDefinition(runId: string): void
  cancelResident(runId: string, graceful: boolean): void
  /** The person's pending Pause of this run (its Core request id), or null. */
  userPauseRequest(runId: string): string | null
  /** The pending Pause was answered: the run parked on it, or it no longer applies. */
  endUserPauseRequest(runId: string): void
  /** What the run's retained Core said about the cooperative pause (the Pause control needs it). */
  notePauseSupport(runId: string, supported: boolean): void
  runInteractiveAiStep(input: InteractiveAiStepInput): Promise<AiStepResult>
}

/** The run's guards, resolved once at launch. */
export interface LoopRunLimits {
  maxIterations: number
  /** Per-step AI timeout (ms) — undefined falls back to the executor default,
   *  0 disables the per-step watchdog entirely. */
  aiStepTimeoutMs: number | undefined
  /** Inactivity bound for every AI step (loop-step-idle). 0 ⇒ disabled. */
  idleTimeoutMs: number
  /** The graph's cost cap as authored (before the usage-telemetry check). */
  configuredMaxCostUsd: number | undefined
  /** The enforced cost cap: undefined when usage cannot be observed. */
  maxCostUsd: number | undefined
}

export interface FinalJobUsage {
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead: number | null
  tokensCacheCreate: number | null
  numTurns: number | null
}

/** Everything the traversal, the node executors, accounting and settlement
 *  read and write while the run executes. */
export interface LoopRunState {
  /** Next event seq of the run's job row (see LoopRunEvents.takeSeq). */
  seq: number
  /** 1-based ordinal of the last emitted step (monotonic across iterations). */
  stepNum: number
  /** The last emitted step still awaiting its `loop_step_end`. */
  openStep: { index: number; nodeId: string; startMs: number } | null
  /** Whole-run deadline (epoch ms); Infinity when the graph opts out. */
  deadline: number
  usageTelemetryAvailable: boolean
  outcome: LoopRunOutcome
  stallReason: LoopStallReason | undefined
  providerLimitHit: ProviderLimit | undefined
  /** Set when the person continued a limit-paused run on another provider: later steps use it. */
  engineOverride: { provider: string; model: string } | undefined
  // Failure diagnosis inputs (recovery module): the last failing step, its error text, Core's own record.
  failedStepId: string | undefined
  failureText: string | undefined
  coreFailure: unknown
  /** Latest port collision (`EADDRINUSE`) printed by the run, with its step (recovery `port_in_use`). */
  portConflict?: { port: number | null; line: string; stepId: string | null }
  iteration: number
  totalCost: number
  totalTokens: number
  totalDuration: number
  finalJobUsage: FinalJobUsage
  aiSessionId: string | undefined
  // Consecutive AI steps that hard-failed with no output (provider down /
  // out of quota / crashing). Reset on any step that runs or produces output.
  consecutiveAiFailures: number
  // Non-convergence guard: the working-tree fingerprint at the last Decider
  // verdict, and how many consecutive 'continue' verdicts have left it
  // UNCHANGED. Two zero-change iterations in a row ⇒ the loop is spinning
  // without progress (verify→fix→verify producing an identical tree) → abort
  // `stalled` instead of burning iterations/cost. Disabled when the executor
  // provides no `repoStateHash` or it can't read the tree.
  lastRepoHash: string | null
  consecutiveNoProgress: number
  // True for the step that runs immediately after a Decider 'continue' — that
  // step must see the cross-iteration history (the verdict it acts on). Mid-body
  // RESUMED steps already carry prior context in their session, so re-appending
  // the history there is redundant tokens; this flag keeps it off for them.
  justContinued: boolean
  // Transport/test failures are engine facts. A model's STOP cannot turn a
  // failed pass (or a failed final archive command) into a successful run.
  // A continue starts a fresh repair pass which can establish success again.
  passFailed: boolean
  // Fail-open honesty: flips true the first time a cost-bearing step yields no
  // priced cost while a cap is set (non-Claude estimate / unknown model / a
  // failed step) → the cap can under-count, so we warn once in the run log.
  costUnknownWarned: boolean
  // Honest total: flips true whenever a cost-bearing step ends without a priced
  // figure — most commonly a claude AI step killed by AI_STEP_TIMEOUT_MS, which
  // never emits its terminal `result` event, so its tokens AND cost are lost
  // (claude cost is all-or-nothing — no rate-card fallback for native-cost
  // providers). When set, the displayed loop total is a LOWER BOUND (`≥`), not
  // an exact figure — so an expensive step that billed $0 isn't read as cheap.
  costUncertain: boolean
  recoveryCounts: Map<string, number>
  phaseRecovery: { failedId: string; target: string; detail: string; artifactOnly: boolean } | undefined
  definitionCompletion: DefinitionCompletion | undefined
}

export interface LoopRunContext {
  readonly host: LoopRunHost
  /** The admitted, deep-cloned request (see normalizeLoopRunRequest). */
  readonly req: LoopRunRequest
  readonly runId: string
  readonly continuation: (DefinitionResumeControls & { resume: true }) | undefined
  readonly definitionEngine: boolean
  readonly adapter: ProviderAdapter
  readonly exactTicketIds: number[]
  readonly limits: LoopRunLimits
  readonly state: LoopRunState
  readonly events: LoopRunEvents
  /** Built-ins always resolve even if the caller omitted `constants`; custom
   *  values layer on top. Used to expand `{{const:*}}` in every node's text. */
  readonly constMap: Record<string, string>
  readonly history: string[]
  /** Run-scoped captured variables ({{run.<name>}}). */
  readonly runVars: Record<string, string>
  readonly seededChangeId: ReturnType<typeof seedChangeId>
  /** The run's capacity slot (definition runs with admission): a hold gives it back, its end takes one again. */
  capacity?: {
    yieldSlot(): void
    /** Take a slot again (queued when the machine/project/provider is full), counted against `provider` when given. */
    reclaim(provider?: string): Promise<'admitted' | 'stopped' | 'disposed'>
  }
}

/** One graph node as the traversal hands it to its executor. */
export interface LoopNodeFrame {
  node: LoopNode
  succs: LoopNode[]
  /** User-given step name (shown in the run log header); falls back per-kind. */
  label: string
  // The RAIL governs provider/model/effort for the whole run — nodes do
  // NOT override (decided in design: "lo que pongamos en el rail manda").
  provider: string
  model: string
  effort: ReasoningEffort | undefined
}

/** How a node executor hands control back to the traversal. */
export type NodeStep =
  /** Continue at `nodeId`; undefined means the graph ran out (settles failed). */
  | { kind: 'next'; nodeId: string | undefined }
  | { kind: 'settle'; outcome: LoopRunOutcome }
  /** The manager was disposed mid-step: startup recovery owns settlement. */
  | { kind: 'disposed' }

export const next = (nodeId: string | undefined): NodeStep => ({ kind: 'next', nodeId })
export const settle = (outcome: LoopRunOutcome): NodeStep => ({ kind: 'settle', outcome })
export const DISPOSED: NodeStep = { kind: 'disposed' }

/** The loop_runs counters as `updateLoopRunCounters` / `pauseLoopRun` take them. */
export function runCounters(state: LoopRunState): { iterationCount: number; totalCostUsd: number; totalTokens: number; totalDurationMs: number } {
  return {
    iterationCount: state.iteration,
    totalCostUsd: state.totalCost,
    totalTokens: state.totalTokens,
    totalDurationMs: state.totalDuration,
  }
}
