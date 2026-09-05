import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { MemoryRouter } from 'react-router-dom'

let capturedHandler: ((data: unknown) => void) | null = null
vi.mock('../useSharedWebSocket', () => ({
  useSharedWebSocket: () => ({
    registerHandler: (_id: string, fn: (data: unknown) => void) => { capturedHandler = fn },
    unregisterHandler: () => { capturedHandler = null },
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
  currentRailIndex: 3, headBranch: null, launched: [], updatedAt: 'x', ...over,
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
  beforeEach(() => { vi.clearAllMocks(); capturedHandler = null })

  it('toasts a LATER chunk launch (never the first — the launch call site owns that)', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 1 }) })
    expect(toastSuccess).not.toHaveBeenCalled()
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: chain({ nextChunk: 2 }) })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    expect(toastSuccess.mock.calls[0][0]).toBe('M1 — rail 2 of 3 launched')
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
    expect(title).toBe('M1 paused — the next rail could not launch (rail_limit_reached)')
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

  it('a wave checkpoint toasts once per rail with Launch next (resume) and Auto-continue (PATCH) actions', async () => {
    resumeChain.mockResolvedValue({ ok: true, chain: null })
    setChainAutoAdvance.mockResolvedValue({ ok: true, chain: null })
    renderHook(() => useMilestoneNotifications(), { wrapper })
    const cp = chain({ status: 'awaiting_approval', autoAdvance: false, nextChunk: 1, headBranch: 'feat/1' })
    send({ type: 'milestone.chain_changed', projectId: 'p1', chain: cp })
    expect(toastSuccess).toHaveBeenCalledTimes(1)
    const [title, opts] = toastSuccess.mock.calls[0] as [string, { id: string; action: { label: string; onClick: () => void }; cancel: { label: string; onClick: () => void } }]
    expect(title).toBe('M1 — rail 1 of 3 delivered. Launch the next rail?')
    expect(opts.id).toBe('chain-checkpoint:c1:1')
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
    expect(title).toBe('M1 delivered — 8 specs waiting for your review')
    expect(opts.action.label).toBe('Review')
    vi.useFakeTimers()
    try {
      act(() => { opts.action.onClick(); vi.advanceTimersByTime(100) })
    } finally { vi.useRealTimers() }
    expect(setActiveProjectId).toHaveBeenCalledWith('p1')
    expect(mockNavigate).toHaveBeenCalledWith('/review/d-9')
  })

  it('announces a completed milestone and ignores messages without a project', () => {
    renderHook(() => useMilestoneNotifications(), { wrapper })
    send({ type: 'blueprint.milestone_completed', projectId: 'p1', milestoneId: 'm1', n: 1, title: 'Skeleton' })
    expect(toastSuccess).toHaveBeenCalledWith('M1 complete — every spec merged', expect.anything())
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
