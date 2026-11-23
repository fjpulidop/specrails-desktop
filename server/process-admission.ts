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
  const waiting = admissionWaiters.get(projectId)
  admissionWaiters.delete(projectId)
  for (const wake of waiting ?? []) wake()
}

const admissionWaiters = new Map<string, Set<() => void>>()

/** The app is open but this project's admission is not yet (hydration or startup recovery). */
export function isProjectAdmissionPending(projectId: string): boolean {
  return appOpen && closedProjects.has(projectId)
}

/**
 * Admission for work a person asked for while the project is still being
 * hydrated (the restart dialog's Resume arrives seconds after boot, before
 * startup recovery opens the project): wait for it to open, bounded, instead
 * of refusing with "Process admission is closed". Shutdown still refuses at once.
 */
export async function awaitProcessAdmission(projectId: string, timeoutMs = 30_000): Promise<void> {
  if (!appOpen || !closedProjects.has(projectId)) { assertProcessAdmission(projectId); return }
  await new Promise<void>((resolve) => {
    const waiters = admissionWaiters.get(projectId) ?? new Set<() => void>()
    admissionWaiters.set(projectId, waiters)
    const done = (): void => { clearTimeout(timer); waiters.delete(done); resolve() }
    const timer = setTimeout(done, timeoutMs)
    timer.unref?.()
    waiters.add(done)
  })
  assertProcessAdmission(projectId)
}

/** @internal Test isolation only; production shutdown is intentionally final. */
export function resetProcessAdmissionForTests(): void {
  appOpen = true
  appGeneration += 1
  projectGenerations.clear()
  closedProjects.clear()
  admissionWaiters.clear()
}
