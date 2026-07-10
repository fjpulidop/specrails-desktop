/**
 * Process-wide and project-scoped admission barrier for subprocess work.
 *
 * Shutdown is not instantaneous: existing HTTP/WebSocket handlers can resume
 * after their manager has been disposed. A generation lease lets those
 * continuations prove that their project is still live before spawning or
 * touching a DB, while the global barrier closes every generic AI-CLI wrapper
 * at the beginning of process shutdown.
 */

export class ProcessAdmissionClosedError extends Error {
  readonly code = 'PROCESS_ADMISSION_CLOSED'

  constructor(readonly projectId?: string) {
    super(projectId
      ? `Process admission is closed for project ${projectId}`
      : 'Process admission is closed during application shutdown')
    this.name = 'ProcessAdmissionClosedError'
  }
}

let appOpen = true
let appGeneration = 0
const projectGenerations = new Map<string, number>()
const closedProjects = new Set<string>()

export interface ProcessAdmissionLease {
  readonly projectId?: string
  isCurrent(): boolean
  assertCurrent(): void
}

export function assertProcessAdmission(projectId?: string): void {
  if (!appOpen || (projectId !== undefined && closedProjects.has(projectId))) {
    throw new ProcessAdmissionClosedError(projectId)
  }
}

export function captureProcessAdmission(projectId?: string): ProcessAdmissionLease {
  assertProcessAdmission(projectId)
  const capturedAppGeneration = appGeneration
  const capturedProjectGeneration = projectId === undefined
    ? 0
    : (projectGenerations.get(projectId) ?? 0)
  const isCurrent = (): boolean =>
    appOpen &&
    appGeneration === capturedAppGeneration &&
    (projectId === undefined || (
      !closedProjects.has(projectId) &&
      (projectGenerations.get(projectId) ?? 0) === capturedProjectGeneration
    ))
  return {
    projectId,
    isCurrent,
    assertCurrent(): void {
      if (!isCurrent()) throw new ProcessAdmissionClosedError(projectId)
    },
  }
}

/** Close app-wide admission before any shutdown await can yield. Idempotent. */
export function beginAppProcessQuiescence(): void {
  if (!appOpen) return
  appOpen = false
  appGeneration += 1
}

/** Invalidate all earlier continuations and reject new work for one project. */
export function beginProjectProcessQuiescence(projectId: string): void {
  closedProjects.add(projectId)
  projectGenerations.set(projectId, (projectGenerations.get(projectId) ?? 0) + 1)
}

/** Open a freshly hydrated project context with a new continuation epoch. */
export function openProjectProcessAdmission(projectId: string): void {
  closedProjects.delete(projectId)
  projectGenerations.set(projectId, (projectGenerations.get(projectId) ?? 0) + 1)
}

/** @internal Test isolation only; production shutdown is intentionally final. */
export function resetProcessAdmissionForTests(): void {
  appOpen = true
  appGeneration += 1
  projectGenerations.clear()
  closedProjects.clear()
}
