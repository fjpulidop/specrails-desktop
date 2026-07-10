import path from 'path'
import fs from 'fs'
import os from 'os'
import type { DbInstance } from './db'
import { initDb } from './db'
import { QueueManager } from './queue-manager'
import { ChatManager } from './chat-manager'
import { SetupManager } from './setup-manager'
import { ProposalManager } from './proposal-manager'
import { AgentRefineManager } from './agent-refine-manager'
import { FileSummaryManager } from './file-summary-manager'
import { createFileSummaryGenerator } from './file-summary-generator'
import { getAdapter } from './providers'
import { pruneStaleRefineSessions } from './agent-refine-db'
import { SpecLauncherManager } from './spec-launcher-manager'
import { WebhookManager } from './webhook-manager'
import { TicketWatcher } from './ticket-watcher'
import { getTerminalManager } from './terminal-manager'
import { BrowserCaptureManager } from './browser-capture-manager'
import { SharedBrowserContextPool } from './browser-context-pool'
import { removeExploreCwd } from './explore-cwd-manager'
import { dropPhaseScope } from './hooks'
import { killTransientChildren } from './transient-children'
import { dropBlobStatesForProject } from './telemetry-receiver'
import {
  mirrorProjectEntryWithPrevious,
  removeRegistryEntry,
  reconcileFromProjects,
  resolveArtifacts,
  resolveHome,
  restoreRegistryEntry,
  type ProjectEntry,
} from './artifact-registry'
import { resolveProjectExecution, resolveLoopBaseEnv } from './workspace-resolution'
import { applyWorktreeEnvPassthrough } from './project-env'
import { removeWorkspace } from './workspace-manager'
import { resolveTicketStoragePath, mutateStore, applyJobOutcomeToTickets, extractTicketIdsFromCommand, readStore, type JobOutcome } from './ticket-store'
import { JiraSyncManager } from './jira/jira-sync-manager'
import { LoopRunManager, recoverOrphanLoopStepAccounting } from './loop-run-manager'
import { createLoopExecutors } from './loop-executors'
import { reconcileRailWorktrees } from './rail-isolated-launch'
import { isRailPrDeliveryEnabled } from './rail-isolation'
import {
  getLoopTerminalRecovery,
  getLoopRun,
  listActiveLoopRuns,
  listPendingLoopTerminalRecoveries,
  completeLoopTerminalRecovery,
  reconcileOrphanLoopRuns,
  type LoopRunRow,
  type LoopTerminalRecoveryPayload,
} from './loop-runs-store'
import type { LoopSpec } from './loop-graph'
import type { JobStatus, WsMessage, TicketUpdatedMessage, RailUpdatedMessage } from './types'
import { claimRailTickets, claimTicketOutcomeOwners, getRails, releaseRailTicketsOwnedBy, ticketOutcomeOwner } from './rails-store'
import {
  initDesktopDb,
  getDesktopDbPath,
  listProjects,
  addProject as addProjectToDesktopDb,
  removeProject as removeProjectFromDesktopDb,
  getProject,
  getProjectByPath,
  touchProject,
  setProjectSetupSession,
  clearProjectSetupSession,
  clearAgentJob,
  getDesktopSetting,
  type ProjectRow,
  type CliProvider,
} from './desktop-db'
import { getConfig } from './config'
import {
  beginProjectProcessQuiescence,
  openProjectProcessAdmission,
} from './process-admission'

// ─── Types ────────────────────────────────────────────────────────────────────

/** The two live queue states are the only non-terminal members of JobStatus.
 * Deriving terminality from that invariant avoids a second status list that can
 * silently fall behind the queue contract when a new terminal outcome is added. */
function isTerminalJobStatus(status: JobStatus): boolean {
  return status !== 'queued' && status !== 'running'
}

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
  broadcast: (msg: WsMessage) => void
  /** Maps jobId → rail metadata for active rail-launched jobs */
  railJobs: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>
  // ── Loops (the Loops feature) ──────────────────────────────────────────────
  /** App-driven loop engine for this project (Loops mode rails). */
  loopRunManager: LoopRunManager
  /** Maps loopRunId → rail metadata for active rail-launched loop runs. */
  railLoopRuns: Map<string, {
    railIndex: number
    ticketIds: number[]
    /** Current launchers settle through a durable loop_terminal_recovery row.
     * Absence means admission failed; never reinterpret it as a legacy exit. */
    requiresTerminalIntent?: boolean
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
    opts?: { ticketCompletionStatus?: 'done' | 'on_review' },
  ) => void
  /** Read a spec's fields for {{spec.*}} interpolation at launch. */
  getTicketSpec: (ticketId: number) => LoopSpec | undefined
  /** App-level DB (project registry + the global `loops` table). */
  desktopDb: DbInstance
}

// ─── ProjectRegistry ──────────────────────────────────────────────────────────

export class ProjectRegistry {
  private _desktopDb: DbInstance
  private _contexts: Map<string, ProjectContext>
  private _broadcast: (msg: WsMessage) => void
  private _webhookManager: WebhookManager
  private _desktopPort: number
  // M9: projects whose per-project DB failed to load at startup (corrupt, locked,
  // or migration-stuck). They stay registered but have no live context.
  private _failedProjects: Map<string, { project: ProjectRow; error: string }>
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

