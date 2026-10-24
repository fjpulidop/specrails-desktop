import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { useElementWidth } from '../useElementWidth'

function Probe() {
  const [ref, width] = useElementWidth<HTMLDivElement>()
  return <div ref={ref} data-testid="probe">{width === null ? 'null' : String(width)}</div>
}

const original = globalThis.ResizeObserver

afterEach(() => {
  globalThis.ResizeObserver = original
})

describe('useElementWidth', () => {
  it('returns null when ResizeObserver is unavailable', () => {
    // @ts-expect-error simulate an environment without ResizeObserver
    globalThis.ResizeObserver = undefined
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('null')
  })

  it('reports the observed width (rounded) and ignores zero widths', () => {
    let emit: (w: number) => void = () => {}
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        emit = (w) => cb([{ contentRect: { width: w } } as ResizeObserverEntry], this as unknown as ResizeObserver)
      }
      observe() { emit(412.6) }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
    render(<Probe />)
    expect(screen.getByTestId('probe')).toHaveTextContent('413')
    act(() => emit(0))
    expect(screen.getByTestId('probe')).toHaveTextContent('413')
    act(() => emit(300))
    expect(screen.getByTestId('probe')).toHaveTextContent('300')
  })

  it('disconnects the observer on unmount', () => {
    const disconnect = vi.fn()
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect = disconnect
    } as unknown as typeof ResizeObserver
    const { unmount } = render(<Probe />)
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })
})
