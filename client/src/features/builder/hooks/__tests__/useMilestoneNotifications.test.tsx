import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

let capturedHandler: ((data: unknown) => void) | null = null
const registerHandler = vi.fn((_id: string, fn: (data: unknown) => void) => { capturedHandler = fn })
const unregisterHandler = vi.fn(() => { capturedHandler = null })
vi.mock('../../../../hooks/useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler,
    unregisterHandler,
    connectionStatus: 'connected',
  }),
}))
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  return { ...(actual as object), useNavigate: () => mockNavigate }
})
const toastSuccess = vi.fn()
const toastWarning = vi.fn()
const toastError = vi.fn()
vi.mock('sonner', () => ({
  toast: {
    success: (...a: unknown[]) => toastSuccess(...a),
    warning: (...a: unknown[]) => toastWarning(...a),
    error: (...a: unknown[]) => toastError(...a),
    info: vi.fn(),
  },
}))
const resumeChain = vi.fn()
const setChainAutoAdvance = vi.fn()
vi.mock('../../lib/milestone-launch', async () => {
  const actual = await vi.importActual<typeof import('../../lib/milestone-launch')>('../../lib/milestone-launch')
  return { ...actual, resumeChain: (...a: unknown[]) => resumeChain(...a), setChainAutoAdvance: (...a: unknown[]) => setChainAutoAdvance(...a) }
})

import { useMilestoneNotifications, localizeChainPauseReason } from '../useMilestoneNotifications'

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(MemoryRouter, null, children)
}
const chain = (over: Record<string, unknown> = {}) => ({
  id: 'c1', milestoneN: 1, mode: 'sequential', status: 'running', pauseReason: null, autoAdvance: true, nextChunk: 1, totalChunks: 3,
  currentRailIndex: 3, headBranch: null, launched: [], createdAt: '2026-09-04T10:00:00.000Z', updatedAt: '2026-09-04T12:05:00.000Z', ...over,
})
const send = (msg: unknown) => act(() => { capturedHandler?.(msg) })
const milestone = (state: string, onReview = 0, deliveryId: string | null = null) => ({
  id: 'm1', n: 1, title: 'Skeleton', storedStatus: 'committed', state,
  counts: { total: 8, done: 0, onReview, inProgress: 0, todo: 8 - onReview, failed: 0 },
  rails: deliveryId ? [{ railIndex: 3, name: 'M1 · 1', ticketIds: [1], active: false, runId: null, startedAt: null, chunkIndex: 1,
    delivery: { id: deliveryId, railIndex: 3, ticketIds: [1], decision: 'on_review', branch: 'b', baseBranch: 'main', prUrl: null, prNumber: null, prState: 'none', createdAt: null } }] : [],
  chain: null,
})

