import { getRailWorktree, isTerminalMergeState, updateRailWorktreeState, type MergeState } from './rail-worktrees-store'
import { removeWorktree, type GitRunner } from './worktree-manager'
import type { DbInstance } from './db'

export interface ReleaseRailWorktreesInput {
  db: DbInstance
  git: GitRunner
  repoDir: string
  worktreeIds: string[]
  /** Terminal state to record for non-terminal rows after the worktree is removed. */
  state?: Extract<MergeState, 'released' | 'merged' | 'failed'>
  /** Injectable remover for focused settlement tests. */
  remove?: typeof removeWorktree
  /** Explicit destructive discard only. Automatic delivery cleanup must leave
   * needs-review worktrees mounted for recovery. */
  allowNeedsReview?: boolean
}

/** Remove Specrails-managed linked worktrees while keeping their local branches.
 *  PR deliveries use this once the work has a durable remote branch/PR: the
 *  branch remains available for local checkout, but the internal worktree stops
 *  blocking `git switch <branch>` in the user's main checkout. */
export async function releaseRailWorktrees(input: ReleaseRailWorktreesInput): Promise<string[]> {
  const state = input.state ?? 'released'
  const remove = input.remove ?? removeWorktree
  const warnings: string[] = []
  for (const wtId of input.worktreeIds) {
    const wt = getRailWorktree(input.db, wtId)
    if (!wt) continue
    if (wt.merge_state === 'needs-review' && input.allowNeedsReview !== true) continue
    // Successful removal already terminalized these rows. Re-running `git
    // worktree remove` against their now-missing paths turns ordinary Publish /
    // Poll / Discard follow-ups into false cleanup_incomplete warnings.
    if (wt.merge_state !== 'needs-review' && isTerminalMergeState(wt.merge_state)) continue
    try {
      await remove(input.git, {
        repoDir: input.repoDir,
        worktreePath: wt.worktree_path,
        branch: wt.branch,
        deleteBranch: false,
      })
    } catch (err) {
      const current = getRailWorktree(input.db, wt.id)
      if (current && current.merge_state !== 'needs-review' && isTerminalMergeState(current.merge_state)) {
        continue
      }
      const warning = `worktree ${wt.worktree_path}: ${err instanceof Error ? err.message : String(err)}`
      warnings.push(warning)
      console.warn(`[rail-worktree-release] failed to remove ${warning}`)
      continue
    }
    if (!isTerminalMergeState(wt.merge_state)) updateRailWorktreeState(input.db, wt.id, state)
  }
  return warnings
}
