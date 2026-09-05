import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { DesktopProvider, useDesktop } from '../useDesktop'
import { SharedWebSocketProvider } from '../useSharedWebSocket'

vi.mock('../../lib/api', () => ({
  setActiveProjectId: vi.fn(),
  setApiContext: vi.fn(),
  getApiBase: () => '/api',
}))

class MockWebSocket {
  static instances: MockWebSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  readyState = 1

  constructor(public url: string) {
    MockWebSocket.instances.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }

  send(_data: string) {}
  close() { this.onclose?.() }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

function makeWrapper() {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      SharedWebSocketProvider,
      { url: 'ws://localhost:4200' },
      React.createElement(DesktopProvider, null, children)
    )
  }
}

function makeProject(overrides: Partial<{ id: string; name: string }> = {}) {
  return {
    id: overrides.id ?? 'proj-1',
    slug: overrides.id ?? 'proj-1',
    name: overrides.name ?? 'Project One',
    path: '/path/to/proj',
    db_path: '/path/.specrails/jobs.sqlite',
    added_at: '2024-01-01T00:00:00Z',
    last_seen_at: '2024-01-01T00:00:00Z',
  }
}

describe('useDesktop - error paths', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    MockWebSocket.instances = []
    ;(global as unknown as Record<string, unknown>).WebSocket = MockWebSocket
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ projects: [] }),
    })
  })

  it('addProject: throws when fetch returns non-ok', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ projects: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: () => Promise.resolve({ error: 'Project already exists' }),
      })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(
      act(async () => {
        await result.current.addProject('/path/to/existing')
      })
    ).rejects.toThrow('Project already exists')
  })

  it('addProject: throws with HTTP status when no error message', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ projects: [] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(
      act(async () => {
        await result.current.addProject('/path/to/proj')
      })
    ).rejects.toThrow('HTTP 500')
  })

  it('addProject: with optional name parameter includes name in body', async () => {
    const newProject = makeProject({ id: 'named-proj', name: 'Named Project' })
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ projects: [] }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ project: newProject, has_specrails: true }) })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await act(async () => {
      await result.current.addProject('/path/to/proj', 'Named Project')
    })

    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls
    const postCall = calls.find((c: [string, RequestInit]) => c[1]?.method === 'POST')
    expect(postCall).toBeDefined()
    const body = JSON.parse(postCall![1].body as string)
    expect(body.name).toBe('Named Project')
    // Silent add: providers omitted — the server registers with the detected set.
    expect(body.providers).toBeUndefined()
  })

  it('removeProject: throws when fetch returns non-ok', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ projects: [makeProject()] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: () => Promise.resolve({ error: 'Project not found' }),
      })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(
      act(async () => {
        await result.current.removeProject('proj-1')
      })
    ).rejects.toThrow('Project not found')
  })

  it('removeProject: throws with HTTP status when no error message', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ projects: [makeProject()] }) })
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        json: () => Promise.resolve({}),
      })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(
      act(async () => {
        await result.current.removeProject('proj-1')
      })
    ).rejects.toThrow('HTTP 403')
  })

  it('does not mistake a startup failure for an empty database and recovers automatically', async () => {
    vi.useFakeTimers()
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [makeProject()] }) })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(result.current.isLoading).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.projects).toHaveLength(1)
    vi.useRealTimers()
  })

  it('keeps the newer WebSocket project snapshot when an older REST response arrives late', async () => {
    let complete!: (response: unknown) => void
    ;(global.fetch as ReturnType<typeof vi.fn>).mockImplementationOnce(() => new Promise((resolve) => { complete = resolve }))
    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    act(() => {
      MockWebSocket.instances[0].simulateMessage({ type: 'desktop.projects', projects: [makeProject({ id: 'live-project' })] })
    })
    await act(async () => { complete({ ok: true, json: async () => ({ projects: [] }) }) })
    expect(result.current.projects.map((project) => project.id)).toEqual(['live-project'])
    expect(result.current.activeProjectId).toBe('live-project')
  })

  it('preserves loaded projects during a failed focus refresh', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ projects: [makeProject()] }) })
      .mockRejectedValue(new Error('sidecar restarting'))
    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.projects).toHaveLength(1))
    await act(async () => { window.dispatchEvent(new Event('focus')) })
    expect(result.current.projects).toHaveLength(1)
    expect(result.current.isLoading).toBe(false)
  })

  it('WS desktop.project_added: does not add duplicate project', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [makeProject({ id: 'dup-proj' })] }),
    })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await waitFor(() => MockWebSocket.instances.length > 0)
    const ws = MockWebSocket.instances[0]
    await act(async () => { ws.onopen?.() })

    // Simulate adding the same project again
    act(() => {
      ws.simulateMessage({
        type: 'desktop.project_added',
        project: makeProject({ id: 'dup-proj', name: 'Duplicate Project' }),
      })
    })

    // Should still only have 1 project (duplicate not added)
    expect(result.current.projects).toHaveLength(1)
  })

  it('WS desktop.project_removed: does not deactivate if different project is active', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        projects: [
          makeProject({ id: 'proj-keep' }),
          makeProject({ id: 'proj-remove' }),
        ],
      }),
    })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Set active to proj-keep
    act(() => { result.current.setActiveProjectId('proj-keep') })
    expect(result.current.activeProjectId).toBe('proj-keep')

    await waitFor(() => MockWebSocket.instances.length > 0)
    const ws = MockWebSocket.instances[0]
    await act(async () => { ws.onopen?.() })

    act(() => {
      ws.simulateMessage({ type: 'desktop.project_removed', projectId: 'proj-remove' })
    })

    // Active project should remain proj-keep since we removed proj-remove
    expect(result.current.activeProjectId).toBe('proj-keep')
    expect(result.current.projects).toHaveLength(1)
  })

  it('WS ignores messages with non-string type', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [makeProject()] }),
    })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await waitFor(() => MockWebSocket.instances.length > 0)
    const ws = MockWebSocket.instances[0]
    await act(async () => { ws.onopen?.() })

    const before = result.current.projects.length

    act(() => {
      ws.simulateMessage({ type: 42, something: 'bad' })
    })

    // No change since type is not a string
    expect(result.current.projects.length).toBe(before)
  })

  it('WS desktop.projects: keeps active project if it exists in new list', async () => {
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ projects: [makeProject({ id: 'existing' })] }),
    })

    const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await waitFor(() => MockWebSocket.instances.length > 0)
    const ws = MockWebSocket.instances[0]
    await act(async () => { ws.onopen?.() })

    // Set active project via WS (REST load no longer auto-selects)
    act(() => {
      ws.simulateMessage({ type: 'desktop.projects', projects: [makeProject({ id: 'existing' })] })
    })
    await waitFor(() => expect(result.current.activeProjectId).toBe('existing'))

    // Send updated list — active project should stay 'existing'
    act(() => {
      ws.simulateMessage({
        type: 'desktop.projects',
        projects: [
          makeProject({ id: 'existing' }),
          makeProject({ id: 'new-one' }),
        ],
      })
    })

    // active project stays 'existing' since it's still in the list
    expect(result.current.activeProjectId).toBe('existing')
  })

  describe('isSwitchingProject', () => {
    it('starts as false after initial load', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })] }),
      })
      const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.isLoading).toBe(false))
      expect(result.current.isSwitchingProject).toBe(false)
    })

    it('becomes true immediately when switching to a different project', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })] }),
      })
      const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      await waitFor(() => MockWebSocket.instances.length > 0)
      const ws = MockWebSocket.instances[0]
      await act(async () => { ws.onopen?.() })

      // Set active project to p1 via WS (REST no longer auto-selects)
      act(() => {
        ws.simulateMessage({
          type: 'desktop.projects',
          projects: [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })],
        })
      })
      await waitFor(() => expect(result.current.activeProjectId).toBe('p1'))

      act(() => { result.current.setActiveProjectId('p2') })
      expect(result.current.isSwitchingProject).toBe(true)
    })

    it('clears isSwitchingProject after 400ms', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [makeProject({ id: 'p1' }), makeProject({ id: 'p2' })] }),
      })
      const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      act(() => { result.current.setActiveProjectId('p2') })
      await waitFor(() => expect(result.current.isSwitchingProject).toBe(false), { timeout: 1000 })
    })

    it('stays false when setting the same project id', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ projects: [makeProject({ id: 'p1' })] }),
      })
      const { result } = renderHook(() => useDesktop(), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.isLoading).toBe(false))

      act(() => { result.current.setActiveProjectId('p1') })
      expect(result.current.isSwitchingProject).toBe(false)
    })
  })
})
