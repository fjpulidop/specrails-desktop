/**
 * Resolve a project's designated INTEGRATION BRANCH — the branch that
 * repo-mutating loops branch their worktrees from and target their draft PRs at.
 *
 * Resolution order (highest precedence first):
 *   1. explicit    — a branch chosen at launch time (rare).
 *   2. project-setting — the per-project configured integration branch.
 *   3. repo-default — the repository's default branch (`origin/HEAD`).
 *   4. head-fallback — the currently checked-out branch, or the literal `HEAD`
 *      when detached / unresolvable (byte-identical to the legacy default).
 *
 * Pure over an injectable `GitRunner` (the same one `worktree-manager` uses) so
 * it is unit-tested without a real repository. This kills the previous implicit
 * "branch off whatever HEAD happens to be" behavior: the resolved branch is
 * surfaced to the caller (and, upstream, shown to the user before launch).
 */
import type { GitRunner } from './worktree-manager'

export type IntegrationBranchSource = 'explicit' | 'project-setting' | 'repo-default' | 'head-fallback'

export interface ResolvedIntegrationBranch {
  branch: string
  source: IntegrationBranchSource
}

export interface FetchResult {
  ok: boolean
  error?: string
}

/** How long a fetch outcome (success OR failure) is reused for the same repo
 *  before a fresh `git fetch origin` is attempted again. Exists so a burst of
 *  near-simultaneous launches against the SAME repo — e.g. a "Launch all"
 *  batch, which is N independent HTTP requests with no shared server-side
 *  transaction (see design.md Decision 2) — performs one real fetch instead of
 *  one per rail. */
export const FETCH_ORIGIN_TTL_MS = 15_000

const fetchCache = new Map<string, { at: number; result: Promise<FetchResult> }>()

/** Test-only: clear the fetch dedup cache so tests never leak state across
 *  cases (mirrors `__resetRepoLocks` in repo-lock.ts). */
export function __resetFetchOriginCache(): void {
  fetchCache.clear()
}

/**
 * `git fetch origin` against `repoDir` — updates ONLY `refs/remotes/origin/*`,
 * never the checked-out local branch or working tree (Git itself refuses to
 * touch either via a plain fetch). Never throws: any non-zero exit or runner
 * rejection resolves to `{ ok: false, error }` so callers can degrade
 * gracefully instead of failing the launch.
 *
 * De-duped per `repoDir` for `FETCH_ORIGIN_TTL_MS`: a call within the window
 * of the last attempt (success OR failure) for the same repo reuses that
 * outcome instead of spawning a new `git fetch` process. `now` is injectable
 * so tests can control TTL expiry without real timers.
 */
