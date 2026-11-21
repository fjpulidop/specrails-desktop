import path from 'node:path'
import type { ProjectContext } from '../../../../project-registry'
import { isLoopsEnabled } from '../../../../feature-flags'
import { newId } from '../../../../ids'
import { getProjectSettings } from '../../../../db'
import { withRepoLock } from '../../../../repo-lock'
import { assertProcessAdmission, ProcessAdmissionClosedError } from '../../../../process-admission'
import { getAdapter } from '../../../../providers'
import { isReasoningEffortValidForModel } from '../../../../providers/runtime'
import type { ReasoningEffort } from '../../../../providers/types'
import { resolveProjectExecution } from '../../../../workspace-resolution'
import { defaultGitRunner } from '../../../../worktree-manager'
import { resolveAgentDefaults } from '../../../agents/runtime/agent-defaults'
import { loadCoreAgentRuntime } from '../../../agent-runtime/runtime/agent-runtime-loader'
import { loadConstantMap } from '../../../loops/runtime/loop-constants'
import { probeDefinitionRun } from '../../../loops/runtime/loop-definition-recovery'
import { PR_CI_LOOP_ID, prCiGraph, supportsPrCi } from '../../../loops/runtime/loop-pr-ci-recipe'
import { getAgentChatManager } from '../../../missions/runtime/agent-chat-registry'
import { isolatedRepositoryTarget, materializeIsolatedWorktree, readHeadSha, resolveOverlaySources } from '../isolated-worktree'
import { isRailPrDeliveryEnabled } from '../rail-isolation'
import { defaultExec } from '../pr-publisher'
import { isPrCiLoopEnabled } from '../../../../feature-flags'
import { getPrCiAdmissionByRun, upsertPrCiAdmission, type PrCiAdmissionRow } from './pr-ci-admission'
import { PrCiResolveError, resolveProjectPrTarget } from './pr-ci-resolver'
import { prCiCapable } from './pr-ci-projection'
import { dismissPrCiAdmissionOffer, startPrCiAdmission, type PrCiStartResult } from './pr-ci-admission-start'
import { projectAdmissionOffer } from './pr-ci-offer'
import { replayPrCiAdmissions, settleAdmissionRun, type PrCiAdmissionSettlementDeps } from './pr-ci-settlement'

/** Wiring of the mission-origin PR CI repair to one project's real git, GitHub and loop engine. */
export interface PrCiAdmissionRuntime {
  /** Persist the host admission of a project PR and show its card; starts nothing. */
  prepare(prUrl: string, originConversationId: string | null): Promise<{ ok: true; admission: PrCiAdmissionRow } | { ok: false; status: number; error: string; detail: string }>
  start(admissionId: string): Promise<PrCiStartResult>
  dismiss(admissionId: string): ReturnType<typeof dismissPrCiAdmissionOffer>
  replay(): Promise<void>
}

