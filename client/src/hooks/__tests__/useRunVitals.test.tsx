import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, act, waitFor } from '@testing-library/react'

// Shared-WS mock: keep a handler MAP (the hook registers one handler per
// mounted chip) and fan messages to all of them, like the real provider.
const wsHandlers = new Map<string, (msg: unknown) => void>()
const emitWs = (msg: unknown) => { for (const fn of [...wsHandlers.values()]) fn(msg) }
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (id: string, fn: (m: unknown) => void) => { wsHandlers.set(id, fn) },
    unregisterHandler: (id: string) => { wsHandlers.delete(id) },
    connectionStatus: 'connected',
  }),
}))

import { useRunVitals, formatRunElapsed } from '../useRunVitals'

const T0 = new Date('2026-07-04T10:00:00.000Z').getTime()

function jobRes(job: Record<string, unknown> | null, status = 200) {
  return {
    ok: status < 300 && job !== null,
    status: job === null ? 404 : status,
    json: async () => ({ job }),
  }
}

function Probe({ projectId = 'p1', runId = 'run-1', live = true }: { projectId?: string; runId?: string; live?: boolean }) {
  const v = useRunVitals(projectId, runId, { live })
  return (
    <div data-testid="vitals">
      {`${v.loaded ? 1 : 0}|${v.status ?? '-'}|${v.running ? 1 : 0}|${v.elapsedMs ?? '-'}|${v.costUsd ?? '-'}|${v.numTurns ?? '-'}`}
    </div>
  )
}

const read = () => screen.getByTestId('vitals').textContent!.split('|')

beforeEach(() => {
  wsHandlers.clear()
  vi.useFakeTimers()
  vi.setSystemTime(T0)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('formatRunElapsed', () => {
  it('formats compact elapsed strings', () => {
    expect(formatRunElapsed(0)).toBe('0s')
    expect(formatRunElapsed(38_000)).toBe('38s')
    expect(formatRunElapsed(252_000)).toBe('4m12s')
    expect(formatRunElapsed(61_000)).toBe('1m01s')
    expect(formatRunElapsed(3_840_000)).toBe('1h 4m')
  })
})

describe('useRunVitals', () => {
  it('initial GET populates status + elapsed + REAL totals from the jobs row', async () => {
    const fetchMock = vi.fn(async () => jobRes({
      id: 'run-1', status: 'running',
      started_at: new Date(T0 - 30_000).toISOString(), finished_at: null,
      total_cost_usd: 0.42, num_turns: 3,
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(fetchMock).toHaveBeenCalledWith('/api/projects/p1/jobs/run-1')
    expect(read()).toEqual(['1', 'running', '1', '30000', '0.42', '3'])
  })

  it('job.turn_done replaces the totals with the accumulated REAL sums (matching jobId only)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({
      status: 'running', started_at: new Date(T0).toISOString(), finished_at: null,
      total_cost_usd: null, num_turns: null,
    })))
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(read()[4]).toBe('-') // no cost yet — never estimated client-side

    // A foreign job's turn is ignored.
    act(() => emitWs({ type: 'job.turn_done', jobId: 'OTHER', totals: { total_cost_usd: 9, num_turns: 9 } }))
    expect(read()[4]).toBe('-')

    act(() => emitWs({ type: 'job.turn_done', jobId: 'run-1', totals: { total_cost_usd: 0.87, num_turns: 2 } }))
    expect(read()[4]).toBe('0.87')
    expect(read()[5]).toBe('2')

    // The next turn's message carries the new running SUM — adopted wholesale.
    act(() => emitWs({ type: 'job.turn_done', jobId: 'run-1', totals: { total_cost_usd: 1.31, num_turns: 3 } }))
    expect(read()[4]).toBe('1.31')
    expect(read()[5]).toBe('3')
  })

  it('ticks elapsed every second while running, and only while running', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({
      status: 'running', started_at: new Date(T0).toISOString(), finished_at: null,
    })))
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(read()[3]).toBe('0')
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(read()[3]).toBe('1000')
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(read()[3]).toBe('4000')
  })

  it('job.finalized freezes: terminal status + final totals + elapsed stops ticking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({
      status: 'running', started_at: new Date(T0).toISOString(), finished_at: null,
    })))
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    act(() => emitWs({
      type: 'job.finalized', jobId: 'run-1', status: 'completed',
      totals: { total_cost_usd: 2.5, num_turns: 7 },
      timestamp: new Date(T0 + 2000).toISOString(),
    }))
    expect(read()).toEqual(['1', 'completed', '0', '2000', '2.5', '7'])
    // Frozen: further ticks and turn totals no longer move the vitals.
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(read()[3]).toBe('2000')
  })

  it('a finished job renders frozen wall-clock elapsed from its own timestamps', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({
      status: 'completed',
      started_at: new Date(T0 - 252_000).toISOString(),
      finished_at: new Date(T0).toISOString(),
      total_cost_usd: 0.87, num_turns: 4,
    })))
    render(<Probe live={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(read()).toEqual(['1', 'completed', '0', '252000', '0.87', '4'])
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(read()[3]).toBe('252000') // frozen
  })

  it('live:false neither subscribes to the WS nor ticks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({
      status: 'running', started_at: new Date(T0).toISOString(), finished_at: null,
    })))
    render(<Probe live={false} />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(wsHandlers.size).toBe(0)
    const before = read()[3]
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(read()[3]).toBe(before)
  })

  it('a failed GET still settles loaded (chip renders without vitals, never crashes)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(read()).toEqual(['1', '-', '0', '-', '-', '-'])
  })

  it('unregisters its WS handler on unmount', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jobRes({ status: 'running', started_at: new Date(T0).toISOString() })))
    const { unmount } = render(<Probe />)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    expect(wsHandlers.size).toBe(1)
    unmount()
    expect(wsHandlers.size).toBe(0)
  })
})
