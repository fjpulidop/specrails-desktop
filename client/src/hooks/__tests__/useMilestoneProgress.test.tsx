import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../useSharedWebSocket', async () => {
  const React = await import('react')
  // The hook reads the context directly (null-safe); a default value stands in
  // for the provider.
  return {
    SharedWebSocketContext: React.createContext({
      registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
      unregisterHandler: () => { capturedHandler = null },
      connectionStatus: 'connected',
    }),
  }
})

import { useMilestoneProgress, useStackedHeadDeliveryIds } from '../useMilestoneProgress'
import { purgeProjectCache } from '../useProjectCache'

const blueprint = {
  blueprintVersion: 1, product: { name: 'Recipely', pitch: 'p', audience: 'a' }, coreFlow: 'f', platform: 'web',
  stack: { language: 'ts', framework: 'x', db: 'sqlite' }, assumptions: [], specsComplete: true, m1Specs: [],
  milestones: [{ id: 'm1', title: 'Skeleton', goal: 'g', status: 'committed', plannedSpecs: [] }],
}
const progress = (state: string, onReview = 0) => [{
  id: 'm1', n: 1, title: 'Skeleton', storedStatus: 'committed', state,
  counts: { total: 8, done: 0, onReview, inProgress: 8 - onReview, todo: 0, failed: 0 }, rails: [], chain: null,
}]

function mockFetch(handler: (url: string) => { status: number; body?: unknown }) {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const r = handler(String(input))
    return { ok: r.status < 300, status: r.status, json: async () => r.body } as Response
  })
}

describe('useMilestoneProgress', () => {
  beforeEach(() => { capturedHandler = null; purgeProjectCache('p1'); purgeProjectCache('p2') })

  it('fetches /blueprint with progress and reports hasBlueprint', async () => {
    mockFetch(() => ({ status: 200, body: { blueprint, progress: progress('running') } }))
    const { result } = renderHook(() => useMilestoneProgress('p1'))
    expect(result.current.hasBlueprint).toBeNull()
    await waitFor(() => expect(result.current.hasBlueprint).toBe(true))
    expect(result.current.blueprint?.product.name).toBe('Recipely')
    expect(result.current.progress[0]).toMatchObject({ id: 'm1', state: 'running' })
    expect(String((global.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0])).toBe('/api/projects/p1/blueprint')
  })

  it('a 404 means no blueprint (ordinary project) — not an error', async () => {
    mockFetch(() => ({ status: 404, body: { error: 'no blueprint' } }))
    const { result } = renderHook(() => useMilestoneProgress('p1'))
    await waitFor(() => expect(result.current.hasBlueprint).toBe(false))
    expect(result.current.progress).toEqual([])
  })

  it('applies the live broadcast for the SAME project only, and resets on project switch', async () => {
    mockFetch(() => ({ status: 200, body: { blueprint, progress: progress('running') } }))
    const { result, rerender } = renderHook(({ id }: { id: string }) => useMilestoneProgress(id), { initialProps: { id: 'p1' } })
    await waitFor(() => expect(result.current.hasBlueprint).toBe(true))
    act(() => { capturedHandler?.({ type: 'blueprint.milestone_progress', projectId: 'p2', progress: progress('done') }) })
    expect(result.current.progress[0].state).toBe('running')
    act(() => { capturedHandler?.({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: progress('delivered', 8) }) })
    expect(result.current.progress[0]).toMatchObject({ state: 'delivered', counts: { onReview: 8 } })
    act(() => { capturedHandler?.({ type: 'ticket_updated', projectId: 'p1' }) })
    expect(result.current.progress[0].state).toBe('delivered')
    rerender({ id: 'p2' })
    await waitFor(() => expect(result.current.hasBlueprint).toBe(true))
    expect(result.current.progress[0].state).toBe('running')
  })

  it('refresh drops the live overlay and refetches', async () => {
    let reads = 0
    mockFetch(() => { reads += 1; return { status: 200, body: { blueprint, progress: progress(reads === 1 ? 'running' : 'done') } } })
    const { result } = renderHook(() => useMilestoneProgress('p1'))
    await waitFor(() => expect(result.current.hasBlueprint).toBe(true))
    await act(async () => { await result.current.refresh() })
    await waitFor(() => expect(result.current.progress[0].state).toBe('done'))
  })

  it('null project id yields an empty, non-loading model', () => {
    const { result } = renderHook(() => useMilestoneProgress(null))
    expect(result.current.progress).toEqual([])
    expect(result.current.hasBlueprint).toBeNull()
  })
})

describe('useStackedHeadDeliveryIds', () => {
  beforeEach(() => { capturedHandler = null; purgeProjectCache('p1') })

  it('derives the stacked heads from the live chain', async () => {
    mockFetch(() => ({ status: 200, body: { blueprint, progress: [{
      ...progress('running')[0],
      chain: { id: 'c', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, nextChunk: 2, totalChunks: 3, currentRailIndex: 4, headBranch: 'b', updatedAt: '',
        launched: [{ chunk: 1, railIndex: 3, ticketIds: [1], runIds: [], deliveryId: 'd1' }, { chunk: 2, railIndex: 4, ticketIds: [4], runIds: [], deliveryId: 'd2' }] },
    }] } }))
    const { result } = renderHook(() => useStackedHeadDeliveryIds('p1'))
    await waitFor(() => expect(result.current.has('d1')).toBe(true))
    expect(result.current.has('d2')).toBe(false)
  })
})
