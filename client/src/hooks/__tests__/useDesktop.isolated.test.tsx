import { act, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DesktopProvider, useDesktop, type DesktopProject } from '../useDesktop'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (message: unknown) => void>(),
  register: vi.fn(), unregister: vi.fn(), setApiProject: vi.fn(), toast: vi.fn(), purge: vi.fn(),
}))
vi.mock('../useSharedWebSocket', () => ({ useSharedWebSocket: () => ({
  registerHandler: mocks.register, unregisterHandler: mocks.unregister, connectionStatus: 'connected',
}) }))
vi.mock('../../lib/api', () => ({ setActiveProjectId: mocks.setApiProject }))
vi.mock('../../lib/origin', () => ({ API_ORIGIN: '' }))
vi.mock('../useProjectCache', () => ({ purgeProjectCache: mocks.purge }))
vi.mock('sonner', () => ({ toast: { success: mocks.toast } }))

const STORAGE_KEY = 'specrails-desktop:activeProjectId'
function project(id: string, platform: string): DesktopProject {
  const path = platform === 'Win32' ? `C:\\fixtures\\${id}` : `/fixtures/${id}`
  return { id, slug: id, name: id, path, db_path: `${path}/jobs.sqlite`, provider: 'claude', added_at: '2026-01-01', last_seen_at: '2026-01-01' }
}
function isolated({ children }: { children: ReactNode }) { return <DesktopProvider isolated>{children}</DesktopProvider> }
function main({ children }: { children: ReactNode }) { return <DesktopProvider>{children}</DesktopProvider> }
function broadcast(message: unknown) { act(() => { mocks.handlers.get('desktop')?.(message) }) }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.handlers.clear()
  mocks.register.mockImplementation((id: string, handler: (message: unknown) => void) => { mocks.handlers.set(id, handler) })
  mocks.unregister.mockImplementation((id: string) => { mocks.handlers.delete(id) })
  localStorage.clear()
  localStorage.setItem(STORAGE_KEY, 'main-project')
})
afterEach(() => { vi.restoreAllMocks() })

describe.each(['MacIntel', 'Win32'])('isolated mission project context (%s frontend)', platform => {
  beforeEach(() => {
    vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform)
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ projects: [project('main-project', platform), project('mission-project', platform)] }) } as Response)
  })

  it('keeps Home unpinned on REST/WS hydration without adopting main selection', async () => {
    const { result } = renderHook(useDesktop, { wrapper: isolated })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.activeProjectId).toBeNull()
    expect(result.current.projects).toHaveLength(2)
    broadcast({ type: 'desktop.projects', projects: [project('main-project', platform), project('mission-project', platform)] })
    expect(result.current.activeProjectId).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('main-project')
    expect(mocks.setApiProject).not.toHaveBeenCalledWith('main-project')
  })

  it('preserves its explicit mission pin when main changes project and another project is added', async () => {
    const { result } = renderHook(useDesktop, { wrapper: isolated })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.setActiveProjectId('mission-project'))
    expect(mocks.setApiProject).toHaveBeenLastCalledWith('mission-project')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('main-project')

    // localStorage is shared by native windows; main is free to choose another
    // project while this renderer remains pinned to the detached conversation.
    localStorage.setItem(STORAGE_KEY, 'new-main-project')
    broadcast({ type: 'desktop.project_added', project: project('new-main-project', platform) })
    broadcast({ type: 'desktop.projects', projects: [project('new-main-project', platform), project('mission-project', platform)] })
    expect(result.current.activeProjectId).toBe('mission-project')
    expect(mocks.toast).not.toHaveBeenCalled()
    await act(async () => { await result.current.refreshProjects() })
    expect(result.current.activeProjectId).toBe('mission-project')
    expect(localStorage.getItem(STORAGE_KEY)).toBe('new-main-project')
    act(() => result.current.setActiveProjectId(null))
    expect(result.current.activeProjectId).toBeNull()
    expect(localStorage.getItem(STORAGE_KEY)).toBe('new-main-project')
  })

  it('removes a deleted mission project locally without clearing main selection or emitting a peer toast', async () => {
    const { result } = renderHook(useDesktop, { wrapper: isolated })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    act(() => result.current.setActiveProjectId('mission-project'))
    broadcast({ type: 'desktop.project_removed', projectId: 'mission-project' })
    expect(result.current.activeProjectId).toBeNull()
    expect(result.current.projects.map(item => item.id)).toEqual(['main-project'])
    expect(mocks.purge).toHaveBeenCalledWith('mission-project')
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.setApiProject).toHaveBeenLastCalledWith(null)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('main-project')
  })

  it('aborts outstanding hydration and removes listeners when the mission window closes', async () => {
    let finish!: (response: Response) => void
    vi.mocked(fetch).mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const { unmount } = renderHook(useDesktop, { wrapper: isolated })
    const request = vi.mocked(fetch).mock.calls[0][1]
    expect(request?.signal?.aborted).toBe(false)
    unmount()
    expect(request?.signal?.aborted).toBe(true)
    expect(mocks.handlers.has('desktop')).toBe(false)
    await act(async () => { finish({ ok: true, json: async () => ({ projects: [project('mission-project', platform)] }) } as Response) })
    const calls = vi.mocked(fetch).mock.calls.length
    act(() => window.dispatchEvent(new Event('focus')))
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls)
    expect(localStorage.getItem(STORAGE_KEY)).toBe('main-project')
    expect(mocks.setApiProject).not.toHaveBeenCalled()
  })
})

it('keeps normal main-window project restoration and persistence enabled', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ projects: [project('main-project', 'MacIntel'), project('other', 'MacIntel')] }) } as Response)
  const { result } = renderHook(useDesktop, { wrapper: main })
  await waitFor(() => expect(result.current.activeProjectId).toBe('main-project'))
  act(() => result.current.setActiveProjectId('other'))
  expect(localStorage.getItem(STORAGE_KEY)).toBe('other')
})
