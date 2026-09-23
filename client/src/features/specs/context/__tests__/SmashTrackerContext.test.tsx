import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, renderHook, act } from '@testing-library/react'
import { toast } from 'sonner'

import {
  SmashTrackerProvider,
  useSmashInflight,
  useIsSmashing,
} from '../SmashTrackerContext'
import { SharedWebSocketContext } from '../../../../hooks/useSharedWebSocket'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  },
}))

vi.mock('../../../../lib/origin', () => ({
  API_ORIGIN: '',
}))

// ─── WS harness ──────────────────────────────────────────────────────────────

type Handler = (msg: unknown) => void

function makeWsValue() {
  const handlers = new Map<string, Handler>()
  return {
    handlers,
    registerHandler: vi.fn((id: string, fn: Handler) => { handlers.set(id, fn) }),
    unregisterHandler: vi.fn((id: string) => { handlers.delete(id) }),
    connectionStatus: 'connected' as const,
    emit: (msg: unknown) => {
      for (const h of handlers.values()) h(msg)
    },
  }
}

function withWs(ws: ReturnType<typeof makeWsValue>) {
  return ({ children }: { children: React.ReactNode }) => (
    <SharedWebSocketContext.Provider value={ws as never}>
      <SmashTrackerProvider>{children}</SmashTrackerProvider>
    </SharedWebSocketContext.Provider>
  )
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SmashTrackerProvider', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) } as Response))
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('registers five WS handlers on mount and unregisters on unmount', () => {
    const ws = makeWsValue()
    const { unmount } = render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    expect(ws.registerHandler).toHaveBeenCalledTimes(5)
    unmount()
    expect(ws.unregisterHandler).toHaveBeenCalledTimes(5)
  })

  it('tracks inflight stage on smash.started + progress events', () => {
    const ws = makeWsValue()
    const { result } = renderHook(() => useSmashInflight(42), { wrapper: withWs(ws) })
    expect(result.current).toBeNull()

    act(() => {
      ws.emit({ type: 'smash.started', projectId: 'p', ticketId: 42, runId: 'r1', timestamp: 't' })
    })
    expect(result.current?.stage).toBe('analyzing')

    act(() => {
      ws.emit({ type: 'smash.progress', projectId: 'p', ticketId: 42, runId: 'r1', stage: 'identifying', timestamp: 't' })
    })
    expect(result.current?.stage).toBe('identifying')

    act(() => {
      ws.emit({ type: 'smash.progress', projectId: 'p', ticketId: 42, runId: 'r1', stage: 'ordering', timestamp: 't' })
    })
    expect(result.current?.stage).toBe('ordering')
  })

  it('useIsSmashing returns true while inflight, false otherwise', () => {
    const ws = makeWsValue()
    const { result } = renderHook(() => useIsSmashing(42), { wrapper: withWs(ws) })
    expect(result.current).toBe(false)
    act(() => {
      ws.emit({ type: 'smash.started', projectId: 'p', ticketId: 42, runId: 'r1', timestamp: 't' })
    })
    expect(result.current).toBe(true)
    act(() => {
      ws.emit({
        type: 'smash.completed',
        projectId: 'p',
        ticketId: 42,
        runId: 'r1',
        smashedAt: '2026-05-16T00:00:00Z',
        childrenIds: [1, 2, 3],
        timestamp: 't',
      })
    })
    expect(result.current).toBe(false)
  })

  it('shows success toast with Deshacer action on smash.completed', () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({
        type: 'smash.completed',
        projectId: 'proj-1',
        ticketId: 5,
        runId: 'r1',
        smashedAt: '2026-05-16T00:00:00Z',
        childrenIds: [10, 11, 12, 13],
        timestamp: 't',
      })
    })
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('4 Sub-Specs'),
      expect.objectContaining({
        duration: 10000,
        action: expect.objectContaining({ label: 'Undo' }),
      }),
    )
  })

  it('Deshacer action POSTs to the undo endpoint with smashedAt', async () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({
        type: 'smash.completed',
        projectId: 'proj-1',
        ticketId: 5,
        runId: 'r1',
        smashedAt: '2026-05-16T12:00:00Z',
        childrenIds: [10],
        timestamp: 't',
      })
    })
    const call = (toast.success as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = call[1] as { action: { onClick: () => void } }
    await act(async () => {
      opts.action.onClick()
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/tickets/5/smash/undo'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"smashedAt":"2026-05-16T12:00:00Z"'),
      }),
    )
  })

  it('shows error toast with Retry action on smash.failed', () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({
        type: 'smash.failed',
        projectId: 'proj-1',
        ticketId: 7,
        runId: 'r-fail',
        reason: 'invalid-output',
        timestamp: 't',
      })
    })
    expect(toast.error).toHaveBeenCalledWith(
      'SMASH could not complete',
      expect.objectContaining({
        description: expect.stringContaining('invalid output'),
        action: expect.objectContaining({ label: 'Retry' }),
      }),
    )
  })

  it('Retry POSTs to the smash endpoint', async () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({
        type: 'smash.failed',
        projectId: 'proj-1',
        ticketId: 9,
        runId: 'r',
        reason: 'invalid-output',
        timestamp: 't',
      })
    })
    const call = (toast.error as ReturnType<typeof vi.fn>).mock.calls[0]
    const opts = call[1] as { action: { onClick: () => void } }
    await act(async () => {
      opts.action.onClick()
      await new Promise((r) => setTimeout(r, 5))
    })
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/proj-1/tickets/9/smash'),
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('clears inflight state and dismisses toast on smash.undone', () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({
        type: 'smash.undone',
        projectId: 'proj-1',
        ticketId: 11,
        childrenIds: [20, 21],
        timestamp: 't',
      })
    })
    expect(toast.dismiss).toHaveBeenCalledWith('smash:11')
    expect(toast.success).toHaveBeenCalledWith('SMASH undone', expect.any(Object))
  })

  it('ignores non-SMASH messages', () => {
    const ws = makeWsValue()
    render(
      <SharedWebSocketContext.Provider value={ws as never}>
        <SmashTrackerProvider>{null}</SmashTrackerProvider>
      </SharedWebSocketContext.Provider>,
    )
    act(() => {
      ws.emit({ type: 'ticket_updated', projectId: 'p', ticket: {} })
      ws.emit({ type: 'unrelated.event', projectId: 'p' })
    })
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('clears inflight state when the failed event arrives', () => {
    const ws = makeWsValue()
    const { result } = renderHook(() => useSmashInflight(99), { wrapper: withWs(ws) })
    act(() => {
      ws.emit({ type: 'smash.started', projectId: 'p', ticketId: 99, runId: 'r', timestamp: 't' })
    })
    expect(result.current?.stage).toBe('analyzing')
    act(() => {
      ws.emit({
        type: 'smash.failed',
        projectId: 'p',
        ticketId: 99,
        runId: 'r',
        reason: 'timeout',
        timestamp: 't',
      })
    })
    expect(result.current).toBeNull()
  })
})
