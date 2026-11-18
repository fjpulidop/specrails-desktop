/**
 * Retained run worktrees: the pure decision behind Settings ▸ Storage.
 *
 * Settlement keeps a run worktree mounted when it cannot prove that removing it
 * is lossless (`needs-review`), and a failed removal can leave a terminal row
 * still mounted. Nothing sweeps them, so they pile up. This file decides, from
 * evidence gathered elsewhere, what removing one would lose:
 *
 * - **Nothing to lose**: the worktree is clean, every ignored file is
 *   regenerable, a link, identical to the main checkout or already authorized
 *   for the safety archive, and every commit on its branch is reachable from a
 *   remote, another branch or the main checkout (or its delivery was merged).
 * - **Waiting for you**: anything else, with the reasons in priority order.
 *
 * Unknown evidence is never clean: a Git read that failed blocks removal.
 * Removing the worktree always keeps its branch; deleting the branch is a
 * separate, stricter permission (`branchDeletable`).
 */

/** Rail worktrees can be removed here; Intent session worktrees are listed only (their session owns them). */
export type RetainedWorktreeKind = 'rail' | 'intent'

/** Why a worktree waits for the person, highest priority first (see {@link RETAINED_REASON_ORDER}). */
export type RetainedWorktreeReason =
  /** A run, revision or decision is using it right now. */
  | 'run-active'
  /** An Intent session still owns it: resume or discard it there. */
  | 'intent-owned'
  /** Git could not prove its state (unknown ≠ clean). */
  | 'git-unknown'
  /** Tracked or untracked changes exist only in this worktree. */
  | 'uncommitted-changes'
  /** Ignored files that exist nowhere else (not regenerable, not a copy of the main checkout). */
  | 'ignored-files'
  /** Touched in the last hour: it may still be in use. */
  | 'recently-active'
  /** Commits reachable from no remote, no other branch and not the main checkout. */
  | 'unpushed-commits'
  /** Git could not tell whether the branch holds unique commits. */
  | 'branch-unknown'
  /** Its delivery still waits for a decision (review, PR, failure to dismiss). */
  | 'open-delivery'

export const RETAINED_REASON_ORDER: readonly RetainedWorktreeReason[] = [
  'run-active', 'intent-owned', 'git-unknown', 'uncommitted-changes', 'ignored-files',
  'recently-active', 'unpushed-commits', 'branch-unknown', 'open-delivery',
]

/** Reasons that forbid removing the worktree from this view. The rest only protect the branch. */
const REMOVE_BLOCKERS: ReadonlySet<RetainedWorktreeReason> = new Set([
  'run-active', 'intent-owned', 'git-unknown', 'uncommitted-changes', 'ignored-files', 'recently-active',
])

/** A worktree touched this recently may still be in use (someone just opened it to read it). */
export const RETAINED_WORKTREE_GRACE_MS = 60 * 60 * 1000

/** Delivery decisions that still wait for the person; the branch is part of that decision. */
const OPEN_DELIVERY_DECISIONS: ReadonlySet<string> = new Set([
  'building', 'on_review', 'pr_draft', 'pr_ready', 'implementation_failed', 'pr_failed',
])

export type RetainedWorktreeLabel = 'nothing-to-lose' | 'waiting-for-you'

export interface RetainedDeliveryFacts {
  decision: string
  /** A PR decision (publish, merge, discard…) holds the delivery right now. */
  operationActive: boolean
}

/** Git evidence; `null` means the read failed or was impossible (never "clean"). */
export interface RetainedGitEvidence {
  head: string | null
  /** Tracked changes (staged or not), excluding Specrails' own overlay. */
  trackedChanges: number | null
  untrackedFiles: number | null
  /** Ignored paths whose bytes exist only here. */
  ignoredAtRisk: readonly string[] | null
  /** True / false when known, null when the branch ref could not be read. */
  branchExists: boolean | null
  /** Commits on the branch reachable from no remote, other branch or the main checkout. */
  unpushedCommits: number | null
}

export interface RetainedWorktreeEvidence {
  kind: RetainedWorktreeKind
  /** Another ledger row (a revision, a live run) uses the same mount, or a run owns it. */
  runActive: boolean
  delivery: RetainedDeliveryFacts | null
  /** Epoch ms of the latest known activity (ledger update, index or HEAD log write). */
  lastActivityAt: number | null
  git: RetainedGitEvidence
}

