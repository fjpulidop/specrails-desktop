import { ChildProcess } from 'child_process'
import fsNode from 'fs'
import pathNode from 'path'
import { createInterface } from 'readline'
import type { Interface as ReadlineInterface } from 'readline'
import { newId as uuidv4 } from './ids'
import { treeKillSafe } from './util/win-spawn'
import type { WsMessage, LogMessage, Job, PhaseDefinition, JobPriority } from './types'
import { PRIORITY_WEIGHT, VALID_PRIORITIES } from './types'
import { resolveCommand } from './command-resolver'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { injectRepoMapEnv } from './repo-map'
import { spawnAiCli } from './util/cli-prompt'
import { extractDisplayText } from './util/stream-display'
import { resetPhases, setActivePhases } from './hooks'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import { isCodeExplorerEnabled, isInteractiveJobsEnabled } from './feature-flags'
import {
  snapshotWorkingTree,
  diffAgainstSnapshot,
  collectDiffPatches,
  recordProvenanceForJob,
  broadcastProvenanceUpdated,
  type WorkingTreeSnapshot,
} from './file-provenance'
import { finaliseInvocationResult } from './result-event'
import { randomUUID } from 'crypto'
import { getAdapter, type ProviderAdapter, type AdapterEvent, type ProviderId } from './providers'
import {
  buildProviderEnv,
  buildProviderRepoAccessArgs,
  formatProviderCommand,
  isReasoningEffortValidForModel,
  parseStreamEvents,
} from './providers/runtime'
import {
  GLOBAL_DEFAULTS_PROFILE_NAME,
  mergeProfileWithAgentDefaults,
  synthesizeProfileFromDefaults,
  type ResolvedProviderAgentDefaults,
} from './agent-defaults'
import { createCodexOtelBridge, type CodexOtelBridge } from './codex-otel-bridge'
import { createJob, deleteQueuedJob, finishJob, appendEvent, skipJob, getProjectSettings, getFreestylePrePrompt, DEFAULT_FREESTYLE_PRE_PROMPT, upsertQueuedJob } from './db'
import type { DbInstance, JobResult, QueuedJobRecord } from './db'
import { InteractiveJobSession, type SettleInfo, type InteractiveSpawnSpec } from './interactive-job-session'
import type { CommandInfo } from './config'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { extractTicketIdsFromCommand, readStore, resolveTicketStoragePath } from './ticket-store'
import { binaryOnPath } from './binary-probe'
import { ensureFrameworkAgents, ensureFrameworkCommandSubtrees } from './workspace-manager'
import { ensureClaudeTrusted } from './claude-trust'
import { resolveProjectExecution, type ProjectExecution } from './workspace-resolution'
import { applyWorktreeEnvPassthrough } from './project-env'
import { readCurrentFrameworkVersion } from './framework-manager'
import { ensureOpenspecShim, prependShimToPath, removeOpenspecShim, openspecShimDir } from './openspec-shim'
import { resolveHome } from './artifact-registry'

// ─── Telemetry env helpers ────────────────────────────────────────────────────

/** Build the OTLP/telemetry environment variable block for a spawned AI-CLI
 * process. Extracted as a pure function so it is unit-testable without a full
 * spawn.
 *
 * Provider-aware: claude and codex honour the standard `OTEL_*` env-var
 * convention (plus claude's `CLAUDE_CODE_ENABLE_TELEMETRY=1` master switch),
 * but the Gemini CLI does NOT — it reads its own `GEMINI_TELEMETRY_*` prefixed
 * vars (verified against google-gemini/gemini-cli docs/cli/telemetry.md) and
 * defaults to gRPC, so gemini rails need `GEMINI_TELEMETRY_OTLP_PROTOCOL=http`
 * and the OTLP endpoint pointed at our loopback receiver. Resource attributes
 * still flow via the standard `OTEL_RESOURCE_ATTRIBUTES` (read by the OTel JS
 * SDK that the Gemini CLI uses), so the receiver can route by job/project id.
 *
 * The `providerId` argument defaults to `'claude'` so existing claude/codex
 * call paths stay byte-identical. */
export function buildTelemetryEnv(
  jobId: string,
  projectId: string,
  desktopPort: number,
  extraResourceAttributes: Record<string, string | number> = {},
  providerId: ProviderId = 'claude',
): Record<string, string> {
  const baseAttrs: Array<[string, string]> = [
    ['specrails.job_id', jobId],
    ['specrails.project_id', projectId],
  ]
  for (const [k, v] of Object.entries(extraResourceAttributes)) {
    baseAttrs.push([k, String(v)])
  }
  const resourceAttributes = baseAttrs.map(([k, v]) => `${k}=${v}`).join(',')
  const endpoint = `http://127.0.0.1:${desktopPort}/otlp`

  if (providerId === 'gemini') {
    // Gemini CLI uses its own env contract (not OTEL_*). Defaults to gRPC, so we
    // must force the http transport to reach our OTLP/HTTP JSON receiver, and
    // target the `local` backend (not gcp). OTEL_RESOURCE_ATTRIBUTES is still
    // honoured by the underlying OTel SDK for job/project routing.
    return {
      GEMINI_TELEMETRY_ENABLED: 'true',
      GEMINI_TELEMETRY_TARGET: 'local',
      GEMINI_TELEMETRY_OTLP_ENDPOINT: endpoint,
      GEMINI_TELEMETRY_OTLP_PROTOCOL: 'http',
      GEMINI_TELEMETRY_TRACES_ENABLED: 'true',
      OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
    }
  }

  // claude (master switch + OTEL_*) and codex (OTEL_* only) — byte-identical to
  // the pre-fix block for both.
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_RESOURCE_ATTRIBUTES: resourceAttributes,
  }
}

/** Detect whether a project's installed specrails-core version supports the
 *  profile-aware pipeline (shipped in 4.1.0). Returns false when the version
 *  file is missing or unparseable so we default to legacy (safer). */
export function projectSupportsProfiles(projectPath: string): boolean {
  const candidates = [
    pathNode.join(projectPath, '.specrails', 'specrails-version'),
    pathNode.join(projectPath, '.specrails-version'),
  ]
  for (const p of candidates) {
    if (!fsNode.existsSync(p)) continue
    try {
      const raw = fsNode.readFileSync(p, 'utf8').trim()
      const [ma, mi, pa] = raw.split('.').map((n) => parseInt(n, 10))
      if (isNaN(ma) || isNaN(mi) || isNaN(pa)) return false
      return ma > 4 || (ma === 4 && mi > 1) || (ma === 4 && mi === 1 && pa >= 0)
    } catch {
      return false
    }
  }
  return false
}

/**
 * Distribute an integer `total` across `n` buckets via the largest-remainder
 * method so the per-bucket values sum EXACTLY back to `total` (no floor loss).
 * Mirrors smash-runner's `distributeInt` — used to split a multi-ticket job's
 * token / turn totals across one ai_invocations row per ticket
 * (COST-ACCOUNTING-AUDIT MED-7). Returns `undefined` per bucket when the input
 * is absent so the row carries NULL rather than a spurious 0.
 */
export function distributeIntEvenly(
  total: number | null | undefined,
  n: number,
): (number | undefined)[] {
  if (total === null || total === undefined) return new Array(n).fill(undefined)
  const t = Math.trunc(total)
  const base = Math.floor(t / n)
  let remainder = t - base * n
  const out: (number | undefined)[] = new Array(n)
  for (let i = 0; i < n; i++) {
    // Hand the leftover to the leading buckets; sign-safe for negative totals.
    if (remainder > 0) { out[i] = base + 1; remainder -= 1 }
    else if (remainder < 0) { out[i] = base - 1; remainder += 1 }
    else out[i] = base
  }
  return out
}

function maxNullable(
  left: number | null | undefined,
  right: number | null | undefined,
): number | null {
  const safeLeft = typeof left === 'number' && Number.isFinite(left) && left >= 0 ? left : null
  const safeRight = typeof right === 'number' && Number.isFinite(right) && right >= 0 ? right : null
  if (safeLeft == null) return safeRight
  if (safeRight == null) return safeLeft
  return Math.max(safeLeft, safeRight)
}

function sanitizeRecoveredResult(result: Partial<JobResult>): Partial<JobResult> {
  const safe = { ...result }
  const numeric: Array<keyof JobResult> = [
    'tokens_in', 'tokens_out', 'tokens_cache_read', 'tokens_cache_create',
    'total_cost_usd', 'num_turns', 'duration_ms', 'duration_api_ms',
  ]
  for (const key of numeric) {
    const value = safe[key]
    if (value !== undefined && (
      typeof value !== 'number' || !Number.isFinite(value) || value < 0
    )) {
      delete safe[key]
    }
  }
  if (safe.model !== undefined && typeof safe.model !== 'string') delete safe.model
  if (safe.session_id !== undefined && typeof safe.session_id !== 'string') delete safe.session_id
  return safe
}

const LOG_BUFFER_MAX = 5000
const LOG_BUFFER_DROP = 1000
export const DEFAULT_ZOMBIE_TIMEOUT_MS = 1_800_000 // 30 minutes

// ─── Error classes ────────────────────────────────────────────────────────────

export class ClaudeNotFoundError extends Error {
  constructor() {
    super('claude binary not found')
    this.name = 'ClaudeNotFoundError'
  }
}

export class CodexNotFoundError extends Error {
  constructor() {
    super('codex binary not found')
    this.name = 'CodexNotFoundError'
  }
}

export class JobNotFoundError extends Error {
  constructor() {
    super('Job not found')
    this.name = 'JobNotFoundError'
  }
}

export class JobAlreadyTerminalError extends Error {
  constructor() {
    super('Job is already in terminal state')
    this.name = 'JobAlreadyTerminalError'
  }
}

export class InvalidJobDependencyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidJobDependencyError'
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'zombie_terminated', 'skipped'])

/** Match an Freestyle rail command: `/specrails:freestyle #5 …` (or `/sr:…`). */
export const FREESTYLE_COMMAND_RE = /^\/(specrails|sr):freestyle\b/

export interface EnqueueOptions {
  dependsOnJobId?: string
  pipelineId?: string
  /** Agent profile name to apply for this spawn. If omitted, the QueueManager
   *  resolves via default. Pass null to force legacy
   *  mode (no profile), even if a default exists. */
  profileName?: string | null
  /** Per-job AI engine override (multi-provider projects). When omitted the
   *  job runs with the project's primary provider (this._adapter). Validated by
   *  the route layer against the project's installed providers. */
  provider?: ProviderId
  /** Per-job model override (e.g. freestyle rails let the user pick
   *  haiku/sonnet/opus per launch). For claude this becomes the `--model`
   *  value, taking precedence over the project orchestrator model. In-memory
   *  only — a queued job that survives a restart falls back to the default. */
  model?: string
  /** Per-job OVERRIDE of the interactive-by-default spawn (tri-state):
   *  `undefined` = default ON — every job whose resolved adapter supports
   *  persistent stdin (claude) spawns as an interactive session (freestyle
   *  idles until an explicit Finalize; every other command auto-settles when
   *  quiescent). `true` = force interactive where capable (same as default).
   *  `false` = force the legacy one-shot static spawn. Ignored (legacy spawn)
   *  for providers without persistent-stdin support and when the
   *  SPECRAILS_INTERACTIVE_JOBS kill-switch is off. In-memory only — a queued
   *  job that survives a restart loses the override and falls back to the
   *  default (which is interactive, so restart is durable). */
  interactive?: boolean
}

/** Optional route-owned durable work that must commit with queue admission.
 * QueueManager persists queued_jobs and invokes `commit` in one outer SQLite
 * transaction, then (and only then) broadcasts/drains. A thrown commit rolls
 * both DB and in-memory admission back. */
export interface DurableEnqueueAdmission {
  jobId: string
  commit: (db: DbInstance, job: Job) => void
}

interface OrphanRecoveryPayload {
  id: string
  command: string
  ticketIds: number[]
  pipelineId: string | null
  startedAt: string
  finishedAt: string
  provider: string
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCacheRead: number | null
  tokensCacheCreate: number | null
  totalCostUsd: number | null
  totalCostUsdEstimated: number | null
  numTurns: number | null
  durationMs: number | null
  durationApiMs: number | null
  sessionId: string | null
  /** Explicit terminal semantics for current outbox rows. Payloads written by
   * older builds omit these fields and replay as failed/aborted. */
  terminalStatus?: Exclude<Job['status'], 'queued' | 'running'>
  invocationStatus?: InvocationStatus
  ticketCompletionStatus?: 'done' | 'on_review'
  exitCode?: number | null
  /** Force-failed job whose child is still alive. Keep the completed outbox row
   * until its late close durably replaces the partial usage snapshot. */
  awaitingLateReconciliation?: boolean
  /** Exact recursive pre-start descendants captured before the parent becomes
   * deletable. Old payloads omit it and use dependency links as fallback. */
  descendants?: OrphanRecoveryDescendant[]
  causalOwnership?: boolean
}

interface OrphanRecoveryDescendant {
  id: string
  command: string
  parentId: string
  pipelineId: string | null
  priority: JobPriority
  causalOwnership?: boolean
}

interface OrphanRecoveryRow {
  job_id: string
  payload: string
  accounting_completed: number
  callback_completed: number
  terminal_completed: number
}

interface JobFinishedOptions {
  ticketCompletionStatus?: 'done' | 'on_review'
  /** Marks an at-least-once delivery from the durable orphan outbox. */
  recoveryReplay?: boolean
  /** Durable callback inputs. Recovery must not depend on a deletable jobs row. */
  recoveryCommand?: string
  recoveryTicketIds?: number[]
  recoveryDurationMs?: number | null
  recoveryCausalOwnership?: boolean
}

interface StageTerminalIntent {
  status: Exclude<Job['status'], 'queued' | 'running'>
  invocationStatus: InvocationStatus
  provider: string
  finishedAt: string
  exitCode: number | null
  result?: Partial<JobResult>
  interactive?: boolean
  ticketCompletionStatus?: 'done' | 'on_review'
  /** True for work that never reached a provider (queued cancel/skip). */
  accountingCompleted?: boolean
  /** A caller that already terminalized descendants in the same transaction
   * still leaves this false: replay delivers their callbacks idempotently. */
  terminalCompleted?: boolean
  descendants?: OrphanRecoveryDescendant[]
  /** Queued cancellation may have an unresolved queued parent that cannot be
   * referenced from jobs yet; pass null while retaining descendant ownership. */
  dependsOnJobId?: string | null
  awaitingLateReconciliation?: boolean
}

interface PendingLateReconciliation {
  code: number | null
  adapterEvents: readonly AdapterEvent[]
  adapter: ProviderAdapter
  spawnedModel?: string
}

// ─── QueueManager ─────────────────────────────────────────────────────────────

export class QueueManager {
  private _queue: string[]
  private _jobs: Map<string, Job>
  private _activeProcess: ChildProcess | null
  private _activeJobId: string | null
  private _paused: boolean
  private _killTimer: ReturnType<typeof setTimeout> | null
  private _cancelingJobs: Set<string>
  private _zombieJobs: Set<string>
  private _persistenceFailedJobs: Set<string>
  private _broadcast: (msg: WsMessage) => void
  private _db: any
  private _logBuffer: LogMessage[]
  private _commands: CommandInfo[]
  private _cwd: string | undefined
  private _zombieTimeoutMs: number
  private _inactivityTimer: ReturnType<typeof setTimeout> | null
  /** Set by shutdown(); once disposed the manager spawns no new jobs and never
   *  touches the (now possibly closed) DB from late child 'close' callbacks. */
  private _disposed: boolean
  /** Startup projection/capture failed and must be rebuilt before admissions
   * or resume may proceed. Cleared only by a complete restore pass. */
  private _restoreBlocked: boolean
  /** Invalidates async pre-spawn work across shutdown. A job captures the
   *  generation at start and must still own the active slot before spawning. */
  private _lifecycleGeneration: number

  private _getCostAlertThreshold: (() => number | null) | null
  private _getDesktopDailyBudget: (() => { budget: number | null; totalSpend: number }) | null
  private _adapter: ProviderAdapter
  /** Effective model to use when spawning processes. For Claude the adapter
   *  reads its own config; this is the override that gets passed via `--model`.
   *  For codex it controls the catalog model used at spawn time and as the
   *  fallback model name stamped onto the ai_invocations row. */
  private _resolvedModel: string | null
  private _agentDefaults: ((provider: string) => ResolvedProviderAgentDefaults | null) | null
  private _onJobFinished:
    | ((
        jobId: string,
        status: Job['status'],
        costUsd?: number,
        opts?: JobFinishedOptions,
      ) => void)
    | null
  /** Project-owned durable effects that are part of every queue admission
   *  (for example, recovery/rail ownership). Invoked after queued_jobs has
   *  been written but inside the same outer transaction, before any
   *  route-specific admission claim. */
  private _onJobAdmission: ((db: DbInstance, job: Job) => void) | null
  private _onBudgetExceeded: ((event: string, data: Record<string, unknown>) => void) | null
  /** Project ID used for OTEL resource attributes (Super mode only) */
  private _projectId: string | null
  /** Server port used to construct the OTLP endpoint URL for env injection */
  private _desktopPort: number
  /** Project slug used for per-job profile snapshots (Super mode only) */
  private _projectSlug: string | null
  /** Pending profile selection keyed by jobId — read at spawn time. Map
   * absence means default resolution; a present null forces legacy mode. */
  private _jobProfileSelection: Map<string, string | null>
  /** Pending per-job provider override keyed by jobId — restart-durable while
   *  queued and consumed only after durable promotion. */
  private _jobProviderSelection: Map<string, ProviderId>
  /** Resolved adapter id per RUNNING job, captured at `_startJob` time.
   *  Read by `_forceFailUnkillableJob` (and any other terminal path that runs
   *  without a child exit) to stamp `ai_invocations.provider` with the provider
   *  the child ACTUALLY ran on. Cleared with
   *  the other per-job maps at every teardown. In-memory only. */
  private _jobResolvedProvider: Map<string, ProviderId>
  /** Pending per-job model override keyed by jobId — restart-durable while
   *  queued and consumed only after durable promotion. */
  private _jobModelSelection: Map<string, string>
  /** Pre-spawn working-tree snapshot refs keyed by jobId — read at exit time
   *  by the Code-Explorer provenance hook. Cleared on job exit. */
  private _snapshotRefs: Map<string, WorkingTreeSnapshot>
  /** Per-job resolved execution context (relocate-artifacts gate), captured at
   *  spawn time so `_onJobExit`'s provenance hook uses the SAME repoDir the
   *  snapshot used (= project.path, never the workspace). Cleared on job exit. */
  private _jobExecution: Map<string, ProjectExecution>
  /** Per-job openspec PATH shim dir (relocated claude rails only). Cleaned up on
   *  job exit. In-memory map of jobId → shim dir. */
  private _openspecShims: Map<string, string> = new Map()
  /** Pending per-job interactive override keyed by jobId. Map absence means the
   *  spawn-time default; present false/true are both restart-durable. */
  private _jobInteractiveSelection: Map<string, boolean>
  /** Per-job PR-delivery mode (safe-pr-workflow), captured ONCE at spawn time by
   *  the SAME `isRailPrDeliveryEnabled()` read that injects
   *  SPECRAILS_GIT_AUTO=false — so a mid-flight env flip can never split one job
   *  between the ask-first on_review parking and the legacy done promotion.
   *  Restart-durable by construction (like the interactive gate): a queued job
   *  that survives a restart recomputes the flag at its own spawn. Consumed at
   *  settle (_onJobExit / _settleInteractiveJob) to thread
   *  `ticketCompletionStatus` into onJobFinished; cleared on every terminal
   *  path. In-memory only. */
  private _jobPrDelivery: Map<string, boolean>
  /** Live interactive job sessions keyed by jobId (the resident persistent-stdin
   *  child + per-turn accounting). Present only while an interactive job runs. */
  private _interactiveSessions: Map<string, InteractiveJobSession>
  /** Live per-job accounting handle for the RUNNING non-interactive job, keyed by
   *  jobId. Holds the growing `adapterEvents` array (by reference), the resolved
   *  adapter and the spawn model so `shutdown()` can flush an aborted
   *  ai_invocations row (with a rate-card cost estimate) for a job still in flight
   *  when the manager is torn down — otherwise `_onJobExit` early-returns on
   *  `_disposed` and the whole job's spend is lost (COST-ACCOUNTING-AUDIT CRIT-3).
   *  Cleared on every terminal path. In-memory only. */
  private _jobLiveAccounting: Map<string, { events: AdapterEvent[]; adapter: ProviderAdapter; model?: string }>
  private _jobReaders: Map<string, { stdout: ReadlineInterface; stderr: ReadlineInterface }>
  /** Jobs terminated by `_forceFailUnkillableJob` (SIGKILL-escalation failure)
   *  whose surviving child's `close` may still fire `_onJobExit` later. Guards
   *  against a duplicate ai_invocations row + a double `_onJobFinished`; a late
   *  close that carries REAL cost replaces the no-cost placeholder rows
   *  (COST-ACCOUNTING-AUDIT LOW-6). In-memory only. */
  private _forceFailedRowJobs: Set<string>
  /** Children that survived a failed SIGKILL escalation. They no longer own the
   * runnable slot, but shutdown must still attempt to terminate them. */
  private _forceFailedProcesses: Map<string, ChildProcess>
  /** Child exits whose terminal transaction failed. They deliberately retain
   * the active slot until shutdown/restart recovery succeeds. */
  private _terminalPersistenceBlockedJobs: Set<string>
  private _pendingLateReconciliations: Map<string, PendingLateReconciliation>
  /** Last terminal state emitted per pipeline. Descendant skipping and parent
   * settlement can both evaluate the same pipeline in one call stack; this
   * keeps the externally visible transition exactly-once. */
  private _emittedPipelineStatuses: Map<string, 'completed' | 'failed'>
  /** Test seam for the sole async pre-spawn dependency. Production resolves the
   *  implementation lazily to keep the plugin subsystem optional. */
  private _resolvePluginsForSpawn: ((
    projectPath: string,
    projectId: string,
    jobId: string,
    providerId?: string,
    legacyProviderId?: string,
    slug?: string,
  ) => Promise<{
    active: Array<{ name: string; version: string }>
    degraded: Array<{ name: string; reason: string }>
  }>) | null

  constructor(
    broadcast: (msg: WsMessage) => void,
    db?: any,
    commands?: CommandInfo[],
    cwd?: string,
    options?: {
      zombieTimeoutMs?: number
      getCostAlertThreshold?: () => number | null
      getDesktopDailyBudget?: () => { budget: number | null; totalSpend: number }
      provider?: ProviderId
      /** Effective model for codex spawns. If omitted, falls back to 'gpt-5.5'. */
      resolvedModel?: string
      /** Global Specrails Agents defaults layer (app Settings ▸ Specrails
       *  Agents). Resolved AT SPAWN TIME so a settings change applies to the
       *  next job with zero restart. Slots below every project-level choice
       *  and above the built-in adapter defaults. */
      agentDefaults?: (provider: string) => ResolvedProviderAgentDefaults | null
      /** Terminal-status callback. On `completed` exits the 4th arg carries the
       *  spawn-captured PR-delivery mode as `ticketCompletionStatus`
       *  (`'on_review'` when SPECRAILS_RAIL_DELIVER_PR was on at spawn — the
       *  universal ask-first methodology — else `'done'`). Failure statuses
       *  keep the legacy 3-arg call shape. */
      onJobFinished?: (
        jobId: string,
        status: Job['status'],
        costUsd?: number,
        opts?: JobFinishedOptions,
      ) => void
      /** Durable project-level work that must commit with every queue
       *  admission. Runs after queued_jobs persistence and before an optional
       *  route-owned DurableEnqueueAdmission callback. */
      onJobAdmission?: (db: DbInstance, job: Job) => void
      /** Fired when a daily/desktop budget is crossed so app-level consumers
       *  (webhooks) can deliver the budget event (the WS broadcast alone never
       *  reached webhook subscribers). */
      onBudgetExceeded?: (event: string, data: Record<string, unknown>) => void
      projectId?: string
      desktopPort?: number
      /** Project slug used to locate per-job profile snapshots at
       *  ~/.specrails/projects/<slug>/jobs/<jobId>/profile.json */
      projectSlug?: string
      /** Injectable async plugin resolver (tests). */
      resolvePluginsForSpawn?: (
        projectPath: string,
        projectId: string,
        jobId: string,
        providerId?: string,
        legacyProviderId?: string,
        slug?: string,
      ) => Promise<{
        active: Array<{ name: string; version: string }>
        degraded: Array<{ name: string; reason: string }>
      }>
    }
  ) {
    this._queue = []
    this._jobs = new Map()
    this._activeProcess = null
    this._activeJobId = null
    this._paused = false
    this._killTimer = null
    this._cancelingJobs = new Set()
    this._zombieJobs = new Set()
    this._persistenceFailedJobs = new Set()
    this._broadcast = broadcast
    this._db = db ?? null
    this._logBuffer = []
    this._commands = commands ?? []
    this._cwd = cwd
    this._inactivityTimer = null
    this._disposed = false
    this._restoreBlocked = false
    this._lifecycleGeneration = 0

    this._getCostAlertThreshold = options?.getCostAlertThreshold ?? null
    this._getDesktopDailyBudget = options?.getDesktopDailyBudget ?? null
    this._adapter = getAdapter(options?.provider ?? 'claude')
    this._resolvedModel = options?.resolvedModel ?? null
    this._agentDefaults = options?.agentDefaults ?? null
    this._onJobFinished = options?.onJobFinished ?? null
    this._onJobAdmission = options?.onJobAdmission ?? null
    this._onBudgetExceeded = options?.onBudgetExceeded ?? null
    this._resolvePluginsForSpawn = options?.resolvePluginsForSpawn ?? null
    this._projectId = options?.projectId ?? null
    this._desktopPort = options?.desktopPort ?? 4200
    this._projectSlug = options?.projectSlug ?? null
    this._jobProfileSelection = new Map()
    this._jobProviderSelection = new Map()
    this._jobResolvedProvider = new Map()
    this._jobModelSelection = new Map()
    this._snapshotRefs = new Map()
    this._jobExecution = new Map()
    this._jobInteractiveSelection = new Map()
    this._jobPrDelivery = new Map()
    this._interactiveSessions = new Map()
    this._jobLiveAccounting = new Map()
    this._jobReaders = new Map()
    this._forceFailedRowJobs = new Set()
    this._forceFailedProcesses = new Map()
    this._terminalPersistenceBlockedJobs = new Set()
    this._pendingLateReconciliations = new Map()
    this._emittedPipelineStatuses = new Map()

    const envTimeout = process.env.WM_ZOMBIE_TIMEOUT_MS !== undefined
      ? parseInt(process.env.WM_ZOMBIE_TIMEOUT_MS, 10)
      : null
    this._zombieTimeoutMs = options?.zombieTimeoutMs
      ?? (envTimeout !== null && !isNaN(envTimeout) ? envTimeout : DEFAULT_ZOMBIE_TIMEOUT_MS)

    if (this._db) {
      this._restoreFromDb()
    }

    // One-time startup sweep of stale openspec shim dirs left by rails that
    // exited without cleaning up (pre-fix builds / ungraceful shutdown).
    this._sweepStaleOpenspecShims()
  }

