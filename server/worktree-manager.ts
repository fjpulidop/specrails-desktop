/**
 * Git worktree lifecycle for parallel-rail isolation. Each isolated ticket run
 * gets its own worktree on its own branch off the integration base, so
 * concurrent AI CLIs never collide on a shared working tree; the merge-manager
 * later integrates the branches back. The caller passes the conventional
 * branch name (`<type>/<ref>-<kebab-title>`, see pr-naming.ts); when absent
 * the legacy `sr/<slug>/ticket-<id>` fallback is used.
 *
 * All git I/O goes through an injectable `GitRunner` so the logic is unit-tested
 * without a real repository. Worktrees live under `$HOME` (never in the repo) and
 * share the repo's `.git`/object-store (the established `.claude/worktrees/**`
 * carve-out). The per-run workspace OVERLAY for relocated projects is assembled by
 * the caller (workspace-manager) — this module owns only the git worktree.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import { windowsSpawnEnv } from './util/win-spawn'

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
      // SystemRoot/ComSpec backfill so worktree + PR-decision git ops don't fail
      // to start under a pkg-stripped Windows sidecar env. No-op on POSIX.
      const env = windowsSpawnEnv()
      execFile('git', args, { cwd, env, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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

/** Legacy fallback branch name for a ticket's isolated run (used only when the
 *  caller does not pass a conventional preferred name — see pr-naming.ts). */
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
  /** Preferred branch name (conventional `<type>/<ref>-<kebab-title>` from
   *  pr-naming). Absent → legacy `sr/<slug>/ticket-<id>` fallback, so other
   *  callers keep their byte-identical behaviour. */
  branch?: string
  /** For active-PR continuation only: safely fast-forward an existing local
   *  branch/worktree from `baseRef` before the run starts. Never rewrites
   *  diverged or locally-ahead branches. */
  refreshFromBaseRef?: boolean
}

export interface WorktreeHandle {
  branch: string
  worktreePath: string
}

export const PR_NEVER_STAGE_PATHS = [
  '.claude/agent-memory',
  '.claude/agent-memory/**',
  '.claude/agent-memory/explanations',
  '.claude/agent-memory/explanations/**',
  '.codex/agent-memory',
  '.codex/agent-memory/**',
  '.codex/agent-memory/explanations',
  '.codex/agent-memory/explanations/**',
  '.gemini/agent-memory',
  '.gemini/agent-memory/**',
  '.gemini/agent-memory/explanations',
  '.gemini/agent-memory/explanations/**',
] as const

const PR_NEVER_STAGE_EXCLUDE_MARKER_BEGIN = '# specrails: never stage private agent artifacts'
const PR_NEVER_STAGE_EXCLUDE_MARKER_END = '# /specrails: never stage private agent artifacts'
const PR_NEVER_STAGE_EXCLUDE_BLOCK = [
  PR_NEVER_STAGE_EXCLUDE_MARKER_BEGIN,
  ...PR_NEVER_STAGE_PATHS,
  PR_NEVER_STAGE_EXCLUDE_MARKER_END,
].join('\n')

