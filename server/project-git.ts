import { execFile } from 'child_process'
import { GIT_EXEC_ENV } from './file-provenance'
import { isValidBranchName } from './integration-branch'

// ─── Project git info + branch switch (Agent-Mode git bar) ────────────────────
//
// Read the repo's current branch / last commit / local branches, and check out
// another LOCAL branch on user request. Always spawns the `git` CLI with the
// hardened env from file-provenance (hostile-repo config stripped, prompts
// disabled) and argv arrays (no shell). The checkout target is validated
// against `git branch` output, so no user string can smuggle flags or refs.

const GIT_TIMEOUT_MS = 10_000
const GIT_MAX_BUFFER = 4 * 1024 * 1024
const COMMIT_SHA_RE = /^[0-9a-f]{40,64}$/i

function git(repoDir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd: repoDir, env: GIT_EXEC_ENV, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message).trim()
          reject(new Error(detail))
          return
        }
        resolve(String(stdout).trim())
      },
    )
  })
}

export interface ProjectWorktree {
  path: string
  /** Branch checked out there; null when detached. */
  branch: string | null
  head: string
  /** True for the repo's main working tree (the project path itself). */
  isMain: boolean
}

export interface ProjectGitInfo {
  /** False when the project path is not inside a git work tree. */
  git: boolean
  /** Current branch name; null while detached or on an unborn/empty repo state. */
  branch: string | null
  detached: boolean
  /** Uncommitted changes present (staged or not). */
  dirty: boolean
  /** Local branch names. */
  branches: string[]
  lastCommit: { hash: string; subject: string; at: string } | null
  /** All working trees (main first) — rails create linked worktrees for
   *  parallel implementation, surfaced by the Mission Control git bar. */
  worktrees: ProjectWorktree[]
}

const NOT_A_REPO: ProjectGitInfo = { git: false, branch: null, detached: false, dirty: false, branches: [], lastCommit: null, worktrees: [] }

/** Parse `git worktree list --porcelain` blocks (blank-line separated). */
export function parseWorktreePorcelain(out: string): ProjectWorktree[] {
  const worktrees: ProjectWorktree[] = []
  for (const block of out.split(/\n\n+/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    let wtPath: string | null = null
    let head = ''
    let branch: string | null = null
    for (const line of lines) {
      if (line.startsWith('worktree ')) wtPath = line.slice('worktree '.length)
      else if (line.startsWith('HEAD ')) head = line.slice('HEAD '.length)
      else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length)
    }
    if (wtPath) worktrees.push({ path: wtPath, branch, head, isMain: worktrees.length === 0 })
  }
  return worktrees
}

async function listLocalBranches(repoDir: string): Promise<string[]> {
  const out = await git(repoDir, ['branch', '--format=%(refname:short)'])
  return out.split('\n').map((b) => b.trim()).filter(Boolean)
}

export type ProjectCheckoutCleanliness =
  | { ok: true; clean: boolean }
  | { ok: false; detail: string }

/** Lossless checkout preflight. Unlike the dashboard-oriented aggregate info,
 * this result is tri-state: an unreadable status is never interpreted as a
 * clean checkout. */
