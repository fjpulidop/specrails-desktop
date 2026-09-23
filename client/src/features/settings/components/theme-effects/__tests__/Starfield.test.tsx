import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import { Starfield } from '../Starfield'

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
    arc: vi.fn(),
    fill: vi.fn(),
    fillStyle: '',
    globalAlpha: 1,
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D
  )
  return ctx
}

describe('Starfield', () => {
  beforeEach(() => {
    stubMatchMedia(false)
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('renders an absolute, pointer-events-none, full-surface canvas and starts drawing', () => {
    const ctx = mockCanvasContext()
    let tick: FrameRequestCallback | undefined
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      tick = cb
      return 1
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const { container } = render(<Starfield />)
    const canvas = container.querySelector('canvas')

    expect(canvas).not.toBeNull()
    expect(canvas?.className).toContain('pointer-events-none')
    expect(canvas?.className).toContain('absolute')
    expect(canvas?.className).toContain('inset-0')
    expect(canvas?.style.zIndex).toBe('-1')
    expect(canvas?.getAttribute('aria-hidden')).not.toBeNull()

    tick?.(performance.now())

    expect(ctx.clearRect).toHaveBeenCalled()
    expect(ctx.arc).toHaveBeenCalled()
    expect(ctx.fill).toHaveBeenCalled()
  })

  it('does not start an animation frame loop when prefers-reduced-motion is set', () => {
    mockCanvasContext()
    stubMatchMedia(true)
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')

    render(<Starfield />)

    expect(rafSpy).not.toHaveBeenCalled()
  })

  it('cancels and resumes the animation frame loop on visibility changes', () => {
    mockCanvasContext()
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(42)
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    render(<Starfield />)

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(cancelSpy).toHaveBeenCalledWith(42)

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))

    expect(rafSpy).toHaveBeenCalledTimes(2)
  })
})
