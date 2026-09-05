import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

// loop.provider_limit: the provider answered a loop step with a usage/rate-
// limit notice and the run stopped at once. The user gets ONE honest alert
// with the provider's reset hint — the fact that decides when to relaunch.

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
    connectionStatus: 'connected',
  }),
}))
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => vi.fn() }
})
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: (...a: unknown[]) => toastError(...a) },
}))

import { useOsNotifications, setOsNotificationPrefs } from '../useOsNotifications'

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}
function send(msg: Record<string, unknown>) {
  act(() => { capturedHandler?.(msg) })
}

describe('useOsNotifications — loop.provider_limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    localStorage.clear()
    Object.defineProperty(window, 'Notification', { value: undefined, writable: true, configurable: true })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('toasts the provider, the reset hint and the provider\'s own sentence, keyed by run', () => {
    renderHook(() => useOsNotifications({ projectsById: new Map([['p1', 'NeoTetris']]) }), { wrapper })
    send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-1', provider: 'claude', kind: 'session_limit', message: "You've hit your session limit · resets 3am (Europe/Madrid)", resetsAt: '3am (Europe/Madrid)' })
    expect(toastError).toHaveBeenCalledTimes(1)
    const [title, opts] = toastError.mock.calls[0] as [string, { id: string; description: string; duration: number }]
    expect(title).toBe('Provider usage limit reached')
    expect(opts.id).toBe('provider-limit:run-1')
    expect(opts.description).toContain('[NeoTetris]')
    expect(opts.description).toContain('Claude refused the request')
    expect(opts.description).toContain('resets 3am (Europe/Madrid)')
    expect(opts.description).toContain('session limit')
    expect(opts.duration).toBe(60_000)
  })

  it('falls back to the no-reset copy and respects the completed-only filter', () => {
    renderHook(() => useOsNotifications(), { wrapper })
    send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-2', provider: 'gemini', kind: 'quota', message: 'RESOURCE_EXHAUSTED', resetsAt: null })
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: expect.stringContaining('after the limit resets') })
    vi.clearAllMocks()
    setOsNotificationPrefs({ enabled: true, filter: 'completed' })
    send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-3', provider: 'claude', kind: 'rate_limit', message: 'HTTP 429', resetsAt: null })
    expect(toastError).not.toHaveBeenCalled()
  })
})