  get desktopDb(): DbInstance {
    return this._desktopDb
  }

  loadAll(): void {
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
    for (const project of projects) {
      try {
        this._loadProjectContext(project)
        this._failedProjects.delete(project.id)
      } catch (err) {
        // M9: a single corrupt / locked / migration-stuck per-project jobs.sqlite
        // must NOT crash the whole app at startup (previously it did, killing
        // every other project + the UI in a restart loop). Log it, record it as
        // failed-to-load, and keep loading the rest.
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`[project-registry] failed to load project ${project.id} (${project.slug}): ${msg}`)
        this._failedProjects.set(project.id, { project, error: msg })
      }
    }
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
      try { ctx.chatManager.shutdown() } catch { /* ignore */ }
      // Loop engine teardown: dispose any resident interactive step sessions
      // (SIGTERM, no settle) + kill in-flight one-shot loop children — BEFORE
      // db.close() so a late close handler can't write to the closed handle.
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
      // Kill any terminal sessions belonging to this project
      try { getTerminalManager().killAllForProject(id) } catch { /* ignore */ }
      // Close the ticket file watcher
      ctx.ticketWatcher.close().catch(() => { /* ignore */ })
      // Tear down the code-explorer summary manager: aborts any in-flight
      // provider child, rejects queued work, and detaches the watcher — BEFORE
      // db.close() so a completing generation can't write to the closed handle.
      try { ctx.fileSummaryManager.dispose() } catch { /* ignore */ }
      // Drop the app-managed Explore Spec cwd (CLAUDE.md + symlink to project)
      try { removeExploreCwd(ctx.project.slug) } catch { /* ignore — non-fatal */ }
      // Drop this project's per-project phase-tracking scope (avoid a leak).
      try { dropPhaseScope(id) } catch { /* ignore */ }
      // Drop any in-memory telemetry BlobState entries for this project.
      try { dropBlobStatesForProject(id) } catch { /* ignore */ }
      // Close the DB connection BEFORE removing the project's data dir below.
      try { ctx.db.close() } catch { /* ignore */ }
      this._contexts.delete(id)
    }
    // B54: remove the ENTIRE app-managed data dir even when context hydration
    // failed. The persisted row is authoritative for registered-but-not-loaded
    // projects and contains the slug needed for safe cleanup.
    try {
      const slug = ctx?.project.slug ?? persistedProject?.slug
      if (slug && slug.trim() && !slug.includes('/') && !slug.includes('..')) {
        const projectDir = path.join(os.homedir(), '.specrails', 'projects', slug)
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
  }

  getContext(id: string): ProjectContext | undefined {
    return this._contexts.get(id)
  }

  getContextByPath(projectPath: string): ProjectContext | undefined {
    const row = getProjectByPath(this._desktopDb, projectPath)
    if (!row) return undefined
    return this._contexts.get(row.id)
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
    for (const ctx of this._contexts.values()) {
      try { ctx.queueManager.shutdown() } catch { /* ignore */ }
      try { ctx.chatManager.shutdown() } catch { /* ignore */ }
      // Loop engine: dispose resident interactive step sessions + kill in-flight
      // one-shot loop children so a quit mid-run doesn't orphan claude processes.
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
      // Release chokidar watchers + abort in-flight generations so a restart
      // does not leak handles/children — mirror removeProject()'s per-project teardown.
      try { ctx.fileSummaryManager.dispose() } catch { /* ignore */ }
      ctx.ticketWatcher.close().catch(() => { /* ignore */ })
    }
    // Close the shared browser context once, after every per-project manager has
    // released its pages (they never close the shared context themselves).
    void this._browserContextPool.dispose().catch(() => { /* ignore */ })
  }

  touchProject(id: string): void {
    touchProject(this._desktopDb, id)
  }

  getProjectRow(id: string): ProjectRow | undefined {
    return getProject(this._desktopDb, id)
  }

  private _loadProjectContext(project: ProjectRow): ProjectContext {
    // Avoid double-loading
    const existing = this._contexts.get(project.id)
    if (existing) return existing

    const db = initDb(project.db_path)

    // Bind broadcast with projectId so all WS messages carry context.
    // Also wire agent status: when a queued job reaches a terminal state,
    // clear current_job_id on any agent that was assigned to it.
    const boundBroadcast = (msg: WsMessage): void => {
      const enriched = { ...msg, projectId: project.id }
      this._broadcast(enriched as WsMessage)
      if (msg.type === 'queue') {
        for (const job of msg.jobs) {
          if (isTerminalJobStatus(job.status)) {
            clearAgentJob(this._desktopDb, job.id)
          }
        }
      }
    }

    // Per-project zombie timeout (stored in queue_state)
    let projectZombieTimeout: number | undefined
    try {
      const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.zombie_timeout_ms'`).get() as { value: string } | undefined
      if (row) {
        const parsed = parseInt(row.value, 10)
        if (!isNaN(parsed) && parsed > 0) projectZombieTimeout = parsed
      }
    } catch { /* queue_state table may not exist yet */ }

    const webhookManager = this._webhookManager
    const railJobs = new Map<string, { railIndex: number; mode: string; ticketIds: number[] }>()
    const ticketStorePath = (): string => {
      const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
      return exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(project.path)
    }
    // Jira sync (per-project, inert until a connection is configured). Constructed
    // before QueueManager so the onJobFinished closure can reference it.
    const jiraSyncManager = new JiraSyncManager({
      db,
      projectId: project.id,
      projectPath: project.path,
      broadcast: boundBroadcast,
    })
    const queueManager = new QueueManager(boundBroadcast, db, undefined, project.path, {
      zombieTimeoutMs: projectZombieTimeout,
      provider: project.provider ?? 'claude',
      projectId: project.id,
      projectSlug: project.slug,
      desktopPort: this._desktopPort,
      onJobAdmission: (projectDb, job) => {
        const ticketIds = extractTicketIdsFromCommand(job.command)
        claimTicketOutcomeOwners(projectDb, ticketIds, job.id)
        const wanted = new Set(ticketIds)
        for (const rail of getRails(projectDb)) {
          const assigned = rail.ticketIds.filter((ticketId) => wanted.has(ticketId))
          if (assigned.length > 0) claimRailTickets(projectDb, rail.railIndex, assigned, job.id)
        }
        // Distinguish current launches from genuinely pre-migration rows even
        // when their current ticket owner later changes or becomes unreadable.
        // This update shares the queue-admission transaction with the claims.
        job.causalOwnership = true
        const marked = projectDb.prepare(`
          UPDATE queued_jobs SET causal_ownership = 1 WHERE id = ?
        `).run(job.id)
        if (marked.changes !== 1) {
          throw new Error(`Failed to persist causal admission for job ${job.id}`)
        }
      },
      getCostAlertThreshold: () => {
        const val = getDesktopSetting(this._desktopDb, 'cost_alert_threshold_usd')
        return val != null ? parseFloat(val) : null
      },
      getDesktopDailyBudget: () => {
        const val = getDesktopSetting(this._desktopDb, 'desktop_daily_budget_usd')
        const budget = val != null ? parseFloat(val) : null
        let totalSpend = 0
        for (const c of this.listContexts()) {
          const row = c.db.prepare(
            `SELECT COALESCE(SUM(total_cost_usd), 0) as total FROM jobs WHERE status = 'completed' AND total_cost_usd IS NOT NULL AND started_at >= date('now')`
          ).get() as { total: number }
          totalSpend += row.total
        }
        return { budget, totalSpend }
      },
      onBudgetExceeded: (event, data) => {
        if (event === 'desktop_daily_budget_exceeded') {
          this._pauseAllQueuesForDesktopBudget()
        }
        // Deliver the budget event to this project's subscribed webhooks — the
        // WS broadcast alone never reached webhook subscribers, so a
        // daily_budget_exceeded / desktop_daily_budget_exceeded subscription was
        // dead. (Event names are in the webhook validEvents allow-list.)
        try {
          webhookManager.deliver(project.id, event as Parameters<typeof webhookManager.deliver>[1], data)
        } catch { /* best-effort */ }
      },
      onJobFinished: (jobId, status, costUsd, opts) => {
        // Recovery can deliver this callback without another queue snapshot.
        // Clear the assignment here as the authoritative terminal effect; the
        // bound queue broadcast above remains an idempotent live-path fallback.
        if (isTerminalJobStatus(status)) {
          clearAgentJob(this._desktopDb, jobId)
        }
        const jobRow = db.prepare('SELECT command, duration_ms, causal_ownership FROM jobs WHERE id = ?').get(jobId) as
          | { command: string; duration_ms: number | null; causal_ownership: number }
          | undefined
        // Recovery callbacks carry their own immutable inputs. Job history is
        // independently deletable/purgeable once a row is terminal; replaying
        // from that row would otherwise checkpoint an empty callback and strand
        // the ticket/rail state forever.
        const recoveryCommand = opts?.recoveryReplay ? opts.recoveryCommand : undefined
        const effectiveCommand = recoveryCommand ?? jobRow?.command ?? ''
        const effectiveDurationMs = opts?.recoveryReplay
          ? (opts.recoveryDurationMs ?? jobRow?.duration_ms ?? null)
          : (jobRow?.duration_ms ?? null)
        const ticketOutcomeStatus: JobOutcome = status === 'skipped'
          ? 'canceled'
          : status as JobOutcome
        const affectsTickets = status === 'completed' || status === 'failed' ||
          status === 'canceled' || status === 'zombie_terminated' || status === 'skipped'
        const event = status === 'completed' ? 'job.completed' : status === 'canceled' ? 'job.canceled' : 'job.failed'
        const criticalFailures: string[] = []
        let outcomeStore: ReturnType<typeof readStore> | null = null
        let changedTicketIds: number[] = []
        let effectTicketIds: number[] = []
        // Broadcast rail.job_completed if this job was launched by a rail
        const railMeta = railJobs.get(jobId)
        if (railMeta) {
          railJobs.delete(jobId)
        }

        // Determine ticket IDs: from rail metadata, or parse from command as fallback
        // (railJobs Map is in-memory and lost on server restart)
        let completedTicketIds: number[] = railMeta?.ticketIds ?? []
        if (completedTicketIds.length === 0 && opts?.recoveryReplay && opts.recoveryTicketIds) {
          completedTicketIds = [...new Set(opts.recoveryTicketIds)]
        }
        if (completedTicketIds.length === 0 && effectiveCommand) {
          const matches = effectiveCommand.match(/#(\d+)/g)
          if (matches) completedTicketIds = matches.map((m) => parseInt(m.slice(1), 10))
        }
        const ticketOwners = new Map<number, string | null>()
        let ownershipReadable = true
        try {
          for (const ticketId of completedTicketIds) {
            ticketOwners.set(ticketId, ticketOutcomeOwner(db, ticketId))
          }
        } catch (err) {
          ownershipReadable = false
          criticalFailures.push(`ticket ownership: ${err instanceof Error ? err.message : String(err)}`)
        }
        const callbackCausalOwnership = opts?.recoveryReplay
          ? opts.recoveryCausalOwnership === true
          : jobRow?.causal_ownership === 1

        // Apply the job outcome to its tickets. Success promotes todo/in_progress
        // → done (→ Specs Done) — or → on_review under the ask-first PR-delivery
        // methodology (below); failure/cancel/zombie reverts in_progress → todo
        // (→ Specs) or flags an already-done spec for review. zombie_terminated is
        // treated as a failure here (and is included in the _onJobExit callback
        // guard) so a timed-out rail releases its specs instead of stranding them.
        //
        // Ask-first methodology (safe-pr-workflow, universal): QueueManager
        // captures the PR-delivery flag ONCE at this job's spawn and threads it
        // here as `opts.ticketCompletionStatus` — so a mid-flight env flip can't
        // split one job's behavior. Under the flag a COMPLETED job parks its
        // tickets at on_review (the human decides done via PR merge or a manual
        // move), never done. Absent opts (legacy callers / never-spawned failure
        // paths) ⇒ 'done', byte-identical to the pre-change promotion.
        const completedStatus = opts?.ticketCompletionStatus ?? 'done'
        if (
          completedTicketIds.length > 0 &&
          affectsTickets
        ) {
          try {
            // Relocate-artifacts gate: write the job outcome to the workspace
            // ticket store when relocated, else the repo-relative store (legacy).
            const outcomeExec = resolveProjectExecution({ slug: project.slug, path: project.path })
            const ticketFile = outcomeExec.relocated
              ? outcomeExec.ticketsPath
              : resolveTicketStoragePath(project.path)
            const now = new Date().toISOString()
            const causallyOwnedTicketIds = completedTicketIds.filter((ticketId) => {
              if (!ownershipReadable) return false
              const owner = ticketOwners.get(ticketId) ?? null
              return owner === jobId || (!callbackCausalOwnership && owner === null)
            })
            const store = mutateStore(ticketFile, (s) => {
              changedTicketIds = applyJobOutcomeToTickets(s, causallyOwnedTicketIds, ticketOutcomeStatus, now, {
                completedStatus,
                effectId: jobId,
                causalOwnerConfirmed: true,
              })
            })
            outcomeStore = store
            effectTicketIds = causallyOwnedTicketIds.filter((ticketId) => {
              const marker = store.tickets[String(ticketId)]?.metadata.specrails_outcome
              return marker?.owner_id === jobId && marker.applied_effect_id === jobId
            })
            for (const tid of changedTicketIds) {
              const ticket = store.tickets[String(tid)]
              if (!ticket) continue
              try {
                boundBroadcast({
                  type: 'ticket_updated',
                  ticket: ticket as unknown as import('./types').LocalTicket,
                  projectId: project.id,
                  timestamp: ticket.updated_at,
                } as TicketUpdatedMessage)
              } catch {
                // The file mutation is authoritative; a startup client reloads it.
              }
            }
          } catch (err) {
            console.error('[project-registry] failed to apply job outcome to tickets:', err)
            criticalFailures.push(`ticket outcome: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // Release the job's tickets from any rail that still holds them. The
        // server `rails` table is the source of truth for mobile clients (the
        // desktop strips its localStorage copy on rail.job_completed) — without
        // this, a finished spec stays stranded on the rail forever. Runs on
        // every terminal outcome, mirroring the desktop: success → spec is
        // done; failure/cancel/zombie → spec returns to the board. Scans ALL
        // rails (not just railMeta.railIndex) so it also heals after a server
        // restart, when the in-memory railJobs map is lost.
        if (
          completedTicketIds.length > 0 &&
          affectsTickets
        ) {
          try {
            const releasableTicketIds = completedTicketIds.filter((ticketId) => {
              if (!ownershipReadable) return false
              const owner = ticketOwners.get(ticketId) ?? null
              return owner === jobId || (!callbackCausalOwnership && owner === null)
            })
            const releasedRails = releaseRailTicketsOwnedBy(db, jobId, releasableTicketIds, {
              railIndex: railMeta?.railIndex ?? null,
              allowUnowned: !callbackCausalOwnership,
            })
            for (const released of releasedRails) {
              const rail = released.rail
              try {
                boundBroadcast({
                  type: 'rail.updated',
                  projectId: project.id,
                  railIndex: rail.railIndex,
                  changed: 'tickets',
                  ticketIds: rail.ticketIds,
                  name: rail.name ?? null,
                  mode: rail.mode,
                  profileName: rail.profileName ?? null,
                  aiEngine: rail.aiEngine ?? null,
                } as RailUpdatedMessage)
              } catch {
                // Persisted rail state is authoritative; WS delivery is advisory.
              }
            }
          } catch (err) {
            console.error('[project-registry] failed to release rail tickets after job exit:', err)
            criticalFailures.push(`rail release: ${err instanceof Error ? err.message : String(err)}`)
          }
        }

        // QueueManager's recovery outbox checkpoints the callback only when it
        // returns normally. Ticket-file and rail mutations are the two critical
        // domain invariants, so surface either failure during a recovery replay.
        // Live exits keep their long-standing best-effort behavior because they
        // have no durable retry owner; they still continue to Jira/webhooks below.
        // Both critical operations are idempotent, so partial replay is safe.
        if (criticalFailures.length > 0 && opts?.recoveryReplay) {
          throw new Error(`critical job outcome effects failed: ${criticalFailures.join('; ')}`)
        }

        // Jira is already backed by its own idempotent durable outbox. Keep it
        // best-effort for this callback: a Jira configuration/network fault must
        // never prevent the local recovery checkpoint.
        if (
          outcomeStore &&
          effectTicketIds.length > 0 &&
          affectsTickets
        ) {
          try {
            if (status === 'completed' && completedStatus === 'on_review') {
              // On a replay after the ticket mutation committed but a later rail
              // mutation failed, changedTicketIds is empty. Derive the intended
              // review set from the converged store so Jira still receives it.
              const reviewIds = effectTicketIds.filter(
                (tid) => outcomeStore?.tickets[String(tid)]?.status === 'on_review'
              )
              jiraSyncManager.onRailReview(reviewIds, jobId)
            } else {
              const needsReviewIds = effectTicketIds.filter(
                (tid) => outcomeStore?.tickets[String(tid)]?.needs_review === true
              )
              jiraSyncManager.onJobOutcome({
                ticketIds: effectTicketIds,
                status: ticketOutcomeStatus,
                    jobId,
                    costUsd: costUsd ?? null,
                    durationMs: effectiveDurationMs,
                needsReviewIds,
              })
            }
          } catch (err) {
            console.error('[project-registry] jira onJobOutcome failed:', err)
          }
        }

        // Webhook delivery is fire-and-forget and non-durable by design. A bad
        // registration/desktop DB must not hold the local recovery outbox open.
        if (status !== 'skipped') {
          try {
            webhookManager.deliver(project.id, event, {
              jobId,
              command: effectiveCommand,
              status,
              costUsd: costUsd ?? null,
              durationMs: effectiveDurationMs,
            })
          } catch (err) {
            console.error('[project-registry] webhook delivery scheduling failed:', err)
          }
        }

        // Broadcast rail.job_completed if we know the rail index
        if (railMeta) {
          try {
            boundBroadcast({
              type: 'rail.job_completed',
              projectId: project.id,
              railIndex: railMeta.railIndex,
              jobId,
              status,
              ticketIds: completedTicketIds,
            })
          } catch {
            // Advisory only; local ticket/rail state already committed.
          }
        }
      },
    })
    const chatManager = new ChatManager(boundBroadcast, db, project.path, project.name, project.provider ?? 'claude', project.id, project.slug)
    const setupManager = new SetupManager(
      boundBroadcast,
      (pid, sid) => setProjectSetupSession(this._desktopDb, pid, sid),
      (pid) => clearProjectSetupSession(this._desktopDb, pid),
      // LOW-2: resolve the per-project DB so phase-4 setup-chat AI turns record
      // an `ai_invocations` row (surface='setup'). Returns null until the project
      // context exists, in which case nothing is recorded (best-effort).
      (pid) => this._contexts.get(pid)?.db ?? null,
    )
    const proposalManager = new ProposalManager(boundBroadcast, db, project.path, project.id)
    const agentRefineManager = new AgentRefineManager(boundBroadcast, db, project.path, project.id, project.provider ?? 'claude')
    // Retention prune: drop stale/abandoned refine sessions on project load.
    try { pruneStaleRefineSessions(db) } catch (err) {
      console.error('[project-registry] prune refine sessions failed:', err)
    }
    const specLauncherManager = new SpecLauncherManager(boundBroadcast, project.path, db, project.id)

    // FileSummaryManager — code-explorer. The class is constructed for every
    // project regardless of the feature flag; the router 404s when the flag
    // is off, so no spawn can occur. Budget reader queries `ai_invocations`
    // for the current calendar month.
    const fileSummaryAdapter = getAdapter(project.provider ?? 'claude')
    const fileSummaryGenerate = createFileSummaryGenerator({ adapter: fileSummaryAdapter, cwd: project.path })
    const fileSummaryManager = new FileSummaryManager({
      db,
      broadcast: boundBroadcast,
      generate: fileSummaryGenerate,
      monthToDateSpend: (projectId: string) => {
        const row = db.prepare(
          `SELECT COALESCE(SUM(total_cost_usd), 0) AS total FROM ai_invocations
           WHERE project_id = ? AND surface = 'file-summary'
             AND started_at >= strftime('%Y-%m-01', 'now')`
        ).get(projectId) as { total: number } | undefined
        return row?.total ?? 0
      },
      monthlyBudgetUsd: () => {
        const raw = getDesktopSetting(this._desktopDb, 'summary_monthly_budget_usd')
        const n = parseFloat(raw ?? '5.00')
        return isNaN(n) ? 5.0 : n
      },
      language: () => {
        const raw = getDesktopSetting(this._desktopDb, 'summary_language')
        return raw === 'es' ? 'es' : 'en'
      },
      providerId: () => fileSummaryAdapter.id,
    })
    // NOTE: the chokidar watcher is NOT attached here. It is only needed to mark
    // already-generated summaries stale, which is irrelevant until the user opens
    // the Code section. Attaching at startup for every project — even ones that
    // never use Code Explorer (the client flag is OFF by default) — added a
    // persistent recursive watcher per project, the source of the fd leak that
    // broke terminals. The watcher is now attached lazily on the first
    // code-explorer request (see code-explorer-router.ts).

    // Load commands for this project. Relocate-artifacts: sr/specrails commands
    // are materialized into the WORKSPACE when the project is relocated; the repo
    // has none, so scanning project.path would find nothing. Resolve the gate so
    // command discovery reads the same tree the rails load (legacy ⇒ repo).
    try {
      const cmdExec = resolveProjectExecution({ slug: project.slug, path: project.path })
      const commandsRoot = cmdExec.relocated && cmdExec.workspaceDir ? cmdExec.workspaceDir : project.path
      const config = getConfig(project.path, db, project.name, commandsRoot)
      queueManager.setCommands(config.commands)
    } catch {
      // Non-fatal: project may not have commands yet
    }

    const ticketWatcher = new TicketWatcher(project.path, project.id, boundBroadcast)
    ticketWatcher.start()
    // Suppress the file-watcher echo for the Jira sync's own writes (the every-60s
    // poll would otherwise trigger a full-board refresh = flicker). Late-bound
    // because the JiraSyncManager is constructed before the watcher.
    jiraSyncManager.setLocalWriteNotifier((rev) => ticketWatcher.notifyDesktopWrite(rev))

    // BrowserCaptureManager — "Add Spec from browser". Constructed for every
    // project regardless of the feature flag; the routes + WS endpoint 404 when
    // the flag is off, and the persistent Chromium context is launched lazily on
    // first session create, so a project that never uses it pays nothing.
    const browserCaptureManager = new BrowserCaptureManager({
      projectId: project.id,
      projectSlug: project.slug,
      db,
      broadcast: boundBroadcast,
      // Share ONE persistent Chromium profile (global cookies/logins) across all
      // projects instead of a per-project profile.
      contextPool: this._browserContextPool,
    })

    // ── Loops engine (the Loops feature) ──────────────────────────────────────
    const railLoopRuns = new Map<string, {
      railIndex: number
      ticketIds: number[]
      requiresTerminalIntent?: boolean
    }>()
    // Capture before runtime construction. The status transition is deliberately
    // delayed until onLoopRunFinished exists so crash recovery replays ticket,
    // rail and Jira invariants instead of bypassing them with raw SQL.
    let orphanLoopRuns: LoopRunRow[] = []
    try { orphanLoopRuns = listActiveLoopRuns(db, project.id) } catch { /* non-fatal */ }
    // Sweep worktrees left behind by a crashed parallel-rail fan-out (no-op +
    // no git calls when isolation was never used). Best-effort, non-blocking.
    void reconcileRailWorktrees(db, project.path)
      .then((n) => { if (n > 0) console.log(`[loops] reconciled ${n} orphan worktree(s) for ${project.slug}`) })
      .catch(() => { /* non-fatal */ })
    // Loop executors resolve their base env LAZILY per step: a RELOCATED project
    // injects core's env-first artifact indirection (tickets/backlog/profiles/
    // state → the workspace) so an ISOLATED worktree run — whose cwd-relative
    // `${ENV:-legacy}` defaults resolve inside the worktree, where only tracked
    // files exist — still reads the real project state. SPECRAILS_REPO_DIR stays
    // per-run (the worktree for isolated runs). Legacy projects keep process.env
    // byte-identical except for the explicit per-project passthrough overlay.
    // See resolveLoopBaseEnv.
    const loopRunManager = new LoopRunManager(db, boundBroadcast, createLoopExecutors({
      env: () => resolveLoopBaseEnv(
        { slug: project.slug, path: project.path },
        undefined,
        applyWorktreeEnvPassthrough(db, process.env),
      ),
    }))

    const getTicketSpec = (ticketId: number): LoopSpec | undefined => {
      try {
        const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
        const ticketFile = exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(project.path)
        const t = readStore(ticketFile).tickets[String(ticketId)]
        if (!t) return undefined
        // Expose every field a loop prompt can reference via `{{spec.*}}`.
        return {
          id: t.id,
          title: t.title,
          description: t.description,
          status: t.status,
          priority: t.priority,
          labels: t.labels,
          jira_key: t.jira_key ?? null,
          jira_url: t.jira_url ?? null,
          openspecChangeName: typeof t.metadata?.openspecChangeName === 'string' ? t.metadata.openspecChangeName : undefined,
          metadata: t.metadata,
        }
      } catch {
        return undefined
      }
    }

    // Releases a finished loop run's tickets + rail slots. The engine already
    // emitted loop.run_completed; this mirrors onJobFinished's ticket/rail
    // release (kept separate so the critical job path is untouched).
    const onLoopRunFinished = (
      runId: string,
      outcome: string,
      opts?: { ticketCompletionStatus?: 'done' | 'on_review' },
    ): void => {
      const intent = getLoopTerminalRecovery(db, runId)
      let payload: LoopTerminalRecoveryPayload | null = null
      if (intent) {
        try {
          const parsed = JSON.parse(intent.payload) as LoopTerminalRecoveryPayload
          if (parsed?.runId !== runId || !Array.isArray(parsed.ticketIds)) {
            throw new Error('loop terminal payload identity is invalid')
          }
          payload = parsed
        } catch (err) {
          console.error(`[loops] invalid terminal recovery payload for ${runId}:`, err)
          return
        }
      }
      const meta = railLoopRuns.get(runId)
      if (!intent && meta?.requiresTerminalIntent) {
        // Current launches atomically settle their run/job/outbox. If there is
        // no outbox, the launch either never committed or failed before the
        // engine acquired terminal authority. Do not release/revert tickets by
        // falling through to the pre-outbox compatibility path.
        if (!getLoopRun(db, runId)) railLoopRuns.delete(runId)
        return
      }
      if (payload && payload.outcomeFinalized === false) {
        const finalizedOutcome = outcome as LoopTerminalRecoveryPayload['outcome']
        payload = {
          ...payload,
          outcome: finalizedOutcome,
          jobStatus: finalizedOutcome === 'success'
            ? 'completed'
            : finalizedOutcome === 'stopped' || finalizedOutcome === 'blocked' || finalizedOutcome === 'stalled'
              ? 'canceled'
              : 'failed',
          outcomeFinalized: true,
        }
        try {
          // Monotonic decision commit precedes effect delivery. A rail/ticket
          // failure may roll back its own transaction, but can never revert a
          // verified isolated result to the conservative startup fallback.
          db.prepare(`UPDATE loop_terminal_recovery SET payload = ? WHERE run_id = ?`)
            .run(JSON.stringify(payload), runId)
        } catch (err) {
          console.error(`[loops] failed to persist final outcome for ${runId}:`, err)
          return
        }
      }
      const ticketIds = payload?.ticketIds ?? meta?.ticketIds ?? []
      const railIndex = payload?.railIndex ?? meta?.railIndex ?? null
      const effectiveOutcome = payload?.outcome ?? outcome
      const status: JobOutcome =
        effectiveOutcome === 'success' ? 'completed'
          : effectiveOutcome === 'stopped' || effectiveOutcome === 'blocked' || effectiveOutcome === 'stalled'
            ? 'canceled'
            : 'failed'
      const completedStatus = payload?.ticketCompletionStatus
        ?? opts?.ticketCompletionStatus
        ?? (isRailPrDeliveryEnabled() ? 'on_review' : 'done')

      try {
        const deliver = db.transaction(() => {
          let changedIds: number[] = []
          let effectTicketIds: number[] = []
          let store: ReturnType<typeof readStore> | null = null
          const causallyOwnedTicketIds = ticketIds.filter((ticketId) => {
            const owner = ticketOutcomeOwner(db, ticketId)
            return owner === runId || (payload?.causalOwnership !== true && owner === null)
          })
          if (causallyOwnedTicketIds.length > 0) {
            store = mutateStore(ticketStorePath(), (s) => {
              changedIds = applyJobOutcomeToTickets(s, causallyOwnedTicketIds, status, new Date().toISOString(), {
                completedStatus,
                effectId: runId,
                causalOwnerConfirmed: true,
              })
            })
            effectTicketIds = causallyOwnedTicketIds.filter((ticketId) => {
              const marker = store?.tickets[String(ticketId)]?.metadata.specrails_outcome
              return marker?.owner_id === runId && marker.applied_effect_id === runId
            })
          }

          const released = releaseRailTicketsOwnedBy(db, runId, causallyOwnedTicketIds, {
            railIndex,
            allowUnowned: payload ? payload.causalOwnership !== true : true,
          })

          // Jira has its own idempotent outbox keyed by runId/ticketId. Only
          // tickets whose causal marker belongs to this run may be enqueued.
          if (store && effectTicketIds.length > 0) {
            try {
              if (status === 'completed' && completedStatus === 'on_review') {
                const reviewIds = effectTicketIds.filter(
                  (ticketId) => store?.tickets[String(ticketId)]?.status === 'on_review',
                )
                jiraSyncManager.onRailReview(reviewIds, runId)
              } else {
                const needsReviewIds = effectTicketIds.filter(
                  (ticketId) => store?.tickets[String(ticketId)]?.needs_review === true,
                )
                jiraSyncManager.onJobOutcome({
                  ticketIds: effectTicketIds,
                  status,
                  jobId: runId,
                  costUsd: null,
                  durationMs: null,
                  needsReviewIds,
                })
              }
            } catch (err) {
              console.error('[project-registry] jira loop onJobOutcome failed:', err)
            }
          }
          if (intent) completeLoopTerminalRecovery(db, runId)
          return { changedIds, store, released }
        })
        const delivered = deliver()
        railLoopRuns.delete(runId)
        for (const ticketId of delivered.changedIds) {
          const ticket = delivered.store?.tickets[String(ticketId)]
          if (!ticket) continue
          try {
            boundBroadcast({
              type: 'ticket_updated',
              ticket: ticket as unknown as TicketUpdatedMessage['ticket'],
              projectId: project.id,
              timestamp: ticket.updated_at,
            } as TicketUpdatedMessage)
          } catch { /* persisted file is authoritative */ }
        }
        for (const released of delivered.released) {
          try {
            boundBroadcast({
              type: 'rail.updated',
              projectId: project.id,
              railIndex: released.rail.railIndex,
              changed: 'tickets',
              ticketIds: released.rail.ticketIds,
              name: released.rail.name ?? null,
              mode: released.rail.mode,
              profileName: released.rail.profileName ?? null,
              aiEngine: released.rail.aiEngine ?? null,
            } as RailUpdatedMessage)
          } catch { /* advisory */ }
        }
      } catch (err) {
        // Durable intents remain pending. Ticket JSON may already contain the
        // effect marker; replay is safe and cannot outrank a later owner.
        console.error(`[loops] terminal effects failed for ${runId}:`, err)
      }
    }

    const ctx: ProjectContext = { project, db, queueManager, chatManager, setupManager, proposalManager, agentRefineManager, fileSummaryManager, specLauncherManager, ticketWatcher, browserCaptureManager, jiraSyncManager, broadcast: boundBroadcast, railJobs, loopRunManager, railLoopRuns, onLoopRunFinished, getTicketSpec, desktopDb: this._desktopDb }
    this._contexts.set(project.id, ctx)
    this._recoverOrphanLoopRuns(project, db, railLoopRuns, onLoopRunFinished, orphanLoopRuns)
    openProjectProcessAdmission(project.id)
    return ctx
  }

  private _recoverOrphanLoopRuns(
    project: ProjectRow,
    db: DbInstance,
    railLoopRuns: Map<string, {
      railIndex: number
      ticketIds: number[]
      requiresTerminalIntent?: boolean
    }>,
    onLoopRunFinished: (runId: string, outcome: string) => void,
    orphans: LoopRunRow[],
  ): void {
    try {
      const recoveredSteps = recoverOrphanLoopStepAccounting(db)
      if (recoveredSteps > 0) {
        console.log(`[loops] recovered ${recoveredSteps} interrupted step invocation(s) for ${project.slug}`)
      }
      const countByRail = new Map<number, number>()
      for (const run of orphans) {
        if (run.rail_index != null) countByRail.set(run.rail_index, (countByRail.get(run.rail_index) ?? 0) + 1)
      }
      const rails = getRails(db)
      const legacyTicketIds = new Map<string, number[]>()
      for (const run of orphans) {
        if (run.rail_index == null) continue
        let persistedIds: number[] = []
        try {
          const parsed = JSON.parse(run.ticket_ids_json ?? '[]') as unknown
          if (Array.isArray(parsed)) {
            persistedIds = parsed.filter((id): id is number => Number.isSafeInteger(id) && id > 0)
          }
        } catch { /* pre-migration malformed value → legacy fallback */ }
        let ticketIds = persistedIds.length > 0
          ? persistedIds
          : (run.ticket_id == null ? [] : [run.ticket_id])
        // Compatibility only for rows launched before migration 45. New rows
        // persist the exact set and never use this ambiguous heuristic.
        if (persistedIds.length === 0 && (countByRail.get(run.rail_index) ?? 0) === 1) {
          const rail = rails.find((candidate) => candidate.railIndex === run.rail_index)
          if (rail && rail.ticketIds.length > 0) ticketIds = [...rail.ticketIds]
        }
        legacyTicketIds.set(run.id, ticketIds)
        railLoopRuns.set(run.id, { railIndex: run.rail_index, ticketIds })
      }
      if (orphans.length > 0) {
        reconcileOrphanLoopRuns(db, new Date().toISOString(), legacyTicketIds)
      }
      // Includes orphan intents created above AND normally-completed runs whose
      // process died after the atomic settle but before its `.then` callback.
      const pending = listPendingLoopTerminalRecoveries(db)
      for (const row of pending) {
        let terminalOutcome = 'failed'
        try {
          terminalOutcome = (JSON.parse(row.payload) as LoopTerminalRecoveryPayload).outcome
        } catch { /* handler logs and retains malformed intent */ }
        onLoopRunFinished(row.run_id, terminalOutcome)
      }
      if (orphans.length > 0) {
        console.log(`[loops] reconciled ${orphans.length} orphan loop run(s) for ${project.slug}`)
      }
    } catch (err) {
      console.error(`[loops] orphan reconciliation failed for ${project.slug}:`, err)
    }
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
