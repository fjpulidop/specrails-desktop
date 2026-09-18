import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
    connectionStatus: 'connected',
  }),
}))
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})
const ui = vi.hoisted(() => ({ uiMode: 'agent' as 'agent' | 'kanban' }))
vi.mock('../../context/UiModeContext', () => ({ useUiMode: () => ({ uiMode: ui.uiMode, setUiMode: vi.fn(), toggleUiMode: vi.fn() }) }))

import { useOsNotifications } from '../useOsNotifications'
import { MISSION_OPEN_RUN_EVENT } from '../../components/agent-chat/agent-run-failure'

class MockNotification {
  static permission: NotificationPermission = 'granted'
  static instances: MockNotification[] = []
  onclick: (() => void) | null = null
  close = vi.fn()
  constructor(public title: string, public options: NotificationOptions = {}) { MockNotification.instances.push(this) }
}

function wrapper({ children }: { children: React.ReactNode }) { return React.createElement(MemoryRouter, null, children) }

describe('useOsNotifications in Mission mode (mission-rail-cards)', () => {
  const setActiveProjectId = vi.fn()
  const opened = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks(); capturedHandler = null; MockNotification.instances = []
    Object.defineProperty(window, 'Notification', { value: MockNotification, writable: true, configurable: true })
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true })
    localStorage.clear()
    window.addEventListener(MISSION_OPEN_RUN_EVENT, opened)
    vi.useFakeTimers()
  })
  afterEach(() => { window.removeEventListener(MISSION_OPEN_RUN_EVENT, opened); vi.useRealTimers() })

  it('opens the run inside the mission instead of navigating to /jobs/:id', () => {
    ui.uiMode = 'agent'
    renderHook(() => useOsNotifications({ setActiveProjectId }), { wrapper })
    act(() => { capturedHandler?.({ type: 'queue', projectId: 'p1', jobs: [{ id: 'j1', status: 'running', command: 'x' }] }) })
    act(() => { capturedHandler?.({ type: 'queue', projectId: 'p1', jobs: [{ id: 'j1', status: 'failed', command: 'x' }] }) })
    expect(MockNotification.instances).toHaveLength(1)
    act(() => { MockNotification.instances[0].onclick?.(); vi.runAllTimers() })
    expect(setActiveProjectId).toHaveBeenCalledWith('p1')
    expect(mockNavigate).not.toHaveBeenCalled()
    expect((opened.mock.calls[0][0] as CustomEvent).detail).toEqual({ projectId: 'p1', jobId: 'j1' })
  })

  it('keeps the routed jobs page in Board mode', () => {
    ui.uiMode = 'kanban'
    renderHook(() => useOsNotifications({ setActiveProjectId }), { wrapper })
    act(() => { capturedHandler?.({ type: 'queue', projectId: 'p1', jobs: [{ id: 'j2', status: 'running' }] }) })
    act(() => { capturedHandler?.({ type: 'queue', projectId: 'p1', jobs: [{ id: 'j2', status: 'completed' }] }) })
    act(() => { MockNotification.instances[0].onclick?.(); vi.runAllTimers() })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/j2')
    expect(opened).not.toHaveBeenCalled()
  })
})
