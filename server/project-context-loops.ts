/**
 * Loop engine wiring for one project (the Loops feature).
 *
 * Owns constructing the project's LoopRunManager with its executors (lazy
 * per-step env, profiles, plugin scope), the Core host-task dispatcher and the
 * architect-clarifications publisher. Terminal loop effects live in
 * `project-context-loop-outcome.ts`.
 */
import path from 'path'
import type { DbInstance } from './db'
import { getProjectSettings } from './db'
import type { ProjectRow } from './desktop-db'
import { isPrCiLoopEnabled } from './feature-flags'
import type { JiraSyncManager } from './jira/jira-sync-manager'
import { createLoopProfilePathResolver } from './modules/agents/runtime/agent-defaults'
import { createHostTaskDispatcher } from './modules/agent-runtime/runtime/host-task-dispatcher'
import type { ProjectAgentAudit } from './modules/audit/adapters/runtime'
import { createPrCiHandlers } from './modules/delivery/runtime/pr-ci/pr-ci-handlers'
import { resolvePrCiTargets } from './modules/delivery/runtime/pr-ci/pr-ci-target'
import { defaultExec } from './modules/delivery/runtime/pr-publisher'
import { nodeRunRecordFs, readClarifications } from './modules/delivery/runtime/run-records'
import type { DailyBudgetRejection } from './modules/execution'
import { createLoopExecutors } from './modules/loops/runtime/loop-executors'
import { LoopRunManager } from './modules/loops/runtime/loop-run-manager'
import { createMachineInstalls } from './modules/machine-installs'
import { createProcessInstallRunner } from './modules/machine-installs/adapters/process'
import { createSqliteApprovalStore } from './modules/machine-installs/adapters/sqlite'
import { applyWorktreeEnvPassthrough, resolveProjectAgentEnv, worktreeEnvPassthroughWarning } from './project-env'
import { projectSupportsProfiles } from './project-profile-support'
import { resolveProjectRepository } from './project-repositories'
import type { ProjectContext } from './project-registry'
import { cancelDefinitionRun } from './project-router-loop-runs'
import { withRepoLock } from './repo-lock'
import type { WsMessage } from './types'
import { resolveLoopBaseEnv, resolveProjectExecution } from './workspace-resolution'
import { defaultGitRunner } from './worktree-manager'

export type RunClarificationsPublisher = (runId: string, ticketIds: readonly number[]) => void

/**
 * Architect clarifications (feedback-2026-10 task 3.2): after a Core
 * invocation pauses or ends, post the run's clarifications record to the
 * linked Jira issues when the project opted in. Core writes no record
 * without `architectClarifications: 1`, so older Cores never post.
 */
export function createRunClarificationsPublisher(deps: {
  project: ProjectRow
  db: DbInstance
  jiraSyncManager: JiraSyncManager
}): RunClarificationsPublisher {
  const { project, db, jiraSyncManager } = deps
  return (runId: string, ticketIds: readonly number[]): void => {
    if (ticketIds.length === 0 || !getProjectSettings(db).jiraPostClarifications || !jiraSyncManager.isActive()) return
    try {
      const runtimeDir = path.join(resolveProjectExecution(project).specrailsDir, 'pipeline', runId)
      const record = readClarifications(runtimeDir, nodeRunRecordFs)
      if (record) jiraSyncManager.onRunClarifications(runId, ticketIds, record)
    } catch (err) {
      console.error(`[jira-sync] clarifications for ${runId} failed:`, err)
    }
  }
}

/**
 * Loop executors resolve their base env LAZILY per step: a RELOCATED project
 * injects core's env-first artifact indirection (tickets/backlog/profiles/
 * state → the workspace) so an ISOLATED worktree run — whose cwd-relative
 * `${ENV:-legacy}` defaults resolve inside the worktree, where only tracked
 * files exist — still reads the real project state. SPECRAILS_REPO_DIR stays
 * per-run (the worktree for isolated runs). Legacy projects keep process.env
 * byte-identical except for the explicit per-project passthrough overlay.
 * See resolveLoopBaseEnv.
 */
