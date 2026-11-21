import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  OPEN_APP_SETTINGS_EVENT,
  OPEN_BUDGET_PANEL_EVENT,
  OPEN_PROJECT_SETTINGS_EVENT,
  openAppSettings,
  openBudgetPanel,
  openProjectSettings,
} from './app-settings-events'
import {
  forwardSurfaceShellRequests,
  listenSurfaceShellRequests,
  readSurfaceShellResult,
  type SurfaceShellResult,
} from './surface-shell-requests'
import type { SurfaceWindowEvent } from './native-surfaces'

let emitted: ((event: { payload: SurfaceWindowEvent }) => void) | null = null
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, callback: (event: { payload: SurfaceWindowEvent }) => void) => { emitted = callback; return () => { emitted = null } }),
  emit: vi.fn(async () => {}),
}))

function setTauri(on: boolean) {
  if (on) (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  else delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
}

function capture(name: string) {
  const seen: unknown[] = []
  const handler = (event: Event) => seen.push((event as CustomEvent).detail ?? null)
  window.addEventListener(name, handler)
  return { seen, stop: () => window.removeEventListener(name, handler) }
}

beforeEach(() => { emitted = null })
afterEach(() => { setTauri(false); window.history.replaceState(null, '', '/') })

describe('surface shell requests: surface-window side', () => {
  it('forwards "Configure" (project settings) with the surface\'s project when the call named none', () => {
    const sent: SurfaceShellResult[] = []
    const stop = forwardSurfaceShellRequests((result) => sent.push(result), { projectId: 'proj-job' })
    openProjectSettings('agentRuntime')
    stop()
    expect(sent).toEqual([{ action: 'shell', request: { kind: 'projectSettings', section: 'agentRuntime', projectId: 'proj-job' } }])
  })

  it('keeps an explicit project, and forwards app settings and budget requests', () => {
    const sent: SurfaceShellResult[] = []
    const stop = forwardSurfaceShellRequests((result) => sent.push(result), { projectId: 'proj-job' })
    openProjectSettings('budget', 'projectBudget', 'proj-other')
    openAppSettings('storage', 'retainedWorktrees')
    openBudgetPanel()
    stop()
    openBudgetPanel()
    expect(sent.map((result) => result.request)).toEqual([
      { kind: 'projectSettings', section: 'budget', settingId: 'projectBudget', projectId: 'proj-other' },
      { kind: 'appSettings', section: 'storage', settingId: 'retainedWorktrees' },
      { kind: 'budget' },
    ])
  })
})

describe('surface shell requests: validation', () => {
  it('rejects shapes that are not shell requests', () => {
    expect(readSurfaceShellResult({ action: 'openOnboarding' })).toBeNull()
    expect(readSurfaceShellResult({ action: 'shell', request: { kind: 'appSettings', section: 'nope' } })).toBeNull()
    expect(readSurfaceShellResult({ action: 'shell', request: { kind: 'projectSettings', section: '' } })).toBeNull()
    expect(readSurfaceShellResult({ action: 'shell', request: { kind: 'exec' } })).toBeNull()
    expect(readSurfaceShellResult({ action: 'shell', request: { kind: 'projectSettings', section: 'x', projectId: 'y'.repeat(300) } }))
      .toEqual({ kind: 'projectSettings', section: 'x' })
  })
})

describe('surface shell requests: opener side', () => {
  it('replays a forwarded request as the local window event, from any surface request', async () => {
    setTauri(true)
    const project = capture(OPEN_PROJECT_SETTINGS_EVENT)
    const budget = capture(OPEN_BUDGET_PANEL_EVENT)
    const app = capture(OPEN_APP_SETTINGS_EVENT)
    const stop = await listenSurfaceShellRequests()
    const base = { surface: 'job-detail' as const, requestId: 'req-gone', windowLabel: 'surface-job-detail-x' }
    emitted?.({ payload: { ...base, kind: 'result', result: { action: 'shell', request: { kind: 'projectSettings', section: 'agentRuntime', projectId: 'p2' } } } })
    emitted?.({ payload: { ...base, kind: 'result', result: { action: 'shell', request: { kind: 'budget' } } } })
    emitted?.({ payload: { ...base, kind: 'result', result: { action: 'openOnboarding' } } })
    emitted?.({ payload: { ...base, kind: 'closed' } })
    stop()
    project.stop(); budget.stop(); app.stop()
    expect(project.seen).toEqual([{ section: 'agentRuntime', projectId: 'p2' }])
    expect(budget.seen).toHaveLength(1)
    expect(app.seen).toEqual([])
  })

  it('does not listen in the browser or inside a surface window', async () => {
    setTauri(false)
    await listenSurfaceShellRequests()
    expect(emitted).toBeNull()
    setTauri(true)
    window.history.replaceState(null, '', '/?surfaceWindow=job-detail&requestId=r1')
    await listenSurfaceShellRequests()
    expect(emitted).toBeNull()
  })
})
