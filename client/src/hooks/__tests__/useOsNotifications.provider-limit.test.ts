import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

// loop.provider_limit: the provider answered a loop step with a usage/rate-
// limit notice and the run stopped at once. The user gets ONE honest alert
// with the provider's reset hint — when the paused run resumes on its own.

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

import { useOsNotifications } from '../useOsNotifications'
import { createAttentionCenter, type AttentionCenter } from '../../lib/attention/attention-center'
import { DEFAULT_ATTENTION_PREFS, type AttentionPrefs } from '../../lib/attention/attention-policy'
import { showNativeNotification } from '../../lib/attention/native-notify'
import type { WindowFocus } from '../../lib/attention/window-focus'
import { OPEN_INBOX_EVENT } from '../../lib/inbox-events'

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}
let prefs: AttentionPrefs
let focus: WindowFocus
let center: AttentionCenter
async function send(msg: Record<string, unknown>) {
  act(() => { capturedHandler?.(msg) })
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
}

describe('useOsNotifications — loop.provider_limit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    localStorage.clear()
    Object.defineProperty(window, 'Notification', { value: undefined, writable: true, configurable: true })
    prefs = structuredClone(DEFAULT_ATTENTION_PREFS)
    focus = { appFocused: false, label: null }
    center = createAttentionCenter({ prefs: async () => prefs, focus: async () => focus, notify: showNativeNotification, toast: vi.fn() })
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('toasts the provider, the reset hint and the provider\'s own sentence, keyed by run', async () => {
    renderHook(() => useOsNotifications({ center, projectsById: new Map([['p1', 'NeoTetris']]) }), { wrapper })
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-1', provider: 'claude', kind: 'session_limit', message: "You've hit your session limit · resets 3am (Europe/Madrid)", resetsAt: '3am (Europe/Madrid)' })
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

  it('clicking the OS notification opens the inbox', async () => {
    const onclick: { current: (() => void) | null } = { current: null }
    class FakeNotification {
      static permission = 'granted'
      close = vi.fn()
      set onclick(fn: () => void) { onclick.current = fn }
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, writable: true, configurable: true })
    const opened = vi.fn()
    window.addEventListener(OPEN_INBOX_EVENT, opened)
    renderHook(() => useOsNotifications({ center }), { wrapper })
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-2', provider: 'claude', message: 'limit', resetsAt: null })
    onclick.current?.()
    window.removeEventListener(OPEN_INBOX_EVENT, opened)
    expect(opened).toHaveBeenCalledOnce()
  })

  it('says the exact reset in the person\'s clock when the server knows it', async () => {
    renderHook(() => useOsNotifications({ center }), { wrapper })
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-3', provider: 'claude', kind: 'session_limit', message: 'limit', resetsAt: '3am (Europe/Madrid)', resumeAt: '2026-11-19T02:00:00.000Z' })
    const time = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date('2026-11-19T02:00:00.000Z'))
    const description = String((toastError.mock.calls[0][1] as { description?: string }).description)
    expect(description).toContain(time)
    expect(description).not.toContain('3am (Europe/Madrid)')
    expect(description).toContain('resumes on its own')
    vi.clearAllMocks()
  })

  it('falls back to the no-reset copy and respects the spending-limits category', async () => {
    renderHook(() => useOsNotifications({ center }), { wrapper })
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-2', provider: 'gemini', kind: 'quota', message: 'RESOURCE_EXHAUSTED', resetsAt: null })
    expect(toastError.mock.calls[0][1]).toMatchObject({ description: expect.stringContaining('once the limit resets') })
    vi.clearAllMocks()
    prefs.categories.budget = false
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-3', provider: 'claude', kind: 'rate_limit', message: 'HTTP 429', resetsAt: null })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('with the app focused it stays an in-app error, without an OS notification', async () => {
    const created = vi.fn()
    class FakeNotification { static permission = 'granted'; constructor() { created() } close = vi.fn() }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, writable: true, configurable: true })
    focus = { appFocused: true, label: 'main' }
    renderHook(() => useOsNotifications({ center }), { wrapper })
    await send({ type: 'loop.provider_limit', projectId: 'p1', runId: 'run-4', provider: 'claude', message: 'limit', resetsAt: null })
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(created).not.toHaveBeenCalled()
  })
})
