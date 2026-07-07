import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act, waitFor } from '@testing-library/react'
import type { RailPrDecision, RailPrDecisionAction, RailPrStateSnapshot } from '../../types'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
    connectionStatus: 'connected',
  }),
}))

const { mockToast } = vi.hoisted(() => ({
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: mockToast }))

import { RailPrDecisionProvider, useRailPrDecisions, type RailPrActResult } from '../RailPrDecisionContext'

let latest: { decisions: Map<number, RailPrStateSnapshot>; hydrated: boolean; act: (railIndex: number, action: RailPrDecisionAction, expected: RailPrDecision) => Promise<RailPrActResult> } | null = null
function Probe() { latest = useRailPrDecisions(); return null }
function renderProvider(projectId: string | null = 'proj') {
  return render(<RailPrDecisionProvider activeProjectId={projectId}><Probe /></RailPrDecisionProvider>)
}
const send = (msg: unknown) => act(() => { capturedHandler?.(msg) })

function wsState(overrides: Partial<RailPrStateSnapshot & { projectId: string }> = {}) {
  return {
    type: 'rail.pr_state',
    projectId: 'proj',
    railIndex: 0,
    prDeliveryId: 'del-1',
    railKey: '0-impl',
    ticketIds: [1, 2],
    baseBranch: 'main',
    branch: null,
    prUrl: null,
    prNumber: null,
    prState: 'none',
    decision: 'on_review',
    originConversationId: null,
    ...overrides,
  }
}

beforeEach(() => {
  capturedHandler = null
  latest = null
  mockToast.success.mockReset()
  mockToast.error.mockReset()
  mockToast.info.mockReset()
  // Default: no active deliveries to seed.
  global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prDeliveries: {} }) }) as unknown as typeof fetch
})

describe('RailPrDecisionProvider', () => {
  it('upserts a non-terminal rail.pr_state snapshot keyed by railIndex', () => {
    renderProvider()
    send(wsState())
    expect(latest!.decisions.get(0)).toMatchObject({
      prDeliveryId: 'del-1', decision: 'on_review', baseBranch: 'main', ticketIds: [1, 2],
    })
    // Later broadcast for the same rail replaces the snapshot in place.
    send(wsState({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, prState: 'pr-created' }))
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prNumber: 7 })
    expect(latest!.decisions.size).toBe(1)
  })

  it('ignores broadcasts from another project', () => {
    renderProvider('proj')
    send(wsState({ projectId: 'other' }))
    expect(latest!.decisions.size).toBe(0)
  })

  it('REMOVES the entry on merged and surfaces a success toast once', () => {
    renderProvider()
    send(wsState({ decision: 'pr_ready', prUrl: 'https://github.com/o/r/pull/7' }))
    expect(latest!.decisions.size).toBe(1)
    send(wsState({ decision: 'merged', prUrl: 'https://github.com/o/r/pull/7' }))
    expect(latest!.decisions.size).toBe(0)
    expect(mockToast.success).toHaveBeenCalledTimes(1)
    // A replayed terminal broadcast (no local entry) surfaces nothing.
    send(wsState({ decision: 'merged' }))
    expect(mockToast.success).toHaveBeenCalledTimes(1)
  })

  it('REMOVES the entry on discarded with a neutral toast, silent when unknown locally', () => {
    renderProvider()
    // Unknown locally → no toast, no entry.
    send(wsState({ decision: 'discarded' }))
    expect(mockToast.info).not.toHaveBeenCalled()
    send(wsState())
    send(wsState({ decision: 'discarded' }))
    expect(latest!.decisions.size).toBe(0)
    expect(mockToast.info).toHaveBeenCalledTimes(1)
  })

  it('HYDRATES from GET /rails prDeliveries (server snapshot: id → prDeliveryId), skipping terminal rows', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        prDeliveries: {
          '1': { id: 'del-9', railIndex: 1, railKey: '1-impl', ticketIds: [4], baseBranch: 'develop', branch: null, prUrl: null, prNumber: null, prState: 'none', decision: 'on_review', originConversationId: null },
          '2': { id: 'del-t', railIndex: 2, decision: 'discarded' },
        },
      }),
    }) as unknown as typeof fetch
    renderProvider()
    await waitFor(() => expect(latest!.decisions.get(1)).toMatchObject({ prDeliveryId: 'del-9', decision: 'on_review', baseBranch: 'develop' }))
    expect(global.fetch).toHaveBeenCalledWith('/api/projects/proj/rails')
    expect(latest!.decisions.has(2)).toBe(false)
  })

  it('never lets the seed clobber a snapshot a live broadcast already updated', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    global.fetch = vi.fn().mockReturnValue(new Promise((r) => { resolveFetch = r })) as unknown as typeof fetch
    renderProvider()
    // Live WS update arrives while the seed fetch is still in flight.
    send(wsState({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/3', prNumber: 3, prState: 'pr-created' }))
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ prDeliveries: { '0': { id: 'del-1', railIndex: 0, decision: 'on_review' } } }),
      })
    })
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', prNumber: 3 })
  })

  it('act() POSTs the project-scoped pr-decision endpoint and does NOT mutate local state', async () => {
    renderProvider()
    send(wsState())
    const postFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true, decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/9' }),
    })
    global.fetch = postFetch as unknown as typeof fetch
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(0, 'create-pr', 'on_review') })
    expect(postFetch).toHaveBeenCalledWith('/api/projects/proj/rails/pr-decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prDeliveryId: 'del-1', action: 'create-pr', expectedDecision: 'on_review' }),
    }))
    expect(result).toMatchObject({ ok: true, status: 200, decision: 'pr_draft' })
    // No optimistic write — the map still holds the pre-mutation snapshot until
    // the rail.pr_state broadcast reconciles it.
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'on_review' })
  })

  it('act() surfaces a 409 stale_decision result verbatim', async () => {
    renderProvider()
    send(wsState())
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'stale_decision', current: 'pr_draft' }),
    }) as unknown as typeof fetch
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(0, 'create-pr', 'on_review') })
    expect(result).toMatchObject({ ok: false, status: 409, error: 'stale_decision', current: 'pr_draft' })
  })

  it('act() without a local delivery (or a network failure) never throws', async () => {
    renderProvider()
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(5, 'discard', 'on_review') })
    expect(result).toMatchObject({ ok: false, status: 0, error: 'no_delivery' })

    send(wsState())
    global.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch
    await act(async () => { result = await latest!.act(0, 'discard', 'on_review') })
    expect(result).toMatchObject({ ok: false, status: 0, error: 'network' })
  })

  it('resets state on project switch', async () => {
    const view = renderProvider('proj')
    send(wsState())
    expect(latest!.decisions.size).toBe(1)
    view.rerender(<RailPrDecisionProvider activeProjectId="proj2"><Probe /></RailPrDecisionProvider>)
    await waitFor(() => expect(latest!.decisions.size).toBe(0))
  })
})
