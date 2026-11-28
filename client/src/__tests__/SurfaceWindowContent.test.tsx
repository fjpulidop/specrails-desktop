import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor, cleanup } from '@testing-library/react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog'
import { RevealWhenPainted, replayStorageChanges, SpareSurfaceWindowContent } from '../SurfaceWindowContent'
import { adoptSurfaceRoute, isSpareSurfaceWindow, isSurfaceWindowRoute, readSurfaceAssignment } from '../lib/native-surfaces'

// ─── Tauri host doubles ──────────────────────────────────────────────────────
const calls: string[] = []
const invoke = vi.fn(async (command: string) => { calls.push(`invoke:${command}`) })
let assign: ((event: { payload: unknown }) => void) | null = null
const show = vi.fn(async () => { calls.push('show') })
vi.mock('@tauri-apps/api/core', () => ({ invoke: (command: string) => invoke(command) }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, callback: (event: { payload: unknown }) => void) => {
    if (name === 'surface-window:assign') { calls.push('listen:assign'); assign = callback }
    return () => { if (name === 'surface-window:assign') assign = null }
  }),
  emit: vi.fn(async () => {}),
}))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ show, setFocus: vi.fn(async () => {}), onResized: vi.fn(async () => () => {}), close: vi.fn(async () => {}) }),
}))

// ─── App doubles: the surfaces' content and the isolated desktop state ──────
const refreshProjects = vi.fn(async () => { projects.push({ id: 'p-new', name: 'New' }) })
let projects: Array<{ id: string; name: string }> = []
vi.mock('../hooks/useDesktop', () => ({
  useDesktop: () => ({ projects, isLoading: false, activeProjectId: 'p-new', setActiveProjectId: vi.fn(), refreshProjects }),
}))
vi.mock('../features/intent/components/IntentMissionsBridge', () => ({ FLOW_MISSION_EXTENSIONS: {} }))
function FakeSurface({ name }: { name: string }) {
  return (
    <Dialog open>
      <DialogContent size="workspace" data-testid={name}>
        <DialogHeader><DialogTitle>{name}</DialogTitle><DialogDescription>d</DialogDescription></DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
vi.mock('../features/settings/pages/GlobalSettingsPage', () => ({ default: () => <FakeSurface name="app-settings" /> }))
vi.mock('../features/settings/pages/SettingsPage', () => ({ ProjectSettingsDialog: () => <FakeSurface name="project-settings" /> }))
vi.mock('../features/jobs/components/JobDetailModal', () => ({ JobDetailModal: () => <FakeSurface name="job-detail" /> }))
vi.mock('../features/live-board/components/LiveBoardWindow', () => ({ default: () => <FakeSurface name="live-board" /> }))

let rafSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {}
  // A hidden window runs no animation frames.
  rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 0)
  calls.length = 0
  invoke.mockClear()
  show.mockClear()
  refreshProjects.mockClear()
  projects = [{ id: 'p1', name: 'One' }]
  assign = null
  localStorage.clear()
  window.history.replaceState(null, '', '/index.html?surfaceWindow=spare')
})
afterEach(() => {
  cleanup()
  rafSpy.mockRestore()
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
  window.history.replaceState(null, '', '/')
})

describe('surface window routes', () => {
  it('the spare counts as a surface window; it renders no surface until it has one', () => {
    expect(isSurfaceWindowRoute('?surfaceWindow=spare')).toBe(true)
    expect(isSpareSurfaceWindow('?surfaceWindow=spare')).toBe(true)
    expect(isSurfaceWindowRoute('?surfaceWindow=job-detail&jobId=1')).toBe(true)
    expect(isSpareSurfaceWindow('?surfaceWindow=job-detail')).toBe(false)
    expect(isSurfaceWindowRoute('?live=1')).toBe(false)
  })

  it('accepts only a known surface with string params', () => {
    expect(readSurfaceAssignment({ surface: 'job-detail', requestId: 'r1', params: { jobId: 'j1', bad: 3 } }))
      .toEqual({ surface: 'job-detail', requestId: 'r1', params: { jobId: 'j1' } })
    expect(readSurfaceAssignment({ surface: 'loops', requestId: 'r1', params: {} })).toBeNull()
    expect(readSurfaceAssignment({ surface: 'job-detail' })).toBeNull()
    expect(readSurfaceAssignment(null)).toBeNull()
  })

  it('takes the URL of the surface it shows, so a reload reopens it', () => {
    adoptSurfaceRoute({ surface: 'job-detail', requestId: 'r1', params: { jobId: 'j1', projectId: 'p1' } })
    expect(window.location.pathname).toBe('/index.html')
    expect(new URLSearchParams(window.location.search).get('surfaceWindow')).toBe('job-detail')
    expect(window.location.search).toContain('requestId=r1')
    expect(window.location.search).toContain('jobId=j1')
  })
})

