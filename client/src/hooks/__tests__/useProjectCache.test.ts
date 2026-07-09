import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useProjectCache, purgeProjectCache } from '../useProjectCache'

// Access the module-level globalCache by re-importing the module
// We'll clear it between tests by switching projectIds

describe('useProjectCache', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns initialValue when no cache exists', () => {
    const fetcher = vi.fn().mockResolvedValue(['data'])
    const { result } = renderHook(() =>
      useProjectCache({
        namespace: 'test',
        projectId: 'proj-no-cache',
        initialValue: [] as string[],
        fetcher,
      })
    )
    // Before the fetch resolves
    expect(result.current.data).toEqual([])
    expect(result.current.isFirstLoad).toBe(true)
  })

  it('calls fetcher on mount and updates data with result', async () => {
    const fetcher = vi.fn().mockResolvedValue(['item1', 'item2'])
    const { result } = renderHook(() =>
      useProjectCache({
        namespace: 'mount-test',
        projectId: 'proj-mount',
        initialValue: [] as string[],
        fetcher,
      })
    )
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.data).toEqual(['item1', 'item2']))
    expect(result.current.isLoading).toBe(false)
    expect(result.current.isFirstLoad).toBe(false)
  })

  it('on projectId change: instantly restores cached data, fetches fresh in background', async () => {
    const fetcher = vi.fn()
    fetcher.mockResolvedValueOnce(['proj-a-data'])
    fetcher.mockResolvedValueOnce(['proj-b-data'])
    fetcher.mockResolvedValueOnce(['proj-a-fresh'])

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useProjectCache({
          namespace: 'switch-test',
          projectId,
          initialValue: [] as string[],
          fetcher,
        }),
      { initialProps: { projectId: 'proj-switch-a' } }
    )

    // Wait for project A data to load and be cached
    await waitFor(() => expect(result.current.data).toEqual(['proj-a-data']))

    // Switch to project B
    rerender({ projectId: 'proj-switch-b' })
    // project B has no cache, so starts with initialValue
    expect(result.current.data).toEqual([])

    // Wait for project B data
    await waitFor(() => expect(result.current.data).toEqual(['proj-b-data']))

    // Switch back to A — should restore cached data instantly
    rerender({ projectId: 'proj-switch-a' })
    expect(result.current.data).toEqual(['proj-a-data'])
    expect(result.current.isFirstLoad).toBe(false)
  })

  it('cancelled flag prevents stale fetch from updating state', async () => {
    let resolveFirst: (v: string[]) => void
    const firstFetch = new Promise<string[]>((res) => { resolveFirst = res })
    const fetcher = vi.fn()
    fetcher.mockReturnValueOnce(firstFetch)
    fetcher.mockResolvedValueOnce(['proj-b-stale-test'])

    const { result, rerender } = renderHook(
      ({ projectId }: { projectId: string }) =>
        useProjectCache({
          namespace: 'cancel-test',
          projectId,
          initialValue: [] as string[],
          fetcher,
        }),
      { initialProps: { projectId: 'proj-cancel-a' } }
    )

    // Switch before first fetch resolves
    rerender({ projectId: 'proj-cancel-b' })
    await waitFor(() => expect(result.current.data).toEqual(['proj-b-stale-test']))

    // Now resolve the first (cancelled) fetch
    act(() => resolveFirst!(['stale-data']))

    // Should NOT have updated to stale-data — still on proj-b data
    expect(result.current.data).toEqual(['proj-b-stale-test'])
  })

  it('polling: when pollInterval > 0, fetcher is called repeatedly', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn().mockResolvedValue(['polled'])
    renderHook(() =>
      useProjectCache({
        namespace: 'poll-test',
        projectId: 'proj-poll',
        initialValue: [] as string[],
        fetcher,
        pollInterval: 1000,
      })
    )

    // Initial fetch
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledTimes(1)

    // Advance timer to trigger poll
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledTimes(2)

    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => { await Promise.resolve() })
    expect(fetcher).toHaveBeenCalledTimes(3)

    vi.useRealTimers()
  })

  it('error in fetcher: keeps cached/initial data, does not crash', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('fetch failed'))
    const { result } = renderHook(() =>
      useProjectCache({
        namespace: 'error-test',
        projectId: 'proj-error',
        initialValue: ['initial'] as string[],
        fetcher,
      })
    )

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    // Data stays at initial value after error
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual(['initial'])
    expect(result.current.error).toBe('fetch failed')
  })

  it('exposes a non-empty fallback when the fetcher rejects without a message', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error())
    const { result } = renderHook(() => useProjectCache({
      namespace: 'empty-error-test',
      projectId: 'proj-empty-error',
      initialValue: ['last-good'] as string[],
      fetcher,
    }))

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual(['last-good'])
    expect(result.current.error).toBe('Request failed')
  })

  it('failed refresh preserves the last good value and a later retry clears the error', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(['good'])
      .mockRejectedValueOnce(new Error('refresh failed'))
      .mockResolvedValueOnce(['recovered'])
    const { result } = renderHook(() => useProjectCache({
      namespace: 'refresh-error-test',
      projectId: 'proj-refresh-error',
      initialValue: [] as string[],
      fetcher,
    }))
    await waitFor(() => expect(result.current.data).toEqual(['good']))

    await act(async () => { await result.current.refresh() })
    expect(result.current.data).toEqual(['good'])
    expect(result.current.error).toBe('refresh failed')

    await act(async () => { await result.current.refresh() })
    expect(result.current.data).toEqual(['recovered'])
    expect(result.current.error).toBeNull()
  })

  it('ignores an older same-project refresh that resolves after a newer one', async () => {
    let resolveOld!: (value: string[]) => void
    const oldRequest = new Promise<string[]>((resolve) => { resolveOld = resolve })
    const fetcher = vi.fn()
      .mockResolvedValueOnce(['initial'])
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce(['newest'])
    const { result } = renderHook(() => useProjectCache({
      namespace: 'refresh-generation-test',
      projectId: 'proj-refresh-generation',
      initialValue: [] as string[],
      fetcher,
    }))
    await waitFor(() => expect(result.current.data).toEqual(['initial']))

    let oldRefresh!: Promise<void>
    act(() => { oldRefresh = result.current.refresh() })
    await act(async () => { await result.current.refresh() })
    expect(result.current.data).toEqual(['newest'])

    await act(async () => {
      resolveOld(['stale'])
      await oldRefresh
    })
    expect(result.current.data).toEqual(['newest'])
  })

  it('refresh() triggers a new fetch', async () => {
    const fetcher = vi.fn()
    fetcher.mockResolvedValueOnce(['v1'])
    fetcher.mockResolvedValueOnce(['v2'])

    const { result } = renderHook(() =>
      useProjectCache({
        namespace: 'refresh-test',
        projectId: 'proj-refresh',
        initialValue: [] as string[],
        fetcher,
      })
    )

    await waitFor(() => expect(result.current.data).toEqual(['v1']))

    act(() => { result.current.refresh() })
    await waitFor(() => expect(result.current.data).toEqual(['v2']))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('purgeProjectCache: drops cached entries so a later mount re-fetches (BUG-CLIENT-03)', async () => {
    const fetcher = vi.fn()
    fetcher.mockResolvedValueOnce(['purge-v1'])
    fetcher.mockResolvedValueOnce(['purge-v2'])

    // First mount caches under `proj-purge:purge-ns`.
    const first = renderHook(() =>
      useProjectCache({
        namespace: 'purge-ns',
        projectId: 'proj-purge',
        initialValue: [] as string[],
        fetcher,
      })
    )
    await waitFor(() => expect(first.result.current.data).toEqual(['purge-v1']))
    first.unmount()

    // Purge that project's cache.
    purgeProjectCache('proj-purge')

    // A fresh mount must behave as a first-load (no cached data, isFirstLoad true)
    // and fetch again — proving the entry was actually removed.
    const second = renderHook(() =>
      useProjectCache({
        namespace: 'purge-ns',
        projectId: 'proj-purge',
        initialValue: [] as string[],
        fetcher,
      })
    )
    expect(second.result.current.isFirstLoad).toBe(true)
    expect(second.result.current.data).toEqual([])
    await waitFor(() => expect(second.result.current.data).toEqual(['purge-v2']))
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('purgeProjectCache: only removes the targeted project, leaves others intact', async () => {
    const fetcherA = vi.fn().mockResolvedValue(['keep-a'])
    const fetcherB = vi.fn().mockResolvedValue(['drop-b'])

    const a = renderHook(() =>
      useProjectCache({ namespace: 'iso-ns', projectId: 'keep', initialValue: [] as string[], fetcher: fetcherA })
    )
    const b = renderHook(() =>
      useProjectCache({ namespace: 'iso-ns', projectId: 'drop', initialValue: [] as string[], fetcher: fetcherB })
    )
    await waitFor(() => expect(a.result.current.data).toEqual(['keep-a']))
    await waitFor(() => expect(b.result.current.data).toEqual(['drop-b']))
    a.unmount()
    b.unmount()

    purgeProjectCache('drop')

    // 'keep' still has its cached entry → instant restore, no first-load.
    const keepAgain = renderHook(() =>
      useProjectCache({ namespace: 'iso-ns', projectId: 'keep', initialValue: [] as string[], fetcher: fetcherA })
    )
    expect(keepAgain.result.current.isFirstLoad).toBe(false)
    expect(keepAgain.result.current.data).toEqual(['keep-a'])
  })

  it('purgeProjectCache: empty projectId is a no-op', () => {
    // Should not throw.
    expect(() => purgeProjectCache('')).not.toThrow()
  })

  afterEach(() => {
    vi.useRealTimers()
  })
})
