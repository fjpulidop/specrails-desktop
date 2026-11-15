import type { DbInstance } from '../../../../db'
import type { RepositoryProject } from '../../../../project-repositories'
import type { Exec } from '../pr-publisher'
import {
  claimPrCiAdmission, dismissPrCiAdmission, findBuildingDeliveryForPr, getPrCiAdmission, releasePrCiAdmission, setPrCiAdmissionWorktree,
  type PrCiAdmissionRow,
} from './pr-ci-admission'
import { PrCiResolveError, resolveProjectPrTarget } from './pr-ci-resolver'

export type PrCiStartResult =
  | { ok: true; admission: PrCiAdmissionRow; runId: string }
  | { ok: false; status: number; error: string; detail: string; runId?: string }

export interface PrCiStartDeps {
  db: DbInstance
  project: RepositoryProject
  exec: Exec
  withRepositoryLock<T>(repoDir: string, fn: () => Promise<T>): Promise<T>
  newRunId(): string
  /** Mount an isolated worktree on the PR head; throws when it cannot be proven to be exactly `headSha`. */
  prepareWorktree(admission: PrCiAdmissionRow, headSha: string, runId: string): Promise<{ worktreePath: string }>
  /** Start the canonical `factory:pr-ci` run in that worktree; it settles the admission itself. */
  launch(admission: PrCiAdmissionRow, worktreePath: string, runId: string): void
  /** Re-project the card after every state change. */
  announce(admission: PrCiAdmissionRow): void
  now?: () => number
}

const refuse = (status: number, error: string, detail: string, runId?: string): PrCiStartResult => ({ ok: false, status, error, detail, ...(runId ? { runId } : {}) })

/**
 * "Start" on a mission-origin offer. Everything that decides what runs comes
 * from the persisted admission and a fresh GitHub observation; the repository
 * lock serializes this with delivery-backed starts, and the SQL claim makes a
 * double click lose cleanly. Nothing is claimed, mounted or pushed unless the
 * PR is still the open same-repository PR that was offered.
 */
export async function startPrCiAdmission(deps: PrCiStartDeps, admissionId: string): Promise<PrCiStartResult> {
  const offered = getPrCiAdmission(deps.db, deps.project.id, admissionId)
  if (!offered) return refuse(404, 'pr_ci_admission_not_found', 'This CI repair offer no longer exists.')
  return deps.withRepositoryLock(offered.repository_path, async () => {
    const admission = getPrCiAdmission(deps.db, deps.project.id, admissionId)
    if (!admission) return refuse(404, 'pr_ci_admission_not_found', 'This CI repair offer no longer exists.')
    if (admission.state === 'started') return refuse(409, 'pr_ci_already_running', 'A CI repair is already running for this pull request.', admission.run_id ?? undefined)
    if (admission.state === 'dismissed') return refuse(409, 'pr_ci_offer_dismissed', 'This offer was dismissed; ask for it again to repair the pull request.')
    const building = findBuildingDeliveryForPr(deps.db, admission.pr_url)
    if (building) return refuse(409, 'pr_ci_run_active', `Another run is already working on this pull request (delivery ${building.id}).`)

    let validated
    try {
      validated = await resolveProjectPrTarget({ exec: deps.exec, project: deps.project, prUrl: admission.pr_url })
    } catch (error) {
      if (error instanceof PrCiResolveError) return refuse(error.status, error.code, error.message)
      throw error
    }
    if (validated.repositoryId !== admission.repository_id || validated.headBranch !== admission.head_branch || validated.baseBranch !== admission.base_branch) {
      return refuse(409, 'pr_changed', `The pull request changed since it was offered (now ${validated.headBranch} → ${validated.baseBranch}); ask for the offer again. Nothing was started or pushed.`)
    }
    const headSha = validated.headSha
    if (!headSha) return refuse(409, 'target_pr_invalid', 'GitHub did not expose the pull request head commit.')

    const runId = deps.newRunId()
    if (!claimPrCiAdmission(deps.db, deps.project.id, admission.id, runId, deps.now)) {
      return refuse(409, 'pr_ci_already_running', 'A CI repair is already running for this pull request.', getPrCiAdmission(deps.db, deps.project.id, admission.id)?.run_id ?? undefined)
    }
    try {
      const { worktreePath } = await deps.prepareWorktree(admission, headSha, runId)
      setPrCiAdmissionWorktree(deps.db, admission.id, worktreePath)
      const started = getPrCiAdmission(deps.db, deps.project.id, admission.id)!
      deps.announce(started)
      deps.launch(started, worktreePath, runId)
      return { ok: true, admission: started, runId }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      releasePrCiAdmission(deps.db, admission.id, `The CI repair could not start: ${reason}`, deps.now)
      deps.announce(getPrCiAdmission(deps.db, deps.project.id, admission.id)!)
      return refuse(409, 'isolation_failed', reason)
    }
  })
}

/** "Not now": persisted on the admission and its card. */
export function dismissPrCiAdmissionOffer(deps: Pick<PrCiStartDeps, 'db' | 'project' | 'announce' | 'now'>, admissionId: string): PrCiStartResult | { ok: true; admission: PrCiAdmissionRow } {
  const admission = getPrCiAdmission(deps.db, deps.project.id, admissionId)
  if (!admission) return refuse(404, 'pr_ci_admission_not_found', 'This CI repair offer no longer exists.')
  if (!dismissPrCiAdmission(deps.db, deps.project.id, admissionId, deps.now)) return refuse(409, 'pr_ci_offer_not_pending', 'Only an offer that has not started can be dismissed.')
  const dismissed = getPrCiAdmission(deps.db, deps.project.id, admissionId)!
  deps.announce(dismissed)
  return { ok: true, admission: dismissed }
}