export async function ensurePrNeverStageExcludes(git: GitRunner, worktreePath: string): Promise<void> {
  const resolved = await git.run(['rev-parse', '--git-path', 'info/exclude'], worktreePath).catch(() => null)
  if (!resolved || resolved.code !== 0) return
  const rawPath = resolved.stdout.trim()
  if (!rawPath) return
  const excludePath = path.isAbsolute(rawPath) ? rawPath : path.join(worktreePath, rawPath)
  try {
    await fs.promises.mkdir(path.dirname(excludePath), { recursive: true })
    const current = await fs.promises.readFile(excludePath, 'utf8').catch(() => '')
    const blockRe = new RegExp(`\\n?${escapeRegExp(PR_NEVER_STAGE_EXCLUDE_MARKER_BEGIN)}[\\s\\S]*?${escapeRegExp(PR_NEVER_STAGE_EXCLUDE_MARKER_END)}\\n?`, 'g')
    const cleaned = current.replace(blockRe, '').replace(/\s+$/, '')
    const next = `${cleaned}${cleaned ? '\n\n' : ''}${PR_NEVER_STAGE_EXCLUDE_BLOCK}\n`
    if (next !== current) await fs.promises.writeFile(excludePath, next)
  } catch {
    // Best-effort only: commitWorktree still applies explicit pathspec excludes.
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function fastForwardExistingBranch(
  git: GitRunner,
  repoDir: string,
  branch: string,
  baseRef: string | undefined,
  mountedWorktreePath?: string,
): Promise<void> {
  if (!baseRef) return
  if (mountedWorktreePath) {
    const ancestor = await git.run(['merge-base', '--is-ancestor', 'HEAD', baseRef], mountedWorktreePath)
    if (ancestor.code !== 0) return
    await git.run(['merge', '--ff-only', baseRef], mountedWorktreePath).catch(() => {})
    return
  }

  const localRef = `refs/heads/${branch}`
  const ancestor = await git.run(['merge-base', '--is-ancestor', localRef, baseRef], repoDir)
  if (ancestor.code !== 0) return
  await git.run(['update-ref', localRef, baseRef], repoDir).catch(() => {})
}

/**
 * Create a fresh worktree+branch for a ticket. Idempotent-ish: if the branch
 * already exists it is reused with `-B`. Throws on git failure so the caller can
 * fall back to the shared-cwd path for that ticket.
 */
export async function createWorktree(git: GitRunner, input: CreateWorktreeInput): Promise<WorktreeHandle> {
  const branch = input.branch ?? worktreeBranch(input.slug, input.ticketId)
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
    // The still-mounted worktree may be checked out on a DIFFERENT branch than
    // the caller's preferred name (the path is keyed by ticketId only, so a
    // stale mount from a prior run of the same ticket collides here). The
    // handle MUST report the branch that will actually carry the run's commits
    // — reporting the caller's preferred name recorded a branch that never
    // existed, so the later `git push` had no ref and the PR delivery wedged
    // at local-only. Detached HEAD / a git failure falls back to the input.
    const head = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], wt)
    const actual = head.code === 0 ? head.stdout.trim() : ''
    const actualBranch = actual && actual !== 'HEAD' ? actual : branch
    if (input.refreshFromBaseRef && actualBranch === branch) {
      await fastForwardExistingBranch(git, input.repoDir, branch, input.baseRef, wt)
    }
    await ensurePrNeverStageExcludes(git, wt)
    return { branch: actualBranch, worktreePath: wt }
  }
  const hasBranch = (await git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], input.repoDir)).code === 0
  if (hasBranch && input.refreshFromBaseRef) {
    await fastForwardExistingBranch(git, input.repoDir, branch, input.baseRef)
  }
  const args = hasBranch
    ? ['worktree', 'add', wt, branch]
    : ['worktree', 'add', '-b', branch, wt, base]
  const res = await git.run(args, input.repoDir)
  if (res.code !== 0) {
    throw new Error(`git worktree add failed for ${branch}: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`)
  }
  await ensurePrNeverStageExcludes(git, wt)
  return { branch, worktreePath: wt }
}

/**
 * Commit the worktree's current changes to its branch so the work is durable in
 * git — it survives worktree removal, is mergeable by the merge-back, and lets a
 * re-launched rail resume from it. No-op (the commit just exits non-zero) when
 * there is nothing to commit. Best-effort: never throws.
 *
 * `excludePaths` (worktree-relative, POSIX separators) are skipped via
 * `:(exclude)` pathspecs — the per-run overlay (worktree-overlay.ts) threads its
 * app-owned scaffolding (framework symlinks, `.mcp.json` copy, manifest) here so
 * it NEVER lands on the ticket branch / PR. All excluded paths are untracked by
 * construction (the overlay only creates entries the checkout lacked), so
 * excluding them can never drop real work.
 */
export async function commitWorktree(git: GitRunner, worktreePath: string, message: string, excludePaths: string[] = []): Promise<void> {
  const allExcludePaths = [...PR_NEVER_STAGE_PATHS, ...excludePaths]
  const addArgs = ['add', '-A', '--', '.', ...allExcludePaths.map((p) => `:(exclude)${p}`)]
  await git.run(addArgs, worktreePath).catch(() => {})
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

/** Every local branch name (`git for-each-ref refs/heads/`) — the collision
 *  input for conventional branch naming. A git failure returns an empty set
 *  (the caller then trusts the preferred names; worktree add still guards). */
export async function listLocalBranches(git: GitRunner, repoDir: string): Promise<Set<string>> {
  const res = await git.run(['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], repoDir)
  if (res.code !== 0) return new Set()
  return new Set(
    res.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  )
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
