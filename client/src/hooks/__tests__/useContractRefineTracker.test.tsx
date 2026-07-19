import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, render } from '@testing-library/react'
import { toast } from 'sonner'

import { ContractRefineTrackerProvider } from '../useContractRefineTracker'
import { SharedWebSocketContext } from '../useSharedWebSocket'

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
  },
}))

vi.mock('../../lib/origin', () => ({ API_ORIGIN: '' }))

type Handler = (message: unknown) => void

function makeWs() {
  const handlers = new Map<string, Handler>()
  return {
    registerHandler: vi.fn((id: string, handler: Handler) => handlers.set(id, handler)),
    unregisterHandler: vi.fn((id: string) => handlers.delete(id)),
    connectionStatus: 'connected' as const,
    emit(message: unknown) {
      for (const handler of handlers.values()) handler(message)
    },
  }
}

function renderTracker(ws: ReturnType<typeof makeWs>) {
  return render(
    <SharedWebSocketContext.Provider value={ws as never}>
      <ContractRefineTrackerProvider>{null}</ContractRefineTrackerProvider>
    </SharedWebSocketContext.Provider>,
  )
}

describe('ContractRefineTrackerProvider provider-safe retry UX', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) } as Response))
  })

  it('does not offer Retry for a Kimi Contract Refine failure', () => {
    const ws = makeWs()
    renderTracker(ws)

    act(() => {
      ws.emit({
        type: 'explore.contract_refine_failed',
        projectId: 'p',
        ticketId: 7,
        provider: 'kimi',
        reason: 'provider-unsupported',
      })
    })

    expect(toast.error).toHaveBeenCalledTimes(1)
    const options = vi.mocked(toast.error).mock.calls[0][1] as { action?: unknown }
    expect(options.action).toBeUndefined()
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('keeps Retry for a Claude failure and sends no provider-changing override', async () => {
    const ws = makeWs()
    renderTracker(ws)

    act(() => {
      ws.emit({
        type: 'explore.contract_refine_failed',
        projectId: 'p',
        ticketId: 8,
        provider: 'claude',
        reason: 'timeout',
      })
    })

    const options = vi.mocked(toast.error).mock.calls[0][1] as {
      action?: { onClick?: () => void }
    }
    expect(options.action).toBeDefined()
    await act(async () => {
      options.action?.onClick?.()
      await Promise.resolve()
    })
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/projects/p/tickets/8/contract-refine'),
      { method: 'POST' },
    )
  })
})