export function createPrCiAdmissionRuntime(c: ProjectContext): PrCiAdmissionRuntime {
  const announce = (admission: PrCiAdmissionRow): void => { projectAdmissionOffer(getAgentChatManager(), admission) }
  const settlementDeps: PrCiAdmissionSettlementDeps = {
    db: c.db, git: defaultGitRunner, exec: defaultExec, announce,
    completionOf: async runId => {
      const probe = await probeDefinitionRun({ db: c.db, cwd: c.project.path, env: process.env }, runId)
      return probe.completion ? { ok: probe.completion.ok, reasons: probe.completion.reasons } : null
    },
  }

  const prepareWorktree = async (admission: PrCiAdmissionRow, headSha: string, runId: string): Promise<{ worktreePath: string }> => {
    const target = isolatedRepositoryTarget(c.project, admission.repository_id)
    const fetched = await defaultGitRunner.run(['fetch', '--no-tags', 'origin', `+refs/heads/${admission.head_branch}:refs/remotes/origin/${admission.head_branch}`], admission.repository_path)
    if (fetched.code !== 0) throw new Error(`Could not fetch ${admission.head_branch} from origin: ${fetched.stderr.trim() || `exit ${fetched.code}`}`)
    const provider = c.project.provider ?? 'claude'
    const prepared = await materializeIsolatedWorktree({
      repoDir: admission.repository_path,
      worktreesRoot: path.join(target.worktreesRoot, runId),
      slug: c.project.slug, ticketId: 0,
      baseRef: `refs/remotes/origin/${admission.head_branch}`,
      branch: admission.head_branch, branchOwnership: 'borrowed-pr', pinBranchOwnership: true,
      // An existing local branch is only acceptable when it is exactly the PR head.
      verifyHead: async handle => {
        const head = await readHeadSha(defaultGitRunner, handle.worktreePath)
        if (handle.branch !== admission.head_branch || head !== headSha) throw new Error(`The local ${admission.head_branch} branch is not the pull request head ${headSha.slice(0, 12)}; it was left untouched.`)
        return head
      },
      overlay: resolveOverlaySources({ slug: c.project.slug, baseRepo: admission.repository_path, provider }, target.primary ? undefined : () => resolveProjectExecution(c.project)),
      copyEnvFiles: getProjectSettings(c.db).worktreeEnvFiles,
      onDegraded: warnings => console.warn(`[pr-ci] worktree for ${admission.id} degraded: ${warnings.join('; ')}`),
    })
    return { worktreePath: prepared.worktreePath }
  }

  const launchFor = (capabilities: Record<string, number> | undefined) => (admission: PrCiAdmissionRow, worktreePath: string, runId: string): void => {
    const provider = c.project.provider ?? 'claude'
    const adapter = getAdapter(provider)
    const defaults = resolveAgentDefaults(c.desktopDb, provider)
    const model = defaults?.pipelineModel ?? adapter.defaultModel()
    const effort = defaults?.pipelineEffort && isReasoningEffortValidForModel(adapter, model, defaults.pipelineEffort) ? defaults.pipelineEffort as ReasoningEffort : undefined
    c.loopRunManager.run({
      runId, loopId: PR_CI_LOOP_ID, loopName: 'Fix PR CI', graph: prCiGraph(capabilities), projectId: c.project.id,
      repositoryId: admission.repository_id,
      cwd: worktreePath, repoDir: worktreePath, isolation: { branch: admission.head_branch, worktreePath },
      railIndex: null, ticketId: null, spec: undefined,
      constants: loadConstantMap(c.desktopDb), provider, model, ...(effort ? { effort } : {}),
    })
      .then(result => c.onLoopRunFinished(result.runId, result.outcome, result.stallReason ? { stallReason: result.stallReason } : undefined))
      .catch(error => {
        console.error('[pr-ci] mission-origin run failed:', error)
        c.onLoopRunFinished(runId, 'failed')
      })
      .finally(() => { void settleAdmissionRun(settlementDeps, getPrCiAdmissionByRun(c.db, c.project.id, runId)!).catch(error => console.error('[pr-ci] settlement failed:', error)) })
  }

  const refuse = (status: number, error: string, detail: string): PrCiStartResult => ({ ok: false, status, error, detail })

  return {
    async prepare(prUrl, originConversationId) {
      if (!isPrCiLoopEnabled()) return refuse(403, 'pr_ci_disabled', 'The PR CI loop is turned off (SPECRAILS_PR_CI_LOOP=false)')
      if (!isLoopsEnabled() || !isRailPrDeliveryEnabled() || !await prCiCapable()) return refuse(409, 'engine_unsupported', 'The PR CI loop is unavailable: it needs Loops, PR delivery and a Core with host tasks.')
      if (!originConversationId) return refuse(400, 'origin_conversation_required', 'The offer is shown in a mission; ask from a mission conversation.')
      try {
        const target = await resolveProjectPrTarget({ exec: defaultExec, project: c.project, prUrl, originConversationId })
        const admission = upsertPrCiAdmission(c.db, target)
        if (!projectAdmissionOffer(getAgentChatManager(), admission)) return refuse(409, 'mission_unavailable', 'The mission conversation is not available to show the offer.')
        return { ok: true, admission }
      } catch (error) {
        if (error instanceof PrCiResolveError) return refuse(error.status, error.code, error.message)
        throw error
      }
    },
    async start(admissionId) {
      if (!isPrCiLoopEnabled()) return refuse(403, 'pr_ci_disabled', 'The PR CI loop is turned off (SPECRAILS_PR_CI_LOOP=false)')
      if (!isLoopsEnabled() || !isRailPrDeliveryEnabled()) return refuse(409, 'pr_ci_requires_pr_mode', 'The PR CI loop needs Loops and PR delivery')
      let capabilities: Record<string, number> | undefined
      try { capabilities = (await loadCoreAgentRuntime()).api?.capabilities } catch { /* unsupported below */ }
      if (!supportsPrCi(capabilities)) return refuse(409, 'engine_unsupported', 'Update Core to run the PR CI loop (host tasks).')
      try { assertProcessAdmission(c.project.id) } catch (error) {
        return refuse(error instanceof ProcessAdmissionClosedError ? 409 : 400, 'process_admission_closed', error instanceof Error ? error.message : 'The app is not accepting new work')
      }
      const budget = c.dailyBudgetRejection?.() ?? null
      if (budget) return refuse(409, budget.error, `The ${budget.period ?? 'daily'} spending budget of $${budget.budgetUsd} is reached ($${budget.spentUsd} spent); raise it or wait for the window to roll over.`)
      return startPrCiAdmission({
        db: c.db, project: c.project, exec: defaultExec, withRepositoryLock: withRepoLock, newRunId: newId,
        prepareWorktree, launch: launchFor(capabilities), announce,
      }, admissionId)
    },
    dismiss: admissionId => dismissPrCiAdmissionOffer({ db: c.db, project: c.project, announce }, admissionId),
    replay: () => replayPrCiAdmissions(settlementDeps, c.project.id),
  }
}