export async function inspectProjectCheckoutCleanliness(repoDir: string): Promise<ProjectCheckoutCleanliness> {
  try {
    const status = await git(repoDir, ['status', '--porcelain', '--untracked-files=all'])
    return { ok: true, clean: status === '' }
  } catch (err) {
    return {
      ok: false,
      detail: `Working tree cleanliness could not be verified: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

export async function getProjectGitInfo(repoDir: string): Promise<ProjectGitInfo> {
  try {
    await git(repoDir, ['rev-parse', '--is-inside-work-tree'])
  } catch {
    return NOT_A_REPO
  }
  // symbolic-ref works on an unborn branch too (fresh `git init`); it fails
  // when HEAD is detached.
  let branch: string | null = null
  let detached = false
  try {
    branch = await git(repoDir, ['symbolic-ref', '--short', 'HEAD'])
  } catch {
    detached = true
  }
  let lastCommit: ProjectGitInfo['lastCommit'] = null
  try {
    const raw = await git(repoDir, ['log', '-1', '--format=%h%s%cI'])
    const [hash, subject, at] = raw.split('')
    if (hash) lastCommit = { hash, subject: subject ?? '', at: at ?? '' }
  } catch {
    /* empty repo — no commits yet */
  }
  let branches: string[] = []
  try {
    branches = await listLocalBranches(repoDir)
  } catch {
    /* keep [] */
  }
  let dirty = false
  try {
    dirty = (await git(repoDir, ['status', '--porcelain'])) !== ''
  } catch {
    /* keep false */
  }
  let worktrees: ProjectWorktree[] = []
  try {
    worktrees = parseWorktreePorcelain(await git(repoDir, ['worktree', 'list', '--porcelain']))
  } catch {
    /* keep [] */
  }
  return { git: true, branch, detached, dirty, branches, lastCommit, worktrees }
}

export type CheckoutResult = { ok: true } | { ok: false; error: string }

/** Compact git's overwrite refusal: the raw message lists EVERY dirty file
 *  (dozens on a busy tree) — unreadable in a toast. Keep the count + a taste. */
export function compactCheckoutError(msg: string): string {
  const lines = msg.split('\n').map((l) => l.trim()).filter(Boolean)
  const idx = lines.findIndex((l) => l.includes('Your local changes to the following files would be overwritten'))
  if (idx === -1) return msg.slice(0, 400)
  const files = lines
    .slice(idx + 1)
    .filter((l) => !l.startsWith('Please ') && !l.startsWith('Aborting') && !l.startsWith('error:') && !l.startsWith('hint:'))
  if (files.length === 0) return msg.slice(0, 400)
  const shown = files.slice(0, 3).join(', ')
  const more = files.length - Math.min(files.length, 3)
  return (
    `Your local changes to ${files.length} file${files.length === 1 ? '' : 's'} would be overwritten by checkout` +
    ` (${shown}${more > 0 ? ` … +${more} more` : ''}). Commit or stash them first.`
  )
}

/** Check out an existing LOCAL branch. The name must match one reported by
 *  `git branch`, so arbitrary flags/refs can never reach the argv. */
export async function checkoutProjectBranch(repoDir: string, branch: string): Promise<CheckoutResult> {
  let branches: string[]
  try {
    branches = await listLocalBranches(repoDir)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'git failed' }
  }
  if (!branches.includes(branch)) {
    return { ok: false, error: `Unknown local branch: ${branch}` }
  }
  try {
    await git(repoDir, ['checkout', branch])
    return { ok: true }
  } catch (err) {
    // Typical: uncommitted changes that would be overwritten — surface git's own
    // reason (compacted: the raw refusal lists every dirty file).
    return { ok: false, error: compactCheckoutError(err instanceof Error ? err.message : 'git checkout failed') }
  }
}

async function remoteBranchExists(repoDir: string, branch: string): Promise<boolean> {
  try {
    await git(repoDir, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])
    return true
  } catch {
    return false
  }
}

/** Checkout a PR/review branch into the user's main repo. Unlike the small
 *  AgentGitBar switcher, this path may materialize a local tracking branch from
 *  `origin/<branch>` because a PR delivery can be remote-only after worktree
 *  cleanup or a fresh clone. When supplied, `expectedSha` is an immutable
 *  delivery lease: a divergent local/remote branch is preserved and checkout
 *  succeeds only when the final branch HEAD equals that exact object. It never
 *  overwrites dirty local work. */
export async function checkoutProjectReviewBranch(
  repoDir: string,
  branch: string,
  expectedSha?: string | null,
): Promise<CheckoutResult> {
  const target = branch.trim()
  if (!isValidBranchName(target)) return { ok: false, error: `Invalid branch name: ${branch}` }
  const expected = expectedSha?.trim().toLowerCase() ?? null
  if (expected !== null && !COMMIT_SHA_RE.test(expected)) {
    return { ok: false, error: 'The verified delivery commit is invalid; checkout was not attempted.' }
  }

  let dirty = false
  try {
    dirty = (await git(repoDir, ['status', '--porcelain'])) !== ''
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'git status failed' }
  }
  if (dirty) return { ok: false, error: 'Working tree has uncommitted changes. Commit or stash them before checkout.' }

  // Best effort: refresh remote-tracking refs before deciding whether a branch
  // can be materialized. Failure degrades to local-only checkout.
  await git(repoDir, ['fetch', 'origin']).catch(() => {})

  let branches: string[]
  try {
    branches = await listLocalBranches(repoDir)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'git failed' }
  }

  try {
    if (branches.includes(target)) {
      if (expected) {
        const localSha = (await git(repoDir, ['rev-parse', '--verify', `refs/heads/${target}`])).toLowerCase()
        if (localSha !== expected) {
          return {
            ok: false,
            error: `Local branch '${target}' points to ${localSha.slice(0, 8)}, not verified delivery ${expected.slice(0, 8)}. It was preserved and not checked out.`,
          }
        }
      }
      await git(repoDir, ['checkout', target])
    } else if (await remoteBranchExists(repoDir, target)) {
      if (expected) {
        const remoteSha = (await git(
          repoDir,
          ['rev-parse', '--verify', `refs/remotes/origin/${target}`],
        )).toLowerCase()
        if (remoteSha !== expected) {
          return {
            ok: false,
            error: `Remote branch 'origin/${target}' points to ${remoteSha.slice(0, 8)}, not verified delivery ${expected.slice(0, 8)}. Checkout was not attempted.`,
          }
        }
      }
      await git(repoDir, ['checkout', '-b', target, '--track', `origin/${target}`])
    } else {
      return { ok: false, error: `Unknown branch: ${target}` }
    }
  } catch (err) {
    return { ok: false, error: compactCheckoutError(err instanceof Error ? err.message : 'git checkout failed') }
  }

  if (expected) {
    try {
      const [currentBranch, currentSha] = await Promise.all([
        git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']),
        git(repoDir, ['rev-parse', '--verify', 'HEAD']),
      ])
      if (currentBranch !== target || currentSha.toLowerCase() !== expected) {
        return {
          ok: false,
          error: `Checkout changed concurrently and did not land on verified delivery ${expected.slice(0, 8)}. No reset or cleanup was performed.`,
        }
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: compactCheckoutError(err instanceof Error ? err.message : 'git checkout verification failed') }
    }
  }

  // A failed ff-only pull should not undo a successful checkout; the branch is
  // already where the user can inspect/fix it. Surface only hard checkout errors.
  await git(repoDir, ['pull', '--ff-only']).catch(() => {})
  return { ok: true }
}
