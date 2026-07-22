import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  MilestoneSequencerProvider,
  useMilestoneSequencer,
  readMilestoneLaunchMode,
  saveMilestoneLaunchMode,
} from '../MilestoneSequencerContext'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

// 7 tickets → chunks [3,3,1]; rails allocate 0,1,2.
const TICKETS = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, status: 'todo', labels: ['M1'] }))

/** URL-routed fetch mock: tickets, rail create/assign/launch, rails busy-state. */
function installFetch(state: { busy: Set<number>; nextRail: number; launches: number[][] }) {
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const ok = (body: unknown) => ({ ok: true, json: async () => body }) as Response
    if (/\/rails\/\d+\/tickets$/.test(url)) {
      const body = JSON.parse(init?.body as string) as { ticketIds: number[] }
      state.launches.push(body.ticketIds)
      return ok({})
    }
    if (url.endsWith('/tickets')) return ok({ tickets: TICKETS })
    if (url.endsWith('/rails') && method === 'POST') {
      const railIndex = state.nextRail++
      return ok({ rail: { railIndex } })
    }
    if (/\/rails\/\d+\/launch$/.test(url)) {
      const railIndex = Number(url.match(/\/rails\/(\d+)\/launch$/)![1])
      state.busy.add(railIndex) // launch makes the rail busy
      return ok({})
    }
    if (url.endsWith('/rails') && method === 'GET') {
      const activeJobs: Record<number, unknown> = {}
      for (const i of state.busy) activeJobs[i] = { jobId: `j${i}` }
      return ok({ rails: [], activeJobs, activeLoopRuns: {} })
    }
    throw new Error(`unmocked fetch: ${method} ${url}`)
  })
  return spy
}

function Harness() {
  const { startSequential, planFor } = useMilestoneSequencer()
  return (
    <div>
      <button data-testid="start" onClick={() => { void startSequential('proj-1', 1) }}>start</button>
      <span data-testid="plan">{planFor('proj-1') ? 'active' : 'none'}</span>
    </div>
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('milestone launch mode preference', () => {
  it('defaults to sequential and persists the last choice', () => {
    expect(readMilestoneLaunchMode()).toBe('sequential')
    saveMilestoneLaunchMode('parallel')
    expect(readMilestoneLaunchMode()).toBe('parallel')
    saveMilestoneLaunchMode('sequential')
    expect(readMilestoneLaunchMode()).toBe('sequential')
  })
})

describe('MilestoneSequencerProvider', () => {
  it('launches chunk 1 immediately and chains the rest as each rail settles', async () => {
    const state = { busy: new Set<number>(), nextRail: 0, launches: [] as number[][] }
    installFetch(state)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MilestoneSequencerProvider><Harness /></MilestoneSequencerProvider>)

    await user.click(screen.getByTestId('start'))
    await waitFor(() => expect(state.launches).toHaveLength(1))
    expect(state.launches[0]).toEqual([1, 2, 3])

    // Poll observes rail 0 busy; nothing new launches while it runs.
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    expect(state.launches).toHaveLength(1)

    // Rail 0 settles → next tick launches chunk 2.
    state.busy.delete(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    await waitFor(() => expect(state.launches).toHaveLength(2))
    expect(state.launches[1]).toEqual([4, 5, 6])

    // Rail 1 settles → chunk 3 (needs one observed-busy tick first).
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    state.busy.delete(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) })
    await waitFor(() => expect(state.launches).toHaveLength(3))
    expect(state.launches[2]).toEqual([7])
  })

  it('a chunk-launch failure stops the chain (never skips ahead)', async () => {
    const state = { busy: new Set<number>(), nextRail: 0, launches: [] as number[][] }
    const spy = installFetch(state)
    // Second rail creation fails (e.g. rail_limit_reached).
    let railCalls = 0
    const original = spy.getMockImplementation()!
    spy.mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.endsWith('/rails') && init?.method === 'POST' && ++railCalls === 2) {
        return { ok: false, json: async () => ({ error: 'rail_limit_reached' }) } as Response
      }
      return original(input, init)
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    render(<MilestoneSequencerProvider><Harness /></MilestoneSequencerProvider>)

    await user.click(screen.getByTestId('start'))
    await waitFor(() => expect(state.launches).toHaveLength(1))

    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) }) // observe busy
    state.busy.delete(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) }) // settle → chunk 2 fails
    // Chain stopped: no further launches ever happen.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    expect(state.launches).toHaveLength(1)
    expect(screen.getByTestId('plan').textContent).toBe('none')
  })

  it('persists the plan so a remount resumes the chain', async () => {
    const state = { busy: new Set<number>(), nextRail: 0, launches: [] as number[][] }
    installFetch(state)
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    const { unmount } = render(<MilestoneSequencerProvider><Harness /></MilestoneSequencerProvider>)
    await user.click(screen.getByTestId('start'))
    await waitFor(() => expect(state.launches).toHaveLength(1))
    await act(async () => { await vi.advanceTimersByTimeAsync(11_000) }) // observe busy
    unmount()

    // Refresh: a fresh provider loads the persisted plan and keeps chaining.
    render(<MilestoneSequencerProvider><Harness /></MilestoneSequencerProvider>)
    state.busy.delete(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(22_000) })
    await waitFor(() => expect(state.launches).toHaveLength(2))
    expect(state.launches[1]).toEqual([4, 5, 6])
  })
})
