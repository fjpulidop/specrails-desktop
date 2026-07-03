import { ChildProcess } from 'child_process'
import fsNode from 'fs'
import pathNode from 'path'
import { createInterface } from 'readline'
import { newId as uuidv4 } from './ids'
import { treeKillSafe } from './util/win-spawn'
import type { WsMessage, LogMessage, Job, PhaseDefinition, JobPriority } from './types'
import { PRIORITY_WEIGHT, VALID_PRIORITIES } from './types'
import { resolveCommand } from './command-resolver'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import { spawnAiCli } from './util/cli-prompt'
import { extractDisplayText } from './util/stream-display'
import { resetPhases, setActivePhases } from './hooks'
import { recordInvocation, type InvocationStatus } from './ai-invocations'
import { isCodeExplorerEnabled } from './feature-flags'
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
import { createCodexOtelBridge, type CodexOtelBridge } from './codex-otel-bridge'
import { createJob, finishJob, appendEvent, skipJob, getProjectSettings, getUltracodePrePrompt, DEFAULT_ULTRACODE_PRE_PROMPT, finalizeInteractiveJob } from './db'
import type { JobResult } from './db'
import { InteractiveJobSession, type SettleInfo, type InteractiveSpawnSpec } from './interactive-job-session'
import type { CommandInfo } from './config'
import { attachmentManager, USER_ATTACHMENT_SYSTEM_NOTE } from './attachment-manager'
import { extractTicketIdsFromCommand, readStore, resolveTicketStoragePath } from './ticket-store'
import { binaryOnPath } from './binary-probe'
import { ensureFrameworkAgents } from './workspace-manager'
import { resolveProjectExecution, type ProjectExecution } from './workspace-resolution'
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'canceled', 'zombie_terminated', 'skipped'])

