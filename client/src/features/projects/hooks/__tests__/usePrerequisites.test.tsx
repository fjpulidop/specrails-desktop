import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePrerequisites, __resetPrerequisitesCacheForTest } from '../usePrerequisites'

const goodStatus = {
  ok: true,
  platform: 'darwin' as const,
  prerequisites: [
    { key: 'node', label: 'Node.js', command: 'node', required: true, installed: true, version: 'v20.0.0', minVersion: '18.0.0', meetsMinimum: true, installUrl: '', installHint: '' },
  ],
  missingRequired: [],
}

describe('usePrerequisites', () => {
  beforeEach(() => {
    __resetPrerequisitesCacheForTest()
  })

  it('fetches on first mount and exposes the status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => goodStatus })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => usePrerequisites())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.status).toEqual(goodStatus)
    expect(result.current.error).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reuses the cached value when re-rendered within 60 s', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => goodStatus })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result: r1, unmount: u1 } = renderHook(() => usePrerequisites())
    await waitFor(() => expect(r1.current.isLoading).toBe(false))
    u1()

    const { result: r2 } = renderHook(() => usePrerequisites())
    expect(r2.current.status).toEqual(goodStatus)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('recheck() invalidates cache and re-fetches', async () => {
    const second = { ...goodStatus, ok: false, missingRequired: [goodStatus.prerequisites[0]] }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => goodStatus })
      .mockResolvedValueOnce({ ok: true, json: async () => second })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => usePrerequisites())
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.status?.ok).toBe(true)

    await act(async () => {
      await result.current.recheck()
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.current.status?.ok).toBe(false)
  })

  it('surfaces a fetch error when the response is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result } = renderHook(() => usePrerequisites())

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.error).not.toBeNull()
    expect(result.current.status).toBeNull()
  })
})