describe('useMilestoneNotifications', () => {
  beforeEach(() => { vi.clearAllMocks(); capturedHandler = null; vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-04T10:38:00.000Z')) })
  afterEach(() => { vi.restoreAllMocks() })

  it('toasts a LATER chunk launch (never the first — the launch call site owns that)', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 1 }) })
    expect(toastSuccess).not.toHaveBeenCalled()
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith('M1 — rail 2 of 3 launched', { id: 'chain-launch:c1:2', description: 'Running · 38m total' })
    // A repeated frame for the same chunk is inert.
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('a paused chain warns with the localized reason and a Resume action that calls the chain route', async () => {
    resumeChain.mockResolvedValue({ ok: true, chain: null })
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'paused', pauseReason: 'launch_rejected:rail_limit_reached' }) })
    expect(toastWarning).toHaveBeenCalledTimes(1)
    const [title, opts] = toastWarning.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('M1 — paused — the next rail could not launch (rail_limit_reached)')
    expect(opts).toMatchObject({ id: 'chain-paused:c1', duration: 30_000, description: 'Paused · 38m total' })
    expect(opts.action.label).toBe('Resume')
    await act(async () => { opts.action.onClick() })
    expect(resumeChain).toHaveBeenCalledWith('p1', 'c1')
    expect(toastSuccess).toHaveBeenCalledWith('Chain resumed', expect.anything())
    // Same pause frame again → no second warning; a different reason → a new one.
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'paused', pauseReason: 'launch_rejected:rail_limit_reached' }) })
    expect(toastWarning).toHaveBeenCalledTimes(1)
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'paused', pauseReason: 'head_missing' }) })
    expect(toastWarning).toHaveBeenCalledTimes(2)
  })

  it('[spec:milestone-launch-chain/notification-lifecycle-and-actions-remain-stable] a wave checkpoint toasts once per rail with Launch next (resume) and Auto-continue (PATCH) actions', async () => {
    resumeChain.mockResolvedValue({ ok: true, chain: null })
    setChainAutoAdvance.mockResolvedValue({ ok: true, chain: null })
    renderHook(() => useMilestoneNotifications(), { wrapper })
    const cp = chain({ status: 'awaiting_approval', autoAdvance: false, nextChunk: 1, headBranch: 'feat/1' })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: cp })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    const [title, opts] = toastSuccess.mock.calls[0] as [string, { id: string; action: { label: string; onClick: () => void }; cancel: { label: string; onClick: () => void } }]
    expect(title).toBe('M1 — rail 1 of 3 delivered. Launch the next rail?')
    expect(opts).toMatchObject({ id: 'chain-checkpoint:c1:1', duration: 60_000, description: 'Awaiting approval · 38m total' })
    expect(opts.action.label).toBe('Launch next rail')
    expect(opts.cancel.label).toBe('Auto-continue')
    // Same checkpoint frame again → no duplicate.
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: cp })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    await act(async () => { opts.action.onClick() })
    expect(resumeChain).toHaveBeenCalledWith('p1', 'c1')
    expect(toastSuccess).toHaveBeenCalledWith('Next rail launched', expect.objectContaining({ id: 'chain-checkpoint:c1:1' }))
    await act(async () => { opts.cancel.onClick() })
    expect(setChainAutoAdvance).toHaveBeenCalledWith('p1', 'c1', true)
    expect(toastSuccess).toHaveBeenCalledWith('Auto-continue on — the next rails launch on their own', expect.objectContaining({ id: 'chain-checkpoint:c1:1' }))
    // The next checkpoint (rail 2) toasts again; a failed PATCH reports honestly.
    setChainAutoAdvance.mockResolvedValueOnce({ ok: false, error: 'chain_terminal', detail: 'gone' })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'awaiting_approval', autoAdvance: false, nextChunk: 2 }) })
    const opts2 = toastSuccess.mock.calls.at(-1)![1] as { cancel: { onClick: () => void } }
    await act(async () => { opts2.cancel.onClick() })
    expect(toastError).toHaveBeenCalledWith('Could not update the chain', expect.objectContaining({ description: 'gone' }))
  })

  it('a failed resume reports honestly', async () => {
    resumeChain.mockResolvedValue({ ok: false, error: 'head_missing', detail: 'gone' })
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'paused', pauseReason: 'chunk_failed' }) })
    const opts = toastWarning.mock.calls[0][1] as { action: { onClick: () => void } }
    await act(async () => { opts.action.onClick() })
    expect(toastError).toHaveBeenCalledWith('Could not resume the chain', expect.objectContaining({ description: 'gone' }))
  })

  it('toasts delivered ONLY on a state transition, with a Review action into the packet', () => {
    const setActiveProjectId = vi.fn()
    renderHook(() => useMilestoneNotifications({ setActiveProjectId }), { wrapper })
    // First observation seeds the state — no toast for history.
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [milestone('delivered', 8, 'd-9')] })
    expect(toastSuccess).not.toHaveBeenCalled()
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [milestone('running')] })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [milestone('delivered', 8, 'd-9')] })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    const [title, opts] = toastSuccess.mock.calls[0] as [string, { action: { label: string; onClick: () => void } }]
    expect(title).toBe('M1 — delivered — 8 specs waiting for your review')
    expect(opts).toMatchObject({ id: 'milestone-delivered:p1:m1', duration: 30_000, description: 'Delivered — awaiting review' })
    expect(opts.action.label).toBe('Review')
    vi.useFakeTimers()
    try {
      act(() => { opts.action.onClick() })
      expect(setActiveProjectId).toHaveBeenCalledWith('p1')
      expect(mockNavigate).not.toHaveBeenCalled()
      act(() => { vi.advanceTimersByTime(50) })
    } finally { vi.useRealTimers() }
    expect(setActiveProjectId).toHaveBeenCalledWith('p1')
    expect(mockNavigate).toHaveBeenCalledWith('/review/d-9')
  })

  it('announces a completed milestone and ignores messages without a project', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1, title: 'Skeleton' })
    expect(toastSuccess).toHaveBeenCalledWith('M1 — complete — every spec merged', { id: 'milestone-completed:p1:m1', duration: 15_000, description: 'Completed' })
    send({ type: 'blueprint.milestone_completed', n: 1 })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: { bogus: true } })
    send(null)
    expect(toastSuccess).toHaveBeenCalledTimes(1)
  })

  it('localizeChainPauseReason falls back to the raw reason for unknown codes', () => {
    expect(localizeChainPauseReason('chunk_stalled')).toBe('the last rail stalled (no provider output)')
    expect(localizeChainPauseReason('provider_limit')).toBe("the provider's usage limit was reached")
    expect(localizeChainPauseReason('weird_reason')).toBe('weird_reason')
    expect(localizeChainPauseReason(null)).toBe('')
  })
})

