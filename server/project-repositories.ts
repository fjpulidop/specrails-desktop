import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'

/** Membership belongs to a logical project; the same checkout may be a member of others. */
export interface ProjectRepository {
  id: string
  projectId: string
  name: string
  path: string
  isPrimary: boolean
  kind: 'git' | 'folder'
  integrationBranch: string | null
  addedAt: string
  available?: boolean
}

export interface RepositoryProject {
  id: string
  name?: string
  path: string
  added_at?: string
  primaryRepositoryId?: string
  repositories?: ProjectRepository[]
}

export interface ProjectRepositoryInput {
  path: string
  name?: string
  integrationBranch?: string | null
}

export class RepositoryValidationError extends Error {
  constructor(message: string, public code = 'invalid_repository', public status = 400, public details?: unknown) {
    super(message)
    this.name = 'RepositoryValidationError'
  }
}

export function repositoryPathKey(value: string): string {
  const absolute = path.resolve(value)
  return process.platform === 'win32' || process.platform === 'darwin' ? absolute.toLowerCase() : absolute
}

export function canonicalRepositoryPath(value: string): string {
  const absolute = path.resolve(value)
  let existing = absolute
  while (true) {
    try { return path.resolve(fs.realpathSync(existing), path.relative(existing, absolute)) } catch { /* Resolve through the nearest existing parent (e.g. an unsaved src path). */ }
    const parent = path.dirname(existing)
    if (parent === existing) return absolute
    existing = parent
  }
}

export function repositoryAvailable(value: string): boolean {
  try { return fs.statSync(value).isDirectory() } catch { return false }
}

/** Cheap fallback for old fixtures and missing roots; persisted memberships carry the inspected kind. */
export function legacyRepositoryKind(value: string): 'git' | 'folder' {
  let dir = path.resolve(value)
  while (true) {
    if (fs.existsSync(path.join(dir, '.git'))) return 'git'
    const parent = path.dirname(dir)
    if (parent === dir) return 'folder'
    dir = parent
  }
}

export function getProjectRepositories(project: RepositoryProject): ProjectRepository[] {
  if (project.repositories?.length) return project.repositories
  return [{
    id: `primary-${project.id}`, projectId: project.id,
    name: project.name ?? path.basename(project.path), path: project.path, isPrimary: true,
    kind: legacyRepositoryKind(project.path), integrationBranch: null,
    addedAt: project.added_at ?? '', available: repositoryAvailable(project.path),
  }]
}

export function resolveProjectRepository(project: RepositoryProject, repositoryId?: string): ProjectRepository {
  const repositories = getProjectRepositories(project)
  const repository = repositoryId === undefined
    ? repositories.find((item) => item.isPrimary)
    : repositories.find((item) => item.id === repositoryId && item.projectId === project.id)
  if (!repository) throw new RepositoryValidationError('Repository does not belong to this project', 'repository_not_found', 404)
  return repository
}

export function validateTicketRepositoryIds(project: RepositoryProject, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new RepositoryValidationError('repositoryIds must be a nonempty array of repository IDs', 'invalid_repository_ids')
  }
  if (new Set(value).size !== value.length) throw new RepositoryValidationError('repositoryIds must not contain duplicates', 'invalid_repository_ids')
  for (const id of value) {
    try { resolveProjectRepository(project, id) } catch {
      throw new RepositoryValidationError(`Repository ${id} does not belong to this project`, 'invalid_repository_ids')
    }
  }
  return [...value] as string[]
}

export interface InspectedRepositoryInput extends ProjectRepositoryInput {
  canonicalKey: string
  gitIdentity: string | null
  kind: 'git' | 'folder'
}

export function inspectRepositoryPath(input: ProjectRepositoryInput, requireAvailable = true): InspectedRepositoryInput {
  if (!input || typeof input.path !== 'string' || !input.path.trim()) throw new RepositoryValidationError('Repository path is required')
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim())) throw new RepositoryValidationError('Repository name must not be empty')
  if (input.integrationBranch !== undefined && input.integrationBranch !== null && (typeof input.integrationBranch !== 'string' || !input.integrationBranch.trim() || /[\r\n\0]/.test(input.integrationBranch))) {
    throw new RepositoryValidationError('integrationBranch must be a branch name or null')
  }
  const canonical = canonicalRepositoryPath(input.path)
  if (requireAvailable && !repositoryAvailable(canonical)) throw new RepositoryValidationError(`Repository directory is unavailable: ${canonical}`, 'repository_unavailable')
  let gitIdentity: string | null = null
  if (repositoryAvailable(canonical)) {
    try {
      const commonDir = execFileSync('git', ['-C', canonical, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      gitIdentity = repositoryPathKey(canonicalRepositoryPath(path.resolve(canonical, commonDir)))
    } catch { /* Non-Git context folders are supported. */ }
  }
  return { ...input, path: canonical, name: input.name?.trim(), integrationBranch: input.integrationBranch?.trim() || null, canonicalKey: repositoryPathKey(canonical), gitIdentity, kind: gitIdentity ? 'git' : 'folder' }
}

export function assertDistinctRepositories(repositories: InspectedRepositoryInput[]): void {
  for (let i = 0; i < repositories.length; i++) {
    for (let j = 0; j < i; j++) {
      const a = repositories[i], b = repositories[j]
      const overlapping = isRepositoryPathWithin(a.canonicalKey, b.canonicalKey) || isRepositoryPathWithin(b.canonicalKey, a.canonicalKey)
      if (overlapping || (a.gitIdentity !== null && a.gitIdentity === b.gitIdentity)) {
        throw new RepositoryValidationError('Repositories in one project must have distinct, non-overlapping roots and Git identities', 'duplicate_repository', 409)
      }
    }
  }
}

export function isRepositoryPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(repositoryPathKey(root), repositoryPathKey(candidate))
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Explicit project context wins; legacy primary matches precede shared secondary matches. */
export function resolveRepositoryProject<T extends RepositoryProject>(projects: T[], inputPath: string, projectId?: string): T | undefined {
  const canonical = canonicalRepositoryPath(inputPath)
  const candidates = projects.filter((project) => (!projectId || project.id === projectId) && getProjectRepositories(project).some((repo) => isRepositoryPathWithin(canonicalRepositoryPath(repo.path), canonical)))
  if (projectId) return candidates[0]
  const primaryMatches = candidates.filter((project) => isRepositoryPathWithin(canonicalRepositoryPath(project.path), canonical))
  const selected = primaryMatches.length ? primaryMatches : candidates
  if (selected.length > 1 && !primaryMatches.length) {
    throw new RepositoryValidationError('This path belongs to several projects; provide projectId', 'ambiguous_project_path', 409, { projectIds: selected.map((project) => project.id) })
  }
  return selected.sort((a, b) => b.path.length - a.path.length)[0]
}
