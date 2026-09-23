import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useActivity } from '../useActivity'

// ─── Mock useSharedWebSocket ───────────────────────────────────────────────────

let registeredHandler: ((msg: unknown) => void) | null = null

vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn((_id: string, fn: (msg: unknown) => void) => {
      registeredHandler = fn
    }),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected' as const,
  }),
}))

// ─── Mock lib/api ──────────────────────────────────────────────────────────────

vi.mock('../../../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeActivityItem(overrides: Partial<{ id: string; type: string; jobId: string }> = {}) {
  return {
    id: overrides.id ?? 'item-1',
    type: (overrides.type ?? 'job_completed') as 'job_started' | 'job_completed' | 'job_failed' | 'job_canceled',
    jobId: overrides.jobId ?? 'job-1',
    jobCommand: '/architect',
    timestamp: '2024-01-01T12:00:00Z',
    summary: 'Completed',
    costUsd: 0.05,
  }
}

describe('useActivity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredHandler = null
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => [],
    })
  })

  describe('initial state', () => {
    it('starts with empty items and loading=false when no projectId', () => {
      const { result } = renderHook(() => useActivity({ activeProjectId: null }))
      expect(result.current.items).toEqual([])
      expect(result.current.loading).toBe(false)
    })

    it('starts with hasMore=true', () => {
      const { result } = renderHook(() => useActivity({ activeProjectId: null }))
      expect(result.current.hasMore).toBe(true)
    })
  })

  describe('data fetching', () => {
    it('fetches activity on mount when projectId is provided', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [makeActivityItem()],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/activity?limit=50')
      )
      expect(result.current.items).toHaveLength(1)
    })

    it('sets hasMore=false when returned items < limit', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [makeActivityItem()],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1', limit: 50 }))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.hasMore).toBe(false)
    })

    it('sets hasMore=true when returned items equals limit', async () => {
      const items = Array.from({ length: 3 }, (_, i) =>
        makeActivityItem({ id: `item-${i}`, jobId: `job-${i}` })
      )
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => items,
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1', limit: 3 }))

      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.hasMore).toBe(true)
    })

    it('clears items when projectId changes', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, json: async () => [makeActivityItem()] })
        .mockResolvedValueOnce({ ok: true, json: async () => [] })

      const { result, rerender } = renderHook(
        ({ projectId }: { projectId: string | null }) => useActivity({ activeProjectId: projectId }),
        { initialProps: { projectId: 'proj-1' } }
      )

      await waitFor(() => expect(result.current.items).toHaveLength(1))

      act(() => rerender({ projectId: 'proj-2' }))
      // Items should reset immediately on project change
      expect(result.current.items).toHaveLength(0)
    })

    it('does not fetch when projectId is null', () => {
      renderHook(() => useActivity({ activeProjectId: null }))
      expect(global.fetch).not.toHaveBeenCalled()
    })

    it('handles fetch error gracefully (no crash)', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('network'))

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))
      expect(result.current.items).toEqual([])
    })
  })

  describe('WebSocket real-time updates', () => {
    it('appends items from queue message with completed jobs', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => {
        registeredHandler?.({
          type: 'queue',
          projectId: 'proj-1',
          jobs: [
            { id: 'job-ws-1', status: 'completed', command: '/developer', startedAt: '2024-01-01T12:00:00Z' },
          ],
        })
      })

      expect(result.current.items.some((i) => i.jobId === 'job-ws-1')).toBe(true)
    })

    it('filters out messages for other projects', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => {
        registeredHandler?.({
          type: 'queue',
          projectId: 'proj-OTHER',
          jobs: [{ id: 'job-other', status: 'completed', command: '/developer' }],
        })
      })

      expect(result.current.items).toHaveLength(0)
    })

    it('deduplicates items from websocket updates', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [makeActivityItem({ id: 'item-dup', jobId: 'job-dup', type: 'job_completed' })],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.items).toHaveLength(1))

      act(() => {
        registeredHandler?.({
          type: 'queue',
          projectId: 'proj-1',
          jobs: [{ id: 'job-dup', status: 'completed', command: '/architect', startedAt: '2024-01-01T12:00:00Z' }],
        })
      })

      // Should not have duplicate (same type+jobId key)
      const matching = result.current.items.filter((i) => i.jobId === 'job-dup')
      expect(matching).toHaveLength(1)
    })

    it('handles phase messages and maps them to job_started type', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => {
        registeredHandler?.({
          type: 'phase',
          projectId: 'proj-1',
          phase: 'architect',
          state: 'running',
          timestamp: '2024-01-01T12:00:00Z',
        })
      })

      expect(result.current.items.some((i) => i.type === 'job_started')).toBe(true)
    })

    it('ignores messages with no type', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => { registeredHandler?.({ noType: true }) })
      expect(result.current.items).toHaveLength(0)
    })
  })

  describe('loadMore', () => {
    it('does nothing when hasMore=false', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })

      const { result } = renderHook(() => useActivity({ activeProjectId: 'proj-1' }))
      await waitFor(() => expect(result.current.loading).toBe(false))

      const callCount = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.length

      act(() => { result.current.loadMore() })
      // No additional fetch since hasMore=false
      expect((global.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCount)
    })
  })
})
