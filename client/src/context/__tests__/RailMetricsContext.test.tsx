import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
    connectionStatus: 'connected',
  }),
}))

import { RailMetricsProvider, useRailMetrics, type RailExecMetric } from '../RailMetricsContext'

let latest: Record<number, RailExecMetric> = {}
function Probe() { latest = useRailMetrics(); return null }
function renderProvider(projectId: string | null = 'proj') {
  return render(<RailMetricsProvider activeProjectId={projectId}><Probe /></RailMetricsProvider>)
}
const send = (msg: unknown) => act(() => { capturedHandler?.(msg) })

beforeEach(() => {
  capturedHandler = null
  latest = {}
  // Default: no active runs to seed (existing WS-driven tests are unaffected).
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ activeLoopRuns: {} }) }) as unknown as typeof fetch
})

describe('RailMetricsProvider', () => {
  it('tracks steps (from loop_step index) + log lines per rail', () => {
    renderProvider()
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'r1', railIndex: 0 })
    send({ type: 'event', event_type: 'loop_step', jobId: 'r1', payload: JSON.stringify({ index: 2 }) })
    send({ type: 'log', processId: 'r1' })
    send({ type: 'log', processId: 'r1' })
    expect(latest[0]).toMatchObject({ steps: 2, lines: 2 })
  })

  it('ignores runs from another project', () => {
    renderProvider('proj')
    send({ type: 'loop.run_started', projectId: 'other', loopRunId: 'rX', railIndex: 0 })
    send({ type: 'log', processId: 'rX' })
    expect(latest[0]).toBeUndefined()
  })

  it('clears the metric on run completion (stop / cancel / success)', () => {
    renderProvider()
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'r1', railIndex: 1 })
    send({ type: 'log', processId: 'r1' })
    expect(latest[1]).toMatchObject({ lines: 1 })
    send({ type: 'loop.run_completed', projectId: 'proj', loopRunId: 'r1', railIndex: 1 })
    expect(latest[1]).toBeUndefined()
  })

  it('SEEDS from the server on mount so metrics survive a page refresh', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ activeLoopRuns: { '2': { loopRunId: 'r9', startedAt: '2026-06-24T10:00:00.000Z', steps: 4, lines: 20 } } }),
    }) as unknown as typeof fetch
    renderProvider()
    await waitFor(() => expect(latest[2]).toMatchObject({ steps: 4, lines: 20 }))
    expect(latest[2].startedAt).toBe(new Date('2026-06-24T10:00:00.000Z').getTime())
  })

  it('aggregates multiple runs of the same rail', () => {
    renderProvider()
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'a', railIndex: 2 })
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'b', railIndex: 2 })
    send({ type: 'event', event_type: 'loop_step', jobId: 'a', payload: JSON.stringify({ index: 2 }) })
    send({ type: 'event', event_type: 'loop_step', jobId: 'b', payload: JSON.stringify({ index: 5 }) })
    send({ type: 'log', processId: 'a' })
    expect(latest[2]).toMatchObject({ steps: 7, lines: 1 })
  })
})
