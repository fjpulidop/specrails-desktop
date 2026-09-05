import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

// loop-step-idle: the `job.stuck` message advertises `actions: ['stop']` and
// the hook must surface an in-app toast whose action calls the EXISTING cancel
// route — independent of OS notification permission.

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
const toastWarning = vi.fn()
const toastSuccess = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    warning: (...a: unknown[]) => toastWarning(...a),
    success: (...a: unknown[]) => toastSuccess(...a),
    error: (...a: unknown[]) => toastError(...a),
  },
}))

import { useOsNotifications, setOsNotificationPrefs } from '../useOsNotifications'

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}

function send(msg: Record<string, unknown>) {
  act(() => { capturedHandler?.(msg) })
}

describe('useOsNotifications — job.stuck "Stop run" action', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    localStorage.clear()
    // No OS Notification API at all: the in-app toast must still fire.
    Object.defineProperty(window, 'Notification', { value: undefined, writable: true, configurable: true })
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows a warning toast with a Stop run action when the server advertises `stop`', () => {
    renderHook(() => useOsNotifications({ projectsById: new Map([['p1', 'Acme']]) }), { wrapper })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', stepKey: 's', staleMs: 12 * 60_000, actions: ['stop'] })
    expect(toastWarning).toHaveBeenCalledTimes(1)
    const [title, opts] = toastWarning.mock.calls[0] as [string, { id: string; description: string; action: { label: string; onClick: () => void } }]
    expect(title).toBe('Run seems stuck')
    expect(opts.id).toBe('job-stuck:run-1')
    expect(opts.description).toContain('[Acme]')
    expect(opts.description).toContain('12 minutes')
    expect(opts.action.label).toBe('Stop run')
  })

  it('the action POSTs the existing cancel route for that project/run and confirms', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    renderHook(() => useOsNotifications(), { wrapper })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', stepKey: 's', staleMs: 60_000, actions: ['stop'] })
    const opts = toastWarning.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => { opts.action.onClick() })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/jobs/run-1/cancel', { method: 'POST' })
    expect(toastSuccess).toHaveBeenCalledWith('Run stopped', expect.objectContaining({ id: 'job-stuck:run-1' }))
  })

  it('a failed cancel reports honestly', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 409 })
    renderHook(() => useOsNotifications(), { wrapper })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', stepKey: 's', staleMs: 60_000, actions: ['stop'] })
    const opts = toastWarning.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => { opts.action.onClick() })
    expect(toastError).toHaveBeenCalledWith('Could not stop the run', expect.anything())
  })

  it('no toast without a project id or without the `stop` action (legacy message shape)', () => {
    renderHook(() => useOsNotifications(), { wrapper })
    send({ type: 'job.stuck', jobId: 'run-1', stepKey: 's', staleMs: 60_000, actions: ['stop'] })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-2', stepKey: 's', staleMs: 60_000 })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-3', stepKey: 's', staleMs: 60_000, actions: 'stop' })
    expect(toastWarning).not.toHaveBeenCalled()
  })

  it('respects the notification preferences', () => {
    setOsNotificationPrefs({ enabled: false, filter: 'all' })
    renderHook(() => useOsNotifications(), { wrapper })
    send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', stepKey: 's', staleMs: 60_000, actions: ['stop'] })
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
