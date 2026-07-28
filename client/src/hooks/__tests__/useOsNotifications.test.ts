import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

const mockRegisterHandler = vi.fn()
const mockUnregisterHandler = vi.fn()
let capturedHandler: ((data: unknown) => void) | null = null

vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (data: unknown) => void) => {
      capturedHandler = fn
      mockRegisterHandler(id, fn)
    },
    unregisterHandler: (id: string) => {
      capturedHandler = null
      mockUnregisterHandler(id)
    },
    connectionStatus: 'connected',
  }),
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return {
    ...(actual as object),
    useNavigate: () => mockNavigate,
  }
})

import { useOsNotifications, getOsNotificationPrefs, setOsNotificationPrefs } from '../useOsNotifications'

// ─── Notification API mock ────────────────────────────────────────────────────

class MockNotification {
  static permission: NotificationPermission = 'granted'
  static requestPermission = vi.fn().mockResolvedValue('granted')

  title: string
  options: NotificationOptions
  onclick: (() => void) | null = null

  constructor(title: string, options: NotificationOptions = {}) {
    this.title = title
    this.options = options
    MockNotification.instances.push(this)
  }

  close = vi.fn()

  static instances: MockNotification[] = []
  static clearInstances() {
    MockNotification.instances = []
  }
}

function setupNotificationMock(permission: NotificationPermission = 'granted') {
  MockNotification.permission = permission
  MockNotification.requestPermission = vi.fn().mockResolvedValue(permission)
  MockNotification.clearInstances()
  Object.defineProperty(window, 'Notification', {
    value: MockNotification,
    writable: true,
    configurable: true,
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}

function renderOsNotifications(opts: Parameters<typeof useOsNotifications>[0] = {}) {
  return renderHook(() => useOsNotifications(opts), { wrapper })
}

function sendQueueMessage(jobs: Array<{ id: string; status: string; command?: string }>, projectId?: string) {
  act(() => {
    capturedHandler?.({
      type: 'queue',
      projectId,
      jobs,
    })
  })
}

function triggerTransition(jobId: string, toStatus: 'completed' | 'failed', command?: string, projectId?: string) {
  sendQueueMessage([{ id: jobId, status: 'running', command }], projectId)
  sendQueueMessage([{ id: jobId, status: toStatus, command }], projectId)
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useOsNotifications', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    capturedHandler = null
    setupNotificationMock('granted')
    vi.useFakeTimers()
    localStorage.clear()
    // Tab hidden by default — notifications should fire
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('registers and unregisters a WS handler', () => {
    const { unmount } = renderOsNotifications()
    expect(mockRegisterHandler).toHaveBeenCalledWith('os-notifications', expect.any(Function))
    unmount()
    expect(mockUnregisterHandler).toHaveBeenCalledWith('os-notifications')
  })

  it('does not fire notification when no jobs transition', () => {
    renderOsNotifications()
    sendQueueMessage([{ id: 'job-1', status: 'queued' }])
    sendQueueMessage([{ id: 'job-1', status: 'running' }])
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('fires notification when job transitions running → completed', () => {
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job completed')
  })

  it('fires notification when job transitions running → failed', () => {
    renderOsNotifications()
    triggerTransition('job-1', 'failed', '/developer')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job failed')
  })

  it('does not fire notification for jobs already completed on first message', () => {
    renderOsNotifications()
    sendQueueMessage([{ id: 'job-1', status: 'completed', command: '/architect' }])
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('does not fire notification for canceled jobs', () => {
    renderOsNotifications()
    sendQueueMessage([{ id: 'job-1', status: 'running' }])
    sendQueueMessage([{ id: 'job-1', status: 'canceled' }])
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('includes command in notification body', () => {
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect --spec SPEA-100')
    expect(MockNotification.instances[0].options.body).toContain('/architect --spec SPEA-100')
  })

  it('includes project name in body when projectsById is provided', () => {
    const projectsById = new Map([['proj-1', 'my-project']])
    renderOsNotifications({ projectsById })
    triggerTransition('job-1', 'completed', '/architect', 'proj-1')
    expect(MockNotification.instances[0].options.body).toContain('[my-project]')
  })

  it('uses tag to deduplicate notifications', () => {
    renderOsNotifications()
    triggerTransition('job-1', 'completed')
    expect(MockNotification.instances[0].options.tag).toBe('specrails-job:job-1:completed')
  })

  it('does not fire when Notification permission is denied', () => {
    setupNotificationMock('denied')
    renderOsNotifications()
    triggerTransition('job-1', 'completed')
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('requests permission when permission is default', async () => {
    setupNotificationMock('default')
    renderOsNotifications()
    triggerTransition('job-1', 'completed')
    expect(MockNotification.requestPermission).toHaveBeenCalled()
  })

  it('navigates to job detail on notification click (same project)', () => {
    const setActiveProjectId = vi.fn()
    renderOsNotifications({ setActiveProjectId })
    triggerTransition('job-42', 'completed')
    expect(MockNotification.instances).toHaveLength(1)
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-42')
    expect(setActiveProjectId).not.toHaveBeenCalled()
  })

  it('switches project and navigates after delay on cross-project click', () => {
    const setActiveProjectId = vi.fn()
    renderOsNotifications({ setActiveProjectId })
    triggerTransition('job-99', 'completed', '/ship', 'proj-B')
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(setActiveProjectId).toHaveBeenCalledWith('proj-B')
    expect(mockNavigate).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-99')
  })

  it('ignores non-queue WS message types', () => {
    renderOsNotifications()
    act(() => {
      capturedHandler?.({ type: 'phase', phase: 'architect', state: 'running' })
      capturedHandler?.({ type: 'desktop.projects', projects: [] })
    })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('handles missing Notification API gracefully', () => {
    const original = (window as Record<string, unknown>)['Notification']
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (window as Record<string, unknown>)['Notification']
    expect(() => {
      renderOsNotifications()
      sendQueueMessage([{ id: 'job-1', status: 'running' }])
      sendQueueMessage([{ id: 'job-1', status: 'completed' }])
    }).not.toThrow()
    Object.defineProperty(window, 'Notification', { value: original, writable: true, configurable: true })
  })

  it('truncates long commands to 80 chars in body', () => {
    renderOsNotifications()
    const longCommand = '/architect ' + 'x'.repeat(100)
    triggerTransition('job-1', 'completed', longCommand)
    const body = MockNotification.instances[0].options.body as string
    expect(body.length).toBeLessThanOrEqual(80)
  })

  // ─── document.hidden tests ──────────────────────────────────────────────────

  it('does not fire notification when tab has focus (document.hidden = false)', () => {
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true })
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('fires notification when tab is hidden', () => {
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true })
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(1)
  })

  // ─── preferences tests ─────────────────────────────────────────────────────

  it('does not fire when notifications are disabled in preferences', () => {
    setOsNotificationPrefs({ enabled: false, filter: 'all' })
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('filters to completed-only when filter is "completed"', () => {
    setOsNotificationPrefs({ enabled: true, filter: 'completed' })
    renderOsNotifications()
    triggerTransition('job-1', 'failed', '/developer')
    expect(MockNotification.instances).toHaveLength(0)
    triggerTransition('job-2', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job completed')
  })

  it('filters to failed-only when filter is "failed"', () => {
    setOsNotificationPrefs({ enabled: true, filter: 'failed' })
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(0)
    triggerTransition('job-2', 'failed', '/developer')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job failed')
  })

  it('fires for both statuses when filter is "all"', () => {
    setOsNotificationPrefs({ enabled: true, filter: 'all' })
    renderOsNotifications()
    triggerTransition('job-1', 'completed', '/architect')
    triggerTransition('job-2', 'failed', '/developer')
    expect(MockNotification.instances).toHaveLength(2)
  })
})

// ─── Preferences helpers ──────────────────────────────────────────────────────

describe('getOsNotificationPrefs / setOsNotificationPrefs', () => {
  beforeEach(() => { localStorage.clear() })

  it('returns defaults when nothing stored', () => {
    expect(getOsNotificationPrefs()).toEqual({ enabled: true, filter: 'all' })
  })

  it('round-trips stored preferences', () => {
    setOsNotificationPrefs({ enabled: false, filter: 'failed' })
    expect(getOsNotificationPrefs()).toEqual({ enabled: false, filter: 'failed' })
  })

  it('handles corrupted localStorage gracefully', () => {
    localStorage.setItem('specrails-os-notifications', 'not-json')
    expect(getOsNotificationPrefs()).toEqual({ enabled: true, filter: 'all' })
  })

  it('handles partial stored data', () => {
    localStorage.setItem('specrails-os-notifications', JSON.stringify({ enabled: false }))
    expect(getOsNotificationPrefs()).toEqual({ enabled: false, filter: 'all' })
  })

})

describe('useOsNotifications — job.stuck (stalled run alert)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    capturedHandler = null
    setupNotificationMock('granted')
    vi.useFakeTimers()
    localStorage.clear()
    Object.defineProperty(document, 'hidden', { value: true, writable: true, configurable: true })
  })

  afterEach(() => { vi.useRealTimers() })

  function sendStuck(jobId: string, projectId?: string, staleMs = 11 * 60_000) {
    act(() => {
      capturedHandler?.({ type: 'job.stuck', projectId, jobId, stepKey: 'step-1', staleMs })
    })
  }

  it('fires a plain-language notification naming the stall duration', () => {
    renderOsNotifications()
    sendStuck('job-9', undefined, 12 * 60_000)
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Run seems stuck')
    expect(MockNotification.instances[0].options.body).toContain('12 minutes')
    expect(MockNotification.instances[0].options.tag).toBe('specrails-job-stuck:job-9')
  })

  it('uses the singular form for a one-minute stall and never shows 0', () => {
    renderOsNotifications()
    sendStuck('job-9', undefined, 30_000)
    expect(MockNotification.instances[0].options.body).toContain('1 minute')
  })

  it('prefixes the project name when known', () => {
    renderOsNotifications({ projectsById: new Map([['p1', 'Acme']]) })
    sendStuck('job-9', 'p1')
    expect(MockNotification.instances[0].options.body).toContain('[Acme]')
  })

  it('fires even while the tab is focused (a watched wedge is invisible otherwise)', () => {
    Object.defineProperty(document, 'hidden', { value: false, writable: true, configurable: true })
    renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.instances).toHaveLength(1)
  })

  it('respects the disabled preference', () => {
    setOsNotificationPrefs({ enabled: false, filter: 'all' })
    renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('is suppressed by the completed-only filter but kept by failed-only', () => {
    setOsNotificationPrefs({ enabled: true, filter: 'completed' })
    const first = renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.instances).toHaveLength(0)
    first.unmount()

    setOsNotificationPrefs({ enabled: true, filter: 'failed' })
    renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.instances).toHaveLength(1)
  })

  it('navigates to the job on click, switching project first when needed', () => {
    const setActiveProjectId = vi.fn()
    renderOsNotifications({ setActiveProjectId })
    sendStuck('job-9', 'p1')
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(setActiveProjectId).toHaveBeenCalledWith('p1')
    act(() => { vi.advanceTimersByTime(200) })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-9')
  })

  it('navigates directly when the message carries no project', () => {
    renderOsNotifications()
    sendStuck('job-9')
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-9')
  })

  it('ignores a malformed stuck message', () => {
    renderOsNotifications()
    act(() => { capturedHandler?.({ type: 'job.stuck' }) })
    act(() => { capturedHandler?.(null) })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('requests permission when it has not been decided yet', () => {
    setupNotificationMock('default')
    renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.requestPermission).toHaveBeenCalled()
  })

  it('shows nothing when permission is denied', () => {
    setupNotificationMock('denied')
    renderOsNotifications()
    sendStuck('job-9')
    expect(MockNotification.instances).toHaveLength(0)
  })
})
