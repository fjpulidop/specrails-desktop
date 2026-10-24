/**
 * Proactive "Integrate locally" (proactive-local-integration): when the
 * person's checkout of the integration branch has uncommitted work that
 * overlaps the delivery, Specrails saves it as a git stash, advances the
 * branch exactly as before, and re-applies it. Git effects only — the caller
 * owns the repository lock, the decision lease and the durable record.
 *
 * Safety contract (never lose user work):
 *  - the stash is identified by its COMMIT sha, never `stash@{n}`;
 *  - it is re-applied with `git stash apply` (never `pop`) and dropped only
 *    after a clean apply;
 *  - a conflicting apply is rolled back ONLY on the paths the stash itself
 *    carries that were clean right before the apply, so anything else in the
 *    checkout (including newer edits) is untouched — and the stash is kept;
 *  - Specrails overlay / never-stage paths are never stashed or restored.
 */
import * as fs from 'fs'
import * as path from 'path'
import { PR_NEVER_STAGE_PATHSPEC_ROOTS, type GitRunner, type GitResult } from '../../../worktree-manager'
import type { LocalStashRecord } from './rail-pr-store'

export const LOCAL_STASH_MESSAGE_PREFIX = 'specrails: before integrating'
const SHA_RE = /^[0-9a-f]{40,64}$/i
const PATH_CHUNK = 100

/** `specrails: before integrating #12, #13 (<deliveryId>)`. */
export function localStashMessage(ticketIds: readonly number[], deliveryId: string): string {
  const tickets = ticketIds.length > 0 ? ticketIds.map((id) => `#${id}`).join(', ') : 'delivery'
  return `${LOCAL_STASH_MESSAGE_PREFIX} ${tickets} (${deliveryId})`
}

/** The branch the agent resolves a conflicting restore on — never the target itself. */
export function restoreBranchName(sha: string): string {
  return `specrails/restore-local-${sha.slice(0, 8)}`
}

function excludePathspecs(): string[] {
  return PR_NEVER_STAGE_PATHSPEC_ROOTS.map((root) => `:(exclude)${root}`)
}

function literal(p: string): string {
  return `:(top,literal)${p}`
}

function failureText(r: GitResult): string {
  return (r.stderr.trim() || r.stdout.trim()).split('\n')[0] || `exit ${r.code}`
}

async function safeRun(git: GitRunner, args: string[], cwd: string): Promise<GitResult> {
  try {
    return await git.run(args, cwd)
  } catch (err) {
    return { code: 1, stdout: '', stderr: err instanceof Error ? err.message : String(err) }
  }
}

function nulList(stdout: string): string[] {
  return stdout.split('\0').filter(Boolean)
}

/**
 * The person's uncommitted paths (tracked + untracked, never ignored), minus
 * Specrails never-stage roots. Null when status is unavailable.
 */
