import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { AgentMessage, AgentPrDecisionEnvelope } from '../lib/agent-api'
import {
  PR_CARD_POLL_MAX_MS,
  PR_CARD_POLL_MS,
  PR_CARD_RESUME_DRIFT_MS,
  PR_CARD_RESUME_TICK_MS,
  PR_CARD_RESYNC_MIN_GAP_MS,
  hasUnsettledPrCard,
  railStateDiffersFromCard,
  usePrCardResync,
} from './usePrCardResync'

const card = (over: Partial<AgentPrDecisionEnvelope> = {}, id = 'm1'): AgentMessage => ({
  id, conversation_id: 'c1', role: 'system', created_at: '',
  content: JSON.stringify({
    kind: 'pr_decision', prDeliveryId: 'd1', railIndex: 0, projectId: 'p1', baseBranch: 'main', ticketIds: [1],
    decision: 'building', prUrl: null, prNumber: null, prState: 'none', branch: null, runIds: [], ...over,
  }),
})

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => value })
}

describe('card resync predicates', () => {
  it('treats building and launched/running cards as unsettled, settled ones as settled', () => {
    expect(hasUnsettledPrCard([card()])).toBe(true)
    expect(hasUnsettledPrCard([card({ decision: 'completed', phase: 'running', hasDelivery: false })])).toBe(true)
    expect(hasUnsettledPrCard([card({ decision: 'on_review', phase: 'delivery' })])).toBe(false)
    expect(hasUnsettledPrCard([card({ decision: 'discarded', phase: 'running' })])).toBe(false)
    expect(hasUnsettledPrCard([])).toBe(false)
  })

  it('flags a rail.pr_state that disagrees with the card of the same project only', () => {
    const messages = [card()]
    expect(railStateDiffersFromCard(messages, { type: 'rail.pr_state', prDeliveryId: 'd1', decision: 'on_review', projectId: 'p1' })).toBe(true)
    expect(railStateDiffersFromCard(messages, { type: 'rail.pr_state', prDeliveryId: 'd1', decision: 'building', projectId: 'p1' })).toBe(false)
    expect(railStateDiffersFromCard(messages, { type: 'rail.pr_state', prDeliveryId: 'd1', decision: 'on_review', projectId: 'p2' })).toBe(false)
    expect(railStateDiffersFromCard(messages, { type: 'rail.pr_state', prDeliveryId: 'other', decision: 'on_review' })).toBe(false)
    expect(railStateDiffersFromCard(messages, null)).toBe(false)
  })
})

describe('usePrCardResync', () => {
  beforeEach(() => { vi.useFakeTimers(); setVisibility('visible') })
  afterEach(() => { vi.useRealTimers() })

  it('coalesces a burst of focus/visibility signals into one fetch, then honours the gap', async () => {
    const resync = vi.fn(async () => true)
    renderHook(() => usePrCardResync({ enabled: true, resync, unsettled: false }))
    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
    })
    expect(resync).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_RESYNC_MIN_GAP_MS) })
    // The suppressed signals collapse into ONE trailing fetch, never a storm.
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('ignores a visibilitychange to hidden and does nothing when disabled', async () => {
    const resync = vi.fn(async () => true)
    const { rerender } = renderHook(({ enabled }) => usePrCardResync({ enabled, resync, unsettled: true }), { initialProps: { enabled: false } })
    await act(async () => { window.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS * 2) })
    expect(resync).not.toHaveBeenCalled()
    rerender({ enabled: true })
    setVisibility('hidden')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    expect(resync).not.toHaveBeenCalled()
  })

  it('polls while a card is unsettled, pauses while hidden and stops once it settles', async () => {
    const resync = vi.fn(async () => true)
    const { rerender } = renderHook(({ unsettled }) => usePrCardResync({ enabled: true, resync, unsettled }), { initialProps: { unsettled: true } })
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS) })
    expect(resync).toHaveBeenCalledTimes(1)
    setVisibility('hidden')
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS * 3) })
    expect(resync).toHaveBeenCalledTimes(1)
    setVisibility('visible')
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS) })
    expect(resync).toHaveBeenCalledTimes(2)
    rerender({ unsettled: false })
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS * 10) })
    expect(resync).toHaveBeenCalledTimes(2)
  })

  it('backs off after failed fetches up to the ceiling', async () => {
    const resync = vi.fn(async () => false)
    renderHook(() => usePrCardResync({ enabled: true, resync, unsettled: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS) })
    expect(resync).toHaveBeenCalledTimes(1)
    // Second attempt waits twice as long after one failure.
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS) })
    expect(resync).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MS) })
    expect(resync).toHaveBeenCalledTimes(2)
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_POLL_MAX_MS * 3) })
    expect(resync.mock.calls.length).toBeLessThanOrEqual(5)
  })

  it('resyncs after a system resume (wall-clock jump across a frozen timer)', async () => {
    const resync = vi.fn(async () => true)
    renderHook(() => usePrCardResync({ enabled: true, resync, unsettled: false }))
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_RESUME_TICK_MS) })
    expect(resync).not.toHaveBeenCalled()
    // Sleep: the clock moves on while no timer fires.
    vi.setSystemTime(Date.now() + PR_CARD_RESUME_DRIFT_MS * 4)
    await act(async () => { await vi.advanceTimersByTimeAsync(PR_CARD_RESUME_TICK_MS) })
    expect(resync).toHaveBeenCalledTimes(1)
  })
})
