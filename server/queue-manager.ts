import { ChildProcess } from 'child_process'
import fsNode from 'fs'
import pathNode from 'path'
import { createInterface } from 'readline'
import { newId as uuidv4 } from './ids'
import treeKill from 'tree-kill'
import type { WsMessage, LogMessage, Job, PhaseDefinition, JobPriority } from './types'
import { PRIORITY_WEIGHT, VALID_PRIORITIES } from './types'
import { resolveCommand } from './command-resolver'
import { spawnAiCli } from './util/cli-prompt'
import { extractDisplayText } from './util/stream-display'
import { resetPhases, setActivePhases } from './hooks'
import { recordInvocation } from './ai-invocations'
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

// ─── Telemetry env helpers ────────────────────────────────────────────────────

/** Build the OTEL environment variable block for a spawned claude process.
 * Extracted as a pure function so it is unit-testable without a full spawn. */
export function buildTelemetryEnv(
  jobId: string,
  projectId: string,
  desktopPort: number,
  extraResourceAttributes: Record<string, string | number> = {},
): Record<string, string> {
  const baseAttrs: Array<[string, string]> = [
    ['specrails.job_id', jobId],
    ['specrails.project_id', projectId],
  ]
  for (const [k, v] of Object.entries(extraResourceAttributes)) {
    baseAttrs.push([k, String(v)])
  }
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${desktopPort}/otlp`,
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_METRICS_EXPORTER: 'otlp',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_TRACES_EXPORTER: 'otlp',
    OTEL_RESOURCE_ATTRIBUTES: baseAttrs.map(([k, v]) => `${k}=${v}`).join(','),
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
  /** Pending per-job model override keyed by jobId — read at spawn time.
   *  In-memory only (mirrors _jobProviderSelection). */
  private _jobModelSelection: Map<string, string>
  /** Pre-spawn working-tree snapshot refs keyed by jobId — read at exit time
   *  by the Code-Explorer provenance hook. Cleared on job exit. */
  private _snapshotRefs: Map<string, WorkingTreeSnapshot>
  /** Pending per-job interactive flag keyed by jobId — read at spawn time.
   *  In-memory only (mirrors _jobModelSelection). */
  private _jobInteractiveSelection: Map<string, boolean>
  /** Live interactive job sessions keyed by jobId (the resident persistent-stdin
   *  child + per-turn accounting). Present only while an interactive job runs. */
  private _interactiveSessions: Map<string, InteractiveJobSession>

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
    this._projectId = options?.projectId ?? null
    this._desktopPort = options?.desktopPort ?? 4200
    this._projectSlug = options?.projectSlug ?? null
    this._jobProfileSelection = new Map()
    this._jobProviderSelection = new Map()
    this._jobModelSelection = new Map()
    this._snapshotRefs = new Map()
    this._jobInteractiveSelection = new Map()
    this._interactiveSessions = new Map()

    const envTimeout = process.env.WM_ZOMBIE_TIMEOUT_MS !== undefined
      ? parseInt(process.env.WM_ZOMBIE_TIMEOUT_MS, 10)
      : null
    this._zombieTimeoutMs = options?.zombieTimeoutMs
      ?? (envTimeout !== null && !isNaN(envTimeout) ? envTimeout : DEFAULT_ZOMBIE_TIMEOUT_MS)

    if (this._db) {
      this._restoreFromDb()
    }
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
        treeKill(pid, 'SIGTERM')
      } catch { /* best-effort */ }
      const grace = setTimeout(() => {
        try {
          treeKill(pid, 'SIGKILL', () => { /* ignore */ })
        } catch { /* best-effort */ }
      }, 5000)
      // Do not let the grace timer keep the process alive on real shutdown.
      if (typeof grace.unref === 'function') grace.unref()
    }

    this._activeProcess = null
    this._activeJobId = null
    // Tear down any resident interactive sessions (SIGTERM their children) so
    // teardown orphans no persistent claude process. dispose() does not settle.
    for (const session of this._interactiveSessions.values()) {
      try { session.dispose() } catch { /* best-effort */ }
    }
    this._interactiveSessions.clear()
    // Release any per-job provenance snapshots so teardown leaves no map entries.
    this._snapshotRefs.clear()
    // Drop the DB reference last so any in-flight 'close' callback sees null
    // and skips all DB work via the existing `if (this._db)` guards.
    this._db = null
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

  private _buildImplementAttachmentContext(command: string): string {
    if (!this._cwd || !this._projectSlug) return ''

    const ticketIds = this._extractTicketIds(command)
    if (ticketIds.length === 0) return ''

    try {
      const store = readStore(resolveTicketStoragePath(this._cwd))
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
        const store = readStore(resolveTicketStoragePath(this._cwd))
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
        this._activeJobId = null
        this._drainQueue()
      }
    })
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
          const invStatus = finalStatus === 'completed'
            ? 'success'
            : finalStatus === 'canceled'
              ? 'aborted'
              : 'failed'
          const ticketIds = this._extractTicketIds(job.command)
          const durationMs = job.startedAt
            ? new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime()
            : undefined
          recordInvocation(this._db, {
            id: randomUUID(),
            project_id: this._projectId,
            provider: 'claude',
            surface: 'job',
            surface_ref_id: jobId,
            ticket_id: ticketIds[0] ?? null,
            status: invStatus,
            started_at: job.startedAt ?? new Date().toISOString(),
            finished_at: job.finishedAt,
            total_cost_usd_estimated: false,
            tokens_in: totals.tokens_in,
            tokens_out: totals.tokens_out,
            tokens_cache_read: totals.tokens_cache_read,
            tokens_cache_create: totals.tokens_cache_create,
            total_cost_usd: totals.total_cost_usd,
            num_turns: totals.num_turns,
            model: info.model ?? undefined,
            session_id: info.sessionId ?? undefined,
            duration_ms: durationMs,
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

    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.queuePosition = null

    this._recomputePositions()
    this._persistJob(job)

    const commandPhases = this._phasesForCommand(job.command)
    if (commandPhases.length > 0) {
      setActivePhases(commandPhases, this._broadcast)
    } else {
      resetPhases(this._broadcast)
    }

    const commandToRun = job.command.trim()

    // Build supplementary context (output chaining + headless mode) that goes
    // into --append-system-prompt, keeping the user prompt clean.
    let systemAppend = ''

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
    const args = adapter.buildArgs('rail-job', {
      prompt: railPrompt,
      systemPrompt: systemAppend || undefined,
      model: railModel,
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
        const coreSupports = projectSupportsProfiles(this._cwd)
        if (selection !== null && coreSupports) {
          // selection is string (explicit) or undefined (default resolution)
          const {
            resolveProfile,
            snapshotForJob,
            persistJobProfile,
          } = require('./profile-manager') as typeof import('./profile-manager')
          const resolved = resolveProfile(this._cwd, selection ?? undefined, adapter.id)
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
    if (telemetryEnabled && adapter.capabilities.nativeOtelEnv && this._projectId) {
      const extra: Record<string, string> = {}
      if (profileName) extra['specrails.profile_name'] = profileName
      if (profileName) extra['specrails.profile_schema_version'] = '1'
      spawnEnv = {
        ...process.env,
        ...buildTelemetryEnv(jobId, this._projectId, this._desktopPort, extra),
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
        const resolution = await resolvePluginsForSpawn(this._cwd, this._projectId, jobId)
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
    if (this._cwd) {
      try {
        adapter.prepareHeadlessSpawn?.(this._cwd)
      } catch (err) {
        /* c8 ignore next -- best-effort prep; a failure is non-fatal */
        console.warn(`[queue-manager] headless-spawn prep failed: ${(err as Error).message}`)
      }
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
      })
      this._startInteractiveJob(
        jobId,
        job,
        adapter,
        { binary, args: interactiveArgs, cwd: this._cwd, env: spawnEnv },
        railPrompt,
      )
      return
    }

    // Code-Explorer pre-spawn snapshot. Captures the working-tree state via
    // `git stash create --include-untracked` so the post-exit hook can diff
    // against it. Gated by SPECRAILS_CODE_EXPLORER — when off, no-op.
    if (isCodeExplorerEnabled() && this._cwd) {
      try {
        const snap = snapshotWorkingTree(this._cwd)
        this._snapshotRefs.set(jobId, snap)
      } catch (err) {
        console.warn(`[queue-manager] provenance snapshot failed: ${(err as Error).message}`)
      }
    }

    // spawnAiCli reroutes multi-line argv values through stdin on Windows.
    const child = spawnAiCli(binary, args, {
      env: spawnEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: this._cwd,
    })

    this._activeProcess = child
    this._activeJobId = jobId

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

      // ai_invocations capture (surface='job'). One row per job exit.
      if (this._projectId) {
        try {
          const invStatus = finalStatus === 'completed'
            ? 'success'
            : (finalStatus === 'canceled' || finalStatus === 'zombie_terminated')
              ? 'aborted'
              : 'failed'
          const ticketIds = this._extractTicketIds(job.command)
          recordInvocation(this._db, {
            id: randomUUID(),
            project_id: this._projectId,
            provider: adapter.id,
            surface: 'job',
            surface_ref_id: jobId,
            ticket_id: ticketIds[0] ?? null,
            status: invStatus,
            started_at: job.startedAt ?? new Date().toISOString(),
            finished_at: job.finishedAt,
            total_cost_usd_estimated: estimated,
            ...normalised,
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
      if (isCodeExplorerEnabled() && this._cwd && this._projectId) {
        const ref = snapshot?.ref ?? ''
        try {
          const diff = diffAgainstSnapshot(this._cwd, ref, snapshot?.untracked, snapshot?.headSha)
          const patches = collectDiffPatches(this._cwd, ref, diff, snapshot?.headSha)
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

          // Per-project daily budget: check total spend for today
          const dailyBudgetRow = this._db.prepare(
            `SELECT value FROM queue_state WHERE key = 'config.daily_budget_usd'`
          ).get() as { value: string } | undefined
          if (dailyBudgetRow) {
            const dailyBudget = parseFloat(dailyBudgetRow.value)
            if (dailyBudget > 0) {
              const spendRow = this._db.prepare(
                `SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM jobs WHERE status = 'completed' AND total_cost_usd IS NOT NULL AND started_at >= date('now')`
              ).get() as { total: number }
              const dailySpend = spendRow.total
              if (dailySpend >= dailyBudget) {
                const wasPaused = this._paused
                this._paused = true
                if (!wasPaused) {
                  this._db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
                }
                this._broadcast({ type: 'daily_budget_exceeded', projectId: '', dailySpend, budget: dailyBudget, queuePaused: true })
              }
            }
          }

          // App-level daily budget enforcement
          if (this._getDesktopDailyBudget) {
            const { budget: desktopBudget, totalSpend: desktopTotalSpend } = this._getDesktopDailyBudget()
            if (desktopBudget != null && desktopBudget > 0 && desktopTotalSpend >= desktopBudget) {
              const wasPaused = this._paused
              this._paused = true
              if (!wasPaused) {
                this._db.prepare(`INSERT OR REPLACE INTO queue_state (key, value) VALUES ('paused', 'true')`).run()
              }
              this._broadcast({ type: 'desktop_daily_budget_exceeded', projectId: '', desktopDailySpend: desktopTotalSpend, desktopBudget, queuePaused: true })
            }
          }
        } catch (err) {
          console.error('[queue-manager] cost-alert bookkeeping failed (db unavailable?):', err)
        }
      }
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
    if (!this._activeProcess || !this._activeProcess.pid) return

    this._clearZombieTimer()
    // A second cancel()/zombie-kill of the same still-running job would
    // otherwise overwrite (and leak) the in-flight SIGKILL timer, which could
    // later fire treeKill(SIGKILL) against a recycled PID. Clear it first.
    if (this._killTimer !== null) {
      clearTimeout(this._killTimer)
      this._killTimer = null
    }
    this._cancelingJobs.add(jobId)
    treeKill(this._activeProcess.pid, 'SIGTERM')

    const pid = this._activeProcess.pid
    this._killTimer = setTimeout(() => {
      treeKill(pid, 'SIGKILL', (err) => {
        if (err) {
          // SIGKILL failed — force cleanup so queue is not permanently blocked
          console.error(`[kill] SIGKILL failed for pid ${pid}: ${err.message}`)
          if (this._activeJobId === jobId) {
            const job = this._jobs.get(jobId)
            if (job && job.status === 'running') {
              job.status = 'failed'
              job.finishedAt = new Date().toISOString()
              if (this._db) {
                try {
                  this._db.prepare(
                    `UPDATE jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP WHERE id = ?`
                  ).run(jobId)
                } catch { /* ignore */ }
              }
            }
            this._activeProcess = null
            this._activeJobId = null
            this._cancelingJobs.delete(jobId)
            this._zombieJobs.delete(jobId)
            this._broadcastQueueState()
            this._drainQueue()
          }
        }
      })
      this._killTimer = null
    }, 5000)
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
