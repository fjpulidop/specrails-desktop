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
import { mirrorProjectEntry, removeRegistryEntry, reconcileFromProjects, resolveArtifacts, resolveHome } from './artifact-registry'
import { resolveProjectExecution } from './workspace-resolution'
import { removeWorkspace } from './workspace-manager'
import { resolveTicketStoragePath, mutateStore, applyJobOutcomeToTickets, readStore, type JobOutcome } from './ticket-store'
import { JiraSyncManager } from './jira/jira-sync-manager'
import { LoopRunManager } from './loop-run-manager'
import { createLoopExecutors } from './loop-executors'
import { reconcileRailWorktrees } from './rail-isolated-launch'
import { reconcileOrphanLoopRuns } from './loop-runs-store'
import type { LoopSpec } from './loop-graph'
import type { WsMessage, TicketUpdatedMessage, RailUpdatedMessage } from './types'
import { getRails, setRailTickets } from './rails-store'
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
  broadcast: (msg: WsMessage) => void
  /** Maps jobId → rail metadata for active rail-launched jobs */
  railJobs: Map<string, { railIndex: number; mode: string; ticketIds: number[] }>
  // ── Loops (the Loops feature) ──────────────────────────────────────────────
  /** App-driven loop engine for this project (Loops mode rails). */
  loopRunManager: LoopRunManager
  /** Maps loopRunId → rail metadata for active rail-launched loop runs. */
  railLoopRuns: Map<string, { railIndex: number; ticketIds: number[] }>
  /** Completion handler for a loop run: releases its tickets + rail slots,
   *  mapping the loop outcome to a ticket outcome. The engine already emits the
   *  loop.run_completed event. */
  onLoopRunFinished: (runId: string, outcome: string) => void
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
    // Mirror the new project into the shared artifact registry so specrails-core
    // resolves its relocated artifacts. Wrapped so a registry write failure never
    // breaks project creation — the startup reconcile will recreate the entry.
    try {
      mirrorProjectEntry({
        repoPath: row.path,
        slug: row.slug,
        providers: row.providers,
        primaryProvider: row.provider,
        desktopProjectId: row.id,
      })
    } catch (err) {
      console.error('[project-registry] registry mirror failed (non-fatal):', err)
    }
    return this._loadProjectContext(row)
  }

  removeProject(id: string): void {
    // Resolve the repo path BEFORE the DB row is deleted below so we can drop the
    // shared artifact-registry entry. Prefer the live context, fall back to the
    // desktop DB row (project may be registered-but-not-loaded, e.g. M9 failure).
    const repoPath = this._contexts.get(id)?.project.path ?? getProject(this._desktopDb, id)?.path
    const ctx = this._contexts.get(id)
    if (ctx) {
      // Tear down spawners BEFORE closing the DB. QueueManager.shutdown() drops
      // its DB handle so a late child 'close' can't run prepared statements on
      // the closed connection (which would crash the app) and terminates any
      // orphaned rail child + dangling zombie timer. ChatManager.shutdown()
      // kills in-flight chat/Explore children and clears their idle timers.
      // SetupManager.abort() stops the 3s install poll and kills install/enrich
      // children. All are idempotent no-ops when nothing is running.
      try { ctx.queueManager.shutdown() } catch { /* ignore */ }
      try { ctx.chatManager.shutdown() } catch { /* ignore */ }
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
      // B54: remove the ENTIRE app-managed data dir for this project, not just
      // the telemetry subdir. It also holds user-mcp.json (a copy of the user's
      // MCP config that can contain API keys), profile snapshots, codex-home, and
      // terminal shim dirs — all secret-bearing residue that previously survived
      // project removal. Guard on a non-empty slug so we never rm the projects/
      // root itself.
      try {
        const slug = ctx.project.slug
        if (slug && slug.trim() && !slug.includes('/') && !slug.includes('..')) {
          const projectDir = path.join(os.homedir(), '.specrails', 'projects', slug)
          if (fs.existsSync(projectDir)) {
            fs.rmSync(projectDir, { recursive: true, force: true })
          }
        }
      } catch { /* ignore — non-fatal */ }
      this._contexts.delete(id)
    }
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
    const TERMINAL_JOB_STATUSES = new Set(['completed', 'failed', 'canceled'])
    const boundBroadcast = (msg: WsMessage): void => {
      const enriched = { ...msg, projectId: project.id }
      this._broadcast(enriched as WsMessage)
      if (msg.type === 'queue') {
        for (const job of msg.jobs) {
          if (TERMINAL_JOB_STATUSES.has(job.status)) {
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
        // Deliver the budget event to this project's subscribed webhooks — the
        // WS broadcast alone never reached webhook subscribers, so a
        // daily_budget_exceeded / desktop_daily_budget_exceeded subscription was
        // dead. (Event names are in the webhook validEvents allow-list.)
        try {
          webhookManager.deliver(project.id, event as Parameters<typeof webhookManager.deliver>[1], data)
        } catch { /* best-effort */ }
      },
      onJobFinished: (jobId, status, costUsd) => {
        const jobRow = db.prepare('SELECT command, duration_ms FROM jobs WHERE id = ?').get(jobId) as
          | { command: string; duration_ms: number | null }
          | undefined
        const event = status === 'completed' ? 'job.completed' : status === 'canceled' ? 'job.canceled' : 'job.failed'
        webhookManager.deliver(project.id, event, {
          jobId,
          command: jobRow?.command ?? '',
          status,
          costUsd: costUsd ?? null,
          durationMs: jobRow?.duration_ms ?? null,
        })
        // Broadcast rail.job_completed if this job was launched by a rail
        const railMeta = railJobs.get(jobId)
        if (railMeta) {
          railJobs.delete(jobId)
        }

        // Determine ticket IDs: from rail metadata, or parse from command as fallback
        // (railJobs Map is in-memory and lost on server restart)
        let completedTicketIds: number[] = railMeta?.ticketIds ?? []
        if (completedTicketIds.length === 0 && jobRow?.command) {
          const matches = jobRow.command.match(/#(\d+)/g)
          if (matches) completedTicketIds = matches.map((m) => parseInt(m.slice(1), 10))
        }

        // Apply the job outcome to its tickets. Success promotes todo/in_progress
        // → done (→ Specs Done); failure/cancel/zombie reverts in_progress → todo
        // (→ Specs) or flags an already-done spec for review. zombie_terminated is
        // treated as a failure here (and is included in the _onJobExit callback
        // guard) so a timed-out rail releases its specs instead of stranding them.
        if (
          completedTicketIds.length > 0 &&
          (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'zombie_terminated')
        ) {
          try {
            // Relocate-artifacts gate: write the job outcome to the workspace
            // ticket store when relocated, else the repo-relative store (legacy).
            const outcomeExec = resolveProjectExecution({ slug: project.slug, path: project.path })
            const ticketFile = outcomeExec.relocated
              ? outcomeExec.ticketsPath
              : resolveTicketStoragePath(project.path)
            const now = new Date().toISOString()
            let changedIds: number[] = []
            const store = mutateStore(ticketFile, (s) => {
              changedIds = applyJobOutcomeToTickets(s, completedTicketIds, status as JobOutcome, now)
            })
            for (const tid of changedIds) {
              const ticket = store.tickets[String(tid)]
              if (!ticket) continue
              boundBroadcast({
                type: 'ticket_updated',
                ticket: ticket as unknown as import('./types').LocalTicket,
                projectId: project.id,
                timestamp: ticket.updated_at,
              } as TicketUpdatedMessage)
            }
            // Jira write-back (inert for non-Jira projects): enqueue the status
            // transition + completion comment per linked ticket. The LOCAL mutation
            // above stays synchronous; only the durable outbox enqueue happens here,
            // wrapped so a Jira failure can never break the job-exit handler.
            if (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'zombie_terminated') {
              try {
                const needsReviewIds = completedTicketIds.filter(
                  (tid) => store.tickets[String(tid)]?.needs_review === true
                )
                jiraSyncManager.onJobOutcome({
                  ticketIds: completedTicketIds,
                  status,
                  jobId,
                  costUsd: costUsd ?? null,
                  durationMs: jobRow?.duration_ms ?? null,
                  needsReviewIds,
                })
              } catch (err) {
                console.error('[project-registry] jira onJobOutcome failed:', err)
              }
            }
          } catch (err) {
            console.error('[project-registry] failed to apply job outcome to tickets:', err)
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
          (status === 'completed' || status === 'failed' || status === 'canceled' || status === 'zombie_terminated')
        ) {
          try {
            for (const rail of getRails(db)) {
              const remaining = rail.ticketIds.filter((id) => !completedTicketIds.includes(id))
              if (remaining.length === rail.ticketIds.length) continue
              setRailTickets(db, rail.railIndex, remaining, rail.mode, rail.profileName, rail.aiEngine)
              boundBroadcast({
                type: 'rail.updated',
                projectId: project.id,
                railIndex: rail.railIndex,
                changed: 'tickets',
                ticketIds: remaining,
                name: rail.name ?? null,
                mode: rail.mode,
                profileName: rail.profileName ?? null,
                aiEngine: rail.aiEngine ?? null,
              } as RailUpdatedMessage)
            }
          } catch (err) {
            console.error('[project-registry] failed to release rail tickets after job exit:', err)
          }
        }

        // Broadcast rail.job_completed if we know the rail index
        if (railMeta) {
          boundBroadcast({
            type: 'rail.job_completed',
            projectId: project.id,
            railIndex: railMeta.railIndex,
            jobId,
            status,
            ticketIds: completedTicketIds,
          })
        }
      },
    })
    const chatManager = new ChatManager(boundBroadcast, db, project.path, project.name, project.provider ?? 'claude', project.id, project.slug)
    const setupManager = new SetupManager(
      boundBroadcast,
      (pid, sid) => setProjectSetupSession(this._desktopDb, pid, sid),
      (pid) => clearProjectSetupSession(this._desktopDb, pid)
    )
    const proposalManager = new ProposalManager(boundBroadcast, db, project.path)
    const agentRefineManager = new AgentRefineManager(boundBroadcast, db, project.path, project.id, project.provider ?? 'claude')
    // Retention prune: drop stale/abandoned refine sessions on project load.
    try { pruneStaleRefineSessions(db) } catch (err) {
      console.error('[project-registry] prune refine sessions failed:', err)
    }
    const specLauncherManager = new SpecLauncherManager(boundBroadcast, project.path)

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
    const railLoopRuns = new Map<string, { railIndex: number; ticketIds: number[] }>()
    // A restart kills any in-flight loop process, so reconcile orphan 'running'
    // rows to terminal — otherwise they keep the loop un-editable (isRunning 409).
    try {
      const orphans = reconcileOrphanLoopRuns(db, new Date().toISOString())
      if (orphans > 0) console.log(`[loops] reconciled ${orphans} orphan loop run(s) for ${project.slug}`)
    } catch { /* non-fatal */ }
    // Sweep worktrees left behind by a crashed parallel-rail fan-out (no-op +
    // no git calls when isolation was never used). Best-effort, non-blocking.
    void reconcileRailWorktrees(db, project.path)
      .then((n) => { if (n > 0) console.log(`[loops] reconciled ${n} orphan worktree(s) for ${project.slug}`) })
      .catch(() => { /* non-fatal */ })
    const loopRunManager = new LoopRunManager(db, boundBroadcast, createLoopExecutors())

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
        }
      } catch {
        return undefined
      }
    }

    // Releases a finished loop run's tickets + rail slots. The engine already
    // emitted loop.run_completed; this mirrors onJobFinished's ticket/rail
    // release (kept separate so the critical job path is untouched).
    const onLoopRunFinished = (runId: string, outcome: string): void => {
      const meta = railLoopRuns.get(runId)
      if (!meta) return
      railLoopRuns.delete(runId)
      const ticketIds = meta.ticketIds
      if (ticketIds.length === 0) return
      const status: JobOutcome =
        outcome === 'success' ? 'completed' : outcome === 'stopped' ? 'canceled' : 'failed'
      try {
        const exec = resolveProjectExecution({ slug: project.slug, path: project.path })
        const ticketFile = exec.relocated ? exec.ticketsPath : resolveTicketStoragePath(project.path)
        const now = new Date().toISOString()
        let changedIds: number[] = []
        const store = mutateStore(ticketFile, (s) => {
          changedIds = applyJobOutcomeToTickets(s, ticketIds, status, now)
        })
        for (const tid of changedIds) {
          const ticket = store.tickets[String(tid)]
          if (!ticket) continue
          boundBroadcast({
            type: 'ticket_updated',
            ticket: ticket as unknown as TicketUpdatedMessage['ticket'],
            projectId: project.id,
            timestamp: ticket.updated_at,
          } as TicketUpdatedMessage)
        }
        try {
          const needsReviewIds = ticketIds.filter((tid) => store.tickets[String(tid)]?.needs_review === true)
          jiraSyncManager.onJobOutcome({ ticketIds, status, jobId: runId, costUsd: null, durationMs: null, needsReviewIds })
        } catch (err) {
          console.error('[project-registry] jira loop onJobOutcome failed:', err)
        }
      } catch (err) {
        console.error('[project-registry] failed to apply loop outcome to tickets:', err)
      }
      try {
        for (const rail of getRails(db)) {
          const remaining = rail.ticketIds.filter((id) => !ticketIds.includes(id))
          if (remaining.length === rail.ticketIds.length) continue
          setRailTickets(db, rail.railIndex, remaining, rail.mode, rail.profileName, rail.aiEngine)
          boundBroadcast({
            type: 'rail.updated',
            projectId: project.id,
            railIndex: rail.railIndex,
            changed: 'tickets',
            ticketIds: remaining,
            name: rail.name ?? null,
            mode: rail.mode,
            profileName: rail.profileName ?? null,
            aiEngine: rail.aiEngine ?? null,
          } as RailUpdatedMessage)
        }
      } catch (err) {
        console.error('[project-registry] failed to release rail tickets after loop run:', err)
      }
    }

    const ctx: ProjectContext = { project, db, queueManager, chatManager, setupManager, proposalManager, agentRefineManager, fileSummaryManager, specLauncherManager, ticketWatcher, browserCaptureManager, jiraSyncManager, broadcast: boundBroadcast, railJobs, loopRunManager, railLoopRuns, onLoopRunFinished, getTicketSpec, desktopDb: this._desktopDb }
    this._contexts.set(project.id, ctx)
    return ctx
  }
}
