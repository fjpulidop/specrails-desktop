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
}

/** Remove Specrails-managed linked worktrees while keeping their local branches.
 *  PR deliveries use this once the work has a durable remote branch/PR: the
 *  branch remains available for local checkout, but the internal worktree stops
 *  blocking `git switch <branch>` in the user's main checkout. */
export async function releaseRailWorktrees(input: ReleaseRailWorktreesInput): Promise<void> {
  const state = input.state ?? 'released'
  for (const wtId of input.worktreeIds) {
    const wt = getRailWorktree(input.db, wtId)
    if (!wt) continue
    try {
      await removeWorktree(input.git, {
        repoDir: input.repoDir,
        worktreePath: wt.worktree_path,
        branch: wt.branch,
        deleteBranch: false,
      })
    } catch (err) {
      console.warn(`[rail-worktree-release] failed to remove worktree ${wt.worktree_path}: ${(err as Error).message}`)
      continue
    }
    if (!isTerminalMergeState(wt.merge_state)) updateRailWorktreeState(input.db, wt.id, state)
  }
}
