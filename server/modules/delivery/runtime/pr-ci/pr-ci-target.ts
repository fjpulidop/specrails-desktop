import type { DbInstance } from '../../../../db'
import { getPrDelivery } from '../rail-pr-store'
import type { IsolatedSettlementSnapshot } from '../isolated-settlement-store'
import type { PrCiTarget } from './pr-ci-handlers'

/** The built-in loop that watches and fixes a PR's CI (`factory:pr-ci`). */
export const PR_CI_LOOP_ID = 'factory:pr-ci'

/**
 * Resolve the PR a pr-ci run works on from Desktop's FROZEN admission records
 * (the isolated settlement snapshot of the continuation generation), never from
 * workflow input. Null when the run is not a pr-ci continuation of an attached PR.
 */
export function resolvePrCiTarget(db: DbInstance, projectId: string, runId: string): PrCiTarget | null {
  const row = db.prepare('SELECT delivery_id, snapshot_json FROM definition_delivery_settlements WHERE project_id = ? AND run_id = ? AND superseded_by IS NULL')
    .get(projectId, runId) as { delivery_id: string; snapshot_json: string } | undefined
  if (!row) return null
  let snapshot: IsolatedSettlementSnapshot
  try { snapshot = JSON.parse(row.snapshot_json) as IsolatedSettlementSnapshot } catch { return null }
  const delivery = getPrDelivery(db, row.delivery_id)
  const target = snapshot.run?.continuationTarget
  if (!delivery || delivery.loop_id !== PR_CI_LOOP_ID || !target?.prUrl || snapshot.run.runId !== runId) return null
  if (delivery.pr_url && delivery.pr_url !== target.prUrl) return null
  return {
    deliveryId: row.delivery_id,
    runId,
    prUrl: target.prUrl,
    prNumber: target.prNumber,
    branch: target.branch,
    baseBranch: target.baseBranch,
    worktreePath: snapshot.run.handle.worktreePath,
    repoDir: snapshot.baseRepo,
    overlayExcludes: [...(snapshot.run.overlayExcludes ?? [])],
  }
}
