import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useTickets, type LocalTicket } from '../useTickets'

// ─── Mock useSharedWebSocket ───────────────────────────────────────────────────

let wsHandler: ((msg: unknown) => void) | null = null

vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: vi.fn((_id: string, fn: (msg: unknown) => void) => {
      wsHandler = fn
    }),
    unregisterHandler: vi.fn(),
    connectionStatus: 'connected' as const,
  }),
}))

// ─── Mock useDesktop ───────────────────────────────────────────────────────────────

let mockActiveProjectId: string | null = 'proj-1'

vi.mock('../useDesktop', () => ({
  useDesktop: () => ({
    get activeProjectId() { return mockActiveProjectId },
  }),
}))

// ─── Mock lib/api ──────────────────────────────────────────────────────────────

vi.mock('../../lib/api', () => ({
  getApiBase: () => '/api/projects/proj-1',
}))

// ─── Mock sonner toast ─────────────────────────────────────────────────────────

const mockToastSuccess = vi.fn()
vi.mock('sonner', () => ({
  toast: { success: (...args: unknown[]) => mockToastSuccess(...args) },
}))

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTicket(overrides: Partial<LocalTicket> = {}): LocalTicket {
  return {
    id: 1,
    title: 'Test ticket',
    description: 'A test ticket',
    status: 'todo',
    priority: 'medium',
    labels: [],
    assignee: null,
    prerequisites: [],
    metadata: {},
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    created_by: 'user',
    source: 'manual',
    ...overrides,
  }
}

