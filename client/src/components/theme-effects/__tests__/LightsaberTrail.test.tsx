import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { LightsaberTrail } from '../LightsaberTrail'

// `vi.restoreAllMocks()` (fired after every test by the shared test-setup)
// resets the module-level `window.matchMedia` mock to a no-op returning
// `undefined`, since it's a plain `vi.fn()` rather than a spy on a real
// implementation. Re-establish a sane default before each test in this file
// so `LightsaberTrail`'s `matchMedia(...).matches` read never crashes.
function stubMatchMedia(matches: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as MediaQueryList
  )
}

function mockCanvasContext() {
  const ctx = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    lineCap: '',
    lineJoin: '',
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: '',
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  )
  return ctx
}

describe('LightsaberTrail', () => {
  beforeEach(() => {
    stubMatchMedia(false)
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('mounts and unmounts without throwing', () => {
    mockCanvasContext()
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    expect(() => {
      const { unmount } = render(<LightsaberTrail />)
      unmount()
    }).not.toThrow()

    expect(rafSpy).toHaveBeenCalled()
  })

  it('does not start an animation frame loop when prefers-reduced-motion is set', () => {
    mockCanvasContext()
    stubMatchMedia(true)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

    render(<LightsaberTrail />)

    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('renders a fixed, pointer-events-none, full-viewport canvas', () => {
    mockCanvasContext()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(1)
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { container } = render(<LightsaberTrail />)
    const canvas = container.querySelector('canvas')

    expect(canvas).not.toBeNull()
    expect(canvas?.className).toContain('pointer-events-none')
    expect(canvas?.className).toContain('fixed')
    expect(canvas?.className).toContain('inset-0')
    expect(canvas?.style.zIndex).toBe('-1')
    expect(canvas?.getAttribute('aria-hidden')).not.toBeNull()
  })

  it('cancels the animation frame loop when the document becomes hidden', () => {
    mockCanvasContext()
    vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    render(<LightsaberTrail />)

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(cancelSpy).toHaveBeenCalled()

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  it('strokes a tapered polyline through recent pointer samples on each frame', () => {
    const ctx = mockCanvasContext()
    let tick: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      tick = cb
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    render(<LightsaberTrail />)

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 30 }))
    tick?.(performance.now())

    expect(ctx.beginPath).toHaveBeenCalled()
    expect(ctx.moveTo).toHaveBeenCalled()
    expect(ctx.lineTo).toHaveBeenCalled()
    expect(ctx.stroke).toHaveBeenCalled()
    expect(ctx.clearRect).toHaveBeenCalled()
  })

  it('clears the live trail so it fades naturally when the pointer leaves the window', () => {
    const ctx = mockCanvasContext()
    let tick: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      tick = cb
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    render(<LightsaberTrail />)

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10 }))
    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 30 }))
    document.dispatchEvent(new Event('mouseleave'))
    ctx.beginPath.mockClear()
    tick?.(performance.now())

    expect(ctx.beginPath).not.toHaveBeenCalled()
  })
})
