import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useAvailableProviders } from '../useAvailableProviders'

function respond(payload: Record<string, unknown>) {
  globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => payload }) as unknown as typeof fetch
}

describe('useAvailableProviders', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }) })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('lists only available ids, keeps labels, and ignores the response metadata keys', async () => {
    respond({ claude: true, codex: false, local3080: true, tiers: ['quick'], providerIssues: {}, launchDescriptors: {}, labels: { local3080: 'LM Studio' } })
    const { result } = renderHook(() => useAvailableProviders())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.availableIds).toEqual(['claude', 'local3080'])
    expect(result.current.labels.local3080).toBe('LM Studio')
  })

  it('refreshes on the detection broadcast so a selector never offers an engine detection has dropped', async () => {
    respond({ claude: true, local3080: true })
    const { result } = renderHook(() => useAvailableProviders())
    await waitFor(() => expect(result.current.availableIds).toEqual(['claude', 'local3080']))
    respond({ claude: true })
    await act(async () => { window.dispatchEvent(new Event('specrails:providers-detected-changed')) })
    await waitFor(() => expect(result.current.availableIds).toEqual(['claude']))
  })

  it('does not fetch at all while disabled', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy as unknown as typeof fetch
    renderHook(() => useAvailableProviders({ enabled: false }))
    await act(async () => { window.dispatchEvent(new Event('specrails:providers-detected-changed')) })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
