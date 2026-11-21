/**
 * Base refresh of a conflicted local delivery (the automatic path before
 * "re-run on the updated base").
 *
 * A milestone chain integrates each delivery into its integration branch.
 * When the base moved since the delivery was built (another spec was
 * integrated), `merge-local` can refuse with a conflict. Instead of pausing
 * the chain, the host first brings the base into the delivery:
 *
 *   1. the delivery's own run worktree (still on its feature branch at the
 *      verified delivery commit) merges the base with a merge commit, never a
 *      rebase: no published or protected history is rewritten;
 *   2. real conflicts go to an agent step (the resolver) with the spec as
 *      context; the host checks that no conflict remains before it commits;
 *   3. the caller re-verifies the merged candidate in that worktree (a fork of
 *      the run from its final verification), and the next integration is a
 *      fast-forward of verified work.
 *
 * The merge is assembled on a detached HEAD; the feature branch moves (a
 * fast-forward, guarded by its old value) only once the merge is committed,
 * and `rollbackBaseRefresh` puts it back when the re-verification cannot
 * start. Everything here is git in a Specrails-owned run worktree; the
 * person's checkout and the integration branch are never touched.
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { formatConventionalSubject } from './pr-naming'
import type { GitRunner } from '../../../worktree-manager'

/** Base refreshes one delivery lineage may take; afterwards the chain pauses with its options. */
export const BASE_REFRESH_LIMIT = 2
/** Fork request ids of base refreshes start with this (counted against the limit). */
export const BASE_REFRESH_REQUEST_PREFIX = 'base-refresh-'
/** The node a refreshed run re-verifies from: the final verification of the Implement recipe. */
export const BASE_REFRESH_FORK_NODE = 'verify-archive'

/** Resolver turns per refresh: the second sees only the files the first left conflicted. */
export const RESOLVER_ROUNDS = 2
const SHA = /^[0-9a-f]{40,64}$/i
const CONFLICT_MARKER = /^(?:<{7}|>{7})(?: |$)|^={7}$/m

export interface BaseRefreshSpec { ticketId: number; title: string | null; description: string | null }

export interface ResolverInput {
  worktreePath: string
  branch: string
  baseBranch: string
  conflictPaths: readonly string[]
  specs: readonly BaseRefreshSpec[]
}

export interface BaseRefreshInput {
  worktreePath: string
  /** The delivery's feature branch, checked out in `worktreePath`. */
  branch: string
  /** The verified delivery commit the branch must still point at. */
  deliverySha: string
  /** The integration branch and the exact commit the delivery must contain. */
  baseBranch: string
  baseSha: string
  /** Branches that are never moved here (the integration branch, the default branch...). */
  protectedBranches: readonly string[]
  specs: readonly BaseRefreshSpec[]
  ticketRef: string
}

export interface BaseRefreshDeps {
  git: GitRunner
  /** The agent step that resolves the conflicted files in the worktree (never commits). */
  resolve: (input: ResolverInput) => Promise<void>
}

export type BaseRefreshFailure =
  | 'protected_branch' | 'worktree_unavailable' | 'worktree_changed' | 'up_to_date'
  | 'conflict_unresolved' | 'resolver_failed' | 'git_failed'

export type BaseRefreshResult =
  | { ok: true; mergeSha: string; conflicts: string[] }
  | { ok: false; reason: BaseRefreshFailure; detail: string; conflicts?: string[] }

const first = (r: { stdout: string; stderr: string; code: number }): string =>
  (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`

/** The resolver brief: the conflict, the specs it must keep, and the host's git ownership. */
export function buildBaseRefreshResolverPrompt(input: ResolverInput, mergeSafe: string): string {
  return [
    `A merge of the updated base branch \`${input.baseBranch}\` into this delivery branch \`${input.branch}\` is prepared in this worktree and left unconfirmed by the host. The base moved since this change was built (other work was integrated), and these files conflict:`,
    ...input.conflictPaths.map((file) => `- ${file}`),
    '',
    'The change on this branch implements:',
    ...input.specs.map((spec) => `- #${spec.ticketId} ${spec.title ?? ''}${spec.description ? `: ${spec.description.replace(/\s+/g, ' ').slice(0, 1200)}` : ''}`),
    '',
    mergeSafe,
    '',
    'Both sides are intended: the base side is work the person already integrated, and this branch\'s side is the change described above. Resolve every conflict by combining them, so the base\'s behaviour stays and this change applies on top of it (for example, when both rewrite the same expression, write the expression that does both). Never drop either side\'s behaviour, and change nothing outside the conflicted hunks. Remove every conflict marker.',
    'Leave a hunk unresolved only when the two intents truly contradict each other (no code can do both); then say which hunk and why.',
    'Do not run git merge, git commit, git add, git checkout, git switch, git reset, git rebase, git stash or git push: the host completes the merge and verifies it.',
  ].join('\n')
}

