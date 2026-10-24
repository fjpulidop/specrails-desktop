/**
 * Server-side restoration of a conflicting "Integrate locally" stash
 * (proactive-local-integration). Git effects only — the caller owns the
 * repository lock, the durable record and the decision lease.
 *
 * Specrails never delegates these writes to the (read-only) mission agent:
 *  1. `prepareRestoreBranch` cuts `specrails/restore-local-<sha8>` from the
 *     integrated target in a separate worktree and runs `git stash apply <sha>`
 *     there. Specrails-managed generated files take the integrated version;
 *     an untracked-vs-tracked collision is turned into an ordinary two-sided
 *     conflict block so it can be resolved like any other.
 *  2. Remaining conflicts are handed to a write-capable resolver confined to
 *     that worktree (see local-restore-resolver.ts); `commitRestoreBranch`
 *     then verifies no marker/unmerged path is left and commits on the branch.
 *  3. Only the person's click brings it back (`bringBackRestoreBranch`, a
 *     fast-forward of the target) or discards it (`discardRestoreBranch`).
 * The stash itself is never popped, dropped or cleared here.
 */
import * as fs from 'fs'
import * as path from 'path'
import { commitWorktreeAndVerify, createWorktree, type GitRunner } from '../../../worktree-manager'
import {
  failureText, isSpecrailsManagedPath, listUserDirtyPaths, nulList, pathsOverlap,
  resetPathsToHead, restoreBranchName, safeRun, stashPaths, unmergedPaths,
} from './local-stash'
import type { LocalRestoreFileChange } from './rail-pr-store'

const SHA_RE = /^[0-9a-f]{40,64}$/i
const MARKER_RE = /^(?:<{7}|>{7})(?: |$)/m

export function restoreCommitMessage(ticketIds: readonly number[]): string {
  const tickets = ticketIds.length > 0 ? ticketIds.map((id) => `#${id}`).join(', ') : 'the delivery'
  return `Restore local changes from before integrating ${tickets}`
}

/** `<root>/restore-local-<sha8>` — the mount root under the project's worktrees area. */
export function restoreWorktreesRoot(worktreesRoot: string, sha: string): string {
  return path.join(worktreesRoot, `restore-local-${sha.slice(0, 8)}`)
}

async function head(git: GitRunner, cwd: string): Promise<string | null> {
  const r = await safeRun(git, ['rev-parse', '--verify', 'HEAD^{commit}'], cwd)
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return SHA_RE.test(sha) ? sha : null
}

async function branchTip(git: GitRunner, repo: string, branch: string): Promise<string | null> {
  const r = await safeRun(git, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], repo)
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return SHA_RE.test(sha) ? sha : null
}

