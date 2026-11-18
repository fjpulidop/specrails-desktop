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

const toastFn = vi.hoisted(() => Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastFn }))

// The stuck alert reads the prefs store directly (its in-app Stop action follows the prefs, not the focus).
const store = vi.hoisted(() => ({ prefs: null as unknown }))
vi.mock('../../lib/attention/attention-prefs-store', () => ({ attentionPrefsStore: { ready: async () => store.prefs } }))

import { useOsNotifications } from '../useOsNotifications'
import { createAttentionCenter, type AttentionCenter } from '../../lib/attention/attention-center'
import { DEFAULT_ATTENTION_PREFS, type AttentionPrefs } from '../../lib/attention/attention-policy'
import { showNativeNotification } from '../../lib/attention/native-notify'
import type { WindowFocus } from '../../lib/attention/window-focus'

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
}

function setupNotificationMock(permission: NotificationPermission = 'granted') {
  MockNotification.permission = permission
  MockNotification.requestPermission = vi.fn().mockResolvedValue(permission)
  MockNotification.instances = []
  Object.defineProperty(window, 'Notification', { value: MockNotification, writable: true, configurable: true })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let prefs: AttentionPrefs
let focus: WindowFocus
let center: AttentionCenter

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}

function renderOsNotifications(opts: Parameters<typeof useOsNotifications>[0] = {}) {
  return renderHook(() => useOsNotifications({ center, ...opts }), { wrapper })
}

/** Let the async pipeline (prefs, focus, permission) settle. */
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
}

async function send(msg: Record<string, unknown>): Promise<void> {
  act(() => { capturedHandler?.(msg) })
  await settle()
}

