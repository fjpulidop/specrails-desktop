import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { useRails } from '../useRails'

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/test-proj',
}))

let mockActiveProjectId: string | null = 'test-project'
vi.mock('../useDesktop', () => ({
  useDesktop: () => ({ activeProjectId: mockActiveProjectId }),
}))

let mockRegisterHandler: ReturnType<typeof vi.fn>
let mockUnregisterHandler: ReturnType<typeof vi.fn>
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: mockRegisterHandler,
    unregisterHandler: mockUnregisterHandler,
    connectionStatus: 'connected',
  }),
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper() {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(React.Fragment, null, children)
  }
}

function stubFetch(response: unknown, ok = true) {
  global.fetch = vi.fn().mockResolvedValue({
    ok,
    json: async () => response,
  })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useRails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRegisterHandler = vi.fn()
    mockUnregisterHandler = vi.fn()
    mockActiveProjectId = 'test-project'
    stubFetch({ rails: [
      { railIndex: 0, ticketIds: [1, 2], mode: 'implement' },
      { railIndex: 1, ticketIds: [], mode: 'implement' },
      { railIndex: 2, ticketIds: [], mode: 'implement' },
    ]})
  })

  it('returns default rail state on mount', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    expect(result.current.rails).toHaveLength(3)
    expect(result.current.rails[0].railIndex).toBe(0)
  })

  it('recovers rails after the active project database becomes available without changing projects', async () => {
    stubFetch({}, false)
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    const handler = mockRegisterHandler.mock.calls.at(-1)![1] as (message: unknown) => void
    stubFetch({ rails: [{ railIndex: 0, ticketIds: [9], mode: 'implement' }] })
    act(() => { handler({ type: 'desktop.project_recovered', projectId: 'other-project' }) })
    expect(global.fetch).not.toHaveBeenCalled()
    act(() => { handler({ type: 'desktop.project_recovered', projectId: 'test-project' }) })
    await waitFor(() => expect(result.current.rails[0].ticketIds).toEqual([9]))
    expect(result.current.error).toBeNull()
  })

  it('fetches rails on mount when activeProjectId is set', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/rails'),
        expect.objectContaining({ signal: expect.anything() })
      )
    })
    await waitFor(() => {
      expect(result.current.rails[0].ticketIds).toEqual([1, 2])
    })
  })

  it('resets rails when activeProjectId becomes null', async () => {
    mockActiveProjectId = null
    stubFetch({})
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current.rails.every((r) => r.ticketIds.length === 0)).toBe(true)
    })
    expect(result.current.error).toBeNull()
  })

  it('registers and unregisters WebSocket handler', () => {
    const { unmount } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    expect(mockRegisterHandler).toHaveBeenCalledWith('rails', expect.any(Function))
    unmount()
    expect(mockUnregisterHandler).toHaveBeenCalledWith('rails')
  })

  it('handles rail.job_started WS message', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.rails[0].ticketIds).toEqual([1, 2]))

    const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void
    act(() => {
      handler({
        type: 'rail.job_started',
        projectId: 'test-project',
        railIndex: 0,
        jobId: 'job-abc',
        mode: 'implement',
      })
    })

    await waitFor(() => {
      expect(result.current.activeRailJobs.get(0)?.jobId).toBe('job-abc')
    })
  })

  it('handles rail.job_stopped WS message', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void

    act(() => {
      handler({ type: 'rail.job_started', projectId: 'test-project', railIndex: 1, jobId: 'job-xyz', mode: 'implement' })
    })
    await waitFor(() => expect(result.current.activeRailJobs.get(1)).toBeDefined())

    act(() => {
      handler({ type: 'rail.job_stopped', projectId: 'test-project', railIndex: 1, jobId: 'job-xyz' })
    })
    await waitFor(() => expect(result.current.activeRailJobs.get(1)).toBeUndefined())
  })

  it('handles rail.job_completed WS message', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void

    act(() => {
      handler({ type: 'rail.job_started', projectId: 'test-project', railIndex: 0, jobId: 'job-1', mode: 'implement' })
    })
    await waitFor(() => expect(result.current.activeRailJobs.get(0)?.status).toBe('running'))

    act(() => {
      handler({ type: 'rail.job_completed', projectId: 'test-project', railIndex: 0, jobId: 'job-1', status: 'completed' })
    })
    await waitFor(() => expect(result.current.activeRailJobs.get(0)?.status).toBe('completed'))
  })

  it('ignores WS messages from different project', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void

    act(() => {
      handler({ type: 'rail.job_started', projectId: 'OTHER-PROJECT', railIndex: 0, jobId: 'job-1', mode: 'implement' })
    })
    expect(result.current.activeRailJobs.size).toBe(0)
  })

  it('ignores non-rail WS messages', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    const handler = mockRegisterHandler.mock.calls[0][1] as (msg: unknown) => void

    act(() => {
      handler({ type: 'some.other.message', railIndex: 0, jobId: 'job-1' })
    })
    expect(result.current.activeRailJobs.size).toBe(0)
  })

  it('assignTickets calls PUT API and refetches', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    stubFetch({ ok: true })
    await act(async () => {
      await result.current.assignTickets(0, [1, 2, 3])
    })
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rails/0/tickets'),
      expect.objectContaining({ method: 'PUT' })
    )
  })

  it('launchRail calls POST API and returns jobId', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    stubFetch({ jobId: 'new-job-123' })
    let jobId: string | null = null
    await act(async () => {
      jobId = await result.current.launchRail(1, 'implement')
    })
    expect(jobId).toBe('new-job-123')
  })

  it('launchRail returns null on error', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    stubFetch({}, false)
    let jobId: string | null = 'not-null'
    await act(async () => {
      jobId = await result.current.launchRail(0, 'implement')
    })
    expect(jobId).toBeNull()
  })

  it('stopRail calls POST API', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.loading).toBe(false))

    stubFetch({})
    await act(async () => {
      await result.current.stopRail(2)
    })
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/rails/2/stop'),
      expect.objectContaining({ method: 'POST' })
    )
  })

  it('sets error state when initial fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'))
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => {
      expect(result.current.error).toBe('Network error')
    })
  })

  it('refetch re-loads rails data', async () => {
    const { result } = renderHook(() => useRails(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.rails[0].ticketIds).toEqual([1, 2]))

    stubFetch({ rails: [
      { railIndex: 0, ticketIds: [5, 6], mode: 'implement' },
      { railIndex: 1, ticketIds: [], mode: 'implement' },
      { railIndex: 2, ticketIds: [], mode: 'implement' },
    ]})
    await act(async () => { result.current.refetch() })
    await waitFor(() => {
      expect(result.current.rails[0].ticketIds).toEqual([5, 6])
    })
  })
})