describe('milestone notification context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    capturedHandler = null
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-04T13:00:00.000Z'))
  })
  afterEach(() => { vi.restoreAllMocks() })

  it.each([
    ['running', 'specrails · M1 — rail 2 of 3 launched', 'Running · 3h 00m total'],
    ['awaiting_approval', 'specrails · M1 — rail 2 of 3 delivered. Launch the next rail?', 'Awaiting approval · 3h 00m total'],
    ['paused', 'specrails · M1 — paused — the last rail failed', 'Paused · 3h 00m total'],
  ])('qualifies %s events with project, progress and static total', (status, title, description) => {
    renderHook(() => useMilestoneNotifications({ projectsById: new Map([['p1', 'specrails']]) }), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status, nextChunk: 2, pauseReason: 'chunk_failed' }) })
    expect([...toastSuccess.mock.calls, ...toastWarning.mock.calls]).toEqual([[title, expect.objectContaining({ description })]])
  })

  it('prefers delivery progress timing over a previous chain frame and freezes it', () => {
    renderHook(() => useMilestoneNotifications({ projectsById: new Map([['p1', 'specrails']]) }), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ updatedAt: '2026-09-04T10:05:00.000Z' }) })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [milestone('running')] })
    const delivered = { ...milestone('delivered', 8, 'd-9'), chain: chain({ status: 'completed' }) }
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [delivered] })
    expect(toastSuccess).toHaveBeenCalledWith('specrails · M1 — delivered — 8 specs waiting for your review', expect.objectContaining({ id: 'milestone-delivered:p1:m1', duration: 30_000, description: 'Delivered — awaiting review · 2h 05m total', action: expect.objectContaining({ label: 'Review' }) }))
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [delivered] })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0][1].description).toBe('Delivered — awaiting review · 2h 05m total')
  })

  it('[spec:milestone-launch-chain/notification-lifecycle-and-actions-remain-stable] seeds completion timing from initial progress without replaying history or needing chain_changed', () => {
    renderHook(() => useMilestoneNotifications({ projectsById: new Map([['p1', 'specrails']]) }), { wrapper })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [{ ...milestone('delivered', 8), chain: chain({ status: 'completed' }) }] })
    expect(toastSuccess).not.toHaveBeenCalled()
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1 })
    expect(toastSuccess).toHaveBeenCalledWith('specrails · M1 — complete — every spec merged', { id: 'milestone-completed:p1:m1', duration: 15_000, description: 'Completed in 2h 05m' })
  })

  it('refreshes timing on equal-state progress before the early return', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [{ ...milestone('running'), chain: chain() }] })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [{ ...milestone('running'), chain: chain({ updatedAt: '2026-09-04T11:00:00.000Z' }) }] })
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls[0][1].description).toBe('Completed in 1h 00m')
  })

  it('clears an authoritative null chain instead of reusing stale timing', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain() })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [milestone('running')] })
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls[0][1].description).toBe('Completed')
  })

  it('replaces the association when a newer chain starts for the same milestone', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'blueprint.milestone_progress', projectId: 'p1', progress: [{ ...milestone('running'), chain: chain() }] })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ id: 'c2', createdAt: '2026-09-04T12:00:00.000Z', updatedAt: '2026-09-04T12:45:00.000Z' }) })
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls[0][1].description).toBe('Completed in 45m')
  })

  it('[spec:milestone-launch-chain/notification-context-degrades-safely] isolates colliding chain ids by project and milestone for guards and completion timing', () => {
    renderHook(() => useMilestoneNotifications({ projectsById: new Map([['p1', 'Alpha'], ['p2', 'Beta']]) }), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    send({ type: 'milestone.chain_changed', projectId: 'p2', chain: chain({ nextChunk: 2, createdAt: '2026-09-04T12:00:00.000Z' }) })
    send({ type: 'milestone.chain_changed', projectId: 'p2', chain: chain({ milestoneN: 2, nextChunk: 2, createdAt: '2026-09-04T12:04:00.000Z' }) })
    expect(toastSuccess).toHaveBeenCalledTimes(3)
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls.at(-1)).toEqual(['Alpha · M1 — complete — every spec merged', expect.objectContaining({ description: 'Completed in 2h 05m' })])
    send({ type: 'blueprint.milestone_completed', projectId: 'p2', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls.at(-1)).toEqual(['Beta · M1 — complete — every spec merged', expect.objectContaining({ description: 'Completed in 5m' })])
    send({ type: 'blueprint.milestone_completed', projectId: 'p2', milestoneId: 'm2', n: 2 })
    expect(toastSuccess.mock.calls.at(-1)).toEqual(['Beta · M2 — complete — every spec merged', expect.objectContaining({ description: 'Completed in 1m' })])
    send({ type: 'blueprint.milestone_completed', projectId: 'p3', milestoneId: 'm1', n: 1 })
    expect(toastSuccess.mock.calls.at(-1)).toEqual(['M1 — complete — every spec merged', expect.objectContaining({ description: 'Completed' })])
  })

  it.each([
    [undefined, 'Running'], ['invalid', 'Running'], ['2026-09-05T10:00:00.000Z', 'Running · 0s total'],
  ])('handles legacy/invalid/future start %s at the WS boundary', (createdAt, description) => {
    renderHook(() => useMilestoneNotifications({ projectsById: new Map([['p1', '  ']]) }), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2, createdAt }) })
    expect(toastSuccess).toHaveBeenCalledWith('M1 — rail 2 of 3 launched', { id: 'chain-launch:c1:2', description })
  })

  it('uses refreshed project names without handler reset and unregisters on cleanup', () => {
    const { rerender, unmount } = renderHook(({ projectsById }) => useMilestoneNotifications({ projectsById }), { wrapper, initialProps: { projectsById: new Map([['p1', 'Old']]) } })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    const original = capturedHandler
    rerender({ projectsById: new Map([['p1', 'Renamed']]) })
    expect(capturedHandler).toBe(original)
    expect(registerHandler).toHaveBeenCalledTimes(1)
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 3 }) })
    expect(toastSuccess.mock.calls.at(-1)?.[0]).toBe('Renamed · M1 — rail 3 of 3 launched')
    unmount()
    expect(unregisterHandler).toHaveBeenCalledWith('milestone-notifications')
    expect(capturedHandler).toBeNull()
  })

  it('keeps checkpoint Launch next failure handling and toast id reuse', async () => {
    resumeChain.mockResolvedValue({ ok: false, error: 'head_missing', detail: 'gone' })
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ status: 'awaiting_approval' }) })
    await act(async () => { toastSuccess.mock.calls[0][1].action.onClick() })
    expect(resumeChain).toHaveBeenCalledWith('p1', 'c1')
    expect(toastError).toHaveBeenCalledWith('Could not resume the chain', expect.objectContaining({ id: 'chain-checkpoint:c1:1', description: 'gone' }))
  })
})
