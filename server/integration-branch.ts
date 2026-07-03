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
