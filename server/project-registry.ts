import { runtimeRunSummary, shutdownAgentRuntimeControls } from './modules/agent-runtime/runtime/agent-runtime-controls-router'
import path from 'path'
import fs from 'fs'
import { AsyncLocalStorage } from 'async_hooks'
import type { DbInstance } from './db'
import { getProjectSettings, initDb } from './db'
import { resolveProjectRepository, resolveRepositoryProject, RepositoryValidationError, type ProjectRepositoryInput, type ProjectRepository, getProjectRepositories, canonicalRepositoryPath, repositoryPathKey } from './project-repositories'
import { getRepositoryExecutionReferences } from './modules/delivery/runtime/multi-repo-execution-store'
import type { QueueManager } from './modules/execution/runtime/queue-manager'
import { readCapStatuses, type DailyBudgetHeadroom } from './modules/execution/runtime/daily-budget-gate'
import { appWideSpendSince, readDesktopCaps, type CapConfig } from './modules/execution/adapters/budget-storage'
import { dailyBudgetResetsAt, isCapExceeded, localDayStartIso, periodResetsAtIso, periodStartIso, type CapPeriod, type CapStatus } from './modules/execution'
import type { ReviewWipGate } from './modules/delivery/runtime/review-wip-gate'
import type { DailyBudgetRejection } from './modules/execution'
import type { ChatManager } from './modules/conversations/runtime/chat-manager'
import type { SetupManager } from './setup-manager'
import type { ProposalManager } from './modules/specs/runtime/proposal-manager'
import type { AgentRefineManager } from './modules/agents/runtime/agent-refine-manager'
import type { FileSummaryManager } from './modules/code/runtime/file-summary-manager'
import type { SpecLauncherManager } from './modules/specs/runtime/spec-launcher-manager'
import { WebhookManager } from './webhook-manager'
import type { TicketWatcher } from './modules/specs/runtime/ticket-watcher'
import { getTerminalManager } from './modules/terminals/runtime/terminal-manager'
import type { BrowserCaptureManager } from './modules/browser/runtime/browser-capture-manager'
import { SharedBrowserContextPool } from './modules/browser/runtime/browser-context-pool'
import { removeExploreCwd } from './modules/conversations/runtime/explore-cwd-manager'
import { dropPhaseScope } from './hooks'
import { killTransientChildren, purgeBackgroundProcessHistory } from './transient-children'
import { dropBlobStatesForProject } from './modules/accounting/runtime/telemetry-receiver'
import {
  mirrorProjectEntryWithPrevious,
  removeRegistryEntry,
  reconcileFromProjects,
  resolveArtifacts,
  resolveHome,
  restoreRegistryEntry,
  type ProjectEntry,
} from './artifact-registry'
import { resolveProjectTicketsPath } from './workspace-resolution'
import { startProjectEnvWarmup, stopProjectEnvWarmup } from './project-env'
import { removeWorkspace } from './workspace-manager'
import { readStore } from './modules/specs/runtime/ticket-store'
import { JiraSyncManager } from './jira/jira-sync-manager'
import { StuckRunDetector } from './modules/execution/runtime/stuck-run-detector'
import type { MilestoneProgressBroadcaster } from './modules/builder/runtime/milestone-progress'
import type { MilestoneChainManager } from './modules/builder/runtime/milestone-chain'
import { createInternalApi } from './internal-api'
import { createProjectAgentAudit, type ProjectAgentAudit } from './modules/audit/adapters/runtime'
import type { LoopRunManager } from './modules/loops/runtime/loop-run-manager'
import { listActiveLoopRuns, type LoopRunRow, type DefinitionCheckpoint } from './modules/loops/runtime/loop-runs-store'
import type { LoopSpec } from './modules/loops/runtime/loop-graph'
import { runHoldSources } from './modules/loops/runtime/loop-run-hold'
import type { WsMessage } from './types'
import {
  initDesktopDb,
  getDesktopDbPath,
  listProjects,
  addProject as addProjectToDesktopDb,
  removeProject as removeProjectFromDesktopDb,
  getProject,
  addProjectRepository as addRepositoryToDesktopDb,
  updateProjectRepository as updateRepositoryInDesktopDb,
  removeProjectRepository as removeRepositoryFromDesktopDb,
  touchProject,
  getDesktopSetting,
  type ProjectRow,
  type CliProvider,
} from './desktop-db'
import type { IntentService } from './modules/intent'
import type { SpecTriageService } from './modules/specs/runtime/triage'
import { rulesInventoryRuns } from './modules/project-rules/runtime/rules-inventory-runs'
import type { IntentHandOffAuthority } from './modules/delivery/runtime/flow-worktree-handoff'
import { beginProjectProcessQuiescence } from './process-admission'
import { resolveSpecrailsHome } from './util/specrails-home'
// Per-capability wiring for _loadProjectContext (each file owns one concern).
import { createProjectBroadcast, createProjectBroadcastTaps } from './project-context-broadcast'
import { createAutoContinuation } from './project-context-auto-continue'
import { continueDefinitionRun } from './project-router-loop-runs'
import { createProjectBudgetGates } from './project-context-budget'
import { createProjectIntent } from './project-context-intent'
import { createLoopRunFinishedHandler, recoverOrphanLoopRuns } from './project-context-loop-outcome'
import { createProjectLoopRuntime, createRunClarificationsPublisher } from './project-context-loops'
import { createProjectAuthoringManagers, createProjectBrowserCapture, createProjectFileSummaryManager, startProjectTicketWatcher } from './project-context-managers'
import { createBlueprintWorkspaceResolver, createProjectMilestoneChains, createProjectMilestoneProgress } from './project-context-milestones'
import { createProjectQueue, loadProjectCommands, readProjectZombieTimeout } from './project-context-queue'
import { startProjectRecovery } from './project-context-recovery'
import { attachProjectServices } from './project-context-services'
import { createProjectTicketAccess } from './project-context-tickets'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ProjectContext {
  project: ProjectRow
  db: DbInstance
  queueManager: QueueManager
  chatManager: ChatManager
  setupManager: SetupManager
  proposalManager: ProposalManager
  agentRefineManager: AgentRefineManager
  fileSummaryManager: FileSummaryManager
  specLauncherManager: SpecLauncherManager
  ticketWatcher: TicketWatcher
  browserCaptureManager: BrowserCaptureManager
  jiraSyncManager: JiraSyncManager
  /** Emits `job.stuck` when a running loop step stops producing activity. */
  stuckRunDetector: StuckRunDetector
  broadcast: (msg: WsMessage) => void
  /** Maps jobId → rail metadata for active rail-launched jobs */
  railJobs: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>
  // ── Loops (the Loops feature) ──────────────────────────────────────────────
  /** App-driven loop engine for this project (Loops mode rails). */
  loopRunManager: LoopRunManager
  /** Loop runs that were active when this context loaded and that startup recovery has not
   *  reconciled yet: no process here drives them, so they show as paused by the restart. */
  restartPendingRunIds?: Set<string>
  /** Maps loopRunId → rail metadata for active rail-launched loop runs. */
  railLoopRuns: Map<string, {
    railIndex: number
    ticketIds: number[]
    /** Current launchers settle through a durable loop_terminal_recovery row.
     * Absence means admission failed; never reinterpret it as a legacy exit. */
    requiresTerminalIntent?: boolean
    /** mission-rail-cards: the agent-chat conversation that launched a SHARED-CWD
     *  run (isolated runs keep it on the delivery row). */
    originConversationId?: string
  }>
  /** Completion handler for a loop run: releases its tickets + rail slots,
   *  mapping the loop outcome to a ticket outcome. The engine already emits the
   *  loop.run_completed event. `opts.ticketCompletionStatus` overrides where a
   *  COMPLETED run's tickets land (the isolated-rail launch passes its
   *  launch-captured prMode). When ABSENT the default derives from the
   *  PR-delivery flag: on ⇒ on_review (the universal ask-first methodology —
   *  the human decides done vs discard), off ⇒ legacy done. Failure/cancel
   *  outcomes ignore it (byte-identical). */
  onLoopRunFinished: (
    runId: string,
    outcome: string,
    opts?: { ticketCompletionStatus?: 'done' | 'on_review'; stallReason?: string },
  ) => void
  /** Read a spec's fields for {{spec.*}} interpolation at launch. */
  getTicketSpec: (ticketId: number) => LoopSpec | undefined
  /** Daily budget admission gate for cost-incurring launches outside the
   *  queue (rail launches, loop resumes): the 409 body while the project or
   *  app-wide daily budget is exhausted, else null. Absent in bare test contexts. */
  dailyBudgetRejection?: () => DailyBudgetRejection | null
  /** Read-only headroom of the tightest daily budget, for warnings before a
   *  launch (launch forecast). Absent in bare test contexts. */
  dailyBudgetHeadroom?: () => DailyBudgetHeadroom | null
  /** Every configured cap (day/week/month × project/app-wide) with its spend. */
  budgetCaps?: (at?: Date) => CapStatus[]
  /** The per-run soft cap a new run starts with (tighter of project and app default), or null. */
  runCapDefault?: () => number | null
  /** Review WIP limit admission for rail launches (review-wip-limit): bound
   *  to this project's connection and `reviewWipLimit` setting. Absent in
   *  bare test contexts. */
  reviewWipGate?: ReviewWipGate
  /** App-level DB (project registry + the global `loops` table). */
  desktopDb: DbInstance
  /** Debounced `blueprint.milestone_progress` broadcaster (premium-milestone-
   *  progress); tapped from the bound broadcast. Absent in bare test contexts. */
  milestoneProgress?: MilestoneProgressBroadcaster
  /** Server-durable milestone launch chains (sequential Launch Milestone). */
  milestoneChains?: MilestoneChainManager
  /** Agent actions audit (batched writer, exports, retention). Absent in bare test contexts. */
  agentAudit?: ProjectAgentAudit
  /** Intent mode: this project's Intent use cases (absent in bare test contexts). */
  flow?: IntentService
  /** Intent -> rail hand-off authority the rails launch route consults for `flowId`. */
  flowHandOff?: IntentHandOffAuthority
  /** Periodic retry of due Intent settlement effects (stopped on teardown). */
  flowSettlement?: { stop(): void }
  /** Samples working missions' resources into the project DB (see project-router-mission-resources). */
  missionResourceRecorder?: { stop(): void }
  /** Spec triage (launch-triage): tapped from the bound broadcast; absent in bare test contexts. */
  specTriage?: SpecTriageService
  /** Recently-deleted specs: purges entries older than 30 days (stopped on teardown). */
  trashPurge?: { stop(): void }
  /** Background merge watch: settles PRs merged or closed on GitHub (delivery). */
  prMergeWatch?: { stop(): void }
}