function readText(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/** Paths whose working copy still carries conflict markers (unreadable ⇒ suspect). */
export function pathsWithMarkers(cwd: string, paths: readonly string[]): string[] {
  return paths.filter((p) => {
    const abs = path.join(cwd, p)
    if (!fs.existsSync(abs)) return false
    try {
      if (!fs.statSync(abs).isFile()) return false
    } catch { return true }
    const text = readText(abs)
    return text === null ? true : MARKER_RE.test(text)
  })
}

export type PrepareRestoreBranchResult =
  | {
    ok: true
    branch: string
    worktreePath: string
    baseSha: string
    /** Conflicts the resolver must handle (empty ⇒ ready to commit). */
    conflictPaths: string[]
    /** Managed generated files that took the integrated version. */
    managedPaths: string[]
  }
  | { ok: false; detail: string; worktreePath?: string; branch: string }

/**
 * Create the restore branch + worktree from `targetBranch` and apply the
 * stash there. Never touches the person's checkout or the target branch.
 */
export async function prepareRestoreBranch(git: GitRunner, input: {
  repo: string
  sha: string
  targetBranch: string
  worktreesRoot: string
  ticketId: number
}): Promise<PrepareRestoreBranchResult> {
  const branch = restoreBranchName(input.sha)
  if (await branchTip(git, input.repo, branch)) {
    // Never borrow (or overwrite) a branch Specrails did not just create.
    return { ok: false, branch, detail: `The branch ${branch} already exists; discard it or rename it, then restore again.` }
  }
  let worktreePath: string
  try {
    const handle = await createWorktree(git, {
      repoDir: input.repo,
      worktreesRoot: restoreWorktreesRoot(input.worktreesRoot, input.sha),
      slug: 'restore-local',
      ticketId: input.ticketId,
      baseRef: input.targetBranch,
      branch,
      fresh: true,
    })
    worktreePath = handle.worktreePath
  } catch (err) {
    return { ok: false, branch, detail: err instanceof Error ? err.message : String(err) }
  }
  const baseSha = await head(git, worktreePath)
  if (!baseSha) return { ok: false, branch, worktreePath, detail: 'The restore worktree has no readable HEAD.' }
  const carried = await stashPaths(git, input.repo, input.sha)
  if (!carried) return { ok: false, branch, worktreePath, detail: 'The saved changes could not be read.' }

  // Untracked files of the stash that the integrated tree now tracks make
  // `git stash apply` refuse outright. In this disposable worktree, set the
  // integrated copy aside, apply, then write both sides as a conflict block.
  const collisions = new Map<string, string>()
  for (const file of carried.untracked.keys()) {
    const abs = path.join(worktreePath, file)
    if (!fs.existsSync(abs)) continue
    const text = readText(abs)
    if (text === null) return { ok: false, branch, worktreePath, detail: `Cannot read ${file} in the restore worktree.` }
    collisions.set(file, text)
    fs.rmSync(abs, { force: true })
  }
  const applied = await safeRun(git, ['stash', 'apply', '--quiet', input.sha], worktreePath)
  const unmerged = await unmergedPaths(git, worktreePath)
  if (!unmerged) return { ok: false, branch, worktreePath, detail: 'git could not list conflicts in the restore worktree.' }
  if (applied.code !== 0 && unmerged.length === 0) {
    return { ok: false, branch, worktreePath, detail: `Applying the saved changes failed: ${failureText(applied)}` }
  }
  const collided: string[] = []
  for (const [file, integrated] of collisions) {
    const abs = path.join(worktreePath, file)
    const local = readText(abs)
    if (local === null || local === integrated) {
      fs.writeFileSync(abs, integrated)
      continue
    }
    if (isSpecrailsManagedPath(file)) {
      fs.writeFileSync(abs, integrated)
      continue
    }
    const nl = (s: string) => s.endsWith('\n') ? s : `${s}\n`
    fs.writeFileSync(abs, `<<<<<<< integrated (${input.targetBranch})\n${nl(integrated)}=======\n${nl(local)}>>>>>>> local changes\n`)
    collided.push(file)
  }
  const managedUnmerged = unmerged.filter(isSpecrailsManagedPath)
  const managedCollided = [...collisions.keys()].filter((f) => isSpecrailsManagedPath(f))
  if (managedUnmerged.length > 0) {
    const settled = await resetPathsToHead(git, worktreePath, managedUnmerged)
    if (settled) return { ok: false, branch, worktreePath, detail: settled }
  }
  const remaining = [...new Set([...unmerged.filter((p) => !isSpecrailsManagedPath(p)), ...collided])]
  return {
    ok: true, branch, worktreePath, baseSha,
    conflictPaths: remaining.slice(0, 20),
    managedPaths: [...new Set([...managedUnmerged, ...managedCollided])].slice(0, 50),
  }
}

export async function restoreFileChanges(git: GitRunner, cwd: string, from: string, to: string): Promise<LocalRestoreFileChange[]> {
  const r = await safeRun(git, ['diff', '--numstat', '-z', '--no-renames', from, to, '--'], cwd)
  if (r.code !== 0) return []
  const files: LocalRestoreFileChange[] = []
  for (const entry of nulList(r.stdout)) {
    const [added, removed, ...rest] = entry.split('\t')
    const file = rest.join('\t')
    if (!file) continue
    files.push({ path: file, added: /^\d+$/.test(added) ? Number(added) : null, removed: /^\d+$/.test(removed) ? Number(removed) : null })
    if (files.length >= 50) break
  }
  return files
}

export type CommitRestoreBranchResult =
  | { ok: true; commitSha: string; files: LocalRestoreFileChange[] }
  | { ok: false; detail: string; conflictPaths?: string[] }

/**
 * Verify the restore worktree is still on its branch with no conflict left,
 * then commit whatever is not committed yet (the resolver may already have).
 */
export async function commitRestoreBranch(git: GitRunner, input: {
  worktreePath: string
  branch: string
  baseSha: string
  conflictPaths: readonly string[]
  message: string
}): Promise<CommitRestoreBranchResult> {
  const { worktreePath } = input
  if (!fs.existsSync(worktreePath)) return { ok: false, detail: 'The restore worktree no longer exists.' }
  const on = await safeRun(git, ['symbolic-ref', '--quiet', 'HEAD'], worktreePath)
  if (on.code !== 0 || on.stdout.trim() !== `refs/heads/${input.branch}`) {
    return { ok: false, detail: `The restore worktree is no longer on ${input.branch}.` }
  }
  const tip = await head(git, worktreePath)
  if (!tip) return { ok: false, detail: 'The restore worktree has no readable HEAD.' }
  const ancestry = await safeRun(git, ['merge-base', '--is-ancestor', input.baseSha, tip], worktreePath)
  if (ancestry.code !== 0) return { ok: false, detail: `${input.branch} no longer descends from the integrated target.` }
  // A resolved-but-unstaged path is still "unmerged" in the index: the
  // working copy (no markers) is what counts, then it is staged.
  const before = await unmergedPaths(git, worktreePath)
  if (!before) return { ok: false, detail: 'git could not list conflicts in the restore worktree.' }
  const marked = pathsWithMarkers(worktreePath, [...new Set([...input.conflictPaths, ...before])])
  if (marked.length > 0) {
    return { ok: false, detail: 'Conflict markers are still present.', conflictPaths: marked.slice(0, 20) }
  }
  if (before.length > 0) {
    const staged = await safeRun(git, ['add', '-A', '--', ...before.map((p) => `:(top,literal)${p}`)], worktreePath)
    if (staged.code !== 0) return { ok: false, detail: `Staging resolved files: ${failureText(staged)}` }
  }
  const unmerged = await unmergedPaths(git, worktreePath)
  if (!unmerged || unmerged.length > 0) {
    return { ok: false, detail: 'Unmerged paths remain.', conflictPaths: (unmerged ?? before).slice(0, 20) }
  }
  const committed = await commitWorktreeAndVerify(git, worktreePath, input.message)
  if (committed.error || !committed.clean) {
    return { ok: false, detail: `Committing the restored changes: ${committed.error ?? committed.dirty.slice(0, 5).join(', ')}` }
  }
  const commitSha = await head(git, worktreePath)
  if (!commitSha) return { ok: false, detail: 'The restore commit could not be read.' }
  return { ok: true, commitSha, files: await restoreFileChanges(git, worktreePath, input.baseSha, commitSha) }
}

export type BringBackResult =
  | { ok: true; commitSha: string; warnings: string[] }
  | { ok: false; reason: 'wrong_branch' | 'dirty' | 'branch_changed' | 'target_conflict' | 'unavailable'; detail: string; current?: string | null }

/**
 * Fast-forward the person's target checkout to the reviewed restore commit.
 * When the target moved meanwhile, the target is merged INTO the restore
 * branch first (in its worktree; aborted on conflict) so the target itself
 * only ever fast-forwards. Overlapping uncommitted edits refuse.
 */
export async function bringBackRestoreBranch(git: GitRunner, input: {
  checkout: string
  repo: string
  targetBranch: string
  branch: string
  worktreePath: string
  commitSha: string
}): Promise<BringBackResult> {
  const { checkout } = input
  if (!fs.existsSync(checkout)) return { ok: false, reason: 'unavailable', detail: 'The checkout no longer exists.' }
  const on = await safeRun(git, ['symbolic-ref', '--quiet', 'HEAD'], checkout)
  const current = on.code === 0 ? on.stdout.trim().replace(/^refs\/heads\//, '') : null
  if (current !== input.targetBranch) {
    return { ok: false, reason: 'wrong_branch', current, detail: `The checkout is on ${current ?? 'a detached HEAD'}, not ${input.targetBranch}.` }
  }
  const tip = await branchTip(git, input.repo, input.branch)
  if (tip !== input.commitSha) {
    return { ok: false, reason: 'branch_changed', detail: `${input.branch} changed since it was prepared; review it again.` }
  }
  const targetHead = await head(git, checkout)
  if (!targetHead) return { ok: false, reason: 'unavailable', detail: 'The target branch has no readable HEAD.' }
  let commitSha = input.commitSha
  const ff = await safeRun(git, ['merge-base', '--is-ancestor', targetHead, commitSha], checkout)
  if (ff.code !== 0) {
    if (!fs.existsSync(input.worktreePath)) {
      return { ok: false, reason: 'target_conflict', detail: `${input.targetBranch} moved and the restore worktree is gone.` }
    }
    const merged = await safeRun(git, ['merge', '--no-edit', '--no-ff', input.targetBranch], input.worktreePath)
    if (merged.code !== 0) {
      await safeRun(git, ['merge', '--abort'], input.worktreePath)
      return { ok: false, reason: 'target_conflict', detail: `${input.targetBranch} moved and no longer merges cleanly with ${input.branch}.` }
    }
    const next = await head(git, input.worktreePath)
    if (!next) return { ok: false, reason: 'unavailable', detail: 'The merged restore commit could not be read.' }
    commitSha = next
  }
  const changed = await safeRun(git, ['diff', '--name-only', '-z', '--no-renames', targetHead, commitSha, '--'], checkout)
  const dirty = await listUserDirtyPaths(git, checkout)
  if (changed.code !== 0 || !dirty) return { ok: false, reason: 'unavailable', detail: 'git could not compare the checkout.' }
  if (pathsOverlap(dirty, nulList(changed.stdout))) {
    return { ok: false, reason: 'dirty', detail: 'Files the restored changes touch have uncommitted edits in the checkout.' }
  }
  const advanced = await safeRun(git, ['merge', '--ff-only', '--no-overwrite-ignore', commitSha], checkout)
  if (advanced.code !== 0) {
    return { ok: false, reason: /would be overwritten|local changes|untracked working tree/i.test(`${advanced.stderr}\n${advanced.stdout}`) ? 'dirty' : 'unavailable', detail: failureText(advanced) }
  }
  return { ok: true, commitSha, warnings: await removeRestoreBranch(git, input.repo, input.worktreePath, input.branch, false) }
}

/**
 * Unmount the restore worktree and delete its branch. `force` (the person's
 * explicit discard) also drops unmerged work on it; otherwise only a merged
 * branch is deleted (`branch -d`). Returns warnings; never throws.
 */
export async function removeRestoreBranch(git: GitRunner, repo: string, worktreePath: string, branch: string, force: boolean): Promise<string[]> {
  const warnings: string[] = []
  if (worktreePath && fs.existsSync(worktreePath)) {
    const removed = await safeRun(git, ['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], repo)
    if (removed.code !== 0) warnings.push(`restore worktree ${worktreePath}: ${failureText(removed)}`)
  }
  await safeRun(git, ['worktree', 'prune'], repo)
  if (await branchTip(git, repo, branch)) {
    const deleted = await safeRun(git, ['branch', force ? '-D' : '-d', branch], repo)
    if (deleted.code !== 0) warnings.push(`restore branch ${branch}: ${failureText(deleted)}`)
  }
  return warnings
}