describe('useTickets', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    wsHandler = null
    mockActiveProjectId = 'proj-1'
    ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ tickets: [] }),
    })
  })

  // ── Initial state ──────────────────────────────────────────────────────────

  describe('initial state', () => {
    it('reloads only the active project when its database recovers after an unavailable read', async () => {
      const fetchMock = vi.mocked(global.fetch)
      fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response)
      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.error).toContain('503'))
      const calls = fetchMock.mock.calls.length
      act(() => { wsHandler?.({ type: 'desktop.project_recovered', projectId: 'other-project' }) })
      expect(fetchMock).toHaveBeenCalledTimes(calls)
      const ticket = makeTicket({ id: 33 })
      fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ tickets: [ticket] }) } as Response)
      act(() => { wsHandler?.({ type: 'desktop.project_recovered', projectId: 'proj-1' }) })
      await waitFor(() => expect(result.current.tickets).toEqual([ticket]))
      expect(result.current.error).toBeNull()
    })

    it('returns empty tickets when no projectId', () => {
      mockActiveProjectId = null
      const { result } = renderHook(() => useTickets())
      expect(result.current.tickets).toEqual([])
      expect(result.current.loading).toBe(false)
      expect(result.current.error).toBeNull()
    })

    it('fetches tickets when projectId is set', async () => {
      const tickets = [makeTicket({ id: 1 }), makeTicket({ id: 2, title: 'Another' })]
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets }),
      })

      const { result } = renderHook(() => useTickets())

      await waitFor(() => {
        expect(result.current.tickets).toHaveLength(2)
      })
      expect(result.current.loading).toBe(false)
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets',
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      )
    })

    it('handles API error gracefully', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({}),
      })

      const { result } = renderHook(() => useTickets())

      await waitFor(() => {
        expect(result.current.error).toContain('500')
      })
      expect(result.current.tickets).toEqual([])
    })

    it('handles array response format', async () => {
      const tickets = [makeTicket({ id: 1 })]
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => tickets,
      })

      const { result } = renderHook(() => useTickets())

      await waitFor(() => {
        expect(result.current.tickets).toHaveLength(1)
      })
    })
  })

  // ── WebSocket: ticket_created ──────────────────────────────────────────────

  describe('ticket_created', () => {
    it('adds a new ticket from WS event', async () => {
      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.loading).toBe(false))

      const newTicket = makeTicket({ id: 5, title: 'New from CLI' })
      act(() => {
        wsHandler?.({
          type: 'ticket_created',
          projectId: 'proj-1',
          ticket: newTicket,
          timestamp: new Date().toISOString(),
        })
      })

      expect(result.current.tickets).toHaveLength(1)
      expect(result.current.tickets[0].id).toBe(5)
    })

    it('shows toast and sets glow for new ticket', async () => {
      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.loading).toBe(false))

      const newTicket = makeTicket({ id: 5, title: 'New from CLI' })
      act(() => {
        wsHandler?.({
          type: 'ticket_created',
          projectId: 'proj-1',
          ticket: newTicket,
        })
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('New ticket: New from CLI', expect.objectContaining({ id: 'new-ticket-5' }))
      expect(result.current.newTicketIds.has(5)).toBe(true)
    })

    it('deduplicates already-known ticket IDs', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1 })] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(1))

      act(() => {
        wsHandler?.({
          type: 'ticket_created',
          projectId: 'proj-1',
          ticket: makeTicket({ id: 1 }),
        })
      })

      expect(result.current.tickets).toHaveLength(1)
    })

    it('ignores events from other projects', async () => {
      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => {
        wsHandler?.({
          type: 'ticket_created',
          projectId: 'proj-other',
          ticket: makeTicket({ id: 99 }),
        })
      })

      expect(result.current.tickets).toHaveLength(0)
    })
  })

  // ── WebSocket: ticket_updated ──────────────────────────────────────────────

  describe('ticket_updated', () => {
    it('updates existing ticket in-place', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1, title: 'Original' })] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(1))

      act(() => {
        wsHandler?.({
          type: 'ticket_updated',
          projectId: 'proj-1',
          ticket: makeTicket({ id: 1, title: 'Updated title', status: 'in_progress' }),
        })
      })

      expect(result.current.tickets[0].title).toBe('Updated title')
      expect(result.current.tickets[0].status).toBe('in_progress')
    })

    it('clears Contract Layer refining state when the updated ticket contains the Contract Layer', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1, title: 'Original' })] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(1))

      act(() => {
        wsHandler?.({
          type: 'explore.contract_refine_started',
          projectId: 'proj-1',
          ticketId: 1,
        })
      })
      expect(result.current.contractRefiningIds.has(1)).toBe(true)

      act(() => {
        wsHandler?.({
          type: 'ticket_updated',
          projectId: 'proj-1',
          ticket: makeTicket({
            id: 1,
            description: 'body\n\n---\n\n## Contract Layer\n\n{}',
          }),
        })
      })

      expect(result.current.contractRefiningIds.has(1)).toBe(false)
    })

    it('triggers full refetch on id:0 (file watcher signal)', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.loading).toBe(false))

      // Reset fetch mock to return new data
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 10, title: 'From CLI' })] }),
      })

      act(() => {
        wsHandler?.({
          type: 'ticket_updated',
          projectId: 'proj-1',
          ticket: { id: 0 },
        })
      })

      await waitFor(() => {
        expect(result.current.tickets).toHaveLength(1)
      })
      expect(result.current.tickets[0].title).toBe('From CLI')
    })
  })

  describe('contract refine websocket events', () => {
    it('tracks started and failed Contract Layer refinement states', async () => {
      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.loading).toBe(false))

      act(() => {
        wsHandler?.({
          type: 'explore.contract_refine_started',
          projectId: 'proj-1',
          ticketId: 9,
        })
      })
      expect(result.current.contractRefiningIds.has(9)).toBe(true)

      act(() => {
        wsHandler?.({
          type: 'explore.contract_refine_failed',
          projectId: 'proj-1',
          ticketId: 9,
        })
      })
      expect(result.current.contractRefiningIds.has(9)).toBe(false)
    })
  })

  // ── WebSocket: ticket_deleted ──────────────────────────────────────────────

  describe('ticket_deleted', () => {
    it('removes ticket from list', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1 }), makeTicket({ id: 2, title: 'Two' })] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(2))

      act(() => {
        wsHandler?.({
          type: 'ticket_deleted',
          projectId: 'proj-1',
          ticketId: 1,
        })
      })

      expect(result.current.tickets).toHaveLength(1)
      expect(result.current.tickets[0].id).toBe(2)
    })
  })

  // ── Project switch ─────────────────────────────────────────────────────────

  describe('project switch', () => {
    it('resets tickets on project change', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1 })] }),
      })

      const { result, rerender } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(1))

      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [] }),
      })

      // Simulate project switch by changing the mock activeProjectId
      mockActiveProjectId = 'proj-2'
      rerender()

      await waitFor(() => {
        expect(result.current.tickets).toEqual([])
      })
    })

    it('aborts and ignores an old manual refetch after switching projects', async () => {
      let resolveOldRefetch!: (value: Response) => void
      let oldRefetchSignal: AbortSignal | undefined
      const fetchMock = vi.fn()
        .mockResolvedValueOnce({ ok: true, json: async () => ({ tickets: [makeTicket({ title: 'Project A' })] }) })
        .mockImplementationOnce((_url: string, init?: RequestInit) => {
          oldRefetchSignal = init?.signal as AbortSignal | undefined
          return new Promise<Response>((resolve) => { resolveOldRefetch = resolve })
        })
        .mockResolvedValueOnce({ ok: true, json: async () => ({ tickets: [makeTicket({ title: 'Project B' })] }) })
      global.fetch = fetchMock as typeof fetch

      const { result, rerender } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets[0]?.title).toBe('Project A'))
      act(() => { void result.current.refetch() })
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

      mockActiveProjectId = 'proj-2'
      rerender()
      await waitFor(() => expect(result.current.tickets[0]?.title).toBe('Project B'))
      expect(fetchMock.mock.calls[2][0]).toBe('/api/projects/proj-2/tickets')
      expect(oldRefetchSignal?.aborted).toBe(true)

      await act(async () => {
        resolveOldRefetch({ ok: true, json: async () => ({ tickets: [makeTicket({ title: 'Stale A' })] }) } as Response)
        await Promise.resolve()
      })
      expect(result.current.tickets[0]?.title).toBe('Project B')
    })

    it('keeps an in-flight mutation bound to its owner and does not refetch the new project', async () => {
      let resolvePatch!: (value: Response) => void
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'PATCH') {
          return new Promise<Response>((resolve) => { resolvePatch = resolve })
        }
        const title = url.includes('proj-2') ? 'Project B' : 'Project A'
        return Promise.resolve({ ok: true, json: async () => ({ tickets: [makeTicket({ title })] }) } as Response)
      })
      global.fetch = fetchMock as typeof fetch

      const { result, rerender } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets[0]?.title).toBe('Project A'))
      let mutation!: Promise<boolean>
      act(() => { mutation = result.current.updateTicket(1, { title: 'Changed in A' }) })

      mockActiveProjectId = 'proj-2'
      rerender()
      await waitFor(() => expect(result.current.tickets[0]?.title).toBe('Project B'))
      resolvePatch({ ok: true } as Response)
      await act(async () => { expect(await mutation).toBe(true) })

      const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
      expect(patchCall?.[0]).toBe('/api/projects/proj-1/tickets/1')
      const projectBReads = fetchMock.mock.calls.filter(([url, init]) => String(url).includes('proj-2') && !init?.method)
      expect(projectBReads).toHaveLength(1)
    })
  })

  // ── Refetch with toast ─────────────────────────────────────────────────────

  describe('refetch with new tickets', () => {
    it('shows toast and glow when refetch finds new tickets', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [makeTicket({ id: 1 })] }),
      })

      const { result } = renderHook(() => useTickets())
      await waitFor(() => expect(result.current.tickets).toHaveLength(1))

      // Refetch returns existing + 2 new
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({
          tickets: [
            makeTicket({ id: 1 }),
            makeTicket({ id: 2, title: 'New A' }),
            makeTicket({ id: 3, title: 'New B' }),
          ],
        }),
      })

      act(() => { result.current.refetch() })

      await waitFor(() => {
        expect(result.current.tickets).toHaveLength(3)
      })

      expect(mockToastSuccess).toHaveBeenCalledWith('2 new tickets added from product discovery', expect.objectContaining({ id: expect.stringContaining('tickets-added-') }))
      expect(result.current.newTicketIds.has(2)).toBe(true)
      expect(result.current.newTicketIds.has(3)).toBe(true)
    })
  })

  describe('createTicket', () => {
    it('POSTs the new ticket and returns true on success', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true,
        json: async () => ({ tickets: [] }),
      })
      const { result } = renderHook(() => useTickets())
      let ok = false
      await act(async () => { ok = await result.current.createTicket({ title: 'X', description: 'Y' }) })
      expect(ok).toBe(true)
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'X', description: 'Y' }),
        }),
      )
    })

    it('returns false when server rejects', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true, json: async () => ({ tickets: [] }),
      }).mockResolvedValueOnce({
        ok: false, json: async () => ({}),
      })
      const { result } = renderHook(() => useTickets())
      let ok: boolean | null = null
      await act(async () => { ok = await result.current.createTicket({ title: 'fail' }) })
      expect(ok).toBe(false)
    })
  })

  describe('updateTicket', () => {
    it('PATCHes the changed fields and returns true on success', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: true, json: async () => ({ tickets: [] }),
      })
      const { result } = renderHook(() => useTickets())
      let ok = false
      await act(async () => { ok = await result.current.updateTicket(42, { title: 'new title' }) })
      expect(ok).toBe(true)
      expect(global.fetch).toHaveBeenCalledWith(
        '/api/projects/proj-1/tickets/42',
        expect.objectContaining({
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: 'new title' }),
        }),
      )
    })

    it('returns false when server rejects update', async () => {
      ;(global.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        ok: true, json: async () => ({ tickets: [] }),
      }).mockResolvedValueOnce({
        ok: false, json: async () => ({}),
      })
      const { result } = renderHook(() => useTickets())
      let ok: boolean | null = null
      await act(async () => { ok = await result.current.updateTicket(7, { status: 'done' }) })
      expect(ok).toBe(false)
    })
  })
})
