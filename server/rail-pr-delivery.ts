/**
 * Deliver a parallel rail's isolated ticket branches as ONE draft pull request,
 * WITHOUT ever touching the base repo's HEAD.
 *
 * This is the flag-gated alternative to the legacy local merge-back
 * (`rail-merge-orchestrator`): instead of `git merge --no-ff` into whatever is
 * checked out, we assemble the successful ticket branches onto a fresh batch
 * integration branch (branched from the DESIGNATED integration branch) and open a
 * single draft PR from it. The engineer owns the merge — specrails is a PR
 * producer, never a merge authority.
 *
 *   0 succeeded          → no-op.
 *   1 succeeded          → draft PR straight from that ticket branch.
 *   N succeeded (clean)  → batch branch (the caller's conventional
 *                          `<type>/<primary-ref>-batch-<n>-tickets` name from
 *                          pr-naming, suffixed `-2`… on collision) off the
 *                          integration branch, merge each ticket branch in, one
 *                          combined draft PR whose body covers every ticket.
 *   N succeeded (conflict) → SAFE failure: abort, tear down the batch branch/worktree,
 *                          leave the ticket branches for a human. Never touch base.
 *
 * Pure over injectable `GitRunner` + `Exec` so it is unit-tested without git/gh/net.
 */
import type { GitRunner } from './worktree-manager'
import { listLocalBranches } from './worktree-manager'
import { resolveCollisionFreeName } from './pr-naming'
import { publishDraftPr, type Exec, type PrPublishResult } from './pr-publisher'

export interface DeliverBranch {
  ticketId: number
  branch: string
  succeeded: boolean
  /** Verified immutable object produced by settlement. */
  sourceSha?: string
}

export interface DeliverRailInput {
  /** The base repo (shares the object-store with every ticket worktree). */
  baseRepo: string
  /** The designated integration branch the draft PR targets and batches off. */
  integrationBranch: string
  /** A key unique to this rail run (used in the transient batch worktree path). */
  railKey: string
  /** Preferred batch branch name (conventional, from pr-naming's
   *  `batchBranchNameFor`); suffixed `-2`, `-3`… on collision, never the
   *  integration branch and never a unit branch. Only used (and only required)
   *  when >1 unit succeeded — single-unit deliveries derive no batch name. */
  batchBranch?: string
  /** Where to create the transient batch worktree (removed after the PR is opened). */
  batchWorktreeRoot: string
  branches: DeliverBranch[]
  title: string
  body: string
}

export type DeliverResult =
  | { state: 'no-op'; reason: string }
  | { state: 'delivered'; branch: string; pr: PrPublishResult; ticketIds: number[] }
  | { state: 'assembly-failed'; reason: string; ticketIds: number[] }

export async function deliverRailAsPr(git: GitRunner, exec: Exec, input: DeliverRailInput): Promise<DeliverResult> {
  const succeeded = input.branches.filter((b) => b.succeeded)
  if (succeeded.length === 0) return { state: 'no-op', reason: 'no-succeeded-branches' }

  // Single ticket → PR straight from its branch; no batch assembly needed.
  if (succeeded.length === 1) {
    const b = succeeded[0]
    const pr = await publishDraftPr(exec, {
      repoDir: input.baseRepo,
      branch: b.branch,
      baseBranch: input.integrationBranch,
      title: input.title,
      body: input.body,
      sourceSha: b.sourceSha,
    })
    return { state: 'delivered', branch: b.branch, pr, ticketIds: [b.ticketId] }
  }

  // Multiple tickets → assemble onto ONE batch branch off the integration base.
  // Bounded collision resolution against the live branch listing; a pre-existing
  // user branch never gets clobbered, the integration branch is never used and —
  // hard guard — the batch head can never land ON a unit branch (its later
  // teardown `branch -D` would then destroy the commits being delivered).
  const ticketIds = succeeded.map((b) => b.ticketId)
  if (!input.batchBranch) {
    // Defensive: callers derive the batch name from the same branch records this
    // function filters, so the counts always agree — but a wedged/foreign caller
    // must fail safely, never assemble onto an empty ref.
    return { state: 'assembly-failed', reason: 'missing-batch-branch', ticketIds }
  }
  const taken = await listLocalBranches(git, input.baseRepo)
  const batch = resolveCollisionFreeName(input.batchBranch, {
    taken: (name) => taken.has(name),
    reserved: [input.integrationBranch, ...succeeded.map((b) => b.branch)],
  })
  if (!batch) {
    return { state: 'assembly-failed', reason: `batch-branch-collision:${input.batchBranch}`, ticketIds }
  }
  const wt = `${input.batchWorktreeRoot.replace(/\/$/, '')}/batch-${input.railKey}`

  const add = await git.run(['worktree', 'add', '-b', batch, wt, input.integrationBranch], input.baseRepo)
  if (add.code !== 0) {
    return { state: 'assembly-failed', reason: firstLine(add) || 'worktree-add-failed', ticketIds }
  }

  for (const b of succeeded) {
    const merge = await git.run(['merge', '--no-ff', '--no-edit', b.sourceSha ?? b.branch], wt)
    if (merge.code !== 0) {
      // Conflict/failure → abort and tear the batch down cleanly. Ticket branches
      // stay intact for a human. Never leave a half-merged batch.
      await git.run(['merge', '--abort'], wt).catch(() => {})
      await teardownBatch(git, input.baseRepo, wt, batch)
      return { state: 'assembly-failed', reason: `merge-conflict:${b.branch}`, ticketIds }
    }
  }

  const pr = await publishDraftPr(exec, {
    repoDir: wt,
    branch: batch,
    baseBranch: input.integrationBranch,
    title: input.title,
    body: input.body,
  })

  // Remove the transient worktree but KEEP the batch branch (the PR references it).
  await git.run(['worktree', 'remove', '--force', wt], input.baseRepo).catch(() => {})

  return { state: 'delivered', branch: batch, pr, ticketIds }
}

async function teardownBatch(git: GitRunner, baseRepo: string, wt: string, batch: string): Promise<void> {
  await git.run(['worktree', 'remove', '--force', wt], baseRepo).catch(() => {})
  await git.run(['branch', '-D', batch], baseRepo).catch(() => {})
}

function firstLine(r: { stderr: string; stdout: string }): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n')[0]
}
