import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import React from 'react'
import { SharedWebSocketProvider, useSharedWebSocket } from '../useSharedWebSocket'
import { getDesktopTokenProtocol, refreshDesktopToken } from '../../lib/auth'

vi.mock('../../lib/auth', () => ({
  getDesktopTokenProtocol: vi.fn(() => undefined),
  refreshDesktopToken: vi.fn(async () => true),
}))

// ─── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static lastInstance: MockWebSocket | null = null

  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  readyState = 0
  url: string
  protocols?: string | string[]

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
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

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeWrapper(url = 'ws://localhost:4200') {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(SharedWebSocketProvider, { url }, children)
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('useSharedWebSocket', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    MockWebSocket.instances = []
    MockWebSocket.lastInstance = null
    vi.clearAllMocks()
    vi.mocked(getDesktopTokenProtocol).mockReturnValue(undefined)
    ;(global as unknown as Record<string, unknown>).WebSocket = MockWebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('connects to WebSocket URL on mount', () => {
    renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })
    expect(MockWebSocket.instances).toHaveLength(1)
    expect(MockWebSocket.instances[0].url).toBe('ws://localhost:4200')
  })

  it('uses desktop token subprotocol when available', async () => {
    vi.mocked(getDesktopTokenProtocol).mockReturnValue('desktop-token.test')

    renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    expect(MockWebSocket.instances[0].protocols).toEqual(['specrails-desktop', 'desktop-token.test'])
  })

  it('sets connectionStatus to connected on open', async () => {
    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })
    expect(result.current.connectionStatus).toBe('connecting')

    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    expect(result.current.connectionStatus).toBe('connected')
  })

  it('fan-out: messages dispatched to all registered handlers', () => {
    const handler1 = vi.fn()
    const handler2 = vi.fn()

    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    act(() => {
      result.current.registerHandler('h1', handler1)
      result.current.registerHandler('h2', handler2)
    })
    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    act(() => { MockWebSocket.lastInstance?.triggerMessage({ type: 'test', data: 'hello' }) })

    expect(handler1).toHaveBeenCalledWith({ type: 'test', data: 'hello' })
    expect(handler2).toHaveBeenCalledWith({ type: 'test', data: 'hello' })
  })

  it('fan-out: a throwing handler does not starve later-registered handlers (BUG-CLIENT-01)', () => {
    const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {})
    const throwingHandler = vi.fn(() => { throw new Error('boom') })
    const laterHandler = vi.fn()

    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    act(() => {
      // Insertion order matters: the Map iterates in insertion order, so the
      // throwing handler is reached BEFORE laterHandler.
      result.current.registerHandler('throws', throwingHandler)
      result.current.registerHandler('later', laterHandler)
    })
    act(() => { MockWebSocket.lastInstance?.triggerOpen() })
    act(() => { MockWebSocket.lastInstance?.triggerMessage({ type: 'test' }) })

    expect(throwingHandler).toHaveBeenCalledTimes(1)
    // Pre-fix this would NOT have been called (loop aborted mid-fan-out).
    expect(laterHandler).toHaveBeenCalledWith({ type: 'test' })
    expect(consoleErr).toHaveBeenCalled()

    consoleErr.mockRestore()
  })

  it('reconnects with backoff on close (1s, 2s, 4s, 8s, 16s)', async () => {
    renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    const ws1 = MockWebSocket.lastInstance!
    act(() => { ws1.triggerOpen() })
    expect(MockWebSocket.instances).toHaveLength(1)

    // First close — should reconnect after 1s
    act(() => { ws1.triggerClose() })
    expect(MockWebSocket.instances).toHaveLength(1) // not yet reconnected

    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(MockWebSocket.instances).toHaveLength(2) // reconnected after 1s

    // Second close — reconnect after 2s
    act(() => { MockWebSocket.lastInstance!.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
    expect(MockWebSocket.instances).toHaveLength(3)

    // Third close — reconnect after 4s
    act(() => { MockWebSocket.lastInstance!.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
    expect(MockWebSocket.instances).toHaveLength(4)

    // Fourth close — reconnect after 8s
    act(() => { MockWebSocket.lastInstance!.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(8000) })
    expect(MockWebSocket.instances).toHaveLength(5)

    // Fifth close — reconnect after 16s
    act(() => { MockWebSocket.lastInstance!.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(16000) })
    expect(MockWebSocket.instances).toHaveLength(6)
  })

  it('retry count resets on successful connection', async () => {
    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    const ws1 = MockWebSocket.lastInstance!
    act(() => { ws1.triggerOpen() })

    // Disconnect and reconnect once
    act(() => { ws1.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })

    const ws2 = MockWebSocket.lastInstance!
    act(() => { ws2.triggerOpen() }) // successful reconnect — resets retry count

    // Now disconnect again — should use 1s delay (reset to first delay)
    act(() => { ws2.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(MockWebSocket.instances).toHaveLength(3)
    expect(result.current.connectionStatus).toBe('connecting')
  })

  it('JSON parse errors are silently ignored', () => {
    const handler = vi.fn()
    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    act(() => {
      result.current.registerHandler('h1', handler)
      MockWebSocket.lastInstance?.triggerOpen()
    })

    // Simulate a bad JSON message
    act(() => {
      MockWebSocket.lastInstance?.onmessage?.({ data: 'not valid json{{{' })
    })

    expect(handler).not.toHaveBeenCalled()
  })

  it('refreshes authentication before reconnecting after sidecar startup or restart', async () => {
    renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })
    vi.mocked(refreshDesktopToken).mockImplementationOnce(async () => {
      vi.mocked(getDesktopTokenProtocol).mockReturnValue('desktop-token.restarted')
      return true
    })
    act(() => { MockWebSocket.lastInstance!.triggerClose() })
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(refreshDesktopToken).toHaveBeenCalledOnce()
    expect(MockWebSocket.lastInstance!.protocols).toEqual(['specrails-desktop', 'desktop-token.restarted'])
  })

  it('disposed flag prevents actions after unmount', () => {
    const { unmount } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })
    const ws = MockWebSocket.lastInstance!

    act(() => { ws.triggerOpen() })
    unmount()

    // After unmount, close should not trigger reconnect
    act(() => { ws.triggerClose() })
    act(() => { vi.advanceTimersByTime(1000) })

    // Should still be only 1 instance
    expect(MockWebSocket.instances).toHaveLength(1)
  })

  it('unregisterHandler removes the handler', () => {
    const handler = vi.fn()
    const { result } = renderHook(() => useSharedWebSocket(), { wrapper: makeWrapper() })

    act(() => {
      result.current.registerHandler('h1', handler)
      MockWebSocket.lastInstance?.triggerOpen()
    })
    act(() => { result.current.unregisterHandler('h1') })
    act(() => { MockWebSocket.lastInstance?.triggerMessage({ type: 'test' }) })

    expect(handler).not.toHaveBeenCalled()
  })
})