export function createProjectLoopRuntime(deps: {
  project: ProjectRow
  db: DbInstance
  broadcast: (msg: WsMessage) => void
  desktopDb: DbInstance
  agentAudit: ProjectAgentAudit
  dailyBudgetRejection: () => DailyBudgetRejection | null
  runCapDefault: () => number | null
  publishRunClarifications: RunClarificationsPublisher
  /** The project context exists only after its managers; late-bound for callbacks. */
  getProjectContext: () => ProjectContext | null
}): LoopRunManager {
  const { project, db, publishRunClarifications } = deps
  const machineInstalls = createMachineInstalls({ store: createSqliteApprovalStore(deps.desktopDb), runner: createProcessInstallRunner() })
  const loopRunManager = new LoopRunManager(db, deps.broadcast, createLoopExecutors({
    pluginScope: () => ({ stateRoot: resolveProjectExecution(project).cwd, legacyProviderId: project.provider }),
    // A project registered as a package of a larger checkout scopes Core to that package in isolated worktrees.
    sourcePath: () => resolveProjectRepository(project).path,
    workspacePaths: () => { const primary = resolveProjectRepository(project); return primary.workspacePaths ?? (primary.workspacePath ? [primary.workspacePath] : undefined) },
    // `minimal` agent environment: the step's provider names ride along.
    env: (providerAllowlist) => resolveLoopBaseEnv(
      { slug: project.slug, path: project.path },
      undefined,
      resolveProjectAgentEnv(db, { providerAllowlist }),
    ),
    // One value-free run-log line when configured names are unresolved.
    environmentNotice: () => worktreeEnvPassthroughWarning(db, applyWorktreeEnvPassthrough(db, process.env)),
    // Phase-3 project switches Core reads from its config (capability-gated in the bridge).
    projectRuntime: () => ({ baselineOnTouch: getProjectSettings(db).baselineOnTouch }),
    // Named rail profiles and global per-agent defaults ride the same
    // SPECRAILS_PROFILE_PATH snapshot in both AI transports. An explicit null
    // rail selection opts out; omitted selections keep Core's default rules.
    profilePathFor: createLoopProfilePathResolver({
      desktopDb: deps.desktopDb,
      profileRoot: () => resolveProjectExecution({ slug: project.slug, path: project.path }).cwd,
      supportsProfiles: projectSupportsProfiles,
    }),
  }), undefined, { dailyBudget: deps.dailyBudgetRejection, runCapDefault: deps.runCapDefault, agentAudit: deps.agentAudit.recorder, onDefinitionInvocationEnd: (runId, ticketIds) => publishRunClarifications(runId, ticketIds),
    // Core machine interrupts (pr-ci-loop): one dispatcher per project, with the PR handlers bound to this project's records.
    hostTasks: () => hostTaskDispatcher,
    // Machine-wide installs a run asks for: approvals live in the app database (machine-wide, like the tool).
    machineInstalls: () => machineInstalls,
    // Stop on a paused/recovered Core run: Core records it, Desktop settles it.
    cancelRetained: runId => {
      const projectContext = deps.getProjectContext()
      if (!projectContext) return
      void cancelDefinitionRun(projectContext, runId).catch(error => console.error(`[loop-run] cancellation of ${runId} was rejected:`, error instanceof Error ? error.message : String(error)))
    } })
  // Order: created after the manager; the `hostTasks` getter above reads it lazily.
  const hostTaskDispatcher = createHostTaskDispatcher({ db, projectId: project.id, handlers: isPrCiLoopEnabled() ? createPrCiHandlers({
    exec: defaultExec, git: defaultGitRunner,
    resolveTargets: (runId) => resolvePrCiTargets(db, project.id, runId),
    withRepositoryLock: (repoDir, fn) => withRepoLock(repoDir, fn),
  }) : {} })
  return loopRunManager
}