/** Match an Ultracode rail command: `/specrails:ultracode #5 …` (or `/sr:…`). */
export const ULTRACODE_COMMAND_RE = /^\/(specrails|sr):ultracode\b/

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
  /** Per-job model override (e.g. ultracode rails let the user pick
   *  haiku/sonnet/opus per launch). For claude this becomes the `--model`
   *  value, taking precedence over the project orchestrator model. In-memory
   *  only — a queued job that survives a restart falls back to the default. */
  model?: string
  /** When true, an ultracode (claude) job becomes an interactive persistent
   *  session: it spawns one resident `claude -p --input-format stream-json`
   *  child, accepts more prompts across turns, stays 'running' until an explicit
   *  finalize, and sums every turn's real usage into the job row. Ignored for
   *  non-ultracode commands and providers without persistent-stdin support. */
  interactive?: boolean
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

  private _getCostAlertThreshold: (() => number | null) | null
  private _getDesktopDailyBudget: (() => { budget: number | null; totalSpend: number }) | null
  private _adapter: ProviderAdapter
  /** Effective model to use when spawning processes. For Claude the adapter
   *  reads its own config; this is the override that gets passed via `--model`.
   *  For codex it controls the catalog model used at spawn time and as the
   *  fallback model name stamped onto the ai_invocations row. */
  private _resolvedModel: string | null
  private _onJobFinished: ((jobId: string, status: Job['status'], costUsd?: number) => void) | null
  private _onBudgetExceeded: ((event: string, data: Record<string, unknown>) => void) | null
  /** Project ID used for OTEL resource attributes (Super mode only) */
  private _projectId: string | null
  /** Server port used to construct the OTLP endpoint URL for env injection */
  private _desktopPort: number
  /** Project slug used for per-job profile snapshots (Super mode only) */
  private _projectSlug: string | null
  /** Pending profile selection keyed by jobId — read at spawn time */
  private _jobProfileSelection: Map<string, string | null>
  /** Pending per-job provider override keyed by jobId — read at spawn time.
   *  In-memory only (mirrors _jobProfileSelection): a queued job that survives a
   *  restart falls back to the project's primary provider. */
  private _jobProviderSelection: Map<string, ProviderId>
  /** Resolved adapter id per RUNNING job, captured at `_startJob` time AFTER the
   *  per-job override has been consumed-and-deleted from `_jobProviderSelection`.
   *  Read by `_forceFailUnkillableJob` (and any other terminal path that runs
   *  without a child exit) to stamp `ai_invocations.provider` with the provider
   *  the child ACTUALLY ran on — the override map is empty by then. Cleared with
   *  the other per-job maps at every teardown. In-memory only. */
  private _jobResolvedProvider: Map<string, ProviderId>
  /** Pending per-job model override keyed by jobId — read at spawn time.
   *  In-memory only (mirrors _jobProviderSelection). */
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
  /** Pending per-job interactive flag keyed by jobId — read at spawn time.
   *  In-memory only (mirrors _jobModelSelection). */
  private _jobInteractiveSelection: Map<string, boolean>
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
  /** Jobs terminated by `_forceFailUnkillableJob` (SIGKILL-escalation failure)
   *  whose surviving child's `close` may still fire `_onJobExit` later. Guards
   *  against a duplicate ai_invocations row + a double `_onJobFinished`; a late
   *  close that carries REAL cost replaces the no-cost placeholder rows
   *  (COST-ACCOUNTING-AUDIT LOW-6). In-memory only. */
  private _forceFailedRowJobs: Set<string>

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
      onJobFinished?: (jobId: string, status: Job['status'], costUsd?: number) => void
      /** Fired when a daily/desktop budget is crossed so app-level consumers
       *  (webhooks) can deliver the budget event (the WS broadcast alone never
       *  reached webhook subscribers). */
      onBudgetExceeded?: (event: string, data: Record<string, unknown>) => void
      projectId?: string
      desktopPort?: number
      /** Project slug used to locate per-job profile snapshots at
       *  ~/.specrails/projects/<slug>/jobs/<jobId>/profile.json */
      projectSlug?: string
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
    this._broadcast = broadcast
    this._db = db ?? null
    this._logBuffer = []
    this._commands = commands ?? []
    this._cwd = cwd
    this._inactivityTimer = null
    this._disposed = false

    this._getCostAlertThreshold = options?.getCostAlertThreshold ?? null
    this._getDesktopDailyBudget = options?.getDesktopDailyBudget ?? null
    this._adapter = getAdapter(options?.provider ?? 'claude')
    this._resolvedModel = options?.resolvedModel ?? null
    this._onJobFinished = options?.onJobFinished ?? null
    this._onBudgetExceeded = options?.onBudgetExceeded ?? null
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
    this._interactiveSessions = new Map()
    this._jobLiveAccounting = new Map()
    this._forceFailedRowJobs = new Set()

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
  shutdown(): void {
    if (this._disposed) return
    this._disposed = true

    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer)
      this._inactivityTimer = null
    }
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }

    const proc = this._activeProcess
    if (proc && proc.pid) {
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
    this._flushInFlightAccounting()

    this._activeProcess = null
    this._activeJobId = null
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
    this._jobLiveAccounting.clear()
    this._openspecShims.clear()
    // Drop the DB reference last so any in-flight 'close' callback sees null
    // and skips all DB work via the existing `if (this._db)` guards.
    this._db = null
  }

  /**
   * Write an aborted ai_invocations row (+ persist onto the jobs row) for every
   * job still in flight when the manager is torn down (shutdown / project
   * removal). For a non-interactive rail the cost is estimated from the live
   * `adapterEvents` captured so far (foundation contract); for an interactive
   * session it is the accumulated per-turn spend plus any folded in-flight turn.
   * Called once from shutdown() BEFORE `_db` is nulled. Best-effort per job.
   */
  private _flushInFlightAccounting(): void {
    const db = this._db
    const projectId = this._projectId
    if (!db || !projectId) return

    // ── Active non-interactive rail ──────────────────────────────────────────
    const activeJobId = this._activeJobId
    if (activeJobId) {
      const job = this._jobs.get(activeJobId)
      if (job && job.status === 'running') {
        try {
          const live = this._jobLiveAccounting.get(activeJobId)
          const { result: normalised, estimated } = live
            ? finaliseInvocationResult(live.adapter, live.events, { fallbackModel: live.model })
            : { result: {} as ReturnType<typeof finaliseInvocationResult>['result'], estimated: false }
          const provider = live?.adapter.id ?? this._jobResolvedProvider.get(activeJobId) ?? this._adapter.id
          const finishedAt = new Date().toISOString()
          job.status = 'failed'
          job.finishedAt = finishedAt
          try {
            finishJob(db, activeJobId, {
              exit_code: -1,
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
          } catch { /* DB may be mid-close */ }
          this._recordJobInvocations({
            jobId: activeJobId,
            provider,
            status: 'aborted',
            startedAt: job.startedAt ?? finishedAt,
            finishedAt,
            ticketIds: this._extractTicketIds(job.command),
            estimated,
            result: normalised,
          })
          this._broadcast({ type: 'spending.invalidated', projectId })
        } catch (err) {
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
        job.status = 'failed'
        job.finishedAt = finishedAt
        try { finalizeInteractiveJob(db, jobId, 'failed') } catch { /* DB may be mid-close */ }
        this._recordJobInvocations({
          jobId,
          provider: 'claude',
          status: 'aborted',
          startedAt: job.startedAt ?? finishedAt,
          finishedAt,
          ticketIds: this._extractTicketIds(job.command),
          estimated: snap.estimated,
          result: {
            tokens_in: snap.totals.tokens_in,
            tokens_out: snap.totals.tokens_out,
            tokens_cache_read: snap.totals.tokens_cache_read,
            tokens_cache_create: snap.totals.tokens_cache_create,
            total_cost_usd: snap.totals.total_cost_usd,
            num_turns: snap.totals.num_turns,
            model: snap.model ?? undefined,
            session_id: snap.sessionId ?? undefined,
            duration_ms: snap.activeDurationMs,
          },
        })
        this._broadcast({ type: 'spending.invalidated', projectId })
      } catch (err) {
        console.error('[queue-manager] shutdown flush (interactive job) failed:', err)
      }
    }
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  enqueue(command: string, priorityOrOpts?: JobPriority | EnqueueOptions, opts?: EnqueueOptions): Job {
    // Support both: enqueue(cmd, priority, opts) and enqueue(cmd, opts)
    let priority: JobPriority = 'normal'
    let resolvedOpts: EnqueueOptions | undefined = opts
    if (typeof priorityOrOpts === 'string') {
      priority = priorityOrOpts
    } else if (priorityOrOpts && typeof priorityOrOpts === 'object') {
      resolvedOpts = priorityOrOpts
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

    const id = uuidv4()
    const job: Job = {
      id,
      command,
      status: 'queued',
      queuePosition: null,
      priority,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      dependsOnJobId: resolvedOpts?.dependsOnJobId ?? null,
      pipelineId: resolvedOpts?.pipelineId ?? null,
      skipReason: null,
      resultText: null,
    }

    this._jobs.set(id, job)

    // Record profile selection (if provided) so spawn time can pick it up.
    // `undefined` means "use default resolution"; `null` means "force legacy".
    if (resolvedOpts && 'profileName' in resolvedOpts) {
      this._jobProfileSelection.set(id, resolvedOpts.profileName ?? null)
    }

    // Record per-job provider override so _startJob resolves the right adapter.
    if (resolvedOpts?.provider) {
      this._jobProviderSelection.set(id, resolvedOpts.provider)
    }

    // Record per-job model override (e.g. ultracode model picker).
    if (resolvedOpts?.model) {
      this._jobModelSelection.set(id, resolvedOpts.model)
    }

    // Record per-job interactive flag (ultracode + claude only — enforced at
    // spawn time against the resolved adapter's persistent-stdin capability).
    if (resolvedOpts?.interactive) {
      this._jobInteractiveSelection.set(id, true)
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
    this._persistJob(job)
    this._broadcastQueueState()
    this._drainQueue()

    return job
  }

  cancel(jobId: string): 'canceled' | 'canceling' {
    const job = this._jobs.get(jobId)
    if (!job) {
      throw new JobNotFoundError()
    }
    if (TERMINAL_STATUSES.has(job.status)) {
      throw new JobAlreadyTerminalError()
    }

    if (job.status === 'queued') {
      const idx = this._queue.indexOf(jobId)
      if (idx !== -1) {
        this._queue.splice(idx, 1)
      }
      job.status = 'canceled'
      job.finishedAt = new Date().toISOString()
      // B47: a queued job's per-job selection entries are consumed only when the
      // job STARTS (_resolveJobAdapter et al.). Cancelling it while queued means
      // it never starts, so drop them here to avoid leaking map entries forever.
      this._jobProviderSelection.delete(jobId)
      this._jobResolvedProvider.delete(jobId)
      this._jobModelSelection.delete(jobId)
      this._jobProfileSelection.delete(jobId)
      this._jobInteractiveSelection.delete(jobId)
      this._skipDependents(jobId, `Parent job ${jobId} was canceled`)
      this._recomputePositions()
      this._persistJob(job)
      this._broadcastQueueState()
      // M20: a queued cancel never reached _onJobFinished (only the running path
      // does, via _kill→_onJobExit), so a rail-launched queued job left its
      // railJobs entry stuck 'running' forever and dropped the job.canceled
      // webhook + rail.job_completed broadcast. Fire the callback here too; it is
      // exit-status-driven and idempotent on tickets.
      if (this._onJobFinished) {
        try {
          this._onJobFinished(jobId, 'canceled', undefined)
        } catch (err) {
          console.error(`[QueueManager] onJobFinished(canceled) failed for ${jobId}: ${(err as Error).message}`)
        }
      }
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

  pause(): void {
    this._paused = true
    this._persistQueueState()
    this._broadcastQueueState()
  }

  resume(): void {
    this._paused = false
    this._persistQueueState()
    this._broadcastQueueState()
    this._drainQueue()
  }

  reorder(jobIds: string[]): void {
    const queuedSet = new Set(this._queue)
    const incomingSet = new Set(jobIds)

    if (queuedSet.size !== incomingSet.size) {
      throw new Error('jobIds must contain exactly the IDs of all currently-queued jobs')
    }
    for (const id of jobIds) {
      if (!queuedSet.has(id)) {
        throw new Error(`Job ${id} is not in queued state`)
      }
    }

    this._queue = [...jobIds]
    this._recomputePositions()

    if (this._db) {
      for (const id of jobIds) {
        const job = this._jobs.get(id)
        if (job) {
          this._persistJob(job)
        }
      }
    }

    this._broadcastQueueState()
  }

  updatePriority(jobId: string, priority: JobPriority): void {
    const job = this._jobs.get(jobId)
    if (!job) throw new JobNotFoundError()
    if (job.status !== 'queued') {
      throw new Error('Can only change priority of queued jobs')
    }

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
    this._persistJob(job)
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

  /** True while an interactive ultracode session is resident for this job. */
  isInteractiveJob(jobId: string): boolean {
    return this._interactiveSessions.has(jobId)
  }

  /** Feed one more user prompt to a running interactive job (queued behind the
   *  active turn). Returns false when the job isn't an active interactive
   *  session (unknown / already finalized / not interactive). */
  sendInteractiveTurn(jobId: string, text: string): boolean {
    const session = this._interactiveSessions.get(jobId)
    if (!session) return false
    return session.send(text)
  }

  /** User-initiated finalize for an interactive job: SIGTERM the resident child;
   *  the settle path stamps the summed totals + 'completed' status. Returns false
   *  when the job isn't an active interactive session. */
  finalizeInteractive(jobId: string): boolean {
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
   * Build the Claude prompt for an Ultracode job. Ultracode does NOT invoke
   * a slash command: it sends the resolved pre-prompt followed by the full spec
   * text of every ticket referenced in the command. Fully reconstructible from
   * the command (`/specrails:ultracode #<id> …`) + the local ticket store, so a
   * queued job survives a server restart without losing the prompt.
   */
  private _buildUltracodePrompt(command: string): string {
    const pre = this._db ? getUltracodePrePrompt(this._db) : DEFAULT_ULTRACODE_PRE_PROMPT
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
        console.warn(`[queue-manager] failed to read specs for ultracode: ${(err as Error).message}`)
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

    const readyIndex = this._queue.findIndex(id => {
      const job = this._jobs.get(id)
      if (!job) return true
      return this._isDependencyMet(job)
    })

    if (readyIndex === -1) return

    const nextJobId = this._queue.splice(readyIndex, 1)[0]
    // A3: reserve the active slot SYNCHRONOUSLY, before _startJob's awaits
    // (plugin verify, profile snapshot). Otherwise a second _drainQueue triggered
    // during those awaits (a concurrent /spawn, or the synchronous N-job loop of
    // an Ultracode rail launch) still sees _activeJobId === null and starts a
    // second job in the same working tree, with _activeProcess/_activeJobId then
    // clobbered so cancel/zombie-kill hits the wrong child.
    this._activeJobId = nextJobId
    this._recomputePositions()
    void this._startJob(nextJobId).catch((err) => {
      console.error(`[QueueManager] _startJob(${nextJobId}) threw before spawn: ${(err as Error)?.message}`)
      // Only release if we never established a child (else _onJobExit owns cleanup).
      if (this._activeJobId === nextJobId && this._activeProcess === null) {
        // Stamp the job terminal — _onJobExit never runs without a child, so the
        // job would otherwise wedge 'running' forever and never fire
        // onJobFinished (rail/webhook never settle) and leak its per-job maps.
        this._failWedgedJob(nextJobId, (err as Error)?.message ?? 'startup failure')
        this._activeJobId = null
        this._drainQueue()
      }
    })
  }

  /**
   * Stamp a job terminal-failed when `_startJob` threw BEFORE a child was ever
   * established (so no `_onJobExit` will run). Mirrors _onJobExit's terminal
   * bookkeeping: in-memory + DB status, per-job map cleanup, onJobFinished, and
   * a queue-state broadcast. Best-effort and never throws.
   */
  private _failWedgedJob(jobId: string, reason: string): void {
    const job = this._jobs.get(jobId)
    // The wedge can land before _startJob set status='running' (an early throw in
    // execution/agent resolution) OR after it. Either way the job is terminal-
    // failed now — capture a finished_at to drive the invocation row regardless.
    const finishedAt = new Date().toISOString()
    if (job && job.status === 'running') {
      job.status = 'failed'
      job.finishedAt = finishedAt
    }
    if (this._db) {
      try {
        finishJob(this._db, jobId, { exit_code: -1, status: 'failed' })
      } catch {
        /* DB may be closed mid-shutdown — never throw from the drain catch */
      }

      // ai_invocations capture (surface='job', failed) so a startup-failed job
      // still counts toward totalRuns/failureRate on Analytics. _onJobExit never
      // runs without a child, so this is the ONLY place the row can be written.
      // No token/cost data was ever finalised (the spawn never produced output).
      // BUG-ANALYTICS-01's limitation applies to the provider stamp here too: by
      // this point the per-job override is consumed, so we read the resolved
      // provider captured at _startJob (set right after adapter resolution; may
      // be absent if the throw preceded it) with _adapter.id as the fallback.
      if (this._projectId && job) {
        try {
          const ticketIds = this._extractTicketIds(job.command)
          const durationMs = job.startedAt
            ? new Date(finishedAt).getTime() - new Date(job.startedAt).getTime()
            : undefined
          recordInvocation(this._db, {
            id: randomUUID(),
            project_id: this._projectId,
            provider: this._jobResolvedProvider.get(jobId) ?? this._adapter.id,
            surface: 'job',
            surface_ref_id: jobId,
            ticket_id: ticketIds[0] ?? null,
            status: 'failed',
            started_at: job.startedAt ?? finishedAt,
            finished_at: finishedAt,
            total_cost_usd_estimated: false,
            duration_ms: durationMs,
          })
          this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
        } catch (err) {
          console.error('[queue-manager] recordInvocation (wedged) failed:', err)
        }
      }
    }
    // Clear per-job selection/snapshot maps (none were consumed by a spawn).
    this._jobExecution.delete(jobId)
    this._snapshotRefs.delete(jobId)
    this._jobModelSelection.delete(jobId)
    this._jobProfileSelection.delete(jobId)
    this._jobProviderSelection.delete(jobId)
    this._jobResolvedProvider.delete(jobId)
    this._jobInteractiveSelection.delete(jobId)
    this._jobLiveAccounting.delete(jobId)
    // A wedged job may have had its openspec shim materialised already (the
    // wedge can land after _startJob's shim setup). Mirror the settle path.
    this._cleanupOpenspecShim(jobId)
    try {
      this._onJobFinished?.(jobId, 'failed', undefined)
    } catch {
      /* onJobFinished is best-effort */
    }
    this._persistQueueState()
    this._broadcastQueueState()
    console.error(`[QueueManager] job ${jobId} failed before spawn: ${reason}`)
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
   * (consumed from `_jobProviderSelection`) when present and registered, else
   * the project's primary adapter. Consuming the entry keeps the map bounded.
   */
  private _resolveJobAdapter(jobId: string): ProviderAdapter {
    const override = this._jobProviderSelection.get(jobId)
    this._jobProviderSelection.delete(jobId)
    if (override) {
      try {
        return getAdapter(override)
      } catch {
        /* fall through to primary */
      }
    }
    return this._adapter
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
   * Spawn an interactive ultracode session. The job row is created with the
   * `interactive` flag set; the resident child runs the first turn (the
   * ultracode prompt) and stays alive for follow-up turns until finalize/crash.
   * No zombie timer is armed (the child idles between turns by design) and
   * `_activeProcess` is left null — the session owns the child; the active SLOT
   * (`_activeJobId`, reserved by _drainQueue) is held until settle.
   */
  private _startInteractiveJob(
    jobId: string,
    job: Job,
    adapter: ProviderAdapter,
    spec: InteractiveSpawnSpec,
    firstPrompt: string,
  ): void {
    if (this._db) {
      try {
        createJob(this._db, {
          id: jobId,
          command: job.command,
          started_at: job.startedAt!,
          priority: job.priority,
          depends_on_job_id: job.dependsOnJobId,
          pipeline_id: job.pipelineId,
          interactive: true,
        })
      } catch (err) {
        console.error('[queue-manager] createJob (interactive) failed:', err)
      }
    }

    const session = new InteractiveJobSession({
      jobId,
      projectId: this._projectId ?? '',
      db: this._db,
      adapter,
      broadcast: this._broadcast,
      onSettle: (info) => this._settleInteractiveJob(jobId, info),
    })
    this._interactiveSessions.set(jobId, session)
    session.start(spec, firstPrompt)
    this._broadcastQueueState()
  }

  /**
   * Terminal bookkeeping for an interactive job (called once by the session's
   * onSettle). Releases the active slot, stamps the job's terminal status +
   * finished_at (token/cost totals were already accumulated per turn), writes a
   * single ai_invocations row with the summed usage, fires the rail/ticket
   * completion callback, and drains the queue.
   */
  private _settleInteractiveJob(jobId: string, info: SettleInfo): void {
    this._interactiveSessions.delete(jobId)
    if (this._activeJobId === jobId) {
      this._activeProcess = null
      this._activeJobId = null
    }
    // Interactive jobs skip provenance, but a defensive delete keeps the map
    // clean if a snapshot was ever recorded for this id.
    this._snapshotRefs.delete(jobId)
    this._jobResolvedProvider.delete(jobId)

    // Clean up the per-job openspec PATH shim (relocated claude rails only).
    this._cleanupOpenspecShim(jobId)

    if (this._disposed) return
    const job = this._jobs.get(jobId)
    if (!job) { this._drainQueue(); return }

    const wasCanceling = this._cancelingJobs.has(jobId)
    this._cancelingJobs.delete(jobId)
    const finalStatus: Job['status'] = wasCanceling
      ? 'canceled'
      : info.reason === 'finalized'
        ? 'completed'
        : 'failed'

    job.status = finalStatus
    job.finishedAt = new Date().toISOString()
    job.exitCode = info.reason === 'finalized' ? 0 : 1

    const totals = info.totals
    if (this._db) {
      try {
        finalizeInteractiveJob(this._db, jobId, finalStatus)
      } catch (err) {
        console.error('[queue-manager] finalizeInteractiveJob failed:', err)
      }

      if (this._projectId) {
        try {
          const invStatus: InvocationStatus = finalStatus === 'completed'
            ? 'success'
            : finalStatus === 'canceled'
              ? 'aborted'
              : 'failed'
          const ticketIds = this._extractTicketIds(job.command)
          this._recordJobInvocations({
            jobId,
            provider: 'claude',
            status: invStatus,
            startedAt: job.startedAt ?? new Date().toISOString(),
            finishedAt: job.finishedAt,
            ticketIds,
            // CRIT-4: true when a mid-turn finalize/crash folded an in-flight
            // turn's rate-card-priced usage into the accumulated totals.
            estimated: info.estimated,
            result: {
              tokens_in: totals.tokens_in,
              tokens_out: totals.tokens_out,
              tokens_cache_read: totals.tokens_cache_read,
              tokens_cache_create: totals.tokens_cache_create,
              total_cost_usd: totals.total_cost_usd,
              num_turns: totals.num_turns,
              model: info.model ?? undefined,
              session_id: info.sessionId ?? undefined,
              // LOW-15: sum of active turn wall-segments, not finished−started.
              duration_ms: info.activeDurationMs,
            },
          })
          this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
        } catch (err) {
          console.error('[queue-manager] recordInvocation (interactive) failed:', err)
        }
      }
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

    if (this._onJobFinished) {
      try {
        this._onJobFinished(jobId, finalStatus, totals.total_cost_usd)
      } catch (err) {
        console.error(`[QueueManager] onJobFinished failed for ${jobId}: ${(err as Error).message}`)
      }
    }

    this._drainQueue()
  }

  private async _startJob(jobId: string): Promise<void> {
    const job = this._jobs.get(jobId)
    if (!job) {
      // Job vanished between the synchronous slot reservation in _drainQueue and
      // here — release the reserved slot and move on (A3).
      if (this._activeJobId === jobId) this._activeJobId = null
      this._drainQueue()
      return
    }

    // Per-job adapter (multi-provider). `this._adapter` stays the project
    // primary; everything in this spawn (binary, argv, model, profile, OTEL,
    // plugins, result parsing, ai_invocations.provider) flows from `adapter`.
    const adapter = this._resolveJobAdapter(jobId)
    // Remember the provider this job actually runs on, for terminal paths that
    // fire without a child 'close' (e.g. _forceFailUnkillableJob) where the
    // per-job override has already been consumed from _jobProviderSelection.
    this._jobResolvedProvider.set(jobId, adapter.id)

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
      } catch {
        /* best-effort — never block a rail spawn on the repair */
      }
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

    // Headless mode: when --yes is in the command, instruct Claude to auto-proceed
    // (stdin is ignored in spawned processes, so no user confirmation is possible)
    if (job.command.includes('--yes')) {
      systemAppend += '\n\nCRITICAL — FULLY AUTONOMOUS MODE (--yes flag):\n' +
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
    // Ultracode (Claude only): skip the slash command entirely and send the
    // pre-prompt + spec text directly as the prompt. The server route guards
    // that ultracode never reaches a non-claude adapter; defensively, a codex
    // adapter still falls through to its skill-translation path below.
    const isUltracode = adapter.id === 'claude' && ULTRACODE_COMMAND_RE.test(commandToRun)
    const railPrompt = isUltracode
      ? this._buildUltracodePrompt(commandToRun)
      : adapter.id === 'codex'
        ? commandToRun.replace(/^\/(specrails|sr):([\w-]+)/, '$$$2')
        : commandToRun
    // Per-job model override (consumed once) takes precedence — used by the
    // ultracode model picker so the user can choose haiku/sonnet/opus per launch.
    const modelOverride = this._jobModelSelection.get(jobId)
    this._jobModelSelection.delete(jobId)
    const railModel = modelOverride
      ? modelOverride
      : adapter.id === 'claude' && this._db
        ? getProjectSettings(this._db).orchestratorModel
        : (this._resolvedModel ?? adapter.defaultModel())
    // Relocate-artifacts: when relocated, claude is spawned from the workspace
    // so add `--add-dir <repoDir>` so its tools can still reach repo files by
    // absolute path. (gemini/codex get env-only tweaks at spawn time below.)
    const railExtraArgs: string[] | undefined =
      execution.relocated && adapter.id === 'claude'
        ? ['--add-dir', execution.repoDir]
        : undefined
    const args = adapter.buildArgs('rail-job', {
      prompt: railPrompt,
      systemPrompt: systemAppend || undefined,
      model: railModel,
      extraArgs: railExtraArgs,
    })

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
    if (adapter.capabilities.profileEnvSupport && this._projectId && this._projectSlug && this._cwd) {
      try {
        const selection = this._jobProfileSelection.get(jobId) // undefined|null|string
        this._jobProfileSelection.delete(jobId)
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
          const resolved = resolveProfile(execution.cwd, selection ?? undefined, adapter.id)
          if (resolved) {
            profileSnapshotPath = snapshotForJob(this._projectSlug, jobId, resolved)
            profileName = resolved.name
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

    // Read pipelineTelemetryEnabled at spawn time (not constructor time) so
    // toggling the setting takes effect on the next job without restarting.
    // OTEL env injection is gated on `adapter.capabilities.nativeOtelEnv`:
    // claude honours OTEL_* env vars natively; codex does not and instead
    // gets signals synthesised by the codex-otel-bridge attached below.
    let spawnEnv: NodeJS.ProcessEnv = process.env
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
        ...process.env,
        ...buildTelemetryEnv(jobId, this._projectId, this._desktopPort, extra, adapter.id),
      }
    }
    // Inject the profile path whenever the adapter honours it (was: claude-
    // only). The codex skill rails read SPECRAILS_PROFILE_PATH the same way.
    if (profileSnapshotPath) {
      spawnEnv = { ...spawnEnv, SPECRAILS_PROFILE_PATH: profileSnapshotPath }
    }

    // ─── Plugin resolution + snapshot ──────────────────────────────────────
    // Active = installed + verify ok; degraded = installed but verify failed
    // or timed out. Degraded does NOT block spawn — rail proceeds, UI gets
    // a `plugin.degraded` event so the user can reinstall.
    //
    // Today PluginManager only supports the `project-json` MCP registration
    // (claude). Codex (`cli-add`) is covered by tasks §14 — until that lands
    // we skip plugin resolution for non-`project-json` adapters so the rail
    // spawns cleanly without errors.
    let pluginActive: Array<{ name: string; version: string }> = []
    let pluginDegraded: Array<{ name: string; reason: string }> = []
    let pluginSnapshotPath: string | null = null
    if (adapter.mcpRegistration === 'project-json' && this._projectId && this._projectSlug && this._cwd) {
      try {
        const { resolvePluginsForSpawn, snapshotPluginsForJob } =
          require('./plugins/rail-integration') as typeof import('./plugins/rail-integration')
        // Relocated ⇒ `.mcp.json`/plugin state live in the workspace (execution.cwd).
        const resolution = await resolvePluginsForSpawn(execution.cwd, this._projectId, jobId)
        pluginActive = resolution.active
        pluginDegraded = resolution.degraded
        if (pluginActive.length > 0 || pluginDegraded.length > 0) {
          pluginSnapshotPath = snapshotPluginsForJob(
            this._projectSlug, jobId, this._projectId, pluginActive, pluginDegraded,
          )
        }
        for (const d of pluginDegraded) {
          this._broadcast({
            type: 'plugin.degraded',
            projectId: this._projectId,
            name: d.name,
            reason: d.reason,
            jobId,
            timestamp: new Date().toISOString(),
          })
        }
      } catch (err) {
        console.warn(`[queue-manager] plugin resolution failed for job ${jobId}: ${(err as Error).message}`)
      }
    }
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
    if (isRailPrDeliveryEnabled()) {
      spawnEnv = { ...spawnEnv, SPECRAILS_GIT_AUTO: 'false' }
    }

    // ─── Interactive ultracode branch ──────────────────────────────────────
    // When the launch requested interactive mode AND the command is ultracode
    // AND the adapter supports persistent stdin (claude), hand off to a resident
    // session instead of the one-shot spawn below. The session keeps the child
    // alive across turns and settles only on finalize/crash. Code-Explorer
    // provenance is intentionally skipped for interactive jobs (v1 — deferred).
    const wantsInteractive = this._jobInteractiveSelection.get(jobId) === true
    this._jobInteractiveSelection.delete(jobId)
    if (wantsInteractive && isUltracode && adapter.capabilities.persistentStdin) {
      const interactiveArgs = adapter.buildArgs('chat-stream', {
        // chat-stream feeds the prompt over stdin per-turn, so the argv `prompt`
        // is unused — pass empty to satisfy the shared SpawnOptions shape.
        prompt: '',
        systemPrompt: systemAppend || undefined,
        model: railModel,
        extraArgs: railExtraArgs,
      })
      this._startInteractiveJob(
        jobId,
        job,
        adapter,
        { binary, args: interactiveArgs, cwd: spawnCwd, env: spawnEnv },
        railPrompt,
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

    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    const child = spawnAiCli(binary, args, {
      env: spawnEnv,
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
    this._resetZombieTimer()
    child.stdout!.on('data', () => { this._resetZombieTimer() })
    child.stderr!.on('data', () => { this._resetZombieTimer() })

    let eventSeq = 0
    let lastResultEvent: Record<string, unknown> | null = null

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

    if (this._db) {
      createJob(this._db, {
        id: jobId,
        command: job.command,
        started_at: job.startedAt!,
        priority: job.priority,
        depends_on_job_id: job.dependsOnJobId,
        pipeline_id: job.pipelineId,
      })
    }

    // ── Batched broadcast for high-frequency messages (log + event) ──────
    // Collects messages and flushes every ~80ms instead of one WS send per line.
    const pendingBroadcast: WsMessage[] = []
    let flushTimer: ReturnType<typeof setTimeout> | null = null
    const FLUSH_INTERVAL_MS = 80

    const batchedBroadcast = (msg: WsMessage): void => {
      pendingBroadcast.push(msg)
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          const batch = pendingBroadcast.splice(0)
          for (const m of batch) this._broadcast(m)
        }, FLUSH_INTERVAL_MS)
      }
    }

    const flushPending = (): void => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      const batch = pendingBroadcast.splice(0)
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

    stdoutReader.on('line', (line) => {
      let parsed: Record<string, unknown> | null = null
      try { parsed = JSON.parse(line) } catch { /* plain text */ }

      // Feed the adapter for the canonical event shape used by
      // finaliseInvocationResult and (optionally) the OTEL bridge. Done
      // alongside the raw event persistence below, NOT in place of it: the
      // raw event log is what feeds the live Job Detail UI and the
      // telemetry export ZIP for non-bridge providers.
      const adapterEv = adapter.parseStreamLine(line)
      if (adapterEv) {
        adapterEvents.push(adapterEv)
        otelBridge?.consumeEvent(adapterEv)
      }

      if (parsed) {
        const eventType = (parsed.type as string) ?? 'unknown'
        if (this._db) {
          appendEvent(this._db, jobId, eventSeq++, {
            event_type: eventType,
            source: 'stdout',
            payload: line,
          })
        }
        batchedBroadcast({
          type: 'event',
          jobId,
          event_type: eventType,
          source: 'stdout',
          payload: line,
          timestamp: new Date().toISOString(),
          seq: eventSeq - 1,
        })
        if (eventType === 'result') {
          lastResultEvent = parsed
        }
        const displayText = extractDisplayText(parsed)
        if (displayText !== null) {
          if (this._db) {
            appendEvent(this._db, jobId, eventSeq++, {
              event_type: 'log',
              source: 'stdout',
              payload: JSON.stringify({ line: displayText }),
            })
          }
          emitLine('stdout', displayText)
        }
      } else {
        if (this._db) {
          appendEvent(this._db, jobId, eventSeq++, {
            event_type: 'log',
            source: 'stdout',
            payload: JSON.stringify({ line }),
          })
        }
        // For adapters whose stream is JSONL (claude, codex), a non-parseable
        // line is unexpected noise. For future plain-text adapters this is
        // their normal output. emitLine surfaces it either way.
        if (adapterEv?.kind === 'text-delta') {
          emitLine('stdout', adapterEv.text)
        } else {
          emitLine('stdout', line)
        }
      }
    })

    stderrReader.on('line', (line) => {
      if (this._db) {
        appendEvent(this._db, jobId, eventSeq++, {
          event_type: 'log',
          source: 'stderr',
          payload: JSON.stringify({ line }),
        })
      }
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
    this._clearZombieTimer()

    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }

    // Reclaim the pre-spawn snapshot unconditionally, BEFORE any early return,
    // so a disposed/unknown job can't leak its entry in _snapshotRefs (the git
    // stash commit it references is dangling and git-GC'd on its own).
    const snapshot = this._snapshotRefs.get(jobId)
    this._snapshotRefs.delete(jobId)
    // Relocate-artifacts: the repo dir this job snapshotted against (= repoDir,
    // never the workspace). Falls back to this._cwd for jobs spawned before this
    // map existed (e.g. restored-from-db) so provenance still targets the repo.
    const jobExecution = this._jobExecution.get(jobId)
    this._jobExecution.delete(jobId)
    // Release the resolved-provider entry on the normal child-exit path (the
    // adapter is threaded into _onJobExit directly, so this is pure cleanup).
    this._jobResolvedProvider.delete(jobId)
    // Reclaim the live-accounting handle unconditionally (shutdown flush no longer
    // needs it once the child has exited).
    this._jobLiveAccounting.delete(jobId)
    const provenanceRepoDir = jobExecution?.repoDir ?? this._cwd

    // Clean up the per-job openspec PATH shim (relocated claude rails only),
    // BEFORE any early return, so a disposed/unknown-job exit can't leak the
    // in-memory map entry or the on-disk chmod-700 dir. Mirrors the interactive
    // settle path (the dominant non-interactive rail path lives here).
    this._cleanupOpenspecShim(jobId)

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
    if (this._disposed) return

    const job = this._jobs.get(jobId)
    if (!job) return

    // LOW-6: this is the LATE close of a job already force-failed by
    // _forceFailUnkillableJob (SIGKILL escalation failed, then the child died on
    // its own). The terminal side-effects (status, onJobFinished, dependents,
    // pipeline, slot release) already ran, so route to a cost-only reconciliation
    // that replaces the no-cost placeholder row(s) IF this close captured real
    // spend — never a duplicate row nor a second onJobFinished.
    if (this._forceFailedRowJobs.has(jobId)) {
      this._reconcileForceFailedJobExit(jobId, code, adapterEvents, adapter, spawnedModel)
      return
    }

    const wasZombie = this._zombieJobs.has(jobId)
    const wasCanceling = this._cancelingJobs.has(jobId)
    this._zombieJobs.delete(jobId)
    this._cancelingJobs.delete(jobId)

    let finalStatus: Job['status']
    if (wasZombie) {
      finalStatus = 'zombie_terminated'
    } else if (wasCanceling) {
      finalStatus = 'canceled'
    } else if (code === 0) {
      finalStatus = 'completed'
    } else {
      finalStatus = 'failed'
    }

    job.status = finalStatus
    job.finishedAt = new Date().toISOString()
    job.exitCode = code

    // Capture result text for output chaining between pipeline steps
    if (lastResultEvent && typeof lastResultEvent.result === 'string') {
      job.resultText = lastResultEvent.result
    }

    // (_activeProcess/_activeJobId already released above, before the early
    // returns, so the slot is freed on every exit path — A3.)

    if (this._db) {
      // Adapter-driven result finalisation handles tokens, cost (or pricing-
      // table estimate for non-native-cost providers), and session_id stamping.
      const { result: normalised, estimated } = finaliseInvocationResult(
        adapter,
        adapterEvents,
        { fallbackModel: spawnedModel },
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
      try {
        finishJob(this._db, jobId, {
          exit_code: code ?? -1,
          status: finalStatus,
          ...tokenData,
        })
      } catch (err) {
        // Defense-in-depth: the DB may have been closed underneath us mid-job.
        // Never let a write throw uncaught inside the child 'close' listener.
        console.error('[queue-manager] finishJob failed (db unavailable?):', err)
      }

      // ai_invocations capture (surface='job'). One row per job exit, or one row
      // per extracted ticket for a multi-ticket batch (MED-7).
      if (this._projectId) {
        try {
          const invStatus: InvocationStatus = finalStatus === 'completed'
            ? 'success'
            : (finalStatus === 'canceled' || finalStatus === 'zombie_terminated')
              ? 'aborted'
              : 'failed'
          const ticketIds = this._extractTicketIds(job.command)
          this._recordJobInvocations({
            jobId,
            provider: adapter.id,
            status: invStatus,
            startedAt: job.startedAt ?? new Date().toISOString(),
            finishedAt: job.finishedAt,
            ticketIds,
            estimated,
            result: normalised,
          })
          this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
        } catch (err) {
          console.error('[queue-manager] recordInvocation failed:', err)
        }
      }

      // Code-Explorer post-exit provenance hook. Diffs the working tree against
      // the pre-spawn snapshot and inserts one row per touched path. Gated by
      // SPECRAILS_CODE_EXPLORER (re-checked at each completion so the flag can
      // be flipped off mid-session without leaving partial writes).
      if (isCodeExplorerEnabled() && provenanceRepoDir && this._projectId) {
        const ref = snapshot?.ref ?? ''
        try {
          const diff = diffAgainstSnapshot(provenanceRepoDir, ref, snapshot?.untracked, snapshot?.headSha)
          const patches = collectDiffPatches(provenanceRepoDir, ref, diff, snapshot?.headSha)
          if (diff.length > 50) {
            console.warn(`[provenance.large_job] job=${jobId} files=${diff.length}`)
          }
          const ticketIds = this._extractTicketIds(job.command)
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

      // Cost comes from the normalised result so providers without a native
      // total_cost_usd field (codex today) still trigger cost alerts based on
      // the pricing-table estimate. When `estimated`, the figure is best-
      // effort — alerts still fire because the user opted into the threshold
      // explicitly and a noisy alert is better than a missed one.
      const jobCost = normalised.total_cost_usd
      const costStr = jobCost != null ? ` | cost: ${estimated ? '~' : ''}$${jobCost.toFixed(4)}` : ''
      emitLine('stdout', `[process exited with code ${code ?? 'unknown'}${costStr}]`)

      // Cost alert: check per-job threshold (app-level, then per-project).
      // These prepared statements touch the DB, which may have been closed
      // mid-job; guard so a throw never escapes the child 'close' listener.
      if (jobCost != null && finalStatus === 'completed') {
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
    }

    // Notify webhook handler (if any) about job completion/failure/cancellation.
    // zombie_terminated is included so a timed-out rail job still releases its
    // tickets (revert/flag) and clears its in-memory railJobs entry instead of
    // wedging the rail card in 'running' until a server restart.
    if (
      this._onJobFinished &&
      (finalStatus === 'completed' || finalStatus === 'failed' || finalStatus === 'canceled' || finalStatus === 'zombie_terminated')
    ) {
      let costUsd: number | undefined
      try {
        costUsd = this._db
          ? (this._db.prepare('SELECT total_cost_usd FROM jobs WHERE id = ?').get(jobId) as { total_cost_usd: number | null } | undefined)?.total_cost_usd ?? undefined
          : undefined
      } catch (err) {
        console.error('[queue-manager] cost read for webhook failed (db unavailable?):', err)
      }
      this._onJobFinished(jobId, finalStatus, costUsd ?? undefined)
    }

    // Handle dependent jobs: skip them if parent did not complete successfully
    if (finalStatus !== 'completed') {
      this._skipDependents(jobId, `Parent job ${jobId} ${finalStatus}`)
    }

    // Check pipeline status
    if (job.pipelineId) {
      this._checkPipelineStatus(job.pipelineId)
    }

    this._broadcastQueueState()
    this._drainQueue()
  }

  private _resetZombieTimer(): void {
    if (this._zombieTimeoutMs <= 0) return
    if (this._inactivityTimer !== null) {
      clearTimeout(this._inactivityTimer)
    }
    const jobId = this._activeJobId
    if (!jobId) return
    this._inactivityTimer = setTimeout(() => {
      this._inactivityTimer = null
      this._onZombieDetected(jobId)
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
    if (job && isRunning) {
      job.status = 'failed'
      job.finishedAt = new Date().toISOString()
      job.exitCode = -1
      if (this._db) {
        try {
          finishJob(this._db, jobId, { exit_code: -1, status: 'failed' })
        } catch {
          /* DB may be closed mid-shutdown — never throw from the kill callback */
        }
      }

      // ai_invocations capture (surface='job', aborted) so the failed rail still
      // shows on Analytics with no token/cost data (none was finalised). LOW-6:
      // the surviving child's `close` may still fire `_onJobExit` later — mark the
      // job so that late close replaces this no-cost placeholder with the real
      // captured cost instead of inserting a SECOND row / re-firing onJobFinished.
      if (this._db && this._projectId) {
        try {
          const ticketIds = this._extractTicketIds(job.command)
          const durationMs = job.startedAt
            ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
            : undefined
          this._recordJobInvocations({
            jobId,
            // Stamp the provider the child ACTUALLY ran on (per-job override
            // already consumed from _jobProviderSelection); _adapter.id is the
            // final fallback for jobs with no resolved-provider entry.
            provider: this._jobResolvedProvider.get(jobId) ?? this._adapter.id,
            status: 'aborted',
            startedAt: job.startedAt ?? new Date().toISOString(),
            finishedAt: job.finishedAt,
            ticketIds,
            estimated: false,
            result: { duration_ms: durationMs },
          })
          this._forceFailedRowJobs.add(jobId)
          this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
        } catch (err) {
          console.error('[queue-manager] recordInvocation (unkillable) failed:', err)
        }
      }
    }

    // Clear ALL per-job maps + the git-stash snapshot + the openspec shim so a
    // surviving child cannot leak memory/disk (mirrors _onJobExit/_failWedgedJob).
    this._snapshotRefs.delete(jobId)
    this._jobExecution.delete(jobId)
    this._jobModelSelection.delete(jobId)
    this._jobProfileSelection.delete(jobId)
    this._jobProviderSelection.delete(jobId)
    this._jobResolvedProvider.delete(jobId)
    this._jobInteractiveSelection.delete(jobId)
    this._jobLiveAccounting.delete(jobId)
    this._cleanupOpenspecShim(jobId)

    this._activeProcess = null
    this._activeJobId = null
    this._cancelingJobs.delete(jobId)
    this._zombieJobs.delete(jobId)

    // Fire the rail/ticket completion callback so status reverts/flags and the
    // budget/webhook/Jira write-back path runs — the whole point of the fix.
    if (isRunning) {
      try {
        this._onJobFinished?.(jobId, 'failed', undefined)
      } catch (err) {
        console.error(`[QueueManager] onJobFinished failed for ${jobId}: ${(err as Error).message}`)
      }
    }

    this._broadcastQueueState()
    this._drainQueue()
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
    this._forceFailedRowJobs.delete(jobId)
    const job = this._jobs.get(jobId)
    // Remove the job now that its terminal handling is fully settled — a further
    // stray close then hits the `if (!job) return` guard in _onJobExit.
    this._jobs.delete(jobId)
    this._jobLiveAccounting.delete(jobId)
    if (!this._db || !this._projectId || !job) return

    try {
      const { result: normalised, estimated } = finaliseInvocationResult(
        adapter,
        adapterEvents,
        { fallbackModel: spawnedModel },
      )
      const hasRealSpend =
        (normalised.total_cost_usd ?? 0) > 0 ||
        (normalised.tokens_in ?? 0) > 0 ||
        (normalised.tokens_out ?? 0) > 0 ||
        (normalised.tokens_cache_read ?? 0) > 0 ||
        (normalised.tokens_cache_create ?? 0) > 0
      if (!hasRealSpend) return // placeholder stands; nothing real to record.

      // Replace the placeholder row(s) with the real captured spend. Delete the
      // plain-jobId row and any per-ticket split rows, then re-record.
      this._db.prepare(
        `DELETE FROM ai_invocations WHERE surface_ref_id = ? OR surface_ref_id LIKE ?`
      ).run(jobId, `${jobId}#t%`)

      const finalStatus: InvocationStatus = code === 0 ? 'success' : 'failed'
      const ticketIds = this._extractTicketIds(job.command)
      this._recordJobInvocations({
        jobId,
        provider: adapter.id,
        status: finalStatus,
        startedAt: job.startedAt ?? new Date().toISOString(),
        finishedAt: job.finishedAt ?? new Date().toISOString(),
        ticketIds,
        estimated,
        result: normalised,
      })
      // Reflect the real cost on the jobs row too (it was stamped failed w/o cost).
      try {
        finishJob(this._db, jobId, {
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
      } catch (err) {
        console.error('[queue-manager] force-fail reconcile finishJob failed:', err)
      }
      this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
    } catch (err) {
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

  private _persistJob(job: Job): void {
    if (!this._db) return
    // For queued jobs, we use the DB to store queue position and priority for startup restore.
    // We only upsert queue_position + priority + dependency fields — the rest is handled by createJob/finishJob.
    // Since this method is called for all status transitions, we use a flexible upsert
    // that only touches queue_position, priority, and dependency fields (for queued jobs) — other fields are
    // managed by the existing createJob/finishJob API.
    try {
      this._db.prepare(
        `UPDATE jobs SET queue_position = ?, priority = ?, depends_on_job_id = ?, pipeline_id = ? WHERE id = ?`
      ).run(job.queuePosition ?? null, job.priority, job.dependsOnJobId ?? null, job.pipelineId ?? null, job.id)
    } catch {
      // Job may not exist in DB yet
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

    try {
      // Backfill an aborted ai_invocations row for every job orphaned 'running'
      // by an UNGRACEFUL crash (no shutdown() flush ran). Each row carries
      // whatever spend the jobs row accumulated — interactive per-turn writes
      // hold real cost; a non-interactive rail whose finishJob never ran holds
      // NULL — so the run still counts toward totalRuns/failureRate and an
      // interactive session's cost is not lost from Analytics
      // (COST-ACCOUNTING-AUDIT CRIT-3 / HIGH-1, crash path). Runs BEFORE the
      // status flip so we can read the pre-fail token/cost columns.
      if (this._projectId) {
        try {
          const orphans = this._db.prepare(
            `SELECT id, command, started_at, model, tokens_in, tokens_out, tokens_cache_read,
                    tokens_cache_create, total_cost_usd, total_cost_usd_estimated, num_turns,
                    duration_ms, duration_api_ms, session_id
             FROM jobs WHERE status = 'running'`
          ).all() as Array<{
            id: string; command: string; started_at: string | null; model: string | null
            tokens_in: number | null; tokens_out: number | null; tokens_cache_read: number | null
            tokens_cache_create: number | null; total_cost_usd: number | null
            total_cost_usd_estimated: number | null; num_turns: number | null
            duration_ms: number | null; duration_api_ms: number | null; session_id: string | null
          }>
          const finishedAt = new Date().toISOString()
          for (const o of orphans) {
            this._recordJobInvocations({
              jobId: o.id,
              provider: this._adapter.id,
              status: 'aborted',
              startedAt: o.started_at ?? finishedAt,
              finishedAt,
              ticketIds: extractTicketIdsFromCommand(o.command),
              estimated: !!o.total_cost_usd_estimated,
              result: {
                tokens_in: o.tokens_in ?? undefined,
                tokens_out: o.tokens_out ?? undefined,
                tokens_cache_read: o.tokens_cache_read ?? undefined,
                tokens_cache_create: o.tokens_cache_create ?? undefined,
                total_cost_usd: o.total_cost_usd ?? undefined,
                num_turns: o.num_turns ?? undefined,
                model: o.model ?? undefined,
                session_id: o.session_id ?? undefined,
                duration_ms: o.duration_ms ?? undefined,
                duration_api_ms: o.duration_api_ms ?? undefined,
              },
            })
          }
          if (orphans.length > 0) {
            this._broadcast({ type: 'spending.invalidated', projectId: this._projectId })
          }
        } catch (err) {
          console.error('[queue-manager] restore backfill failed:', err)
        }
      }

      // Fail any jobs that were running when the server last shut down
      this._db.prepare(
        `UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE status = 'running'`
      ).run()

      // Restore queued jobs in order (priority DESC then queue_position ASC)
      const rows = this._db.prepare(
        `SELECT id, command, queue_position, priority, depends_on_job_id, pipeline_id FROM jobs WHERE status = 'queued' ORDER BY queue_position ASC`
      ).all() as Array<{ id: string; command: string; queue_position: number | null; priority: string | null; depends_on_job_id: string | null; pipeline_id: string | null }>

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
        }
        this._jobs.set(row.id, job)
        this._queue.push(row.id)
      }

      // Re-sort queue by priority (higher first), preserving FIFO within same level
      this._queue.sort((a, b) => {
        const jobA = this._jobs.get(a)!
        const jobB = this._jobs.get(b)!
        return PRIORITY_WEIGHT[jobB.priority] - PRIORITY_WEIGHT[jobA.priority]
      })
      this._recomputePositions()

      // Restore pause state
      const pauseRow = this._db.prepare(
        `SELECT value FROM queue_state WHERE key = 'paused'`
      ).get() as { value: string } | undefined

      this._paused = pauseRow?.value === 'true'
    } catch {
      // DB may not have queue_state table yet — ignore
    }

    // Kick off any restored queued jobs that are ready to run
    this._drainQueue()
  }

  private _isDependencyMet(job: Job): boolean {
    if (!job.dependsOnJobId) return true

    const parent = this._jobs.get(job.dependsOnJobId)
    if (parent) return parent.status === 'completed'

    if (this._db) {
      const row = this._db.prepare('SELECT status FROM jobs WHERE id = ?').get(job.dependsOnJobId) as { status: string } | undefined
      if (row) return row.status === 'completed'
    }

    return true
  }

  private _skipDependents(parentJobId: string, reason: string): void {
    const toSkip: string[] = []

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

      if (this._db) {
        // Ensure the job row exists before updating (queued jobs may not have been persisted via createJob yet)
        const exists = this._db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(id)
        if (!exists) {
          this._db.prepare(
            `INSERT INTO jobs (id, command, started_at, status, skip_reason, finished_at, depends_on_job_id, pipeline_id) VALUES (?, ?, ?, 'skipped', ?, ?, ?, ?)`
          ).run(id, job.command, job.finishedAt, reason, job.finishedAt, job.dependsOnJobId, job.pipelineId)
        } else {
          skipJob(this._db, id, reason)
        }
      }

      this._skipDependents(id, `Parent job ${id} was skipped`)
    }
  }

  private _checkPipelineStatus(pipelineId: string): void {
    const pipelineJobs = Array.from(this._jobs.values()).filter(j => j.pipelineId === pipelineId)
    if (pipelineJobs.length === 0) return

    const allDone = pipelineJobs.every(j => j.status === 'completed')
    const anyFailed = pipelineJobs.some(j =>
      j.status === 'failed' || j.status === 'skipped' || j.status === 'canceled' || j.status === 'zombie_terminated'
    )
    const anyPending = pipelineJobs.some(j => j.status === 'queued' || j.status === 'running')

    if (allDone) {
      this._broadcast({ type: 'pipeline_status', pipelineId, status: 'completed' })
    } else if (anyFailed && !anyPending) {
      this._broadcast({ type: 'pipeline_status', pipelineId, status: 'failed' })
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
