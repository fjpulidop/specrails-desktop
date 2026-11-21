/**
 * The "Copy this project's .env into runs" remedy of an environment blocker:
 * turn on the project's `worktreeEnvFiles` setting and copy the env files
 * into the stopped run's existing worktree(s) — one per repository — before
 * the regular Continue goes on in them. Later runs get them at
 * materialization (`isolated-worktree.ts`).
 *
 * Sources are only the project's own repositories: a worktree is matched to
 * the repository whose Git common directory it shares, never to a path the
 * run request merely names.
 */
import * as fs from 'fs'
import * as path from 'path'
import { getProjectRepositories } from '../../../project-repositories'
import { readDefinitionRun } from '../../loops/runtime/loop-runs-store'
import { defaultGitRunner, type GitRunner } from '../../../worktree-manager'
import { isCopyableEnvFileName, syncWorktreeEnvFiles, type EnvFilesSyncResult } from '../../../worktree-env-files'
import type { DbInstance } from '../../../db'
import type { ProjectContext } from '../../../project-registry'

export class EnvFilesUnavailableError extends Error {
  readonly code = 'env_files_unavailable'
  constructor() {
    super("This project's repositories have no .env file to copy. Create it in your checkout, then try again.")
    this.name = 'EnvFilesUnavailableError'
  }
}

export interface RunEnvFilesCopy {
  /** Worktree-relative copies, per worktree. */
  copied: string[]
  warnings: string[]
}

interface RepositoryRoot { path: string; commonDir: string | null }

async function commonDir(git: GitRunner, dir: string): Promise<string | null> {
  try {
    const result = await git.run(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)
    const value = result.code === 0 ? result.stdout.trim() : ''
    return value ? fs.realpathSync(value) : null
  } catch {
    return null
  }
}

function hasCandidate(dir: string): boolean {
  try { return fs.readdirSync(dir).some(isCopyableEnvFileName) } catch { return false }
}

/** The run's isolated worktrees (multi-repository manifest, else its single isolation mount). */
function runWorktrees(db: DbInstance, runId: string): string[] {
  const request = readDefinitionRun(db, runId)?.request
  if (!request) return []
  const mounts = request.executionManifest?.repositories.map((repository) => repository.worktreePath)
    ?? (request.isolation?.worktreePath ? [request.isolation.worktreePath] : [])
  return [...new Set(mounts.filter((mount): mount is string => typeof mount === 'string' && path.isAbsolute(mount)))]
}

/**
 * Turn the setting on and copy the env files into the run's worktrees.
 * Throws {@link EnvFilesUnavailableError} (nothing changed) when no project
 * repository has an env file.
 */
export async function enableEnvFilesForRun(
  c: Pick<ProjectContext, 'db' | 'project'>,
  runId: string,
  deps: { git?: GitRunner; enable: () => void; sync?: typeof syncWorktreeEnvFiles },
): Promise<RunEnvFilesCopy> {
  const git = deps.git ?? defaultGitRunner
  const repositories = getProjectRepositories(c.project).filter((repo) => repo.kind === 'git' && repo.available !== false)
  if (!repositories.some((repo) => hasCandidate(repo.path))) throw new EnvFilesUnavailableError()
  deps.enable()
  const roots: RepositoryRoot[] = await Promise.all(repositories.map(async (repo) => ({ path: repo.path, commonDir: await commonDir(git, repo.path) })))
  const out: RunEnvFilesCopy = { copied: [], warnings: [] }
  for (const worktreePath of runWorktrees(c.db, runId)) {
    const shared = await commonDir(git, worktreePath)
    const root = shared ? roots.find((candidate) => candidate.commonDir === shared) : undefined
    if (!root) continue
    const result: EnvFilesSyncResult = await (deps.sync ?? syncWorktreeEnvFiles)({ git, repoDir: root.path, worktreePath, enabled: true })
    out.copied.push(...result.copied)
    out.warnings.push(...result.warnings)
  }
  out.copied = [...new Set(out.copied)].sort()
  return out
}