async function triggerTransition(jobId: string, toStatus: 'completed' | 'failed', command?: string, projectId?: string) {
  await send({ type: 'queue', projectId, jobs: [{ id: jobId, status: 'running', command }] })
  await send({ type: 'queue', projectId, jobs: [{ id: jobId, status: toStatus, command }] })
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useOsNotifications (attention pipeline)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockNavigate.mockReset()
    capturedHandler = null
    setupNotificationMock('granted')
    prefs = structuredClone(DEFAULT_ATTENTION_PREFS)
    store.prefs = prefs
    focus = { appFocused: false, label: null }
    center = createAttentionCenter({ prefs: async () => prefs, focus: async () => focus, notify: showNativeNotification, toast: (event) => toastFn(event.title, { description: event.body }) })
    window.history.replaceState(null, '', '/')
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

  it('does not fire notification when no jobs transition', async () => {
    renderOsNotifications()
    await send({ type: 'queue', jobs: [{ id: 'job-1', status: 'queued' }] })
    await send({ type: 'queue', jobs: [{ id: 'job-1', status: 'running' }] })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('fires notification when job transitions running → completed', async () => {
    renderOsNotifications()
    await triggerTransition('job-1', 'completed', '/architect')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job completed')
  })

  it('fires notification when job transitions running → failed', async () => {
    renderOsNotifications()
    await triggerTransition('job-2', 'failed', '/implement')
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Job failed')
  })

  it('does not fire for jobs already completed on first message, nor for canceled jobs', async () => {
    renderOsNotifications()
    await send({ type: 'queue', jobs: [{ id: 'job-1', status: 'completed' }] })
    await send({ type: 'queue', jobs: [{ id: 'job-2', status: 'running' }] })
    await send({ type: 'queue', jobs: [{ id: 'job-2', status: 'canceled' }] })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('names the project and the command, keyed by job and status', async () => {
    renderOsNotifications({ projectsById: new Map([['proj-1', 'My App']]) })
    await triggerTransition('job-1', 'completed', '/architect', 'proj-1')
    expect(MockNotification.instances[0].options.body).toBe('[My App] /architect')
    expect(MockNotification.instances[0].options.tag).toBe('job:job-1:completed')
    expect(MockNotification.instances[0].options.silent).toBe(true)
  })

  it('truncates long commands to 80 chars in body', async () => {
    renderOsNotifications()
    await triggerTransition('job-1', 'completed', 'x'.repeat(120))
    expect(MockNotification.instances[0].options.body).toBe('x'.repeat(80))
  })

  it('plays the sound when the prefs ask for it', async () => {
    prefs.sound = true
    renderOsNotifications()
    await triggerTransition('job-1', 'completed', '/a')
    expect(MockNotification.instances[0].options.silent).toBe(false)
  })

  it('does not fire when permission is denied, and asks when it is still default', async () => {
    setupNotificationMock('denied')
    renderOsNotifications()
    await triggerTransition('job-1', 'completed')
    expect(MockNotification.instances).toHaveLength(0)

    setupNotificationMock('default')
    await triggerTransition('job-2', 'completed')
    expect(MockNotification.requestPermission).toHaveBeenCalled()
  })

  it('navigates to job detail on notification click (same project)', async () => {
    renderOsNotifications()
    await triggerTransition('job-1', 'completed')
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-1')
    expect(MockNotification.instances[0].close).toHaveBeenCalled()
  })

  it('switches project and navigates after delay on cross-project click', async () => {
    const setActiveProjectId = vi.fn()
    renderOsNotifications({ setActiveProjectId })
    await triggerTransition('job-1', 'failed', undefined, 'proj-2')
    vi.useFakeTimers()
    act(() => { MockNotification.instances[0].onclick?.() })
    expect(setActiveProjectId).toHaveBeenCalledWith('proj-2')
    expect(mockNavigate).not.toHaveBeenCalled()
    act(() => { vi.advanceTimersByTime(100) })
    expect(mockNavigate).toHaveBeenCalledWith('/jobs/job-1')
  })

  it('ignores non-queue WS message types and a missing Notification API', async () => {
    renderOsNotifications()
    await send({ type: 'log', jobId: 'job-1' })
    Object.defineProperty(window, 'Notification', { value: undefined, writable: true, configurable: true })
    await triggerTransition('job-1', 'completed')
    expect(MockNotification.instances).toHaveLength(0)
  })

  describe('prefs and focus (one policy)', () => {
    it('nothing when attention is off', async () => {
      prefs.enabled = false
      renderOsNotifications()
      await triggerTransition('job-1', 'completed')
      await triggerTransition('job-2', 'failed')
      expect(MockNotification.instances).toHaveLength(0)
    })

    it('"Finished jobs" off silences completions only', async () => {
      prefs.categories.done = false
      renderOsNotifications()
      await triggerTransition('job-1', 'completed')
      await triggerTransition('job-2', 'failed')
      expect(MockNotification.instances.map((n) => n.title)).toEqual(['Job failed'])
    })

    it('a muted project stays quiet', async () => {
      prefs.mutedProjects = ['proj-1']
      renderOsNotifications()
      await triggerTransition('job-1', 'failed', undefined, 'proj-1')
      await triggerTransition('job-2', 'failed', undefined, 'proj-2')
      expect(MockNotification.instances).toHaveLength(1)
    })

    it('focused elsewhere in the app → a failure is an in-app toast, a completion stays quiet', async () => {
      focus = { appFocused: true, label: 'main' }
      renderOsNotifications()
      await triggerTransition('job-1', 'completed', '/a')
      expect(MockNotification.instances).toHaveLength(0)
      expect(toastFn).not.toHaveBeenCalled()
      await triggerTransition('job-2', 'failed', '/b')
      expect(MockNotification.instances).toHaveLength(0)
      expect(toastFn).toHaveBeenCalledWith('Job failed', expect.objectContaining({ description: '/b' }))
    })

    it('focused on the job itself → nothing at all', async () => {
      focus = { appFocused: true, label: 'main' }
      window.history.replaceState(null, '', '/jobs/job-1')
      renderOsNotifications()
      await triggerTransition('job-1', 'completed')
      expect(MockNotification.instances).toHaveLength(0)
      expect(toastFn).not.toHaveBeenCalled()
    })
  })
})

describe('useOsNotifications — job.stuck (stalled run alert)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    setupNotificationMock('granted')
    prefs = structuredClone(DEFAULT_ATTENTION_PREFS)
    store.prefs = prefs
    // The person is looking at the app: a stuck run interrupts anyway.
    focus = { appFocused: true, label: 'main' }
    center = createAttentionCenter({ prefs: async () => prefs, focus: async () => focus, notify: showNativeNotification, toast: vi.fn() })
  })

  it('fires a plain-language notification naming the stall duration, even with the window focused', async () => {
    renderOsNotifications({ projectsById: new Map([['p1', 'Acme']]) })
    await send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', staleMs: 12 * 60_000 })
    expect(MockNotification.instances).toHaveLength(1)
    expect(MockNotification.instances[0].title).toBe('Run seems stuck')
    expect(MockNotification.instances[0].options.body).toContain('[Acme]')
    expect(MockNotification.instances[0].options.body).toContain('12 minutes')
  })

  it('uses the singular form for a one-minute stall and never shows 0', async () => {
    renderOsNotifications()
    await send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', staleMs: 10_000 })
    expect(MockNotification.instances[0].options.body).toContain('1 minute')
    expect(MockNotification.instances[0].options.body).not.toContain('0 minutes')
  })

  it('follows the failures category', async () => {
    prefs.categories.failed = false
    renderOsNotifications()
    await send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', staleMs: 60_000 })
    expect(MockNotification.instances).toHaveLength(0)
  })

  it('one subject is announced once: the stall, then its failure, within the window', async () => {
    focus = { appFocused: false, label: null }
    renderOsNotifications()
    await send({ type: 'job.stuck', projectId: 'p1', jobId: 'run-1', staleMs: 60_000 })
    await triggerTransition('run-1', 'failed', undefined, 'p1')
    expect(MockNotification.instances.map((n) => n.title)).toEqual(['Run seems stuck'])
  })
})