/**
 * Merge the base into the delivery in its worktree. On success the feature
 * branch points at the merge commit (a descendant of the delivery commit) and
 * the worktree is clean on it. On failure the worktree and the branch are
 * exactly as they were (the delivery commit, clean).
 */
export async function mergeBaseIntoDelivery(deps: BaseRefreshDeps, input: BaseRefreshInput): Promise<BaseRefreshResult> {
  const { git } = deps
  const cwd = input.worktreePath
  if (input.protectedBranches.includes(input.branch) || input.branch === input.baseBranch) {
    return { ok: false, reason: 'protected_branch', detail: `\`${input.branch}\` is a protected branch; Specrails never moves it.` }
  }
  if (!SHA.test(input.deliverySha) || !SHA.test(input.baseSha)) return { ok: false, reason: 'worktree_changed', detail: 'the delivery or base commit is not an exact commit id' }
  if (!existsSync(cwd)) return { ok: false, reason: 'worktree_unavailable', detail: `the delivery worktree ${cwd} no longer exists` }
  const [ref, head, status] = await Promise.all([
    git.run(['symbolic-ref', '--quiet', 'HEAD'], cwd),
    git.run(['rev-parse', '--verify', 'HEAD'], cwd),
    git.run(['status', '--porcelain', '--untracked-files=normal'], cwd),
  ])
  if (ref.code !== 0 || ref.stdout.trim() !== `refs/heads/${input.branch}`) return { ok: false, reason: 'worktree_changed', detail: `the worktree is not on \`${input.branch}\`` }
  if (head.code !== 0 || head.stdout.trim().toLowerCase() !== input.deliverySha.toLowerCase()) return { ok: false, reason: 'worktree_changed', detail: `\`${input.branch}\` moved since the delivery was verified` }
  if (status.code !== 0 || status.stdout.trim()) return { ok: false, reason: 'worktree_changed', detail: 'the delivery worktree has uncommitted changes' }
  const contained = await git.run(['merge-base', '--is-ancestor', input.baseSha, input.deliverySha], cwd)
  if (contained.code === 0) return { ok: false, reason: 'up_to_date', detail: `the delivery already contains \`${input.baseBranch}\`` }

  // Assemble on a detached HEAD: the feature branch only moves once the merge is committed.
  const detached = await git.run(['checkout', '--quiet', '--detach'], cwd)
  if (detached.code !== 0) return { ok: false, reason: 'git_failed', detail: `detaching the worktree: ${first(detached)}` }
  const restore = async (): Promise<void> => {
    if ((await git.run(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], cwd)).code === 0) await git.run(['merge', '--abort'], cwd)
    // The worktree is Specrails' own: dropping a failed resolution only discards the attempt.
    await git.run(['checkout', '--quiet', '--force', input.branch], cwd)
    // The refresh started on a clean worktree, so an untracked (not ignored) file is the attempt's own.
    await git.run(['clean', '-fdq'], cwd)
  }
  const subject = formatConventionalSubject({ type: 'chore', change: `merge ${input.baseBranch} into the delivery`, ref: input.ticketRef })
  const merged = await git.run(['merge', '--no-ff', '--no-edit', '-m', subject, input.baseSha], cwd)
  let conflicts: string[] = []
  if (merged.code !== 0) {
    const unmerged = await git.run(['diff', '--name-only', '--diff-filter=U'], cwd)
    conflicts = unmerged.code === 0 ? unmerged.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
    if (!conflicts.length) {
      await restore()
      return { ok: false, reason: 'git_failed', detail: `merging \`${input.baseBranch}\`: ${first(merged)}` }
    }
    const remaining = (files: readonly string[]): string[] => files.filter((file) => {
      const absolute = path.join(cwd, file)
      try { return existsSync(absolute) && CONFLICT_MARKER.test(readFileSync(absolute, 'utf8')) } catch { return true }
    })
    // A second round gets only the files whose markers the first one left (a cheap model sometimes stops early).
    let left = conflicts
    for (let round = 0; round < RESOLVER_ROUNDS && left.length; round++) {
      try {
        await deps.resolve({ worktreePath: cwd, branch: input.branch, baseBranch: input.baseBranch, conflictPaths: left, specs: input.specs })
      } catch (error) {
        await restore()
        return { ok: false, reason: 'resolver_failed', detail: error instanceof Error ? error.message : String(error), conflicts }
      }
      left = remaining(left)
    }
    if (left.length) {
      await restore()
      return { ok: false, reason: 'conflict_unresolved', detail: `conflict markers remain in ${left.join(', ')}`, conflicts }
    }
    const added = await git.run(['add', '-A', '--', ...conflicts], cwd)
    const still = await git.run(['diff', '--name-only', '--diff-filter=U'], cwd)
    if (added.code !== 0 || still.code !== 0 || still.stdout.trim()) {
      await restore()
      return { ok: false, reason: 'conflict_unresolved', detail: still.stdout.trim() ? `still unmerged: ${still.stdout.trim().split('\n').join(', ')}` : `staging the resolution: ${first(added)}`, conflicts }
    }
    // The resolver may only touch the conflicted files: anything else it changed is not the merge.
    const stray = await git.run(['status', '--porcelain', '--untracked-files=normal'], cwd)
    const unexpected = stray.stdout.split('\n').filter((line) => line.trim() && /^.[^ ]|^\?\?/.test(line)).map((line) => line.slice(3).trim())
    if (stray.code !== 0 || unexpected.length) {
      await restore()
      return { ok: false, reason: 'conflict_unresolved', detail: `the resolution also changed ${unexpected.slice(0, 5).join(', ') || 'files the host could not read'}`, conflicts }
    }
    const committed = await git.run(['commit', '--quiet', '--no-edit'], cwd)
    if (committed.code !== 0) {
      await restore()
      return { ok: false, reason: 'git_failed', detail: `committing the merge: ${first(committed)}`, conflicts }
    }
  }
  const mergeHead = await git.run(['rev-parse', '--verify', 'HEAD'], cwd)
  const mergeSha = mergeHead.code === 0 ? mergeHead.stdout.trim() : ''
  const descends = SHA.test(mergeSha) ? await git.run(['merge-base', '--is-ancestor', input.deliverySha, mergeSha], cwd) : null
  const containsBase = SHA.test(mergeSha) ? await git.run(['merge-base', '--is-ancestor', input.baseSha, mergeSha], cwd) : null
  if (!descends || descends.code !== 0 || !containsBase || containsBase.code !== 0) {
    await restore()
    return { ok: false, reason: 'git_failed', detail: 'the merge commit could not be verified', conflicts }
  }
  // Fast-forward the feature branch to the merge, only if it still points at the delivery commit.
  const moved = await git.run(['update-ref', `refs/heads/${input.branch}`, mergeSha, input.deliverySha], cwd)
  if (moved.code !== 0) {
    await restore()
    return { ok: false, reason: 'worktree_changed', detail: `\`${input.branch}\` moved during the refresh: ${first(moved)}` }
  }
  const attached = await git.run(['checkout', '--quiet', input.branch], cwd)
  if (attached.code !== 0) return { ok: false, reason: 'git_failed', detail: `returning to \`${input.branch}\`: ${first(attached)}`, conflicts }
  return { ok: true, mergeSha, conflicts }
}

/** Undo a refresh whose re-verification never started: the branch goes back to the delivery commit. */
export async function rollbackBaseRefresh(git: GitRunner, input: { worktreePath: string; branch: string; deliverySha: string; mergeSha: string }): Promise<boolean> {
  const cwd = input.worktreePath
  const detached = await git.run(['checkout', '--quiet', '--detach'], cwd)
  if (detached.code !== 0) return false
  const back = await git.run(['update-ref', `refs/heads/${input.branch}`, input.deliverySha, input.mergeSha], cwd)
  const attached = await git.run(['checkout', '--quiet', '--force', input.branch], cwd)
  return back.code === 0 && attached.code === 0
}
