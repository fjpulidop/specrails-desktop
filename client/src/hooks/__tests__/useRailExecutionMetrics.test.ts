import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
    connectionStatus: 'connected',
  }),
}))

import { useRailExecutionMetrics } from '../useRailExecutionMetrics'

const send = (msg: unknown) => act(() => { capturedHandler?.(msg) })

beforeEach(() => { capturedHandler = null })

describe('useRailExecutionMetrics', () => {
  it('tracks a run, counts steps (from loop_step index) and log lines, keyed per rail', () => {
    const { result } = renderHook(() => useRailExecutionMetrics('proj'))
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'r1', railIndex: 0 })
    send({ type: 'event', event_type: 'loop_step', jobId: 'r1', payload: JSON.stringify({ index: 1 }) })
    send({ type: 'log', processId: 'r1' })
    send({ type: 'log', processId: 'r1' })
    send({ type: 'event', event_type: 'loop_step', jobId: 'r1', payload: JSON.stringify({ index: 3 }) })

    expect(result.current[0]).toMatchObject({ steps: 3, lines: 2 })
    expect(typeof result.current[0].startedAt).toBe('number')
  })

  it('ignores runs from another project (run_started filtered)', () => {
    const { result } = renderHook(() => useRailExecutionMetrics('proj'))
    send({ type: 'loop.run_started', projectId: 'other', loopRunId: 'rX', railIndex: 0 })
    send({ type: 'log', processId: 'rX' })
    expect(result.current[0]).toBeUndefined()
  })

  it('clears the metric when the run completes (stop / cancel / success)', () => {
    const { result } = renderHook(() => useRailExecutionMetrics('proj'))
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'r1', railIndex: 1 })
    send({ type: 'log', processId: 'r1' })
    expect(result.current[1]).toMatchObject({ lines: 1 })
    send({ type: 'loop.run_completed', projectId: 'proj', loopRunId: 'r1', railIndex: 1 })
    expect(result.current[1]).toBeUndefined()
  })

  it('aggregates multiple runs of the same rail (sum steps/lines, earliest start)', () => {
    const { result } = renderHook(() => useRailExecutionMetrics('proj'))
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'a', railIndex: 2 })
    send({ type: 'loop.run_started', projectId: 'proj', loopRunId: 'b', railIndex: 2 })
    send({ type: 'event', event_type: 'loop_step', jobId: 'a', payload: JSON.stringify({ index: 2 }) })
    send({ type: 'event', event_type: 'loop_step', jobId: 'b', payload: JSON.stringify({ index: 5 }) })
    send({ type: 'log', processId: 'a' })
    expect(result.current[2]).toMatchObject({ steps: 7, lines: 1 })
  })
})
