import path from 'node:path'
import type { DbInstance } from '../../../../db'
import { getPrDelivery } from '../rail-pr-store'
import type { IsolatedSettlementSnapshot } from '../isolated-settlement-store'
import type { PrCiTarget } from './pr-ci-handlers'

/** The built-in loop that watches and fixes a PR's CI (`factory:pr-ci`). */
export const PR_CI_LOOP_ID = 'factory:pr-ci'

/**
 * Resolve the PRs a pr-ci run works on from Desktop's FROZEN admission records
 * (the isolated settlement snapshots of the continuation generation), never from
 * workflow input. A single-repository run has one; a multi-repository run has
 * one per repository delivery that continues an attached PR (all share the run
 * id). Repositories without a PR are not targets.
 */
export function resolvePrCiTargets(db: DbInstance, projectId: string, runId: string): PrCiTarget[] {
  const rows = db.prepare('SELECT delivery_id, snapshot_json FROM definition_delivery_settlements WHERE project_id = ? AND run_id = ? AND superseded_by IS NULL ORDER BY created_at, delivery_id')
    .all(projectId, runId) as Array<{ delivery_id: string; snapshot_json: string }>
  const targets: PrCiTarget[] = []
  for (const row of rows) {
    let snapshot: IsolatedSettlementSnapshot
    try { snapshot = JSON.parse(row.snapshot_json) as IsolatedSettlementSnapshot } catch { continue }
    const delivery = getPrDelivery(db, row.delivery_id)
    const target = snapshot.run?.continuationTarget
    if (!delivery || delivery.loop_id !== PR_CI_LOOP_ID || !target?.prUrl || snapshot.run.runId !== runId) continue
    if (delivery.pr_url && delivery.pr_url !== target.prUrl) continue
    targets.push({
      deliveryId: row.delivery_id,
      runId,
      repositoryName: path.basename(delivery.repository_path ?? snapshot.baseRepo),
      prUrl: target.prUrl,
      prNumber: target.prNumber,
      branch: target.branch,
      baseBranch: target.baseBranch,
      worktreePath: snapshot.run.handle.worktreePath,
      repoDir: snapshot.baseRepo,
      overlayExcludes: [...(snapshot.run.overlayExcludes ?? [])],
    })
  }
  return targets
}
