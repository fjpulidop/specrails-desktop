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
 *   N succeeded (clean)  → batch branch `sr/<slug>/batch-<key>` off the integration
 *                          branch, merge each ticket branch in, one combined draft PR
 *                          whose body lists every ticket.
 *   N succeeded (conflict) → SAFE failure: abort, tear down the batch branch/worktree,
 *                          leave the ticket branches for a human. Never touch base.
 *
 * Pure over injectable `GitRunner` + `Exec` so it is unit-tested without git/gh/net.
 */
import type { GitRunner } from './worktree-manager'
import { publishDraftPr, type Exec, type PrPublishResult } from './pr-publisher'

export interface DeliverBranch {
  ticketId: number
  branch: string
  succeeded: boolean
}

export interface DeliverRailInput {
  /** The base repo (shares the object-store with every ticket worktree). */
  baseRepo: string
  /** The designated integration branch the draft PR targets and batches off. */
  integrationBranch: string
  slug: string
  /** A key unique to this rail run (used in the batch branch + worktree path). */
  railKey: string
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

export function batchBranchName(slug: string, railKey: string): string {
  return `sr/${slug}/batch-${railKey}`
}

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
    })
    return { state: 'delivered', branch: b.branch, pr, ticketIds: [b.ticketId] }
  }

  // Multiple tickets → assemble onto ONE batch branch off the integration base.
  const batch = batchBranchName(input.slug, input.railKey)
  const wt = `${input.batchWorktreeRoot.replace(/\/$/, '')}/batch-${input.railKey}`
  const ticketIds = succeeded.map((b) => b.ticketId)

  const add = await git.run(['worktree', 'add', '-b', batch, wt, input.integrationBranch], input.baseRepo)
  if (add.code !== 0) {
    return { state: 'assembly-failed', reason: firstLine(add) || 'worktree-add-failed', ticketIds }
  }

  for (const b of succeeded) {
    const merge = await git.run(['merge', '--no-ff', '--no-edit', b.branch], wt)
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

/** Build a combined-PR body listing every ticket delivered by the rail. */
export function buildBatchPrBody(loopName: string, tickets: Array<{ ticketId: number; title?: string }>): string {
  const lines = [
    `Implemented by the **${loopName}** rail as one batch:`,
    '',
    ...tickets.map((t) => `- [x] #${t.ticketId}${t.title ? ` — ${t.title}` : ''}`),
    '',
    '_Draft PR produced by specrails — the engineer owns the merge._',
  ]
  return lines.join('\n')
}

function firstLine(r: { stderr: string; stdout: string }): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n')[0]
}