export async function fetchOrigin(
  git: GitRunner,
  repoDir: string,
  now: () => number = Date.now,
): Promise<FetchResult> {
  const cached = fetchCache.get(repoDir)
  const nowMs = now()
  if (cached && nowMs - cached.at < FETCH_ORIGIN_TTL_MS) return cached.result

  const result = (async (): Promise<FetchResult> => {
    try {
      const r = await git.run(['fetch', 'origin'], repoDir)
      if (r.code === 0) return { ok: true }
      return { ok: false, error: r.stderr.trim() || r.stdout.trim() || `exit ${r.code}` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })()
  fetchCache.set(repoDir, { at: nowMs, result })
  return result
}

export interface ResolveIntegrationBranchInput {
  repoDir: string
  /** Explicit branch chosen at launch time (rare). */
  explicit?: string | null
  /** Per-project configured integration branch (empty/undefined = auto-resolve). */
  projectSetting?: string | null
}

/** The repo's default branch via `origin/HEAD` → the bare branch name, or null. */
export async function repoDefaultBranch(git: GitRunner, repoDir: string): Promise<string | null> {
  const r = await git.run(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoDir)
  if (r.code === 0) {
    const ref = r.stdout.trim() // e.g. refs/remotes/origin/main
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/)
    if (m && m[1]) return m[1]
  }
  return null
}

/** The currently checked-out branch, or null when detached (`HEAD`) / unresolvable. */
export async function currentBranch(git: GitRunner, repoDir: string): Promise<string | null> {
  const r = await git.run(['rev-parse', '--abbrev-ref', 'HEAD'], repoDir)
  if (r.code === 0) {
    const b = r.stdout.trim()
    if (b && b !== 'HEAD') return b // 'HEAD' == detached
  }
  return null
}

/**
 * Conservative git branch-name validator. The integration branch flows into
 * `git worktree add -b <branch> <path> <base>` as `<base>`, so a value starting
 * with `-` or containing whitespace/control chars would be an argument-injection
 * vector. We allow only a safe subset (letters, digits, `._/-`), reject a leading
 * `-`, `..`, a trailing `/` or `.lock`, and cap the length. This is stricter than
 * git's own rules on purpose — it is an input-boundary guard, not a git parser.
 */
export function isValidBranchName(name: string): boolean {
  if (typeof name !== 'string') return false
  const n = name.trim()
  if (!n || n.length > 255) return false
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/')) return false
  if (n.includes('..') || n.includes('//') || n.endsWith('.lock')) return false
  return /^[A-Za-z0-9._/-]+$/.test(n)
}

export async function resolveIntegrationBranch(
  git: GitRunner,
  input: ResolveIntegrationBranchInput,
): Promise<ResolvedIntegrationBranch> {
  const explicit = input.explicit?.trim()
  if (explicit) return { branch: explicit, source: 'explicit' }

  const setting = input.projectSetting?.trim()
  if (setting) return { branch: setting, source: 'project-setting' }

  const def = await repoDefaultBranch(git, input.repoDir)
  if (def) return { branch: def, source: 'repo-default' }

  const cur = await currentBranch(git, input.repoDir)
  if (cur) return { branch: cur, source: 'head-fallback' }

  // Detached / no remote / unresolvable → the literal HEAD (legacy-identical).
  return { branch: 'HEAD', source: 'head-fallback' }
}

export interface WorktreeBaseRefResolution {
  baseRef: string
  usedRemote: boolean
  warning?: string
}

/**
 * Decide the actual `baseRef` a worktree should branch from, given the
 * already-resolved integration branch and whether `fetchOrigin` succeeded.
 *
 * `explicit` is a launch-time override the caller chose on purpose — it is
 * NEVER remote-prefixed and NEVER existence-checked (see proposal.md Out of
 * Scope). Every other source (`repo-default`, `project-setting`,
 * `head-fallback`) uses the fetched remote-tracking ref `origin/<branch>`
 * ONLY when the fetch succeeded AND that remote branch actually exists —
 * guards a `project-setting` branch that was never pushed, which would
 * otherwise turn a working local-only setup into a broken `git worktree add`.
 * Any failure of either check falls back to today's bare local branch name,
 * with a human-readable `warning` the caller can log/broadcast.
 */
export async function resolveWorktreeBaseRef(
  git: GitRunner,
  input: { repoDir: string; integration: ResolvedIntegrationBranch; fetchOk: boolean },
): Promise<WorktreeBaseRefResolution> {
  const { repoDir, integration, fetchOk } = input
  if (integration.source === 'explicit') {
    return { baseRef: integration.branch, usedRemote: false }
  }
  if (!fetchOk) {
    return { baseRef: integration.branch, usedRemote: false, warning: 'git fetch origin failed; using local ref' }
  }
  const exists = await git.run(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${integration.branch}`],
    repoDir,
  )
  if (exists.code === 0) {
    return { baseRef: `origin/${integration.branch}`, usedRemote: true }
  }
  return {
    baseRef: integration.branch,
    usedRemote: false,
    warning: `origin/${integration.branch} not found; using local ref`,
  }
}
