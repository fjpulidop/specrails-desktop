/**
 * Merge-back state machine for parallel-rail isolation. After the fan-out, each
 * successful ticket branch is integrated into the base ONE AT A TIME (the caller
 * holds the per-repo mutex), each integration individually validated:
 *
 *   merge --no-ff → conflict? resolve (AI) → re-verify INTEGRATED tree
 *     → red? rebase+one-fix-pass → still red? roll back to pre-merge + needs-review
 *
 * Only a clean, re-verified merge advances the base; a failed run is never merged.
 * All git I/O + the AI/verify steps are injected so the machine is unit-tested
 * without a real repo. See openspec/changes/parallel-implementation-worktrees.
 */
import type { GitRunner } from './worktree-manager'

export type MergeState = 'merged' | 'needs-review' | 'skipped'

export interface BranchToMerge {
  ticketId: number
  branch: string
  /** The ticket's loop run succeeded — only successful runs are eligible to merge. */
  succeeded: boolean
  /** Contract-Layer file touch list (optional) — drives merge ordering. */
  touchList?: string[]
}

export interface MergeDeps {
  git: GitRunner
  /** Repo (or worktree of the base branch) where merges are applied. */
  baseDir: string
  /** Invoke the AI merge-resolver on the current conflict; true ⇒ resolved cleanly. */
  resolveConflict(branch: BranchToMerge): Promise<boolean>
  /** Run the loop's verification on the integrated base; true ⇒ green. */
  verifyIntegrated(): Promise<boolean>
  /** Rebase the branch on the new base + run one fix pass, committing the fix and
   *  re-verifying; true ⇒ the integrated tree is now green. */
  rebaseAndFix(branch: BranchToMerge): Promise<boolean>
  /** State sink (ledger + WS). Also receives the transient 'merging'. */
  onState?(ticketId: number, state: MergeState | 'merging'): void
}

export interface MergeOutcome {
  ticketId: number
  branch: string
  state: MergeState
}

/**
 * Merge order: least-overlapping branches first (so the most-conflicting one
 * rebases onto the most-complete base last), tie-broken by ticket id. With no
 * touch-lists, plain ascending ticket-id order. Pure.
 */
export function orderBranches(branches: BranchToMerge[]): BranchToMerge[] {
  const eligible = branches.filter((b) => b.succeeded)
  const haveTouch = eligible.some((b) => (b.touchList?.length ?? 0) > 0)
  if (!haveTouch) return [...eligible].sort((a, b) => a.ticketId - b.ticketId)
  const overlap = (b: BranchToMerge): number => {
    const others = new Set<string>()
    for (const o of eligible) if (o !== b) for (const f of o.touchList ?? []) others.add(f)
    let n = 0
    for (const f of b.touchList ?? []) if (others.has(f)) n++
    return n
  }
  return [...eligible].sort((a, b) => overlap(a) - overlap(b) || a.ticketId - b.ticketId)
}

async function revParse(git: GitRunner, baseDir: string): Promise<string> {
  const r = await git.run(['rev-parse', 'HEAD'], baseDir)
  return r.stdout.trim()
}

/**
 * Integrate every successful branch into the base, sequentially. Returns a
 * per-ticket outcome. Failed runs are reported `skipped` and never merged. The
 * base is rolled back to its pre-merge SHA whenever an integration cannot be made
 * green, so the repo is always left green with the succeeded tickets integrated.
 */
export async function mergeBack(deps: MergeDeps, branches: BranchToMerge[]): Promise<MergeOutcome[]> {
  const { git, baseDir } = deps
  const outcomes: MergeOutcome[] = []

  // Failed/aborted runs are never merged.
  for (const b of branches) {
    if (!b.succeeded) outcomes.push({ ticketId: b.ticketId, branch: b.branch, state: 'skipped' })
  }

  for (const b of orderBranches(branches)) {
    deps.onState?.(b.ticketId, 'merging')
    const preSha = await revParse(git, baseDir)

    const merge = await git.run(['merge', '--no-ff', '--no-edit', b.branch], baseDir)
    if (merge.code !== 0) {
      // Conflict (or other merge failure) — hand the conflict to the AI resolver.
      const resolved = await deps.resolveConflict(b)
      if (!resolved) {
        await git.run(['merge', '--abort'], baseDir)
        deps.onState?.(b.ticketId, 'needs-review')
        outcomes.push({ ticketId: b.ticketId, branch: b.branch, state: 'needs-review' })
        continue
      }
      // Resolver edited the working tree within the conflict markers — record it.
      await git.run(['add', '-A'], baseDir)
      await git.run(['commit', '--no-edit'], baseDir)
    }

    // Re-verify the INTEGRATED tree before accepting the merge.
    let green = await deps.verifyIntegrated()
    if (!green) {
      // One automatic recovery: rebase the branch on the new base + a fix pass.
      const fixed = await deps.rebaseAndFix(b)
      if (!fixed) {
        await git.run(['reset', '--hard', preSha], baseDir)
        deps.onState?.(b.ticketId, 'needs-review')
        outcomes.push({ ticketId: b.ticketId, branch: b.branch, state: 'needs-review' })
        continue
      }
      green = true
    }

    deps.onState?.(b.ticketId, 'merged')
    outcomes.push({ ticketId: b.ticketId, branch: b.branch, state: 'merged' })
  }

  return outcomes
}