export async function listUserDirtyPaths(git: GitRunner, repo: string): Promise<string[] | null> {
  const r = await safeRun(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--', '.', ...excludePathspecs()], repo)
  if (r.code !== 0) return null
  const paths: string[] = []
  for (const entry of nulList(r.stdout)) {
    if (entry.length < 4) continue
    paths.push(entry.slice(3))
  }
  return [...new Set(paths)]
}

/** Paths the delivery changes between the current head and the assembled result. */
export async function changedPathsBetween(git: GitRunner, repo: string, from: string, to: string): Promise<string[] | null> {
  const r = await safeRun(git, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'], repo)
  return r.code === 0 ? nulList(r.stdout) : null
}

/** True when a dirty path is (or sits under / above) a path the delivery changes. */
export function pathsOverlap(dirty: readonly string[], changed: readonly string[]): boolean {
  if (dirty.length === 0 || changed.length === 0) return false
  // Case-folded too: a case-insensitive filesystem (macOS/Windows default)
  // collides `Readme.md` with `README.md`.
  const fold = (p: string) => p.toLowerCase()
  const changedSet = new Set(changed.map(fold))
  return dirty.some((raw) => {
    const p = fold(raw)
    if (changedSet.has(p)) return true
    const dir = p.endsWith('/') ? p : `${p}/`
    return changed.some((c) => {
      const f = fold(c)
      return f.startsWith(dir) || p.startsWith(`${f}/`)
    })
  })
}

async function currentBranch(git: GitRunner, repo: string): Promise<string | null> {
  const r = await safeRun(git, ['symbolic-ref', '--quiet', 'HEAD'], repo)
  return r.code === 0 ? r.stdout.trim().replace(/^refs\/heads\//, '') : null
}

async function stashTip(git: GitRunner, repo: string): Promise<string | null> {
  const r = await safeRun(git, ['rev-parse', '--quiet', '--verify', 'refs/stash'], repo)
  const sha = r.code === 0 ? r.stdout.trim() : ''
  return SHA_RE.test(sha) ? sha : null
}

export interface StashListEntry { sha: string; subject: string }

/** `refs/stash` reflog in stash@{n} order (index = n). */
export async function listStashes(git: GitRunner, repo: string): Promise<StashListEntry[] | null> {
  const r = await safeRun(git, ['stash', 'list', '--format=%H%x1f%gs'], repo)
  if (r.code !== 0) return null
  return r.stdout.split('\n').filter(Boolean).map((line) => {
    const [sha, subject = ''] = line.split('\x1f')
    return { sha: sha.trim(), subject }
  })
}

export type SaveLocalChangesResult =
  | { ok: true; record: LocalStashRecord }
  | { ok: false; detail: string }

/**
 * `git stash push --include-untracked` of every non-Specrails change. The new
 * entry is proven by `refs/stash` moving to a commit whose subject carries the
 * delivery id; nothing else is ever inferred from `stash@{0}`.
 */
export async function saveLocalChanges(input: {
  git: GitRunner
  repo: string
  branch: string
  deliveryId: string
  ticketIds: readonly number[]
  now?: () => string
}): Promise<SaveLocalChangesResult> {
  const { git, repo } = input
  const message = localStashMessage(input.ticketIds, input.deliveryId)
  const before = await stashTip(git, repo)
  const pushed = await safeRun(git, ['stash', 'push', '--include-untracked', '-m', message, '--', '.', ...excludePathspecs()], repo)
  const after = await stashTip(git, repo)
  if (!after || after === before) {
    return { ok: false, detail: pushed.code !== 0 ? `saving local changes: ${failureText(pushed)}` : 'saving local changes: git created no stash entry' }
  }
  const subject = await safeRun(git, ['log', '-1', '--format=%s', after], repo)
  if (subject.code !== 0 || !subject.stdout.includes(`(${input.deliveryId})`)) {
    // refs/stash moved but not to our entry (a concurrent external stash):
    // do not guess. The person's changes are in SOME stash; refuse to proceed.
    return { ok: false, detail: 'saving local changes: the new stash entry could not be verified' }
  }
  const at = (input.now ?? (() => new Date().toISOString()))()
  return {
    ok: true,
    record: {
      sha: after, name: message, checkoutPath: repo, branch: input.branch, state: 'saved',
      restoreBranch: null, conflictPaths: [], savedAt: at, updatedAt: at,
    },
  }
}

/** Every path the stash carries: index + worktree changes, and its untracked files. */
export async function stashPaths(git: GitRunner, repo: string, sha: string): Promise<{ tracked: string[]; untracked: Map<string, string> } | null> {
  const worktree = await safeRun(git, ['diff', '--name-only', '-z', '--no-renames', `${sha}^1`, sha, '--'], repo)
  const index = await safeRun(git, ['diff', '--name-only', '-z', '--no-renames', `${sha}^1`, `${sha}^2`, '--'], repo)
  if (worktree.code !== 0 || index.code !== 0) return null
  const untracked = new Map<string, string>()
  const third = await safeRun(git, ['rev-parse', '--quiet', '--verify', `${sha}^3`], repo)
  if (third.code === 0) {
    const tree = await safeRun(git, ['ls-tree', '-r', '-z', `${sha}^3`], repo)
    if (tree.code !== 0) return null
    for (const entry of nulList(tree.stdout)) {
      const tab = entry.indexOf('\t')
      if (tab < 0) continue
      const [, , blob] = entry.slice(0, tab).split(' ')
      untracked.set(entry.slice(tab + 1), blob)
    }
  }
  return { tracked: [...new Set([...nulList(worktree.stdout), ...nulList(index.stdout)])], untracked }
}

async function inChunks(paths: readonly string[], fn: (chunk: string[]) => Promise<GitResult>): Promise<GitResult | null> {
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const r = await fn(paths.slice(i, i + PATH_CHUNK))
    if (r.code !== 0) return r
  }
  return null
}

/** True when the checkout already holds exactly what the stash carries (a
 * crash between a clean apply and the drop). */
async function alreadyApplied(git: GitRunner, repo: string, sha: string, carried: { tracked: string[]; untracked: Map<string, string> }): Promise<boolean> {
  if (carried.tracked.length === 0 && carried.untracked.size === 0) return false
  if (carried.tracked.length > 0) {
    const failed = await inChunks(carried.tracked, (chunk) => safeRun(git, ['diff', '--quiet', sha, '--', ...chunk.map(literal)], repo))
    if (failed) return false
  }
  for (const [file, blob] of carried.untracked) {
    const abs = path.join(repo, file)
    if (!fs.existsSync(abs)) return false
    const hashed = await safeRun(git, ['hash-object', '--', file], repo)
    if (hashed.code !== 0 || hashed.stdout.trim() !== blob) return false
  }
  return true
}

async function dropBySha(git: GitRunner, repo: string, sha: string): Promise<string | null> {
  const list = await listStashes(git, repo)
  const index = list?.findIndex((entry) => entry.sha === sha) ?? -1
  if (index < 0) return null
  const dropped = await safeRun(git, ['stash', 'drop', '--quiet', `stash@{${index}}`], repo)
  return dropped.code === 0 ? null : `dropping restored stash ${sha.slice(0, 8)}: ${failureText(dropped)}`
}

/** Put the given paths back to HEAD: tracked ones from HEAD, the rest removed. */
async function resetPathsToHead(git: GitRunner, repo: string, paths: readonly string[]): Promise<string | null> {
  if (paths.length === 0) return null
  const inHead = new Set<string>()
  for (let i = 0; i < paths.length; i += PATH_CHUNK) {
    const listed = await safeRun(git, ['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...paths.slice(i, i + PATH_CHUNK).map(literal)], repo)
    if (listed.code !== 0) return `restoring the integrated tree: ${failureText(listed)}`
    for (const p of nulList(listed.stdout)) inHead.add(p)
  }
  const tracked = paths.filter((p) => inHead.has(p))
  const extra = paths.filter((p) => !inHead.has(p))
  const checkout = await inChunks(tracked, (chunk) => safeRun(git, ['checkout', 'HEAD', '--', ...chunk.map(literal)], repo))
  if (checkout) return `restoring the integrated tree: ${failureText(checkout)}`
  const unstage = await inChunks(extra, (chunk) => safeRun(git, ['rm', '--cached', '-q', '--ignore-unmatch', '--', ...chunk.map(literal)], repo))
  if (unstage) return `restoring the integrated tree: ${failureText(unstage)}`
  for (const p of extra) {
    const abs = path.join(repo, p)
    try {
      const stat = fs.lstatSync(abs)
      if (!stat.isDirectory()) fs.rmSync(abs, { force: true })
    } catch { /* already absent */ }
  }
  return null
}

export type RestoreLocalChangesResult =
  /** Applied cleanly (or found already applied) and dropped. */
  | { state: 'restored'; warnings: string[] }
  /** The stash entry is gone — the person applied/dropped it themselves. */
  | { state: 'released'; warnings: string[] }
  /** Conflicted: integrated tree restored on the stash's paths, stash KEPT. */
  | { state: 'needs_attention'; conflictPaths: string[]; warnings: string[] }
  /** Not attempted / refused without changing anything; stash KEPT. */
  | { state: 'blocked'; reason: 'wrong_branch' | 'dirty' | 'unavailable'; detail: string; current?: string | null }

/**
 * Re-apply a recorded stash into its checkout. Idempotent: an already-applied
 * stash is just dropped; a missing one is reported `released`.
 */
export async function restoreLocalChanges(git: GitRunner, record: Pick<LocalStashRecord, 'sha' | 'checkoutPath' | 'branch'>): Promise<RestoreLocalChangesResult> {
  const repo = record.checkoutPath
  if (!repo || !fs.existsSync(repo)) return { state: 'blocked', reason: 'unavailable', detail: 'The checkout the changes were saved from no longer exists.' }
  const list = await listStashes(git, repo)
  if (!list) return { state: 'blocked', reason: 'unavailable', detail: 'git stash list failed' }
  if (!list.some((entry) => entry.sha === record.sha)) return { state: 'released', warnings: [] }
  const branch = await currentBranch(git, repo)
  if (branch !== record.branch) {
    return { state: 'blocked', reason: 'wrong_branch', current: branch, detail: `The checkout is on ${branch ?? 'a detached HEAD'}, not ${record.branch}.` }
  }
  const carried = await stashPaths(git, repo, record.sha)
  if (!carried) return { state: 'blocked', reason: 'unavailable', detail: 'The saved changes could not be read.' }
  if (await alreadyApplied(git, repo, record.sha, carried)) {
    const warning = await dropBySha(git, repo, record.sha)
    return { state: 'restored', warnings: warning ? [warning] : [] }
  }
  const carriedPaths = [...new Set([...carried.tracked, ...carried.untracked.keys()])]
  const preDirty = await listUserDirtyPaths(git, repo)
  if (!preDirty) return { state: 'blocked', reason: 'unavailable', detail: 'git status failed' }
  const preDirtySet = new Set(preDirty)
  const busy = carriedPaths.filter((p) => preDirtySet.has(p))
  if (busy.length > 0) {
    // Newer edits sit on the same files: applying would mix them with the
    // saved work and a rollback could not tell them apart. Keep both.
    return { state: 'blocked', reason: 'dirty', detail: `These files changed again since they were saved: ${busy.slice(0, 5).join(', ')}` }
  }
  const applied = await safeRun(git, ['stash', 'apply', '--quiet', record.sha], repo)
  if (applied.code === 0) {
    const warning = await dropBySha(git, repo, record.sha)
    return { state: 'restored', warnings: warning ? [warning] : [] }
  }
  const unmerged = await safeRun(git, ['diff', '--name-only', '-z', '--diff-filter=U'], repo)
  const conflictPaths = unmerged.code === 0 ? nulList(unmerged.stdout) : []
  const postDirty = (await listUserDirtyPaths(git, repo)) ?? []
  const touched = carriedPaths.filter((p) => !preDirtySet.has(p) && (postDirty.includes(p) || conflictPaths.includes(p)))
  if (touched.length === 0 && conflictPaths.length === 0) {
    // Git refused before touching anything (typically: a file the stash
    // would restore as untracked now exists, tracked, in the integrated
    // result). The tree is intact; the stash is kept for a manual resolve.
    const present = carriedPaths.filter((p) => fs.existsSync(path.join(repo, p)))
    return { state: 'needs_attention', conflictPaths: (present.length > 0 ? present : carriedPaths).slice(0, 20), warnings: [] }
  }
  const warnings: string[] = []
  const restoreError = await resetPathsToHead(git, repo, carriedPaths.filter((p) => !preDirtySet.has(p)))
  if (restoreError) warnings.push(restoreError)
  const finalDirty = await listUserDirtyPaths(git, repo)
  if (!finalDirty || finalDirty.length !== preDirty.length || finalDirty.some((p) => !preDirtySet.has(p))) {
    warnings.push('The integrated tree could not be fully restored after the conflicting apply; your saved changes are still in the stash.')
  }
  return { state: 'needs_attention', conflictPaths: (conflictPaths.length > 0 ? conflictPaths : touched).slice(0, 20), warnings }
}

/** Specrails stashes in a repository, keyed by delivery id (from the message). */
export async function findSpecrailsStashes(git: GitRunner, repo: string): Promise<Array<{ sha: string; deliveryId: string; branch: string | null; name: string }>> {
  const list = await listStashes(git, repo)
  if (!list) return []
  const found: Array<{ sha: string; deliveryId: string; branch: string | null; name: string }> = []
  for (const entry of list) {
    // Reflog subject: "On <branch>: <message>" (or "WIP on …").
    const match = /^(?:WIP )?[Oo]n ([^:]+): (specrails: before integrating .*\(([^()\s]+)\))$/.exec(entry.subject)
    if (!match || !SHA_RE.test(entry.sha)) continue
    found.push({ sha: entry.sha, branch: match[1] === '(no branch)' ? null : match[1], name: match[2], deliveryId: match[3] })
  }
  return found
}

/** Fold a restore attempt into the durable record (pure). `blocked` keeps it `saved`. */
export function recordAfterRestore(record: LocalStashRecord, result: RestoreLocalChangesResult, now = new Date().toISOString()): LocalStashRecord {
  if (result.state === 'restored' || result.state === 'released') return { ...record, state: result.state, updatedAt: now }
  if (result.state === 'needs_attention') {
    return { ...record, state: 'needs_attention', restoreBranch: restoreBranchName(record.sha), conflictPaths: result.conflictPaths, updatedAt: now }
  }
  return { ...record, updatedAt: now }
}
