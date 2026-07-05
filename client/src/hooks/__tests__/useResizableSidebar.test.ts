import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResizableSidebar } from '../useResizableSidebar'

const KEY = 'specrails-desktop:sidebar-width:test'

function startDrag(result: { current: { onGripPointerDown: (e: unknown) => void } }, clientX: number) {
  act(() => result.current.onGripPointerDown({ button: 0, clientX, preventDefault() {} }))
}
function moveTo(clientX: number) {
  act(() => document.dispatchEvent(Object.assign(new Event('mousemove'), { clientX })))
}
function endDrag() {
  act(() => document.dispatchEvent(new Event('mouseup')))
}

describe('useResizableSidebar', () => {
  beforeEach(() => localStorage.clear())

  it('starts at the default width when nothing is stored', () => {
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'left', defaultWidth: 240, min: 200, max: 460 }))
    expect(result.current.width).toBe(240)
  })

  it('restores a stored width, clamped to [min,max]', () => {
    localStorage.setItem(KEY, '9999')
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'left', defaultWidth: 240, min: 200, max: 460 }))
    expect(result.current.width).toBe(460) // clamped to max
  })

  it('a LEFT sidebar widens when dragging its right-edge grip to the right', () => {
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'left', defaultWidth: 240, min: 200, max: 460 }))
    startDrag(result, 300)
    moveTo(360) // +60 to the right
    expect(result.current.width).toBe(300)
    endDrag()
    // Persisted on drag end.
    expect(localStorage.getItem(KEY)).toBe('300')
  })

  it('a RIGHT sidebar widens when dragging its left-edge grip to the LEFT (inverted)', () => {
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'right', defaultWidth: 208, min: 180, max: 460 }))
    startDrag(result, 300)
    moveTo(240) // -60 to the left → wider for a right sidebar
    expect(result.current.width).toBe(268)
    endDrag()
  })

  it('clamps to min/max during a drag', () => {
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'left', defaultWidth: 240, min: 200, max: 460 }))
    startDrag(result, 300)
    moveTo(10_000)
    expect(result.current.width).toBe(460)
    moveTo(-10_000)
    expect(result.current.width).toBe(200)
    endDrag()
  })

  it('arrow keys resize (side-aware) and Home resets to default', () => {
    const { result } = renderHook(() => useResizableSidebar('test', { side: 'left', defaultWidth: 240, min: 200, max: 460 }))
    act(() => result.current.onGripKeyDown({ key: 'ArrowRight', shiftKey: false, preventDefault() {} } as unknown as React.KeyboardEvent))
    expect(result.current.width).toBe(248) // +8 (grow for a left sidebar)
    act(() => result.current.onGripKeyDown({ key: 'ArrowLeft', shiftKey: true, preventDefault() {} } as unknown as React.KeyboardEvent))
    expect(result.current.width).toBe(224) // -24 (shift step)
    act(() => result.current.onGripKeyDown({ key: 'Home', shiftKey: false, preventDefault() {} } as unknown as React.KeyboardEvent))
    expect(result.current.width).toBe(240)
  })
})
