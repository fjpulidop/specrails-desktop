/**
 * App-shell requests made inside a native surface window
 * (docs/internals/native-window-surfaces.md, "Callbacks become results").
 *
 * `openAppSettings`, `openProjectSettings` and `openBudgetPanel` ask the app
 * shell through window events. A surface window (Settings, Job detail, the live
 * board) has no app shell, so nothing there listens: the surface forwards the
 * request to its opener as a result, then closes (the host focuses the opener).
 * The opener (main or mission window) replays it as the same window event, so
 * the shell that owns the place handles it exactly as a local click would.
 *
 * Replay tour is not here: Settings reports `{ action: 'openOnboarding' }`
 * through its own callback, and the guide hides it elsewhere.
 */
import {
  APP_SETTINGS_SECTIONS,
  OPEN_APP_SETTINGS_EVENT,
  OPEN_BUDGET_PANEL_EVENT,
  OPEN_PROJECT_SETTINGS_EVENT,
  openAppSettings,
  openBudgetPanel,
  openProjectSettings,
  type AppSettingsSection,
  type OpenAppSettingsDetail,
  type OpenProjectSettingsDetail,
} from './app-settings-events'
import { isSurfaceWindowRoute, listenSurfaceWindowEvents } from './native-surfaces'
import { isTauri } from './tauri-shell'

export type SurfaceShellRequest =
  | { kind: 'appSettings'; section: AppSettingsSection; settingId?: string }
  | { kind: 'projectSettings'; section: string; settingId?: string; projectId?: string }
  | { kind: 'budget' }

export interface SurfaceShellResult { action: 'shell'; request: SurfaceShellRequest }

const MAX_FIELD = 256
const field = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD ? value : undefined

/** Validates a result from another window (it crossed a process boundary). */
export function readSurfaceShellResult(value: unknown): SurfaceShellRequest | null {
  if (!value || typeof value !== 'object' || (value as { action?: unknown }).action !== 'shell') return null
  const request = (value as { request?: unknown }).request as Record<string, unknown> | undefined
  if (!request || typeof request !== 'object') return null
  const settingId = field(request.settingId)
  if (request.kind === 'budget') return { kind: 'budget' }
  if (request.kind === 'appSettings') {
    const section = field(request.section)
    if (!section || !(APP_SETTINGS_SECTIONS as readonly string[]).includes(section)) return null
    return { kind: 'appSettings', section: section as AppSettingsSection, ...(settingId ? { settingId } : {}) }
  }
  if (request.kind === 'projectSettings') {
    const section = field(request.section)
    if (!section) return null
    const projectId = field(request.projectId)
    return { kind: 'projectSettings', section, ...(settingId ? { settingId } : {}), ...(projectId ? { projectId } : {}) }
  }
  return null
}

/** Opener side: run the request here, as the local window event. */
export function runSurfaceShellRequest(request: SurfaceShellRequest): void {
  if (request.kind === 'budget') openBudgetPanel()
  else if (request.kind === 'appSettings') openAppSettings(request.section, request.settingId)
  else openProjectSettings(request.section, request.settingId, request.projectId)
}

/**
 * Surface-window side: forward this window's shell requests through `send`
 * (report + close). `projectId` scopes a project-settings request that did not
 * name one: the surface's own project, not whatever the main window shows.
 */
export function forwardSurfaceShellRequests(send: (result: SurfaceShellResult) => void, options: { projectId?: string } = {}): () => void {
  const target = globalThis as unknown as Window
  const forward = (request: SurfaceShellRequest) => send({ action: 'shell', request })
  const onAppSettings = (event: Event) => {
    const detail = (event as CustomEvent<OpenAppSettingsDetail>).detail
    if (detail?.section) forward({ kind: 'appSettings', section: detail.section, ...(detail.settingId ? { settingId: detail.settingId } : {}) })
  }
  const onProjectSettings = (event: Event) => {
    const detail = (event as CustomEvent<OpenProjectSettingsDetail>).detail
    if (!detail?.section) return
    const projectId = detail.projectId ?? options.projectId
    forward({ kind: 'projectSettings', section: detail.section, ...(detail.settingId ? { settingId: detail.settingId } : {}), ...(projectId ? { projectId } : {}) })
  }
  const onBudget = () => forward({ kind: 'budget' })
  target.addEventListener(OPEN_APP_SETTINGS_EVENT, onAppSettings)
  target.addEventListener(OPEN_PROJECT_SETTINGS_EVENT, onProjectSettings)
  target.addEventListener(OPEN_BUDGET_PANEL_EVENT, onBudget)
  return () => {
    target.removeEventListener(OPEN_APP_SETTINGS_EVENT, onAppSettings)
    target.removeEventListener(OPEN_PROJECT_SETTINGS_EVENT, onProjectSettings)
    target.removeEventListener(OPEN_BUDGET_PANEL_EVENT, onBudget)
  }
}

/**
 * Opener side, app-wide: every surface window this window opened can forward a
 * shell request, whether or not the component that opened it is still mounted
 * (an unmounted opener leaves its window open and independent).
 */
export async function listenSurfaceShellRequests(): Promise<() => void> {
  if (!isTauri() || isSurfaceWindowRoute()) return () => {}
  return listenSurfaceWindowEvents((event) => {
    if (event.kind !== 'result') return
    const request = readSurfaceShellResult(event.result)
    if (request) runSurfaceShellRequest(request)
  })
}
