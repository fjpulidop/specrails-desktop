/**
 * Queue and execution wiring for one project.
 *
 * Owns constructing the project's QueueManager (durable admission claims,
 * budget enforcement hooks, terminal-job effects) and loading the project's
 * command catalog into it. The registry supplies the app-wide budget snapshot
 * and the cross-project pause; terminal effects live in
 * `project-context-job-outcome.ts`.
 */
import type { DbInstance } from './db'
import { getDesktopSetting, type ProjectRow } from './desktop-db'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { resolveAgentDefaults } from './modules/agents/runtime/agent-defaults'
import type { ProjectAgentAudit } from './modules/audit/adapters/runtime'
import { claimRailTickets, claimTicketOutcomeOwners, getRails } from './modules/delivery/runtime/rails-store'
import type { CapStatus } from './modules/execution'
import { QueueManager } from './modules/execution/runtime/queue-manager'
import { extractTicketIdsFromCommand } from './modules/specs/runtime/ticket-store'
import { getProjectCommands } from './config'
import { createJobFinishedHandler } from './project-context-job-outcome'
import type { ProjectContext } from './project-registry'
import type { WsMessage } from './types'
import type { WebhookManager } from './webhook-manager'
import { resolveProjectExecution } from './workspace-resolution'

/** Per-project zombie timeout (stored in queue_state). */
export function readProjectZombieTimeout(db: DbInstance): number | undefined {
  let projectZombieTimeout: number | undefined
  try {
    const row = db.prepare(`SELECT value FROM queue_state WHERE key = 'config.zombie_timeout_ms'`).get() as { value: string } | undefined
    if (row) {
      const parsed = parseInt(row.value, 10)
      if (!isNaN(parsed) && parsed > 0) projectZombieTimeout = parsed
    }
  } catch { /* queue_state table may not exist yet */ }
  return projectZombieTimeout
}

export function createProjectQueue(deps: {
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  desktopDb: DbInstance
  desktopPort: number
  zombieTimeoutMs: number | undefined
  agentAudit: ProjectAgentAudit
  webhookManager: WebhookManager
  /** Must exist before the queue: terminal effects enqueue Jira transitions. */
  jiraSyncManager: JiraSyncManager
  railJobs: ProjectContext['railJobs']
  /** App-wide daily budget snapshot shared with the rail/loop admission gate. */
  desktopDailyBudget: () => { budget: number | null; totalSpend: number }
  /** Every cap of this project plus the app-wide ones, with spend. */
  capStatuses: () => CapStatus[]
  /** Enforce the app-wide budget through every per-project queue authority. */
  pauseAllQueuesForDesktopBudget: () => void
}): QueueManager {
  const { project, db, desktopDb, webhookManager } = deps
  return new QueueManager(deps.broadcast, db, undefined, project.path, {
    zombieTimeoutMs: deps.zombieTimeoutMs,
    agentAudit: deps.agentAudit.recorder,
    provider: project.provider ?? 'claude',
    projectId: project.id,
    projectSlug: project.slug,
    desktopPort: deps.desktopPort,
    // Global Specrails Agents defaults — resolved at spawn time from
    // desktop.sqlite so a Settings change applies to the next job without
    // restarting (mirrors the pipelineTelemetryEnabled read-at-spawn rule).
    agentDefaults: (provider) => resolveAgentDefaults(desktopDb, provider),
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
      const val = getDesktopSetting(desktopDb, 'cost_alert_threshold_usd')
      return val != null ? parseFloat(val) : null
    },
    getDesktopDailyBudget: () => deps.desktopDailyBudget(),
    appLedgerDb: desktopDb,
    getPeriodCapBreaches: () => deps.capStatuses().filter((cap) => cap.exhausted && cap.period !== 'day'),
    onBudgetExceeded: (event, data) => {
      if (event === 'desktop_daily_budget_exceeded') {
        deps.pauseAllQueuesForDesktopBudget()
      }
      // Deliver the budget event to this project's subscribed webhooks — the
      // WS broadcast alone never reached webhook subscribers, so a
      // daily_budget_exceeded / desktop_daily_budget_exceeded subscription was
      // dead. (Event names are in the webhook validEvents allow-list.)
      try {
        webhookManager.deliver(project.id, event as Parameters<typeof webhookManager.deliver>[1], data)
      } catch { /* best-effort */ }
    },
    onJobFinished: createJobFinishedHandler({
      project,
      db,
      desktopDb,
      railJobs: deps.railJobs,
      jiraSyncManager: deps.jiraSyncManager,
      webhookManager,
      broadcast: deps.broadcast,
    }),
  })
}

/**
 * Load commands for this project. Relocate-artifacts: sr/specrails commands
 * are materialized into the WORKSPACE when the project is relocated; the repo
 * has none, so scanning project.path would find nothing. Resolve the gate so
 * command discovery reads the same tree the rails load (legacy ⇒ repo).
 */
export function loadProjectCommands(queueManager: QueueManager, project: Pick<ProjectRow, 'slug' | 'path'>): void {
  try {
    const cmdExec = resolveProjectExecution({ slug: project.slug, path: project.path })
    const commandsRoot = cmdExec.relocated && cmdExec.workspaceDir ? cmdExec.workspaceDir : project.path
    // Commands only: no tracker/git subprocess probes on the load path.
    queueManager.setCommands(getProjectCommands(project.path, commandsRoot))
  } catch {
    // Non-fatal: project may not have commands yet
  }
}
