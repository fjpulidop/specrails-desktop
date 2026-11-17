/**
 * Returns the base URL prefix for project-scoped API calls.
 *
 * The Super-mode server is the only supported runtime; this helper always returns
 * `${API_ORIGIN}/api/projects/<projectId>`. Defaults to the active project;
 * pass an explicit id for a newly created project before activating it. Endpoints that are
 * not project-scoped (e.g. `/api/*`, `/api/health`) should reference
 * `API_ORIGIN` directly instead of going through `getApiBase`.
 */

import { API_ORIGIN } from './origin'

let _activeProjectId: string | null = null

export function setActiveProjectId(projectId: string | null): void {
  _activeProjectId = projectId
}

/** The active project id (null before one is chosen). */
export function getActiveProjectId(): string | null {
  return _activeProjectId
}

/** @deprecated alias kept for tests; prefer `setActiveProjectId`. */
export const setApiContext = (projectId: string | null): void => setActiveProjectId(projectId)

export function getApiBase(projectId: string | null = _activeProjectId): string {
  if (!projectId) {
    throw new Error('getApiBase called with no active project — call setActiveProjectId first')
  }
  return `${API_ORIGIN}/api/projects/${projectId}`
}
