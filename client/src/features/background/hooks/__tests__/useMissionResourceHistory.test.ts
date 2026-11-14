import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useMissionResourceHistory } from '../useMissionResourceHistory'
import { getMissionResources, type MissionResourcesSnapshot } from '../../lib/mission-resources-api'

vi.mock('../../lib/mission-resources-api', () => ({ getMissionResources: vi.fn() }))
const snapshot = (sampledAt: number): MissionResourcesSnapshot => ({
  sampledAt, supported: true, entries: [], worktree: null, history: [],
  totals: { cpuPercent: 0, memoryBytes: 0, processCount: 0 },
})
const deferred = () => {
  let resolve!: (value: MissionResourcesSnapshot) => void
  const promise = new Promise<MissionResourcesSnapshot>(r => { resolve = r })
  return { promise, resolve }
}
beforeEach(() => { vi.useFakeTimers(); vi.mocked(getMissionResources).mockReset().mockResolvedValue(snapshot(1)) })
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('useMissionResourceHistory', () => {
  it('[spec:mission-resources/open-resource-views-refresh-within-their-mission-scope] fetches on open and every three seconds, stops on close and refreshes on reopen', async () => {
    const { result, rerender } = renderHook(({ open }) => useMissionResourceHistory('p1', 'c1', open), { initialProps: { open: false } })
    expect(getMissionResources).not.toHaveBeenCalled()
    rerender({ open: true })
    await act(async () => {})
    expect(getMissionResources).toHaveBeenCalledExactlyOnceWith('p1', 'c1', expect.any(AbortSignal))
    expect(result.current.latest?.sampledAt).toBe(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(2999) })
    expect(getMissionResources).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(getMissionResources).toHaveBeenCalledTimes(2)
    const signal = vi.mocked(getMissionResources).mock.calls[0][2]!
    rerender({ open: false })
    expect(signal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(getMissionResources).toHaveBeenCalledTimes(2)
    rerender({ open: true })
    await act(async () => {})
    expect(getMissionResources).toHaveBeenCalledTimes(3)
  })

  it('[spec:mission-resources/open-resource-views-refresh-within-their-mission-scope] aborts on unmount and ignores delayed closed responses', async () => {
    const pending = deferred()
    vi.mocked(getMissionResources).mockReturnValue(pending.promise)
    const { result, rerender, unmount } = renderHook(({ open }) => useMissionResourceHistory('p1', 'c1', open), { initialProps: { open: true } })
    const firstSignal = vi.mocked(getMissionResources).mock.calls[0][2]!
    rerender({ open: false })
    await act(async () => { pending.resolve(snapshot(9)); await pending.promise })
    expect(firstSignal.aborted).toBe(true)
    expect(result.current.latest).toBeNull()
    rerender({ open: true })
    const signal = vi.mocked(getMissionResources).mock.calls[1][2]!
    unmount()
    expect(signal.aborted).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(6000) })
    expect(getMissionResources).toHaveBeenCalledTimes(2)
  })

  it.each(['project', 'chat'] as const)('[spec:mission-resources/open-resource-views-refresh-within-their-mission-scope] rejects delayed responses after a %s switch', async field => {
    const old = deferred(); const current = deferred()
    vi.mocked(getMissionResources).mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    const { result, rerender } = renderHook(({ project, chat }) => useMissionResourceHistory(project, chat, true), { initialProps: { project: 'p1', chat: 'c1' } })
    const oldSignal = vi.mocked(getMissionResources).mock.calls[0][2]!
    rerender({ project: field === 'project' ? 'p2' : 'p1', chat: field === 'chat' ? 'c2' : 'c1' })
    expect(result.current.latest).toBeNull()
    expect(oldSignal.aborted).toBe(true)
    expect(getMissionResources).toHaveBeenLastCalledWith(field === 'project' ? 'p2' : 'p1', field === 'chat' ? 'c2' : 'c1', expect.any(AbortSignal))
    await act(async () => { current.resolve(snapshot(2)); await current.promise })
    await act(async () => { old.resolve(snapshot(1)); await old.promise })
    expect(result.current.latest?.sampledAt).toBe(2)
  })

  it('[spec:mission-resources/open-resource-views-refresh-within-their-mission-scope] reports failure and recovers at the next poll', async () => {
    vi.mocked(getMissionResources).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot(2))
    const { result } = renderHook(() => useMissionResourceHistory('p1', 'c1', true))
    await act(async () => {})
    expect(result.current.error).toBe('offline')
    expect(result.current.latest).toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
    expect(result.current.error).toBeNull()
    expect(result.current.latest?.sampledAt).toBe(2)
  })
})
