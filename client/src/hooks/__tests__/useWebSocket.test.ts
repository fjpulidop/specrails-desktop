import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useWebSocket } from '../useWebSocket'
import { getDesktopTokenProtocol, refreshDesktopToken } from '../../lib/auth'

vi.mock('../../lib/auth', () => ({
  getDesktopTokenProtocol: vi.fn(() => undefined),
  refreshDesktopToken: vi.fn(async () => true),
}))

// ─── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static lastInstance: MockWebSocket | null = null
  static failNext = false

  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  readyState = 0

  constructor(public url: string, public protocols?: string[]) {
    if (MockWebSocket.failNext) {
      MockWebSocket.failNext = false
      throw new Error('temporary WebSocket constructor failure')
    }
    MockWebSocket.instances.push(this)
    MockWebSocket.lastInstance = this
  }

  send(_data: string) {}

  close() {
    this.readyState = 3
    this.onclose?.()
  }

  triggerOpen() {
    this.readyState = 1
    this.onopen?.()
  }

  triggerMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }

  triggerClose() {
    this.readyState = 3
    this.onclose?.()
  }
}

describe('useWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    MockWebSocket.lastInstance = null
    MockWebSocket.failNext = false
    vi.mocked(getDesktopTokenProtocol).mockReset().mockReturnValue(undefined)
    vi.mocked(refreshDesktopToken).mockReset().mockResolvedValue(true)
    vi.stubGlobal('WebSocket', MockWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('starts in "connecting" status', () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('ws://localhost:4200', onMessage))
    expect(result.current.connectionStatus).toBe('connecting')
  })

  it('transitions to "connected" when WebSocket opens', () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    expect(result.current.connectionStatus).toBe('connected')
  })

  it('creates a WebSocket with the provided URL', () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:9999', onMessage))
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:9999')
  })

  it('calls onMessage with parsed JSON when a message arrives', () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    act(() => {
      MockWebSocket.lastInstance?.triggerOpen()
      MockWebSocket.lastInstance?.triggerMessage({ type: 'queue', jobs: [] })
    })

    expect(onMessage).toHaveBeenCalledWith({ type: 'queue', jobs: [] })
  })

  it('silently ignores malformed JSON messages', () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    act(() => {
      MockWebSocket.lastInstance?.triggerOpen()
      MockWebSocket.lastInstance?.onmessage?.({ data: 'not-valid-json{{{' })
    })

    expect(onMessage).not.toHaveBeenCalled()
  })

  it('reconnects after close with 1s delay (first backoff)', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    expect(MockWebSocket.instances).toHaveLength(1)

    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    expect(MockWebSocket.instances).toHaveLength(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('reconnects with exponential backoff (2s second attempt)', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    // Close once (1s delay)
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    // Close again (2s delay)
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })

    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('resets retry count to 0 after successful reconnect', async () => {
    const onMessage = vi.fn()
    renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    const ws1 = MockWebSocket.lastInstance!
    act(() => { ws1.triggerOpen() })

    act(() => { ws1.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const ws2 = MockWebSocket.lastInstance!
    act(() => { ws2.triggerOpen() }) // successful reconnect → resets counter

    act(() => { ws2.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) }) // first delay again

    expect(MockWebSocket.instances).toHaveLength(3)
  })

  it('keeps reconnecting beyond the original 31-second cutoff with a capped 30-second delay', async () => {
    const onMessage = vi.fn()
    const { result } = renderHook(() => useWebSocket('ws://localhost:4200', onMessage))

    const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
    for (const delay of delays) {
      act(() => { MockWebSocket.lastInstance?.triggerClose() })
      const before = MockWebSocket.instances.length
      await act(async () => { await vi.advanceTimersByTimeAsync(delay - 1) })
      expect(MockWebSocket.instances).toHaveLength(before)
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(MockWebSocket.instances).toHaveLength(before + 1)
    }
    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    expect(result.current.connectionStatus).toBe('connected')
    expect(refreshDesktopToken).toHaveBeenCalledTimes(7)
  })

  it('cleans up pending retry timeout on unmount', () => {
    const onMessage = vi.fn()
    const { unmount } = renderHook(() => useWebSocket('ws://localhost:4200', onMessage))
    const ws = MockWebSocket.lastInstance!

    act(() => { ws.triggerOpen() })

    // Trigger a close so a retry timer gets queued
    act(() => { ws.triggerClose() })
    // At this point a 1s timer is pending

    // Unmount before the timer fires — the cleanup cancels the pending timer
    unmount()

    // Advance past the retry delay — no new connection should have been made
    act(() => { vi.advanceTimersByTime(2000) })

    // Only the original WS instance should exist (the pending timer was cancelled)
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it.each([undefined, 'desktop-token.old'])('refreshes a rotated or initially missing credential before reconnecting (%s)', async (initialProtocol) => {
    vi.mocked(getDesktopTokenProtocol).mockReturnValue(initialProtocol)
    renderHook(() => useWebSocket('ws://localhost:4200', vi.fn()))
    expect(MockWebSocket.instances[0].protocols).toEqual(initialProtocol ? ['specrails-desktop', initialProtocol] : undefined)
    vi.mocked(refreshDesktopToken).mockImplementationOnce(async () => {
      vi.mocked(getDesktopTokenProtocol).mockReturnValue('desktop-token.current')
      return true
    })
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(refreshDesktopToken).toHaveBeenCalledOnce()
    expect(MockWebSocket.instances[1].protocols).toEqual(['specrails-desktop', 'desktop-token.current'])
  })

  it('does not create a ghost socket when unmounted while token refresh is pending', async () => {
    let finishRefresh!: (value: boolean) => void
    vi.mocked(refreshDesktopToken).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve }))
    const { unmount } = renderHook(() => useWebSocket('ws://localhost:4200', vi.fn()))
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(refreshDesktopToken).toHaveBeenCalledOnce()
    unmount()
    await act(async () => { finishRefresh(true) })
    window.dispatchEvent(new Event('focus'))
    window.dispatchEvent(new Event('online'))
    await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('keeps a new URL connection when a previous effect token refresh finishes late', async () => {
    let finishRefresh!: (value: boolean) => void
    vi.mocked(refreshDesktopToken).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve }))
    const onMessage = vi.fn()
    const { rerender, result } = renderHook(({ url }) => useWebSocket(url, onMessage), { initialProps: { url: 'ws://localhost/old' } })
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    rerender({ url: 'ws://localhost/current' })
    const current = MockWebSocket.lastInstance!
    act(() => { current.triggerOpen() })
    await act(async () => { finishRefresh(true) })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(current.url).toBe('ws://localhost/current')
    expect(result.current.connectionStatus).toBe('connected')
  })

  it('wakes immediately on focus/online and deduplicates events while refreshing', async () => {
    let finishRefresh!: (value: boolean) => void
    vi.mocked(refreshDesktopToken).mockImplementationOnce(() => new Promise((resolve) => { finishRefresh = resolve }))
    renderHook(() => useWebSocket('ws://localhost:4200', vi.fn()))
    act(() => { MockWebSocket.lastInstance?.triggerClose() })
    act(() => {
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
    })
    expect(refreshDesktopToken).toHaveBeenCalledOnce()
    await act(async () => { finishRefresh(true) })
    expect(MockWebSocket.instances).toHaveLength(2)
    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    act(() => { window.dispatchEvent(new Event('focus')) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
    expect(MockWebSocket.instances).toHaveLength(2)
  })

  it('cleans StrictMode sockets and uses only the current message callback', () => {
    const firstHandler = vi.fn()
    const nextHandler = vi.fn()
    const { rerender, unmount } = renderHook(({ handler }) => useWebSocket('ws://localhost:4200', handler), {
      initialProps: { handler: firstHandler }, reactStrictMode: true,
    })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[0].readyState).toBe(3)
    expect(MockWebSocket.instances[0].onclose).toBeNull()
    rerender({ handler: nextHandler })
    act(() => { MockWebSocket.instances[1].triggerMessage({ type: 'job_log' }) })
    expect(firstHandler).not.toHaveBeenCalled()
    expect(nextHandler).toHaveBeenCalledOnce()
    unmount()
    act(() => { vi.advanceTimersByTime(60000) })
    expect(MockWebSocket.instances).toHaveLength(2)
    expect(MockWebSocket.instances[1].readyState).toBe(3)
  })

  it('recovers from a constructor failure and a transient token refresh failure', async () => {
    MockWebSocket.failNext = true
    vi.mocked(refreshDesktopToken).mockRejectedValueOnce(new Error('temporarily unavailable'))
    const { result } = renderHook(() => useWebSocket('ws://localhost:4200', vi.fn()))
    expect(MockWebSocket.instances).toHaveLength(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(MockWebSocket.instances).toHaveLength(1)
    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    expect(result.current.connectionStatus).toBe('connected')
  })
})
