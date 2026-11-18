/**
 * Interactive per-project managers: conversations, setup, spec authoring,
 * code-explorer summaries, the ticket file watcher and browser capture.
 *
 * Each factory takes only the inputs its managers need and returns what it
 * created; `project-registry.ts` calls them in construction order and owns
 * their teardown (see `removeProject` / `shutdown`).
 */
import type { DbInstance } from './db'
import { clearProjectSetupSession, getDesktopSetting, setProjectSetupSession, type ProjectRow } from './desktop-db'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { AgentRefineManager } from './modules/agents/runtime/agent-refine-manager'
import { pruneStaleRefineSessions } from './modules/agents/runtime/agent-refine-db'
import { corePhase3Capabilities } from './modules/agent-runtime/runtime/core-capabilities'
import { BrowserCaptureManager } from './modules/browser/runtime/browser-capture-manager'
import type { SharedBrowserContextPool } from './modules/browser/runtime/browser-context-pool'
import { createFileSummaryGenerator } from './modules/code/runtime/file-summary-generator'
import { FileSummaryManager } from './modules/code/runtime/file-summary-manager'
import { ChatManager } from './modules/conversations/runtime/chat-manager'
import { rulesInventoryRuns } from './modules/project-rules/runtime/rules-inventory-runs'
import { ProposalManager } from './modules/specs/runtime/proposal-manager'
import { SpecLauncherManager } from './modules/specs/runtime/spec-launcher-manager'
import { TicketWatcher } from './modules/specs/runtime/ticket-watcher'
import { getProjectRepositories } from './project-repositories'
import type { ProjectContext } from './project-registry'
import { getAdapter } from './providers'
import { SetupManager } from './setup-manager'
import type { WsMessage } from './types'
import { logRejection } from './util/log-rejection'

export interface ProjectAuthoringManagers {
  chatManager: ChatManager
  setupManager: SetupManager
  proposalManager: ProposalManager
  agentRefineManager: AgentRefineManager
  specLauncherManager: SpecLauncherManager
}

/** Chat, setup wizard, proposals, agent refine and spec launcher. */
export function createProjectAuthoringManagers(deps: {
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  desktopDb: DbInstance
  /** Live registry lookup: setup callbacks resolve contexts by project id. */
  getContext: (projectId: string) => ProjectContext | undefined
}): ProjectAuthoringManagers {
  const { project, db, broadcast: boundBroadcast, desktopDb } = deps
  const chatManager = new ChatManager(boundBroadcast, db, project.path, project.name, project.provider ?? 'claude', project.id, project.slug, () => getProjectRepositories(project))
  const setupManager = new SetupManager(
    boundBroadcast,
    (pid, sid) => setProjectSetupSession(desktopDb, pid, sid),
    (pid) => clearProjectSetupSession(desktopDb, pid),
    // LOW-2: resolve the per-project DB so phase-4 setup-chat AI turns record
    // an `ai_invocations` row (surface='setup'). Returns null until the project
    // context exists, in which case nothing is recorded (best-effort).
    (pid) => deps.getContext(pid)?.db ?? null,
    // After a setup succeeded, run Core's rules inventory once in the
    // background (gated on Core `rulesInventory`; idempotent; a failure is
    // logged and shown in the project's rules panel). Never blocks setup.
    (pid) => {
      const target = deps.getContext(pid)?.project
      if (!target) return
      void rulesInventoryRuns.runAfterSetup(
        { id: target.id, slug: target.slug, path: target.path },
        async () => (await corePhase3Capabilities()).rulesInventory,
      ).catch(logRejection('rules inventory after setup'))
    },
  )
  const proposalManager = new ProposalManager(
    boundBroadcast,
    db,
    project.path,
    project.id,
    project.provider ?? 'claude',
    project.slug,
  )
  const agentRefineManager = new AgentRefineManager(boundBroadcast, db, project.path, project.id, project.provider ?? 'claude')
  // Retention prune: drop stale/abandoned refine sessions on project load.
  try { pruneStaleRefineSessions(db) } catch (err) {
    console.error('[project-registry] prune refine sessions failed:', err)
  }
  const specLauncherManager = new SpecLauncherManager(
    boundBroadcast,
    project.path,
    db,
    project.id,
    project.provider ?? 'claude',
    project.slug,
  )
  return { chatManager, setupManager, proposalManager, agentRefineManager, specLauncherManager }
}

/**
 * FileSummaryManager — code-explorer. The class is constructed for every
 * project regardless of the feature flag; the router 404s when the flag
 * is off, so no spawn can occur. Budget reader queries `ai_invocations`
 * for the current calendar month.
 */
export function createProjectFileSummaryManager(deps: {
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  desktopDb: DbInstance
}): FileSummaryManager {
  const { project, db, broadcast: boundBroadcast, desktopDb } = deps
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
      const raw = getDesktopSetting(desktopDb, 'summary_monthly_budget_usd')
      const n = parseFloat(raw ?? '5.00')
      return isNaN(n) ? 5.0 : n
    },
    language: () => {
      const raw = getDesktopSetting(desktopDb, 'summary_language')
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
  return fileSummaryManager
}

/** Start the ticket file watcher. Order: JiraSyncManager already exists. */
export function startProjectTicketWatcher(deps: {
  project: ProjectRow
  broadcast: (msg: WsMessage) => void
  jiraSyncManager: JiraSyncManager
}): TicketWatcher {
  const ticketWatcher = new TicketWatcher(deps.project.path, deps.project.id, deps.broadcast)
  ticketWatcher.start()
  // Suppress the file-watcher echo for the Jira sync's own writes (the every-60s
  // poll would otherwise trigger a full-board refresh = flicker). Late-bound
  // because the JiraSyncManager is constructed before the watcher.
  deps.jiraSyncManager.setLocalWriteNotifier((rev) => ticketWatcher.notifyDesktopWrite(rev))
  return ticketWatcher
}

/**
 * BrowserCaptureManager — "Add Spec from browser". Constructed for every
 * project regardless of the feature flag; the routes + WS endpoint 404 when
 * the flag is off, and the persistent Chromium context is launched lazily on
 * first session create, so a project that never uses it pays nothing.
 */
export function createProjectBrowserCapture(deps: {
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  contextPool: SharedBrowserContextPool
}): BrowserCaptureManager {
  return new BrowserCaptureManager({
    projectId: deps.project.id,
    projectSlug: deps.project.slug,
    db: deps.db,
    broadcast: deps.broadcast,
    // Share ONE persistent Chromium profile (global cookies/logins) across all
    // projects instead of a per-project profile.
    contextPool: deps.contextPool,
  })
}