// PR-decision rehydration lives with startup recovery; re-exported for existing consumers.
export { emitRecoveredPrDelivery, reprojectActivePrDeliveries } from './project-context-recovery'

// ─── ProjectRegistry ──────────────────────────────────────────────────────────

class ProjectDatabaseBusyError extends Error {}
const PROJECT_LOAD_RETRY_DELAYS_MS = [1000, 2000, 5000, 30000]
/** Background warm-up loads contexts for at most this long per event-loop turn. */
const WARMUP_SLICE_MS = 8
/** Startup recoveries of background-loaded projects that run at the same time. */
const WARMUP_RECOVERY_CONCURRENCY = 4
/** A project route touches `last_seen_at` at most this often (it orders the warm-up). */
const TOUCH_INTERVAL_MS = 30_000

/**
 * Runs queued startup recoveries with bounded concurrency. A recovery is
 * promoted (started at once) when its project is used before its turn.
 */
class RecoveryGate {
  private readonly _queue = new Map<string, () => Promise<void>>()
  private _running = 0
  constructor(private readonly _limit: number) {}

  enqueue(id: string, start: () => Promise<void>): void {
    this._queue.set(id, start)
    this._drain()
  }

  isQueued(id: string): boolean {
    return this._queue.has(id)
  }

  promote(id: string): void {
    const start = this._queue.get(id)
    if (!start) return
    this._queue.delete(id)
    this._run(start, false)
  }

  cancel(id: string): void {
    this._queue.delete(id)
  }

  clear(): void {
    this._queue.clear()
  }

  private _drain(): void {
    while (this._running < this._limit && this._queue.size > 0) {
      const [id, start] = this._queue.entries().next().value as [string, () => Promise<void>]
      this._queue.delete(id)
      this._run(start, true)
    }
  }

  private _run(start: () => Promise<void>, counted: boolean): void {
    if (counted) this._running++
    let done: Promise<void>
    try { done = Promise.resolve(start()) } catch { done = Promise.resolve() }
    void done.catch(() => { /* each recovery logs its own failure */ }).finally(() => {
      if (counted) this._running--
      this._drain()
    })
  }
}