  setCommands(commands: CommandInfo[]): void {
    this._commands = commands
  }

  setZombieTimeout(ms: number): void {
    this._zombieTimeoutMs = ms
    // If a job is currently running, reset the timer with the new value
    if (this._activeJobId) {
      this._resetZombieTimer()
    }
  }

  /**
   * Tear down the manager: clear pending timers, terminate any active child
   * (SIGTERM, then SIGKILL after a grace period), and drop the DB handle so a
   * late child 'close' event cannot run prepared statements against a closed
   * connection (which would throw uncaught inside the EventEmitter listener and
   * crash the whole app). Idempotent. Must be called BEFORE the per-project DB
   * is closed (e.g. in ProjectRegistry.removeProject) and on graceful shutdown.
   */
  shutdown(): boolean {
    if (this._disposed) {
      if (!this._db) return true
      // A previous removal attempt may have stopped children but failed to
      // stage their terminal intent. Re-enter the idempotent shutdown path with
      // the retained ownership/maps so storage repair can converge it.
      this._disposed = false
      return this.shutdown()
    }
    this._disposed = true
    this._lifecycleGeneration += 1

    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer)
      this._inactivityTimer = null
    }
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }

    const ownedProcesses = new Set<ChildProcess>()
    if (this._activeProcess) ownedProcesses.add(this._activeProcess)
    for (const proc of this._forceFailedProcesses.values()) ownedProcesses.add(proc)
    for (const proc of ownedProcesses) {
      if (!proc.pid) continue
      const pid = proc.pid
      try {
        treeKillSafe(pid, 'SIGTERM', () => { /* best-effort on shutdown */ })
      } catch { /* best-effort */ }
      const grace = setTimeout(() => {
        try {
          treeKillSafe(pid, 'SIGKILL', () => { /* ignore */ })
        } catch { /* best-effort */ }
      }, 5000)
      // Do not let the grace timer keep the process alive on real shutdown.
      if (typeof grace.unref === 'function') grace.unref()
    }

    // Flush accounting for every in-flight job BEFORE dropping the DB handle:
    // the treeKill'd child's later 'close' hits `if (this._disposed) return` in
    // _onJobExit, so without this flush the whole job's spend is lost
    // (COST-ACCOUNTING-AUDIT CRIT-3 / HIGH-1). Best-effort — never throws.
    for (const jobId of Array.from(this._forceFailedRowJobs)) {
      const live = this._jobLiveAccounting.get(jobId)
      this._reconcileForceFailedJobExit(
        jobId,
        null,
        live?.events ?? [],
        live?.adapter ?? this._adapter,
        live?.model,
      )
    }
    for (const [jobId, pending] of Array.from(this._pendingLateReconciliations)) {
      this._reconcileForceFailedJobExit(
        jobId,
        pending.code,
        pending.adapterEvents,
        pending.adapter,
        pending.spawnedModel,
      )
    }
    if (!this._flushInFlightAccounting()) return false
    try {
      // A child may have closed through the disposed guard after an earlier
      // staging failure, leaving only its durable RUNNING row. Capture that row
      // from raw events before declaring a retried removal safe.
      this._captureOrphanRecoveries()
      this._resumeOrphanRecoveries()
    } catch (err) {
      console.error('[queue-manager] shutdown orphan capture failed:', err)
      return false
    }

    for (const readers of this._jobReaders.values()) {
      try { readers.stdout.close() } catch { /* best-effort */ }
      try { readers.stderr.close() } catch { /* best-effort */ }
    }
    this._jobReaders.clear()
    this._activeProcess = null
    this._activeJobId = null
    this._forceFailedProcesses.clear()
    // Tear down any resident interactive sessions (SIGTERM their children) so
    // teardown orphans no persistent claude process. dispose() does not settle
    // (the aborted row was already written by _flushInFlightAccounting).
    for (const session of this._interactiveSessions.values()) {
      try { session.dispose() } catch { /* best-effort */ }
    }
    this._interactiveSessions.clear()
    // Release any per-job provenance snapshots so teardown leaves no map entries.
    this._snapshotRefs.clear()
    this._jobExecution.clear()
    this._jobResolvedProvider.clear()
    this._jobPrDelivery.clear()
    this._jobLiveAccounting.clear()
    this._openspecShims.clear()
    // Project removal must retain this durable DB until every critical outbox
    // effect converges. App shutdown may still close the connection externally;
    // the file/outbox survives for next startup.
    const recoveryComplete = this._terminalRecoveryComplete()
    if (recoveryComplete) this._db = null
    return recoveryComplete
  }

  private _terminalRecoveryComplete(): boolean {
    const db = this._db
    if (!db) return true
    try {
      const rows = db.prepare(`
        SELECT job_id, payload, accounting_completed, callback_completed, terminal_completed
          FROM orphan_job_recovery
      `).all() as OrphanRecoveryRow[]
      const running = db.prepare(
        `SELECT 1 FROM jobs WHERE status = 'running' AND owner = 'queue' LIMIT 1`,
      ).get()
      if (running) return false
      for (const row of rows) {
        const { payload } = this._decodeRecoveryPayload(row.job_id, row.payload)
        if (
          row.accounting_completed === 0 ||
          row.callback_completed === 0 ||
          row.terminal_completed === 0 ||
          payload.awaitingLateReconciliation
        ) return false
      }
      return true
    } catch (err) {
      console.error('[queue-manager] terminal recovery completion check failed:', err)
      return false
    }
  }

  /** Atomically terminalize a job and create its immutable recovery intent.
   * No accounting, ticket/rail callback, dependent mutation or user-visible
   * terminal broadcast may happen before this transaction commits. */
  private _stageTerminalIntent(job: Job, input: StageTerminalIntent): OrphanRecoveryPayload {
    const db = this._db
    if (!db) throw new Error('Cannot stage a terminal job without its project database')

    const result = input.result ?? {}
    const payload: OrphanRecoveryPayload = {
      id: job.id,
      command: job.command,
      ticketIds: this._extractTicketIds(job.command),
      pipelineId: job.pipelineId,
      startedAt: job.startedAt ?? input.finishedAt,
      finishedAt: input.finishedAt,
      provider: input.provider,
      model: result.model ?? null,
      tokensIn: result.tokens_in ?? null,
      tokensOut: result.tokens_out ?? null,
      tokensCacheRead: result.tokens_cache_read ?? null,
      tokensCacheCreate: result.tokens_cache_create ?? null,
      totalCostUsd: result.total_cost_usd ?? null,
      totalCostUsdEstimated: result.total_cost_usd_estimated == null
        ? 0
        : (result.total_cost_usd_estimated ? 1 : 0),
      numTurns: result.num_turns ?? null,
      durationMs: result.duration_ms ?? null,
      durationApiMs: result.duration_api_ms ?? null,
      sessionId: result.session_id ?? null,
      descendants: input.descendants ?? (
        input.status === 'completed' ? [] : this._snapshotRecoveryDescendants(job.id)
      ),
      causalOwnership: job.causalOwnership === true,
      terminalStatus: input.status,
      invocationStatus: input.invocationStatus,
      ticketCompletionStatus: input.ticketCompletionStatus,
      exitCode: input.exitCode,
      awaitingLateReconciliation: input.awaitingLateReconciliation,
    }
    const encoded = JSON.stringify(
      this._decodeRecoveryPayload(job.id, JSON.stringify(payload)).payload,
    )
    const stage = db.transaction(() => {
      // Works for both a running row and an async pre-spawn admission. The
      // nested promotion transaction removes queued_jobs in the same commit.
      createJob(db, {
        id: job.id,
        command: job.command,
        started_at: payload.startedAt,
        provider: payload.provider,
        priority: job.priority,
        depends_on_job_id: input.dependsOnJobId === undefined
          ? job.dependsOnJobId
          : input.dependsOnJobId,
        pipeline_id: job.pipelineId,
        interactive: input.interactive,
        causal_ownership: job.causalOwnership === true,
      })
      finishJob(db, job.id, {
        exit_code: input.exitCode ?? -1,
        status: input.status,
        tokens_in: payload.tokensIn ?? undefined,
        tokens_out: payload.tokensOut ?? undefined,
        tokens_cache_read: payload.tokensCacheRead ?? undefined,
        tokens_cache_create: payload.tokensCacheCreate ?? undefined,
        total_cost_usd: payload.totalCostUsd ?? undefined,
        total_cost_usd_estimated: !!payload.totalCostUsdEstimated,
        num_turns: payload.numTurns ?? undefined,
        model: payload.model ?? undefined,
        duration_ms: payload.durationMs ?? undefined,
        duration_api_ms: payload.durationApiMs ?? undefined,
        session_id: payload.sessionId ?? undefined,
      })
      db.prepare(`
        INSERT INTO orphan_job_recovery (
          job_id, payload, accounting_completed, callback_completed, terminal_completed
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(job_id) DO NOTHING
      `).run(
        job.id,
        encoded,
        input.accountingCompleted || !this._projectId ? 1 : 0,
        this._onJobFinished ? 0 : 1,
        input.terminalCompleted ? 1 : 0,
      )
      const intent = db.prepare(`SELECT payload FROM orphan_job_recovery WHERE job_id = ?`)
        .get(job.id) as { payload: string } | undefined
      if (!intent || intent.payload !== encoded) {
        throw new Error(`A different terminal recovery intent already owns job ${job.id}`)
      }
      const persisted = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(job.id) as
        | { status: string }
        | undefined
      if (persisted?.status !== input.status) {
        throw new Error(`Failed to persist terminal status ${input.status} for ${job.id}`)
      }
    })
    stage()
    this._terminalPersistenceBlockedJobs.delete(job.id)
    return payload
  }

  /** Graceful shutdown uses the same terminal intent as ordinary exits. */
  private _stageGracefulAbort(
    job: Job,
    payload: OrphanRecoveryPayload,
    interactive: boolean,
  ): void {
    this._stageTerminalIntent(job, {
      status: 'failed',
      invocationStatus: 'aborted',
      provider: payload.provider,
      finishedAt: payload.finishedAt,
      exitCode: -1,
      interactive,
      result: {
        tokens_in: payload.tokensIn ?? undefined,
        tokens_out: payload.tokensOut ?? undefined,
        tokens_cache_read: payload.tokensCacheRead ?? undefined,
        tokens_cache_create: payload.tokensCacheCreate ?? undefined,
        total_cost_usd: payload.totalCostUsd ?? undefined,
        total_cost_usd_estimated: !!payload.totalCostUsdEstimated,
        num_turns: payload.numTurns ?? undefined,
        model: payload.model ?? undefined,
        duration_ms: payload.durationMs ?? undefined,
        duration_api_ms: payload.durationApiMs ?? undefined,
        session_id: payload.sessionId ?? undefined,
      },
      descendants: payload.descendants,
    })
    job.status = 'failed'
    job.finishedAt = payload.finishedAt
    job.exitCode = -1
  }

  /**
   * Stage every in-flight job before shutdown/project removal, then immediately
   * drain the callback and terminal checkpoints while the DB and project owners
   * are still alive. Any failed critical callback remains durable for restart.
   */
  private _flushInFlightAccounting(): boolean {
    const db = this._db
    const projectId = this._projectId
    if (!db || !projectId) return true
    let staged = true

    // ── Active non-interactive rail ──────────────────────────────────────────
    const activeJobId = this._activeJobId
    if (activeJobId && !this._interactiveSessions.has(activeJobId)) {
      const job = this._jobs.get(activeJobId)
      if (job && job.status === 'running') {
        try {
          const live = this._jobLiveAccounting.get(activeJobId)
          const { result: normalised, estimated } = live
            ? finaliseInvocationResult(live.adapter, live.events, { fallbackModel: live.model })
            : { result: {} as ReturnType<typeof finaliseInvocationResult>['result'], estimated: false }
          const provider = live?.adapter.id ?? this._jobResolvedProvider.get(activeJobId) ?? this._adapter.id
          const finishedAt = new Date().toISOString()
          this._stageGracefulAbort(job, {
            id: activeJobId,
            command: job.command,
            ticketIds: this._extractTicketIds(job.command),
            pipelineId: job.pipelineId,
            startedAt: job.startedAt ?? finishedAt,
            finishedAt,
            provider,
            model: normalised.model ?? null,
            tokensIn: normalised.tokens_in ?? null,
            tokensOut: normalised.tokens_out ?? null,
            tokensCacheRead: normalised.tokens_cache_read ?? null,
            tokensCacheCreate: normalised.tokens_cache_create ?? null,
            totalCostUsd: normalised.total_cost_usd ?? null,
            totalCostUsdEstimated: estimated ? 1 : 0,
            numTurns: normalised.num_turns ?? null,
            durationMs: normalised.duration_ms ?? null,
            durationApiMs: normalised.duration_api_ms ?? null,
            sessionId: normalised.session_id ?? null,
          }, false)
          this._broadcast({ type: 'spending.invalidated', projectId })
        } catch (err) {
          staged = false
          console.error('[queue-manager] shutdown flush (active job) failed:', err)
        }
      }
    }

    // ── Resident interactive sessions ────────────────────────────────────────
    for (const [jobId, session] of this._interactiveSessions) {
      const job = this._jobs.get(jobId)
      if (!job || job.status !== 'running') continue
      try {
        const snap = session.snapshotForAbort()
        const finishedAt = new Date().toISOString()
        const provider = this._jobResolvedProvider.get(jobId) ?? 'claude'
        this._stageGracefulAbort(job, {
          id: jobId,
          command: job.command,
          ticketIds: this._extractTicketIds(job.command),
          pipelineId: job.pipelineId,
          startedAt: job.startedAt ?? finishedAt,
          finishedAt,
          provider,
          model: snap.model ?? null,
          tokensIn: snap.totals.tokens_in,
          tokensOut: snap.totals.tokens_out,
          tokensCacheRead: snap.totals.tokens_cache_read,
          tokensCacheCreate: snap.totals.tokens_cache_create,
          totalCostUsd: snap.totals.total_cost_usd,
          totalCostUsdEstimated: snap.estimated ? 1 : 0,
          numTurns: snap.totals.num_turns,
          durationMs: snap.activeDurationMs,
          durationApiMs: null,
          sessionId: snap.sessionId ?? null,
        }, true)
        this._broadcast({ type: 'spending.invalidated', projectId })
      } catch (err) {
        staged = false
        console.error('[queue-manager] shutdown flush (interactive job) failed:', err)
      }
    }

    // Complete local ticket/rail and dependent invariants now (important for
    // project removal, where this DB may never reopen). Failed critical effects
    // stay in orphan_job_recovery and are replayed on the next project load.
    try {
      this._resumeOrphanRecoveries()
    } catch (err) {
      console.error('[queue-manager] shutdown recovery replay failed:', err)
    }
    return staged
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  private _assertMutable(): void {
    if (this._disposed) throw new Error('Queue manager is shutting down')
  }

  enqueue(
    command: string,
    priorityOrOpts?: JobPriority | EnqueueOptions,
    opts?: EnqueueOptions,
    durableAdmission?: DurableEnqueueAdmission,
  ): Job {
    this._assertMutable()
    if (this._restoreBlocked) {
      throw new Error('Queue recovery is incomplete; retry resume after repairing storage')
    }
    // Support both: enqueue(cmd, priority, opts) and enqueue(cmd, opts)
    let priority: JobPriority = 'normal'
    let resolvedOpts: EnqueueOptions | undefined = opts
    if (typeof priorityOrOpts === 'string') {
      priority = priorityOrOpts
    } else if (priorityOrOpts && typeof priorityOrOpts === 'object') {
      resolvedOpts = priorityOrOpts
    }

    const rawDependsOnJobId = resolvedOpts?.dependsOnJobId as unknown
    let dependsOnJobId: string | null = null
    if (rawDependsOnJobId !== undefined) {
      if (typeof rawDependsOnJobId !== 'string' || !rawDependsOnJobId.trim()) {
        throw new InvalidJobDependencyError('dependsOnJobId must be a non-empty string')
      }
      dependsOnJobId = rawDependsOnJobId.trim()
      const parentStatus = this._getDependencyStatus(dependsOnJobId)
      if (
        parentStatus &&
        TERMINAL_STATUSES.has(parentStatus) &&
        parentStatus !== 'completed'
      ) {
        throw new InvalidJobDependencyError(
          `Cannot depend on job ${dependsOnJobId} because it is ${parentStatus}`,
        )
      }
    }

    // Resolve the adapter for THIS job: the per-job provider override when set
    // and installed, else the project's primary provider. The binary check
    // below probes the chosen provider's CLI.
    const enqueueAdapter =
      resolvedOpts?.provider ? getAdapter(resolvedOpts.provider) : this._adapter
    if (enqueueAdapter.id === 'codex') {
      if (!binaryOnPath('codex')) throw new CodexNotFoundError()
    } else if (enqueueAdapter.id === 'claude') {
      if (!binaryOnPath('claude')) throw new ClaudeNotFoundError()
    } else if (!binaryOnPath(enqueueAdapter.binary)) {
      // Future providers reuse the same pattern: a quick `which` probe via
      // the adapter's binary. We don't throw a typed *NotFoundError because
      // none has been declared; the adapter's id surfaces in the error.
      throw new Error(`${enqueueAdapter.binary} binary not found`)
    }

    if ((durableAdmission || this._onJobAdmission) && !this._db) {
      throw new Error('Durable enqueue admission requires a project database')
    }
    const id = durableAdmission?.jobId ?? uuidv4()
    if (typeof id !== 'string' || !id.trim()) {
      throw new Error('Durable enqueue admission requires a non-empty jobId')
    }
    if (this._jobs.has(id)) {
      throw new Error(`Job ${id} is already admitted`)
    }
    if (dependsOnJobId === id) {
      throw new InvalidJobDependencyError('A job cannot depend on itself')
    }
    const job: Job = {
      id,
      command,
      status: 'queued',
      queuePosition: null,
      priority,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      dependsOnJobId,
      pipelineId: resolvedOpts?.pipelineId ?? null,
      skipReason: null,
      resultText: null,
      causalOwnership: false,
    }

    this._jobs.set(id, job)

    // Record profile selection (if provided) so spawn time can pick it up.
    // `undefined` means "use default resolution"; `null` means "force legacy".
    if (resolvedOpts?.profileName !== undefined) {
      this._jobProfileSelection.set(id, resolvedOpts.profileName)
    }

    // Pin the adapter resolved at admission even when no override was supplied.
    // A restart or a long pre-spawn await must not reinterpret this job under a
    // project default that changed after the user submitted it.
    this._jobProviderSelection.set(id, enqueueAdapter.id)

    // Record per-job model override (e.g. freestyle model picker).
    if (resolvedOpts?.model) {
      this._jobModelSelection.set(id, resolvedOpts.model)
    }

    // Record per-job interactive OVERRIDE only when explicitly provided
    // (tri-state — see EnqueueOptions.interactive). Absent ⇒ the spawn-time
    // default decides, so a queued job that survives a restart (map lost)
    // still spawns interactive.
    if (typeof resolvedOpts?.interactive === 'boolean') {
      this._jobInteractiveSelection.set(id, resolvedOpts.interactive)
    }

    // Insert at the correct position based on priority (higher priority first, FIFO within same level)
    const weight = PRIORITY_WEIGHT[priority]
    let insertIdx = this._queue.length
    for (let i = 0; i < this._queue.length; i++) {
      const existing = this._jobs.get(this._queue[i])
      if (existing && PRIORITY_WEIGHT[existing.priority] < weight) {
        insertIdx = i
        break
      }
    }
    this._queue.splice(insertIdx, 0, id)

    this._recomputePositions()
    try {
      // Admission is not successful until it is durable. A best-effort write
      // here would acknowledge work that disappears on the next process crash.
      if (durableAdmission || this._onJobAdmission) {
        const db = this._db!
        const commitAdmission = db.transaction(() => {
          this._persistQueuedState(true)
          this._onJobAdmission?.(db, job)
          durableAdmission?.commit(db, job)
        })
        commitAdmission()
      } else {
        this._persistQueuedState(true)
      }
    } catch (err) {
      const idx = this._queue.indexOf(id)
      if (idx !== -1) this._queue.splice(idx, 1)
      this._jobs.delete(id)
      this._jobProfileSelection.delete(id)
      this._jobProviderSelection.delete(id)
      this._jobModelSelection.delete(id)
      this._jobInteractiveSelection.delete(id)
      this._recomputePositions()
      throw err
    }
    this._broadcastQueueState()
    this._drainQueue()

    return job
  }

  cancel(jobId: string): 'canceled' | 'canceling' {
    this._assertMutable()
    const job = this._jobs.get(jobId)
    if (!job) {
      throw new JobNotFoundError()
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new JobAlreadyTerminalError()
    }
    if (this._terminalPersistenceBlockedJobs.has(jobId)) {
      throw new Error(`Job ${jobId} is awaiting durable terminal recovery`)
    }

    // `_startJob` marks the in-memory job running before its async plugin
    // verification finishes, while the durable admission intentionally remains
    // in queued_jobs until spawn. Treat that reserved/no-child window as
    // cancelable pre-start work: a Set-only cancel intent would be lost by a
    // process crash and the command would run after restart.
    const isPreparingToSpawn =
      job.status === 'running' &&
      this._activeJobId === jobId &&
      this._activeProcess === null &&
      !this._interactiveSessions.has(jobId)

    if (job.status === 'queued' || isPreparingToSpawn) {
      this._cancelBeforeSpawn(job, isPreparingToSpawn)
      return 'canceled'
    }

    // job.status === 'running'
    // Interactive jobs own a resident child via the session (not _activeProcess),
    // so route their cancel through the session: SIGTERM → settle sees the
    // canceling flag and stamps 'canceled'.
    const interactiveSession = this._interactiveSessions.get(jobId)
    if (interactiveSession) {
      this._cancelingJobs.add(jobId)
      interactiveSession.finalize()
      return 'canceling'
    }
    this._kill(jobId)
    return 'canceling'
  }

  /**
   * Cancel queued or asynchronously-preparing work as one durable state change.
   * The parent cancellation, recursive dependent skips, queued-row removals and
   * the surviving queue positions commit together. In-memory state is restored
   * exactly when any write fails, so the API never reports a cancellation whose
   * dependency chain can later resurrect from a partial SQLite commit.
   */
  private _cancelBeforeSpawn(job: Job, wasPreparingToSpawn: boolean): void {
    type MutableJobSnapshot = Pick<
      Job,
      'status' | 'queuePosition' | 'startedAt' | 'finishedAt' | 'exitCode' | 'skipReason'
    >

    const previousQueue = [...this._queue]
    const previousActiveJobId = this._activeJobId
    const snapshots = new Map<string, MutableJobSnapshot>()
    const snapshot = (candidate: Job): void => {
      if (snapshots.has(candidate.id)) return
      snapshots.set(candidate.id, {
        status: candidate.status,
        queuePosition: candidate.queuePosition,
        startedAt: candidate.startedAt,
        finishedAt: candidate.finishedAt,
        exitCode: candidate.exitCode,
        skipReason: candidate.skipReason,
      })
    }

    snapshot(job)
    const canceledAt = new Date().toISOString()
    const parentIndex = this._queue.indexOf(job.id)
    if (parentIndex !== -1) this._queue.splice(parentIndex, 1)
    job.status = 'canceled'
    job.finishedAt = canceledAt
    job.exitCode = null
    job.queuePosition = null

    const skipped: Job[] = []
    const stageDependentSkips = (parentJobId: string, reason: string): void => {
      const children = Array.from(this._jobs.values()).filter(
        (candidate) => candidate.dependsOnJobId === parentJobId && candidate.status === 'queued',
      )
      for (const child of children) {
        snapshot(child)
        const index = this._queue.indexOf(child.id)
        if (index !== -1) this._queue.splice(index, 1)
        child.status = 'skipped'
        child.finishedAt = canceledAt
        child.queuePosition = null
        child.skipReason = reason
        skipped.push(child)
        stageDependentSkips(child.id, `Parent job ${child.id} was skipped`)
      }
    }
    stageDependentSkips(job.id, `Parent job ${job.id} was canceled`)
    this._recomputePositions()

    try {
      if (this._db) {
        const db = this._db
        const persistCancellation = db.transaction(() => {
          // Persist a canceled tombstone even for work that never reached the
          // provider. Besides making the cancellation auditable, this satisfies
          // jobs.depends_on_job_id while descendant skipped rows are inserted;
          // using canceledAt for both timestamps truthfully records zero runtime.
          const persistedParent = job.dependsOnJobId
            ? db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(job.dependsOnJobId)
            : null
          this._stageTerminalIntent(job, {
            status: 'canceled',
            invocationStatus: 'aborted',
            provider: this._jobResolvedProvider.get(job.id)
              ?? this._jobProviderSelection.get(job.id)
              ?? this._adapter.id,
            finishedAt: canceledAt,
            exitCode: -1,
            accountingCompleted: true,
            // A not-yet-started parent lives only in queued_jobs and therefore
            // cannot satisfy jobs.depends_on_job_id's FK. Terminal history does
            // not need to retain that unresolved edge; descendants of THIS job
            // still reference the canceled tombstone inserted here.
            dependsOnJobId: persistedParent ? job.dependsOnJobId : null,
            descendants: skipped.map((child) => ({
              id: child.id,
              command: child.command,
              parentId: child.dependsOnJobId ?? job.id,
              pipelineId: child.pipelineId,
              priority: child.priority,
              causalOwnership: child.causalOwnership === true,
            })),
          })

          for (const child of skipped) {
            const exists = db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(child.id)
            if (exists) {
              skipJob(db, child.id, child.skipReason ?? `Parent job ${job.id} was canceled`)
            } else {
              db.prepare(
                `INSERT INTO jobs (
                   id, command, started_at, status, skip_reason, finished_at,
                   depends_on_job_id, pipeline_id, causal_ownership
                 ) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?, ?)`,
              ).run(
                child.id,
                child.command,
                child.finishedAt ?? canceledAt,
                child.skipReason,
                child.finishedAt ?? canceledAt,
                child.dependsOnJobId,
                child.pipelineId,
                child.causalOwnership === true ? 1 : 0,
              )
            }
            deleteQueuedJob(db, child.id)
          }

          // Nested better-sqlite3 transactions use a savepoint; every surviving
          // position therefore shares the cancellation's outer commit.
          this._persistQueuedState(true)
        })
        persistCancellation()
      }
    } catch (err) {
      this._queue = previousQueue
      this._activeJobId = previousActiveJobId
      for (const [id, previous] of snapshots) {
        const candidate = this._jobs.get(id)
        if (candidate) Object.assign(candidate, previous)
      }
      this._recomputePositions()
      throw err
    }

    if (wasPreparingToSpawn && this._activeJobId === job.id) {
      // Invalidates every `_canContinueStart` check when the pending await
      // resolves; no provider process can be created after this point.
      this._activeJobId = null
    }
    this._cancelingJobs.delete(job.id)

    const terminalIds = [job.id, ...skipped.map((child) => child.id)]
    for (const id of terminalIds) {
      this._jobProviderSelection.delete(id)
      this._jobResolvedProvider.delete(id)
      this._jobModelSelection.delete(id)
      this._jobProfileSelection.delete(id)
      this._jobInteractiveSelection.delete(id)
      this._jobExecution.delete(id)
      this._snapshotRefs.delete(id)
      this._jobPrDelivery.delete(id)
      this._jobLiveAccounting.delete(id)
      this._cleanupOpenspecShim(id)
    }

    let accountingReady = true
    if (this._db) {
      accountingReady = this._resumeOrphanRecoveries()
    } else {
      for (const child of skipped) {
        try {
          this._onJobFinished?.(child.id, 'skipped', undefined)
        } catch (err) {
          console.error(`[QueueManager] onJobFinished(skipped) failed for ${child.id}: ${(err as Error).message}`)
        }
      }
      try {
        this._onJobFinished?.(job.id, 'canceled', undefined)
      } catch (err) {
        console.error(`[QueueManager] onJobFinished(canceled) failed for ${job.id}: ${(err as Error).message}`)
      }
      const affectedPipelines = new Set<string>()
      if (job.pipelineId) affectedPipelines.add(job.pipelineId)
      for (const child of skipped) {
        if (child.pipelineId) affectedPipelines.add(child.pipelineId)
      }
      for (const pipelineId of affectedPipelines) this._checkPipelineStatus(pipelineId)
    }
    if (!accountingReady) {
      this._paused = true
      this._persistQueueState()
    }
    this._broadcastQueueState()
    if (accountingReady) this._drainQueue()
  }

  pause(): void {
    this._assertMutable()
    this._paused = true
    this._persistQueueState()
    this._broadcastQueueState()
  }

  resume(): void {
    this._assertMutable()
    if (this._restoreBlocked) {
      this._restoreFromDb()
      if (this._restoreBlocked) {
        this._paused = true
        this._persistQueueState()
        this._broadcastQueueState()
        return
      }
    }
    for (const [jobId, pending] of Array.from(this._pendingLateReconciliations)) {
      this._reconcileForceFailedJobExit(
        jobId,
        pending.code,
        pending.adapterEvents,
        pending.adapter,
        pending.spawnedModel,
      )
    }
    if (this._pendingLateReconciliations.size > 0) {
      this._paused = true
      this._persistQueueState()
      this._broadcastQueueState()
      return
    }
    if (this._terminalPersistenceBlockedJobs.size > 0) {
      this._paused = true
      this._persistQueueState()
      this._broadcastQueueState()
      return
    }
    if (!this._resumeOrphanRecoveries()) {
      // A provider run whose ledger is still pending must remain ahead of new
      // admissions; otherwise budget enforcement can undercount spend.
      this._paused = true
      this._persistQueueState()
      this._broadcastQueueState()
      return
    }
    this._paused = false
    this._persistQueueState()
    this._broadcastQueueState()
    this._drainQueue()
  }

  reorder(jobIds: string[]): void {
    this._assertMutable()
    if (jobIds.some((id) => typeof id !== 'string')) {
      throw new Error('jobIds must contain only string IDs')
    }
    if (jobIds.length !== this._queue.length) {
      throw new Error('jobIds must contain exactly the IDs of all currently-queued jobs')
    }
    const queuedSet = new Set(this._queue)
    const incomingSet = new Set(jobIds)

    if (incomingSet.size !== jobIds.length || queuedSet.size !== this._queue.length) {
      throw new Error('jobIds must contain exactly the IDs of all currently-queued jobs')
    }
    for (const id of jobIds) {
      if (!queuedSet.has(id)) {
        throw new Error(`Job ${id} is not in queued state`)
      }
    }
    for (let index = 1; index < jobIds.length; index += 1) {
      const previous = this._jobs.get(jobIds[index - 1])
      const current = this._jobs.get(jobIds[index])
      if (
        previous && current &&
        PRIORITY_WEIGHT[previous.priority] < PRIORITY_WEIGHT[current.priority]
      ) {
        throw new Error('Cannot reorder jobs across priority levels; update priority first')
      }
    }

    const previousQueue = [...this._queue]
    this._queue = [...jobIds]
    this._recomputePositions()
    try {
      this._persistQueuedState(true)
    } catch (err) {
      this._queue = previousQueue
      this._recomputePositions()
      throw err
    }

    this._broadcastQueueState()
  }

  updatePriority(jobId: string, priority: JobPriority): void {
    this._assertMutable()
    const job = this._jobs.get(jobId)
    if (!job) throw new JobNotFoundError()
    if (job.status !== 'queued') {
      throw new Error('Can only change priority of queued jobs')
    }

    const previousPriority = job.priority
    const previousQueue = [...this._queue]
    job.priority = priority

    // Remove from queue and re-insert at correct position
    const idx = this._queue.indexOf(jobId)
    if (idx !== -1) this._queue.splice(idx, 1)

    const weight = PRIORITY_WEIGHT[priority]
    let insertIdx = this._queue.length
    for (let i = 0; i < this._queue.length; i++) {
      const existing = this._jobs.get(this._queue[i])
      if (existing && PRIORITY_WEIGHT[existing.priority] < weight) {
        insertIdx = i
        break
      }
    }
    this._queue.splice(insertIdx, 0, jobId)

    this._recomputePositions()
    try {
      this._persistQueuedState(true)
    } catch (err) {
      job.priority = previousPriority
      this._queue = previousQueue
      this._recomputePositions()
      throw err
    }
    this._broadcastQueueState()
  }

  getJobs(): Job[] {
    return Array.from(this._jobs.values())
  }

  getActiveJobId(): string | null {
    return this._activeJobId
  }

  isPaused(): boolean {
    return this._paused
  }

  getLogBuffer(): LogMessage[] {
    return [...this._logBuffer]
  }

  /** True while an interactive session is resident for this job. */
  isInteractiveJob(jobId: string): boolean {
    return this._interactiveSessions.has(jobId)
  }

  /** Settle mode of the LIVE interactive session for this job ('finalize' for
   *  freestyle, 'auto' for everything else), or null when no session is
   *  resident (unknown / not interactive / already settled). Feeds the
   *  `interactiveSettleMode` field on GET /jobs/:id. */
  getInteractiveSettleMode(jobId: string): 'finalize' | 'auto' | null {
    return this._interactiveSessions.get(jobId)?.getSettleMode() ?? null
  }

  /** Feed one more user prompt to a running interactive job (queued behind the
   *  active turn). Returns false when the job isn't an active interactive
   *  session (unknown / already finalized / not interactive). */
  sendInteractiveTurn(jobId: string, text: string): boolean {
    this._assertMutable()
    const session = this._interactiveSessions.get(jobId)
    if (!session) return false
    return session.send(text)
  }

  /** User-initiated finalize for an interactive job: SIGTERM the resident child;
   *  the settle path stamps the summed totals + 'completed' status. Returns false
   *  when the job isn't an active interactive session. */
  finalizeInteractive(jobId: string): boolean {
    this._assertMutable()
    const session = this._interactiveSessions.get(jobId)
    if (!session) return false
    session.finalize()
    return true
  }

  // ─── Private methods ────────────────────────────────────────────────────────

  phasesForCommand(command: string): PhaseDefinition[] {
    return this._phasesForCommand(command)
  }

  /**
   * Resolve a slash command into a full prompt with $ARGUMENTS substituted.
   * Delegates to the shared resolveCommand utility in command-resolver.ts.
   */
  private _resolveCommand(command: string): string {
    return resolveCommand(command, this._cwd ?? process.cwd())
  }

  private _phasesForCommand(command: string): PhaseDefinition[] {
    // Extract slug from command strings like "/specrails:implement #5" or "implement"
    const firstToken = command.trim().split(/\s+/)[0]
    const slug = firstToken.includes(':') ? firstToken.split(':').pop()! : firstToken.replace(/^\//, '')
    const info = this._commands.find((c) => c.slug === slug)
    return info?.phases ?? []
  }

  private _extractTicketIds(command: string): number[] {
    return extractTicketIdsFromCommand(command)
  }

  /**
   * Write the ai_invocations row(s) for one job exit (surface='job'). Requires
   * `this._db` and `this._projectId` — callers guard.
   *
   * Multi-ticket attribution (COST-ACCOUNTING-AUDIT MED-7): a batch rail carries
   * N tickets but the whole cost previously landed on `ticketIds[0]`, so every
   * other ticket read $0 in topTickets / the per-ticket spending-summary. When
   * >1 ticket is present we now write ONE row per ticket with cost/tokens/turns
   * split — cost & duration evenly (float), token & turn totals via
   * largest-remainder so the splits sum EXACTLY to the original (mirrors
   * smash-runner). `surface_ref_id` stays the plain jobId for the single-ticket
   * (and no-ticket) case so it is byte-compatible with the old behaviour; a split
   * row uses `<jobId>#t<ticketId>` so the N rows never collide.
   *
   * Returns the surface_ref_id(s) written so a caller (LOW-6 reconciliation) can
   * locate/replace the rows later.
   */
  private _recordJobInvocations(params: {
    jobId: string
    provider: string
    status: InvocationStatus
    startedAt: string
    finishedAt: string | null
    ticketIds: number[]
    estimated: boolean
    result: {
      tokens_in?: number
      tokens_out?: number
      tokens_cache_read?: number
      tokens_cache_create?: number
      total_cost_usd?: number
      num_turns?: number
      model?: string
      session_id?: string
      duration_ms?: number
      duration_api_ms?: number
    }
    conversationId?: string | null
  }): string[] {
    const { jobId, provider, status, startedAt, finishedAt, ticketIds, estimated, result } = params
    const db = this._db
    const projectId = this._projectId
    if (!db || !projectId) return []

    // Single-ticket / no-ticket: one row, plain jobId (byte-compatible).
    if (ticketIds.length <= 1) {
      recordInvocation(db, {
        id: randomUUID(),
        project_id: projectId,
        provider,
        surface: 'job',
        surface_ref_id: jobId,
        ticket_id: ticketIds[0] ?? null,
        conversation_id: params.conversationId ?? null,
        status,
        started_at: startedAt,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        ...result,
      })
      return [jobId]
    }

    // Multi-ticket: split across one row per ticket. Cost & duration split evenly
    // as floats; token & turn totals via largest-remainder (sum exactly to total).
    const n = ticketIds.length
    const evenSplit = (v: number | undefined): number | undefined =>
      v === undefined ? undefined : v / n
    const tokensIn = distributeIntEvenly(result.tokens_in, n)
    const tokensOut = distributeIntEvenly(result.tokens_out, n)
    const cacheRead = distributeIntEvenly(result.tokens_cache_read, n)
    const cacheCreate = distributeIntEvenly(result.tokens_cache_create, n)
    const numTurns = distributeIntEvenly(result.num_turns, n)
    const refIds: string[] = []
    ticketIds.forEach((ticketId, i) => {
      const refId = `${jobId}#t${ticketId}`
      refIds.push(refId)
      recordInvocation(db, {
        id: randomUUID(),
        project_id: projectId,
        provider,
        surface: 'job',
        surface_ref_id: refId,
        ticket_id: ticketId,
        conversation_id: params.conversationId ?? null,
        status,
        started_at: startedAt,
        finished_at: finishedAt,
        total_cost_usd_estimated: estimated,
        tokens_in: tokensIn[i],
        tokens_out: tokensOut[i],
        tokens_cache_read: cacheRead[i],
        tokens_cache_create: cacheCreate[i],
        total_cost_usd: evenSplit(result.total_cost_usd),
        num_turns: numTurns[i],
        model: result.model,
        session_id: result.session_id,
        duration_ms: evenSplit(result.duration_ms),
        duration_api_ms: evenSplit(result.duration_api_ms),
      })
    })
    return refIds
  }

  /**
   * Local calendar-day start, expressed as a UTC-ISO instant so it compares
   * correctly against the UTC-ISO `started_at` strings (which sort
   * lexicographically). Fixes the UTC `date('now')` boundary that bucketed spend
   * near local midnight on the wrong day (MED-5). Overridable in tests via the
   * injected clock is unnecessary — it reads the real local day.
   */
  private _localDayStartIso(): string {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
  }

  /**
   * Evaluate the per-project and app-level daily budgets and pause the queue when
   * exceeded. Called on every terminal job exit (MED-5). Best-effort: never
   * throws (the DB may have been closed mid-job).
   */
  private _enforceDailyBudget(): void {
    const db = this._db
    if (!db) return
    try {
      // Per-project daily budget: sum the ai_invocations ledger for the LOCAL day
      // across ALL statuses + surfaces (failed/aborted runs cost real money).
      const dailyBudgetRow = db.prepare(
        `SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`
      ).get() as { value: string } | undefined
      if (dailyBudgetRow && this._projectId) {
        const dailyBudget = parseFloat(dailyBudgetRow.value)
        if (dailyBudget > 0) {
          const fromIso = this._localDayStartIso()
          const spendRow = db.prepare(
            `SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM ai_invocations
             WHERE project_id = ? AND total_cost_usd IS NOT NULL AND started_at >= ?`
          ).get(this._projectId, fromIso) as { total: number }
          const dailySpend = spendRow.total
          if (dailySpend >= dailyBudget) {
            const wasPaused = this._paused
            this._paused = true
            if (!wasPaused) {
              db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
            }
            this._broadcast({ type: 'daily_budget_exceeded', projectId: '', dailySpend, budget: dailyBudget, queuePaused: true })
            try {
              this._onBudgetExceeded?.('daily_budget_exceeded', { dailySpend, budget: dailyBudget, queuePaused: true })
            } catch { /* webhook delivery is best-effort */ }
          }
        }
      }

      // App-level daily budget enforcement (totalSpend computed by the caller).
      if (this._getDesktopDailyBudget) {
        const { budget: desktopBudget, totalSpend: desktopTotalSpend } = this._getDesktopDailyBudget()
        if (desktopBudget != null && desktopBudget > 0 && desktopTotalSpend >= desktopBudget) {
          const wasPaused = this._paused
          this._paused = true
          if (!wasPaused) {
            db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
          }
          this._broadcast({ type: 'desktop_daily_budget_exceeded', projectId: '', desktopDailySpend: desktopTotalSpend, desktopBudget, queuePaused: true })
          try {
            this._onBudgetExceeded?.('desktop_daily_budget_exceeded', { desktopDailySpend: desktopTotalSpend, desktopBudget, queuePaused: true })
          } catch { /* webhook delivery is best-effort */ }
        }
      }
    } catch (err) {
      console.error('[queue-manager] daily-budget enforcement failed (db unavailable?):', err)
    }
  }

  private _buildImplementAttachmentContext(command: string): string {
    if (!this._cwd || !this._projectSlug) return ''

    const ticketIds = this._extractTicketIds(command)
    if (ticketIds.length === 0) return ''

    try {
      const store = readStore(this._resolveTicketsPath())
      const sections: string[] = []

      for (const ticketId of ticketIds) {
        const storeAttachmentIds = new Set(
          (store.tickets[String(ticketId)]?.attachments ?? []).map((attachment) => attachment.id),
        )
        const diskAttachmentIds = attachmentManager
          .list(this._projectSlug, ticketId)
          .map((attachment) => attachment.id)
        const attachmentIds = Array.from(new Set([...storeAttachmentIds, ...diskAttachmentIds]))
        if (attachmentIds.length === 0) continue

        const blocks = attachmentManager.getPromptBlocksSync(this._projectSlug, ticketId, attachmentIds)
        if (blocks.length === 0) continue

        sections.push(`## Ticket #${ticketId} Attached Resources\n\n${blocks.join('\n\n')}`)
      }

      if (sections.length === 0) return ''

      return '\n\nIMPORTANT: Referenced ticket attachments are also part of the spec context. ' +
        `You have explicit permission to read local attachment files stored under ~/.specrails/projects/${this._projectSlug}/attachments/<ticketId>/.\n\n` +
        `${USER_ATTACHMENT_SYSTEM_NOTE}\n\n` +
        'If a <user-attachment> block contains only a local file path, open that file directly before implementing.\n\n' +
        sections.join('\n\n')
    } catch (err) {
      console.warn(`[queue-manager] failed to build attachment context: ${(err as Error).message}`)
      return ''
    }
  }

  /**
   * Build the Claude prompt for an Freestyle job. Freestyle does NOT invoke
   * a slash command: it sends the resolved pre-prompt followed by the full spec
   * text of every ticket referenced in the command. Fully reconstructible from
   * the command (`/specrails:freestyle #<id> …`) + the local ticket store, so a
   * queued job survives a server restart without losing the prompt.
   */
  private _buildFreestylePrompt(command: string): string {
    const pre = this._db ? getFreestylePrePrompt(this._db) : DEFAULT_FREESTYLE_PRE_PROMPT
    const ticketIds = this._extractTicketIds(command)
    const specs: string[] = []
    if (this._cwd) {
      try {
        const store = readStore(this._resolveTicketsPath())
        for (const ticketId of ticketIds) {
          const ticket = store.tickets[String(ticketId)]
          if (!ticket) continue
          const body = (ticket.description ?? '').trim()
          specs.push(`# Spec #${ticketId}: ${ticket.title}\n\n${body || '_(no description)_'}`)
        }
      } catch (err) {
        console.warn(`[queue-manager] failed to read specs for freestyle: ${(err as Error).message}`)
      }
    }
    const specBlock = specs.length > 0
      ? specs.join('\n\n---\n\n')
      : `(No spec content found for ${ticketIds.map((id) => `#${id}`).join(', ') || 'this rail'}.)`
    return `${pre}\n\n---\n\n${specBlock}`
  }

  private _drainQueue(): void {
    if (this._disposed) return
    if (this._activeJobId !== null) return
    if (this._paused) return
    if (this._queue.length === 0) return

    // Defense in depth for state restored from old/corrupt builds or mutated by
    // an invalid caller: only unique, presently-queued jobs may reach start.
    // In particular, a duplicated id must not relaunch after its first run
    // becomes terminal.
    const seen = new Set<string>()
    const normalizedQueue: string[] = []
    const removedJobIds: string[] = []
    for (const id of this._queue) {
      if (seen.has(id)) continue
      seen.add(id)
      const candidate = this._jobs.get(id)
      if (candidate?.status === 'queued') normalizedQueue.push(id)
      else removedJobIds.push(id)
    }
    if (normalizedQueue.length !== this._queue.length) {
      this._queue = normalizedQueue
      this._recomputePositions()
      this._persistQueuedState(false, removedJobIds)
      if (this._queue.length === 0) return
    }

    // App/project budgets are durable policies, not merely post-job alerts.
    // Re-check before reserving a slot so a different project that crossed the
    // app-wide cap cannot be followed by a fresh spawn from this queue.
    this._enforceDailyBudget()
    if (this._paused) return

    const readyIndex = this._queue.findIndex(id => {
      const job = this._jobs.get(id)
      return job?.status === 'queued' && this._isDependencyMet(job)
    })

    if (readyIndex === -1) return

    const nextJobId = this._queue.splice(readyIndex, 1)[0]
    // A3: reserve the active slot SYNCHRONOUSLY, before _startJob's awaits
    // (plugin verify, profile snapshot). Otherwise a second _drainQueue triggered
    // during those awaits (a concurrent /spawn, or the synchronous N-job loop of
    // an Freestyle rail launch) still sees _activeJobId === null and starts a
    // second job in the same working tree, with _activeProcess/_activeJobId then
    // clobbered so cancel/zombie-kill hits the wrong child.
    this._activeJobId = nextJobId
    this._recomputePositions()
    // Keep every still-queued position in sync while preserving the selected
    // job's durable admission until createJob promotes it just before spawn.
    this._persistQueuedState(false, [], nextJobId)
    void this._startJob(nextJobId).catch((err) => {
      console.error(`[QueueManager] _startJob(${nextJobId}) threw before spawn: ${(err as Error)?.message}`)
      // Only release if we never established a child (else _onJobExit owns cleanup).
      if (this._activeJobId === nextJobId && this._activeProcess === null) {
        // Stamp the job terminal — _onJobExit never runs without a child, so the
        // job would otherwise wedge 'running' forever and never fire
        // onJobFinished (rail/webhook never settle) and leak its per-job maps.
        this._activeJobId = null
        const terminalPersisted = this._failWedgedJob(
          nextJobId,
          (err as Error)?.message ?? 'startup failure',
        )
        if (terminalPersisted) this._drainQueue()
      }
    })
  }

  /**
   * Stamp a job terminal-failed when `_startJob` threw BEFORE a child was ever
   * established (so no `_onJobExit` will run). Mirrors _onJobExit's terminal
   * bookkeeping: in-memory + DB status, per-job map cleanup, onJobFinished, and
   * a queue-state broadcast. Best-effort and never throws.
   */
  private _failWedgedJob(jobId: string, reason: string): boolean {
    const job = this._jobs.get(jobId)
    const previousJobState = job ? {
      status: job.status,
      queuePosition: job.queuePosition,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      exitCode: job.exitCode,
      skipReason: job.skipReason,
    } : null
    // The wedge can land before _startJob set status='running' (an early throw in
    // execution/agent resolution) OR after it. Either way the job is terminal-
    // failed now — capture a finished_at to drive the invocation row regardless.
    const finishedAt = new Date().toISOString()
    if (job && !TERMINAL_STATUSES.has(job.status)) {
      job.status = 'failed'
      job.startedAt ??= finishedAt
      job.finishedAt = finishedAt
    }
    // Side effects are valid only after the terminal row and queued-admission
    // removal commit together. In particular, a failed promotion must leave
    // queued_jobs intact for restart instead of manufacturing accounting and a
    // completion callback for a terminal state SQLite never accepted.
    let terminalPersisted = !this._db && !!job
    if (this._db) {
      try {
        if (!job) throw new Error(`Missing in-memory job ${jobId}`)
        const durationMs = job.startedAt
          ? new Date(finishedAt).getTime() - new Date(job.startedAt).getTime()
          : undefined
        this._stageTerminalIntent(job, {
          status: 'failed',
          invocationStatus: 'failed',
          provider: this._jobResolvedProvider.get(jobId)
            ?? this._jobProviderSelection.get(jobId)
            ?? this._adapter.id,
          finishedAt,
          exitCode: -1,
          result: { duration_ms: durationMs },
        })
        terminalPersisted = true
      } catch (err) {
        // The transaction rollback preserves queued_jobs (or the pre-existing
        // running row) for durable recovery. Do not delete it in a later
        // best-effort cleanup and do not publish false terminal side effects.
        console.error(`[queue-manager] startup failure persistence failed for ${jobId}:`, err)
      }

    }
    if (!terminalPersisted) {
      let durableQueued = false
      if (this._db) {
        try {
          durableQueued = !!this._db.prepare(
            'SELECT 1 FROM queued_jobs WHERE id = ?',
          ).get(jobId)
        } catch {
          // If even the read fails, fail closed below by pausing the queue.
        }
      }

      if (job && previousJobState) {
        Object.assign(job, previousJobState)
        if (durableQueued) {
          // The provider never acquired the admission. Restore the same
          // pre-execution semantics in memory and put it back at the front, but
          // pause instead of immediately retrying a persistently-broken DB.
          job.status = 'queued'
          job.startedAt = null
          job.finishedAt = null
          job.exitCode = null
          job.skipReason = null
          if (!this._queue.includes(jobId)) this._queue.unshift(jobId)
          this._recomputePositions()
          this._persistQueuedState()
        } else {
          // Promotion already consumed queued_jobs, so there is no admission to
          // retry. Retain ownership of the childless RUNNING row and make
          // resume fail closed until shutdown/startup recovery stages it.
          this._activeJobId = jobId
          this._terminalPersistenceBlockedJobs.add(jobId)
        }
      }

      // Make the degraded state visible and stable. A user can explicitly
      // resume after repairing storage; enqueue cannot silently spin the same
      // failed promotion in a tight loop.
      this._paused = true
      this._persistQueueState()

      const resolvedProvider = this._jobResolvedProvider.get(jobId)
      if (resolvedProvider) this._jobProviderSelection.set(jobId, resolvedProvider)
      this._jobResolvedProvider.delete(jobId)
      this._jobExecution.delete(jobId)
      this._snapshotRefs.delete(jobId)
      this._jobPrDelivery.delete(jobId)
      this._jobLiveAccounting.delete(jobId)
      this._cleanupOpenspecShim(jobId)
      this._broadcastQueueState()
      console.error(
        `[QueueManager] job ${jobId} remains durably ${durableQueued ? 'queued' : 'unsettled'} after startup failure: ${reason}`,
      )
      return false
    }

    // Clear per-job selection/snapshot maps (none were consumed by a spawn).
    this._jobExecution.delete(jobId)
    this._snapshotRefs.delete(jobId)
    this._jobModelSelection.delete(jobId)
    this._jobProfileSelection.delete(jobId)
    this._jobProviderSelection.delete(jobId)
    this._jobResolvedProvider.delete(jobId)
    this._jobInteractiveSelection.delete(jobId)
    this._jobPrDelivery.delete(jobId)
    this._jobLiveAccounting.delete(jobId)
    // A wedged job may have had its openspec shim materialised already (the
    // wedge can land after _startJob's shim setup). Mirror the settle path.
    this._cleanupOpenspecShim(jobId)
    let accountingReady = true
    if (this._db) {
      accountingReady = this._resumeOrphanRecoveries()
      if (!accountingReady) {
        this._paused = true
        this._persistQueueState()
      }
    } else if (terminalPersisted) {
      try {
        this._onJobFinished?.(jobId, 'failed', undefined)
      } catch {
        /* onJobFinished is best-effort */
      }
      this._skipDependents(jobId, `Parent job ${jobId} failed`)
      if (job?.pipelineId) this._checkPipelineStatus(job.pipelineId)
    }
    this._persistQueueState()
    this._broadcastQueueState()
    console.error(`[QueueManager] job ${jobId} failed before spawn: ${reason}`)
    return accountingReady
  }

  /**
   * Remove the per-job openspec PATH shim (relocated claude rails only) from
   * BOTH the in-memory map and disk. Idempotent and best-effort: a no-op when
   * no shim was materialised for the job. Centralised so every terminal path
   * (_settleInteractiveJob, _onJobExit, _failWedgedJob, the SIGKILL-failure
   * recovery) cleans up the dir + map entry the same way — the fix for the
   * lifecycle-cleanup asymmetry that leaked one chmod-700 dir per rail.
   */
  private _cleanupOpenspecShim(jobId: string): void {
    const shim = this._openspecShims.get(jobId)
    if (!shim) return
    this._openspecShims.delete(jobId)
    if (this._projectSlug) {
      removeOpenspecShim(this._projectSlug, jobId, resolveHome())
    }
  }

  /**
   * Startup sweep of stale per-job openspec shim dirs left on disk by rails that
   * crashed/were killed before this code shipped the terminal-path cleanup (or
   * by an ungraceful server exit). Best-effort: removes every `<jobId>` subdir
   * under `~/.specrails/projects/<slug>/openspec-shim/`. The dirs are pure
   * regeneratable PATH shims (no state), so an over-eager sweep is harmless —
   * the next spawn re-materialises its own. No-op when no slug is set.
   */
  private _sweepStaleOpenspecShims(): void {
    if (!this._projectSlug) return
    try {
      const home = resolveHome()
      const shimRoot = pathNode.dirname(openspecShimDir(this._projectSlug, '_', home))
      if (!fsNode.existsSync(shimRoot)) return
      for (const entry of fsNode.readdirSync(shimRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        try {
          fsNode.rmSync(pathNode.join(shimRoot, entry.name), { recursive: true, force: true })
        } catch {
          /* best-effort per-entry */
        }
      }
    } catch {
      /* best-effort: a missing shim root / unreadable dir is fine */
    }
  }

  /**
   * Resolve the adapter for a job at spawn time: the per-job provider override
   * when present and registered, else the project's primary adapter. Pending
   * selections remain intact until createJob durably promotes the admission;
   * a pre-promotion failure can therefore be retried without semantic drift.
   */
  private _resolveJobAdapter(jobId: string): ProviderAdapter {
    const override = this._jobProviderSelection.get(jobId)
    if (override) {
      try {
        return getAdapter(override)
      } catch {
        /* fall through to primary */
      }
    }
    return this._adapter
  }

  /** Consume restart-durable pre-spawn selections only after queued_jobs has
   * been atomically promoted to jobs. Runtime state already holds every value
   * needed by the child at that point. */
  private _consumePendingSelections(jobId: string): void {
    this._jobProviderSelection.delete(jobId)
    this._jobModelSelection.delete(jobId)
    this._jobProfileSelection.delete(jobId)
    this._jobInteractiveSelection.delete(jobId)
  }

  /**
   * Resolve the relocate-artifacts execution context for this manager's project.
   * The gate: relocated only when a registry entry exists AND core has populated
   * the workspace; otherwise legacy (cwd = project.path, empty env) — preserving
   * byte-identical behaviour for every existing in-repo project. Falls back to a
   * legacy resolution rooted at `this._cwd` when slug/cwd are unavailable
   * (non-Super contexts / tests that construct the manager without a slug).
   */
  private _resolveExecution(): ProjectExecution {
    const repoDir = this._cwd ?? process.cwd()
    if (!this._projectSlug || !this._cwd) {
      return {
        relocated: false,
        cwd: repoDir,
        repoDir,
        workspaceDir: null,
        ticketsPath: pathNode.join(repoDir, '.specrails', 'local-tickets.json'),
        backlogConfigPath: pathNode.join(repoDir, '.specrails', 'backlog-config.json'),
        profilesDir: pathNode.join(repoDir, '.specrails', 'profiles'),
        pluginsStateDir: pathNode.join(repoDir, '.specrails', 'plugins'),
        fileSummariesDir: pathNode.join(repoDir, '.specrails', 'file-summaries'),
        specrailsDir: pathNode.join(repoDir, '.specrails'),
        stateDir: pathNode.join(repoDir, '.claude'),
        env: {},
      }
    }
    return resolveProjectExecution({ slug: this._projectSlug, path: this._cwd })
  }

  /**
   * Resolve the local-tickets.json path honouring the relocate-artifacts gate.
   * Relocated ⇒ the registry entry's ticketsPath (workspace). Legacy ⇒
   * `resolveTicketStoragePath(this._cwd)` which preserves the
   * integration-contract.json custom-storagePath behaviour for existing repos.
   */
  private _resolveTicketsPath(): string {
    const exec = this._resolveExecution()
    if (exec.relocated) return exec.ticketsPath
    return resolveTicketStoragePath(this._cwd ?? process.cwd())
  }

  /**
   * Spawn an interactive session. The job row is created with the `interactive`
   * flag set; the resident child runs the first turn (the freestyle prompt, or
   * the slash command itself — spike-verified to expand over stream-json stdin)
   * and stays alive for follow-up turns until settle. `_activeProcess` is left
   * null — the session owns the child; the active SLOT (`_activeJobId`,
   * reserved by _drainQueue) is held until settle. QueueManager's own zombie
   * timer is never armed for interactive jobs; 'auto' sessions instead run
   * their OWN wedge detector on the same inactivity budget, while 'finalize'
   * sessions idle awaiting the human by design (no timer).
   */
  private _startInteractiveJob(
    jobId: string,
    job: Job,
    adapter: ProviderAdapter,
    spec: InteractiveSpawnSpec,
    firstPrompt: string,
    settleMode: 'finalize' | 'auto',
  ): void {
    if (this._db) {
      // Promotion is the execution boundary. Propagate any failure to
      // `_drainQueue` before constructing the session: starting a child while
      // its queued admission remains replayable would duplicate the command on
      // the next process restart.
      createJob(this._db, {
        id: jobId,
        command: job.command,
        started_at: job.startedAt!,
        provider: adapter.id,
        priority: job.priority,
        depends_on_job_id: job.dependsOnJobId,
        pipeline_id: job.pipelineId,
        interactive: true,
        causal_ownership: job.causalOwnership === true,
      })
    }
    this._consumePendingSelections(jobId)

    const session = new InteractiveJobSession({
      jobId,
      projectId: this._projectId ?? '',
      db: this._db,
      adapter,
      broadcast: this._broadcast,
      onSettle: (info) => this._settleInteractiveJob(jobId, info),
      settleMode,
      // Auto sessions arm a wedge detector on the SAME inactivity budget the
      // one-shot path uses; finalize sessions idle awaiting the human.
      zombieTimeoutMs: settleMode === 'auto' ? this._zombieTimeoutMs : undefined,
    })
    this._interactiveSessions.set(jobId, session)
    session.start(spec, firstPrompt)
    this._broadcastQueueState()
  }

  /**
   * Terminal bookkeeping for an interactive job (called once by the session's
   * onSettle — human finalize, auto-quiescence, wedge, or crash). Releases the
   * active slot, stamps the job's terminal status + finished_at (token/cost
   * totals were already accumulated per turn), writes a single ai_invocations
   * row with the summed usage, records Code-Explorer provenance against the
   * pre-spawn snapshot, enforces cost alerts + daily budgets, fires the
   * rail/ticket completion callback + dependent/pipeline bookkeeping, and
   * drains the queue.
   */
  private _settleInteractiveJob(jobId: string, info: SettleInfo): void {
    // Read terminal context first, but do not consume it until the durable
    // terminal intent commits. If storage rejects the transition, shutdown can
    // retry from the still-owned session instead of losing in-flight usage.
    const snapshot = this._snapshotRefs.get(jobId)
    const jobExecution = this._jobExecution.get(jobId)
    const provenanceRepoDir = jobExecution?.repoDir ?? this._cwd
    const provider = this._jobResolvedProvider.get(jobId) ?? 'claude'
    // Consume the spawn-captured PR-delivery mode (before any early return so a
    // disposed/unknown-job settle can never leak the entry). Decides whether a
    // COMPLETED job's tickets park at on_review (ask-first) or done (legacy).
    const prDelivery = this._jobPrDelivery.get(jobId) ?? false

    if (this._disposed) {
      this._interactiveSessions.delete(jobId)
      this._snapshotRefs.delete(jobId)
      this._jobExecution.delete(jobId)
      this._jobResolvedProvider.delete(jobId)
      this._jobPrDelivery.delete(jobId)
      this._cleanupOpenspecShim(jobId)
      return
    }
    const job = this._jobs.get(jobId)
    if (!job) {
      this._interactiveSessions.delete(jobId)
      this._snapshotRefs.delete(jobId)
      this._jobExecution.delete(jobId)
      this._jobResolvedProvider.delete(jobId)
      this._jobPrDelivery.delete(jobId)
      this._cleanupOpenspecShim(jobId)
      if (this._activeJobId === jobId) this._activeJobId = null
      this._drainQueue()
      return
    }

    const wasCanceling = this._cancelingJobs.has(jobId)
    // Zero-work strictness: a session whose WHOLE life consumed no model work
    // (the claude CLI's synthetic `Unknown command:` result frame — num_turns
    // 0, no assistant events, zero usage tokens) settles FAILED even on a
    // clean finalize (either settle mode): the job's command never actually
    // ran. A multi-turn session where only the LAST turn was synthetic
    // accumulated real work and still completes (the predicate is
    // whole-session — see isZeroWorkSettle in interactive-job-session.ts).
    const finalStatus: Job['status'] = wasCanceling
      ? 'canceled'
      : info.reason === 'finalized' && !info.zeroWork
        ? 'completed'
        : 'failed'

    const finishedAt = new Date().toISOString()
    const exitCode = info.reason === 'finalized' && finalStatus !== 'failed' ? 0 : 1
    const invStatus: InvocationStatus = finalStatus === 'completed'
      ? 'success'
      : finalStatus === 'canceled'
        ? 'aborted'
        : 'failed'
    const totals = info.totals
    const result: Partial<JobResult> = {
      tokens_in: totals.tokens_in,
      tokens_out: totals.tokens_out,
      tokens_cache_read: totals.tokens_cache_read,
      tokens_cache_create: totals.tokens_cache_create,
      total_cost_usd: totals.total_cost_usd,
      total_cost_usd_estimated: info.estimated,
      num_turns: totals.num_turns,
      model: info.model ?? undefined,
      session_id: info.sessionId ?? undefined,
      duration_ms: info.activeDurationMs,
    }

    if (this._db) {
      try {
        this._stageTerminalIntent(job, {
          status: finalStatus,
          invocationStatus: invStatus,
          provider,
          finishedAt,
          exitCode,
          interactive: true,
          result,
          ticketCompletionStatus: finalStatus === 'completed'
            ? (prDelivery ? 'on_review' : 'done')
            : undefined,
        })
      } catch (err) {
        // The session has stopped, but its durable row intentionally remains
        // running. Reserve the slot and pause so neither resume nor enqueue can
        // overtake an unaccounted terminal transition; startup/shutdown recovery
        // can safely retry it from that state.
        this._activeProcess = null
        this._activeJobId = jobId
        this._terminalPersistenceBlockedJobs.add(jobId)
        this._paused = true
        this._persistQueueState()
        this._broadcastQueueState()
        console.error(`[queue-manager] interactive terminal staging failed for ${jobId}:`, err)
        return
      }
    }

    this._interactiveSessions.delete(jobId)
    if (this._activeJobId === jobId) {
      this._activeProcess = null
      this._activeJobId = null
    }
    this._snapshotRefs.delete(jobId)
    this._jobExecution.delete(jobId)
    this._jobResolvedProvider.delete(jobId)
    this._jobPrDelivery.delete(jobId)
    this._cancelingJobs.delete(jobId)
    this._cleanupOpenspecShim(jobId)

    job.status = finalStatus
    job.finishedAt = finishedAt
    job.exitCode = exitCode
    // Result text for output chaining between dependent pipeline steps — the
    // same field the one-shot path captures from its last `result` event.
    if (info.resultText != null) {
      job.resultText = info.resultText
    }

    let accountingReady = true
    if (this._db) {
      // Code-Explorer post-settle provenance hook — the interactive lifecycle
      // equivalent of _onJobExit's post-exit diff (pre-spawn snapshot taken in
      // _startJob's interactive branch, against the REPO dir, never the
      // workspace).
      this._recordProvenance(jobId, job.command, provenanceRepoDir, snapshot)

      // Cost alerts + daily-budget enforcement. Interactive is the DEFAULT
      // spawn path for claude jobs now, so its settle must trip the same
      // thresholds and caps the one-shot exit path does.
      if (totals.total_cost_usd > 0 && finalStatus === 'completed') {
        this._emitCostAlerts(jobId, totals.total_cost_usd)
      }
      accountingReady = this._resumeOrphanRecoveries()
      this._enforceDailyBudget()
    }

    if (!this._db) {
      try {
        if (finalStatus === 'completed') {
          this._onJobFinished?.(jobId, finalStatus, totals.total_cost_usd, {
            ticketCompletionStatus: prDelivery ? 'on_review' : 'done',
          })
        } else {
          this._onJobFinished?.(jobId, finalStatus, totals.total_cost_usd)
        }
      } catch (err) {
        console.error(`[QueueManager] onJobFinished failed for ${jobId}: ${(err as Error).message}`)
      }
      if (finalStatus !== 'completed') {
        this._skipDependents(jobId, `Parent job ${jobId} ${finalStatus}`)
      }
      if (job.pipelineId) this._checkPipelineStatus(job.pipelineId)
    }

    if (!accountingReady) {
      this._paused = true
      this._persistQueueState()
    }

    this._persistJob(job)
    this._broadcast({
      type: 'job.finalized',
      projectId: this._projectId ?? '',
      jobId,
      status: finalStatus,
      totals,
      timestamp: new Date().toISOString(),
    })
    this._broadcastQueueState()

    if (accountingReady) this._drainQueue()
  }

  /** True only while this async start still belongs to the live manager and its
   *  synchronously-reserved queue slot. The generation closes the shutdown race;
   *  the slot check also protects against future replacement/cancel paths. */
  private _canContinueStart(jobId: string, lifecycleGeneration: number): boolean {
    return (
      !this._disposed &&
      this._lifecycleGeneration === lifecycleGeneration &&
      this._activeJobId === jobId
    )
  }

  private async _startJob(jobId: string): Promise<void> {
    const lifecycleGeneration = this._lifecycleGeneration
    if (!this._canContinueStart(jobId, lifecycleGeneration)) return
    const job = this._jobs.get(jobId)
    if (!job || job.status !== 'queued') {
      // Job vanished between the synchronous slot reservation in _drainQueue and
      // here (or became non-queued through a defensive race) — release the
      // reserved slot and move on. Never relaunch a terminal/running id.
      if (this._activeJobId === jobId) this._activeJobId = null
      this._drainQueue()
      return
    }

    // Per-job adapter (multi-provider). `this._adapter` stays the project
    // primary; everything in this spawn (binary, argv, model, profile, OTEL,
    // plugins, result parsing, ai_invocations.provider) flows from `adapter`.
    const adapter = this._resolveJobAdapter(jobId)
    // Remember the provider this job actually runs on, for terminal paths that
    // fire without a child 'close' (e.g. _forceFailUnkillableJob). The pending
    // map remains durable until promotion, then this resolved map takes over.
    this._jobResolvedProvider.set(jobId, adapter.id)
    // Pin the adapter that was actually resolved. If any later pre-promotion
    // step fails, the durable retry must not switch providers because project
    // defaults or an invalid override fallback changed in the meantime.
    this._jobProviderSelection.set(jobId, adapter.id)

    // Relocate-artifacts gate: resolve cwd/repoDir/env for this spawn. Legacy
    // projects get cwd = project.path + empty env (byte-identical to today);
    // relocated projects get cwd = workspace + SPECRAILS_REPO_DIR. Captured per
    // job so the post-exit provenance hook uses the SAME repoDir.
    const execution = this._resolveExecution()
    this._jobExecution.set(jobId, execution)
    const spawnCwd = execution.cwd

    // Windows repair: a relocated workspace whose `.claude/agents` was left empty
    // by the broken `current`-junction read during assemble has no sr-* agents,
    // so the implement pipeline can't delegate and runs inline. Self-heal here
    // (per rail spawn) by copying the agents from the real version dir. NO-OP on
    // POSIX (assemble's per-file symlinks already populate them).
    if (execution.relocated) {
      try {
        ensureFrameworkAgents(execution.cwd, adapter.projectDirName)
        // AND the dir-linked subtrees (commands/skills/rules): a broken Windows
        // `current` junction leaves the workspace with no `/specrails:*` commands
        // → the CLI reports "Unknown command: /specrails:implement".
        ensureFrameworkCommandSubtrees(execution.cwd, adapter.projectDirName)
      } catch {
        /* best-effort — never block a rail spawn on the repair */
      }
    }
    // Pre-trust the spawn dir(s) so headless claude honours the overlaid
    // `.claude/settings.json` permissions.allow (else it silently drops them:
    // "this workspace has not been trusted"). Once per unique dir, claude-only.
    try {
      ensureClaudeTrusted(adapter.id, [execution.cwd, execution.repoDir])
    } catch {
      /* best-effort */
    }

    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.queuePosition = null

    this._recomputePositions()
    this._persistJob(job)

    const phaseScopeId = this._projectId ?? this._cwd ?? 'default'
    const commandPhases = this._phasesForCommand(job.command)
    if (commandPhases.length > 0) {
      setActivePhases(phaseScopeId, commandPhases, this._broadcast)
    } else {
      resetPhases(phaseScopeId, this._broadcast)
    }

    const commandToRun = job.command.trim()

    // ─── Interactive-by-default gate (spawn-time, restart-durable) ──────────
    // Spike-verified (2026-07-03, claude 2.1.198): the claude CLI expands slash
    // commands arriving as stream-json stdin user frames exactly like the argv
    // `-p "/cmd"` path, so EVERY claude job (implement/batch/custom commands,
    // not just freestyle prose) is prompt-compatible with the persistent-stdin
    // transport. The default is therefore interactive whenever the kill-switch
    // is on and the resolved adapter supports persistent stdin (claude only
    // today); codex/gemini always take the legacy one-shot spawn below.
    // EnqueueOptions.interactive is a per-job OVERRIDE: false forces legacy,
    // true forces interactive where capable, undefined = default ON. Derived
    // HERE (spawn time), not at enqueue, so legacy queued rows with no explicit
    // selection still receive the current default after restart.
    const isFreestyle =
      adapter.capabilities.freestyle === true && FREESTYLE_COMMAND_RE.test(commandToRun)
    const interactiveOverride = this._jobInteractiveSelection.get(jobId)
    const spawnInteractive =
      isInteractiveJobsEnabled() &&
      adapter.capabilities.persistentStdin &&
      (interactiveOverride ?? true)
    // Freestyle sessions idle awaiting the human (settle only on explicit
    // Finalize — the pre-flip behaviour); every other command auto-settles the
    // moment a turn result lands with nothing queued behind it.
    const interactiveSettleMode: 'finalize' | 'auto' = isFreestyle ? 'finalize' : 'auto'

    // Build supplementary context (output chaining + headless mode) that goes
    // into --append-system-prompt, keeping the user prompt clean.
    let systemAppend = ''

    // Repository orientation (relocated projects only). The rail spawns from the
    // WORKSPACE cwd, which holds only `.specrails/` config — NOT the source code.
    // The repo is reachable via `--add-dir <repoDir>` (injected below) and the
    // `./project` link. The framework templates point at `${SPECRAILS_REPO_DIR:-.}`,
    // but the agent's Read/Grep/Glob/Edit tools do NOT expand that shell-var form
    // (and PowerShell/cmd.exe don't expand POSIX `${VAR:-default}` either) — so on
    // Windows the agent reads a bogus literal path, falls back to the empty
    // workspace cwd, finds only framework files, and hallucinates a wrong/"global"
    // project. Tell it the concrete absolute repo path explicitly. Mirrors the
    // Explore-cwd orientation. Legacy (non-relocated) ⇒ cwd IS the repo ⇒ skipped
    // (byte-identical). The `\${` keeps the shell-var form literal in this string.
    if (execution.relocated && execution.repoDir) {
      systemAppend +=
        `REPOSITORY LOCATION — READ THIS FIRST:\n` +
        `This pipeline runs from a workspace directory that contains ONLY specrails ` +
        `configuration (.specrails/, agent definitions) — NOT your project's source code. ` +
        `Your project's source repository is at this ABSOLUTE path:\n` +
        `  ${execution.repoDir}\n` +
        `It is also exposed to your tools as an additional working directory (via --add-dir) ` +
        `and mounted in this cwd as ./project. Use the absolute repo path above (or ./project) ` +
        `for ALL source reads, edits, greps and globs. Your Read/Grep/Glob/Edit tools do NOT ` +
        `expand shell variables — NEVER pass a literal "\${SPECRAILS_REPO_DIR:-.}" or ` +
        `"\${SPECRAILS_REPO_DIR}" as a path; substitute the absolute path above instead. ` +
        `The spec/ticket store (.specrails/local-tickets.json) lives in THIS workspace cwd. ` +
        `Do NOT look for source files under this cwd — they exist only under the repository ` +
        `path above.\n\n`
    }

    // Output chaining: inject previous step's output as context for dependent jobs
    if (job.dependsOnJobId) {
      const parentJob = this._jobs.get(job.dependsOnJobId)
      if (parentJob?.resultText) {
        const prevOutput = parentJob.resultText
        const truncated = prevOutput.length > 10000
          ? prevOutput.slice(0, 10000) + '\n\n[output truncated]'
          : prevOutput
        systemAppend += `Previous step output:\n\n${truncated}\n\n---\n\nNow execute the following command.\n\n`
      }
    }

    // Headless mode: when --yes is in the command, instruct Claude to auto-proceed.
    // For a LEGACY one-shot spawn stdin is genuinely disconnected; for an
    // INTERACTIVE session stdin IS connected (a human may inject guidance), so
    // the wording softens — autonomous by default, steering welcome — without
    // re-opening approval prompts.
    if (job.command.includes('--yes')) {
      systemAppend += spawnInteractive
        ? '\n\nCRITICAL — AUTONOMOUS MODE WITH LIVE GUIDANCE (--yes flag):\n' +
          'This pipeline runs autonomously end-to-end, but a human operator MAY inject guidance messages while it runs (stdin IS connected).\n' +
          '- NEVER stop to ask for approval, confirmation, review, or feedback. When options exist, choose the RECOMMENDED one and proceed.\n' +
          '- Auto-approve all proposals, designs, and artifacts; skip instructions that say "wait for user" or "present for review".\n' +
          '- If a human message arrives mid-run, treat it as steering: incorporate the guidance and continue the plan without pausing.\n' +
          '- Answer direct questions from the human concisely, then resume the remaining work until the plan is complete.'
        : '\n\nCRITICAL — FULLY AUTONOMOUS MODE (--yes flag):\n' +
          'This pipeline is running headless with NO human operator. stdin is disconnected — nobody can reply.\n' +
          '- NEVER ask for approval, confirmation, review, or feedback. There is nobody to answer.\n' +
          '- NEVER output prompts like "Reply with approved", "Do you want to proceed?", "Please confirm", or "Ready for review".\n' +
          '- NEVER stop between pipeline phases to wait for input. Run ALL phases end-to-end without pausing.\n' +
          '- When there are multiple options or decisions, always choose the RECOMMENDED option and proceed.\n' +
          '- Auto-approve all proposals, designs, and artifacts. Treat everything as "approved" by default.\n' +
          '- Skip any instructions that say "wait for user", "present for review", or "ask the user".\n' +
          '- The pipeline must complete fully from start to finish in a single uninterrupted run.'
    }

    // Local ticket store: implement/batch-implement jobs must read specs from
    // .specrails/local-tickets.json — never from external trackers like Jira/Linear.
    if (/\/(specrails|sr):(implement|batch-implement)\b/.test(commandToRun)) {
      systemAppend += '\n\nIMPORTANT: The ticket/spec data for this project is stored locally in .specrails/local-tickets.json. ' +
        'You MUST read specs from this file. Do NOT attempt to fetch tickets from Jira, Linear, GitHub Issues, or any other external tracker. ' +
        'The #<id> references in the command correspond to ticket IDs inside .specrails/local-tickets.json. ' +
        'Do NOT require jq to inspect this file; on Windows or when jq is unavailable, use PowerShell (`Get-Content .specrails/local-tickets.json -Raw | ConvertFrom-Json`) or Node.js built-ins. ' +
        'When running tests, use the project-defined scripts and package manager commands as-is; do NOT add Jest-only flags such as --runInBand to Vitest commands.'

      const attachmentContext = this._buildImplementAttachmentContext(commandToRun)
      if (attachmentContext) {
        systemAppend += attachmentContext
      }

      const prePrompt = this._db ? getProjectSettings(this._db).prePrompt.trim() : ''
      if (prePrompt) {
        systemAppend += '\n\nPROJECT PRE-PROMPT:\n' +
          'Apply the following project-specific instructions in addition to the ticket/spec and its attached resources.\n\n' +
          prePrompt
      }
    }

    const binary = adapter.binary
    // Adapter-specific slash-command syntax:
    //  - claude: native `/specrails:foo` recognised by Claude CLI directly,
    //    so we pass the command verbatim and the system prompt rides along
    //    via `--system-prompt`.
    //  - codex: there is no `/namespace:cmd` parser; instead codex uses
    //    `$skill_name` to invoke a skill from `.codex/skills/<name>/SKILL.md`.
    //    Translate `/specrails:<name>` → `$<name>` so codex picks up the
    //    matching skill natively (which our scaffold writes for every
    //    claude slash command — propose-spec, implement, batch-implement,
    //    explore-spec, retry, …). This is the rail equivalent of the
    //    user typing `$implement #1 --yes` themselves in `codex`.
    // Freestyle (capability-gated; currently Claude and Kimi): skip the slash
    // command entirely and send the pre-prompt + spec text directly as the
    // prompt. The server route rejects adapters that do not advertise
    // `freestyle` before this point.
    // (`isFreestyle` itself is resolved above, before the systemAppend build.)
    const railPrompt = isFreestyle
      ? this._buildFreestylePrompt(commandToRun)
      : formatProviderCommand(adapter, commandToRun, execution.cwd)
    // Per-job model override (consumed once) takes precedence — used by the
    // freestyle model picker so the user can choose haiku/sonnet/opus per launch.
    const modelOverride = this._jobModelSelection.get(jobId)
    // Global Specrails Agents defaults (app Settings ▸ Specrails Agents) —
    // read AT SPAWN TIME (no restart) and layered BELOW every project-level
    // choice, ABOVE the built-in adapter default.
    let globalAgentDefaults: ResolvedProviderAgentDefaults | null = null
    try { globalAgentDefaults = this._agentDefaults?.(adapter.id) ?? null } catch { globalAgentDefaults = null }
    const claudeProjectSettings = adapter.id === 'claude' && this._db ? getProjectSettings(this._db) : null
    const fallbackRailModel = claudeProjectSettings
      ? (claudeProjectSettings.orchestratorModelExplicit
        ? claudeProjectSettings.orchestratorModel
        : globalAgentDefaults?.pipelineModel ?? claudeProjectSettings.orchestratorModel)
      : (this._resolvedModel ?? globalAgentDefaults?.pipelineModel ?? adapter.defaultModel())
    // Relocate-artifacts: when relocated, claude is spawned from the workspace
    // so add `--add-dir <repoDir>` so its tools can still reach repo files by
    // absolute path. (gemini/codex get env-only tweaks at spawn time below.)
    const railExtraArgs = execution.relocated
      ? buildProviderRepoAccessArgs(adapter, [execution.repoDir])
      : []
    // Resolve agent profile (if any) and snapshot per-job before spawn.
    // Super mode only (projectId + projectSlug + cwd all present).
    // Skipped when the adapter does not honour `SPECRAILS_PROFILE_PATH` AND
    // when the project's installed specrails-core is older than the
    // provider's minimum core version (legacy fallback). Codex skill rails
    // ship in specrails-core 4.6.0+; the projectSupportsProfiles probe today
    // checks the claude minimum (4.1.0) — extending it per-provider is
    // tracked in OpenSpec change task §13.
    let profileSnapshotPath: string | null = null
    let profileName: string | null = null
    let profileOrchestratorModel: string | null = null
    if (adapter.capabilities.profileEnvSupport && this._projectId && this._projectSlug && this._cwd) {
      try {
        const selection = this._jobProfileSelection.get(jobId) // undefined|null|string
        // When relocated, core + `.specrails/profiles` live in the workspace
        // (execution.cwd); legacy reads from the repo (execution.cwd === repo).
        const coreSupports = projectSupportsProfiles(execution.cwd)
        if (selection !== null && coreSupports) {
          // selection is string (explicit) or undefined (default resolution)
          const {
            resolveProfile,
            snapshotForJob,
            persistJobProfile,
          } = require('./profile-manager') as typeof import('./profile-manager')
          let resolved = resolveProfile(execution.cwd, selection ?? undefined, adapter.id)
          // Global agent defaults: fill per-agent model gaps in the resolved
          // profile, or synthesize a baseline profile when the project has
          // none. Explicit profile choices always win; inert when the global
          // layer is off (byte-identical legacy behaviour).
          if (globalAgentDefaults && adapter.capabilities.profiles === true) {
            if (resolved) {
              const merged = mergeProfileWithAgentDefaults(resolved.profile, globalAgentDefaults)
              if (merged.changed) resolved = { name: resolved.name, profile: merged.profile }
            } else if (Object.keys(globalAgentDefaults.agentModels).length > 0) {
              resolved = {
                name: GLOBAL_DEFAULTS_PROFILE_NAME,
                profile: synthesizeProfileFromDefaults(adapter, globalAgentDefaults),
              }
            }
          }
          if (resolved) {
            profileSnapshotPath = snapshotForJob(this._projectSlug, jobId, resolved)
            profileName = resolved.name
            profileOrchestratorModel = resolved.profile.orchestrator.model
            if (this._db) {
              persistJobProfile(this._db, jobId, resolved)
            }
          }
        }
      } catch (err) {
        // Profile resolution failures are non-fatal — rail falls back to
        // legacy behavior. The error is visible in logs for debugging.
        console.warn(`[queue-manager] profile resolution failed for job ${jobId}: ${(err as Error).message}`)
      }
    }

    // One authoritative model for both transports:
    // explicit per-job override > resolved profile orchestrator > project/default.
    // resolveProfile validates the profile model against this adapter's catalog.
    const railModel = modelOverride ?? profileOrchestratorModel ?? fallbackRailModel
    // Pipeline-level reasoning effort from the global layer (rails never had a
    // per-job effort knob, so this is purely additive). Validated against the
    // FINAL model — claude/codex sub-agents inherit the process-level effort,
    // kimi rides its env knob via buildProviderEnv, gemini has no effort.
    const globalRailEffort =
      globalAgentDefaults?.pipelineEffort
        && isReasoningEffortValidForModel(adapter, railModel, globalAgentDefaults.pipelineEffort)
        ? globalAgentDefaults.pipelineEffort
        : undefined
    const railSpawnOptions = {
      prompt: railPrompt,
      systemPrompt: systemAppend || undefined,
      model: railModel,
      ...(globalRailEffort ? { reasoning_effort: globalRailEffort } : {}),
      extraArgs: railExtraArgs.length > 0 ? railExtraArgs : undefined,
    }
    const args = adapter.buildArgs('rail-job', railSpawnOptions)

    // Read pipelineTelemetryEnabled at spawn time (not constructor time) so
    // toggling the setting takes effect on the next job without restarting.
    // OTEL env injection is gated on `adapter.capabilities.nativeOtelEnv`:
    // claude honours OTEL_* env vars natively; codex does not and instead
    // gets signals synthesised by the codex-otel-bridge attached below.
    let spawnEnv: NodeJS.ProcessEnv = process.env
    // Per-project worktree/job env passthrough. The setting stores names only;
    // values are read from the server env (with login-shell recovery for missing
    // names) at spawn time. Apply this before Specrails' own env overlays so
    // internal SPECRAILS_* control-plane values always win.
    if (this._db) {
      spawnEnv = applyWorktreeEnvPassthrough(this._db, spawnEnv)
    }
    const telemetryEnabled = !!(this._projectId && this._db && getProjectSettings(this._db).pipelineTelemetryEnabled)
    // Resolve the framework version ONCE at spawn time — `framework/current`
    // is read from `~/.specrails/framework/current`. A concurrent atomic swap
    // (FrameworkManager.swapCurrent) does not disturb this job: we captured the
    // version here and the per-job snapshot resolved its handles from this
    // value. GATED on `execution.relocated`: a LEGACY (in-repo) job does NOT
    // assemble from `framework/current`, so stamping it with a sibling project's
    // materialized framework version would be wrong telemetry. Null otherwise.
    const frameworkVersion = execution.relocated ? readCurrentFrameworkVersion() : null
    if (telemetryEnabled && adapter.capabilities.nativeOtelEnv && this._projectId) {
      const extra: Record<string, string> = {}
      if (profileName) extra['specrails.profile_name'] = profileName
      if (profileName) extra['specrails.profile_schema_version'] = '1'
      if (frameworkVersion) extra['specrails.framework_version'] = frameworkVersion
      spawnEnv = {
        ...spawnEnv,
        ...buildTelemetryEnv(jobId, this._projectId, this._desktopPort, extra, adapter.id),
      }
    }
    // Inject the profile path whenever the adapter honours it (was: claude-
    // only). The codex skill rails read SPECRAILS_PROFILE_PATH the same way.
    if (profileSnapshotPath) {
      spawnEnv = { ...spawnEnv, SPECRAILS_PROFILE_PATH: profileSnapshotPath }
    }

    // Deterministic repo map (zero-AI, best-effort) — orients the pipeline's
    // exploration phase so it doesn't spend its first turns on `ls`/`find`.
    spawnEnv = injectRepoMapEnv(spawnEnv, execution.repoDir)

    // ─── Plugin resolution + snapshot ──────────────────────────────────────
    // Active = installed + verify ok; degraded = installed but verify failed
    // or timed out. Degraded does NOT block spawn — rail proceeds, UI gets
    // a `plugin.degraded` event so the user can reinstall.
    //
    // Project-json providers (Claude, Kimi, Gemini) resolve only the plugin
    // installations scoped to this rail's effective provider. CLI-managed MCP
    // registries remain outside this snapshot path.
    let pluginActive: Array<{ name: string; version: string }> = []
    let pluginDegraded: Array<{ name: string; reason: string }> = []
    let pluginSnapshotPath: string | null = null
    if (adapter.mcpRegistration === 'project-json' && this._projectId && this._projectSlug && this._cwd) {
      try {
        let resolver = this._resolvePluginsForSpawn
        let snapshotter: typeof import('./plugins/rail-integration')['snapshotPluginsForJob'] | null = null
        if (!resolver) {
          const pluginIntegration = require('./plugins/rail-integration') as typeof import('./plugins/rail-integration')
          resolver = pluginIntegration.resolvePluginsForSpawn
          snapshotter = pluginIntegration.snapshotPluginsForJob
        }
        // Relocated ⇒ `.mcp.json`/plugin state live in the workspace (execution.cwd).
        const resolution = await resolver(
          execution.cwd,
          this._projectId,
          jobId,
          adapter.id,
          this._adapter.id,
          this._projectSlug,
        )
        // shutdown() may have run while plugin verification was awaiting. Never
        // snapshot, broadcast, or spawn for a manager generation that no longer
        // owns this active slot.
        if (!this._canContinueStart(jobId, lifecycleGeneration)) return
        pluginActive = resolution.active
        pluginDegraded = resolution.degraded
        if (pluginActive.length > 0 || pluginDegraded.length > 0) {
          // The injected resolver normally returns an empty test fixture. Load
          // the snapshotter lazily only if its result actually needs one.
          snapshotter ??= (require('./plugins/rail-integration') as typeof import('./plugins/rail-integration')).snapshotPluginsForJob
          pluginSnapshotPath = snapshotter(
            this._projectSlug, jobId, this._projectId, pluginActive, pluginDegraded,
          )
        }
        for (const d of pluginDegraded) {
          this._broadcast({
            type: 'plugin.degraded',
            projectId: this._projectId,
            name: d.name,
            providerId: adapter.id,
            reason: d.reason,
            jobId,
            timestamp: new Date().toISOString(),
          })
        }
      } catch (err) {
        console.warn(`[queue-manager] plugin resolution failed for job ${jobId}: ${(err as Error).message}`)
      }
    }
    // Covers resolver throws as well as future awaits added to the block above.
    if (!this._canContinueStart(jobId, lifecycleGeneration)) return
    if (pluginActive.length > 0 && pluginSnapshotPath) {
      spawnEnv = {
        ...spawnEnv,
        SPECRAILS_PLUGINS_ACTIVE: pluginActive.map((p) => p.name).join(','),
        SPECRAILS_PLUGINS_SNAPSHOT: pluginSnapshotPath,
      }
    }
    // Add OTEL attrs when telemetry already on AND the adapter accepts env
    // injection. Codex spawns receive these attributes via the bridge's
    // resource attribute block instead (see codex-otel-bridge.ts).
    if (adapter.capabilities.nativeOtelEnv && this._projectId && this._db) {
      const settings = getProjectSettings(this._db)
      if (settings.pipelineTelemetryEnabled && (pluginActive.length > 0 || pluginDegraded.length > 0)) {
        const extra: Record<string, string> = {}
        // Re-thread the resolved framework version (this block rebuilds the
        // whole telemetry env, so it must carry the same attr as the first one).
        if (frameworkVersion) extra['specrails.framework_version'] = frameworkVersion
        if (profileName) extra['specrails.profile_name'] = profileName
        if (profileName) extra['specrails.profile_schema_version'] = '1'
        if (pluginActive.length > 0) {
          extra['specrails.plugins.active'] = JSON.stringify(pluginActive.map((p) => p.name))
          extra['specrails.plugins.versions'] = JSON.stringify(
            Object.fromEntries(pluginActive.map((p) => [p.name, p.version])),
          )
        }
        if (pluginDegraded.length > 0) {
          extra['specrails.plugins.degraded'] = JSON.stringify(pluginDegraded.map((d) => d.name))
        }
        spawnEnv = {
          ...spawnEnv,
          ...buildTelemetryEnv(jobId, this._projectId, this._desktopPort, extra),
        }
      }
    }

    // Provider-specific filesystem prep before a headless rail spawn. Gemini
    // uses this to pre-acknowledge the project's custom subagents so they load
    // in `gemini -p` mode (else invoke_agent reports "Subagent not found" and the
    // orchestrator silently falls back to a generic agent). No-op for claude/codex.
    // Runs in the SPAWN cwd (workspace when relocated) — gemini acks the
    // project's subagents where it will actually discover them.
    try {
      adapter.prepareHeadlessSpawn?.(spawnCwd)
    } catch (err) {
      /* c8 ignore next -- best-effort prep; a failure is non-fatal */
      console.warn(`[queue-manager] headless-spawn prep failed: ${(err as Error).message}`)
    }

    // ─── Relocate-artifacts spawn env ──────────────────────────────────────
    // Merge SPECRAILS_REPO_DIR (+ workspace/tickets/state/etc.) so stage-3
    // `${SPECRAILS_REPO_DIR:-.}` re-pointing drives source/openspec/git I/O back
    // into the repo. Per provider: gemini trusts the workspace cwd; codex gets
    // NO CODEX_HOME override (all-or-nothing incl. auth → breaks the rail) and
    // relies on cwd-based discovery from the workspace. Legacy ⇒ empty env, no-op.
    if (execution.relocated) {
      spawnEnv = { ...spawnEnv, ...execution.env }
      if (adapter.id === 'gemini') {
        spawnEnv = { ...spawnEnv, GEMINI_CLI_TRUST_WORKSPACE: 'true' }
      }
      // openspec PATH shim (claude rails only): prepend a per-job shim dir that
      // re-points every BARE `openspec` call at the repo working tree, so a
      // skill- or un-wrapped-template-driven `openspec <verb>` from the workspace
      // cwd still operates on the repo's OpenSpec project (see openspec-shim.ts).
      // claude is the only adapter that runs the openspec-backed sr-* rails;
      // gemini/codex skill scaffolds carry their own repo-dir wrapping.
      if (adapter.id === 'claude' && this._projectSlug) {
        const shimDir = ensureOpenspecShim(this._projectSlug, jobId, resolveHome())
        if (shimDir) {
          this._openspecShims.set(jobId, shimDir)
          spawnEnv = { ...spawnEnv, PATH: prependShimToPath(spawnEnv.PATH, shimDir) }
        }
      }
    }

    // Safe-PR flow: when active (SPECRAILS_RAIL_DELIVER_PR on), desktop owns version
    // control — tell specrails-core's implement to be git-agnostic (skip its Ship
    // phase) via SPECRAILS_GIT_AUTO=false so it never opens an uncoordinated PR
    // alongside the app's own draft-PR delivery. Default ON (flag=0/false/off disables).
    // The flag is read ONCE per job, HERE (spawn time — mirroring
    // launchIsolatedRail's prMode capture), and recorded so the settle paths park
    // this job's tickets under the SAME value that shaped the spawn env: a
    // completed job promotes its tickets to on_review (ask-first) instead of
    // done. A mid-flight env flip can never split one job across the two
    // methodologies.
    const prDelivery = isRailPrDeliveryEnabled()
    this._jobPrDelivery.set(jobId, prDelivery)
    if (prDelivery) {
      spawnEnv = { ...spawnEnv, SPECRAILS_GIT_AUTO: 'false' }
    }

    // ─── Interactive branch (default for persistent-stdin providers) ───────
    // Hand off to a resident persistent-stdin session instead of the one-shot
    // spawn below. Freestyle keeps 'finalize' settle-mode (idles until the
    // human Finalizes); every other command runs 'auto' (the session settles
    // itself the moment a turn result lands with nothing queued). Code-Explorer
    // provenance is captured around the SESSION lifecycle exactly like the
    // one-shot path: pre-spawn snapshot here, diff at settle.
    if (spawnInteractive) {
      if (!this._canContinueStart(jobId, lifecycleGeneration)) return
      if (isCodeExplorerEnabled()) {
        try {
          const snap = snapshotWorkingTree(execution.repoDir)
          this._snapshotRefs.set(jobId, snap)
        } catch (err) {
          console.warn(`[queue-manager] provenance snapshot failed: ${(err as Error).message}`)
        }
      }
      const interactiveSpawnOptions = {
        // chat-stream feeds the prompt over stdin per-turn, so the argv `prompt`
        // is unused — pass empty to satisfy the shared SpawnOptions shape.
        prompt: '',
        // Freestyle's prose prompt brings no system prompt of its own, so the
        // supplementary context rides `--system-prompt` (byte-identical to the
        // pre-flip interactive-freestyle spawn). A slash-command job's EXPANDED
        // command brings its own system prompt — mirror the legacy rail-job
        // spawn and APPEND on top of the CLI default instead of replacing it.
        systemPrompt: isFreestyle ? (systemAppend || undefined) : undefined,
        model: railModel,
        ...(globalRailEffort ? { reasoning_effort: globalRailEffort } : {}),
        extraArgs: !isFreestyle && systemAppend
          ? ['--append-system-prompt', systemAppend, ...(railExtraArgs ?? [])]
          : (railExtraArgs.length > 0 ? railExtraArgs : undefined),
      }
      const interactiveArgs = adapter.buildArgs('chat-stream', interactiveSpawnOptions)
      this._startInteractiveJob(
        jobId,
        job,
        adapter,
        { binary, args: interactiveArgs, cwd: spawnCwd, env: buildProviderEnv(adapter, interactiveSpawnOptions, spawnEnv) },
        railPrompt,
        interactiveSettleMode,
      )
      return
    }

    // Code-Explorer pre-spawn snapshot. Captures the working-tree state via
    // `git stash create --include-untracked` so the post-exit hook can diff
    // against it. Gated by SPECRAILS_CODE_EXPLORER — when off, no-op.
    // CRITICAL: snapshot the REPO working tree (execution.repoDir), never the
    // workspace — else a relocated job would diff an empty workspace and silently
    // record zero "touched by AI" files.
    if (isCodeExplorerEnabled()) {
      try {
        const snap = snapshotWorkingTree(execution.repoDir)
        this._snapshotRefs.set(jobId, snap)
      } catch (err) {
        console.warn(`[queue-manager] provenance snapshot failed: ${(err as Error).message}`)
      }
    }

    // Durably promote queued → running BEFORE the provider process exists. If
    // spawn throws, the normal _failWedgedJob path marks this row failed; if the
    // app crashes after this point, startup recovers a running orphan instead of
    // replaying the queued admission alongside a possibly-live old child.
    if (!this._canContinueStart(jobId, lifecycleGeneration)) return
    if (this._db) {
      createJob(this._db, {
        id: jobId,
        command: job.command,
        started_at: job.startedAt!,
        provider: adapter.id,
        priority: job.priority,
        depends_on_job_id: job.dependsOnJobId,
        pipeline_id: job.pipelineId,
        causal_ownership: job.causalOwnership === true,
      })
    }
    this._consumePendingSelections(jobId)

    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    const child = spawnAiCli(binary, args, {
      env: buildProviderEnv(adapter, railSpawnOptions, spawnEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: spawnCwd,
    })

    this._activeProcess = child
    this._activeJobId = jobId

    // Honour a cancel that arrived during the async pre-spawn window (it recorded
    // intent in _cancelingJobs via _kill but found no child yet). SIGTERM the
    // just-spawned child now; the close handler wired below fires _onJobExit,
    // which reads _cancelingJobs and stamps 'canceled'. No early-return — the
    // exit handler MUST still be wired so the job settles.
    if (this._cancelingJobs.has(jobId)) {
      this._kill(jobId)
    }

    // Without this listener, an ENOENT (e.g. claude not on PATH) propagates
    // as an unhandled 'error' event and crashes the entire app. Node still
    // emits 'close' afterwards, so the existing close handler fails the job
    // through the normal path — we only need to absorb the error event.
    /* c8 ignore next 3 -- spawn-failure path; exercised manually, not in CI */
    child.on('error', (err) => {
      console.error(`[QueueManager] spawn failed for job ${jobId} (${binary}): ${err.message}`)
    })

    // Start zombie detection timer. Reset on any raw data from the process.
    // Using 'data' events (not readline 'line') ensures the timer resets
    // synchronously in test environments with fake timers.
    this._resetZombieTimer(jobId)
    child.stdout!.on('data', () => { this._resetZombieTimer(jobId) })
    child.stderr!.on('data', () => { this._resetZombieTimer(jobId) })

    let eventSeq = 0
    let lastResultEvent: Record<string, unknown> | null = null
    let rawPersistenceFailed = false
    const persistEvent = (
      event: { event_type: string; source?: string | null; payload: string },
      critical = true,
    ): { seq: number; persisted: boolean } => {
      const seq = eventSeq++
      const db = this._db
      // A force-failed child may continue emitting after its durable job became
      // terminal (and its history may already be deleted). Keep parsing usage
      // in memory for late reconciliation, but never write child events through
      // a terminal/missing FK or let storage failure escape readline.
      if (!db) return { seq, persisted: true }
      if (
        this._jobs.get(jobId)?.status !== 'running' && !this._forceFailedRowJobs.has(jobId)
      ) return { seq, persisted: false }
      try {
        appendEvent(db, jobId, seq, event)
      } catch (err) {
        console.error(`[queue-manager] event persistence failed for ${jobId}:`, err)
        if (critical && !rawPersistenceFailed) {
          rawPersistenceFailed = true
          this._paused = true
          this._persistQueueState()
          this._broadcastQueueState()
          if (this._activeJobId === jobId) {
            this._persistenceFailedJobs.add(jobId)
            this._kill(jobId)
          } else {
            const surviving = this._forceFailedProcesses.get(jobId)
            if (surviving?.pid) {
              try { treeKillSafe(surviving.pid, 'SIGTERM', () => { /* best-effort */ }) } catch { /* best-effort */ }
            }
          }
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
    this._jobLiveAccounting.set(jobId, { events: adapterEvents, adapter, model: railModel })

    // Synthetic OTEL bridge for providers whose CLI does not honour OTEL_*
    // env vars (codex today). Lifecycle bound to the spawn's close handler.
    let otelBridge: CodexOtelBridge | null = null
    if (telemetryEnabled && !adapter.capabilities.nativeOtelEnv && this._projectId) {
      otelBridge = createCodexOtelBridge({
        jobId,
        projectId: this._projectId,
        desktopPort: this._desktopPort,
        model: railModel,
      })
    }

    // ── Batched broadcast for high-frequency messages (log + event) ──────
    // Collects messages and flushes every ~80ms instead of one WS send per line.
    const pendingBroadcast: WsMessage[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const FLUSH_INTERVAL_MS = 80

    const batchedBroadcast = (msg: WsMessage): void => {
      if (this._disposed) return
      pendingBroadcast.push(msg)
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          if (this._disposed) { pendingBroadcast.length = 0; return }
          const batch = pendingBroadcast.splice(0)
          for (const m of batch) this._broadcast(m)
        }, FLUSH_INTERVAL_MS)
      }
    }

    const flushPending = (): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      const batch = pendingBroadcast.splice(0)
      if (this._disposed) return
      for (const m of batch) this._broadcast(m)
    }

    const emitLine = (source: 'stdout' | 'stderr', line: string): void => {
      const msg: LogMessage = {
        type: 'log',
        source,
        line,
        timestamp: new Date().toISOString(),
        processId: jobId,
      }
      this._logBuffer.push(msg)
      if (this._logBuffer.length > LOG_BUFFER_MAX) {
        this._logBuffer.splice(0, LOG_BUFFER_DROP)
      }
      batchedBroadcast(msg)
    }

    const stdoutReader = createInterface({ input: child.stdout!, crlfDelay: Infinity })
    const stderrReader = createInterface({ input: child.stderr!, crlfDelay: Infinity })
    this._jobReaders.set(jobId, { stdout: stdoutReader, stderr: stderrReader })

    stdoutReader.on('line', (line) => {
      if (this._disposed) return
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* plain text */ }

      // Feed the adapter for the canonical event shape used by
      // finaliseInvocationResult and (optionally) the OTEL bridge. Done
      // alongside the raw event persistence below, NOT in place of it: the
      // raw event log is what feeds the live Job Detail UI and the
      // telemetry export ZIP for non-bridge providers.
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
      if (this._disposed) return
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

      this._onJobExit(jobId, code, lastResultEvent, emitLine, adapterEvents, railModel, adapter)
    })

    this._broadcastQueueState()
  }

  private _onJobExit(
    jobId: string,
    code: number | null,
    lastResultEvent: Record<string, unknown> | null,
    emitLine: (source: 'stdout' | 'stderr', line: string) => void,
    adapterEvents: readonly AdapterEvent[] = [],
    spawnedModel?: string,
    /** Per-job adapter resolved in _startJob; defaults to the project primary
     *  for any caller that does not thread it (none today). */
    adapter: ProviderAdapter = this._adapter,
  ): void {
    // Timers belong to the job currently holding the single execution slot.
    // A late close from a previously force-failed, unkillable child must not
    // disarm the successor's inactivity watchdog or SIGKILL escalation.
    if (this._activeJobId === jobId) {
      this._clearZombieTimer()
      if (this._killTimer !== null) {
        clearTimeout(this._killTimer)
        this._killTimer = null
      }
    }

    // Read terminal context now, but consume it only after the terminal row and
    // recovery intent commit. A failed disk write must leave enough ownership
    // for graceful/startup recovery to retry the exact same run.
    const snapshot = this._snapshotRefs.get(jobId)
    const jobExecution = this._jobExecution.get(jobId)
    const prDelivery = this._jobPrDelivery.get(jobId) ?? false
    const provenanceRepoDir = jobExecution?.repoDir ?? this._cwd
    const consumeTerminalContext = (): void => {
      const readers = this._jobReaders.get(jobId)
      try { readers?.stdout.close() } catch { /* best-effort */ }
      try { readers?.stderr.close() } catch { /* best-effort */ }
      this._jobReaders.delete(jobId)
      this._snapshotRefs.delete(jobId)
      this._jobExecution.delete(jobId)
      this._jobResolvedProvider.delete(jobId)
      this._jobLiveAccounting.delete(jobId)
      this._jobPrDelivery.delete(jobId)
      this._cleanupOpenspecShim(jobId)
    }

    // A3: release the active slot for THIS job before any early return, so a
    // disposed/unknown-job exit can never leave the slot reserved (which would
    // wedge the queue). Guarded by identity in case a stale exit fires late.
    if (this._activeJobId === jobId) {
      this._activeProcess = null
      this._activeJobId = null
    }

    // The manager was torn down (e.g. project removed) while the child was
    // still running. The DB may be closed; skip all bookkeeping to avoid an
    // uncaught throw inside this EventEmitter 'close' listener.
    if (this._disposed) {
      consumeTerminalContext()
      return
    }

    const job = this._jobs.get(jobId)
    if (!job) {
      consumeTerminalContext()
      this._drainQueue()
      return
    }

    // LOW-6: this is the LATE close of a job already force-failed by
    // _forceFailUnkillableJob (SIGKILL escalation failed, then the child died on
    // its own). The terminal side-effects (status, onJobFinished, dependents,
    // pipeline, slot release) already ran, so route to a cost-only reconciliation
    // that replaces the no-cost placeholder row(s) IF this close captured real
    // spend — never a duplicate row nor a second onJobFinished.
    if (this._forceFailedRowJobs.has(jobId)) {
      consumeTerminalContext()
      this._reconcileForceFailedJobExit(jobId, code, adapterEvents, adapter, spawnedModel)
      return
    }

    const wasZombie = this._zombieJobs.has(jobId)
    const wasCanceling = this._cancelingJobs.has(jobId)
    const wasPersistenceFailed = this._persistenceFailedJobs.has(jobId)
    // A provider may report a semantic turn failure while its CLI still exits
    // successfully (code 0). AdapterEvent is the provider-neutral contract for
    // that condition, so do not let the process exit code relabel it completed.
    // Cancellation/zombie outcomes retain precedence because they describe the
    // user/manager-owned termination of the whole job.
    const providerReportedError = adapterEvents.some((event) => event.kind === 'error')

    let finalStatus: Exclude<Job['status'], 'queued' | 'running'>
    if (wasPersistenceFailed) {
      finalStatus = 'failed'
    } else if (wasZombie) {
      finalStatus = 'zombie_terminated'
    } else if (wasCanceling) {
      finalStatus = 'canceled'
    } else if (providerReportedError) {
      finalStatus = 'failed'
    } else if (code === 0) {
      finalStatus = 'completed'
    } else {
      finalStatus = 'failed'
    }

    const finishedAt = new Date().toISOString()
    const startedAtMs = job.startedAt ? new Date(job.startedAt).getTime() : Number.NaN
    const finishedAtMs = new Date(finishedAt).getTime()
    const wallDurationMs = Number.isFinite(startedAtMs)
      ? Math.max(0, finishedAtMs - startedAtMs)
      : undefined

    // Adapter-driven finalisation must happen before staging so the immutable
    // intent owns the same usage that lands on jobs and ai_invocations. The
    // manager wall clock fills providers such as Kimi that emit no duration;
    // a provider-native duration retains precedence inside the finaliser.
    const { result: normalised, estimated } = finaliseInvocationResult(
      adapter,
      adapterEvents,
      { fallbackModel: spawnedModel, durationMs: wallDurationMs },
    )
    const tokenData: Partial<JobResult> = lastResultEvent || adapterEvents.length > 0
      ? {
          tokens_in: normalised.tokens_in,
          tokens_out: normalised.tokens_out,
          tokens_cache_read: normalised.tokens_cache_read,
          tokens_cache_create: normalised.tokens_cache_create,
          total_cost_usd: normalised.total_cost_usd,
          total_cost_usd_estimated: estimated,
          num_turns: normalised.num_turns,
          model: normalised.model,
          duration_ms: normalised.duration_ms,
          duration_api_ms: normalised.duration_api_ms,
          session_id: normalised.session_id,
        }
      : {}
    const invStatus: InvocationStatus = finalStatus === 'completed'
      ? 'success'
      : (finalStatus === 'canceled' || finalStatus === 'zombie_terminated')
        ? 'aborted'
        : 'failed'

    if (this._db) {
      try {
        this._stageTerminalIntent(job, {
          status: finalStatus,
          invocationStatus: invStatus,
          provider: adapter.id,
          finishedAt,
          exitCode: code,
          result: tokenData,
          ticketCompletionStatus: finalStatus === 'completed'
            ? (prDelivery ? 'on_review' : 'done')
            : undefined,
        })
      } catch (err) {
        // Keep the durable row running and reserve the now-childless slot. This
        // is an explicit fail-stop: no later job may overtake unaccounted work.
        this._activeProcess = null
        this._activeJobId = jobId
        this._terminalPersistenceBlockedJobs.add(jobId)
        this._paused = true
        this._persistQueueState()
        this._broadcastQueueState()
        console.error(`[queue-manager] terminal staging failed for ${jobId}:`, err)
        return
      }
    }

    consumeTerminalContext()
    this._zombieJobs.delete(jobId)
    this._cancelingJobs.delete(jobId)
    this._persistenceFailedJobs.delete(jobId)
    job.status = finalStatus
    job.finishedAt = finishedAt
    job.exitCode = code
    if (lastResultEvent && typeof lastResultEvent.result === 'string') {
      job.resultText = lastResultEvent.result
    }

    let accountingReady = true
    if (this._db) {
      // Code-Explorer post-exit provenance hook. Diffs the working tree against
      // the pre-spawn snapshot and inserts one row per touched path. Gated by
      // SPECRAILS_CODE_EXPLORER (re-checked at each completion so the flag can
      // be flipped off mid-session without leaving partial writes).
      this._recordProvenance(jobId, job.command, provenanceRepoDir, snapshot)

      // Cost comes from the normalised result so providers without a native
      // total_cost_usd field (codex today) still trigger cost alerts based on
      // the pricing-table estimate. When `estimated`, the figure is best-
      // effort — alerts still fire because the user opted into the threshold
      // explicitly and a noisy alert is better than a missed one.
      const jobCost = normalised.total_cost_usd
      const costStr = jobCost != null ? ` | cost: ${estimated ? '~' : ''}$${jobCost.toFixed(4)}` : ''
      emitLine('stdout', `[process exited with code ${code ?? 'unknown'}${costStr}]`)

      // Cost alert: check per-job threshold (app-level, then per-project).
      if (jobCost != null && finalStatus === 'completed') {
        this._emitCostAlerts(jobId, jobCost)
      }

      accountingReady = this._resumeOrphanRecoveries()

      // ─── Daily-budget enforcement (MED-5) ───────────────────────────────────
      // Runs on EVERY terminal exit, not just completed jobs: a failed/aborted
      // claude run still emits real cost (error_max_turns etc.), so a day of
      // expensive failures must still trip the cap. The spend sum reads the
      // canonical ai_invocations ledger (ALL statuses + ALL surfaces — jobs,
      // explore, quick-spec, ai-edit, file-summary, loop, smash) for the server's
      // LOCAL calendar day, not the UTC `date('now')` boundary that mis-buckets
      // spend near local midnight and disagreed with the /budget meter.
      this._enforceDailyBudget()
    } else {
      emitLine('stdout', `[process exited with code ${code ?? 'unknown'}]`)
      try {
        if (finalStatus === 'completed') {
          this._onJobFinished?.(jobId, finalStatus, normalised.total_cost_usd, {
            ticketCompletionStatus: prDelivery ? 'on_review' : 'done',
          })
        } else {
          this._onJobFinished?.(jobId, finalStatus, normalised.total_cost_usd)
        }
      } catch (err) {
        console.error(`[QueueManager] onJobFinished failed for ${jobId}: ${(err as Error).message}`)
      }
      if (finalStatus !== 'completed') {
        this._skipDependents(jobId, `Parent job ${jobId} ${finalStatus}`)
      }
      if (job.pipelineId) this._checkPipelineStatus(job.pipelineId)
    }

    if (!accountingReady) {
      this._paused = true
      this._persistQueueState()
    }
    this._broadcastQueueState()
    if (accountingReady) this._drainQueue()
  }

  /**
   * Code-Explorer provenance recording, shared by the one-shot exit path
   * (_onJobExit) and the interactive settle path (_settleInteractiveJob).
   * Diffs the REPO working tree against the pre-spawn snapshot and inserts one
   * `file_provenance` row per touched path, broadcasting each. Gated by
   * SPECRAILS_CODE_EXPLORER (re-checked at each completion so the flag can be
   * flipped off mid-session without leaving partial writes). Best-effort.
   */
  private _recordProvenance(
    jobId: string,
    command: string,
    provenanceRepoDir: string | undefined,
    snapshot: WorkingTreeSnapshot | undefined,
  ): void {
    if (!isCodeExplorerEnabled() || !provenanceRepoDir || !this._projectId || !this._db) return
    const ref = snapshot?.ref ?? ''
    try {
      const diff = diffAgainstSnapshot(provenanceRepoDir, ref, snapshot?.untracked, snapshot?.headSha)
      const patches = collectDiffPatches(provenanceRepoDir, ref, diff, snapshot?.headSha)
      if (diff.length > 50) {
        console.warn(`[provenance.large_job] job=${jobId} files=${diff.length}`)
      }
      const ticketIds = this._extractTicketIds(command)
      const rows = recordProvenanceForJob(
        this._db,
        this._projectId,
        jobId,
        ticketIds[0] ?? null,
        diff,
        Date.now(),
        patches,
      )
      for (const row of rows) {
        broadcastProvenanceUpdated(this._broadcast, this._projectId, row)
      }
    } catch (err) {
      console.warn(`[queue-manager] provenance recording failed: ${(err as Error).message}`)
    }
  }

  /**
   * Per-job cost alerts (app-level threshold, then per-project threshold),
   * shared by the one-shot exit path and the interactive settle path. The
   * prepared statement touches the DB, which may have been closed mid-job;
   * guarded so a throw never escapes a child 'close'/settle listener.
   */
  private _emitCostAlerts(jobId: string, jobCost: number): void {
    if (!this._db) return
    try {
      const desktopThreshold = this._getCostAlertThreshold?.() ?? null
      if (desktopThreshold != null && jobCost >= desktopThreshold) {
        this._broadcast({ type: 'cost_alert', projectId: '', jobId, cost: jobCost, threshold: desktopThreshold })
      }

      // Per-project job cost threshold (alerts independently of app threshold)
      const projectThresholdRow = this._db.prepare(
        `SELECT value FROM queue_state WHERE key = 'config.job_cost_threshold_usd'`
      ).get() as { value: string } | undefined
      if (projectThresholdRow) {
        const projectThreshold = parseFloat(projectThresholdRow.value)
        if (projectThreshold > 0 && jobCost >= projectThreshold) {
          this._broadcast({ type: 'cost_alert', projectId: '', jobId, cost: jobCost, threshold: projectThreshold })
        }
      }
    } catch (err) {
      console.error('[queue-manager] cost-alert bookkeeping failed (db unavailable?):', err)
    }
  }

  private _resetZombieTimer(ownerJobId?: string): void {
    if (this._zombieTimeoutMs <= 0) return
    const jobId = ownerJobId ?? this._activeJobId
    if (!jobId || this._activeJobId !== jobId) return
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer)
    }
    this._inactivityTimer = setTimeout(() => {
      this._inactivityTimer = null
      if (this._activeJobId === jobId) this._onZombieDetected(jobId)
    }, this._zombieTimeoutMs)
  }

  private _clearZombieTimer(): void {
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer)
      this._inactivityTimer = null
    }
  }

  private _onZombieDetected(jobId: string): void {
    const job = this._jobs.get(jobId)
    if (!job || job.status !== 'running') return

    this._clearZombieTimer()

    const timeoutSec = Math.round(this._zombieTimeoutMs / 1000)
    const line = `[zombie-detection] Job ${jobId} has been inactive for ${timeoutSec}s — auto-terminating`
    console.error(line)

    // Emit directly without going through emitLine (which would reset the zombie timer)
    const msg: LogMessage = {
      type: 'log',
      source: 'stderr',
      line,
      timestamp: new Date().toISOString(),
      processId: jobId,
    }
    this._logBuffer.push(msg)
    if (this._logBuffer.length > LOG_BUFFER_MAX) {
      this._logBuffer.splice(0, LOG_BUFFER_DROP)
    }
    this._broadcast(msg)

    this._zombieJobs.add(jobId)
    this._kill(jobId)
  }

  private _kill(jobId: string): void {
    // Record the cancel intent UP FRONT — even when no child exists yet. A
    // cancel arriving during the async pre-spawn window (plugin verify / profile
    // snapshot) would otherwise early-return below before recording intent, the
    // child would later spawn unobserved, and _onJobExit would stamp 'completed'.
    // With the intent recorded, the post-spawn check in _startJob SIGTERMs the
    // child once it exists, and _onJobExit reads it to stamp 'canceled'.
    this._cancelingJobs.add(jobId)
    if (!this._activeProcess || !this._activeProcess.pid) return

    this._clearZombieTimer()
    // A second cancel()/zombie-kill of the same still-running job would
    // otherwise overwrite (and leak) the in-flight SIGKILL timer, which could
    // later fire treeKill(SIGKILL) against a recycled PID. Clear it first.
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }
    const pid = this._activeProcess.pid
    // treeKillSafe never throws synchronously, but wrap defensively so a kill
    // failure can NEVER propagate into the cancel HTTP route as a 500. On Windows
    // it invokes an absolute taskkill (PATH-independent) so the tree is actually
    // killed; the callback surfaces any failure instead of swallowing it.
    try {
      treeKillSafe(pid, 'SIGTERM', (err) => {
        if (err) console.error(`[kill] SIGTERM tree-kill failed for pid ${pid}: ${err.message}`)
      })
    } catch (err) {
      console.error(`[kill] SIGTERM tree-kill threw for pid ${pid}: ${(err as Error).message}`)
    }

    this._killTimer = setTimeout(() => {
      treeKillSafe(pid, 'SIGKILL', (err) => {
        if (err) {
          // SIGKILL failed — force cleanup so queue is not permanently blocked.
          console.error(`[kill] SIGKILL failed for pid ${pid}: ${err.message}`)
          if (this._activeJobId === jobId) {
            this._forceFailUnkillableJob(jobId)
          }
        }
      })
      this._killTimer = null
    }, 5000)
  }

  /**
   * Terminal handling for a still-`running` job whose child survived SIGKILL
   * (the escalation `treeKill` errored — most likely on Windows via taskkill).
   * Previously this branch only force-failed the row in memory + DB and released
   * the slot, but skipped `_onJobFinished` (so ticket status never reverted/
   * flagged and budget/webhook/Jira write-back never fired), skipped
   * `recordInvocation`, and leaked every per-job map + the git-stash snapshot +
   * the openspec shim. Route through the same complete teardown the rest of the
   * terminal paths use so a zombie-surviving child can't wedge the rail forever.
   */
  private _forceFailUnkillableJob(jobId: string): void {
    const job = this._jobs.get(jobId)
    const isRunning = !!job && job.status === 'running'
    const survivingProcess = this._activeJobId === jobId ? this._activeProcess : null
    let accountingReady = true
    if (job && isRunning) {
      const finishedAt = new Date().toISOString()
      const live = this._jobLiveAccounting.get(jobId)
      const { result: normalised, estimated } = live
        ? finaliseInvocationResult(live.adapter, live.events, { fallbackModel: live.model })
        : { result: {} as ReturnType<typeof finaliseInvocationResult>['result'], estimated: false }
      const durationMs = normalised.duration_ms ?? (job.startedAt
        ? new Date(finishedAt).getTime() - new Date(job.startedAt).getTime()
        : undefined)
      const provider = live?.adapter.id ?? this._jobResolvedProvider.get(jobId) ?? this._adapter.id
      if (this._db) {
        try {
          this._stageTerminalIntent(job, {
            status: 'failed',
            invocationStatus: 'aborted',
            provider,
            finishedAt,
            exitCode: -1,
            awaitingLateReconciliation: true,
            result: {
              ...normalised,
              total_cost_usd_estimated: estimated,
              duration_ms: durationMs,
            },
          })
        } catch (err) {
          // The child still exists and continues to own the active slot. Leave
          // every map intact and fail-stop the queue so a later close or
          // shutdown can retry the terminal transaction with fuller usage.
          this._terminalPersistenceBlockedJobs.add(jobId)
          this._paused = true
          this._persistQueueState()
          this._broadcastQueueState()
          console.error(`[queue-manager] unkillable terminal staging failed for ${jobId}:`, err)
          return
        }
      }

      job.status = 'failed'
      job.finishedAt = finishedAt
      job.exitCode = -1
      // A surviving child's late close only reconciles richer usage. The
      // durable callback/dependency effects below must never be fired twice.
      this._forceFailedRowJobs.add(jobId)
      if (survivingProcess) this._forceFailedProcesses.set(jobId, survivingProcess)
      if (this._db) accountingReady = this._resumeOrphanRecoveries()
    }

    // Clear completed lifecycle maps, but retain the live adapter-event
    // accumulator until late close/shutdown so usage emitted by the surviving
    // child can still be reconciled.
    this._snapshotRefs.delete(jobId)
    this._jobExecution.delete(jobId)
    this._jobModelSelection.delete(jobId)
    this._jobProfileSelection.delete(jobId)
    this._jobProviderSelection.delete(jobId)
    this._jobResolvedProvider.delete(jobId)
    this._jobInteractiveSelection.delete(jobId)
    this._jobPrDelivery.delete(jobId)
    this._cleanupOpenspecShim(jobId)

    this._activeProcess = null
    this._activeJobId = null
    this._cancelingJobs.delete(jobId)
    this._zombieJobs.delete(jobId)

    // DB-backed terminal effects are delivered by the outbox. Keep the direct
    // path only for ephemeral managers that have no durable project database.
    if (isRunning && !this._db) {
      try {
        this._onJobFinished?.(jobId, 'failed', undefined)
      } catch (err) {
        console.error(`[QueueManager] onJobFinished failed for ${jobId}: ${(err as Error).message}`)
      }
      this._skipDependents(jobId, `Parent job ${jobId} failed`)
      if (job?.pipelineId) this._checkPipelineStatus(job.pipelineId)
    }

    if (!accountingReady) {
      this._paused = true
      this._persistQueueState()
    }
    this._broadcastQueueState()
    if (accountingReady) this._drainQueue()
  }

  /**
   * Cost-only reconciliation for the LATE `close` of a job already force-failed
   * by `_forceFailUnkillableJob` (LOW-6). All terminal side-effects
   * (onJobFinished, dependents, pipeline, slot release) already ran, so this
   * neither re-fires them nor inserts a duplicate row. If the child ultimately
   * captured real spend, the no-cost placeholder row(s) are replaced with the
   * real cost; otherwise the placeholder is left untouched.
   */
  private _reconcileForceFailedJobExit(
    jobId: string,
    code: number | null,
    adapterEvents: readonly AdapterEvent[],
    adapter: ProviderAdapter,
    spawnedModel?: string,
  ): void {
    const job = this._jobs.get(jobId)
    this._forceFailedProcesses.delete(jobId)
    // Ephemeral managers have no second durable history projection. Retain both
    // the failed tombstone and the late-close guard; a duplicate close remains
    // a no-op instead of making the job disappear or re-firing callbacks.
    if (!this._db || !job) return
    this._pendingLateReconciliations.set(jobId, {
      code,
      adapterEvents: [...adapterEvents],
      adapter,
      spawnedModel,
    })

    try {
      const finalised = finaliseInvocationResult(
        adapter,
        adapterEvents,
        { fallbackModel: spawnedModel },
      )
      const normalised = sanitizeRecoveredResult(finalised.result)
      const estimated = finalised.estimated
      const hasRealSpend =
        (normalised.total_cost_usd ?? 0) > 0 ||
        (normalised.tokens_in ?? 0) > 0 ||
        (normalised.tokens_out ?? 0) > 0 ||
        (normalised.tokens_cache_read ?? 0) > 0 ||
        (normalised.tokens_cache_create ?? 0) > 0
      const finalStatus: InvocationStatus = code === 0
        ? 'success'
        : code === null
          ? 'aborted'
          : 'failed'
      const reconcile = this._db.transaction(() => {
        const recovery = this._db!.prepare(`
          SELECT payload, accounting_completed
            FROM orphan_job_recovery WHERE job_id = ?
        `).get(jobId) as { payload: string; accounting_completed: number } | undefined
        if (!recovery) {
          throw new Error(`Missing late-reconciliation intent for ${jobId}`)
        }

        const { payload } = this._decodeRecoveryPayload(jobId, recovery.payload)
        payload.awaitingLateReconciliation = false
        if (hasRealSpend) {
          Object.assign(payload, {
            provider: adapter.id,
            model: normalised.model ?? null,
            tokensIn: normalised.tokens_in ?? null,
            tokensOut: normalised.tokens_out ?? null,
            tokensCacheRead: normalised.tokens_cache_read ?? null,
            tokensCacheCreate: normalised.tokens_cache_create ?? null,
            totalCostUsd: normalised.total_cost_usd ?? null,
            totalCostUsdEstimated: estimated ? 1 : 0,
            numTurns: normalised.num_turns ?? null,
            durationMs: normalised.duration_ms ?? null,
            durationApiMs: normalised.duration_api_ms ?? null,
            sessionId: normalised.session_id ?? null,
            invocationStatus: finalStatus,
          })
        }
        const validatedPayload = this._decodeRecoveryPayload(
          jobId,
          JSON.stringify(payload),
        ).payload

        // Convert the already-completed partial accounting checkpoint back into
        // a durable pending intent before removing its placeholder. If the real
        // ledger insert later fails, restart/resume owns the full late payload.
        const shouldReaccount = hasRealSpend && !!this._projectId
        this._db!.prepare(`
          UPDATE orphan_job_recovery
             SET payload = ?, accounting_completed = ?
           WHERE job_id = ?
        `).run(JSON.stringify(validatedPayload), shouldReaccount ? 0 : recovery.accounting_completed, jobId)
        if (shouldReaccount) {
          this._db!.prepare(
            `DELETE FROM ai_invocations WHERE surface_ref_id = ? OR surface_ref_id LIKE ?`
          ).run(jobId, `${jobId}#t%`)
        }

        if (hasRealSpend) {
          // Reflect the real cost on the jobs row too (it was force-failed with
          // a partial snapshot while the child was still alive).
          finishJob(this._db!, jobId, {
            exit_code: code ?? -1,
            status: 'failed',
            tokens_in: normalised.tokens_in,
            tokens_out: normalised.tokens_out,
            tokens_cache_read: normalised.tokens_cache_read,
            tokens_cache_create: normalised.tokens_cache_create,
            total_cost_usd: normalised.total_cost_usd,
            total_cost_usd_estimated: estimated,
            num_turns: normalised.num_turns,
            model: normalised.model,
            duration_ms: normalised.duration_ms,
            duration_api_ms: normalised.duration_api_ms,
            session_id: normalised.session_id,
          })
        }
      })
      reconcile()
      this._forceFailedRowJobs.delete(jobId)
      this._jobLiveAccounting.delete(jobId)
      this._pendingLateReconciliations.delete(jobId)
      this._terminalPersistenceBlockedJobs.delete(jobId)
      const accountingReady = this._resumeOrphanRecoveries()
      if (!accountingReady) {
        this._paused = true
        this._persistQueueState()
        this._broadcastQueueState()
      }
    } catch (err) {
      // Keep the guard + tombstone so this runtime never treats a duplicate
      // event as a new terminal job. No successor is admitted after an unknown
      // late spend until the operator retries/restarts with healthy storage.
      this._terminalPersistenceBlockedJobs.add(jobId)
      this._paused = true
      this._persistQueueState()
      this._broadcastQueueState()
      console.error('[queue-manager] force-fail reconcile failed:', err)
    }
  }

  private _broadcastQueueState(): void {
    this._broadcast({
      type: 'queue',
      jobs: this.getJobs(),
      activeJobId: this._activeJobId,
      paused: this._paused,
      timestamp: new Date().toISOString(),
    })
  }

  /** Materialise the exact restart semantics for one unstarted admission.
   * Map presence matters for profile and interactive: null/false are explicit
   * choices and must never collapse into the absent/default state. */
  private _queuedJobRecord(job: Job): QueuedJobRecord {
    const hasProfileSelection = this._jobProfileSelection.has(job.id)
    const hasInteractiveSelection = this._jobInteractiveSelection.has(job.id)
    return {
      id: job.id,
      command: job.command,
      queue_position: job.queuePosition,
      priority: job.priority,
      depends_on_job_id: job.dependsOnJobId,
      pipeline_id: job.pipelineId,
      provider: this._jobProviderSelection.get(job.id) ?? null,
      model: this._jobModelSelection.get(job.id) ?? null,
      profile_name: hasProfileSelection
        ? (this._jobProfileSelection.get(job.id) ?? null)
        : null,
      profile_selection_set: hasProfileSelection,
      interactive: hasInteractiveSelection
        ? this._jobInteractiveSelection.get(job.id)!
        : null,
      causal_ownership: job.causalOwnership === true,
    }
  }

  private _persistJob(job: Job, strict = false): void {
    if (!this._db) return
    try {
      if (job.status === 'queued') {
        upsertQueuedJob(this._db, this._queuedJobRecord(job))
      } else if (TERMINAL_STATUSES.has(job.status)) {
        deleteQueuedJob(this._db, job.id)
      }
    } catch (err) {
      if (strict) throw err
      // Persistence remains best-effort for callers racing project teardown.
    }
  }

  /** Persist the complete in-memory queue order in one transaction. Explicit
   * removals cover terminal-before-start paths while leaving the active
   * pre-spawn admission intact until createJob atomically promotes it. */
  private _persistQueuedState(
    strict = false,
    removedJobIds: readonly string[] = [],
    reservedJobId?: string,
  ): void {
    const db = this._db
    if (!db) return

    try {
      const persist = db.transaction(() => {
        for (const id of removedJobIds) deleteQueuedJob(db, id)
        if (reservedJobId) {
          const reserved = this._jobs.get(reservedJobId)
          if (reserved) {
            upsertQueuedJob(db, {
              ...this._queuedJobRecord(reserved),
              // A selected-but-not-yet-spawned admission must restore ahead of
              // the remaining queue; using 0 also avoids duplicate position 1.
              queue_position: 0,
            })
          }
        }
        for (const id of this._queue) {
          const job = this._jobs.get(id)
          if (!job || job.status !== 'queued') continue
          upsertQueuedJob(db, this._queuedJobRecord(job))
        }
      })
      persist()
    } catch (err) {
      if (strict) throw err
      // Best-effort for internal teardown/drain paths; admissions and public
      // queue mutations call this in strict mode and roll back in memory.
    }
  }

  private _persistQueueState(): void {
    if (!this._db) return
    try {
      this._db.prepare(
        `INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', ?)`
      ).run(this._paused ? 'true' : 'false')
    } catch {
      // queue_state table may not exist if migration hasn't run
    }
  }

  private _restoreFromDb(): void {
    if (!this._db) return

    let recoveryAccountingReady = false
    const restoredIds: string[] = []
    try {
      this._captureOrphanRecoveries()

      // Restore queued jobs by their durable positions, then re-assert the
      // priority invariant. `reorder` only permits movement within a priority
      // band, so this sort is also a defensive repair for older/corrupt rows.
      const rows = this._db.prepare(
        `SELECT id, command, queue_position, priority, depends_on_job_id, pipeline_id,
                provider, model, profile_name, profile_selection_set, interactive,
                causal_ownership
           FROM queued_jobs
         UNION ALL
         SELECT id, command, queue_position, priority, depends_on_job_id, pipeline_id,
                NULL AS provider, NULL AS model, NULL AS profile_name,
                0 AS profile_selection_set, NULL AS interactive,
                causal_ownership
           FROM jobs
          WHERE status = 'queued'
            AND NOT EXISTS (SELECT 1 FROM queued_jobs WHERE queued_jobs.id = jobs.id)
         ORDER BY queue_position ASC, id ASC`
      ).all() as Array<{
        id: string
        command: string
        queue_position: number | null
        priority: string | null
        depends_on_job_id: string | null
        pipeline_id: string | null
        provider: string | null
        model: string | null
        profile_name: string | null
        profile_selection_set: number
        interactive: number | null
        causal_ownership: number
      }>

      for (const row of rows) {
        const priority = (VALID_PRIORITIES.has(row.priority ?? '') ? row.priority : 'normal') as JobPriority
        const job: Job = {
          id: row.id,
          command: row.command,
          status: 'queued',
          queuePosition: row.queue_position,
          priority,
          startedAt: null,
          finishedAt: null,
          exitCode: null,
          dependsOnJobId: row.depends_on_job_id ?? null,
          pipelineId: row.pipeline_id ?? null,
          skipReason: null,
          resultText: null,
          causalOwnership: row.causal_ownership === 1,
        }
        this._jobs.set(row.id, job)
        this._queue.push(row.id)
        restoredIds.push(row.id)
        if (row.provider) {
          this._jobProviderSelection.set(row.id, row.provider as ProviderId)
        }
        if (row.model !== null) {
          this._jobModelSelection.set(row.id, row.model)
        }
        if (row.profile_selection_set === 1) {
          this._jobProfileSelection.set(row.id, row.profile_name)
        }
        if (row.interactive === 0 || row.interactive === 1) {
          this._jobInteractiveSelection.set(row.id, row.interactive === 1)
        }
      }

      // Higher priority always executes first; Array#sort is stable, preserving
      // queue_position order within each band.
      this._queue.sort((a, b) => {
        const jobA = this._jobs.get(a)!
        const jobB = this._jobs.get(b)!
        return PRIORITY_WEIGHT[jobB.priority] - PRIORITY_WEIGHT[jobA.priority]
      })

      // Queue-terminal recovery must run AFTER queued rows are materialised in
      // memory: the normal `_skipDependents` invariant walks `_jobs`/`_queue`.
      // Its own durable checkpoint keeps this replay-safe if startup crashes
      // before, during, or immediately after the recursive skip.
      recoveryAccountingReady = this._resumeOrphanRecoveries()
      this._recomputePositions()

      // Restore pause state
      const pauseRow = this._db.prepare(
        `SELECT value FROM queue_state WHERE key = 'paused'`
      ).get() as { value: string } | undefined

      this._paused = pauseRow?.value === 'true' || !recoveryAccountingReady
      if (!recoveryAccountingReady) this._persistQueueState()
      this._restoreBlocked = false
    } catch (err) {
      // Discard any partial in-memory projection from this attempt. Admissions
      // are rejected while blocked, so every id here belongs exclusively to the
      // failed restore and can be rebuilt deterministically on resume.
      const restored = new Set(restoredIds)
      this._queue = this._queue.filter((id) => !restored.has(id))
      for (const id of restored) {
        this._jobs.delete(id)
        this._jobProfileSelection.delete(id)
        this._jobProviderSelection.delete(id)
        this._jobResolvedProvider.delete(id)
        this._jobModelSelection.delete(id)
        this._jobInteractiveSelection.delete(id)
      }
      this._restoreBlocked = true
      // Startup cannot safely admit provider work when orphan capture/replay or
      // queue restoration itself failed. Persist the fail-stop when possible;
      // the user can retry after repairing the database.
      this._paused = true
      this._persistQueueState()
      console.error('[queue-manager] durable queue recovery failed:', err)
    }

    // Kick off any restored queued jobs that are ready to run
    if (!this._restoreBlocked) this._drainQueue()
  }

  /** Resolve a parent across live state, execution history and the durable
   * pre-start queue. A missing string id intentionally remains `null`: the
   * established QueueManager contract treats external/nonexistent parents as
   * already satisfied. */
  private _getDependencyStatus(jobId: string): string | null {
    const parent = this._jobs.get(jobId)
    if (parent) return parent.status

    if (this._db) {
      const history = this._db.prepare('SELECT status FROM jobs WHERE id = ?').get(jobId) as
        | { status: string }
        | undefined
      if (history) return history.status
      const queued = this._db.prepare('SELECT 1 FROM queued_jobs WHERE id = ?').get(jobId)
      if (queued) return 'queued'
    }
    return null
  }

  private _isDependencyMet(job: Job): boolean {
    if (!job.dependsOnJobId) return true
    const parentStatus = this._getDependencyStatus(job.dependsOnJobId)
    return parentStatus === null || parentStatus === 'completed'
  }

  private _skipDependents(parentJobId: string, reason: string): void {
    const toSkip: string[] = []
    const affectedPipelines = new Set<string>()

    for (const [id, job] of this._jobs) {
      if (job.dependsOnJobId === parentJobId && job.status === 'queued') {
        toSkip.push(id)
      }
    }

    for (const id of toSkip) {
      const job = this._jobs.get(id)
      if (!job) continue

      const idx = this._queue.indexOf(id)
      if (idx !== -1) this._queue.splice(idx, 1)

      job.status = 'skipped'
      job.finishedAt = new Date().toISOString()
      job.skipReason = reason
      if (job.pipelineId) affectedPipelines.add(job.pipelineId)

      if (this._db) {
        // Ensure the job row exists before updating (queued jobs may not have been persisted via createJob yet)
        const exists = this._db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)
        if (!exists) {
          this._db.prepare(
            `INSERT INTO jobs (id, command, started_at, status, skip_reason, finished_at, depends_on_job_id, pipeline_id, causal_ownership) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?, ?)`
          ).run(id, job.command, job.finishedAt, reason, job.finishedAt, job.dependsOnJobId, job.pipelineId, job.causalOwnership === true ? 1 : 0)
        } else {
          skipJob(this._db, id, reason)
        }
        deleteQueuedJob(this._db, id)
      }

      try {
        this._onJobFinished?.(id, 'skipped', undefined)
      } catch (err) {
        console.error(`[QueueManager] onJobFinished(skipped) failed for ${id}: ${(err as Error).message}`)
      }

      this._skipDependents(id, `Parent job ${id} was skipped`)
    }

    this._recomputePositions()
    this._persistQueuedState()
    for (const pipelineId of affectedPipelines) this._checkPipelineStatus(pipelineId)
  }

  private _snapshotRecoveryDescendants(parentJobId: string): OrphanRecoveryDescendant[] {
    const db = this._db
    if (!db) return []
    const rows = db.prepare(`
      SELECT id, command, depends_on_job_id, pipeline_id, priority, causal_ownership
        FROM queued_jobs
      UNION ALL
      SELECT id, command, depends_on_job_id, pipeline_id, priority, causal_ownership
        FROM jobs
       WHERE status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM queued_jobs WHERE queued_jobs.id = jobs.id)
    `).all() as Array<{
      id: string; command: string; depends_on_job_id: string | null
      pipeline_id: string | null; priority: string | null; causal_ownership: number
    }>
    const children = new Map<string, typeof rows>()
    for (const row of rows) {
      if (!row.depends_on_job_id) continue
      const list = children.get(row.depends_on_job_id) ?? []
      list.push(row)
      children.set(row.depends_on_job_id, list)
    }
    const result: OrphanRecoveryDescendant[] = []
    const seen = new Set<string>()
    const visit = (parentId: string): void => {
      for (const row of children.get(parentId) ?? []) {
        if (seen.has(row.id)) continue
        seen.add(row.id)
        result.push({
          id: row.id,
          command: row.command,
          parentId,
          pipelineId: row.pipeline_id,
          priority: VALID_PRIORITIES.has(row.priority ?? '')
            ? row.priority as JobPriority
            : 'normal',
          causalOwnership: row.causal_ownership === 1,
        })
        visit(row.id)
      }
    }
    visit(parentJobId)
    return result
  }

  /** Apply the immutable descendant snapshot even if history retention already
   * deleted the parent and nulled every live FK. Rows that became terminal by a
   * newer user action are left untouched. */
  private _skipRecoveredDescendants(
    parentJobId: string,
    descendants: readonly OrphanRecoveryDescendant[],
    parentStatus: Exclude<Job['status'], 'queued' | 'running'> = 'failed',
  ): void {
    const db = this._db
    if (!db) return
    for (const descendant of descendants) {
      const admission = db.prepare(`SELECT 1 FROM queued_jobs WHERE id = ?`).get(descendant.id)
      const history = db.prepare(`SELECT status FROM jobs WHERE id = ?`).get(descendant.id) as
        | { status: string }
        | undefined
      const inMemory = this._jobs.get(descendant.id)
      const stillQueued = !!admission || history?.status === 'queued' || inMemory?.status === 'queued'
      // Queued cancellation terminalizes descendants in the same transaction
      // as the root intent. Their callbacks are nevertheless owned by this
      // checkpoint, so an already-skipped snapshot still needs delivery. A
      // different terminal status means a newer action won and is left alone.
      const alreadySkipped = history?.status === 'skipped' || inMemory?.status === 'skipped'
      if (!stillQueued && !alreadySkipped) continue
      const finishedAt = new Date().toISOString()
      const reason = `Parent job ${descendant.parentId === parentJobId ? parentJobId : descendant.parentId} ${
        descendant.parentId === parentJobId ? parentStatus : 'was skipped'
      }`
      if (stillQueued) {
        const index = this._queue.indexOf(descendant.id)
        if (index !== -1) this._queue.splice(index, 1)
        if (inMemory) {
          inMemory.status = 'skipped'
          inMemory.finishedAt = finishedAt
          inMemory.skipReason = reason
          inMemory.queuePosition = null
        }
        if (history) {
          skipJob(db, descendant.id, reason)
        } else {
          const parentStillExists = db.prepare(`SELECT 1 FROM jobs WHERE id = ?`).get(descendant.parentId)
          db.prepare(`
            INSERT INTO jobs (
              id, command, started_at, status, priority, skip_reason, finished_at,
              depends_on_job_id, pipeline_id, causal_ownership
            ) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?, ?, ?)
          `).run(
            descendant.id,
            descendant.command,
            finishedAt,
            descendant.priority,
            reason,
            finishedAt,
            parentStillExists ? descendant.parentId : null,
            descendant.pipelineId,
            descendant.causalOwnership === true ? 1 : 0,
          )
        }
        deleteQueuedJob(db, descendant.id)
      }
      this._onJobFinished?.(descendant.id, 'skipped', undefined, {
        recoveryReplay: true,
        recoveryCommand: descendant.command,
        recoveryTicketIds: extractTicketIdsFromCommand(descendant.command),
        recoveryDurationMs: null,
        recoveryCausalOwnership: descendant.causalOwnership === true,
      })
    }
    this._recomputePositions()
    this._persistQueuedState(true)
  }

  /** Rebuild the best durable usage frontier from raw provider frames. For
   * interactive Claude sessions each result is a per-turn token snapshot but a
   * cumulative cost/turn snapshot, so segments must be folded exactly like the
   * live session; assistant-only tail frames are one estimated in-flight turn. */
  private _recoverPersistedJobUsage(
    jobId: string,
    providerId: string,
    fallbackModel: string | null,
    interactive: boolean,
  ): { result: Partial<JobResult>; estimated: boolean; authoritative: boolean } {
    const db = this._db
    if (!db) return { result: {}, estimated: false, authoritative: false }
    let adapter: ProviderAdapter
    try {
      adapter = getAdapter(providerId as ProviderId)
    } catch {
      adapter = this._adapter
    }
    type RawRow = { seq: number; event_type: string; payload: string }
    const parse = (row: RawRow): readonly AdapterEvent[] => {
      try {
        return parseStreamEvents(adapter, row.payload)
      } catch (err) {
        console.warn(`[queue-manager] ignored malformed durable event for ${jobId}:`, err)
        return []
      }
    }
    const makeUsageAccumulator = () => {
      const totals = {
        tokens_in: 0,
        tokens_out: 0,
        tokens_cache_read: 0,
        tokens_cache_create: 0,
        total_cost_usd: 0,
        num_turns: 0,
        duration_ms: 0,
        duration_api_ms: 0,
      }
      let model: string | undefined = fallbackModel ?? undefined
      let sessionId: string | undefined
      let estimated = false
      const snapshots = new Map<string, Partial<JobResult>>()
      const MAX_SNAPSHOT_KEYS = 4_096
      const add = (event: AdapterEvent, seq: number): void => {
        const finalised = finaliseInvocationResult(adapter, [event], { fallbackModel: model })
        const result = sanitizeRecoveredResult(finalised.result)
        const raw = event.kind === 'other' ? event.raw : null
        const message = raw && typeof raw.message === 'object' && raw.message
          ? raw.message as Record<string, unknown>
          : null
        const directMessageId = (event as AdapterEvent & { messageId?: string }).messageId
        const messageId = directMessageId ?? (
          message && typeof message.id === 'string' ? message.id : undefined
        )
        const stableId = messageId ? `message:${messageId}` : `${event.kind}:${seq}`
        const previous = snapshots.get(stableId) ?? {}
        const addDelta = (key: keyof typeof totals): void => {
          const current = result[key]
          if (typeof current !== 'number') return
          const prior = previous[key]
          totals[key] += Math.max(0, current - (typeof prior === 'number' ? prior : 0))
        }
        addDelta('tokens_in')
        addDelta('tokens_out')
        addDelta('tokens_cache_read')
        addDelta('tokens_cache_create')
        addDelta('total_cost_usd')
        addDelta('num_turns')
        addDelta('duration_ms')
        addDelta('duration_api_ms')
        model = result.model ?? model
        sessionId = result.session_id ?? sessionId
        estimated = estimated || finalised.estimated
        if (!snapshots.has(stableId) && snapshots.size >= MAX_SNAPSHOT_KEYS) {
          snapshots.delete(snapshots.keys().next().value as string)
        }
        // Frames for one provider message are contiguous; retain a bounded LRU
        // of recent snapshots for retransmission/delta dedupe without letting a
        // malicious transcript allocate one map entry per event forever.
        snapshots.delete(stableId)
        snapshots.set(stableId, { ...previous, ...result })
      }
      const result = (): { result: Partial<JobResult>; estimated: boolean } => {
        const hasUsage = Object.values(totals).some((value) => value > 0)
        return {
          result: hasUsage ? { ...totals, model, session_id: sessionId } : {},
          estimated,
        }
      }
      return { add, result }
    }

    if (!interactive) {
      const accumulator = makeUsageAccumulator()
      let lastValidResult:
        | ReturnType<typeof finaliseInvocationResult>
        | null = null
      const events = db.prepare(`
        SELECT seq, event_type, payload FROM events
         WHERE job_id = ? AND source = 'stdout' AND event_type != 'log'
         ORDER BY seq, id
      `).iterate(jobId) as Iterable<RawRow>
      for (const row of events) {
        for (const event of parse(row)) {
          if (event.kind === 'result') {
            const finalised = finaliseInvocationResult(adapter, [event], {
              fallbackModel: fallbackModel ?? undefined,
            })
            lastValidResult = {
              ...finalised,
              result: sanitizeRecoveredResult(finalised.result),
            }
          } else {
            accumulator.add(event, row.seq)
          }
        }
      }
      const fallback = accumulator.result()
      if (lastValidResult) {
        const result: Partial<JobResult> = { ...fallback.result }
        for (const [key, value] of Object.entries(lastValidResult.result)) {
          // Provider normalisers intentionally retain optional keys with an
          // undefined value. Only concrete terminal fields are authoritative;
          // an omitted field must not erase recoverable assistant evidence.
          if (value !== undefined) {
            (result as Record<string, unknown>)[key] = value
          }
        }
        return {
          result,
          // A native terminal cost is authoritative. When the terminal frame
          // omits cost, preserve whether the assistant-frame backfill was an
          // estimate instead of silently relabelling it as exact.
          estimated: result.total_cost_usd === lastValidResult.result.total_cost_usd &&
            lastValidResult.result.total_cost_usd !== undefined
            ? lastValidResult.estimated
            : (lastValidResult.estimated || fallback.estimated),
          authoritative: true,
        }
      }
      return { ...fallback, authoritative: false }
    }

    const totals = {
      tokens_in: 0,
      tokens_out: 0,
      tokens_cache_read: 0,
      tokens_cache_create: 0,
      total_cost_usd: 0,
      num_turns: 0,
      duration_ms: 0,
      duration_api_ms: 0,
    }
    let model: string | undefined = fallbackModel ?? undefined
    let sessionId: string | undefined
    let baselineCost = 0
    let baselineTurns = 0
    let estimated = false
    let lastResultSeq = -1
    const resultRows = db.prepare(`
      SELECT seq, event_type, payload FROM events
       WHERE job_id = ? AND source = 'stdout' AND event_type = 'result'
       ORDER BY seq, id
    `).iterate(jobId) as Iterable<RawRow>
    for (const row of resultRows) {
      for (const event of parse(row)) {
        if (event.kind !== 'result') continue
        const finalised = finaliseInvocationResult(adapter, [event], { fallbackModel: model })
        const result = sanitizeRecoveredResult(finalised.result)
        totals.tokens_in += result.tokens_in ?? 0
        totals.tokens_out += result.tokens_out ?? 0
        totals.tokens_cache_read += result.tokens_cache_read ?? 0
        totals.tokens_cache_create += result.tokens_cache_create ?? 0
        const cumulativeCost = result.total_cost_usd ?? baselineCost
        totals.total_cost_usd += Math.max(0, cumulativeCost - baselineCost)
        baselineCost = cumulativeCost
        const cumulativeTurns = result.num_turns ?? (baselineTurns + 1)
        totals.num_turns += Math.max(0, cumulativeTurns - baselineTurns)
        baselineTurns = cumulativeTurns
        totals.duration_ms += result.duration_ms ?? 0
        totals.duration_api_ms += result.duration_api_ms ?? 0
        model = result.model ?? model
        sessionId = result.session_id ?? sessionId
        estimated = estimated || finalised.estimated
        lastResultSeq = row.seq
      }
    }

    const tail = makeUsageAccumulator()
    const tailRows = db.prepare(`
      SELECT seq, event_type, payload FROM events
       WHERE job_id = ? AND source = 'stdout' AND event_type != 'log' AND seq > ?
       ORDER BY seq, id
    `).iterate(jobId, lastResultSeq) as Iterable<RawRow>
    for (const row of tailRows) {
      for (const event of parse(row)) {
        if (event.kind !== 'result') tail.add(event, row.seq)
      }
    }
    const tailUsage = tail.result()
    const tailResult = tailUsage.result
    const hasTailUsage = [
      tailResult.tokens_in,
      tailResult.tokens_out,
      tailResult.tokens_cache_read,
      tailResult.tokens_cache_create,
      tailResult.total_cost_usd,
    ].some((value) => typeof value === 'number' && value > 0)
    if (hasTailUsage) {
      totals.tokens_in += tailResult.tokens_in ?? 0
      totals.tokens_out += tailResult.tokens_out ?? 0
      totals.tokens_cache_read += tailResult.tokens_cache_read ?? 0
      totals.tokens_cache_create += tailResult.tokens_cache_create ?? 0
      totals.total_cost_usd += tailResult.total_cost_usd ?? 0
      totals.num_turns += tailResult.num_turns ?? 1
      totals.duration_ms += tailResult.duration_ms ?? 0
      totals.duration_api_ms += tailResult.duration_api_ms ?? 0
      model = tailResult.model ?? model
      sessionId = tailResult.session_id ?? sessionId
      estimated = estimated || tailUsage.estimated
    }

    const hasRecoveredUsage = Object.values(totals).some((value) => value > 0)
    return {
      result: hasRecoveredUsage
        ? {
            ...totals,
            model,
            session_id: sessionId,
          }
        : {},
      estimated,
      authoritative: false,
    }
  }

  private _decodeRecoveryPayload(
    jobId: string,
    encoded: string,
  ): {
    payload: OrphanRecoveryPayload
    terminalStatus: Exclude<Job['status'], 'queued' | 'running'>
    invocationStatus: InvocationStatus
  } {
    const payload = JSON.parse(encoded) as OrphanRecoveryPayload
    if (!payload || typeof payload !== 'object') throw new Error('payload is not an object')
    if (typeof payload.command !== 'string') throw new Error('payload command is invalid')
    // Ticket ownership is derived from the immutable command, never trusted
    // from a legacy/corrupt payload. This also repairs pre-fix [0]/overflow ids.
    payload.ticketIds = extractTicketIdsFromCommand(payload.command)
    payload.totalCostUsdEstimated ??= 0
    const terminalStatus = payload.terminalStatus ?? 'failed'
    const invocationStatus = payload.invocationStatus ?? 'aborted'
    const nullableNumber = (value: unknown): boolean =>
      value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    if (
      payload.id !== jobId ||
      typeof payload.startedAt !== 'string' ||
      typeof payload.finishedAt !== 'string' ||
      typeof payload.provider !== 'string' || !payload.provider ||
      (payload.pipelineId !== null && typeof payload.pipelineId !== 'string') ||
      !payload.ticketIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
      !nullableNumber(payload.tokensIn) ||
      !nullableNumber(payload.tokensOut) ||
      !nullableNumber(payload.tokensCacheRead) ||
      !nullableNumber(payload.tokensCacheCreate) ||
      !nullableNumber(payload.totalCostUsd) ||
      !nullableNumber(payload.numTurns) ||
      !nullableNumber(payload.durationMs) ||
      !nullableNumber(payload.durationApiMs) ||
      (payload.totalCostUsdEstimated !== 0 && payload.totalCostUsdEstimated !== 1) ||
      (payload.exitCode != null && !Number.isInteger(payload.exitCode)) ||
      (payload.model !== null && typeof payload.model !== 'string') ||
      (payload.sessionId !== null && typeof payload.sessionId !== 'string') ||
      (payload.causalOwnership !== undefined && typeof payload.causalOwnership !== 'boolean') ||
      (payload.awaitingLateReconciliation !== undefined && typeof payload.awaitingLateReconciliation !== 'boolean') ||
      (payload.ticketCompletionStatus !== undefined && !['done', 'on_review'].includes(payload.ticketCompletionStatus)) ||
      !TERMINAL_STATUSES.has(terminalStatus) ||
      !['success', 'failed', 'aborted'].includes(invocationStatus) ||
      (payload.descendants !== undefined && (
        !Array.isArray(payload.descendants) ||
        !payload.descendants.every((descendant) =>
          descendant && typeof descendant.id === 'string' &&
          typeof descendant.command === 'string' &&
          typeof descendant.parentId === 'string' &&
          (descendant.pipelineId === null || typeof descendant.pipelineId === 'string') &&
          VALID_PRIORITIES.has(descendant.priority) &&
          (descendant.causalOwnership === undefined || typeof descendant.causalOwnership === 'boolean')
        )
      ))
    ) {
      throw new Error('payload identity or fields are invalid')
    }
    return { payload, terminalStatus, invocationStatus }
  }

  /**
   * Atomically convert every crash-orphaned RUNNING job into a durable recovery
   * intent and a failed job. The outbox snapshot is committed in the SAME
   * SQLite transaction as the status flip, so a process death can leave either
   * the original running row or a replayable failed row — never an untracked
   * half-recovery.
   */
  private _captureOrphanRecoveries(): void {
    const db = this._db
    if (!db) return

    type OrphanJob = {
      id: string
      command: string
      pipeline_id: string | null
      provider: string | null
      started_at: string | null
      model: string | null
      tokens_in: number | null
      tokens_out: number | null
      tokens_cache_read: number | null
      tokens_cache_create: number | null
      total_cost_usd: number | null
      total_cost_usd_estimated: number | null
      num_turns: number | null
      duration_ms: number | null
      duration_api_ms: number | null
      session_id: string | null
      causal_ownership: number
      interactive: number
    }

    const capture = db.transaction(() => {
      // A server restart proves that no prior-process `close` listener can
      // still enrich a force-failed job. Release those holds and retain the
      // partial usage already checkpointed as the best available evidence.
      const heldRecoveries = db.prepare(`
        SELECT recovery.job_id, recovery.payload, recovery.accounting_completed,
               jobs.provider, jobs.model, jobs.interactive
          FROM orphan_job_recovery AS recovery
          LEFT JOIN jobs ON jobs.id = recovery.job_id
      `).all() as Array<{
        job_id: string
        payload: string
        accounting_completed: number
        provider: string | null
        model: string | null
        interactive: number | null
      }>
      const releaseHold = db.prepare(`
        UPDATE orphan_job_recovery
           SET payload = ?, accounting_completed = ?
         WHERE job_id = ?
      `)
      for (const held of heldRecoveries) {
        let decoded: ReturnType<QueueManager['_decodeRecoveryPayload']>
        try {
          decoded = this._decodeRecoveryPayload(held.job_id, held.payload)
        } catch (err) {
          console.error(`[queue-manager] invalid held recovery payload for ${held.job_id}:`, err)
          throw err
        }
        const { payload, terminalStatus } = decoded
        if (!payload.awaitingLateReconciliation) continue
        const recovered = this._recoverPersistedJobUsage(
          held.job_id,
          held.provider ?? payload.provider ?? this._adapter.id,
          held.model ?? payload.model,
          held.interactive === 1,
        )
        const hasRecoveredUsage = [
          recovered.result.tokens_in,
          recovered.result.tokens_out,
          recovered.result.tokens_cache_read,
          recovered.result.tokens_cache_create,
          recovered.result.total_cost_usd,
        ].some((value) => typeof value === 'number' && value > 0)
        const hasRecoveredEvidence = hasRecoveredUsage || recovered.authoritative
        if (hasRecoveredEvidence) {
          if (recovered.authoritative) {
            payload.model = recovered.result.model ?? null
            payload.tokensIn = recovered.result.tokens_in ?? null
            payload.tokensOut = recovered.result.tokens_out ?? null
            payload.tokensCacheRead = recovered.result.tokens_cache_read ?? null
            payload.tokensCacheCreate = recovered.result.tokens_cache_create ?? null
            payload.totalCostUsd = recovered.result.total_cost_usd ?? null
            payload.totalCostUsdEstimated = recovered.estimated ? 1 : 0
            payload.numTurns = recovered.result.num_turns ?? null
            payload.durationMs = recovered.result.duration_ms ?? null
            payload.durationApiMs = recovered.result.duration_api_ms ?? null
            payload.sessionId = recovered.result.session_id ?? null
          } else {
            payload.model = recovered.result.model ?? payload.model
            payload.tokensIn = maxNullable(payload.tokensIn, recovered.result.tokens_in)
            payload.tokensOut = maxNullable(payload.tokensOut, recovered.result.tokens_out)
            payload.tokensCacheRead = maxNullable(payload.tokensCacheRead, recovered.result.tokens_cache_read)
            payload.tokensCacheCreate = maxNullable(payload.tokensCacheCreate, recovered.result.tokens_cache_create)
            payload.totalCostUsd = maxNullable(payload.totalCostUsd, recovered.result.total_cost_usd)
            payload.totalCostUsdEstimated = (payload.totalCostUsdEstimated || recovered.estimated) ? 1 : 0
            payload.numTurns = maxNullable(payload.numTurns, recovered.result.num_turns)
            payload.durationMs = maxNullable(payload.durationMs, recovered.result.duration_ms)
            payload.durationApiMs = maxNullable(payload.durationApiMs, recovered.result.duration_api_ms)
            payload.sessionId = recovered.result.session_id ?? payload.sessionId
          }
          this._decodeRecoveryPayload(held.job_id, JSON.stringify(payload))
          finishJob(db, held.job_id, {
            exit_code: payload.exitCode ?? -1,
            status: terminalStatus,
            tokens_in: payload.tokensIn ?? undefined,
            tokens_out: payload.tokensOut ?? undefined,
            tokens_cache_read: payload.tokensCacheRead ?? undefined,
            tokens_cache_create: payload.tokensCacheCreate ?? undefined,
            total_cost_usd: payload.totalCostUsd ?? undefined,
            total_cost_usd_estimated: !!payload.totalCostUsdEstimated,
            num_turns: payload.numTurns ?? undefined,
            model: payload.model ?? undefined,
            duration_ms: payload.durationMs ?? undefined,
            duration_api_ms: payload.durationApiMs ?? undefined,
            session_id: payload.sessionId ?? undefined,
          })
        }
        payload.awaitingLateReconciliation = false
        const shouldReaccount = hasRecoveredEvidence && !!this._projectId
        if (shouldReaccount) {
          db.prepare(
            `DELETE FROM ai_invocations WHERE surface_ref_id = ? OR surface_ref_id LIKE ?`,
          ).run(held.job_id, `${held.job_id}#t%`)
        }
        releaseHold.run(
          JSON.stringify(payload),
          shouldReaccount ? 0 : held.accounting_completed,
          held.job_id,
        )
      }

      const orphans = db.prepare(
        `SELECT id, command, pipeline_id, provider, started_at, model, tokens_in, tokens_out, tokens_cache_read,
                tokens_cache_create, total_cost_usd, total_cost_usd_estimated, num_turns,
                duration_ms, duration_api_ms, session_id, causal_ownership, interactive
         FROM jobs WHERE status = 'running' AND owner = 'queue'`
      ).all() as OrphanJob[]
      if (orphans.length === 0) return

      const finishedAt = new Date().toISOString()
      const insert = db.prepare(
        `INSERT OR IGNORE INTO orphan_job_recovery (job_id, payload)
         VALUES (?, ?)`
      )
      for (const orphan of orphans) {
        const finalised = this._recoverPersistedJobUsage(
          orphan.id,
          orphan.provider ?? this._adapter.id,
          orphan.model,
          orphan.interactive === 1,
        )
        const recovered = finalised.result
        const recoveredEstimated = finalised.estimated
        const choose = (
          persisted: number | null,
          raw: number | null | undefined,
        ): number | null => finalised.authoritative ? (raw ?? null) : maxNullable(persisted, raw)
        const payload: OrphanRecoveryPayload = {
          id: orphan.id,
          command: orphan.command,
          ticketIds: extractTicketIdsFromCommand(orphan.command),
          pipelineId: orphan.pipeline_id,
          startedAt: orphan.started_at ?? finishedAt,
          finishedAt,
          // Old rows predate jobs.provider; their only honest fallback is the
          // project's primary adapter. New rows preserve per-job overrides.
          provider: orphan.provider ?? this._adapter.id,
          model: finalised.authoritative
            ? (recovered.model ?? null)
            : (recovered.model ?? orphan.model ?? null),
          tokensIn: choose(orphan.tokens_in, recovered.tokens_in),
          tokensOut: choose(orphan.tokens_out, recovered.tokens_out),
          tokensCacheRead: choose(orphan.tokens_cache_read, recovered.tokens_cache_read),
          tokensCacheCreate: choose(orphan.tokens_cache_create, recovered.tokens_cache_create),
          totalCostUsd: choose(orphan.total_cost_usd, recovered.total_cost_usd),
          totalCostUsdEstimated: finalised.authoritative
            ? (recoveredEstimated ? 1 : 0)
            : ((orphan.total_cost_usd_estimated || recoveredEstimated) ? 1 : 0),
          numTurns: choose(orphan.num_turns, recovered.num_turns),
          durationMs: choose(orphan.duration_ms, recovered.duration_ms),
          durationApiMs: choose(orphan.duration_api_ms, recovered.duration_api_ms),
          sessionId: finalised.authoritative
            ? (recovered.session_id ?? null)
            : (recovered.session_id ?? orphan.session_id ?? null),
          descendants: this._snapshotRecoveryDescendants(orphan.id),
          causalOwnership: orphan.causal_ownership === 1,
          terminalStatus: 'failed',
          invocationStatus: 'aborted',
          exitCode: -1,
        }
        const encoded = JSON.stringify(
          this._decodeRecoveryPayload(orphan.id, JSON.stringify(payload)).payload,
        )
        insert.run(orphan.id, encoded)
        finishJob(db, orphan.id, {
          exit_code: -1,
          status: 'failed',
          tokens_in: payload.tokensIn ?? undefined,
          tokens_out: payload.tokensOut ?? undefined,
          tokens_cache_read: payload.tokensCacheRead ?? undefined,
          tokens_cache_create: payload.tokensCacheCreate ?? undefined,
          total_cost_usd: payload.totalCostUsd ?? undefined,
          total_cost_usd_estimated: !!payload.totalCostUsdEstimated,
          num_turns: payload.numTurns ?? undefined,
          model: payload.model ?? undefined,
          duration_ms: payload.durationMs ?? undefined,
          duration_api_ms: payload.durationApiMs ?? undefined,
          session_id: payload.sessionId ?? undefined,
        })
      }
    })
    capture()
  }

  /**
   * Drain the orphan outbox with an independent durable checkpoint per effect.
   * Accounting runs in the same transaction as its checkpoint, which makes it
   * exactly-once across arbitrary process death. The domain callback is a
   * conventional at-least-once outbox delivery: its DB mutations and checkpoint
   * share a transaction, and every replay carries the same stable job id so its
   * idempotent ticket/rail/Jira mutations can safely converge after a crash. A
   * third checkpoint replays the normal dependent-skip/pipeline invariants only
   * after queued rows have been restored into `_jobs` and `_queue`.
   */
  private _resumeOrphanRecoveries(): boolean {
    try {
      return this._resumeOrphanRecoveriesUnsafe()
    } catch (err) {
      // A durable effect remains pending by construction. Surface a fail-stop
      // result instead of letting an EventEmitter close handler throw uncaught
      // or allowing later provider work to overtake unknown accounting.
      console.error('[queue-manager] terminal recovery drain failed:', err)
      return false
    }
  }

  private _resumeOrphanRecoveriesUnsafe(): boolean {
    const db = this._db
    if (!db) return true

    const rows = db.prepare(
      `SELECT job_id, payload, accounting_completed, callback_completed, terminal_completed
       FROM orphan_job_recovery
       WHERE accounting_completed = 0 OR callback_completed = 0 OR terminal_completed = 0
       ORDER BY created_at, job_id`
    ).all() as OrphanRecoveryRow[]
    let spendingChanged = false
    let invalidRecovery = false

    for (const row of rows) {
      let payload: OrphanRecoveryPayload
      let terminalStatus: Exclude<Job['status'], 'queued' | 'running'>
      let invocationStatus: InvocationStatus
      try {
        ({ payload, terminalStatus, invocationStatus } = this._decodeRecoveryPayload(
          row.job_id,
          row.payload,
        ))
      } catch (err) {
        console.error(`[queue-manager] invalid orphan recovery payload for ${row.job_id}:`, err)
        invalidRecovery = true
        continue
      }

      if (row.accounting_completed === 0 && !this._projectId) {
        db.prepare(`UPDATE orphan_job_recovery SET accounting_completed = 1 WHERE job_id = ?`)
          .run(row.job_id)
      } else if (row.accounting_completed === 0 && this._projectId) {
        try {
          const recordAccounting = db.transaction(() => {
            const pending = db.prepare(
              `SELECT accounting_completed FROM orphan_job_recovery WHERE job_id = ?`
            ).get(row.job_id) as { accounting_completed: number } | undefined
            if (!pending || pending.accounting_completed !== 0) return false

            this._recordJobInvocations({
              jobId: payload.id,
              provider: payload.provider,
              status: invocationStatus,
              startedAt: payload.startedAt,
              finishedAt: payload.finishedAt,
              ticketIds: payload.ticketIds,
              estimated: !!payload.totalCostUsdEstimated,
              result: {
                tokens_in: payload.tokensIn ?? undefined,
                tokens_out: payload.tokensOut ?? undefined,
                tokens_cache_read: payload.tokensCacheRead ?? undefined,
                tokens_cache_create: payload.tokensCacheCreate ?? undefined,
                total_cost_usd: payload.totalCostUsd ?? undefined,
                num_turns: payload.numTurns ?? undefined,
                model: payload.model ?? undefined,
                session_id: payload.sessionId ?? undefined,
                duration_ms: payload.durationMs ?? undefined,
                duration_api_ms: payload.durationApiMs ?? undefined,
              },
            })
            db.prepare(
              `UPDATE orphan_job_recovery SET accounting_completed = 1 WHERE job_id = ?`
            ).run(row.job_id)
            return true
          })
          spendingChanged = recordAccounting() || spendingChanged
        } catch (err) {
          console.error(`[queue-manager] orphan accounting replay failed for ${row.job_id}:`, err)
        }
      }

      if (row.callback_completed === 0 && !this._onJobFinished) {
        db.prepare(`UPDATE orphan_job_recovery SET callback_completed = 1 WHERE job_id = ?`)
          .run(row.job_id)
      } else if (row.callback_completed === 0 && this._onJobFinished) {
        try {
          const deliverCallback = db.transaction(() => {
            const pending = db.prepare(
              `SELECT callback_completed FROM orphan_job_recovery WHERE job_id = ?`
            ).get(row.job_id) as { callback_completed: number } | undefined
            if (!pending || pending.callback_completed !== 0) return

            this._onJobFinished?.(
              payload.id,
              terminalStatus,
              payload.totalCostUsd ?? undefined,
              {
                recoveryReplay: true,
                recoveryCommand: payload.command,
                recoveryTicketIds: payload.ticketIds,
                recoveryDurationMs: payload.durationMs,
                recoveryCausalOwnership: payload.causalOwnership === true,
                ...(terminalStatus === 'completed' && payload.ticketCompletionStatus
                  ? { ticketCompletionStatus: payload.ticketCompletionStatus }
                  : {}),
              },
            )
            db.prepare(
              `UPDATE orphan_job_recovery SET callback_completed = 1 WHERE job_id = ?`
            ).run(row.job_id)
          })
          deliverCallback()
        } catch (err) {
          console.error(`[queue-manager] orphan outcome replay failed for ${row.job_id}: ${(err as Error).message}`)
        }
      }

      if (row.terminal_completed === 0) {
        // `_skipDependents` updates the in-memory projection before its SQL.
        // SQLite can roll the transaction back, so retain an equally atomic
        // rollback image; otherwise a transient checkpoint failure removes
        // durable queued work from this process until another restart.
        const queueBefore = [...this._queue]
        const jobsBefore = new Map(Array.from(this._jobs, ([id, job]) => [id, {
          status: job.status,
          finishedAt: job.finishedAt,
          skipReason: job.skipReason,
          queuePosition: job.queuePosition,
        }]))
        try {
          const replayTerminalInvariants = db.transaction(() => {
            const pending = db.prepare(
              `SELECT terminal_completed FROM orphan_job_recovery WHERE job_id = ?`
            ).get(row.job_id) as { terminal_completed: number } | undefined
            if (!pending || pending.terminal_completed !== 0) return false

            // Reuse the exact recursive terminal semantics used by live failed
            // jobs. At this point startup has already restored every queued row
            // into memory, so descendants are persisted as skipped and removed
            // from the runnable queue just as they are on a normal exit.
            // Compatibility with intents written before descendant snapshots:
            // materialise once and reuse it for both recovery-safe callbacks
            // and cross-pipeline status evaluation.
            const recoveryDescendants = Array.isArray(payload.descendants)
              ? payload.descendants
              : this._snapshotRecoveryDescendants(payload.id)
            if (terminalStatus !== 'completed') {
              this._skipRecoveredDescendants(payload.id, recoveryDescendants, terminalStatus)
            }
            // Descendants may intentionally belong to different pipelines.
            // Recompute every affected pipeline before checkpointing so a
            // crash replays any missed notification instead of orphaning the
            // child's pipeline in a stale running state.
            const affectedPipelines = new Set<string>()
            if (payload.pipelineId) affectedPipelines.add(payload.pipelineId)
            for (const descendant of recoveryDescendants) {
              if (descendant.pipelineId) affectedPipelines.add(descendant.pipelineId)
            }
            for (const pipelineId of affectedPipelines) {
              this._checkPersistedPipelineStatus(pipelineId)
            }
            db.prepare(
              `UPDATE orphan_job_recovery SET terminal_completed = 1 WHERE job_id = ?`
            ).run(row.job_id)
            return true
          })
          replayTerminalInvariants()
        } catch (err) {
          this._queue = queueBefore
          for (const [id, before] of jobsBefore) {
            const job = this._jobs.get(id)
            if (!job) continue
            job.status = before.status
            job.finishedAt = before.finishedAt
            job.skipReason = before.skipReason
            job.queuePosition = before.queuePosition
          }
          console.error(`[queue-manager] orphan terminal replay failed for ${row.job_id}: ${(err as Error).message}`)
        }
      }
    }

    // A crash before this cleanup is harmless: completed rows are skipped on
    // the next startup and removed then.
    const completedRows = db.prepare(`
      SELECT job_id, payload FROM orphan_job_recovery
       WHERE accounting_completed = 1
         AND callback_completed = 1
         AND terminal_completed = 1
    `).all() as Array<{ job_id: string; payload: string }>
    const removeCompleted = db.prepare(`DELETE FROM orphan_job_recovery WHERE job_id = ?`)
    const cleanupCompleted = db.transaction(() => {
      for (const completed of completedRows) {
        let payload: OrphanRecoveryPayload
        try {
          payload = this._decodeRecoveryPayload(completed.job_id, completed.payload).payload
        } catch (err) {
          throw new Error(`Invalid completed recovery payload for ${completed.job_id}: ${(err as Error).message}`)
        }
        if (payload.awaitingLateReconciliation) continue
        removeCompleted.run(completed.job_id)
      }
    })
    cleanupCompleted()
    if (spendingChanged && this._projectId) {
      try { this._broadcast({ type: 'spending.invalidated', projectId: this._projectId }) } catch { /* advisory */ }
    }
    const pendingCritical = db.prepare(`
      SELECT 1 FROM orphan_job_recovery
       WHERE accounting_completed = 0 OR terminal_completed = 0
       LIMIT 1
    `).get()
    return !pendingCritical && !invalidRecovery
  }

  private _checkPipelineStatus(pipelineId: string): void {
    const pipelineJobs = Array.from(this._jobs.values()).filter(j => j.pipelineId === pipelineId)
    if (pipelineJobs.length === 0) return

    const allDone = pipelineJobs.every(j => j.status === 'completed')
    const anyFailed = pipelineJobs.some(j =>
      j.status === 'failed' || j.status === 'skipped' || j.status === 'canceled' || j.status === 'zombie_terminated'
    )
    const anyPending = pipelineJobs.some(j => j.status === 'queued' || j.status === 'running')

    const status = allDone ? 'completed' : (anyFailed && !anyPending ? 'failed' : null)
    if (!status) {
      // A caller may append work to an existing pipeline id. Its next terminal
      // transition is new and must be observable again.
      this._emittedPipelineStatuses.delete(pipelineId)
      return
    }
    if (this._emittedPipelineStatuses.get(pipelineId) === status) return
    this._broadcast({ type: 'pipeline_status', pipelineId, status })
    this._emittedPipelineStatuses.set(pipelineId, status)
  }

  /**
   * Recovery counterpart of `_checkPipelineStatus`. Terminal parents are not
   * restored into the in-memory job map, so startup must evaluate the complete
   * persisted pipeline rather than the queued-only `_jobs` view.
   */
  private _checkPersistedPipelineStatus(pipelineId: string): void {
    const db = this._db
    if (!db) return
    const rows = db.prepare(
      `SELECT status FROM jobs WHERE pipeline_id = ?
       UNION ALL
       SELECT 'queued' AS status FROM queued_jobs
        WHERE pipeline_id = ?
          AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.id = queued_jobs.id)`
    ).all(pipelineId, pipelineId) as Array<{ status: string }>
    if (rows.length === 0) return

    const allDone = rows.every((job) => job.status === 'completed')
    const anyFailed = rows.some((job) =>
      job.status === 'failed' || job.status === 'skipped' || job.status === 'canceled' || job.status === 'zombie_terminated'
    )
    const anyPending = rows.some((job) => job.status === 'queued' || job.status === 'running')

    try {
      const status = allDone ? 'completed' : (anyFailed && !anyPending ? 'failed' : null)
      if (!status) {
        this._emittedPipelineStatuses.delete(pipelineId)
        return
      }
      if (this._emittedPipelineStatuses.get(pipelineId) === status) return
      this._broadcast({ type: 'pipeline_status', pipelineId, status })
      this._emittedPipelineStatuses.set(pipelineId, status)
    } catch {
      // Startup broadcasts are advisory; persisted terminal state is authoritative.
    }
  }

  private _recomputePositions(): void {
    this._queue.forEach((id, index) => {
      const job = this._jobs.get(id)
      if (job) {
        job.queuePosition = index + 1
      }
    })
  }
}
