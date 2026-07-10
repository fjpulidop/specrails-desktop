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
  mockToast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: mockToast }))

import {
  RailPrDecisionProvider,
  useRailPrDecisions,
  type RailPrActResult,
  type RailPrCheckoutResult,
} from '../RailPrDecisionContext'

let latest: {
  decisions: Map<number, RailPrStateSnapshot>
  hydrated: boolean
  act: (
    railIndex: number,
    action: RailPrDecisionAction,
    expected: RailPrDecision,
    expectedPrDeliveryId: string,
  ) => Promise<RailPrActResult>
  checkout: (railIndex: number, expectedPrDeliveryId: string) => Promise<RailPrCheckoutResult>
} | null = null
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
  mockToast.warning.mockReset()
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

  it('orders same-delivery snapshots by updatedAt and keeps a conflicting tie fail-safe', () => {
    renderProvider()
    send(wsState({
      decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/7', prState: 'pr-created',
      updatedAt: '2026-07-10 12:00:02',
    }))

    send(wsState({ decision: 'on_review', updatedAt: '2026-07-10 12:00:01' }))
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', updatedAt: '2026-07-10 12:00:02' })

    // SQLite timestamps have one-second precision: a different payload at the
    // same timestamp is ambiguous and cannot regress the accepted snapshot.
    send(wsState({ decision: 'pr_failed', updatedAt: '2026-07-10 12:00:02' }))
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', updatedAt: '2026-07-10 12:00:02' })

    // Even a terminal-looking payload needs strictly newer durable evidence.
    send(wsState({ decision: 'merged', updatedAt: '2026-07-10 12:00:02' }))
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft' })

    send(wsState({ decision: 'merged', updatedAt: '2026-07-10 12:00:03' }))
    expect(latest!.decisions.has(0)).toBe(false)
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
    send(wsState({ prDeliveryId: 'already-terminal', decision: 'discarded' }))
    expect(mockToast.info).not.toHaveBeenCalled()
    send(wsState())
    send(wsState({ decision: 'discarded' }))
    expect(latest!.decisions.size).toBe(0)
    expect(mockToast.info).toHaveBeenCalledTimes(1)
  })

  it('announces retained recovery work when Dismiss terminalizes with cleanup warnings', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    renderProvider()
    send(wsState({ decision: 'pr_failed', isContinuation: true }))
    const cleanupWarning = 'worktree /wt/recoverable-follow-up: preserved for inspection because it already requires review'
    send(wsState({
      decision: 'discarded', isContinuation: true,
      cleanupWarnings: [cleanupWarning],
    }))

    expect(latest!.decisions.has(0)).toBe(false)
    expect(mockToast.warning).toHaveBeenCalledWith('Cleanup is incomplete (1 warning)', expect.objectContaining({
      description: expect.stringContaining('/wt/recoverable-follow-up'),
      duration: Infinity,
      action: expect.objectContaining({ label: 'Copy recovery details' }),
    }))
    const options = mockToast.warning.mock.calls[0]?.[1] as { action?: { onClick?: () => void } }
    options.action?.onClick?.()
    expect(writeText).toHaveBeenCalledWith(cleanupWarning)
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('REMOVES completed no-change cards with a truthful Done toast', () => {
    renderProvider()
    send(wsState({ decision: 'no_changes', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes' }))
    send(wsState({ decision: 'completed', implementationOutcome: 'succeeded', deliveryOutcome: 'no_changes' }))
    expect(latest!.decisions.size).toBe(0)
    expect(mockToast.success).toHaveBeenCalledWith('Confirmed — specs moved to Done')
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('keeps terminal safety archives visible in a persistent dashboard toast', () => {
    renderProvider()
    send(wsState({ decision: 'pr_ready' }))
    send(wsState({
      decision: 'merged',
      safetyArchives: [
        '/repo/worktrees/ticket-1.specrails-overlay-quarantine-a/.mcp.json',
        '/repo/worktrees/ticket-1.specrails-overlay-quarantine-a/.claude/settings.json',
      ],
    }))

    expect(latest!.decisions.has(0)).toBe(false)
    expect(mockToast.warning).toHaveBeenCalledWith('Safety archive (2)', expect.objectContaining({
      description: expect.stringContaining('.mcp.json'),
      duration: Infinity,
      action: expect.objectContaining({ label: 'Copy paths' }),
    }))
  })

  it('ignores a late terminal event from an older delivery generation on the same rail', () => {
    renderProvider()
    send(wsState({ prDeliveryId: 'generation-a', decision: 'on_review' }))
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'on_review', supersedesDeliveryId: 'generation-a',
    }))
    send(wsState({ prDeliveryId: 'generation-a', decision: 'superseded' }))
    expect(latest!.decisions.get(0)).toMatchObject({ prDeliveryId: 'generation-b', decision: 'on_review' })
    expect(mockToast.success).not.toHaveBeenCalled()
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('accepts only explicit A-from-B rollback evidence and keeps failed B tombstoned', () => {
    renderProvider()
    send(wsState({
      prDeliveryId: 'generation-a', decision: 'on_review',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:01.000Z',
    }))
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
    }))
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'discarded', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
    }))
    expect(latest!.decisions.has(0)).toBe(false)

    send(wsState({
      prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
    }))
    expect(latest!.decisions.get(0)).toMatchObject({
      prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
    })

    // Failed B cannot replay, and a later C makes the old A-from-B rollback
    // marker ineligible even if a malformed replay claims a newer timestamp.
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:05.000Z',
    }))
    expect(latest!.decisions.get(0)?.prDeliveryId).toBe('generation-a')
    send(wsState({
      prDeliveryId: 'generation-c', decision: 'building', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:06.000Z', updatedAt: '2026-07-10T12:00:06.000Z',
    }))
    send(wsState({
      prDeliveryId: 'generation-a', decision: 'on_review', restoredFromDeliveryId: 'generation-b',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:07.000Z',
    }))
    expect(latest!.decisions.get(0)).toMatchObject({ prDeliveryId: 'generation-c', decision: 'building' })
  })

  it('does not let a delayed HTTP snapshot from A replace generation B', async () => {
    renderProvider()
    send(wsState({ prDeliveryId: 'generation-a', decision: 'on_review' }))

    let resolveAction!: (value: unknown) => void
    global.fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveAction = resolve })) as unknown as typeof fetch
    const pending = latest!.act(0, 'create-pr', 'on_review', 'generation-a')

    send(wsState({
      prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
    }))
    let result: RailPrActResult | undefined
    await act(async () => {
      resolveAction({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          decision: 'pr_ready',
          snapshot: {
            id: 'generation-a', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2],
            baseBranch: 'main', decision: 'pr_ready', prState: 'pr-created',
            prUrl: 'https://github.com/o/r/pull/7', prNumber: 7, branch: 'feat/a', runIds: [],
          },
        }),
      })
      result = await pending
    })

    expect(latest!.decisions.get(0)).toMatchObject({
      prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
    })
    expect(result?.snapshotApplication).toBe('stale')
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

  it('preserves a raced live rail while still hydrating unrelated pending rails from the same GET', async () => {
    let resolveFetch: (v: unknown) => void = () => {}
    global.fetch = vi.fn().mockReturnValue(new Promise((r) => { resolveFetch = r })) as unknown as typeof fetch
    renderProvider()
    // Live WS update arrives while the seed fetch is still in flight.
    send(wsState({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/3', prNumber: 3, prState: 'pr-created' }))
    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ prDeliveries: {
          '0': { id: 'del-1', railIndex: 0, decision: 'on_review' },
          '1': { id: 'del-2', railIndex: 1, railKey: '1-impl', ticketIds: [8], baseBranch: 'main', decision: 'on_review' },
        } }),
      })
    })
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', prNumber: 3 })
    expect(latest!.decisions.get(1)).toMatchObject({ prDeliveryId: 'del-2', decision: 'on_review', ticketIds: [8] })
  })

  it('does not let an ignored terminal from generation A erase generation B returned by an in-flight hydration', async () => {
    let resolveFetch: (value: unknown) => void = () => {}
    global.fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve })) as unknown as typeof fetch
    renderProvider()

    // The client has not seeded generation B yet. A delayed terminal event for
    // older generation A is therefore ignored and must not count as a live
    // mutation of this rail.
    send(wsState({ prDeliveryId: 'generation-a', decision: 'superseded' }))

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ prDeliveries: {
          '0': {
            id: 'generation-b', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2],
            baseBranch: 'main', decision: 'on_review', prState: 'none',
            supersedesDeliveryId: 'generation-a',
          },
        } }),
      })
    })

    expect(latest!.decisions.get(0)).toMatchObject({ prDeliveryId: 'generation-b', decision: 'on_review' })
  })

  it('does not resurrect A when a terminal A event lands while its stale hydration GET is in flight', async () => {
    let resolveFetch: (value: unknown) => void = () => {}
    global.fetch = vi.fn().mockReturnValue(new Promise((resolve) => { resolveFetch = resolve })) as unknown as typeof fetch
    renderProvider()

    // No card is seeded yet, but this terminal event is still a durable
    // tombstone that the pending GET must consult.
    send(wsState({ prDeliveryId: 'generation-a', decision: 'discarded', updatedAt: '2026-07-10 12:00:02' }))

    await act(async () => {
      resolveFetch({
        ok: true,
        json: async () => ({ prDeliveries: {
          '0': {
            id: 'generation-a', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2],
            baseBranch: 'main', decision: 'on_review', prState: 'none',
            updatedAt: '2026-07-10 12:00:01',
          },
        } }),
      })
    })

    expect(latest!.decisions.has(0)).toBe(false)
    expect(mockToast.info).not.toHaveBeenCalled()
  })

  it('focus hydration may restore tombstoned A only with explicit A-from-B rollback evidence', async () => {
    renderProvider()
    await waitFor(() => expect(latest!.hydrated).toBe(true))
    send(wsState({
      prDeliveryId: 'generation-a', decision: 'on_review',
      createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:01.000Z',
    }))
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'building', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:02.000Z',
    }))
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'discarded', supersedesDeliveryId: 'generation-a',
      createdAt: '2026-07-10T12:00:02.000Z', updatedAt: '2026-07-10T12:00:03.000Z',
    }))
    expect(latest!.decisions.has(0)).toBe(false)

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prDeliveries: {
        '0': {
          id: 'generation-a', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2],
          baseBranch: 'main', decision: 'on_review', prState: 'none',
          restoredFromDeliveryId: 'generation-b',
          createdAt: '2026-07-10T12:00:01.000Z', updatedAt: '2026-07-10T12:00:04.000Z',
        },
      } }),
    }) as unknown as typeof fetch
    await act(async () => { window.dispatchEvent(new Event('focus')) })

    await waitFor(() => expect(latest!.decisions.get(0)).toMatchObject({
      prDeliveryId: 'generation-a', restoredFromDeliveryId: 'generation-b',
    }))
  })

  it('act() applies the authoritative HTTP snapshot immediately without waiting for WebSocket', async () => {
    renderProvider()
    send(wsState())
    const postFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({
        ok: true,
        decision: 'pr_draft',
        prUrl: 'https://github.com/o/r/pull/9',
        snapshot: {
          id: 'del-1', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2], baseBranch: 'main', branch: 'feat/batch',
          prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, prState: 'pr-created', decision: 'pr_draft', runIds: [], originConversationId: null,
          implementationOutcome: 'succeeded', deliveryOutcome: 'delivered', statusCode: 'pr_created', cleanupWarnings: [], units: [],
        },
      }),
    })
    global.fetch = postFetch as unknown as typeof fetch
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(0, 'create-pr', 'on_review', 'del-1') })
    expect(postFetch).toHaveBeenCalledWith('/api/projects/proj/rails/pr-decision', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ prDeliveryId: 'del-1', action: 'create-pr', expectedDecision: 'on_review' }),
    }))
    expect(result).toMatchObject({ ok: true, status: 200, decision: 'pr_draft' })
    expect(result?.snapshot).toMatchObject({ decision: 'pr_draft', prNumber: 9 })
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', prNumber: 9 })
  })

  it('act() surfaces a 409 stale_decision result verbatim', async () => {
    renderProvider()
    send(wsState())
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'stale_decision', current: 'pr_draft' }),
    }) as unknown as typeof fetch
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(0, 'create-pr', 'on_review', 'del-1') })
    expect(result).toMatchObject({ ok: false, status: 409, error: 'stale_decision', current: 'pr_draft' })
  })

  it('refuses a captured generation A action after the rail has already advanced to B', async () => {
    renderProvider()
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'pr_failed',
      supersedesDeliveryId: 'generation-a', createdAt: '2026-07-10T12:00:02.000Z',
    }))
    vi.mocked(global.fetch).mockClear()

    let result: RailPrActResult | undefined
    await act(async () => {
      result = await latest!.act(0, 'discard', 'pr_failed', 'generation-a')
    })

    expect(result).toMatchObject({
      ok: false, status: 409, error: 'stale_decision', current: 'pr_failed', snapshotApplication: 'stale',
    })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(latest!.decisions.get(0)?.prDeliveryId).toBe('generation-b')
  })

  it('refuses a captured generation A checkout after the rail has already advanced to B', async () => {
    renderProvider()
    send(wsState({
      prDeliveryId: 'generation-b', decision: 'pr_ready',
      supersedesDeliveryId: 'generation-a', createdAt: '2026-07-10T12:00:02.000Z',
      branch: 'feat/generation-b', prUrl: 'https://github.com/o/r/pull/22',
    }))
    vi.mocked(global.fetch).mockClear()

    let result: RailPrCheckoutResult | undefined
    await act(async () => {
      result = await latest!.checkout(0, 'generation-a')
    })

    expect(result).toMatchObject({ ok: false, status: 409, error: 'stale_decision' })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(latest!.decisions.get(0)?.prDeliveryId).toBe('generation-b')
  })

  it('act() distinguishes operation_in_progress and applies its disabling lease snapshot', async () => {
    renderProvider()
    send(wsState({ decision: 'pr_draft', prUrl: 'https://github.com/o/r/pull/9', prState: 'pr-created' }))
    global.fetch = vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({
        error: 'operation_in_progress', current: 'pr_draft', operation: 'publish',
        snapshot: {
          id: 'del-1', railIndex: 0, railKey: '0-impl', ticketIds: [1, 2], baseBranch: 'main', branch: 'feat/review',
          prUrl: 'https://github.com/o/r/pull/9', prNumber: 9, prState: 'pr-created', decision: 'pr_draft', runIds: [], originConversationId: null, operation: 'publish',
        },
      }),
    }) as unknown as typeof fetch
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(0, 'publish', 'pr_draft', 'del-1') })
    expect(result).toMatchObject({ ok: false, status: 409, busy: true, operation: 'publish' })
    expect(latest!.decisions.get(0)).toMatchObject({ decision: 'pr_draft', operation: 'publish' })
  })

  it('act() without a local delivery (or a network failure) never throws', async () => {
    renderProvider()
    let result: RailPrActResult | undefined
    await act(async () => { result = await latest!.act(5, 'discard', 'on_review', 'missing') })
    expect(result).toMatchObject({ ok: false, status: 0, error: 'no_delivery' })

    send(wsState())
    global.fetch = vi.fn().mockRejectedValue(new Error('boom')) as unknown as typeof fetch
    await act(async () => { result = await latest!.act(0, 'discard', 'on_review', 'del-1') })
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