export class ProjectRegistry {
  private _desktopDb: DbInstance
  private _contexts: Map<string, ProjectContext>
  /** Machine-scope: how a provider's turns are paid (subscription plan vs API),
   * late-bound from the usage service (created after the registry). */
  private _providerBilling: ((provider: string) => Promise<{ billing: 'plan' | 'api' | 'unknown'; plan: string | null }>) | null = null
  private _broadcast: (msg: WsMessage) => void
  private _webhookManager: WebhookManager
  private _desktopPort: number
  // M9: projects whose per-project DB failed to load at startup (corrupt, locked,
  // or migration-stuck). They stay registered but have no live context.
  private _failedProjects: Map<string, { project: ProjectRow; error: string }>
  /** Settings that running agent sessions depend on changed (`projectId: null` = app-global). */
  private readonly _settingsListeners = new Set<(scope: { projectId: string | null }) => void>()
  private readonly _removalListeners = new Set<(project: { id: string; slug: string }) => void>()
  private _loadRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private _shuttingDown = false
  /** Registered projects the background warm-up has not loaded yet (load order). */
  private readonly _pending = new Set<string>()
  private _warmup: Promise<void> | null = null
  private readonly _recoveryGate = new RecoveryGate(WARMUP_RECOVERY_CONCURRENCY)
  private readonly _lastTouched = new Map<string, number>()
  /** Request-scoped memo of the app-wide spend (see withSpendSnapshot). */
  private readonly _spendScope = new AsyncLocalStorage<Map<string, number>>()
  // App-wide shared browser context for "Add Spec from a website": ONE persistent
  // Chromium profile under ~/.specrails/browser-profile, so cookies/logins are
  // shared across every project. Launched lazily, disposed once at shutdown().
  private _browserContextPool: SharedBrowserContextPool

  constructor(broadcast: (msg: WsMessage) => void, desktopDbPath?: string, desktopPort?: number) {
    this._broadcast = broadcast
    this._desktopDb = initDesktopDb(desktopDbPath ?? getDesktopDbPath())
    this._contexts = new Map()
    this._webhookManager = new WebhookManager(this._desktopDb)
    this._desktopPort = desktopPort ?? 4200
    this._failedProjects = new Map()
    this._browserContextPool = new SharedBrowserContextPool()
  }

  /** Bind the machine's billing lookup (subscription vs API) for Intent cost. */
  setProviderBilling(lookup: (provider: string) => Promise<{ billing: 'plan' | 'api' | 'unknown'; plan: string | null }>): void {
    this._providerBilling = lookup
  }

  /** The port this server instance listens on (may differ from the persisted `port` setting). */
  get desktopPort(): number {
    return this._desktopPort
  }

  get desktopDb(): DbInstance {
    return this._desktopDb
  }

  loadAll(): void {
    const projects = this._reconcileCatalog()
    for (const project of projects) {
      this._pending.delete(project.id)
      this._tryLoadProject(project)
    }
  }

  /**
   * Load every registered project in the background, most recently used first,
   * a few milliseconds per event-loop turn so the server answers while it warms
   * up. A project that is asked for before its turn (`getContext`) loads at
   * once. Startup recovery of background-loaded projects runs with bounded
   * concurrency; a project that is used is recovered first. Resolves when every
   * project has been loaded (or has failed to load).
   */
  startWarmup(): Promise<void> {
    if (this._warmup) return this._warmup
    const projects = this._reconcileCatalog()
    const order = [...projects].sort((a, b) => (b.last_seen_at ?? '').localeCompare(a.last_seen_at ?? ''))
    for (const project of order) if (!this._contexts.has(project.id)) this._pending.add(project.id)
    this._warmup = (async () => {
      while (this._pending.size > 0 && !this._shuttingDown) {
        await new Promise<void>((resolve) => setImmediate(resolve))
        const sliceStart = Date.now()
        do {
          const id = this._pending.values().next().value as string | undefined
          if (id === undefined) break
          this._loadPending(id, true)
        } while (this._pending.size > 0 && Date.now() - sliceStart < WARMUP_SLICE_MS)
      }
    })()
    return this._warmup
  }

  /** Resolves once the background warm-up (if any) has loaded every project. */
  whenWarm(): Promise<void> {
    return this._warmup ?? Promise.resolve()
  }

  /** Projects still waiting for the background warm-up. */
  warmupStatus(): { pending: number; loaded: number } {
    return { pending: this._pending.size, loaded: this._contexts.size }
  }

  private _loadPending(id: string, background: boolean): void {
    if (!this._pending.delete(id)) return
    const row = getProject(this._desktopDb, id)
    if (row) this._tryLoadProject(row, 0, background)
  }

  /** Load every project the warm-up has not reached yet (used by app-wide totals that must be complete). */
  private _loadAllPending(): void {
    for (const id of [...this._pending]) this._loadPending(id, false)
  }

  private _reconcileCatalog(): ProjectRow[] {
    const projects = listProjects(this._desktopDb)
    // Self-heal the shared artifact registry: project one entry per desktop
    // project, leaving non-desktop (core-standalone) entries untouched. Wrapped
    // so a registry write failure never blocks app startup — a missing entry is
    // recreated on the next addProject/reconcile.
    try {
      reconcileFromProjects(
        projects.map((p) => ({
          repoPath: p.path,
          slug: p.slug,
          providers: p.providers,
          primaryProvider: p.provider,
          desktopProjectId: p.id,
        })),
      )
    } catch (err) {
      console.error('[project-registry] registry reconcile failed (non-fatal):', err)
    }
    return projects
  }

