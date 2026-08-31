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

const GIT_RUNNER_TIMEOUT_MS = 120_000

export const defaultGitRunner: GitRunner = {
  run(args, cwd) {
    return new Promise<GitResult>((resolve) => {
      // SystemRoot/ComSpec backfill so worktree + PR-decision git ops don't fail
      // to start under a pkg-stripped Windows sidecar env. No-op on POSIX.
      const env = windowsSpawnEnv()
      execFile('git', args, {
        cwd,
        env,
        timeout: GIT_RUNNER_TIMEOUT_MS,
        killSignal: 'SIGTERM',
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
      }, (err, stdout, stderr) => {
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
  /** True only when this call mounted the linked worktree. A reused mount is
   *  borrowed state and must not be torn down by allocation rollback. */
  worktreeCreated?: boolean
  /** True only when this call created the branch ref. Existing/resumed/PR
   *  branches are borrowed and must never be deleted by allocation rollback. */
  branchCreated?: boolean
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
  '.kimi-code/agent-memory',
  '.kimi-code/agent-memory/**',
  '.kimi-code/agent-memory/explanations',
  '.kimi-code/agent-memory/explanations/**',
  // The relocated workspace root. The Revision gate harvests reviewer scores
  // from `.specrails/agent-memory/explanations/`, so that dir now materializes
  // inside the worktree — it is private evidence, never PR content.
  '.specrails/agent-memory',
  '.specrails/agent-memory/**',
  '.specrails/agent-memory/explanations',
  '.specrails/agent-memory/explanations/**',
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
 * Create a fresh worktree+branch for a ticket. Idempotent-ish: an existing
 * branch or mount is resumed without rewriting it. Throws on git failure; only
 * callers creating fresh work may choose shared cwd. PR continuations must fail
 * closed because shared cwd cannot guarantee branch identity.
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
    return { branch: actualBranch, worktreePath: wt, worktreeCreated: false, branchCreated: false }
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
  return { branch, worktreePath: wt, worktreeCreated: true, branchCreated: !hasBranch }
}

export interface CommitWorktreeResult {
  /** `git add` accepted the deliverable pathspecs. */
  staged: boolean
  /** `git commit` created a commit. False is valid when there was nothing new. */
  committed: boolean
  /** No deliverable tracked/untracked changes remain after the commit attempt. */
  clean: boolean
  /** Porcelain status lines for deliverable paths still dirty after commit. */
  dirty: string[]
  /** Human-readable git failure, including index audit/reset failures. */
  error?: string
}

function gitFailure(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback
}

function thrownGitFailure(err: unknown): GitResult {
  return {
    code: 1,
    stdout: '',
    stderr: err instanceof Error ? err.message : String(err),
  }
}

async function gitRun(git: GitRunner, args: string[], cwd: string): Promise<GitResult> {
  try {
    return await git.run(args, cwd)
  } catch (err) {
    return thrownGitFailure(err)
  }
}

function commitPathspecs(excludePaths: string[]): string[] {
  return [
    '--', '.',
    ...PR_NEVER_STAGE_PATHSPEC_ROOTS.map((p) => `:(exclude)${p}`),
    // Overlay names originate in the workspace filesystem. Treat them as
    // literal top-level paths so glob/pathspec metacharacters cannot broaden
    // the never-commit surface.
    ...excludePaths.map((p) => `:(top,exclude,literal)${p}`),
  ]
}

const INDEX_AUDIT_ARGS = [
  'diff', '--cached', '--name-only', '--no-renames', '-z',
  '--diff-filter=ACDMRTUXB', '--',
] as const

const PR_NEVER_STAGE_ROOTS = [...new Set(
  PR_NEVER_STAGE_PATHS.map((entry) => entry.endsWith('/**') ? entry.slice(0, -3) : entry),
)]

function normalizedGitPath(value: string): string {
  return path.sep === '\\' ? value.replaceAll('\\', '/') : value
}

function isPathAtOrBelow(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`)
}

/**
 * Collapse a path list to its minimal roots — drop any entry that is at or
 * below another. Overlay-owned entries like `.claude/agent-memory` are
 * SYMLINKS (the overlay links shared memory in). A git pathspec that descends
 * INTO a symlink — `:(exclude).claude/agent-memory/**` or the `/explanations`
 * subpaths — is rejected with `fatal: pathspec ... is beyond a symbolic link`,
 * which aborts the entire `git add`/`git status` and blocks PR delivery. The
 * symlink ROOT alone (`:(exclude).claude/agent-memory`) still excludes all of
 * its contents (dir-level pathspec semantics) without traversing the link, and
 * is equally correct for the copy-fallback case where it is a real directory.
 */
function minimalPathRoots(paths: readonly string[]): string[] {
  const norm = [...new Set(paths.map((p) => (p.endsWith('/**') ? p.slice(0, -3) : p)))]
  return norm.filter((p) => !norm.some((other) => other !== p && isPathAtOrBelow(p, other)))
}

/** Symlink-safe never-stage pathspec roots (see {@link minimalPathRoots}). */
export const PR_NEVER_STAGE_PATHSPEC_ROOTS = minimalPathRoots(PR_NEVER_STAGE_PATHS)

function forbiddenStagedPaths(staged: string[], excludePaths: string[]): string[] {
  const overlayRoots = excludePaths.map(normalizedGitPath).filter(Boolean)
  return staged.filter((candidate) => (
    PR_NEVER_STAGE_ROOTS.some((root) => isPathAtOrBelow(candidate, root))
    || overlayRoots.some((root) => isPathAtOrBelow(candidate, root))
  ))
}

function parseNulTerminatedPaths(result: GitResult, phase: string): { paths: string[]; error?: undefined } | { paths: []; error: string } {
  if (result.code !== 0) {
    return { paths: [], error: `${phase}: ${gitFailure(result, `git diff failed with exit ${result.code}`)}` }
  }
  if (result.stdout === '') return { paths: [] }
  if (!result.stdout.endsWith('\0')) {
    return { paths: [], error: `${phase}: git returned a malformed non-NUL-terminated path list` }
  }
  const paths = result.stdout.slice(0, -1).split('\0')
  if (paths.some((entry) => entry.length === 0)) {
    return { paths: [], error: `${phase}: git returned a malformed path list containing an empty entry` }
  }
  return { paths }
}

async function auditStagedPaths(
  git: GitRunner,
  worktreePath: string,
  excludePaths: string[],
  phase: string,
): Promise<{ forbidden: string[]; error?: undefined } | { forbidden: []; error: string }> {
  const result = await gitRun(git, [...INDEX_AUDIT_ARGS], worktreePath)
  const parsed = parseNulTerminatedPaths(result, phase)
  if (parsed.error) return { forbidden: [], error: parsed.error }
  return { forbidden: forbiddenStagedPaths(parsed.paths, excludePaths) }
}

function forbiddenResetPathspecs(excludePaths: string[]): string[] {
  return [
    '--',
    ...PR_NEVER_STAGE_ROOTS.map((entry) => `:(top,literal)${entry}`),
    ...excludePaths.map(normalizedGitPath).filter(Boolean).map((entry) => `:(top,literal)${entry}`),
  ]
}

function describeForbiddenPaths(paths: string[]): string {
  const shown = paths.slice(0, 5).map((entry) => JSON.stringify(entry)).join(', ')
  return paths.length > 5 ? `${shown}, and ${paths.length - 5} more` : shown
}

/**
 * Commit the worktree's current deliverable changes to its branch and verify
 * that no deliverable local modifications remain. Excluded overlay/private
 * agent paths may stay untracked in the worktree because they must never land on
 * the ticket branch or PR.
 */
export async function commitWorktreeAndVerify(
  git: GitRunner,
  worktreePath: string,
  message: string,
  excludePaths: string[] = []
): Promise<CommitWorktreeResult> {
  const pathspecs = commitPathspecs(excludePaths)
  // The add is deliberately PLAIN — no exclude pathspecs. `git add` exits 1
  // with "The following paths are ignored by one of your .gitignore files"
  // whenever ANY pathspec item (exclude items included) names a git-ignored
  // path, and our own info/exclude block (ensurePrNeverStageExcludes) plus repo
  // .gitignore entries (e.g. `.claude/settings.local.json`) make exactly the
  // excluded paths ignored. Ignored paths can never be staged without `-f`, so
  // the plain add is safe for them; non-ignored overlay files DO get staged
  // here and are unstaged by the audit → reset flow below before the commit,
  // whose `--only` pathspecs (which git commit accepts without the
  // ignored-path check) remain the authoritative exclusion.
  const add = await gitRun(git, ['add', '-A', '--', '.'], worktreePath)
  let indexSafe = false
  let indexError: string | undefined
  if (add.code === 0) {
    const initialAudit = await auditStagedPaths(
      git, worktreePath, excludePaths, 'git index audit failed before commit',
    )
    if (initialAudit.error) {
      indexError = initialAudit.error
    } else if (initialAudit.forbidden.length === 0) {
      indexSafe = true
    } else {
      // The plain add routinely stages non-ignored overlay files, and an
      // earlier process may have put private paths in the index. Reset only the
      // prohibited roots back to HEAD: working files remain intact for recovery.
      const reset = await gitRun(
        git,
        ['reset', '--quiet', ...forbiddenResetPathspecs(excludePaths)],
        worktreePath,
      )
      if (reset.code !== 0) {
        indexError = `git could not safely unstage forbidden paths: ${gitFailure(reset, `git reset failed with exit ${reset.code}`)}`
      } else {
        const finalAudit = await auditStagedPaths(
          git, worktreePath, excludePaths, 'git index re-audit failed after unstaging forbidden paths',
        )
        if (finalAudit.error) {
          indexError = finalAudit.error
        } else if (finalAudit.forbidden.length > 0) {
          indexError = `forbidden paths remain staged after safe unstage: ${describeForbiddenPaths(finalAudit.forbidden)}`
        } else {
          indexSafe = true
        }
      }
    }
  }
  // `--only` makes the allow/exclude pathspecs authoritative at commit time,
  // not merely at the earlier `git add`/audit. This closes the remaining race
  // where another process could stage a private path between audit and commit.
  // Automated delivery also bypasses repository hooks: a pre-commit hook runs
  // after our final audit and could otherwise stage an excluded secret into the
  // commit. User working files and the ordinary index remain preserved.
  const commit = add.code === 0 && indexSafe
    ? await gitRun(git, ['commit', '--no-verify', '--only', '-m', message, ...pathspecs], worktreePath)
    : { code: 1, stdout: '', stderr: 'skipped commit because the index was not proven safe' }
  const status = await gitRun(git, ['status', '--porcelain', '--untracked-files=all', ...pathspecs], worktreePath)
  const dirty = status.code === 0
    ? status.stdout.split('\n').map((line) => line.trimEnd()).filter(Boolean)
    : []
  const error = add.code !== 0
    ? gitFailure(add, `git add failed with exit ${add.code}`)
    : indexError
      ? indexError
      : status.code !== 0
        ? gitFailure(status, `git status failed with exit ${status.code}`)
        : commit.code !== 0 && dirty.length > 0
          ? gitFailure(commit, `git commit failed with exit ${commit.code}`)
          : undefined
  return {
    staged: add.code === 0,
    committed: commit.code === 0,
    clean: indexSafe && status.code === 0 && dirty.length === 0,
    dirty,
    ...(error ? { error } : {}),
  }
}

/**
 * Commit the worktree's current changes to its branch so the work is durable in
 * git — it survives worktree removal, is mergeable by the merge-back, and lets a
 * re-launched rail resume it. Retained as a best-effort compatibility wrapper;
 * new delivery code should use `commitWorktreeAndVerify`.
 */
export async function commitWorktree(git: GitRunner, worktreePath: string, message: string, excludePaths: string[] = []): Promise<void> {
  await commitWorktreeAndVerify(git, worktreePath, message, excludePaths)
}

export interface RemoveWorktreeInput {
  repoDir: string
  worktreePath: string
  branch: string
  /** Also delete the branch (default true — set false to keep a needs-review branch). */
  deleteBranch?: boolean
  /** Automatic cleanup uses Git's non-force removal as a final TOCTOU guard:
   * if the checkout became dirty after verification, Git must refuse removal.
   * Explicit destructive cleanup retains the historical force default. */
  force?: boolean
}

/** Remove a worktree and optionally delete its branch. Explicit cleanup keeps
 * the historical force default; automatic cleanup opts out. Removal failures
 * throw so callers do not mark the ledger released while it is still mounted.
 * Branch deletion remains best-effort. */
export async function removeWorktree(git: GitRunner, input: RemoveWorktreeInput): Promise<void> {
  const removed = await git.run(
    ['worktree', 'remove', ...(input.force === false ? [] : ['--force']), input.worktreePath],
    input.repoDir,
  )
  if (removed.code !== 0) {
    throw new Error(`git worktree remove failed for ${input.worktreePath}: ${gitFailure(removed, `exit ${removed.code}`)}`)
  }
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
