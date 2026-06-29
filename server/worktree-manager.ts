/**
 * Git worktree lifecycle for parallel-rail isolation. Each isolated ticket run
 * gets its own worktree on branch `sr/<slug>/ticket-<id>` off the repo HEAD, so
 * concurrent AI CLIs never collide on a shared working tree; the merge-manager
 * later integrates the branches back.
 *
 * All git I/O goes through an injectable `GitRunner` so the logic is unit-tested
 * without a real repository. Worktrees live under `$HOME` (never in the repo) and
 * share the repo's `.git`/object-store (the established `.claude/worktrees/**`
 * carve-out). The per-run workspace OVERLAY for relocated projects is assembled by
 * the caller (workspace-manager) — this module owns only the git worktree.
 */
import { execFile } from 'child_process'
import * as path from 'path'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/** Injectable git executor. The default shells out to the system `git`. */
export interface GitRunner {
  run(args: string[], cwd: string): Promise<GitResult>
}

export const defaultGitRunner: GitRunner = {
  run(args, cwd) {
    return new Promise<GitResult>((resolve) => {
      execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
        resolve({ code, stdout: stdout?.toString() ?? '', stderr: stderr?.toString() ?? '' })
      })
    })
  },
}

/** True when `dir` is inside a git working tree. Worktree isolation is impossible
 *  without git, so the caller falls back to the shared cwd + tells the user. */
export async function isGitRepo(git: GitRunner, dir: string): Promise<boolean> {
  const r = await git.run(['rev-parse', '--is-inside-work-tree'], dir)
  return r.code === 0 && r.stdout.trim() === 'true'
}

/**
 * Whether a repo can be worktree-isolated:
 *  - `no-git`     → not a git working tree.
 *  - `no-commits` → a git repo with an UNBORN HEAD (no commits yet) — `git
 *    worktree add … HEAD` fails ("invalid reference: HEAD"), so isolation is
 *    impossible until there's an initial commit.
 *  - `ok`         → has a resolvable HEAD; safe to branch worktrees from it.
 */
export async function repoIsolationStatus(git: GitRunner, dir: string): Promise<'ok' | 'no-git' | 'no-commits'> {
  if (!(await isGitRepo(git, dir))) return 'no-git'
  const head = await git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], dir)
  return head.code === 0 ? 'ok' : 'no-commits'
}

/** Stable branch name for a ticket's isolated run. */
export function worktreeBranch(slug: string, ticketId: number): string {
  return `sr/${slug}/ticket-${ticketId}`
}

/** Absolute worktree path for a ticket (under the per-project $HOME area). */
export function worktreePath(worktreesRoot: string, ticketId: number): string {
  return path.join(worktreesRoot, `ticket-${ticketId}`)
}

export interface CreateWorktreeInput {
  repoDir: string
  worktreesRoot: string
  slug: string
  ticketId: number
  /** Base ref the worktree branches from (default the repo's current HEAD). */
  baseRef?: string
}

export interface WorktreeHandle {
  branch: string
  worktreePath: string
}

/**
 * Create a fresh worktree+branch for a ticket. Idempotent-ish: if the branch
 * already exists it is reused with `-B`. Throws on git failure so the caller can
 * fall back to the shared-cwd path for that ticket.
 */
export async function createWorktree(git: GitRunner, input: CreateWorktreeInput): Promise<WorktreeHandle> {
  const branch = worktreeBranch(input.slug, input.ticketId)
  const wt = worktreePath(input.worktreesRoot, input.ticketId)
  const base = input.baseRef ?? 'HEAD'

  // RESUME-AWARE (idempotency): a re-launched rail must pick up the partial work
  // from a prior stopped run, NEVER wipe it. So:
  //  1. worktree still checked out → reuse it as-is.
  //  2. branch exists (worktree was cleaned but its commits were kept) → re-check
  //     it out into a worktree (resume from the committed partial work).
  //  3. neither → create a fresh branch off base.
  const existing = await listWorktrees(git, input.repoDir)
  if (existing.some((p) => path.resolve(p) === path.resolve(wt))) {
    return { branch, worktreePath: wt }
  }
  const hasBranch = (await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], input.repoDir)).code === 0
  const args = hasBranch
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, base]
  const res = await git.run(args, input.repoDir)
  if (res.code !== 0) {
    throw new Error(`git worktree add failed for ${branch}: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`)
  }
  return { branch, worktreePath: wt }
}

/**
 * Commit the worktree's current changes to its branch so the work is durable in
 * git — it survives worktree removal, is mergeable by the merge-back, and lets a
 * re-launched rail resume from it. No-op (the commit just exits non-zero) when
 * there is nothing to commit. Best-effort: never throws.
 */
export async function commitWorktree(git: GitRunner, worktreePath: string, message: string): Promise<void> {
  await git.run(['add', '-A'], worktreePath).catch(() => {})
  await git.run(['commit', '-m', message], worktreePath).catch(() => {})
}

export interface RemoveWorktreeInput {
  repoDir: string
  worktreePath: string
  branch: string
  /** Also delete the branch (default true — set false to keep a needs-review branch). */
  deleteBranch?: boolean
}

/** Remove a worktree (force) and optionally delete its branch. Best-effort — a
 *  failure here must never break the run; it is swept again at startup. */
export async function removeWorktree(git: GitRunner, input: RemoveWorktreeInput): Promise<void> {
  await git.run(['worktree', 'remove', '--force', input.worktreePath], input.repoDir)
  if (input.deleteBranch !== false) {
    await git.run(['branch', '-D', input.branch], input.repoDir)
  }
}

/** Parse `git worktree list --porcelain` into the worktree paths it reports
 *  (excluding the main working tree, which is `repoDir` itself). */
export async function listWorktrees(git: GitRunner, repoDir: string): Promise<string[]> {
  const res = await git.run(['worktree', 'list', '--porcelain'], repoDir)
  if (res.code !== 0) return []
  const paths: string[] = []
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      const p = line.slice('worktree '.length).trim()
      if (p && path.resolve(p) !== path.resolve(repoDir)) paths.push(p)
    }
  }
  return paths
}
