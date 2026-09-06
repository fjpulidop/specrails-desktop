import type { DbInstance } from './db'
import { getPrDelivery, toPrDeliverySnapshot } from './rail-pr-store'
import { resolveProjectRepository, type RepositoryProject } from './project-repositories'
import type { GitRunner } from './worktree-manager'

/** Resolve the latest delivered head per member from durable milestone history.
 * The request names deliveries, never invents a repository/branch/SHA binding. */
export async function resolveRepositoryDeliveryBases(db: DbInstance, project: RepositoryProject, selectedIds: string[], value: unknown, git: GitRunner): Promise<{
  repositoryBaseBranches: Record<string, string>
  repositoryBaseShas: Record<string, string>
}> {
  const repositoryBaseBranches: Record<string, string> = {}
  const repositoryBaseShas: Record<string, string> = {}
  if (value === undefined) return { repositoryBaseBranches, repositoryBaseShas }
  if (!Array.isArray(value) || value.length === 0 || value.length > 100 || value.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 200)) {
    throw new Error('baseDeliveryIds must be a nonempty list of at most 100 delivery IDs')
  }
  const primary = resolveProjectRepository(project)
  const bases = new Map<string, { branch: string; sha: string; merged: boolean }>()
  for (const id of value as string[]) {
    const row = getPrDelivery(db, id)
    if (!row || row.parent_delivery_id) throw new Error(`Unknown base delivery: ${id}`)
    const snapshot = toPrDeliverySnapshot(row)
    if (!['on_review', 'no_changes', 'pr_draft', 'pr_ready', 'completed', 'merged'].includes(snapshot.decision)) throw new Error(`Base delivery ${id} is not ready`)
    const entries = snapshot.repositoryDeliveries?.length ? snapshot.repositoryDeliveries : [{
      repositoryId: primary.id, decision: snapshot.decision, baseBranch: snapshot.baseBranch,
      branch: snapshot.branch ?? (snapshot.branches.length === 1 ? snapshot.branches[0].branch : null),
      deliverySha: snapshot.deliverySha ?? (snapshot.branches.length === 1 ? snapshot.branches[0].finalSha : null),
    }]
    for (const entry of entries) {
      if (!selectedIds.includes(entry.repositoryId) || ['no_changes', 'completed'].includes(entry.decision)) continue
      const branch = entry.decision === 'merged' ? (('integrationBranch' in entry && entry.integrationBranch) || entry.baseBranch) : entry.branch
      if (!branch || !entry.deliverySha) throw new Error(`Base delivery ${id} has no verified head for repository ${entry.repositoryId}`)
      bases.set(entry.repositoryId, { branch, sha: entry.deliverySha, merged: entry.decision === 'merged' })
    }
  }
  for (const [id, base] of bases) {
    const repository = resolveProjectRepository(project, id)
    const result = await git.run(['rev-parse', '--verify', `refs/heads/${base.branch}`], repository.path)
    const head = result.stdout.trim()
    if (result.code !== 0 || !/^[a-f0-9]{40,64}$/i.test(head)) throw new Error(`Missing base branch ${base.branch} in ${repository.name}`)
    if (base.merged) {
      const contains = await git.run(['merge-base', '--is-ancestor', base.sha, head], repository.path)
      if (contains.code !== 0) throw new Error(`Integrated base no longer contains the delivered commit in ${repository.name}`)
    } else if (head !== base.sha) throw new Error(`Delivered base branch changed in ${repository.name}`)
    repositoryBaseBranches[id] = base.branch
    repositoryBaseShas[id] = head
  }
  return { repositoryBaseBranches, repositoryBaseShas }
}