describe('RevealWhenPainted', () => {
  // WebKit runs no animation frames in a hidden window: the frame-based reveal never fired and every
  // window waited for the host's 2.5 s fallback before it showed.
  it('[spec:native-surface-windows/hidden-window-reveals-itself] shows the hidden window once the framed content is in the DOM, without animation frames', async () => {
    const reveal = vi.fn(async () => {})
    const { rerender } = render(<RevealWhenPainted reveal={reveal} />)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(reveal).not.toHaveBeenCalled()
    rerender(<><div data-surface-window="" /><RevealWhenPainted reveal={reveal} /></>)
    await waitFor(() => expect(reveal).toHaveBeenCalledTimes(1))
    expect(rafSpy).not.toHaveBeenCalled()
  })
})

describe('replayStorageChanges', () => {
  it('replays preferences another window changed while this one waited', () => {
    localStorage.setItem('specrails.theme', 'dracula')
    localStorage.setItem('specrails.keep', 'same')
    const before = new Map<string, string | null>([['specrails.theme', 'dracula'], ['specrails.keep', 'same'], ['specrails.gone', 'x']])
    localStorage.setItem('specrails.theme', 'galaxy')
    localStorage.setItem('specrails.lang', 'es')
    const seen: Array<[string | null, string | null]> = []
    const listener = (event: StorageEvent) => seen.push([event.key, event.newValue])
    window.addEventListener('storage', listener)
    replayStorageChanges(before)
    window.removeEventListener('storage', listener)
    expect(seen).toEqual(expect.arrayContaining([['specrails.theme', 'galaxy'], ['specrails.lang', 'es'], ['specrails.gone', null]]))
    expect(seen.find(([key]) => key === 'specrails.keep')).toBeUndefined()
  })
})

describe('SpareSurfaceWindowContent', () => {
  it('[spec:native-surface-windows/spare-takes-the-surface] reports ready only once it listens, then renders the assigned surface framed and shows the window', async () => {
    render(<SpareSurfaceWindowContent />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('surface_window_spare_ready'))
    // No assignment can be lost: the listener is in place before the host may send one.
    expect(calls.indexOf('listen:assign')).toBeLessThan(calls.indexOf('invoke:surface_window_spare_ready'))
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(show).not.toHaveBeenCalled()

    localStorage.setItem('specrails.theme', 'galaxy')
    const replayed: string[] = []
    const onStorage = (event: StorageEvent) => { if (event.key) replayed.push(event.key) }
    window.addEventListener('storage', onStorage)
    await act(async () => { assign?.({ payload: { surface: 'app-settings', requestId: 'r9', params: { section: 'appearance' } } }) })
    window.removeEventListener('storage', onStorage)

    // The page confirms it took the surface (the host discards a spare that does not).
    expect(invoke.mock.calls.filter(([command]) => command === 'surface_window_spare_ready')).toHaveLength(2)
    const dialog = await screen.findByTestId('app-settings')
    expect(dialog.hasAttribute('data-surface-window')).toBe(true)
    expect(new URLSearchParams(window.location.search).get('surfaceWindow')).toBe('app-settings')
    expect(replayed).toContain('specrails.theme')
    await waitFor(() => expect(show).toHaveBeenCalledTimes(1))

    // Used once: a second assignment is ignored.
    await act(async () => { assign?.({ payload: { surface: 'job-detail', requestId: 'r10', params: { jobId: 'j1' } } }) })
    expect(screen.queryByTestId('job-detail')).toBeNull()
  })

  it('learns a project added after it loaded before showing that project', async () => {
    render(<SpareSurfaceWindowContent />)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('surface_window_spare_ready'))
    await act(async () => { assign?.({ payload: { surface: 'project-settings', requestId: 'r1', params: { projectId: 'p-new' } } }) })
    expect(refreshProjects).toHaveBeenCalledTimes(1)
    expect(await screen.findByTestId('project-settings')).toBeTruthy()
  })
})