  private _tryLoadProject(project: ProjectRow, retry = 0, background = false): void {
    this._clearLoadRetry(project.id)
    if (this._shuttingDown) return
    try {
      this._loadProjectContext(project, { background })
      const recovered = this._failedProjects.delete(project.id)
      if (recovered) {
        try {
          this._broadcast({ type: 'desktop.project_recovered', projectId: project.id, timestamp: new Date().toISOString() })
        } catch { /* the available context remains authoritative */ }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[project-registry] failed to load project ${project.id} (${project.slug}): ${msg}`)
      this._failedProjects.set(project.id, { project, error: msg })
      // Only an unopened DB can be retried safely: no managers/watchers or
      // recovery work exist yet. Corruption and later constructor errors stay
      // visible without repeatedly constructing partially initialized contexts.
      if (err instanceof ProjectDatabaseBusyError) {
        const timer = setTimeout(() => {
          this._loadRetryTimers.delete(project.id)
          const current = getProject(this._desktopDb, project.id)
          if (current) this._tryLoadProject(current, Math.min(retry + 1, PROJECT_LOAD_RETRY_DELAYS_MS.length - 1))
        }, PROJECT_LOAD_RETRY_DELAYS_MS[retry])
        timer.unref?.()
        this._loadRetryTimers.set(project.id, timer)
      }
    }
  }

  private _clearLoadRetry(id: string): void {
    const timer = this._loadRetryTimers.get(id)
    if (timer) clearTimeout(timer)
    this._loadRetryTimers.delete(id)
  }

  /** The durable catalog includes projects whose DB could not be opened. */
  listProjects(): ProjectRow[] {
    return listProjects(this._desktopDb)
  }

  /** Projects whose per-project DB failed to load at startup (M9). */
  listFailedProjects(): { project: ProjectRow; error: string }[] {
    return Array.from(this._failedProjects.values())
  }

  /**
   * The deduped union of providers across every registered project (from the
   * desktop DB, so it includes projects that failed to load a per-project DB).
   * Used by the framework boot `versionCheck` to decide which providerDirs to
   * materialize. Defaults to `['claude']` when there are no projects yet (so a
   * fresh install still materializes the claude framework for the first add).
   */
  installedProvidersUnion(): string[] {
    const set = new Set<string>()
    for (const p of listProjects(this._desktopDb)) {
      const list = p.providers && p.providers.length > 0 ? p.providers : [p.provider]
      for (const prov of list) {
        if (prov && prov.length > 0) set.add(prov)
      }
    }
    return set.size > 0 ? Array.from(set) : ['claude']
  }

  addProject(opts: {
    id: string
    slug: string
    name: string
    path: string
    provider?: CliProvider
    providers?: CliProvider[]
    repositories?: ProjectRepositoryInput[]
    workspacePaths?: string[]
  }): ProjectContext {
    const row = addProjectToDesktopDb(this._desktopDb, opts)
    let previousRegistryEntry: ProjectEntry | undefined
    let mirroredRegistryEntry: ProjectEntry | undefined
    let registryMirrored = false
    // Mirror the new project into the shared artifact registry so specrails-core
    // resolves its relocated artifacts. Wrapped so a registry write failure never
    // breaks project creation — the startup reconcile will recreate the entry.
    try {
      const mutation = mirrorProjectEntryWithPrevious({
        repoPath: row.path,
        slug: row.slug,
        providers: row.providers,
        primaryProvider: row.provider,
        desktopProjectId: row.id,
      })
      previousRegistryEntry = mutation.previousEntry
      mirroredRegistryEntry = mutation.entry
      registryMirrored = true
    } catch (err) {
      console.error('[project-registry] registry mirror failed (non-fatal):', err)
    }
    try {
      const context = this._loadProjectContext(row)
      this._failedProjects.delete(row.id)
      return context
    } catch (err) {
      // Registration is one logical operation. A row that cannot be hydrated is
      // unusable through the API and would make every retry hit UNIQUE forever.
      this._contexts.delete(row.id)
      this._failedProjects.delete(row.id)
      // The mirror may have ADOPTED a pre-existing core-standalone entry. Undo
      // only a successful mirror and restore that entry verbatim; deleting it
      // would strand core's relocated artifacts. A fresh mirror has no prior
      // entry, so the same rollback removes the newly-created projection.
      if (registryMirrored && mirroredRegistryEntry) {
        try { restoreRegistryEntry(row.path, previousRegistryEntry, mirroredRegistryEntry) } catch { /* best effort */ }
      }
      try { removeProjectFromDesktopDb(this._desktopDb, row.id) } catch { /* best effort */ }
      throw err
    }
  }

  removeProject(id: string): void {
    this._clearLoadRetry(id)
    this._pending.delete(id)
    this._recoveryGate.cancel(id)
    this._lastTouched.delete(id)
    rulesInventoryRuns.forget(id)
    // Resolve the repo path BEFORE the DB row is deleted below so we can drop the
    // shared artifact-registry entry. Prefer the live context, fall back to the
    // desktop DB row (project may be registered-but-not-loaded, e.g. M9 failure).
    const persistedProject = getProject(this._desktopDb, id)
    const repoPath = this._contexts.get(id)?.project.path ?? persistedProject?.path
    const ctx = this._contexts.get(id)
    if (ctx) {
      // Invalidate async route continuations before any killed child can emit a
      // late `close` against the DB that this removal is about to close.
      beginProjectProcessQuiescence(id)
      // Tear down spawners BEFORE closing the DB. QueueManager.shutdown() drops
      // its DB handle so a late child 'close' can't run prepared statements on
      // the closed connection (which would crash the app) and terminates any
      // orphaned rail child + dangling zombie timer. ChatManager.shutdown()
      // kills in-flight chat/Explore children and clears their idle timers.
      // SetupManager.abort() stops the 3s install poll and kills install/enrich
      // children. All are idempotent no-ops when nothing is running.
      let queueRecoveryComplete = false
      try {
        queueRecoveryComplete = typeof ctx.queueManager.shutdown === 'function'
          ? ctx.queueManager.shutdown() !== false
          : true
      } catch (err) {
        console.error(`[project-registry] queue shutdown failed for ${id}:`, err)
      }
      if (!queueRecoveryComplete) {
        // The context remains registered with its DB intact. A retry can drain
        // the durable callback/outbox once the external ticket store recovers;
        // deleting the data dir here would make that effect unrecoverable.
        throw new Error('Project removal deferred: terminal job recovery is still pending')
      }
      // Persistent history must be removable before deleting project databases
      // or directories; a storage failure leaves the registered data retryable.
      purgeBackgroundProcessHistory({ projectId: id })
      try { ctx.chatManager.shutdown() } catch { /* ignore */ }
      // Loop engine teardown: dispose any resident interactive step sessions
      // (SIGTERM, no settle) + kill in-flight one-shot loop children — BEFORE
      // db.close() so a late close handler can't write to the closed handle.
      try { shutdownAgentRuntimeControls(ctx) } catch { /* ignore */ }
      try { ctx.loopRunManager.shutdown() } catch { /* ignore */ }
      try { ctx.setupManager.abort(id) } catch { /* ignore */ }
      // Kill untracked fire-and-forget children (Quick spec-gen) for this project.
      try { killTransientChildren(id) } catch { /* ignore */ }
      // M12: these three also spawn children that outlive removeProject. Proposal
      // and AgentRefine write to the per-project DB in their close handlers — if
      // not disposed before db.close() they throw on the closed connection and
      // (no uncaughtException handler) crash the entire app. SpecLauncher has no
      // DB but its --dangerously-skip-permissions child keeps burning spend.
      try { ctx.proposalManager.shutdown() } catch { /* ignore */ }
      try { ctx.agentRefineManager.shutdown() } catch { /* ignore */ }
      try { ctx.specLauncherManager.shutdown() } catch { /* ignore */ }
      // Tear down the embedded browser (closes pages + persistent context).
      void ctx.browserCaptureManager.shutdown().catch(() => { /* ignore */ })
      // Stop the Jira sync poll/drain timers (no children, just intervals).
      try { ctx.jiraSyncManager.stop() } catch { /* ignore */ }
      try { ctx.stuckRunDetector.stop() } catch { /* ignore */ }
      try { ctx.milestoneProgress?.dispose() } catch { /* ignore */ }
      try { ctx.flowSettlement?.stop() } catch { /* ignore */ }
      try { ctx.missionResourceRecorder?.stop() } catch { /* ignore */ }
      // Kill any terminal sessions belonging to this project
      try { getTerminalManager().killAllForProject(id) } catch { /* ignore */ }
      // Close the ticket file watcher
      ctx.ticketWatcher.close().catch(() => { /* ignore */ })
      // Tear down the code-explorer summary manager: aborts any in-flight
      // provider child, rejects queued work, and detaches the watcher — BEFORE
      // db.close() so a completing generation can't write to the closed handle.
      try { ctx.fileSummaryManager.dispose() } catch { /* ignore */ }
      try { ctx.specTriage?.dispose() } catch { /* ignore */ }
      try { ctx.trashPurge?.stop() } catch { /* ignore */ }
      try { ctx.prMergeWatch?.stop() } catch { /* ignore */ }
      // Drop the app-managed Explore Spec cwd (CLAUDE.md + symlink to project)
      try { removeExploreCwd(ctx.project.slug) } catch { /* ignore — non-fatal */ }
      // Drop this project's per-project phase-tracking scope (avoid a leak).
      try { dropPhaseScope(id) } catch { /* ignore */ }
      // Drop any in-memory telemetry BlobState entries for this project.
      try { dropBlobStatesForProject(id) } catch { /* ignore */ }
      // Stop the login-shell env refresh and forget recovered values.
      try { stopProjectEnvWarmup(ctx.db) } catch { /* ignore */ }
      // Flush pending audit rows and stop retention BEFORE the connection closes.
      try { ctx.agentAudit?.dispose() } catch { /* ignore */ }
      // Close the DB connection BEFORE removing the project's data dir below.
      try { ctx.db.close() } catch { /* ignore */ }
      this._contexts.delete(id)
    } else {
      purgeBackgroundProcessHistory({ projectId: id })
    }
    // B54: remove the ENTIRE app-managed data dir even when context hydration
    // failed. The persisted row is authoritative for registered-but-not-loaded
    // projects and contains the slug needed for safe cleanup.
    try {
      const slug = ctx?.project.slug ?? persistedProject?.slug
      if (slug && slug.trim() && !slug.includes('/') && !slug.includes('..')) {
        const projectDir = path.join(resolveSpecrailsHome(), '.specrails', 'projects', slug)
        if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true })
      }
    } catch { /* ignore — non-fatal */ }
    // Drop the relocated WORKSPACE for an adopted project whose REGISTRY slug
    // differs from the desktop slug. The per-project data-dir rm above only
    // removes `projects/<desktop-slug>`; an adopted repo's workspace lives under
    // `projects/<registry-slug>/workspace` and would otherwise leak. Resolve the
    // registry entry (BEFORE removeRegistryEntry deletes it) and, when relocated,
    // remove the workspace under the registry slug. Best-effort — never blocks
    // removal. (When the slugs match, the dir is already gone; removeWorkspace
    // no-ops on a missing dir.)
    if (repoPath) {
      try {
        const art = resolveArtifacts(repoPath)
        if (!art.isLegacy && art.entry?.slug) {
          // Use the SAME home the registry/workspace live under (== os.homedir()
          // in production; overridable via SPECRAILS_REGISTRY_HOME in tests) so
          // the workspace dir resolves identically to the registry entry.
          removeWorkspace(art.entry.slug, resolveHome())
        }
      } catch (err) {
        console.error('[project-registry] workspace remove failed (non-fatal):', err)
      }
    }
    // Drop the shared artifact-registry entry for this repo. Wrapped so a
    // registry write failure never blocks project removal.
    if (repoPath) {
      try { removeRegistryEntry(repoPath) } catch (err) {
        console.error('[project-registry] registry remove failed (non-fatal):', err)
      }
    }
    this._failedProjects.delete(id)
    removeProjectFromDesktopDb(this._desktopDb, id)
    if (persistedProject) {
      for (const listener of this._removalListeners) {
        try { listener({ id, slug: persistedProject.slug }) } catch (err) {
          console.error('[project-registry] project removal listener failed (non-fatal):', err)
        }
      }
    }
  }

  /** Observe project removal (e.g. to stop the project's Core session host). */
  onSettingsChanged(listener: (scope: { projectId: string | null }) => void): () => void {
    this._settingsListeners.add(listener)
    return () => { this._settingsListeners.delete(listener) }
  }

  notifySettingsChanged(scope: { projectId: string | null }): void {
    for (const listener of this._settingsListeners) {
      try { listener(scope) } catch (error) { console.error('[project-registry] settings listener failed:', error) }
    }
  }

  onProjectRemoved(listener: (project: { id: string; slug: string }) => void): () => void {
    this._removalListeners.add(listener)
    return () => { this._removalListeners.delete(listener) }
  }

  /**
   * The project's live context. A project the background warm-up has not
   * reached yet loads now; one whose startup recovery is still queued starts
   * recovering now (it is in use).
   */
  getContext(id: string): ProjectContext | undefined {
    let ctx = this._contexts.get(id)
    if (!ctx && this._pending.has(id)) {
      this._loadPending(id, false)
      ctx = this._contexts.get(id)
    }
    if (ctx && this._recoveryGate.isQueued(id)) this._recoveryGate.promote(id)
    return ctx
  }

  getContextByPath(projectPath: string, projectId?: string): ProjectContext | undefined {
    const row = resolveRepositoryProject(listProjects(this._desktopDb), projectPath, projectId)
    if (!row) return undefined
    return this.getContext(row.id)
  }

  /** Preserve manager closures and shared stores when the repository catalog changes. */
  refreshProjectRepositories(projectId: string): ProjectRow {
    const row = getProject(this._desktopDb, projectId)
    if (!row) throw new RepositoryValidationError('Project not found', 'project_not_found', 404)
    const context = this._contexts.get(projectId)
    if (context) {
      for (const previous of getProjectRepositories(context.project)) {
        const next = getProjectRepositories(row).find((repository) => repository.id === previous.id)
        if (!next || next.path !== previous.path) {
          try { context.fileSummaryManager.detachWatcher(projectId, previous.id) } catch (err) {
            console.warn('[project-registry] repository watcher cleanup failed:', err)
          }
        }
      }
      Object.assign(context.project, row)
    }
    const failed = this._failedProjects.get(projectId)
    if (failed) Object.assign(failed.project, row)
    return context?.project ?? row
  }

  addRepository(projectId: string, input: ProjectRepositoryInput): ProjectRepository {
    const repository = addRepositoryToDesktopDb(this._desktopDb, projectId, input)
    this.refreshProjectRepositories(projectId)
    return repository
  }

  updateRepository(projectId: string, repositoryId: string, input: Partial<ProjectRepositoryInput>): ProjectRepository {
    if (input.path !== undefined) {
      const project = getProject(this._desktopDb, projectId)
      if (!project) throw new RepositoryValidationError('Project not found', 'project_not_found', 404)
      const current = resolveProjectRepository(project, repositoryId)
      if (!current.isPrimary && repositoryPathKey(canonicalRepositoryPath(input.path)) === repositoryPathKey(canonicalRepositoryPath(current.path))) {
        input = { ...input }
        delete input.path
      }
    }
    if (input.workspacePath !== undefined || input.workspacePaths !== undefined) {
      const context = this._contexts.get(projectId)
      if (!context) throw new RepositoryValidationError('Load this project before changing its workspace', 'project_unavailable', 503)
      const references = getRepositoryExecutionReferences(context.db, repositoryId)
      const unfinished = context.db.prepare("SELECT id FROM loop_runs WHERE status <> 'completed' LIMIT 1").get()
      if (unfinished || references.runIds.length || references.deliveryIds.length) throw new RepositoryValidationError('Workspace is referenced by runs or pending deliveries', 'repository_in_use', 409, references)
    }
    if (input.path !== undefined) this._assertRepositoryUnreferenced(projectId, repositoryId)
    const repository = updateRepositoryInDesktopDb(this._desktopDb, projectId, repositoryId, input)
    this.refreshProjectRepositories(projectId)
    return repository
  }

  removeRepository(projectId: string, repositoryId: string): void {
    this._assertRepositoryUnreferenced(projectId, repositoryId)
    removeRepositoryFromDesktopDb(this._desktopDb, projectId, repositoryId)
    this.refreshProjectRepositories(projectId)
  }

  private _assertRepositoryUnreferenced(projectId: string, repositoryId: string): void {
    const project = getProject(this._desktopDb, projectId)
    if (!project) throw new RepositoryValidationError('Project not found', 'project_not_found', 404)
    const repository = resolveProjectRepository(project, repositoryId)
    if (repository.isPrimary) throw new RepositoryValidationError('The primary repository cannot be removed or relocated here', 'primary_repository_protected', 409)
    const context = this._contexts.get(projectId)
    if (!context) throw new RepositoryValidationError('Load this project before removing or relocating a repository', 'project_unavailable', 503)
    const store = readStore(resolveProjectTicketsPath({ slug: project.slug, path: project.path }))
    const ticketIds = Object.values(store.tickets).filter((ticket) => ticket.repositoryIds?.includes(repositoryId)).map((ticket) => ticket.id)
    const references = getRepositoryExecutionReferences(context.db, repositoryId)
    if (ticketIds.length || references.runIds.length || references.deliveryIds.length) {
      throw new RepositoryValidationError('Repository is referenced by specs, runs or pending deliveries', 'repository_in_use', 409, { ticketIds, ...references })
    }
  }

  listContexts(): ProjectContext[] {
    return Array.from(this._contexts.values())
  }

  /**
   * Graceful process-level teardown: terminate every project's active rail and
   * chat children so SIGTERM/SIGINT (or desktop parent-death) does not leave
   * orphaned claude/codex processes reparented to init. Best-effort per project
   * — one failure never blocks the rest. Does NOT close DBs (the process is
   * exiting anyway).
   */
  shutdown(): void {
    this._shuttingDown = true
    this._pending.clear()
    this._recoveryGate.clear()
    for (const id of this._loadRetryTimers.keys()) this._clearLoadRetry(id)
    for (const ctx of this._contexts.values()) {
      try { ctx.queueManager.shutdown() } catch { /* ignore */ }
      try { ctx.chatManager.shutdown() } catch { /* ignore */ }
      // Loop engine: dispose resident interactive step sessions + kill in-flight
      // one-shot loop children so a quit mid-run doesn't orphan claude processes.
      try { shutdownAgentRuntimeControls(ctx) } catch { /* ignore */ }
      try { ctx.loopRunManager.shutdown() } catch { /* ignore */ }
      // Install/enrich wizard children + the 3s install poll interval are NOT
      // torn down by the spawner shutdowns above — mirror removeProject()'s
      // setupManager.abort() so a quit mid-wizard doesn't orphan them.
      try { ctx.setupManager.abort(ctx.project.id) } catch { /* ignore */ }
      try { killTransientChildren(ctx.project.id) } catch { /* ignore */ }
      try { ctx.proposalManager.shutdown() } catch { /* ignore */ }
      try { ctx.agentRefineManager.shutdown() } catch { /* ignore */ }
      try { ctx.specLauncherManager.shutdown() } catch { /* ignore */ }
      void ctx.browserCaptureManager.shutdown().catch(() => { /* ignore */ })
      try { ctx.jiraSyncManager.stop() } catch { /* ignore */ }
      try { ctx.stuckRunDetector.stop() } catch { /* ignore */ }
      try { ctx.milestoneProgress?.dispose() } catch { /* ignore */ }
      try { ctx.flowSettlement?.stop() } catch { /* ignore */ }
      try { ctx.missionResourceRecorder?.stop() } catch { /* ignore */ }
      // Release chokidar watchers + abort in-flight generations so a restart
      // does not leak handles/children — mirror removeProject()'s per-project teardown.
      try { ctx.fileSummaryManager.dispose() } catch { /* ignore */ }
      try { ctx.specTriage?.dispose() } catch { /* ignore */ }
      try { ctx.trashPurge?.stop() } catch { /* ignore */ }
      try { ctx.prMergeWatch?.stop() } catch { /* ignore */ }
      try { stopProjectEnvWarmup(ctx.db) } catch { /* ignore */ }
      try { ctx.agentAudit?.dispose() } catch { /* ignore */ }
      ctx.ticketWatcher.close().catch(() => { /* ignore */ })
    }
    // Close the shared browser context once, after every per-project manager has
    // released its pages (they never close the shared context themselves).
    void this._browserContextPool.dispose().catch(() => { /* ignore */ })
  }

  touchProject(id: string): void {
    // Every project request lands here; one desktop-DB write per interval is enough.
    const now = Date.now()
    const last = this._lastTouched.get(id)
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS) return
    this._lastTouched.set(id, now)
    touchProject(this._desktopDb, id)
  }

  getProjectRow(id: string): ProjectRow | undefined {
    return getProject(this._desktopDb, id)
  }

  /**
   * Compose one project's runtime. Construction ORDER is part of the contract:
   *  1. Process admission closes before anything can spawn; it reopens only at
   *     the end of startup recovery (project-context-recovery.ts).
   *  2. The bound broadcast exists first; its observer taps (milestones, spec
   *     triage, Intent) are assigned as their owners are created.
   *  3. JiraSyncManager and the audit writer precede QueueManager: terminal job
   *     effects enqueue Jira transitions and record audit rows.
   *  4. The ticket watcher starts after JiraSyncManager (late-bound write
   *     notifier) and after the command catalog is loaded.
   *  5. Active loop runs are captured BEFORE the loop engine is constructed;
   *     their status transition waits until onLoopRunFinished exists so crash
   *     recovery replays ticket, rail and Jira invariants.
   *  6. The context object is assembled before services that need a complete
   *     context (mission resources, triage, trash purge, merge watch, Intent),
   *     and registered before env warmup and startup recovery start.
   * Teardown (removeProject/shutdown) releases these in its own documented order.
   */
  private _loadProjectContext(project: ProjectRow, opts: { background?: boolean } = {}): ProjectContext {
    // Avoid double-loading
    const existing = this._contexts.get(project.id)
    if (existing) return existing

    // A context is visible synchronously, but no subprocess launch may enter
    // until durable loop callbacks and isolated worktrees have been reconciled.
    beginProjectProcessQuiescence(project.id)
    const db = this._openProjectDb(project)
    const desktopDb = this._desktopDb

    const taps = createProjectBroadcastTaps()
    const boundBroadcast = createProjectBroadcast({ projectId: project.id, broadcast: (msg) => this._broadcast(msg), desktopDb, taps })
    const zombieTimeoutMs = readProjectZombieTimeout(db)
    const railJobs: ProjectContext['railJobs'] = new Map()
    const tickets = createProjectTicketAccess(project)

    // ── Integrations + audit (needed by the queue's terminal effects) ────────
    // Jira sync (per-project, inert until a connection is configured).
    const jiraSyncManager = new JiraSyncManager({ db, projectId: project.id, projectPath: project.path, broadcast: boundBroadcast })
    // Agent actions audit (one batched writer per project connection). Retention
    // runs shortly after startup and daily, reading the project setting each time.
    const agentAudit = createProjectAgentAudit(db, {
      label: project.slug,
      retentionDays: () => getProjectSettings(db).agentAuditRetentionDays,
    })

    // ── Queue & execution ────────────────────────────────────────────────────
    const queueManager = createProjectQueue({
      project, db, broadcast: boundBroadcast, desktopDb, desktopPort: this._desktopPort, zombieTimeoutMs,
      agentAudit, webhookManager: this._webhookManager, jiraSyncManager, railJobs,
      desktopDailyBudget: () => this._desktopDailyBudgetSnapshot(),
      capStatuses: () => this._capStatuses(db, project.id),
      pauseAllQueuesForDesktopBudget: () => this._pauseAllQueuesForDesktopBudget(),
    })

    // ── Conversations, setup, spec authoring, code explorer ──────────────────
    const authoring = createProjectAuthoringManagers({ project, db, broadcast: boundBroadcast, desktopDb, getContext: (pid) => this._contexts.get(pid) })
    const fileSummaryManager = createProjectFileSummaryManager({ project, db, broadcast: boundBroadcast, desktopDb })
    loadProjectCommands(queueManager, project)

    // ── Specs watcher + browser capture ──────────────────────────────────────
    const ticketWatcher = startProjectTicketWatcher({ project, broadcast: boundBroadcast, jiraSyncManager })
    const browserCaptureManager = createProjectBrowserCapture({ project, db, broadcast: boundBroadcast, contextPool: this._browserContextPool })

    // ── Loops engine, budgets, loop settlement ───────────────────────────────
    const railLoopRuns: ProjectContext['railLoopRuns'] = new Map()
    // Capture before runtime construction (order point 5 above).
    let orphanLoopRuns: LoopRunRow[] = []
    try { orphanLoopRuns = listActiveLoopRuns(db, project.id) } catch { /* non-fatal */ }
    const budget = createProjectBudgetGates({
      db, projectId: project.id, desktopDb,
      desktopDailyBudget: () => this._desktopDailyBudgetSnapshot(),
      desktopPeriodBudget: (period, at) => this._desktopPeriodSnapshot(period, at),
      desktopCapConfig: () => this._desktopCapConfig(),
    })
    const publishRunClarifications = createRunClarificationsPublisher({ project, db, jiraSyncManager })
    // The project context exists only after its managers; late-bound for callbacks.
    let projectContext: ProjectContext | null = null
    const loopRunManager = createProjectLoopRuntime({
      project, db, broadcast: boundBroadcast, desktopDb, agentAudit,
      dailyBudgetRejection: budget.dailyBudgetRejection, runCapDefault: budget.runCapDefault,
      publishRunClarifications, getProjectContext: () => projectContext,
    })
    const finishLoopRun = createLoopRunFinishedHandler({
      project, db, railLoopRuns, ticketStorePath: tickets.ticketStorePath, jiraSyncManager, publishRunClarifications, taps, broadcast: boundBroadcast,
    })
    // A settled run's runtime summary is read next (its card, Continue, an agent's diagnose):
    // read it once now, off the request path, so those reads hit the settled-status cache
    // instead of each spawning Core's status command.
    const onLoopRunFinished: typeof finishLoopRun = (runId, ...rest) => {
      const finished = finishLoopRun(runId, ...rest)
      const warm = setTimeout(() => { if (projectContext) void runtimeRunSummary(projectContext, runId).catch(() => null) }, 250)
      warm.unref?.()
      return finished
    }
    const stuckRunDetector = new StuckRunDetector(project.id, { db }, boundBroadcast)
    stuckRunDetector.start()

    // ── Project builder milestones ───────────────────────────────────────────
    // Milestone launch chain (premium-milestone-progress D3): chunks launch
    // through the app's OWN rails launch route over loopback (the single
    // authority for every guard) — never by re-implementing the handler.
    const internalApi = createInternalApi({ port: this._desktopPort })
    const blueprintWorkspace = createBlueprintWorkspaceResolver(project)
    const milestoneDeps = { project, db, railJobs, railLoopRuns, ticketStorePath: tickets.ticketStorePath, blueprintWorkspace, broadcast: boundBroadcast }
    const milestoneChains = createProjectMilestoneChains({ ...milestoneDeps, internalApi })
    taps.milestoneChains = milestoneChains
    const milestoneProgress = createProjectMilestoneProgress({
      ...milestoneDeps,
      getChains: () => taps.milestoneChains,
      holdSources: () => runHoldSources({ loopRunManager, restartPendingRunIds: projectContext?.restartPendingRunIds }),
    })
    taps.milestoneProgress = milestoneProgress

    // ── Assemble the context, then services that need it ─────────────────────
    const ctx: ProjectContext = {
      project, db, queueManager, ...authoring, fileSummaryManager, ticketWatcher, browserCaptureManager, jiraSyncManager, stuckRunDetector,
      broadcast: boundBroadcast, railJobs, loopRunManager, railLoopRuns, onLoopRunFinished, getTicketSpec: tickets.getTicketSpec, desktopDb,
      milestoneProgress, ...budget, agentAudit,
    }
    projectContext = ctx
    ctx.restartPendingRunIds = new Set(orphanLoopRuns.map(run => run.id))
    ctx.milestoneChains = milestoneChains
    attachProjectServices(ctx, { db, ticketStorePath: tickets.ticketStorePath, taps })
    // Intent mode: use cases bound to THIS project's connection; the mission host
    // is app-global and late-bound (agent chat starts after the registry).
    createProjectIntent({ ctx, db, desktopDb, internalApi, providerBilling: () => this._providerBilling, readFlowTicket: tickets.readFlowTicket, taps })

    this._contexts.set(project.id, ctx)
    // A failed run whose cause is known and fixable continues once by itself (Settings can turn it off).
    taps.autoContinue = createAutoContinuation({
      context: () => (this._contexts.get(project.id) === ctx ? ctx : null), desktopDb,
      continueRun: (context, runId, remedy, options) => continueDefinitionRun(context, runId, remedy, options),
    })
    // Warm the project's login-shell env cache off the event loop so the first
    // rail/loop spawn reads recovered credentials instead of a cold 1.5 s probe.
    startProjectEnvWarmup(db)
    const recover = (): Promise<void> => startProjectRecovery({
      ctx, project, db, broadcast: boundBroadcast, jiraSyncManager, orphanLoopRuns,
      isCurrent: () => this._contexts.get(project.id) === ctx,
      recoverOrphanLoopRuns: (definitionStates) => this._recoverOrphanLoopRuns(project, db, railLoopRuns, onLoopRunFinished, orphanLoopRuns, definitionStates),
    })
    // Startup recovery always runs; a background warm-up bounds how many run at once.
    if (opts.background) this._recoveryGate.enqueue(project.id, recover)
    else void recover()
    return ctx
  }

  /** Open the per-project DB; a busy/locked database is the only retryable load failure. */
  private _openProjectDb(project: ProjectRow): DbInstance {
    try {
      return initDb(project.db_path)
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code
      if (typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)(_|$)/.test(code)) {
        throw new ProjectDatabaseBusyError(err instanceof Error ? err.message : String(err), { cause: err })
      }
      throw err
    }
  }

  private _recoverOrphanLoopRuns(
    project: ProjectRow,
    db: DbInstance,
    railLoopRuns: ProjectContext['railLoopRuns'],
    onLoopRunFinished: (runId: string, outcome: string) => void,
    orphans: LoopRunRow[],
    definitionStates?: ReadonlyMap<string, DefinitionCheckpoint>,
  ): boolean {
    return recoverOrphanLoopRuns(project, db, railLoopRuns, onLoopRunFinished, orphans, definitionStates)
  }

  /** App-wide daily budget state. The queue auto-pause and the rail/loop
   *  admission gate read this same snapshot, so both doors agree. Same basis as
   *  the project day cap and the weekly/monthly caps: every recorded cost since
   *  the LOCAL day start, all projects plus every agent turn (missions, Intent,
   *  Home and Blueprint chats). It used to read completed jobs since the UTC day. */
  private _desktopDailyBudgetSnapshot(at: Date = new Date()): { budget: number | null; totalSpend: number } {
    const val = getDesktopSetting(this._desktopDb, 'desktop_daily_budget_usd')
    const budget = val != null ? parseFloat(val) : null
    // Without an app-wide daily budget the spend is never read (every consumer
    // checks `budget > 0` first); summing every project per call made the
    // per-project inbox/live-board caps O(projects²).
    if (budget === null || !(budget > 0)) return { budget, totalSpend: 0 }
    return { budget, totalSpend: this._appWideSpend(localDayStartIso(at)) }
  }

  /**
   * Run `fn` with one app-wide spend figure per period: cross-project read
   * models (inbox, live board) ask every project for its caps, and each ask
   * would otherwise sum every project again. The memo lives only for `fn`.
   */
  withSpendSnapshot<T>(fn: () => T): T {
    if (this._spendScope.getStore()) return fn()
    return this._spendScope.run(new Map(), fn)
  }

  private _appWideSpend(sinceIso: string): number {
    const memo = this._spendScope.getStore()
    const cached = memo?.get(sinceIso)
    if (cached !== undefined) return cached
    const total = appWideSpendSince(this._spendProjects(), this._desktopDb, sinceIso)
    memo?.set(sinceIso, total)
    return total
  }

  private _spendProjects(): Array<{ db: DbInstance; projectId: string }> {
    // An app-wide cap must count every project, including ones still warming up.
    this._loadAllPending()
    return this.listContexts().map((c) => ({ db: c.db, projectId: c.project.id }))
  }

  /** App-wide caps (all projects combined) as configured in desktop settings. */
  private _desktopCapConfig(): CapConfig {
    return readDesktopCaps((key) => getDesktopSetting(this._desktopDb, key))
  }

  /** App-wide weekly/monthly cap with the spend of EVERY project in the local period containing `at`. */
  private _desktopPeriodSnapshot(period: Exclude<CapPeriod, 'day'>, at: Date): { budget: number | null; totalSpend: number } {
    const budget = this._desktopCapConfig()[period]
    if (budget === null) return { budget: null, totalSpend: 0 }
    // Every project plus every agent turn (app-wide scope).
    return { budget, totalSpend: this._appWideSpend(periodStartIso(period, at)) }
  }

  /** The app-wide caps with their spend (all projects combined), for the Budget panel. */
  desktopCapStatuses(at: Date = new Date()): CapStatus[] {
    const out: CapStatus[] = []
    const day = this._desktopDailyBudgetSnapshot(at)
    const push = (period: CapPeriod, snapshot: { budget: number | null; totalSpend: number }, resetsAt: string): void => {
      if (snapshot.budget == null || !(snapshot.budget > 0)) return
      out.push({ scope: 'desktop', period, budgetUsd: snapshot.budget, spentUsd: snapshot.totalSpend, exhausted: isCapExceeded(snapshot.budget, snapshot.totalSpend), resetsAt })
    }
    push('day', day, dailyBudgetResetsAt('desktop', at))
    push('week', this._desktopPeriodSnapshot('week', at), periodResetsAtIso('week', at))
    push('month', this._desktopPeriodSnapshot('month', at), periodResetsAtIso('month', at))
    return out
  }

  /** Every cap of one project plus the app-wide ones, with spend. */
  private _capStatuses(db: DbInstance, projectId: string, at: Date = new Date()): CapStatus[] {
    return readCapStatuses({ db, projectId, appLedgerDb: this._desktopDb, desktop: () => this._desktopDailyBudgetSnapshot(), desktopPeriod: (period, when) => this._desktopPeriodSnapshot(period, when) }, at)
  }

  /** Enforce the app-wide budget through every per-project queue authority. */
  private _pauseAllQueuesForDesktopBudget(): void {
    for (const context of this.listContexts()) {
      try {
        if (!context.queueManager.isPaused()) context.queueManager.pause()
      } catch { /* a concurrently removed project is best-effort */ }
    }
  }
}
