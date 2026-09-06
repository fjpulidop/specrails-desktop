import type { DesktopProject } from '../hooks/useDesktop'
import { API_ORIGIN } from './origin'

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

export interface RepositoryInput {
  path: string
  name?: string
  integrationBranch?: string | null
}

/** Older servers and saved project snapshots still identify one primary root. */
export function projectRepositories(project?: Pick<DesktopProject, 'id' | 'name' | 'path' | 'added_at' | 'repositories'>): ProjectRepository[] {
  if (!project) return []
  return project.repositories?.length ? project.repositories : [{
    id: `primary-${project.id}`, projectId: project.id, name: project.name,
    path: project.path, isPrimary: true, kind: 'git', integrationBranch: null,
    addedAt: project.added_at,
  }]
}

export function repositoryApiBase(projectId: string, repositoryId?: string): string {
  const base = `${API_ORIGIN}/api/projects/${encodeURIComponent(projectId)}`
  return repositoryId ? `${base}/repositories/${encodeURIComponent(repositoryId)}` : base
}