export interface RetainedWorktreeEvaluation {
  label: RetainedWorktreeLabel
  /** Every reason that applies, in {@link RETAINED_REASON_ORDER}. Empty ⇔ nothing to lose. */
  reasons: RetainedWorktreeReason[]
  /** The worktree may be removed here (its branch is kept). */
  removable: boolean
  /** The first reason that forbids removal, when not removable. */
  removeBlocker: RetainedWorktreeReason | null
  /** Removing the branch too loses nothing (requires `removable`). */
  branchDeletable: boolean
}

export function evaluateRetainedWorktree(evidence: RetainedWorktreeEvidence, now: number): RetainedWorktreeEvaluation {
  const reasons = new Set<RetainedWorktreeReason>()
  const { git, delivery } = evidence
  if (evidence.runActive || delivery?.operationActive || delivery?.decision === 'building') reasons.add('run-active')
  if (evidence.kind === 'intent') reasons.add('intent-owned')
  if (git.head === null || git.trackedChanges === null || git.untrackedFiles === null || git.ignoredAtRisk === null) {
    reasons.add('git-unknown')
  }
  if ((git.trackedChanges ?? 0) > 0 || (git.untrackedFiles ?? 0) > 0) reasons.add('uncommitted-changes')
  if ((git.ignoredAtRisk?.length ?? 0) > 0) reasons.add('ignored-files')
  if (evidence.lastActivityAt !== null && now - evidence.lastActivityAt < RETAINED_WORKTREE_GRACE_MS) reasons.add('recently-active')

  // A merged delivery's commits are on the base even when squash/rebase rewrote them.
  const merged = delivery?.decision === 'merged'
  if (git.branchExists === null) reasons.add('branch-unknown')
  else if (git.branchExists) {
    if (git.unpushedCommits === null) reasons.add('branch-unknown')
    else if (git.unpushedCommits > 0 && !merged) reasons.add('unpushed-commits')
  }
  if (delivery && OPEN_DELIVERY_DECISIONS.has(delivery.decision)) reasons.add('open-delivery')

  const ordered = RETAINED_REASON_ORDER.filter((reason) => reasons.has(reason))
  const removeBlocker = ordered.find((reason) => REMOVE_BLOCKERS.has(reason)) ?? null
  const removable = removeBlocker === null
  return {
    label: ordered.length === 0 ? 'nothing-to-lose' : 'waiting-for-you',
    reasons: ordered,
    removable,
    removeBlocker,
    branchDeletable: removable && git.branchExists === true && ordered.length === 0,
  }
}

/** Whole days since the latest activity (null when unknown). */
export function idleDays(lastActivityAt: number | null, now: number): number | null {
  if (lastActivityAt === null) return null
  return Math.max(0, Math.floor((now - lastActivityAt) / (24 * 60 * 60 * 1000)))
}

export interface PorcelainCounts {
  tracked: number
  untracked: number
  /** Ignored paths as Git printed them (a trailing `/` marks a directory). */
  ignored: string[]
}

/**
 * Parse `git status --porcelain=v1 -z` output. Renames/copies carry their
 * source as an extra NUL-terminated field, which is skipped. Returns null for
 * output Git would never print (so the caller reports `git-unknown`).
 */
export function parsePorcelainZ(stdout: string): PorcelainCounts | null {
  const counts: PorcelainCounts = { tracked: 0, untracked: 0, ignored: [] }
  if (stdout === '') return counts
  if (!stdout.endsWith('\0')) return null
  const fields = stdout.slice(0, -1).split('\0')
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]
    if (entry.length < 4 || entry[2] !== ' ') return null
    const code = entry.slice(0, 2)
    const file = entry.slice(3)
    if (code === '!!') counts.ignored.push(file)
    else if (code === '??') counts.untracked++
    else {
      counts.tracked++
      if (code[0] === 'R' || code[0] === 'C') i++
    }
  }
  return counts
}

/** Escape a branch name for `--exclude=<glob>` so only that branch is excluded. */
export function escapeRefGlob(name: string): string {
  return name.replace(/[*?[\\]/g, (char) => `\\${char}`)
}
