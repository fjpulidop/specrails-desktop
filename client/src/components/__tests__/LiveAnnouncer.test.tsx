import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act } from '../../test-utils'
import { setLanguage } from '../../lib/i18n'
import { SharedWebSocketContext } from '../../hooks/useSharedWebSocket'
import { announce, announcer, THROTTLE_MS } from '../../lib/announce'

const h = vi.hoisted(() => ({ activeId: 'p1' as string | null }))
vi.mock('../../hooks/useDesktop', () => ({ useDesktop: () => ({ activeProjectId: h.activeId }) }))

import { LiveAnnouncer } from '../LiveAnnouncer'

type Handler = (msg: unknown) => void
function mount() {
  const handlers = new Map<string, Handler>()
  const ctx = {
    registerHandler: (id: string, fn: Handler) => { handlers.set(id, fn) },
    unregisterHandler: (id: string) => { handlers.delete(id) },
    connectionStatus: 'connected' as const,
  }
  const view = render(<SharedWebSocketContext.Provider value={ctx}><LiveAnnouncer /></SharedWebSocketContext.Provider>)
  const send = (msg: unknown) => act(() => { handlers.get('live-announcer')?.(msg) })
  return { ...view, send }
}
const region = () => screen.getByTestId('live-announcer')

describe('LiveAnnouncer', () => {
  beforeEach(() => { vi.useFakeTimers(); h.activeId = 'p1'; announcer.reset() })
  afterEach(() => { vi.useRealTimers(); void setLanguage('en') })

  it('is one visually hidden polite status region', () => {
    mount()
    expect(region()).toHaveAttribute('role', 'status')
    expect(region()).toHaveAttribute('aria-live', 'polite')
    expect(region()).toHaveClass('sr-only')
  })

  it('announces run state changes of the active project, localized', async () => {
    const { send } = mount()
    send({ type: 'rail.job_started', projectId: 'p1', railIndex: 1, jobId: 'j1' })
    expect(region().textContent).toContain('Rail 2: run started')
    await act(async () => { vi.advanceTimersByTime(THROTTLE_MS + 1); await setLanguage('es') })
    send({ type: 'rail.job_completed', projectId: 'p1', railIndex: 1, jobId: 'j1', status: 'completed' })
    expect(region().textContent).toContain('Rail 2: ejecución terminada')
  })

  it('names the spec when the message carries exactly one, and keeps the rail for cap pauses', async () => {
    const { send } = mount()
    send({ type: 'rail.job_completed', projectId: 'p1', railIndex: 0, jobId: 'j1', status: 'completed', ticketIds: [14] })
    expect(region().textContent).toContain('Rail 1: #14 finished')
    act(() => { vi.advanceTimersByTime(THROTTLE_MS + 1) })
    // Several specs: no single reference to give, so the rail sentence is used.
    send({ type: 'rail.job_completed', projectId: 'p1', railIndex: 0, jobId: 'j2', status: 'failed', ticketIds: [1, 2] })
    expect(region().textContent).toContain('Rail 1: run failed')
    act(() => { vi.advanceTimersByTime(THROTTLE_MS + 1) })
    send({ type: 'loop.run_paused', projectId: 'p1', railIndex: 2, loopRunId: 'r1', pauseKind: 'budget_paused', ticketIds: [7] })
    expect(region().textContent).toContain('Rail 3: run paused, a budget cap was reached')
    await act(async () => { vi.advanceTimersByTime(THROTTLE_MS + 1); await setLanguage('es') })
    send({ type: 'rail.job_started', projectId: 'p1', railIndex: 0, jobId: 'j3', ticketIds: [9] })
    expect(region().textContent).toContain('Rail 1: #9 iniciada')
    expect(region().textContent).not.toMatch(/\brun\b/i)
  })

  it('ignores other projects and dedupes the same state', () => {
    const { send } = mount()
    send({ type: 'rail.job_started', projectId: 'p2', railIndex: 0, jobId: 'j1' })
    expect(region().textContent).toBe('')
    send({ type: 'rail.pr_state', projectId: 'p1', prDeliveryId: 'd1', railIndex: 0, decision: 'on_review' })
    const first = region().textContent
    expect(first).toContain('review ready')
    act(() => { vi.advanceTimersByTime(THROTTLE_MS + 1) })
    send({ type: 'rail.pr_state', projectId: 'p1', prDeliveryId: 'd1', railIndex: 0, decision: 'on_review' })
    act(() => { vi.advanceTimersByTime(THROTTLE_MS + 1) })
    expect(region().textContent).toBe(first)
  })

  it('speaks anything sent through announce()', () => {
    mount()
    act(() => { announce('Saved') })
    expect(region().textContent).toContain('Saved')
  })
})
