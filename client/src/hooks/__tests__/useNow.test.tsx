import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { activeNowClocks, subscribeNow, useNow } from '../useNow'

describe('useNow', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10_000) })
  afterEach(() => { vi.useRealTimers() })

  it('ticks every interval while active', () => {
    const { result } = renderHook(() => useNow(1000))
    expect(result.current).toBe(10_000)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(result.current).toBe(11_000)
    act(() => { vi.advanceTimersByTime(2000) })
    expect(result.current).toBe(13_000)
  })

  it('runs one timer per interval size however many components read it', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const hooks = [renderHook(() => useNow(1000)), renderHook(() => useNow(1000)), renderHook(() => useNow(1000))]
    expect(activeNowClocks()).toBe(1)
    const slow = renderHook(() => useNow(60_000))
    expect(activeNowClocks()).toBe(2)
    expect(setIntervalSpy).toHaveBeenCalledTimes(2)
    act(() => { vi.advanceTimersByTime(1000) })
    expect(hooks.map(h => h.result.current)).toEqual([11_000, 11_000, 11_000])
    expect(slow.result.current).toBe(10_000)
    hooks.forEach(h => h.unmount())
    expect(activeNowClocks()).toBe(1)
    slow.unmount()
    expect(activeNowClocks()).toBe(0)
    setIntervalSpy.mockRestore()
  })

  it('stays frozen and runs no timer while inactive, and reads the clock when it becomes active', () => {
    const { result, rerender } = renderHook(({ active }) => useNow(1000, active), { initialProps: { active: false } })
    expect(activeNowClocks()).toBe(0)
    act(() => { vi.advanceTimersByTime(5000) })
    expect(result.current).toBe(10_000)
    rerender({ active: true })
    expect(result.current).toBe(15_000)
    expect(activeNowClocks()).toBe(1)
    rerender({ active: false })
    expect(activeNowClocks()).toBe(0)
  })

  it('a listener that unsubscribes during a tick does not break the others', () => {
    const seen: number[] = []
    let stopFirst = () => {}
    stopFirst = subscribeNow(500, () => stopFirst())
    const stopSecond = subscribeNow(500, now => seen.push(now))
    vi.advanceTimersByTime(1000)
    expect(seen).toEqual([10_500, 11_000])
    stopSecond()
    expect(activeNowClocks()).toBe(0)
  })
})
