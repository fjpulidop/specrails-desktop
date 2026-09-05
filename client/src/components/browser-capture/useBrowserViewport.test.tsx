import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useBrowserViewport } from './useBrowserViewport'

let resized: ResizeObserverCallback
let observed: ReturnType<typeof vi.fn>
let disconnected: ReturnType<typeof vi.fn>
let frames: Map<number, FrameRequestCallback>
let nextFrame: number
let scaleFactor: number
const originalScaleFactor = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')!

beforeEach(() => {
  frames = new Map()
  nextFrame = 0
  scaleFactor = 2
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => scaleFactor })
  observed = vi.fn()
  disconnected = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resized = callback }
    observe = observed
    disconnect = disconnected
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback)
    return nextFrame
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { frames.delete(id) })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'devicePixelRatio', originalScaleFactor)
})

function fixture() {
  const element = document.createElement('div')
  const rect = { width: 1200.2, height: 740.4 }
  vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => rect as DOMRect)
  return { ref: { current: element }, rect }
}

function notifyResize() {
  act(() => { resized([], {} as ResizeObserver) })
}

function drawFrame() {
  act(() => {
    const pending = [...frames.values()]
    frames.clear()
    for (const callback of pending) callback(0)
  })
}

describe('useBrowserViewport', () => {
  it('measures CSS pixels immediately with a separate Retina scale factor', () => {
    const { ref } = fixture()
    const setViewport = vi.fn()
    renderHook(() => useBrowserViewport(ref, setViewport, true))
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(1200, 740, 2)
    expect(observed).toHaveBeenCalledExactlyOnceWith(ref.current)
  })

  it('keeps one observer across renders and does not repeat identical measurements', () => {
    const { ref } = fixture()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ callback }) => useBrowserViewport(ref, callback, true), { initialProps: { callback: first } })
    rerender({ callback: second })
    notifyResize()
    drawFrame()
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(observed).toHaveBeenCalledTimes(1)
    expect(disconnected).not.toHaveBeenCalled()
  })

  it('coalesces a burst to the latest measurement and current callback', () => {
    const { ref, rect } = fixture()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = renderHook(({ callback }) => useBrowserViewport(ref, callback, true), { initialProps: { callback: first } })
    rect.width = 1300
    notifyResize()
    rect.width = 1400
    notifyResize()
    rerender({ callback: second })
    expect(frames.size).toBe(1)
    drawFrame()
    expect(second).toHaveBeenCalledExactlyOnceWith(1400, 740, 2)
  })

  it('updates density when moved to another monitor without a CSS resize', () => {
    const { ref } = fixture()
    const setViewport = vi.fn()
    let onChange: (() => void) | undefined
    const remove = vi.fn()
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: (_event: string, callback: () => void) => { onChange = callback },
      removeEventListener: remove,
    })))
    const { unmount } = renderHook(() => useBrowserViewport(ref, setViewport, true))
    scaleFactor = 1
    act(() => { onChange?.() })
    drawFrame()
    expect(setViewport).toHaveBeenLastCalledWith(1200, 740, 1)
    expect(window.matchMedia).toHaveBeenLastCalledWith('(resolution: 1dppx)')
    unmount()
    expect(remove).toHaveBeenCalledTimes(2)
  })

  it('keeps device presets fixed while still tracking monitor density', () => {
    const { ref, rect } = fixture()
    const setViewport = vi.fn()
    renderHook(() => useBrowserViewport(ref, setViewport, true, { width: 375, height: 667 }))
    rect.width = 800
    notifyResize()
    drawFrame()
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(375, 667, 2)
    scaleFactor = 1
    notifyResize()
    drawFrame()
    expect(setViewport).toHaveBeenLastCalledWith(375, 667, 1)
  })

  it('ignores hidden and invalid surfaces then measures once they become visible', () => {
    const { ref, rect } = fixture()
    const setViewport = vi.fn()
    rect.width = 0
    renderHook(() => useBrowserViewport(ref, setViewport, true))
    rect.width = Number.NaN
    notifyResize()
    drawFrame()
    expect(setViewport).not.toHaveBeenCalled()
    rect.width = 900
    notifyResize()
    drawFrame()
    expect(setViewport).toHaveBeenCalledExactlyOnceWith(900, 740, 2)
  })

  it('reapplies fit dimensions when enabled again and cancels pending work on close', () => {
    const { ref } = fixture()
    const setViewport = vi.fn()
    const { rerender } = renderHook(({ enabled }) => useBrowserViewport(ref, setViewport, enabled), { initialProps: { enabled: true } })
    notifyResize()
    rerender({ enabled: false })
    notifyResize()
    expect(frames.size).toBe(0)
    expect(disconnected).toHaveBeenCalledTimes(1)
    rerender({ enabled: true })
    expect(setViewport).toHaveBeenCalledTimes(2)
  })

  it('uses window resize when ResizeObserver is unavailable and bounds DPR', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const { ref, rect } = fixture()
    const setViewport = vi.fn()
    scaleFactor = 3
    renderHook(() => useBrowserViewport(ref, setViewport, true))
    expect(setViewport).toHaveBeenLastCalledWith(1200, 740, 2)
    rect.width = 900
    scaleFactor = Number.NaN
    act(() => { window.dispatchEvent(new Event('resize')) })
    drawFrame()
    expect(setViewport).toHaveBeenLastCalledWith(900, 740, 1)
  })
})
